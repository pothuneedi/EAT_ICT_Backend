/* global SELECT */
'use strict';

const cds = require('@sap/cds');
const { PRIORITY, normalizePriority } = require('../lib/priority-utils');
const { isStrictTrue } = require('../lib/sap-boolean');
const { getDashboardAnalytics } = require('../lib/dashboard-analytics');

/**
 * Analytics functions — read directly from DB using fully qualified
 * schema names to avoid service-layer re-dispatch deadlocks.
 */

async function getActiveOrders() {
    const db     = await cds.connect.to('db');
    const orders = await db.run(
        SELECT.from('ict.po_lines').where({ po_status: ['OPEN', 'GR_POSTED'] })
    );

    const summary = orders.reduce((acc, { po_number, po_status }) => {
        if (!acc[po_number]) {
            acc[po_number] = { po_number, total_lines: 0, open_lines: 0, closed_lines: 0, status: 'OPEN' };
        }
        acc[po_number].total_lines++;
        if (po_status === 'OPEN')        acc[po_number].open_lines++;
        else if (po_status === 'CLOSED') acc[po_number].closed_lines++;
        return acc;
    }, {});

    return { value: Object.values(summary) };
}

async function getExceptionSummary() {
    const db = await cds.connect.to('db');
    const [poLines, exceptions] = await Promise.all([
        db.run(SELECT.from('ict.po_lines').columns('ai_processed')),
        db.run(SELECT.from('ict.exceptions').columns('priority', 'panel'))
    ]);

    return {
        value: {
            total_po_lines:   poLines.length,
            pending_analysis: poLines.filter((p) => !isStrictTrue(p.ai_processed)).length,
            total_exceptions: exceptions.length,
            high_priority:    exceptions.filter(e => normalizePriority(e.priority) === PRIORITY.HIGH).length,
            medium_priority:  exceptions.filter(e => normalizePriority(e.priority) === PRIORITY.MEDIUM).length,
            low_priority:     exceptions.filter(e => normalizePriority(e.priority) === PRIORITY.LOW).length,
            action_required:  exceptions.filter(e => e.panel === 'ACTION_REQUIRED').length,
            status_report:    exceptions.filter(e => e.panel === 'STATUS_REPORT').length
        }
    };
}

async function getSupplyChainMetrics() {
    const db = await cds.connect.to('db');
    const [poLines, exceptions, asns] = await Promise.all([
        db.run(SELECT.from('ict.po_lines')),
        db.run(SELECT.from('ict.exceptions')),
        db.run(SELECT.from('ict.asn_ibd'))
    ]);

    const totalPos        = new Set(poLines.map(p => p.po_number)).size;
    const completedPos    = poLines.filter(p => p.po_status === 'CLOSED').length;
    const onTimeDelivery  = totalPos === 0 ? 0 : ((completedPos / totalPos) * 100).toFixed(2);
    const exceptionRate   = poLines.length === 0 ? 0 : ((exceptions.length / poLines.length) * 100).toFixed(2);
    const avgLeadTime     = poLines.length === 0 ? 0 : (
        poLines.reduce((sum, p) => {
            const delivery = new Date(p.delivery_date);
            const created  = new Date(p.created_at);
            return sum + Math.ceil((delivery - created) / (1000 * 60 * 60 * 24));
        }, 0) / poLines.length
    ).toFixed(1);

    return {
        value: {
            total_pos:          totalPos,
            on_time_delivery:   parseFloat(onTimeDelivery),
            exception_rate:     parseFloat(exceptionRate),
            avg_lead_time_days: parseFloat(avgLeadTime),
            total_asns:         asns.length,
            completed_asns:     asns.filter(a => a.overall_status === 'C').length
        }
    };
}

/**
 * Aggregated AI token-usage analytics over a date range.
 * Aggregation is done in JS (portable across SQLite/Postgres — no dialect
 * date functions) over execution_logs rows that actually consumed tokens.
 */
async function getAiUsageAnalytics(req) {
    const db = await cds.connect.to('db');

    // Parse a date param, falling back to `fallback` on missing/invalid input
    // so a bad request never crashes the endpoint with an Invalid Date.
    const parseDate = (v, fallback) => {
        if (!v) return fallback;
        const d = new Date(v);
        return isNaN(d.getTime()) ? fallback : d;
    };

    // Default window: trailing 30 days (inclusive of today)
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
    let fromDate = parseDate(req.data.fromDate, defaultFrom);
    let toDate = parseDate(req.data.toDate, today);

    // Tolerate a reversed range instead of returning nothing
    if (fromDate > toDate) { const t = fromDate; fromDate = toDate; toDate = t; }

    // Normalize to full-day bounds so the whole toDate is included
    const fromISO = new Date(fromDate.toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const toISO = new Date(toDate.toISOString().slice(0, 10) + 'T23:59:59.999Z').toISOString();

    const rows = await db.run(
        SELECT.from('ict.execution_logs')
            .columns(
                'started_at', 'provider', 'model_id', 'ai_calls',
                'input_tokens', 'output_tokens', 'reasoning_tokens',
                'cached_input_tokens', 'total_tokens'
            )
            .where('started_at >=', fromISO).and('started_at <=', toISO)
    );

    const totals = {
        total_runs: 0, total_ai_calls: 0,
        total_input_tokens: 0, total_output_tokens: 0,
        total_reasoning_tokens: 0, total_cached_input_tokens: 0, total_tokens: 0
    };
    const byProvider = new Map();
    const byModel = new Map();
    const daily = new Map();

    const bucket = (map, label) => {
        if (!map.has(label)) {
            map.set(label, {
                label, runs: 0, ai_calls: 0, input_tokens: 0, output_tokens: 0,
                reasoning_tokens: 0, cached_input_tokens: 0, total_tokens: 0
            });
        }
        return map.get(label);
    };
    const add = (b, r) => {
        b.runs += 1;
        b.ai_calls += r.ai_calls || 0;
        b.input_tokens += r.input_tokens || 0;
        b.output_tokens += r.output_tokens || 0;
        b.reasoning_tokens += r.reasoning_tokens || 0;
        b.cached_input_tokens += r.cached_input_tokens || 0;
        b.total_tokens += r.total_tokens || 0;
    };

    for (const r of rows) {
        // Only runs that actually consumed tokens count as "usage"
        if (!(r.total_tokens > 0 || r.ai_calls > 0)) continue;

        totals.total_runs += 1;
        totals.total_ai_calls += r.ai_calls || 0;
        totals.total_input_tokens += r.input_tokens || 0;
        totals.total_output_tokens += r.output_tokens || 0;
        totals.total_reasoning_tokens += r.reasoning_tokens || 0;
        totals.total_cached_input_tokens += r.cached_input_tokens || 0;
        totals.total_tokens += r.total_tokens || 0;

        add(bucket(byProvider, r.provider || 'Unknown'), r);
        add(bucket(byModel, r.model_id || 'Unknown'), r);
        const day = (r.started_at || '').toString().slice(0, 10);
        if (day) add(bucket(daily, day), r);
    }

    const byDesc = (a, b) => b.total_tokens - a.total_tokens;
    const byDay = (a, b) => a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);

    return {
        fromDate: fromISO.slice(0, 10),
        toDate: toISO.slice(0, 10),
        ...totals,
        byProvider: [...byProvider.values()].sort(byDesc),
        byModel: [...byModel.values()].sort(byDesc),
        daily: [...daily.values()].sort(byDay)
    };
}

/**
 * Aggregated AI feedback analytics over a date range.
 * Groups by exception type, rating, and day for admin dashboards.
 */
async function getAiFeedbackAnalytics(req) {
    const db = await cds.connect.to('db');

    const parseDate = (v, fallback) => {
        if (!v) return fallback;
        const d = new Date(v);
        return isNaN(d.getTime()) ? fallback : d;
    };

    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
    let fromDate = parseDate(req.data.fromDate, defaultFrom);
    let toDate = parseDate(req.data.toDate, today);

    if (fromDate > toDate) { const t = fromDate; fromDate = toDate; toDate = t; }

    const fromISO = new Date(fromDate.toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
    const toISO = new Date(toDate.toISOString().slice(0, 10) + 'T23:59:59.999Z').toISOString();

    const rows = await db.run(
        SELECT.from('ict.ai_feedback')
            .columns('created_at', 'exception_type', 'rating', 'comment', 'exception_id')
            .where('created_at >=', fromISO).and('created_at <=', toISO)
    );

    const totals = {
        total: 0,
        helpful: 0,
        not_helpful: 0,
        with_comments: 0,
        unique_exceptions: 0
    };
    const byExceptionType = new Map();
    const byRating = new Map([
        ['HELPFUL', { label: 'Helpful', count: 0 }],
        ['NOT_HELPFUL', { label: 'Not Helpful', count: 0 }]
    ]);
    const daily = new Map();
    const exceptionIds = new Set();

    const typeBucket = (label) => {
        if (!byExceptionType.has(label)) {
            byExceptionType.set(label, {
                label, count: 0, helpful: 0, not_helpful: 0, not_helpful_pct: 0
            });
        }
        return byExceptionType.get(label);
    };

    const dayBucket = (label) => {
        if (!daily.has(label)) {
            daily.set(label, { label, count: 0, helpful: 0, not_helpful: 0 });
        }
        return daily.get(label);
    };

    for (const r of rows) {
        totals.total += 1;
        if (r.exception_id != null) exceptionIds.add(r.exception_id);
        if (r.comment && String(r.comment).trim()) totals.with_comments += 1;

        const isHelpful = r.rating === 'HELPFUL';
        if (isHelpful) totals.helpful += 1;
        else if (r.rating === 'NOT_HELPFUL') totals.not_helpful += 1;

        const tBucket = typeBucket(r.exception_type || 'Unknown');
        tBucket.count += 1;
        if (isHelpful) tBucket.helpful += 1;
        else if (r.rating === 'NOT_HELPFUL') tBucket.not_helpful += 1;

        if (byRating.has(r.rating)) byRating.get(r.rating).count += 1;

        const day = (r.created_at || '').toString().slice(0, 10);
        if (day) {
            const dBucket = dayBucket(day);
            dBucket.count += 1;
            if (isHelpful) dBucket.helpful += 1;
            else if (r.rating === 'NOT_HELPFUL') dBucket.not_helpful += 1;
        }
    }

    totals.unique_exceptions = exceptionIds.size;
    totals.helpful_pct = totals.total > 0
        ? Math.round((totals.helpful / totals.total) * 1000) / 10
        : 0;
    totals.not_helpful_pct = totals.total > 0
        ? Math.round((totals.not_helpful / totals.total) * 1000) / 10
        : 0;

    const byTypeArr = [...byExceptionType.values()].map(b => ({
        ...b,
        not_helpful_pct: b.count > 0 ? Math.round((b.not_helpful / b.count) * 1000) / 10 : 0
    })).sort((a, b) => b.count - a.count);

    const byRatingArr = [...byRating.values()].sort((a, b) => b.count - a.count);
    const dailyArr = [...daily.values()].sort((a, b) => a.label < b.label ? -1 : (a.label > b.label ? 1 : 0));

    return {
        fromDate: fromISO.slice(0, 10),
        toDate: toISO.slice(0, 10),
        ...totals,
        byExceptionType: byTypeArr,
        byRating: byRatingArr,
        daily: dailyArr
    };
}

function register(srv) {
    srv.on('READ', 'getActiveOrders',       getActiveOrders);
    srv.on('READ', 'getExceptionSummary',   getExceptionSummary);
    srv.on('READ', 'getSupplyChainMetrics', getSupplyChainMetrics);
    srv.on('getAiUsageAnalytics',           getAiUsageAnalytics);
    srv.on('getAiFeedbackAnalytics',        getAiFeedbackAnalytics);
    srv.on('getDashboardAnalytics',         getDashboardAnalytics);
}

module.exports = { register };

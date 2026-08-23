/* global SELECT */
'use strict';

const cds = require('@sap/cds');
const { calendarDateKey } = require('./s4h/date-utils');

const ACTIVE_PO_STATUSES = ['OPEN', 'GR_POSTED'];
const ALL = 'ALL';
const { PRIORITY, normalizePriority } = require('./priority-utils');
const { isStrictTrue } = require('./sap-boolean');
const { loadIbdCreationReport } = require('./ibd-creation-report');
const PANEL = { ACTION_REQUIRED: 'ACTION_REQUIRED', STATUS_REPORT: 'STATUS_REPORT' };
const TIMELINE_KEYS = ['overdue', 'next7', 'next14', 'next30', 'beyond30', 'noDate'];

function startOfDay(date) {
    const copy = new Date(date.getTime());
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function toLocalDateKey(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 86400000);
}

function normalizeFilters(data = {}) {
    return {
        plant: data.plant || ALL,
        deliveryDateFrom: String(data.deliveryDateFrom || '').trim(),
        deliveryDateTo: String(data.deliveryDateTo || '').trim(),
        priority: data.priority || ALL,
        exceptionType: data.exceptionType || ALL,
        search: String(data.search || '').trim()
    };
}

function filterBySearch(rows, fields, search) {
    if (!search) {
        return rows;
    }

    const term = search.toLowerCase();
    return rows.filter((row) => fields.some((field) => {
        const value = row[field];
        return value && String(value).toLowerCase().includes(term);
    }));
}

function parseFilterDateKey(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return null;
    }
    return text;
}

function applyDeliveryDateRange(q, field, deliveryDateFrom, deliveryDateTo) {
    const from = parseFilterDateKey(deliveryDateFrom);
    const to = parseFilterDateKey(deliveryDateTo);
    if (!from && !to) {
        return q;
    }
    if (from && to) {
        return q.and(`${field} >=`, `${from}T00:00:00.000Z`).and(`${field} <=`, `${to}T23:59:59.999Z`);
    }
    if (from) {
        return q.and(`${field} >=`, `${from}T00:00:00.000Z`);
    }
    return q.and(`${field} <=`, `${to}T23:59:59.999Z`);
}

function getDeliveryThresholds() {
    const today = startOfDay(new Date());
    return {
        today: toLocalDateKey(today),
        next7: toLocalDateKey(addDays(today, 7)),
        next14: toLocalDateKey(addDays(today, 14)),
        next30: toLocalDateKey(addDays(today, 30))
    };
}

function classifyDeliveryDate(deliveryDate, thresholds) {
    if (!deliveryDate) {
        return 'noDate';
    }

    const date = calendarDateKey(deliveryDate);
    if (!date) {
        return 'noDate';
    }
    if (date < thresholds.today) {
        return 'overdue';
    }
    if (date <= thresholds.next7) {
        return 'next7';
    }
    if (date <= thresholds.next14) {
        return 'next14';
    }
    if (date <= thresholds.next30) {
        return 'next30';
    }
    return 'beyond30';
}

function aggregatePoLines(poLines, thresholds) {
    const timelineCounts = Object.fromEntries(TIMELINE_KEYS.map((key) => [key, 0]));
    const byPlant = {};
    let pendingAnalysis = 0;

    poLines.forEach((row) => {
        timelineCounts[classifyDeliveryDate(row.delivery_date, thresholds)]++;

        if (!isStrictTrue(row.ai_processed)) {
            pendingAnalysis++;
        }

        const code = row.plant || '—';
        if (!byPlant[code]) {
            byPlant[code] = { plant: code, plantName: row.plant_name || '', count: 0 };
        }
        if (!byPlant[code].plantName && row.plant_name) {
            byPlant[code].plantName = row.plant_name;
        }
        byPlant[code].count++;
    });

    return {
        total_po_lines: poLines.length,
        pending_analysis: pendingAnalysis,
        deliveryTimeline: TIMELINE_KEYS.map((bucketKey) => ({
            bucketKey,
            count: timelineCounts[bucketKey]
        })),
        plants: Object.values(byPlant).sort((a, b) => b.count - a.count)
    };
}

function aggregateExceptions(rows) {
    const metrics = {
        action_required: 0,
        status_report: 0,
        high_priority: 0,
        medium_priority: 0,
        low_priority: 0
    };
    const rootCauses = {};

    rows.forEach((row) => {
        if (row.panel === PANEL.ACTION_REQUIRED) {
            metrics.action_required++;
        } else if (row.panel === PANEL.STATUS_REPORT) {
            metrics.status_report++;
        }

        if (normalizePriority(row.priority) === PRIORITY.HIGH) {
            metrics.high_priority++;
        } else if (normalizePriority(row.priority) === PRIORITY.MEDIUM) {
            metrics.medium_priority++;
        } else if (normalizePriority(row.priority) === PRIORITY.LOW) {
            metrics.low_priority++;
        }

        const type = row.exception_type || 'UNKNOWN';
        rootCauses[type] = (rootCauses[type] || 0) + 1;
    });

    return {
        metrics,
        rootCauses: Object.keys(rootCauses).map((exceptionType) => ({
            exceptionType,
            count: rootCauses[exceptionType]
        })).sort((a, b) => b.count - a.count)
    };
}

function buildSummaryPoLineQuery(filters) {
    let query = SELECT.from('ict.po_lines')
        .columns(
            'po_number', 'line_item', 'plant', 'delivery_date',
            'ai_processed', 'material_id', 'supplier_id'
        )
        .where('po_status in', ACTIVE_PO_STATUSES);

    if (filters.plant !== ALL) {
        query = query.and({ plant: filters.plant });
    }

    return applyDeliveryDateRange(query, 'delivery_date', filters.deliveryDateFrom, filters.deliveryDateTo);
}

function buildSummaryExceptionQuery(filters) {
    let query = SELECT.from('ict.exceptions')
        .columns(
            'exception_type', 'priority', 'panel', 'po_number', 'line_item',
            'supplier_name', 'material_id', 'plant', 'delivery_date'
        )
        .where('1=1');

    query = applyDeliveryDateRange(query, 'delivery_date', filters.deliveryDateFrom, filters.deliveryDateTo);

    if (filters.plant !== ALL) {
        query = query.and({ plant: filters.plant });
    }
    if (filters.priority !== ALL) {
        query = query.and({ priority: filters.priority });
    }
    if (filters.exceptionType !== ALL) {
        query = query.and({ exception_type: filters.exceptionType });
    }

    return query;
}

function activePoLineKeys(poLines) {
    return new Set(poLines.map((row) => `${row.po_number}|${row.line_item}`));
}

function activePoNumbers(poLines) {
    return new Set(poLines.map((row) => row.po_number).filter(Boolean));
}

async function enrichPoLinesWithPlantNames(db, poLines) {
    const plantCodes = [...new Set(poLines.map((row) => row.plant).filter(Boolean))];
    if (!plantCodes.length) {
        return poLines.map((row) => ({ ...row, plant_name: '' }));
    }

    const plants = await db.run(
        SELECT.from('ict.plants').columns('plant_code', 'plant_name').where({ plant_code: { in: plantCodes } })
    );
    const plantNameByCode = Object.fromEntries(plants.map((row) => [row.plant_code, row.plant_name]));
    return poLines.map((row) => ({
        ...row,
        plant_name: plantNameByCode[row.plant] || ''
    }));
}

function filterRowsToActivePoLines(rows, activeKeys) {
    return rows.filter((row) => activeKeys.has(`${row.po_number}|${row.line_item}`));
}

async function countChrEvents(db, filters, poNumbers) {
    if (filters.plant === ALL) {
        const result = await db.run(SELECT.one.from('ict.chr_events').columns('count(*) as total'));
        return Number(result?.total || 0);
    }

    const rows = await db.run(SELECT.from('ict.chr_events').columns('po_number'));
    return rows.filter((row) => poNumbers.has(row.po_number)).length;
}

async function loadDashboardRows(db, filters) {
    const [rawPoLines, rawExceptions, rawIdocRows] = await Promise.all([
        db.run(buildSummaryPoLineQuery(filters)),
        db.run(buildSummaryExceptionQuery(filters)),
        db.run(SELECT.from('ict.edi856_idoc_errors').columns('docnum', 'po_number', 'line_item'))
    ]);

    const poLines = filterBySearch(
        await enrichPoLinesWithPlantNames(db, rawPoLines),
        ['po_number', 'material_id', 'supplier_id'],
        filters.search
    );
    const activeKeys = activePoLineKeys(poLines);
    const poNumberSet = activePoNumbers(poLines);

    return {
        poLines,
        exceptions: filterBySearch(
            filterRowsToActivePoLines(rawExceptions, activeKeys),
            ['po_number', 'supplier_name', 'material_id'],
            filters.search
        ),
        idocErrors: filterBySearch(
            rawIdocRows.filter((row) => poNumberSet.has(row.po_number)),
            ['docnum', 'po_number'],
            filters.search
        ),
        poNumberSet
    };
}

function buildExceptionCountQuery(filters) {
    let query = SELECT.one.from('ict.exceptions').columns('count(*) as total').where('1=1');
    query = applyDeliveryDateRange(query, 'delivery_date', filters.deliveryDateFrom, filters.deliveryDateTo);
    if (filters.plant !== ALL) {
        query = query.and({ plant: filters.plant });
    }
    if (filters.priority !== ALL) {
        query = query.and({ priority: filters.priority });
    }
    if (filters.exceptionType !== ALL) {
        query = query.and({ exception_type: filters.exceptionType });
    }
    return query;
}

async function countExceptionRecords(db, filters) {
    const result = await db.run(buildExceptionCountQuery(filters));
    return Number(result?.total || 0);
}

async function getIctDashboardSummary(args = {}) {
    const filters = normalizeFilters(args);
    const db = await cds.connect.to('db');
    const thresholds = getDeliveryThresholds();

    const [{ poLines, exceptions, idocErrors, poNumberSet }, allPoTotal, asnTotal, totalExceptionRecords] = await Promise.all([
        loadDashboardRows(db, filters),
        db.run(SELECT.one.from('ict.po_lines').columns('count(*) as total')),
        db.run(buildAsnCountQuery(filters)),
        countExceptionRecords(db, filters)
    ]);
    const chrTotal = await countChrEvents(db, filters, poNumberSet);

    const poData = aggregatePoLines(poLines, thresholds);
    const exceptionData = aggregateExceptions(exceptions);

    return {
        filters_applied: filters,
        counts: {
            total_po_lines_all_statuses: Number(allPoTotal?.total || 0),
            total_active_po_lines: poData.total_po_lines,
            pending_analysis: poData.pending_analysis,
            total_asn: Number(asnTotal?.total || 0),
            total_chr_events: chrTotal,
            total_idoc_errors: idocErrors.length,
            total_exception_records: totalExceptionRecords,
            total_exceptions_on_active_po_lines: exceptions.length,
            action_required: exceptionData.metrics.action_required,
            status_report: exceptionData.metrics.status_report,
            high_priority: exceptionData.metrics.high_priority,
            medium_priority: exceptionData.metrics.medium_priority,
            low_priority: exceptionData.metrics.low_priority,
            plants_with_active_po_lines: poData.plants.length
        },
        delivery_window: Object.fromEntries(
            poData.deliveryTimeline.map((bucket) => [bucket.bucketKey, bucket.count])
        ),
        plants: poData.plants,
        top_exception_types: exceptionData.rootCauses
    };
}

function buildAsnCountQuery(filters) {
    let query = SELECT.one.from('ict.asn_ibd').columns('count(*) as total');
    if (filters.plant !== ALL) {
        query = query.where({ plant: filters.plant });
    }
    return query;
}

async function getDashboardAnalytics(req) {
    const filters = normalizeFilters(req.data);
    const db = await cds.connect.to('db');
    const thresholds = getDeliveryThresholds();
    const { poLines, exceptions, idocErrors } = await loadDashboardRows(db, filters);
    const poData = aggregatePoLines(poLines, thresholds);
    const exceptionData = aggregateExceptions(exceptions);
    const ibdReport = await loadIbdCreationReport(db, {
        plant: filters.plant,
        search: filters.search
    });

    return {
        metrics: {
            total_po_lines: poData.total_po_lines,
            pending_analysis: poData.pending_analysis,
            idoc_errors: idocErrors.length,
            ibd_creation_required: ibdReport.totalCount,
            ...exceptionData.metrics
        },
        deliveryTimeline: poData.deliveryTimeline,
        plants: poData.plants,
        rootCauses: exceptionData.rootCauses
    };
}

module.exports = {
    getDashboardAnalytics,
    getIctDashboardSummary
};

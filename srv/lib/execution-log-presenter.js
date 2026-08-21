'use strict';

const JOB_TYPE = {
    AI: 'AI_ANALYSIS',
    MASTER: 'S4_MASTER_SYNC',
    TRANSACTIONAL: 'S4_TRANSACTIONAL_SYNC',
    CHR: 'S4_CHR_SYNC'
};

function normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'SUCCESS' || s === 'SUCCEEDED' || s === 'COMPLETED') {
        return 'SUCCESS';
    }
    if (s === 'FAILURE' || s === 'FAILED' || s === 'FAIL') {
        return 'FAILURE';
    }
    if (s === 'ERROR') {
        return 'ERROR';
    }
    if (s === 'RUNNING' || s === 'IN_PROGRESS' || s === 'EXECUTING') {
        return 'RUNNING';
    }
    return s || 'UNKNOWN';
}

function parseLogEntries(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function inferJobType(record = {}) {
    if (record.job_type) {
        return record.job_type;
    }
    const provider = String(record.provider || '').toUpperCase();
    const jobName = String(record.job_name || '').toUpperCase();
    if (provider === 'CHR' || jobName.includes('CHR')) {
        return JOB_TYPE.CHR;
    }
    if (provider === 'SAP' || provider.includes('S/4')) {
        if (jobName.includes('MASTER')) {
            return JOB_TYPE.MASTER;
        }
        return JOB_TYPE.TRANSACTIONAL;
    }
    return JOB_TYPE.AI;
}

function formatDurationSec(started, completed) {
    if (!started) {
        return null;
    }
    const startMs = new Date(started).getTime();
    const endMs = completed ? new Date(completed).getTime() : Date.now();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
        return null;
    }
    const sec = Math.round((endMs - startMs) / 1000);
    if (sec >= 60) {
        return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    }
    return `${sec}s`;
}

function isSyncJobType(jobType) {
    return jobType === JOB_TYPE.MASTER
        || jobType === JOB_TYPE.TRANSACTIONAL
        || jobType === JOB_TYPE.CHR;
}

function formatAiLegacyMessage(record = {}) {
    const status = normalizeStatus(record.status);

    if (status === 'FAILURE' || status === 'ERROR') {
        return String(record.error_message || record.message || 'Job failed').trim();
    }

    if (status === 'RUNNING') {
        const processed = Number(record.processed_count) || 0;
        const total = Number(record.total_batch_size);
        if (total > 0) {
            return `Running… ${processed}/${total} processed`;
        }
        return 'Running…';
    }

    const errors = Number(record.error_count) || 0;
    let message = `Processed: ${Number(record.processed_count) || 0}, `
        + `Created: ${Number(record.created_count) || 0}, `
        + `Updated: ${Number(record.updated_count) || 0}, `
        + `Skipped: ${Number(record.skipped_count) || 0}`;
    if (errors) {
        message += `, Failed: ${errors}`;
    }
    return message;
}

/** Final AI run sentence persisted in log_entries and job callbacks. */
function formatAiAnalysisSummary(record = {}) {
    const duration = record.completed_at && record.started_at
        ? Math.round((new Date(record.completed_at) - new Date(record.started_at)) / 1000)
        : (record.duration_sec ?? 0);
    const total = Number(record.total_batch_size) || 0;
    const processed = Number(record.processed_count) || 0;
    const created = Number(record.created_count) || 0;
    const updated = Number(record.updated_count) || 0;
    const skipped = Number(record.skipped_count) || 0;
    const failed = Number(record.error_count) || 0;
    const verb = normalizeStatus(record.status) === 'SUCCESS' ? 'completed' : 'finished with errors';

    return `Analysis ${verb} — ${processed}/${total} processed `
        + `(Created: ${created}, Updated: ${updated}, `
        + `Skipped: ${skipped}, Failed: ${failed}) in ${duration}s`;
}

function formatRunSummary(record = {}) {
    const jobType = inferJobType(record);
    if (!isSyncJobType(jobType)) {
        return formatAiLegacyMessage(record);
    }

    const status = normalizeStatus(record.status);
    const duration = formatDurationSec(record.started_at, record.completed_at);
    const durSuffix = duration ? ` · ${duration}` : '';

    if (status === 'FAILURE' || status === 'ERROR') {
        const err = String(record.error_message || record.message || 'Job failed').trim();
        const short = err.length > 140 ? `${err.slice(0, 137)}…` : err;
        return short + durSuffix;
    }

    if (status === 'RUNNING') {
        const processed = Number(record.processed_count) || 0;
        const total = Number(record.total_batch_size);
        if (total > 0) {
            return `Running… ${processed}/${total} processed`;
        }
        return 'Running…';
    }

    const processed = Number(record.processed_count) || 0;
    const created = Number(record.created_count) || 0;
    const updated = Number(record.updated_count) || 0;
    const skipped = Number(record.skipped_count) || 0;
    const errors = Number(record.error_count) || 0;

    if (jobType === JOB_TYPE.CHR) {
        const upserted = processed || created + updated || 0;
        const parts = [`${upserted} event${upserted === 1 ? '' : 's'} synced`];
        if (created) parts.push(`${created} new`);
        if (errors) parts.push(`${errors} failed`);
        return parts.join(' · ') + durSuffix;
    }

    const upserted = processed || created + updated || 0;
    const parts = [`${upserted.toLocaleString('en-US')} upserted`];
    if (created) parts.push(`${created.toLocaleString('en-US')} new`);
    if (updated) parts.push(`${updated.toLocaleString('en-US')} updated`);
    if (skipped) parts.push(`${skipped.toLocaleString('en-US')} skipped`);
    if (errors) parts.push(`${errors} failed`);
    return parts.join(' · ') + durSuffix;
}

function isNoisyProgressEntry(message) {
    return /^Page \d+:/.test(message)
        || /^Deactivating stale /.test(message)
        || /reconcile skipped/.test(message);
}

function buildTimeline(entries, record = {}) {
    if (!Array.isArray(entries) || !entries.length) {
        return [];
    }

    const jobType = inferJobType(record);
    if (!isSyncJobType(jobType)) {
        return entries
            .map((entry) => ({
                level: String(entry.level || 'INFO').toUpperCase(),
                timestamp: entry.timestamp || null,
                message: String(entry.message || '').trim(),
                data: entry.data ?? null
            }))
            .filter((entry) => entry.message)
            .sort((a, b) => {
                const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
                return ta - tb;
            });
    }

    const important = [];
    const pageProgress = [];

    for (const entry of entries) {
        const message = String(entry.message || '').trim();
        if (!message) {
            continue;
        }

        const level = String(entry.level || 'INFO').toUpperCase();
        const row = {
            level,
            timestamp: entry.timestamp || null,
            message
        };

        if (level !== 'INFO') {
            important.push(row);
            continue;
        }

        if (isNoisyProgressEntry(message)) {
            pageProgress.push(row);
            continue;
        }

        important.push(row);
    }

    if (pageProgress.length > 2) {
        important.push({
            level: 'INFO',
            timestamp: pageProgress[pageProgress.length - 1].timestamp,
            message: `${pageProgress.length} sync batch pages completed`
        });
    } else {
        important.push(...pageProgress);
    }

    important.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
    });

    if (!important.length) {
        const summary = formatRunSummary(record);
        if (summary) {
            return [{ level: 'INFO', timestamp: record.completed_at || record.started_at || null, message: summary }];
        }
    }

    return important;
}

function formatToIsoTimestamp(sTs) {
    if (!sTs) {
        return null;
    }
    const s = String(sTs);
    if (s.includes('T')) {
        return s;
    }
    return `${s.replace(' ', 'T')}Z`;
}

function parseBtpRunTextMessage(runText) {
    if (!runText) {
        return '';
    }
    try {
        const logEntries = JSON.parse(runText);
        if (!Array.isArray(logEntries) || !logEntries.length) {
            return '';
        }
        const successLog = logEntries.find((l) => l.type === 'SUCCESS' || l.type === 'FAILURE');
        if (!successLog?.text) {
            return '';
        }
        try {
            const parsedText = JSON.parse(successLog.text);
            return parsedText.message || successLog.text;
        } catch {
            return successLog.text;
        }
    } catch {
        return '';
    }
}

/**
 * Single entry point for BTPExecutionLogs READ — merges BTP run metadata with
 * persisted execution_logs and returns list-ready + detail-ready fields.
 */
function buildBtpExecutionLogRow({ schedule, run, dbLog, formatToISO = formatToIsoTimestamp }) {
    const runId = run.runId?.toString() || '';
    if (!runId) {
        return null;
    }

    const row = {
        runId,
        job_name: schedule.job_name,
        job_type: schedule.job_type,
        status: normalizeStatus(run.runState || run.runStatus || 'UNKNOWN'),
        started_at: formatToISO(run.executionTimestamp || run.scheduleTimestamp),
        completed_at: formatToISO(run.completionTimestamp),
        httpStatus: run.httpStatus || 0,
        message: run.statusMessage || '',
        error_message: null,
        total_batch_size: null,
        processed_count: null,
        created_count: null,
        updated_count: null,
        skipped_count: null,
        error_count: null,
        log_entries: null,
        logEntries: null,
        provider: null,
        model_id: null,
        ai_calls: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        reasoning_tokens: null,
        cached_input_tokens: null,
        timeline: null
    };

    if (dbLog) {
        row.status = normalizeStatus(dbLog.status || row.status);
        row.completed_at = formatToISO(dbLog.completed_at) || row.completed_at;
        if (row.status === 'RUNNING') {
            row.completed_at = null;
        }
        row.error_message = dbLog.error_message || null;
        row.total_batch_size = dbLog.total_batch_size;
        row.processed_count = dbLog.processed_count;
        row.created_count = dbLog.created_count;
        row.updated_count = dbLog.updated_count;
        row.skipped_count = dbLog.skipped_count;
        row.error_count = dbLog.error_count;
        row.log_entries = dbLog.log_entries;
        row.logEntries = dbLog.log_entries;
        row.provider = dbLog.provider;
        row.model_id = dbLog.model_id;
        row.ai_calls = dbLog.ai_calls;
        row.input_tokens = dbLog.input_tokens;
        row.output_tokens = dbLog.output_tokens;
        row.total_tokens = dbLog.total_tokens;
        row.reasoning_tokens = dbLog.reasoning_tokens;
        row.cached_input_tokens = dbLog.cached_input_tokens;
    } else {
        const btpMessage = parseBtpRunTextMessage(run.runText);
        if (btpMessage) {
            row.message = btpMessage;
        }
    }

    row.message = formatRunSummary(row);

    if (isSyncJobType(inferJobType(row))) {
        const timeline = buildTimeline(parseLogEntries(row.log_entries), row);
        row.timeline = timeline.length ? JSON.stringify(timeline) : null;
    }

    return row;
}

module.exports = {
    JOB_TYPE,
    normalizeStatus,
    parseLogEntries,
    inferJobType,
    isSyncJobType,
    formatAiLegacyMessage,
    formatAiAnalysisSummary,
    formatRunSummary,
    buildTimeline,
    buildBtpExecutionLogRow
};

'use strict';

const JOB_TYPE = Object.freeze({
    AI_ANALYSIS: 'AI_ANALYSIS',
    AI_REANALYSIS: 'AI_REANALYSIS',
    S4_MASTER_SYNC: 'S4_MASTER_SYNC',
    S4_TRANSACTIONAL_SYNC: 'S4_TRANSACTIONAL_SYNC',
    S4_CHR_SYNC: 'S4_CHR_SYNC'
});

const SYNC_JOB_TYPES = new Set([
    JOB_TYPE.S4_MASTER_SYNC,
    JOB_TYPE.S4_TRANSACTIONAL_SYNC,
    JOB_TYPE.S4_CHR_SYNC
]);

const JOB_TYPE_LABELS = {
    [JOB_TYPE.AI_ANALYSIS]: 'AI exception analysis',
    [JOB_TYPE.AI_REANALYSIS]: 'AI reanalysis (sync changes)',
    [JOB_TYPE.S4_MASTER_SYNC]: 'S/4 master data sync',
    [JOB_TYPE.S4_TRANSACTIONAL_SYNC]: 'S/4 transactional sync',
    [JOB_TYPE.S4_CHR_SYNC]: 'CHR events sync'
};

function normalizeJobType(value) {
    const type = value || JOB_TYPE.AI_ANALYSIS;
    if (!Object.values(JOB_TYPE).includes(type)) {
        throw new Error(`Invalid job_type '${value}'.`);
    }
    return type;
}

function isSyncJobType(jobType) {
    return SYNC_JOB_TYPES.has(jobType);
}

function isAiJobType(jobType) {
    return jobType === JOB_TYPE.AI_ANALYSIS || jobType === JOB_TYPE.AI_REANALYSIS;
}

function isReanalysisJobType(jobType) {
    return jobType === JOB_TYPE.AI_REANALYSIS;
}

function resolveCallbackPath(jobType) {
    return isSyncJobType(jobType)
        ? '/odata/v4/catalog/runScheduledSync'
        : '/odata/v4/catalog/analyzeExceptions';
}

function resolveCallbackUrl(req, jobType) {
    let host = process.env.APP_URI || 'http://localhost:4000';
    if (process.env.VCAP_APPLICATION) {
        const appInfo = JSON.parse(process.env.VCAP_APPLICATION);
        host = `https://${appInfo.application_uris[0]}`;
    }
    return `${host}${resolveCallbackPath(jobType)}`;
}

function parseScheduleConfig(configValue) {
    if (configValue == null || configValue === '') {
        return {};
    }

    if (typeof configValue === 'object') {
        return configValue;
    }

    try {
        return JSON.parse(configValue);
    } catch (err) {
        throw new Error(`Invalid config JSON: ${err.message}`);
    }
}

function validateScheduleConfig(jobType, config) {
    const normalizedType = normalizeJobType(jobType);

    if (isAiJobType(normalizedType)) {
        return;
    }

    if (normalizedType === JOB_TYPE.S4_CHR_SYNC) {
        const customer = config?.customer != null ? String(config.customer).trim() : '';
        if (!customer) {
            throw new Error('CHR sync schedules require config.customer.');
        }
    }

    if (normalizedType === JOB_TYPE.S4_TRANSACTIONAL_SYNC) {
        const hasRange = config?.fromDate && config?.toDate;
        const hasLookback = config?.lookbackDays != null && config?.lookbackDays !== '';
        if (hasRange && hasLookback) {
            throw new Error('Use either config.lookbackDays or config.fromDate/toDate, not both.');
        }
        if (config?.lookbackDays != null && config.lookbackDays !== '') {
            const days = parseInt(config.lookbackDays, 10);
            if (!Number.isFinite(days) || days < 1) {
                throw new Error('config.lookbackDays must be a positive integer.');
            }
        }
    }
}

function buildJobDescription(jobType, { batch_size, config } = {}) {
    const label = JOB_TYPE_LABELS[jobType] || jobType;

    if (jobType === JOB_TYPE.AI_REANALYSIS) {
        return `PO line reanalysis after sync changes (Size: ${batch_size || 5})`;
    }

    if (jobType === JOB_TYPE.AI_ANALYSIS) {
        return `Automated exception analysis batch run (Size: ${batch_size || 5})`;
    }

    if (jobType === JOB_TYPE.S4_MASTER_SYNC) {
        return `${label} — plants, materials, suppliers`;
    }

    if (jobType === JOB_TYPE.S4_TRANSACTIONAL_SYNC) {
        const parsed = parseScheduleConfig(config);
        const scope = parsed.fromDate && parsed.toDate
            ? `${parsed.fromDate} to ${parsed.toDate}`
            : (parsed.lookbackDays
                ? `last ${parsed.lookbackDays} day(s)`
                : 'current year');
        return `${label} — po_lines, po_partners, asn_ibd, idoc_errors (${scope})`;
    }

    if (jobType === JOB_TYPE.S4_CHR_SYNC) {
        const parsed = parseScheduleConfig(config);
        const customer = parsed.customer ? `customer ${parsed.customer}` : 'CHR events';
        const minutes = parsed.lookbackMinutes ? `${parsed.lookbackMinutes} min lookback` : 'default lookback';
        return `${label} — ${customer}, ${minutes}`;
    }

    return label;
}

module.exports = {
    JOB_TYPE,
    normalizeJobType,
    isSyncJobType,
    isAiJobType,
    isReanalysisJobType,
    resolveCallbackUrl,
    parseScheduleConfig,
    validateScheduleConfig,
    buildJobDescription
};

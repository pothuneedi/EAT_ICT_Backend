'use strict';

const SCHEDULE_PATTERN = Object.freeze({
    ONE_TIME: 'ONE_TIME',
    CRON: 'CRON',
    REPEAT_INTERVAL: 'REPEAT_INTERVAL',
    REPEAT_AT: 'REPEAT_AT'
});

const INTERVAL_UNITS = new Set(['minutes', 'minute', 'hours', 'hour', 'days', 'day', 'weeks', 'week']);

function normalizeSchedulePattern(value) {
    const pattern = value || SCHEDULE_PATTERN.CRON;
    if (!Object.values(SCHEDULE_PATTERN).includes(pattern)) {
        throw new Error(`Invalid schedule_pattern '${value}'.`);
    }
    return pattern;
}

/**
 * Resolves pattern + value from a job_schedules row (backward compatible with cron_expression only).
 */
function resolveScheduleTiming(row = {}) {
    const pattern = normalizeSchedulePattern(row.schedule_pattern || SCHEDULE_PATTERN.CRON);
    let value = row.schedule_value != null && row.schedule_value !== ''
        ? String(row.schedule_value).trim()
        : '';

    if (!value && pattern === SCHEDULE_PATTERN.CRON && row.cron_expression) {
        value = String(row.cron_expression).trim();
    }

    return { pattern, value };
}

/**
 * Normalizes incoming payload: sets schedule_pattern, schedule_value, and keeps cron_expression in sync for CRON.
 */
function normalizeScheduleFields(data) {
    if (!data) {
        return;
    }

    const { pattern, value } = resolveScheduleTiming(data);
    data.schedule_pattern = pattern;
    data.schedule_value = value;

    if (pattern === SCHEDULE_PATTERN.CRON) {
        data.cron_expression = value;
    }
}

function validateScheduleTiming(pattern, value) {
    const normalizedPattern = normalizeSchedulePattern(pattern);
    const trimmed = value != null ? String(value).trim() : '';

    if (!trimmed) {
        throw new Error('schedule_value is required.');
    }

    switch (normalizedPattern) {
        case SCHEDULE_PATTERN.CRON:
            if (trimmed.split(/\s+/).length < 5) {
                throw new Error('Invalid cron expression (use BTP xscron, e.g. "* * * * * */60 0").');
            }
            break;

        case SCHEDULE_PATTERN.REPEAT_INTERVAL: {
            const match = trimmed.match(/^(\d+)\s+(\w+)$/i);
            if (!match) {
                throw new Error('Repeat interval must look like "30 minutes" or "2 hours".');
            }
            const amount = parseInt(match[1], 10);
            if (!Number.isFinite(amount) || amount < 1) {
                throw new Error('Repeat interval amount must be at least 1.');
            }
            const unit = match[2].toLowerCase();
            if (!INTERVAL_UNITS.has(unit)) {
                throw new Error('Repeat interval unit must be minutes, hours, days, or weeks.');
            }
            break;
        }

        case SCHEDULE_PATTERN.REPEAT_AT:
            if (trimmed.length < 3) {
                throw new Error('Repeat-at time is required (e.g. "6:30am").');
            }
            break;

        case SCHEDULE_PATTERN.ONE_TIME:
            if (Number.isNaN(Date.parse(trimmed)) && !/^\d/.test(trimmed)) {
                throw new Error('One-time schedule requires a valid date/time (ISO or human-readable).');
            }
            break;

        default:
            break;
    }

    return { pattern: normalizedPattern, value: trimmed };
}

function buildBtpSchedulePayload(pattern, value) {
    const { pattern: p, value: v } = validateScheduleTiming(pattern, value);

    switch (p) {
        case SCHEDULE_PATTERN.ONE_TIME:
            return { time: v };
        case SCHEDULE_PATTERN.CRON:
            return { cron: v };
        case SCHEDULE_PATTERN.REPEAT_INTERVAL:
            return { repeatInterval: v };
        case SCHEDULE_PATTERN.REPEAT_AT:
            return { repeatAt: v };
        default:
            throw new Error(`Unsupported schedule_pattern '${p}'.`);
    }
}

function normalizeAndValidateScheduleFields(data) {
    normalizeScheduleFields(data);
    validateScheduleTiming(data.schedule_pattern, data.schedule_value);
}

module.exports = {
    SCHEDULE_PATTERN,
    normalizeSchedulePattern,
    resolveScheduleTiming,
    normalizeScheduleFields,
    validateScheduleTiming,
    normalizeAndValidateScheduleFields,
    buildBtpSchedulePayload
};

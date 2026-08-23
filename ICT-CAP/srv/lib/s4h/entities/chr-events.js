'use strict';

/**
 * CHR Navisphere /v2/events entity config.
 *
 * The API accepts only: billToReferenceNumber, customerReferenceNumber,
 * navisphereTrackingNumber, orderNumber, loadNumber, eventType.
 * customer and eventTime filtering are applied client-side after the bulk fetch.
 *
 * Unfiltered calls return the most recent ~500 events (~19h of traffic) with no paging.
 */

const DEFAULT_LOOKBACK_MINUTES = 1440; // 1 day

function parsePositiveInt(value, fallback = null) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveLookbackMinutes(value) {
    if (value == null || value === '') {
        return parsePositiveInt(
            process.env.CHR_EVENTS_LOOKBACK_MINUTES,
            DEFAULT_LOOKBACK_MINUTES
        );
    }

    const minutes = parsePositiveInt(value, null);
    if (minutes == null) {
        throw new Error('lookbackMinutes must be a positive integer.');
    }

    return minutes;
}

/** Required on every syncChrEvents call — no env/default fallback. */
function resolveCustomer(value) {
    const trimmed = value != null ? String(value).trim() : '';
    if (!trimmed) {
        throw new Error('customer is required.');
    }
    return trimmed;
}

function resolveChrSyncOptions({ lookbackMinutes, customer } = {}) {
    return {
        lookbackMinutes: resolveLookbackMinutes(lookbackMinutes),
        customer: resolveCustomer(customer)
    };
}

function loadChrEventsEntityConfig({ lookbackMinutes, customer }) {
    return {
        cdsEntity: 'ict.chr_events',
        eventsPath: process.env.CHR_EVENTS_PATH || '/v2/events',
        lookbackMinutes,
        customer
    };
}

function buildEventsPath(entityConfig) {
    return entityConfig.eventsPath;
}

/** Rolling window: lookbackMinutes back from now, no upper bound (CHR clock skew). */
function resolveEventWindow(entityConfig, nowMs = Date.now()) {
    const fromMs = nowMs - entityConfig.lookbackMinutes * 60000;
    return {
        fromMs,
        toMs: null,
        minutes: entityConfig.lookbackMinutes,
        label: `${new Date(fromMs).toISOString()} onwards`
    };
}

/** Client-side customer + eventTime filters (CHR API cannot apply these server-side). */
function parseChrEventsBody(body, { fromMs = null, toMs = null, customer = null } = {}) {
    const rows = body?.results || [];

    if (fromMs == null && !customer) {
        return rows;
    }

    return rows.filter(row => {
        if (customer && row.customer && row.customer !== customer) {
            return false;
        }
        if (fromMs == null) {
            return true;
        }
        const t = row.eventTime ? Date.parse(row.eventTime) : NaN;
        if (!Number.isFinite(t)) {
            return false;
        }
        return t >= fromMs && (toMs == null || t <= toMs);
    });
}

module.exports = {
    loadChrEventsEntityConfig,
    resolveChrSyncOptions,
    resolveLookbackMinutes,
    resolveCustomer,
    buildEventsPath,
    resolveEventWindow,
    parseChrEventsBody,
    DEFAULT_LOOKBACK_MINUTES
};

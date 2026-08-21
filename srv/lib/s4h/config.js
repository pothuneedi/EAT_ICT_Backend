'use strict';

/**
 * Central S/4 sync configuration — runtime tuning via environment variables.
 * Entity OData paths/filters live in srv/lib/s4h/entities/*.js.
 */

const DEFAULT_PAGE_SIZE = 50;
/** Max rows fetched per entity in local dev (NODE_ENV !== 'production'). */
const LOCAL_DEV_ROW_LIMIT = 500;

function parsePositiveInt(value) {
    if (value == null || value === '') {
        return null;
    }
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function loadConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    const syncLimitRaw = (process.env.S4H_SYNC_LIMIT || '').trim();
    const explicitFullSync = process.env.S4H_FULL_SYNC === 'true' || syncLimitRaw === 'ALL';

    let devRowLimit = null;
    let fullSync = explicitFullSync;

    if (!fullSync && syncLimitRaw && syncLimitRaw !== 'ALL') {
        devRowLimit = parsePositiveInt(syncLimitRaw);
    }

    // Local dev: always cap volume so syncs stay fast (overrides S4H_SYNC_LIMIT=ALL).
    if (!isProduction) {
        devRowLimit = devRowLimit || LOCAL_DEV_ROW_LIMIT;
        fullSync = false;
    }

    if (!fullSync && !devRowLimit && isProduction) {
        fullSync = true;
    }

    // The gateway URL and its credentials come from the MB_API_GATEWAY destination
    // (or the S4H_PROXY_URL fallback locally) — see srv/lib/s4h/gateway.js.
    return {
        pageSize: parsePositiveInt(process.env.S4H_PAGE_SIZE) || DEFAULT_PAGE_SIZE,
        fullSync,
        devRowLimit,
        reconcileEnabled: process.env.S4H_RECONCILE !== 'false' && fullSync && !devRowLimit,
        upsertBatchSize: parsePositiveInt(process.env.S4H_UPSERT_BATCH_SIZE) || 200,
        maxRetries: parsePositiveInt(process.env.S4H_PROXY_RETRIES) || 3,
        retryDelayMs: parsePositiveInt(process.env.S4H_PROXY_RETRY_DELAY_MS) || 1000,
        requestTimeoutMs: parsePositiveInt(process.env.S4H_PROXY_TIMEOUT_MS) || 60000
    };
}

function syncModeLabel({ devRowLimit, fullSync }) {
    if (devRowLimit) {
        return `LIMITED(${devRowLimit})`;
    }
    return fullSync ? 'FULL' : 'PARTIAL';
}

module.exports = { loadConfig, syncModeLabel, DEFAULT_PAGE_SIZE, LOCAL_DEV_ROW_LIMIT };

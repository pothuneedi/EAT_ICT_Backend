'use strict';

const { SYNC_KIND } = require('./sync-registry');

function buildSyncMeta(config, {
    syncKind,
    totalInSource = null,
    dateScope = null,
    targets = [],
    counts = {}
} = {}) {
    const isFullRun = config.fullSync && !config.devRowLimit;

    const syncMode = isFullRun
        ? 'FULL'
        : (config.devRowLimit ? 'LIMITED' : 'PARTIAL');

    const scope = isFullRun
        ? 'ALL'
        : (config.devRowLimit ? String(config.devRowLimit) : 'PARTIAL');

    let totalToSync = null;
    if (totalInSource != null) {
        totalToSync = config.devRowLimit
            ? Math.min(config.devRowLimit, totalInSource)
            : totalInSource;
    } else if (config.devRowLimit) {
        totalToSync = config.devRowLimit;
    }

    const estimatedPages = totalToSync != null
        ? Math.ceil(totalToSync / config.pageSize)
        : null;

    return {
        syncKind,
        targets: targets.length ? targets : [],
        counts,
        dateScope,
        syncMode,
        scope,
        batchSize: config.pageSize,
        upsertBatchSize: config.upsertBatchSize,
        rowLimit: config.devRowLimit,
        fullSync: config.fullSync,
        reconcileEnabled: config.reconcileEnabled,
        totalInSource,
        totalToSync,
        estimatedPages,
        countAvailable: totalInSource != null,
        pagination: {
            batchSize: config.pageSize,
            strategy: 'odata_next_or_skip_top',
            commitPerPage: true
        }
    };
}

function formatS4SyncPlanMessage(meta) {
    const targetLabel = meta.targets?.join(' → ') || 'S/4 entities';

    const total = meta.countAvailable
        ? `${meta.totalToSync} record(s) across ${targetLabel}`
        : `records for ${targetLabel}`;

    const scopeLabel = meta.scope === 'ALL'
        ? 'full sync'
        : `limited sync (${meta.scope} rows)`;

    const scopeDetail = meta.syncKind === SYNC_KIND.MASTER
        ? 'master data full refresh'
        : (meta.dateScope?.label
            ? `PO date scope: ${meta.dateScope.label} (po_lines only)`
            : 'PO date scope: default last 30 days');

    return (
        `Syncing ${total} in batches of ${meta.batchSize} — ${scopeLabel}, `
        + `${scopeDetail}, mode: ${meta.syncMode}`
        + (meta.estimatedPages != null ? `, ~${meta.estimatedPages} page(s)` : '')
        + (meta.reconcileEnabled ? ', reconcile: on' : ', reconcile: off')
        + '.'
    );
}

function buildChrSyncMeta({ lookbackMinutes, customer } = {}) {
    return { lookbackMinutes, customer };
}

function formatChrSyncPlanMessage(meta) {
    return (
        `Syncing CHR events — customer: ${meta.customer}, `
        + `lookback: ${meta.lookbackMinutes} min.`
    );
}

module.exports = {
    buildSyncMeta,
    buildChrSyncMeta,
    formatS4SyncPlanMessage,
    formatChrSyncPlanMessage
};

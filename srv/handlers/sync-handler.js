'use strict';

const cds = require('@sap/cds');
const LogCollector = require('../lib/LogCollector');
const { persistExecutionLog } = require('../lib/execution-log-persist');
const { loadConfig } = require('../lib/s4h/config');
const {
    buildSyncMeta,
    buildChrSyncMeta,
    formatS4SyncPlanMessage,
    formatChrSyncPlanMessage
} = require('../lib/s4h/sync-meta');
const { resolveDateScope, resolveDateScopeFromConfig } = require('../lib/s4h/sync-scope');
const {
    SYNC_KIND,
    listMasterSyncTargets,
    listTransactionalSyncTargets
} = require('../lib/s4h/sync-registry');
const { syncChrEvents } = require('../lib/s4h/chr-events-syncer');
const { resolveChrSyncOptions } = require('../lib/s4h/entities/chr-events');
const {
    JOB_TYPE,
    parseScheduleConfig,
    validateScheduleConfig
} = require('../lib/job-schedule-types');
const {
    extractSchedulerHeaders,
    resolveJobSchedule,
    touchScheduleLastRun
} = require('../lib/job-schedule-resolve');

const MASTER_JOB_NAME = 'S4_MASTER_SYNC_JOB';
const TRANSACTIONAL_JOB_NAME = 'S4_TRANSACTIONAL_SYNC_JOB';
const CHR_JOB_NAME = 'S4_CHR_SYNC_JOB';

const activeRuns = {
    master: null,
    transactional: null,
    chr: null
};

const persistLogs = persistExecutionLog;

function emptyStats() {
    return {
        upserted: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        closed: 0,
        deleted: 0,
        deactivated: 0,
        warnings: 0,
        pages: 0
    };
}

function mergeStats(total, part) {
    total.upserted += part.upserted || 0;
    total.created += part.created || 0;
    total.updated += part.updated || 0;
    total.unchanged += part.unchanged || 0;
    total.skipped += part.skipped || 0;
    total.closed += part.closed || 0;
    total.deleted += part.deleted || 0;
    total.deactivated += part.deactivated || 0;
    total.warnings += part.warnings || 0;
    total.pages += part.pages || 0;
    total.byEntity = total.byEntity || {};
    total.byEntity[part.entity] = part;
}

function resolvePipelineMeta(targets, { syncKind, dateScope = null }) {
    const config = loadConfig();
    return buildSyncMeta(config, {
        syncKind,
        dateScope,
        targets: targets.map(t => t.label),
        counts: {}
    });
}

async function runS4Pipeline({ runId, jobName, targets, meta, activeKey, scheduleLogId = null }) {
    const log = new LogCollector(runId, scheduleLogId);
    log.setModel('SAP', 'S/4HANA OData');
    log.info(formatS4SyncPlanMessage(meta));

    const runTs = new Date().toISOString();
    let lastPersist = 0;

    const onProgress = async () => {
        if (log.status !== 'RUNNING') {
            return;
        }
        const now = Date.now();
        if (now - lastPersist >= 800) {
            lastPersist = now;
            await persistLogs(log);
        }
    };

    const totals = emptyStats();

    try {
        log.updateStats({ total_batch_size: meta.totalToSync || 0 });
        await persistLogs(log);

        for (const target of targets) {
            log.info(`--- Syncing ${target.label} ---`);
            const result = await target.sync(runTs, { log, onProgress, meta });
            mergeStats(totals, { ...result, entity: target.label });
        }

        log.updateStats({
            total_batch_size: meta.totalToSync || totals.upserted + totals.closed,
            processed_count: totals.upserted,
            created_count: totals.created,
            updated_count: totals.updated,
            skipped_count: totals.skipped + totals.unchanged
        });

        log.finish('SUCCESS');
        const skippedUnavailable = Object.values(totals.byEntity || {})
            .some(part => part.serviceUnavailable);
        if (skippedUnavailable) {
            log.warn('One or more entities were skipped because the S/4 OData service is not available yet.');
        }
        log.info(
            `S/4 ${meta.syncKind} sync finished — ${totals.pages} page(s), ${totals.upserted} upserted, `
            + `${totals.deleted} deleted, ${totals.deactivated} deactivated, ${totals.closed} closed.`
        );
        await persistLogs(log);
        await touchScheduleLastRun(scheduleLogId);

        return totals;
    } catch (err) {
        console.error(`[SyncHandler] S/4 ${meta.syncKind} sync failed: ${err.message}`, err);
        if (log.status === 'RUNNING') {
            log.systemError(err.message, err);
        }
        await persistLogs(log);
        await touchScheduleLastRun(scheduleLogId);
        throw err;
    } finally {
        activeRuns[activeKey] = null;
    }
}

async function runChrSync({ runId, meta, chrOptions, scheduleLogId = null }) {
    const log = new LogCollector(runId, scheduleLogId);
    log.setModel('CHR', 'Navisphere /v2/events');
    log.info(formatChrSyncPlanMessage(meta));

    const runTs = new Date().toISOString();
    let lastPersist = 0;

    const onProgress = async () => {
        if (log.status !== 'RUNNING') {
            return;
        }
        const now = Date.now();
        if (now - lastPersist >= 800) {
            lastPersist = now;
            await persistLogs(log);
        }
    };

    try {
        log.updateStats({ total_batch_size: 0 });
        await persistLogs(log);

        const result = await syncChrEvents(runTs, { log, onProgress, ...chrOptions });

        log.updateStats({
            total_batch_size: result.upserted || 0,
            processed_count: result.upserted || 0
        });

        log.finish('SUCCESS');
        if (result.fetchErrors) {
            log.warn('CHR sync completed with no data (source unavailable or empty window).');
        }
        log.info(
            `CHR sync finished — ${result.matchedInSource} event(s) in window, `
            + `${result.upserted} upserted (${result.poLinked ?? 0} po_linked).`
        );
        await persistLogs(log);
        await touchScheduleLastRun(scheduleLogId);

        return result;
    } catch (err) {
        console.error(`[SyncHandler] CHR sync failed: ${err.message}`, err);
        if (log.status === 'RUNNING') {
            log.systemError(err.message, err);
        }
        await persistLogs(log);
        await touchScheduleLastRun(scheduleLogId);
        throw err;
    } finally {
        activeRuns.chr = null;
    }
}

function spawnBackgroundJob(runId, label, jobFn) {
    cds.spawn({ every: false }, async () => {
        try {
            await jobFn();
        } catch (err) {
            console.error(`[SyncHandler] Background ${label} error:`, err.message);
        }
    });
}

function buildAcceptedResponse({ runId, job, message, meta, extra = {} }) {
    return JSON.stringify({
        status: 'Accepted',
        runId,
        job,
        message,
        meta,
        ...extra
    });
}

function assertNotRunning(activeKey, jobLabel) {
    const runId = activeRuns[activeKey];
    if (runId) {
        return `S/4 ${jobLabel} sync already in progress (runId: ${runId}). Poll ExecutionLogs for progress.`;
    }
    return null;
}

async function logSkippedScheduledRun({ runId, scheduleLogId, message }) {
    const log = new LogCollector(runId, scheduleLogId);
    log.warn(message);
    log.finish('SUCCESS');
    await persistLogs(log);
    await touchScheduleLastRun(scheduleLogId);
}

async function startS4Pipeline({ req, activeKey, jobName, syncKind, targets, dateScope = null, scheduleLogId = null, runId = null }) {
    const conflict = assertNotRunning(activeKey, syncKind.toLowerCase());
    if (conflict) {
        if (req) {
            req.error(409, conflict);
            return null;
        }
        await logSkippedScheduledRun({
            runId: runId || cds.utils.uuid(),
            scheduleLogId,
            message: conflict
        });
        return null;
    }

    const effectiveRunId = runId || cds.utils.uuid();
    activeRuns[activeKey] = effectiveRunId;
    const meta = resolvePipelineMeta(targets, { syncKind, dateScope });

    spawnBackgroundJob(effectiveRunId, syncKind, () => runS4Pipeline({
        runId: effectiveRunId,
        jobName,
        targets,
        meta,
        activeKey,
        scheduleLogId
    }));

    return buildAcceptedResponse({
        runId: effectiveRunId,
        job: jobName,
        message: formatS4SyncPlanMessage(meta),
        meta,
        extra: { targets: meta.targets, syncKind }
    });
}

async function handleSyncMasterData(req) {
    return startS4Pipeline({
        req,
        activeKey: 'master',
        jobName: MASTER_JOB_NAME,
        syncKind: SYNC_KIND.MASTER,
        targets: listMasterSyncTargets()
    });
}

async function handleSyncTransactionalData(req) {
    let dateScope;
    try {
        dateScope = resolveDateScope({
            fromDate: req.data.fromDate,
            toDate: req.data.toDate
        });
    } catch (err) {
        req.error(400, err.message);
        return;
    }

    return startS4Pipeline({
        req,
        activeKey: 'transactional',
        jobName: TRANSACTIONAL_JOB_NAME,
        syncKind: SYNC_KIND.TRANSACTIONAL,
        targets: listTransactionalSyncTargets(),
        dateScope
    });
}

async function handleSyncChrEvents(req) {
    let chrOptions;
    try {
        chrOptions = resolveChrSyncOptions(req.data);
    } catch (err) {
        req.error(400, err.message);
        return;
    }

    if (activeRuns.chr) {
        req.error(409, `CHR sync already in progress (runId: ${activeRuns.chr}). Poll ExecutionLogs for progress.`);
        return;
    }

    const meta = buildChrSyncMeta(chrOptions);
    const runId = cds.utils.uuid();
    activeRuns.chr = runId;

    spawnBackgroundJob(runId, 'CHR', () => runChrSync({ runId, meta, chrOptions }));

    return buildAcceptedResponse({
        runId,
        job: CHR_JOB_NAME,
        message: formatChrSyncPlanMessage(meta),
        meta,
        extra: chrOptions
    });
}

async function runScheduledSyncJob({ jobConfig, runId }) {
    const scheduleLogId = jobConfig.ID;
    const config = parseScheduleConfig(jobConfig.config);
    validateScheduleConfig(jobConfig.job_type, config);

    switch (jobConfig.job_type) {
        case JOB_TYPE.S4_MASTER_SYNC:
            return startS4Pipeline({
                activeKey: 'master',
                jobName: MASTER_JOB_NAME,
                syncKind: SYNC_KIND.MASTER,
                targets: listMasterSyncTargets(),
                scheduleLogId,
                runId
            });

        case JOB_TYPE.S4_TRANSACTIONAL_SYNC: {
            const dateScope = resolveDateScopeFromConfig(config);
            return startS4Pipeline({
                activeKey: 'transactional',
                jobName: TRANSACTIONAL_JOB_NAME,
                syncKind: SYNC_KIND.TRANSACTIONAL,
                targets: listTransactionalSyncTargets(),
                dateScope,
                scheduleLogId,
                runId
            });
        }

        case JOB_TYPE.S4_CHR_SYNC: {
            const chrOptions = resolveChrSyncOptions({
                customer: config.customer,
                lookbackMinutes: config.lookbackMinutes
            });

            if (activeRuns.chr) {
                await logSkippedScheduledRun({
                    runId,
                    scheduleLogId,
                    message: `CHR sync already in progress (runId: ${activeRuns.chr}).`
                });
                return { status: 'Accepted', message: 'CHR sync skipped — already running', count: 0 };
            }

            const meta = buildChrSyncMeta(chrOptions);
            activeRuns.chr = runId;

            spawnBackgroundJob(runId, 'CHR', () => runChrSync({
                runId,
                meta,
                chrOptions,
                scheduleLogId
            }));

            return {
                status: 'Accepted',
                message: formatChrSyncPlanMessage(meta),
                count: 0
            };
        }

        default:
            throw new Error(`JobSchedule "${jobConfig.job_name}" is not a sync schedule (job_type: ${jobConfig.job_type}).`);
    }
}

function register(srv) {
    srv.on('syncMasterData', handleSyncMasterData);
    srv.on('syncTransactionalData', handleSyncTransactionalData);
    srv.on('syncChrEvents', handleSyncChrEvents);

    srv.on('runScheduledSync', (req) => {
        const { jobId, scheduleId, runId } = extractSchedulerHeaders(req);

        if (!jobId && !scheduleId) {
            req.error(400, 'Missing x-sap-job-id or x-sap-job-schedule-id header.');
            return;
        }

        cds.spawn({ every: false }, async () => {
            let scheduleLogId = null;
            try {
                const jobConfig = await resolveJobSchedule({ jobId, scheduleId });
                scheduleLogId = jobConfig.ID;
                await runScheduledSyncJob({ jobConfig, runId });
            } catch (err) {
                console.error('[SyncHandler] Scheduled sync error:', err.message);
                const log = new LogCollector(runId, scheduleLogId);
                log.systemError(err.message, err);
                await persistLogs(log);
                await touchScheduleLastRun(scheduleLogId);
            }
        });

        return { status: 'Accepted', message: 'Scheduled sync started in background', count: 0 };
    });
}

module.exports = { register };

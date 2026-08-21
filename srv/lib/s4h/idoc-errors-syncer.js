'use strict';

const cds = require('@sap/cds');
const { fetchInPages, proxyGet, proxyGetCount } = require('./fetch');
const { loadConfig, syncModeLabel } = require('./config');
const { loadOpenPoNumbers } = require('./open-po-scope');
const { chunkArray } = require('./entities/_shared');
const {
    loadIdocErrorsEntityConfig,
    buildPathForPoBatch,
    buildCountPathForPoBatch,
    buildProbePath
} = require('./entities/idoc-errors');
const { mapIdocErrorRow, buildIdocUpsertRow } = require('./idoc-errors-mapper');
const { deleteStaleIdocErrorsInOpenPoScope, upsertInBatches } = require('./reconcile');

const EXISTING_COLUMNS = [
    'docnum', 'po_number', 'line_item', 'status', 'status_text', 'error_msg',
    'bill_of_lading', 'status_group', 'status_logdat',
    'ai_processed', 'ai_processed_at', 'exception_type_hint', 'ict_exception_id'
];

function idocRowKey(row) {
    return `${row.docnum}_${row.po_number}_${row.line_item}`;
}

async function probeIdocService(entityConfig) {
    try {
        await proxyGet(buildProbePath(entityConfig));
        return true;
    } catch (err) {
        if (/403|404/.test(err.message)) {
            return false;
        }
        throw err;
    }
}

async function upsertIdocPage(entityConfig, pageRows, runTs, stats, upsertBatchSize) {
    const incomingRows = pageRows.map(row => mapIdocErrorRow(row, runTs)).filter(Boolean);
    stats.skipped += pageRows.length - incomingRows.length;

    if (!incomingRows.length) {
        return;
    }

    await cds.tx(async tx => {
        const poNumbers = [...new Set(incomingRows.map(row => row.po_number))];
        const existingRows = await tx.run(
            SELECT.from(entityConfig.cdsEntity)
                .columns(...EXISTING_COLUMNS)
                .where({ po_number: { in: poNumbers } })
        );

        const existingMap = new Map(
            existingRows.map(row => [idocRowKey(row), row])
        );

        const upsertRows = incomingRows.map(incoming => {
            const plan = buildIdocUpsertRow(
                existingMap.get(idocRowKey(incoming)),
                incoming
            );

            if (plan.op === 'insert') {
                stats.created += 1;
            } else if (plan.op === 'update') {
                stats.updated += 1;
            } else {
                stats.unchanged += 1;
            }

            return plan.row;
        });

        await upsertInBatches(tx, entityConfig.cdsEntity, upsertRows, upsertBatchSize);
        stats.upserted += upsertRows.length;
    });
}

async function syncIdocErrors(runTs, { log, onProgress } = {}) {
    const config = loadConfig();
    const entityConfig = loadIdocErrorsEntityConfig();

    const stats = {
        upserted: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        deleted: 0,
        pages: 0,
        poBatches: 0,
        openPoCount: 0,
        serviceUnavailable: false
    };

    const openPoNumbers = await loadOpenPoNumbers();
    stats.openPoCount = openPoNumbers.length;

    if (!openPoNumbers.length) {
        log?.info('No open PO lines in DB — skipping IDoc error sync.');
        return stats;
    }

    if (!(await probeIdocService(entityConfig))) {
        log?.warn(`Skipping IDoc error sync — S/4 service '${entityConfig.service}' is not available.`);
        stats.serviceUnavailable = true;
        return stats;
    }

    const poBatches = chunkArray(openPoNumbers, entityConfig.poBatchSize);
    let limitReached = false;

    log?.info(
        `Starting IDoc error sync (${syncModeLabel(config)}, page size: ${config.pageSize}, `
        + `open POs: ${openPoNumbers.length})...`
    );

    for (const poBatch of poBatches) {
        if (limitReached) {
            break;
        }

        stats.poBatches += 1;
        await fetchInPages(buildPathForPoBatch(entityConfig, poBatch), async (pageRows, pageMeta) => {
            if (!pageRows?.length) {
                return;
            }

            stats.pages += 1;
            log?.info(
                `PO batch ${stats.poBatches}/${poBatches.length}, page ${pageMeta.pageIndex}: `
                + `processing ${pageRows.length} IDoc error(s)...`
            );

            await upsertIdocPage(entityConfig, pageRows, runTs, stats, config.upsertBatchSize);

            log?.updateStats({
                total_batch_size: stats.upserted,
                processed_count: stats.upserted,
                created_count: stats.created,
                updated_count: stats.updated,
                skipped_count: stats.skipped + stats.unchanged
            });

            if (onProgress) {
                await onProgress();
            }

            if (config.devRowLimit && stats.upserted >= config.devRowLimit) {
                limitReached = true;
                return false;
            }
        });
    }

    if (config.reconcileEnabled) {
        await cds.tx(async tx => {
            stats.deleted = await deleteStaleIdocErrorsInOpenPoScope(tx, runTs, openPoNumbers);
        });
    }

    log?.info(
        `IDoc error sync complete — upserted: ${stats.upserted}, skipped: ${stats.skipped}, `
        + `deleted: ${stats.deleted}.`
    );

    return stats;
}

async function countIdocErrors() {
    const entityConfig = loadIdocErrorsEntityConfig();
    const openPoNumbers = await loadOpenPoNumbers();

    if (!openPoNumbers.length) {
        return 0;
    }

    let total = 0;
    for (const poBatch of chunkArray(openPoNumbers, entityConfig.poBatchSize)) {
        total += await proxyGetCount(buildCountPathForPoBatch(entityConfig, poBatch));
    }
    return total;
}

module.exports = { syncIdocErrors, countIdocErrors, upsertIdocPage };

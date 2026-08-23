'use strict';

const cds = require('@sap/cds');
const { fetchInPages, proxyGetCount } = require('./fetch');
const { loadConfig } = require('./config');
const { upsertInBatches, deactivateStaleMasterRows } = require('./reconcile');

function mapPageRows(pageRows, runTs, mapRow) {
    const mapped = [];
    for (const row of pageRows) {
        const mappedRow = mapRow(row, runTs);
        if (mappedRow) {
            mapped.push(mappedRow);
        }
    }
    return mapped;
}

/**
 * Generic full-set master data sync: page fetch → map → upsert per page → soft reconcile.
 * Use `mapPage` when a page needs async enrichment (e.g. suppliers + business partners).
 */
async function syncMasterEntity(runTs, spec, { log, onProgress } = {}) {
    const config = loadConfig();
    const { label, cdsEntity, odataPath, mapRow, mapPage } = spec;

    const stats = {
        upserted: 0,
        pages: 0,
        skipped: 0,
        deactivated: 0,
        warnings: 0
    };

    log?.info(
        `Starting ${label} sync (page size: ${config.pageSize}, `
        + `reconcile: ${config.reconcileEnabled ? 'on' : 'off'})...`
    );

    await fetchInPages(odataPath, async (pageRows, pageMeta) => {
        if (!pageRows?.length) {
            return;
        }

        const mapped = mapPage
            ? await mapPage(pageRows, runTs, { log, pageMeta })
            : mapPageRows(pageRows, runTs, mapRow);

        stats.skipped += pageRows.length - mapped.length;
        if (stats.skipped > 0) {
            stats.warnings += pageRows.length - mapped.length;
        }

        if (mapped.length) {
            await cds.tx(async tx => {
                await upsertInBatches(tx, cdsEntity, mapped, config.upsertBatchSize);
            });
            stats.upserted += mapped.length;
        }

        stats.pages += 1;
        log?.info(
            `Page ${pageMeta.pageIndex}: upserted ${mapped.length} ${label} row(s)`,
            { fetchedTotal: pageMeta.fetchedTotal }
        );

        if (onProgress) {
            await onProgress();
        }
    });

    if (config.reconcileEnabled) {
        log?.info(`Deactivating stale ${label} not seen in this run...`);
        await cds.tx(async tx => {
            stats.deactivated = await deactivateStaleMasterRows(tx, cdsEntity, runTs);
        });
    } else {
        log?.info(`${label} reconcile skipped (partial/dev sync).`);
    }

    log?.info(
        `${label} sync complete — pages: ${stats.pages}, upserted: ${stats.upserted}, `
        + `deactivated: ${stats.deactivated}, skipped: ${stats.skipped}.`
    );

    return stats;
}

async function countODataEntity(countPath) {
    return proxyGetCount(countPath);
}

module.exports = { syncMasterEntity, countODataEntity };

'use strict';

const cds = require('@sap/cds');
const { fetchInPages, proxyGetCount, fetchODataResults } = require('./fetch');
const { loadConfig, syncModeLabel } = require('./config');
const { loadOpenPoNumbers } = require('./open-po-scope');
const {
    loadAsnIbdEntityConfig,
    buildItemPathForPoBatch,
    buildCountPathForPoBatch,
    buildHeaderPathForDeliveryBatch
} = require('./entities/asn-ibd');
const { chunkArray } = require('./entities/_shared');
const { mapIbdItem } = require('./asn-ibd-mapper');
const { deleteStaleAsnInOpenPoScope, upsertInBatches } = require('./reconcile');
const { refreshPoLineQuantitiesFromAsn } = require('./po-lines-qty');

async function fetchHeadersByDeliveryDocuments(entityConfig, deliveryNumbers, headerCache) {
    const missing = [...new Set(deliveryNumbers.filter(Boolean))]
        .filter(delivery => !headerCache.has(delivery));

    for (const batch of chunkArray(missing, entityConfig.headerBatchSize)) {
        const headers = await fetchODataResults(buildHeaderPathForDeliveryBatch(entityConfig, batch));
        for (const header of headers) {
            if (header?.DeliveryDocument) {
                headerCache.set(header.DeliveryDocument, header);
            }
        }
    }
}

async function upsertAsnPage(pageRows, runTs, stats, upsertBatchSize, entityConfig, headerCache) {
    await fetchHeadersByDeliveryDocuments(
        entityConfig,
        pageRows.map(row => row.DeliveryDocument),
        headerCache
    );

    const mapped = pageRows
        .map(row => mapIbdItem(row, runTs, headerCache.get(row.DeliveryDocument)))
        .filter(Boolean);

    stats.skipped += pageRows.length - mapped.length;
    if (!mapped.length) {
        return;
    }

    await cds.tx(async tx => {
        await upsertInBatches(tx, entityConfig.cdsEntity, mapped, upsertBatchSize);
    });
    stats.upserted += mapped.length;
}

async function syncAsnIbd(runTs, { log, onProgress } = {}) {
    const config = loadConfig();
    const entityConfig = loadAsnIbdEntityConfig();

    const stats = { upserted: 0, skipped: 0, deleted: 0, pages: 0, poBatches: 0, openPoCount: 0 };
    const openPoNumbers = await loadOpenPoNumbers();
    stats.openPoCount = openPoNumbers.length;

    if (!openPoNumbers.length) {
        log?.info('No open PO lines in DB — skipping ASN sync.');
        return stats;
    }

    const poBatches = chunkArray(openPoNumbers, entityConfig.poBatchSize);
    const headerCache = new Map();
    let limitReached = false;

    log?.info(
        `Starting ASN sync (${syncModeLabel(config)}, page size: ${config.pageSize}, `
        + `open POs: ${openPoNumbers.length})...`
    );

    for (const poBatch of poBatches) {
        if (limitReached) {
            break;
        }

        stats.poBatches += 1;
        await fetchInPages(buildItemPathForPoBatch(entityConfig, poBatch), async (pageRows, pageMeta) => {
            if (!pageRows?.length) {
                return;
            }

            stats.pages += 1;
            log?.info(
                `PO batch ${stats.poBatches}/${poBatches.length}, page ${pageMeta.pageIndex}: `
                + `processing ${pageRows.length} ASN item(s)...`
            );

            await upsertAsnPage(pageRows, runTs, stats, config.upsertBatchSize, entityConfig, headerCache);

            log?.updateStats({
                total_batch_size: stats.upserted,
                processed_count: stats.upserted,
                skipped_count: stats.skipped
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
            stats.deleted = await deleteStaleAsnInOpenPoScope(tx, runTs, openPoNumbers);
        });
    }

    await cds.tx(async tx => {
        stats.poQtyRefreshed = await refreshPoLineQuantitiesFromAsn(tx, openPoNumbers, runTs);
    });

    log?.info(
        `ASN sync complete — upserted: ${stats.upserted}, skipped: ${stats.skipped}, `
        + `deleted: ${stats.deleted}, po qty refreshed: ${stats.poQtyRefreshed || 0}.`
    );

    if (!stats.upserted && stats.openPoCount > 0) {
        log?.warn(
            `No inbound delivery items in S/4 for ${stats.openPoCount} open PO(s) `
            + `(filter: ${entityConfig.poRefField} in open po_lines). `
            + 'Verify in Postman that those PO numbers exist on A_InbDeliveryItem.'
        );
    }

    return stats;
}

async function countAsnIbd() {
    const entityConfig = loadAsnIbdEntityConfig();
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

module.exports = { syncAsnIbd, countAsnIbd };

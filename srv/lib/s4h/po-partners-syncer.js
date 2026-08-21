'use strict';

const cds = require('@sap/cds');
const { loadConfig, syncModeLabel } = require('./config');
const { loadOpenPoNumbers } = require('./open-po-scope');
const { loadPoPartnersEntityConfig, fetchPoPartnersFromS4 } = require('./entities/po-partners');
const { mapPoPartnerRow } = require('./po-partners-mapper');
const { chunkArray } = require('./entities/_shared');
const { upsertInBatches, deleteStalePoPartnersInOpenPoScope } = require('./reconcile');

/**
 * The only parallel fan-out in the S/4 sync path, so this value alone decides
 * how many ABAP dialog work processes a sync occupies. An unset, empty or
 * malformed variable must fall back to the safe value rather than the old
 * default — S4H_PO_PARTNER_PARALLEL="" should not quietly double the load.
 */
const DEFAULT_PO_PARTNER_PARALLEL = 5;

function parseParallelLimit() {
    const n = parseInt(process.env.S4H_PO_PARTNER_PARALLEL, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PO_PARTNER_PARALLEL;
}

async function syncPoPartners(runTs, { log } = {}) {
    const config = loadConfig();
    const entityConfig = loadPoPartnersEntityConfig();
    const openPoNumbers = await loadOpenPoNumbers();

    const stats = { upserted: 0, skipped: 0, deleted: 0, poCount: openPoNumbers.length };
    if (!openPoNumbers.length) {
        log?.info('No open PO lines in DB — skipping po_partners sync.');
        return stats;
    }

    const parallel = parseParallelLimit();
    log?.info(
        `Starting po_partners sync (${syncModeLabel(config)}, open POs: ${openPoNumbers.length}, `
        + `parallel: ${parallel})...`
    );

    for (const batch of chunkArray(openPoNumbers, parallel)) {
        const mapped = [];

        await Promise.all(batch.map(async poNumber => {
            try {
                const rows = await fetchPoPartnersFromS4(poNumber);
                for (const row of rows) {
                    const mappedRow = mapPoPartnerRow(row, runTs);
                    if (mappedRow) {
                        mapped.push(mappedRow);
                    }
                }
            } catch (err) {
                stats.skipped += 1;
                log?.warn(`PO ${poNumber} partners fetch failed: ${err.message}`);
            }
        }));

        if (mapped.length) {
            await cds.tx(async tx => {
                await upsertInBatches(tx, entityConfig.cdsEntity, mapped, config.upsertBatchSize);
            });
            stats.upserted += mapped.length;
        }

        log?.updateStats({
            total_batch_size: stats.upserted,
            processed_count: stats.upserted,
            skipped_count: stats.skipped
        });
    }

    if (config.reconcileEnabled) {
        await cds.tx(async tx => {
            stats.deleted = await deleteStalePoPartnersInOpenPoScope(tx, runTs, openPoNumbers);
        });
    }

    log?.info(
        `po_partners sync complete — upserted: ${stats.upserted}, skipped POs: ${stats.skipped}, `
        + `deleted: ${stats.deleted}.`
    );

    return stats;
}

async function countPoPartners() {
    return (await loadOpenPoNumbers()).length;
}

module.exports = { syncPoPartners, countPoPartners };

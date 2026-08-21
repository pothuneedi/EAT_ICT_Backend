#!/usr/bin/env node
/* global SELECT */
'use strict';

/**
 * Sync one PO from S/4HANA: po_lines → po_partners → asn_ibd → edi856_idoc_errors.
 * Usage: node scripts/sync-po.js 4500016495
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const cds = require('@sap/cds');
const { fetchODataResults, fetchInPages } = require('../srv/lib/s4h/fetch');
const { loadConfig } = require('../srv/lib/s4h/config');
const { mapSapPoLineSnapshot } = require('../srv/lib/s4h/po-lines-mapper');
const { buildPoLineUpsertRow, EXISTING_LOAD_COLUMNS } = require('../srv/lib/s4h/po-lines-merge');
const { loadAsnReceivedByPoLine, refreshPoLineQuantitiesFromAsn } = require('../srv/lib/s4h/po-lines-qty');
const { upsertInBatches } = require('../srv/lib/s4h/reconcile');
const { fetchPoPartnersFromS4 } = require('../srv/lib/s4h/entities/po-partners');
const { mapPoPartnerRow } = require('../srv/lib/s4h/po-partners-mapper');
const {
    loadAsnIbdEntityConfig,
    buildItemPathForPoBatch,
    buildHeaderPathForDeliveryBatch
} = require('../srv/lib/s4h/entities/asn-ibd');
const { mapIbdItem } = require('../srv/lib/s4h/asn-ibd-mapper');
const {
    loadIdocErrorsEntityConfig,
    buildPathForPoBatch
} = require('../srv/lib/s4h/entities/idoc-errors');
const { upsertIdocPage } = require('../srv/lib/s4h/idoc-errors-syncer');
const {
    buildODataBasePath,
    buildODataQuery,
    escapeODataString,
    splitCsv,
    chunkArray
} = require('../srv/lib/s4h/entities/_shared');

const PO = String(process.argv[2] || '').trim();
if (!PO) {
    console.error('Usage: node scripts/sync-po.js <po_number>');
    process.exit(1);
}

function buildPoLinesPath(poNumber) {
    const service = process.env.S4H_PO_SERVICE || 'API_PURCHASEORDER_PROCESS_SRV';
    const entitySet = process.env.S4H_PO_ENTITY_SET || 'A_PurchaseOrderItem';
    const expandNav = splitCsv(process.env.S4H_PO_EXPAND || 'to_PurchaseOrder,to_ScheduleLine');
    const filter = `PurchaseOrder eq '${escapeODataString(poNumber)}'`;
    const basePath = buildODataBasePath(service, entitySet);
    return `${basePath}${buildODataQuery({ expand: expandNav, filter })}`;
}

function loadPoLineEntityConfig() {
    return {
        intracompanyDocTypes: splitCsv(process.env.S4H_INTRACOMPANY_DOC_TYPES || 'UB')
    };
}

async function loadExistingLines(tx, poNumber) {
    const rows = await tx.run(
        SELECT.from('ict.po_lines')
            .columns(...EXISTING_LOAD_COLUMNS)
            .where({ po_number: poNumber })
    );
    return new Map(rows.map((line) => [`${line.po_number}-${line.line_item}`, line]));
}

async function syncPoLines(poNumber, runTs) {
    const entityConfig = loadPoLineEntityConfig();
    const s4Items = await fetchODataResults(buildPoLinesPath(poNumber));
    if (!s4Items.length) {
        return { upserted: 0, skipped: 0, message: 'No PO lines returned from S/4' };
    }

    const stats = { upserted: 0, skipped: 0, created: 0, updated: 0 };
    await cds.tx(async (tx) => {
        const existingMap = await loadExistingLines(tx, poNumber);
        const asnReceivedByLine = await loadAsnReceivedByPoLine(tx, [poNumber]);
        const upsertRows = [];

        for (const s4Item of s4Items) {
            const incoming = mapSapPoLineSnapshot(s4Item, entityConfig);
            const plan = buildPoLineUpsertRow(
                existingMap.get(`${incoming.po_number}-${incoming.line_item}`),
                incoming,
                runTs,
                { asnReceivedByLine }
            );

            if (plan.skip) {
                stats.skipped += 1;
                continue;
            }
            if (plan.op === 'insert') {
                stats.created += 1;
            } else if (plan.op === 'update') {
                stats.updated += 1;
            }
            upsertRows.push(plan.row);
        }

        if (upsertRows.length) {
            await upsertInBatches(tx, 'ict.po_lines', upsertRows, loadConfig().upsertBatchSize);
            stats.upserted = upsertRows.length;
        }
    });

    return stats;
}

async function syncPoPartners(poNumber, runTs) {
    const rows = await fetchPoPartnersFromS4(poNumber);
    const mapped = rows.map((row) => mapPoPartnerRow(row, runTs)).filter(Boolean);
    if (!mapped.length) {
        return { upserted: 0 };
    }

    await cds.tx(async (tx) => {
        await upsertInBatches(tx, 'ict.po_partners', mapped, loadConfig().upsertBatchSize);
    });
    return { upserted: mapped.length };
}

async function fetchHeadersByDelivery(entityConfig, deliveryNumbers, headerCache) {
    const missing = [...new Set(deliveryNumbers.filter(Boolean))]
        .filter((delivery) => !headerCache.has(delivery));

    for (const batch of chunkArray(missing, entityConfig.headerBatchSize)) {
        const headers = await fetchODataResults(buildHeaderPathForDeliveryBatch(entityConfig, batch));
        for (const header of headers) {
            if (header?.DeliveryDocument) {
                headerCache.set(header.DeliveryDocument, header);
            }
        }
    }
}

async function syncAsn(poNumber, runTs) {
    const entityConfig = loadAsnIbdEntityConfig();
    const config = loadConfig();
    const stats = { upserted: 0, skipped: 0, pages: 0 };
    const headerCache = new Map();

    await fetchInPages(buildItemPathForPoBatch(entityConfig, [poNumber]), async (pageRows) => {
        if (!pageRows?.length) {
            return;
        }
        stats.pages += 1;
        await fetchHeadersByDelivery(
            entityConfig,
            pageRows.map((row) => row.DeliveryDocument),
            headerCache
        );

        const mapped = pageRows
            .map((row) => mapIbdItem(row, runTs, headerCache.get(row.DeliveryDocument)))
            .filter(Boolean);
        stats.skipped += pageRows.length - mapped.length;

        if (mapped.length) {
            await cds.tx(async (tx) => {
                await upsertInBatches(tx, entityConfig.cdsEntity, mapped, config.upsertBatchSize);
            });
            stats.upserted += mapped.length;
        }
    });

    await cds.tx(async (tx) => {
        stats.poQtyRefreshed = await refreshPoLineQuantitiesFromAsn(tx, [poNumber], runTs);
    });

    return stats;
}

async function syncIdocErrors(poNumber, runTs) {
    const entityConfig = loadIdocErrorsEntityConfig();
    const config = loadConfig();
    const stats = { upserted: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };

    await fetchInPages(buildPathForPoBatch(entityConfig, [poNumber]), async (pageRows) => {
        await upsertIdocPage(entityConfig, pageRows, runTs, stats, config.upsertBatchSize);
    });

    return stats;
}

async function printCounts(poNumber) {
    const [lines, partners, asn, idoc] = await Promise.all([
        cds.run(SELECT.one.from('ict.po_lines').columns('count(*) as c').where({ po_number: poNumber })),
        cds.run(SELECT.one.from('ict.po_partners').columns('count(*) as c').where({ po_number: poNumber })),
        cds.run(SELECT.one.from('ict.asn_ibd').columns('count(*) as c').where({ reference_document: poNumber })),
        cds.run(SELECT.one.from('ict.edi856_idoc_errors').columns('count(*) as c').where({ po_number: poNumber }))
    ]);
    console.log('DB counts:', {
        po_lines: lines?.c || 0,
        po_partners: partners?.c || 0,
        asn_ibd: asn?.c || 0,
        edi856_idoc_errors: idoc?.c || 0
    });
}

async function main() {
    cds.model = await cds.load('*');
    await cds.connect.to('db');
    const runTs = new Date().toISOString();

    console.log(`Syncing PO ${PO} from S/4...`);

    const poStats = await syncPoLines(PO, runTs);
    console.log('po_lines:', poStats);
    if (!poStats.upserted && poStats.skipped === 0 && poStats.message) {
        console.error(poStats.message);
        process.exit(1);
    }

    const partnerStats = await syncPoPartners(PO, runTs);
    console.log('po_partners:', partnerStats);

    const asnStats = await syncAsn(PO, runTs);
    console.log('asn_ibd:', asnStats);

    const idocStats = await syncIdocErrors(PO, runTs);
    console.log('edi856_idoc_errors:', idocStats);

    await printCounts(PO);
    console.log('Done.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

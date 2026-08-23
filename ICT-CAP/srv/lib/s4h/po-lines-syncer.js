'use strict';

const cds = require('@sap/cds');
const { fetchInPages, proxyGetCount } = require('./fetch');
const { loadConfig, syncModeLabel } = require('./config');
const { loadPoLinesEntityConfig } = require('./entities/po-lines');
const { mapSapPoLineSnapshot } = require('./po-lines-mapper');
const { buildPoLineUpsertRow, EXISTING_LOAD_COLUMNS } = require('./po-lines-merge');
const { loadAsnReceivedByPoLine } = require('./po-lines-qty');
const { closeStaleOpenPoLines, upsertInBatches } = require('./reconcile');

async function loadExistingLines(tx, poNumbers) {
    if (!poNumbers.length) {
        return new Map();
    }

    const existingLines = await tx.run(
        SELECT.from('ict.po_lines')
            .columns(...EXISTING_LOAD_COLUMNS)
            .where({ po_number: { in: poNumbers } })
    );

    return new Map(existingLines.map(line => [`${line.po_number}-${line.line_item}`, line]));
}

async function upsertPoLinePage(pageRows, runTs, stats, upsertBatchSize, entityConfig) {
    const poNumbers = [...new Set(pageRows.map(it => it.PurchaseOrder))];

    await cds.tx(async tx => {
        const existingMap = await loadExistingLines(tx, poNumbers);
        const asnReceivedByLine = await loadAsnReceivedByPoLine(tx, poNumbers);
        const upsertRows = [];

        for (const s4Item of pageRows) {
            const incoming = mapSapPoLineSnapshot(s4Item, entityConfig);
            const plan = buildPoLineUpsertRow(
                existingMap.get(`${incoming.po_number}-${incoming.line_item}`),
                incoming,
                runTs,
                { asnReceivedByLine }
            );

            if (plan.skip) {
                stats.skipped += 1;
                stats.warnings += 1;
                continue;
            }

            if (plan.op === 'insert') {
                stats.created += 1;
            } else if (plan.op === 'update') {
                stats.updated += 1;
            } else {
                stats.unchanged += 1;
            }

            upsertRows.push(plan.row);
        }

        if (upsertRows.length) {
            await upsertInBatches(tx, 'ict.po_lines', upsertRows, upsertBatchSize);
            stats.upserted += upsertRows.length;
        }
    });
}

async function syncPoLines(runTs, { log, onProgress, meta } = {}) {
    const config = loadConfig();
    const dateScope = meta?.dateScope;
    const entityConfig = loadPoLinesEntityConfig(dateScope);

    const stats = {
        upserted: 0,
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        closed: 0,
        warnings: 0,
        pages: 0
    };

    log?.info(
        `Starting PO line sync (${syncModeLabel(config)}, page size: ${config.pageSize}, `
        + `date scope: ${dateScope.label})...`
    );

    await fetchInPages(entityConfig.odataPath, async (pageRows, pageMeta) => {
        if (!pageRows?.length) {
            return;
        }

        stats.pages += 1;
        log?.info(`Page ${pageMeta.pageIndex}: upserting ${pageRows.length} PO line(s)...`);

        await upsertPoLinePage(pageRows, runTs, stats, config.upsertBatchSize, entityConfig);

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
    });

    if (config.reconcileEnabled) {
        await cds.tx(async tx => {
            stats.closed = await closeStaleOpenPoLines(tx, runTs);
        });
    }

    log?.info(
        `PO line sync complete — pages: ${stats.pages}, upserted: ${stats.upserted}, closed: ${stats.closed}.`
    );

    return stats;
}

async function countOpenPoLines({ dateScope } = {}) {
    return proxyGetCount(loadPoLinesEntityConfig(dateScope).countPath);
}

module.exports = { syncPoLines, countOpenPoLines };

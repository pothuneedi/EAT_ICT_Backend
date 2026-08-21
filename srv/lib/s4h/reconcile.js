'use strict';

const { poLineKeyFilter } = require('../po-line-key-filter');

function whereNotSyncedThisRun(runTs) {
    return ['last_synced_at is null or last_synced_at <', runTs];
}

function affectedRows(result) {
    return typeof result === 'number' ? result : (result || 0);
}

async function deleteExceptionsForLines(tx, lines, chunkSize = 200) {
    for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize);
        await tx.run(
            DELETE.from('ict.exceptions').where(poLineKeyFilter(chunk))
        );
    }
}

/**
 * Close OPEN po_lines not returned by S/4 in this run (watermark reconcile).
 * Removes exceptions for those lines first — they are no longer actionable.
 */
async function closeStaleOpenPoLines(tx, runTs) {
    const [predicate, value] = whereNotSyncedThisRun(runTs);
    const staleLines = await tx.run(
        SELECT.from('ict.po_lines')
            .columns('po_number', 'line_item')
            .where({ po_status: 'OPEN' })
            .and(predicate, value)
    );

    if (!staleLines.length) {
        return 0;
    }

    await deleteExceptionsForLines(tx, staleLines);

    return affectedRows(await tx.run(
        UPDATE('ict.po_lines')
            .set({ po_status: 'CLOSED' })
            .where({ po_status: 'OPEN' })
            .and(predicate, value)
    ));
}

async function deactivateStaleMasterRows(tx, entity, runTs) {
    const [predicate, value] = whereNotSyncedThisRun(runTs);
    return affectedRows(await tx.run(
        UPDATE(entity).set({ is_active: false }).where(predicate, value)
    ));
}

async function upsertInBatches(tx, entity, rows, batchSize) {
    if (!rows.length) {
        return 0;
    }

    let total = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        await tx.run(UPSERT.into(entity).entries(chunk));
        total += chunk.length;
    }
    return total;
}

async function deleteStaleInPoChunks(tx, { entity, poField, poNumbers, runTs, inChunkSize = 200 }) {
    if (!poNumbers.length) {
        return 0;
    }

    const [predicate, value] = whereNotSyncedThisRun(runTs);
    let totalDeleted = 0;

    for (let i = 0; i < poNumbers.length; i += inChunkSize) {
        const chunk = poNumbers.slice(i, i + inChunkSize);
        const result = await tx.run(
            DELETE.from(entity)
                .where({ [poField]: { in: chunk } })
                .and(predicate, value)
        );
        totalDeleted += affectedRows(result);
    }

    return totalDeleted;
}

function deleteStaleAsnInOpenPoScope(tx, runTs, poNumbers, options) {
    return deleteStaleInPoChunks(tx, {
        entity: 'ict.asn_ibd',
        poField: 'reference_document',
        poNumbers,
        runTs,
        ...options
    });
}

function deleteStaleIdocErrorsInOpenPoScope(tx, runTs, poNumbers, options) {
    return deleteStaleInPoChunks(tx, {
        entity: 'ict.edi856_idoc_errors',
        poField: 'po_number',
        poNumbers,
        runTs,
        ...options
    });
}

function deleteStalePoPartnersInOpenPoScope(tx, runTs, poNumbers, options) {
    return deleteStaleInPoChunks(tx, {
        entity: 'ict.po_partners',
        poField: 'po_number',
        poNumbers,
        runTs,
        ...options
    });
}

module.exports = {
    closeStaleOpenPoLines,
    upsertInBatches,
    deactivateStaleMasterRows,
    deleteStaleAsnInOpenPoScope,
    deleteStaleIdocErrorsInOpenPoScope,
    deleteStalePoPartnersInOpenPoScope
};

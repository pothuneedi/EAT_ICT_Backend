'use strict';

const { isStrictTrue } = require('../sap-boolean');

/** SAP inbound delivery goods movement status when GR is posted. */
const GR_POSTED_MOVEMENT_STATUS = 'C';

function poLineKey(poNumber, lineItem) {
    return `${poNumber}-${lineItem}`;
}

function toQty(value) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) {
        return 0;
    }
    return Number(n.toFixed(3));
}

function isGrPostedMovement(status) {
    return String(status || '').trim() === GR_POSTED_MOVEMENT_STATUS;
}

/**
 * received_qty_so_far = sum of ASN actual_delivery_qty.
 * gr_qty = same sum, but only rows with goods_movement_status 'C' (GR posted).
 * open_qty = po_qty - gr_qty.
 */
function resolvePoLineQuantities(poQty, { openQty, asnQuantities, existing } = {}) {
    const qty = toQty(poQty);

    if (asnQuantities != null) {
        const received = Math.max(0, toQty(asnQuantities.received_qty_so_far));
        const grQty = Math.max(0, toQty(asnQuantities.gr_qty));
        return {
            received_qty_so_far: received,
            gr_qty: grQty,
            open_qty: Math.max(0, toQty(qty - grQty))
        };
    }

    if (openQty != null) {
        const received = Math.max(0, toQty(qty - toQty(openQty)));
        return {
            received_qty_so_far: received,
            gr_qty: 0,
            open_qty: Math.max(0, qty)
        };
    }

    const received = toQty(existing?.received_qty_so_far);
    const grQty = toQty(existing?.gr_qty);
    return {
        received_qty_so_far: received,
        gr_qty: grQty,
        open_qty: Math.max(0, toQty(qty - grQty))
    };
}

async function loadAsnQuantitiesByPoLine(tx, poNumbers) {
    if (!poNumbers?.length) {
        return new Map();
    }

    const rows = await tx.run(
        SELECT.from('ict.asn_ibd')
            .columns(
                'reference_document',
                'reference_item',
                'actual_delivery_qty',
                'goods_movement_status'
            )
            .where({ reference_document: { in: poNumbers } })
    );

    const byLine = new Map();
    for (const row of rows) {
        if (!row.reference_document || row.reference_item == null || row.reference_item === '') {
            continue;
        }
        const key = poLineKey(row.reference_document, row.reference_item);
        const entry = byLine.get(key) || { received_qty_so_far: 0, gr_qty: 0 };
        const lineQty = toQty(row.actual_delivery_qty ?? 0);
        entry.received_qty_so_far = toQty(entry.received_qty_so_far + lineQty);
        if (isGrPostedMovement(row.goods_movement_status)) {
            entry.gr_qty = toQty(entry.gr_qty + lineQty);
        }
        byLine.set(key, entry);
    }

    return byLine;
}

/** Cumulative actual_delivery_qty per PO line; first ASN row kept for status/BOL fields. */
function summarizeAsnByPoLine(asnRows) {
    const byLine = {};
    for (const row of asnRows || []) {
        if (!row.reference_document || row.reference_item == null || row.reference_item === '') {
            continue;
        }
        const key = `${row.reference_document}_${row.reference_item}`;
        const qty = toQty(row.actual_delivery_qty ?? 0);
        if (!byLine[key]) {
            byLine[key] = { ...row, received_qty_so_far: qty };
        } else {
            byLine[key].received_qty_so_far = toQty(byLine[key].received_qty_so_far + qty);
        }
    }
    return byLine;
}

async function refreshPoLineQuantitiesFromAsn(tx, poNumbers, runTs) {
    if (!poNumbers?.length) {
        return 0;
    }

    const poLines = await tx.run(
        SELECT.from('ict.po_lines')
            .columns('po_number', 'line_item', 'po_qty', 'open_qty', 'received_qty_so_far', 'gr_qty', 'ai_processed', 'ai_processed_at')
            .where({ po_number: { in: poNumbers }, po_status: 'OPEN' })
    );

    if (!poLines.length) {
        return 0;
    }

    const asnQuantitiesByLine = await loadAsnQuantitiesByPoLine(tx, poNumbers);
    let updated = 0;

    for (const line of poLines) {
        const asnQuantities = asnQuantitiesByLine.get(poLineKey(line.po_number, line.line_item));
        if (asnQuantities == null) {
            continue;
        }

        const quantities = resolvePoLineQuantities(line.po_qty, { asnQuantities, existing: line });
        if (toQty(line.open_qty) === quantities.open_qty
            && toQty(line.received_qty_so_far) === quantities.received_qty_so_far
            && toQty(line.gr_qty) === quantities.gr_qty) {
            continue;
        }

        const patch = { ...quantities, last_synced_at: runTs };
        if (isStrictTrue(line.ai_processed) || line.ai_processed_at) {
            patch.ai_reanalysis_needed = true;
            patch.ai_processed = false;
        }

        await tx.run(UPDATE('ict.po_lines').set(patch).where({
            po_number: line.po_number,
            line_item: line.line_item
        }));
        updated += 1;
    }

    return updated;
}

module.exports = {
    GR_POSTED_MOVEMENT_STATUS,
    poLineKey,
    toQty,
    isGrPostedMovement,
    resolvePoLineQuantities,
    loadAsnQuantitiesByPoLine,
    loadAsnReceivedByPoLine: loadAsnQuantitiesByPoLine,
    summarizeAsnByPoLine,
    refreshPoLineQuantitiesFromAsn
};

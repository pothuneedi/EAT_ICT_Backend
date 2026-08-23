'use strict';

const { poLineKey, toQty, resolvePoLineQuantities } = require('./po-lines-qty');
const { parseODataTimestamp } = require('./date-utils');
const { isStrictTrue } = require('../sap-boolean');

/** S/4 snapshot fields — not open_qty/gr_qty (those are ASN-derived; see hasQuantityChanged). */
const SAP_COMPARABLE_FIELDS = [
    'material_id', 'plant', 'material_group',
    'po_qty', 'po_uom', 'net_price',
    'supplier_id', 'doc_type', 'currency',
    'doc_date', 'created_on', 'created_by',
    'company_code', 'purch_group',
    'delivery_date', 'ship_date', 'is_intracompany_transfer'
];

const QTY_COMPARABLE_FIELDS = ['open_qty', 'received_qty_so_far', 'gr_qty'];

const DATE_FIELDS = new Set(['doc_date', 'created_on', 'delivery_date', 'ship_date']);
/** Null/blank OData values are retained from DB on update — compare and persist effective values. */
const NULLABLE_FALLBACK_FIELDS = new Set(['po_uom', 'currency', 'created_by', 'ship_date']);

function normalizeComparable(field, value) {
    if (value == null || value === '') {
        return null;
    }
    if (DATE_FIELDS.has(field)) {
        return parseODataTimestamp(value) || null;
    }
    if (field === 'po_qty' || field === 'net_price') {
        const digits = field === 'net_price' ? 2 : 3;
        return Number(parseFloat(value).toFixed(digits));
    }
    if (field === 'is_intracompany_transfer') {
        return isStrictTrue(value);
    }
    return String(value);
}

function effectiveValue(field, value, existing) {
    if (NULLABLE_FALLBACK_FIELDS.has(field) && (value == null || value === '')) {
        return existing?.[field];
    }
    return value;
}

function hasSapDataChanged(existing, incoming) {
    if (!existing) {
        return true;
    }
    return SAP_COMPARABLE_FIELDS.some(field =>
        normalizeComparable(field, existing[field])
        !== normalizeComparable(field, effectiveValue(field, incoming[field], existing))
    );
}

function hasQuantityChanged(existing, quantities) {
    return QTY_COMPARABLE_FIELDS.some(field =>
        toQty(existing[field]) !== toQty(quantities[field])
    );
}

function hadPriorAnalysis(existing) {
    return isStrictTrue(existing?.ai_processed) || !!existing?.ai_processed_at;
}

function reanalysisFlags(existing, changed) {
    if (!changed || !hadPriorAnalysis(existing)) {
        return {};
    }
    return {
        ai_processed: false,
        ai_reanalysis_needed: true
    };
}

function buildEffectiveSapSnapshot(incoming, existing) {
    const { open_qty: _s4OpenQty, ...sap } = incoming;
    for (const field of NULLABLE_FALLBACK_FIELDS) {
        sap[field] = effectiveValue(field, sap[field], existing);
    }
    return sap;
}

function buildPoLineUpsertRow(existing, incoming, runTs, { asnReceivedByLine } = {}) {
    const keys = {
        po_number: incoming.po_number,
        line_item: incoming.line_item
    };

    if (!incoming.delivery_date) {
        return { skip: true, reason: 'missing_delivery_date', keys };
    }

    const quantities = resolvePoLineQuantities(incoming.po_qty, {
        openQty: incoming.open_qty,
        asnQuantities: asnReceivedByLine?.get(poLineKey(incoming.po_number, incoming.line_item)),
        existing
    });

    if (!existing) {
        const { open_qty: _s4OpenQty, ...sapPayload } = incoming;
        const row = {
            ...sapPayload,
            ...quantities,
            po_status: 'OPEN',
            ai_processed: false,
            last_synced_at: runTs
        };
        if (row.po_uom == null) {
            delete row.po_uom;
        }
        if (row.currency == null) {
            delete row.currency;
        }
        return { op: 'insert', row };
    }

    const sapChanged = hasSapDataChanged(existing, incoming);
    const qtyChanged = hasQuantityChanged(existing, quantities);
    const flags = reanalysisFlags(existing, sapChanged || qtyChanged);

    if (!sapChanged) {
        const row = { ...keys, po_status: 'OPEN', last_synced_at: runTs, ...flags };
        if (qtyChanged) {
            Object.assign(row, quantities);
        }
        return { op: 'touch', row };
    }

    return {
        op: 'update',
        row: {
            ...buildEffectiveSapSnapshot(incoming, existing),
            ...quantities,
            po_status: 'OPEN',
            last_synced_at: runTs,
            ...flags
        }
    };
}

const EXISTING_LOAD_COLUMNS = [...new Set([
    'po_number', 'line_item',
    ...SAP_COMPARABLE_FIELDS,
    ...QTY_COMPARABLE_FIELDS,
    'ai_processed', 'ai_processed_at', 'ai_reanalysis_needed', 'po_status'
])];

module.exports = {
    SAP_COMPARABLE_FIELDS,
    QTY_COMPARABLE_FIELDS,
    hasSapDataChanged,
    hasQuantityChanged,
    buildPoLineUpsertRow,
    EXISTING_LOAD_COLUMNS
};

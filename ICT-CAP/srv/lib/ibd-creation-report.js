'use strict';

/* global SELECT */

const { dedupeChrEventsForPo } = require('./chr-events-presentation');
const { normalizeLineItem } = require('./s4h/entities/_shared');

const OPEN_PO_STATUSES = ['OPEN', 'GR_POSTED'];
const IN_TRANSIT_PATTERN = /in\s*transit|picked\s*up|load\s*picked|departed|en\s*route|pickedup|intransit/i;

function poLineKey(poNumber, lineItem) {
    const line = normalizeLineItem(lineItem) || String(lineItem || '').trim();
    return `${String(poNumber || '').trim()}_${line}`;
}

function isChrInTransit(event) {
    const text = String(event?.status || event?.event_type || '').trim();
    return IN_TRANSIT_PATTERN.test(text);
}

function pickChrEta(event) {
    return event?.delivery_by_date || event?.delivery_available_by_date || event?.event_time || null;
}

function pickChrReference(event) {
    return event?.customer_reference_number
        || event?.customer_order_reference
        || event?.order_number
        || event?.navisphere_tracking_number
        || '';
}

function poLinesWithIbd(asnRows) {
    const linesWithIbd = new Set();
    for (const row of asnRows || []) {
        if (!row.reference_document || row.reference_item == null || row.reference_item === '') {
            continue;
        }
        if (row.delivery) {
            linesWithIbd.add(poLineKey(row.reference_document, row.reference_item));
        }
    }
    return linesWithIbd;
}

function indexChrByPo(chrRows) {
    const byPo = {};
    for (const row of chrRows || []) {
        if (!row.po_number) {
            continue;
        }
        (byPo[row.po_number] = byPo[row.po_number] || []).push(row);
    }
    return byPo;
}

function resolveInTransitChr(poNumber, chrByPo) {
    const events = dedupeChrEventsForPo(chrByPo[poNumber]);
    return events.find(isChrInTransit) || null;
}

function applyReportFilters(lines, { plant, search } = {}) {
    let result = lines;

    if (plant && plant !== 'ALL') {
        result = result.filter((row) => row.plant === plant);
    }

    const term = String(search || '').trim().toLowerCase();
    if (term) {
        result = result.filter((row) => [
            row.po_number,
            row.line_item,
            row.supplier_id,
            row.supplier_name,
            row.material_id,
            row.plant,
            row.chr_status,
            row.reference
        ].some((value) => value && String(value).toLowerCase().includes(term)));
    }

    return result;
}

function sortByChrEta(lines) {
    return [...lines].sort((a, b) => {
        const aTime = a.chr_eta ? new Date(a.chr_eta).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.chr_eta ? new Date(b.chr_eta).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
    });
}

function buildIbdCreationLines({ poLines, asnRows, chrRows, suppliers, plants }) {
    const linesWithIbd = poLinesWithIbd(asnRows);
    const chrByPo = indexChrByPo(chrRows);
    const supplierById = Object.fromEntries((suppliers || []).map((s) => [s.supplier, s]));
    const plantByCode = Object.fromEntries((plants || []).map((p) => [p.plant_code, p]));

    const lines = [];
    for (const po of poLines || []) {
        const key = poLineKey(po.po_number, po.line_item);
        if (linesWithIbd.has(key)) {
            continue;
        }

        const chr = resolveInTransitChr(po.po_number, chrByPo);
        if (!chr) {
            continue;
        }

        const supplier = supplierById[po.supplier_id] || null;
        lines.push({
            po_number: po.po_number,
            line_item: po.line_item,
            supplier_id: po.supplier_id || '',
            supplier_name: supplier?.name || '',
            material_id: po.material_id || '',
            plant: po.plant || '',
            plant_name: plantByCode[po.plant]?.plant_name || '',
            po_qty: po.po_qty,
            chr_qty: chr.actual_quantity ?? po.po_qty,
            delivery_date: po.delivery_date || null,
            chr_eta: pickChrEta(chr),
            chr_status: chr.status || chr.event_type || '',
            reference: pickChrReference(chr),
            bill_of_lading: chr.load_number || ''
        });
    }

    return sortByChrEta(lines);
}

async function loadIbdCreationReport(db, filters = {}) {
    const [poLines, asnRows, chrRows, suppliers, plants] = await Promise.all([
        db.run(
            SELECT.from('ict.po_lines')
                .where({ po_status: { in: OPEN_PO_STATUSES } })
        ),
        db.run(SELECT.from('ict.asn_ibd').columns('delivery', 'reference_document', 'reference_item')),
        db.run(
            SELECT.from('ict.chr_events').columns(
                'po_number', 'status', 'event_type', 'event_time',
                'delivery_by_date', 'delivery_available_by_date',
                'actual_quantity', 'customer_reference_number', 'customer_order_reference',
                'order_number', 'navisphere_tracking_number', 'load_number'
            )
        ),
        db.run(SELECT.from('ict.suppliers').columns('supplier', 'name')),
        db.run(SELECT.from('ict.plants').columns('plant_code', 'plant_name'))
    ]);

    const lines = buildIbdCreationLines({ poLines, asnRows, chrRows, suppliers, plants });
    const filtered = applyReportFilters(lines, filters);
    return {
        totalCount: filtered.length,
        lines: filtered
    };
}

module.exports = {
    buildIbdCreationLines,
    loadIbdCreationReport,
    poLineKey
};

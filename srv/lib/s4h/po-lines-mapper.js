'use strict';

const { parseODataTimestamp, compareTimestamps } = require('./date-utils');
const { asResultArray } = require('./odata-utils');
const { normalizeLineItem } = require('./entities/_shared');

function toDecimal(value, fractionDigits = 3) {
    const n = parseFloat(value);
    if (!Number.isFinite(n)) {
        return 0;
    }
    return Number(n.toFixed(fractionDigits));
}

function toPrice(value) {
    return toDecimal(value, 2);
}

function pickEarliestScheduleLine(scheduleLines) {
    return asResultArray(scheduleLines)
        .filter(sl => sl.ScheduleLineDeliveryDate)
        .sort((a, b) => compareTimestamps(a.ScheduleLineDeliveryDate, b.ScheduleLineDeliveryDate))[0] || null;
}

/** Header Supplier; for intracompany (UB) POs S/4 often leaves Supplier blank and sets SupplyingPlant. */
function resolvePoSupplierId(header = {}) {
    const supplier = String(header.Supplier || '').trim();
    if (supplier) {
        return supplier;
    }
    const supplyingPlant = String(header.SupplyingPlant || '').trim();
    return supplyingPlant || null;
}

/**
 * Maps one A_PurchaseOrderItem (+ expands) to the S/4-sourced column snapshot
 * documented in S4HANA_SYNC_ENDPOINTS.md §3.
 */
function mapSapPoLineSnapshot(s4Item, entityConfig) {
    const header = s4Item.to_PurchaseOrder || {};
    const scheduleLine = pickEarliestScheduleLine(s4Item.to_ScheduleLine);

    const poQty = toDecimal(s4Item.OrderQuantity);

    const docDate = parseODataTimestamp(header.PurchaseOrderDate);
    const createdOn = parseODataTimestamp(header.CreationDate);
    const deliveryDate = scheduleLine?.ScheduleLineDeliveryDate
        ? parseODataTimestamp(scheduleLine.ScheduleLineDeliveryDate)
        : (docDate || createdOn);

    const docType = header.PurchaseOrderType || null;

    return {
        po_number: s4Item.PurchaseOrder,
        line_item: normalizeLineItem(s4Item.PurchaseOrderItem),
        material_id: s4Item.Material || null,
        plant: s4Item.Plant || null,
        material_group: s4Item.MaterialGroup || null,
        po_qty: poQty,
        po_uom: s4Item.PurchaseOrderQuantityUnit || null,
        net_price: toPrice(s4Item.NetPriceAmount),
        supplier_id: resolvePoSupplierId(header),
        doc_type: docType,
        currency: s4Item.DocumentCurrency || header.DocumentCurrency || null,
        doc_date: docDate,
        created_on: createdOn,
        created_by: header.CreatedByUser || null,
        company_code: header.CompanyCode || null,
        purch_group: header.PurchasingGroup || null,
        delivery_date: deliveryDate,
        ship_date: parseODataTimestamp(s4Item.ZZ1_ShipDate_PDI),
        open_qty: scheduleLine?.OpenPurchaseOrderQuantity != null
            ? toDecimal(scheduleLine.OpenPurchaseOrderQuantity)
            : null,
        is_intracompany_transfer: docType
            ? entityConfig.intracompanyDocTypes.includes(docType)
            : false
    };
}

module.exports = {
    mapSapPoLineSnapshot,
    pickEarliestScheduleLine,
    resolvePoSupplierId,
    toDecimal,
    toPrice
};

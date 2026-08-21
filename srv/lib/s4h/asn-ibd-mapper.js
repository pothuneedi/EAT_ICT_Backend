'use strict';

const { parseODataTimestamp, parseODataTime, combineDateAndTime } = require('./date-utils');
const { normalizeLineItem } = require('./entities/_shared');

function resolvePoReference(item) {
    return item.ReferenceSDDocument || item.PurchaseOrder || null;
}

function resolvePoItemReference(item) {
    return item.ReferenceSDDocumentItem || item.PurchaseOrderItem || null;
}

/** Maps A_InbDeliveryItem + A_InbDeliveryHeader → ict.asn_ibd. */
function mapIbdItem(item, runTs, header) {
    if (!item?.DeliveryDocument || item.DeliveryDocumentItem == null || item.DeliveryDocumentItem === '') {
        return null;
    }

    const referenceDocument = resolvePoReference(item);
    const referenceItem = resolvePoItemReference(item);
    if (!referenceDocument || referenceItem == null || referenceItem === '') {
        return null;
    }

    const deliveryItem = String(item.DeliveryDocumentItem).trim();

    return {
        delivery: item.DeliveryDocument,
        item: deliveryItem,
        delivery_item: deliveryItem,
        item_category: item.DeliveryDocumentItemCategory || null,
        material: item.Material || null,
        material_group: item.MaterialGroup || null,
        plant: item.Plant || null,
        storage_location: item.StorageLocation || null,
        delivery_quantity: item.OriginalDeliveryQuantity ?? item.DeliveryQuantity ?? null,
        base_unit_of_measure: item.BaseUnit || item.DeliveryQuantityUnit || null,
        actual_delivery_qty: item.ActualDeliveryQuantity ?? null,
        item_description: item.DeliveryDocumentItemText || null,
        reference_document: referenceDocument,
        reference_item: normalizeLineItem(referenceItem),
        movement_type: item.GoodsMovementType || null,
        goods_movement_status: item.GoodsMovementStatus || null,
        created_by: header?.CreatedByUser || null,
        time: parseODataTime(header?.CreationTime),
        created_on: combineDateAndTime(header?.CreationDate, header?.CreationTime),
        overall_status: header?.OverallSDProcessStatus || header?.OverallGoodsMovementStatus || null,
        shipping_point_receiving_pt: header?.ReceivingPlant || null,
        delivery_type: header?.DeliveryDocumentType || null,
        delivery_date: parseODataTimestamp(header?.DeliveryDate),
        document_date: parseODataTimestamp(header?.DocumentDate),
        act_goods_movement_date: parseODataTimestamp(header?.ActualGoodsMovementDate),
        bill_of_lading: header?.BillOfLading || null,
        incoterms: header?.IncotermsClassification || null,
        supplier: header?.Supplier || null,
        external_delivery_id: header?.DeliveryDocumentBySupplier || header?.ExternalDeliveryID || null,
        last_synced_at: runTs
    };
}

module.exports = { mapIbdItem };

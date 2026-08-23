'use strict';

const {
    splitCsv,
    buildODataBasePath,
    buildODataQuery,
    buildODataCountPath,
    escapeODataString
} = require('./_shared');

/**
 * Exactly the A_InbDeliveryItem fields asn-ibd-mapper.js reads — nothing more.
 *
 * This is a correctness guard, not a payload optimisation. A_InbDeliveryItem
 * exposes date fields this sync never uses, and a single corrupt value in one of
 * them (spaces rather than 00000000 in ManufactureDate on delivery 180035447 /
 * PO 4500016335) makes SAP's serialiser raise CX_SY_CONVERSION_NO_DATE_TIME and
 * abandon the entire response — taking every other PO in the same $filter with
 * it. Requesting only what we map keeps such records readable.
 *
 * Overridable via S4H_ASN_ITEM_SELECT (comma-separated) so a field can be added
 * or dropped without a deploy. Note that an unknown field name here is a hard
 * OData error, not a silent undefined — verify any change in Postman first.
 */
const ITEM_SELECT_FIELDS = [
    'DeliveryDocument',
    'DeliveryDocumentItem',
    'DeliveryDocumentItemCategory',
    'DeliveryDocumentItemText',
    'Material',
    'MaterialGroup',
    'Plant',
    'StorageLocation',
    // No 'DeliveryQuantity': it is not a property of A_InbDeliveryItem. The
    // mapper reads it as a fallback, so it has always resolved to undefined —
    // harmless there, but a hard 400 if named in $select.
    'OriginalDeliveryQuantity',
    'ActualDeliveryQuantity',
    'DeliveryQuantityUnit',
    'BaseUnit',
    'GoodsMovementType',
    'GoodsMovementStatus',
    'ReferenceSDDocument',
    'ReferenceSDDocumentItem'
    // No 'PurchaseOrder' / 'PurchaseOrderItem': verified against S/4, they are
    // not properties of A_InbDeliveryItem (naming them returns 404). The mapper
    // reads them only as fallbacks behind ReferenceSDDocument(Item), so they
    // have always resolved to undefined.
];

/**
 * Exactly the A_InbDeliveryHeader fields asn-ibd-mapper.js reads.
 *
 * The header carries fifteen date/time properties; the Inbound Control Tower
 * displays four dates, one time and the changed-by/on pair. Every unrequested
 * one is a ManufactureDate waiting to happen — a corrupt value in a column we
 * never show would abort the header fetch exactly as it did for items.
 *
 * Deliberately NOT requested: BillingDocumentDate, IntercompanyBillingDate,
 * LoadingDate, PickingDate, PlannedGoodsIssueDate, ProofOfDeliveryDate,
 * TransportationPlanningDate, and the matching *Time properties.
 *
 * Every name here is verified against the A_InbDeliveryHeaderType metadata.
 * Note ExternalDeliveryID is absent from that entity type — the mapper's
 * fallback to it has never resolved; DeliveryDocumentBySupplier is the real
 * "Ext. Delivery" field.
 */
const HEADER_SELECT_FIELDS = [
    'DeliveryDocument',
    // displayed dates / times
    'DeliveryDate',
    'DocumentDate',
    'ActualGoodsMovementDate',
    'CreationDate',
    'CreationTime',
    'LastChangeDate',
    'CreatedByUser',
    'LastChangedByUser',
    // non-date attributes the mapper stores
    'OverallSDProcessStatus',
    'OverallGoodsMovementStatus',
    'ReceivingPlant',
    'DeliveryDocumentType',
    'BillOfLading',
    'IncotermsClassification',
    'Supplier',
    'DeliveryDocumentBySupplier'
];

function parsePositiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadAsnIbdEntityConfig() {
    const service = process.env.S4H_ASN_SERVICE || 'API_INBOUND_DELIVERY_SRV';

    return {
        service,
        poRefField: process.env.S4H_ASN_PO_REF_FIELD || 'ReferenceSDDocument',
        poBatchSize: parsePositiveInt(process.env.S4H_ASN_PO_BATCH_SIZE, 40),
        headerBatchSize: parsePositiveInt(process.env.S4H_ASN_HEADER_BATCH_SIZE, 40),
        itemSelect: splitCsv(process.env.S4H_ASN_ITEM_SELECT || ITEM_SELECT_FIELDS.join(',')),
        headerSelect: splitCsv(process.env.S4H_ASN_HEADER_SELECT || HEADER_SELECT_FIELDS.join(',')),
        cdsEntity: 'ict.asn_ibd',
        itemBasePath: buildODataBasePath(service, process.env.S4H_ASN_ITEM_ENTITY_SET || 'A_InbDeliveryItem'),
        headerBasePath: buildODataBasePath(service, process.env.S4H_ASN_HEADER_ENTITY_SET || 'A_InbDeliveryHeader')
    };
}

function buildPoReferenceFilter(poNumbers, poRefField) {
    return poNumbers
        .map(po => `${poRefField} eq '${escapeODataString(po)}'`)
        .join(' or ');
}

function buildItemFilter(entityConfig, poNumbers) {
    return `(${buildPoReferenceFilter(poNumbers, entityConfig.poRefField)})`;
}

function buildItemPathForPoBatch(entityConfig, poNumbers) {
    return `${entityConfig.itemBasePath}${buildODataQuery({
        filter: buildItemFilter(entityConfig, poNumbers),
        select: entityConfig.itemSelect
    })}`;
}

function buildHeaderPathForDeliveryBatch(entityConfig, deliveryNumbers) {
    const filter = deliveryNumbers
        .map(d => `DeliveryDocument eq '${escapeODataString(d)}'`)
        .join(' or ');
    return `${entityConfig.headerBasePath}${buildODataQuery({
        filter: `(${filter})`,
        select: entityConfig.headerSelect
    })}`;
}

function buildCountPathForPoBatch(entityConfig, poNumbers) {
    return buildODataCountPath(entityConfig.itemBasePath, buildItemFilter(entityConfig, poNumbers));
}

module.exports = {
    loadAsnIbdEntityConfig,
    buildItemPathForPoBatch,
    buildCountPathForPoBatch,
    buildHeaderPathForDeliveryBatch
};

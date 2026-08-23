'use strict';

const crypto = require('crypto');
const cds = require('@sap/cds');
const { parseODataTimestamp } = require('./date-utils');
const { sapDecimal } = require('./entities/_shared');

/** Column lengths of ict.chr_events — CHR is free text, Postgres errors rather than truncating. */
const LIMITS = {
    po_number: 50,
    event_type: 50,
    status: 50,
    customer_reference_number: 50,
    bill_to_reference_number: 200,
    navisphere_tracking_number: 30,
    navisphere_tracking_link: 500,
    order_number: 20,
    customer_order_reference: 50,
    load_number: 20,
    location_name: 100,
    location_contact_name: 100,
    location_contact_phone: 30,
    location_contact_email: 100,
    description: 255,
    sku_number: 30,
    freight_class: 10,
    actual_weight_uom: 20,
    actual_volume_uom: 20
};

/** Clamp string columns in place so one oversized source value can't abort the whole batch. */
function clampRow(row, onTruncate) {
    for (const [field, max] of Object.entries(LIMITS)) {
        const value = row[field];
        if (typeof value === 'string' && value.length > max) {
            row[field] = value.slice(0, max);
            onTruncate?.(field, value.length, max);
        }
    }
    return row;
}

function firstOrderDetail(event) {
    const raw = event?.orderDetails || event?.orderDetail || [];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    return list[0] || {};
}

function resolveLocation(event) {
    if (event?.location) {
        return event.location;
    }

    const stop = event?.stops?.[0];
    if (stop) {
        return stop.location || stop;
    }

    return event?.locations?.[0] || null;
}

function mapChrEventRows(apiEvent, openPoSet = new Set(), onTruncate) {
    if (!apiEvent?.event) {
        return [];
    }

    const event = apiEvent.event;
    const eventType = event.eventType || null;
    const eventTime = parseODataTimestamp(apiEvent.eventTime);
    const orderDetail = firstOrderDetail(event);
    const location = resolveLocation(event);
    const contact = location?.locationContact || {};

    const orderNumber = orderDetail.orderNumber != null ? String(orderDetail.orderNumber) : null;
    const loadNumber = event.loadNumber != null ? String(event.loadNumber) : null;

    const header = {
        event_time: eventTime,
        event_type: eventType,
        status: eventType,
        customer_reference_number: apiEvent.customerReferenceNumber || null,
        bill_to_reference_number: apiEvent.billToReferenceNumber || null,
        navisphere_tracking_number: orderDetail.navisphereTrackingNumber || null,
        navisphere_tracking_link: orderDetail.navisphereTrackingLink || null,
        order_number: orderNumber,
        customer_order_reference: orderDetail.customerOrderReferenceNumber || null,
        load_number: loadNumber,
        delivery_available_by_date: parseODataTimestamp(event.deliveryAvailableByDate),
        delivery_by_date: parseODataTimestamp(event.deliveryByDate),
        location_name: location?.name || null,
        location_contact_name: contact.name || null,
        location_contact_phone: contact.phoneNumber || null,
        location_contact_email: contact.email || null
    };

    const items = Array.isArray(event.items) && event.items.length ? event.items : [];
    const rows = [];

    for (const item of items) {
        const poNumber = item?.poNumber != null && item.poNumber !== ''
            ? String(item.poNumber)
            : null;
        const poLinked = poNumber ? openPoSet.has(poNumber) : false;

        const skuNumber = item?.skuNumber != null ? String(item.skuNumber) : null;
        const sourceHash = crypto.createHash('sha256').update([
            orderNumber || '',
            eventTime || '',
            eventType || '',
            loadNumber || '',
            poNumber || '',
            skuNumber || '',
            item?.description || ''
        ].join('|')).digest('hex');

        // NOTE: source_hash and po_linked above use the raw values, so the dedup key
        // stays stable and PO matching isn't affected by clamping below.
        rows.push(clampRow({
            ID: cds.utils.uuid(),
            po_number: poNumber,
            po_linked: poLinked,
            ...header,
            description: item?.description || null,
            sku_number: skuNumber,
            freight_class: item?.freightClass != null ? String(item.freightClass) : null,
            insurance_value: sapDecimal(item?.insuranceValue),
            actual_quantity: sapDecimal(item?.actualQuantity),
            actual_weight: sapDecimal(item?.actualWeight),
            actual_weight_uom: item?.actualWeightUnitOfMeasure || null,
            actual_pallets: sapDecimal(item?.actualPallets),
            actual_volume: sapDecimal(item?.actualVolume),
            actual_volume_uom: item?.actualVolumeUnitOfMeasure || null,
            source_hash: sourceHash
        }, onTruncate));
    }

    return rows;
}

module.exports = { mapChrEventRows };

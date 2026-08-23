namespace ict;

using { ict.plants, ict.materials, ict.suppliers } from './master-data';

entity po_lines {
    key po_number                : String(10);
    key line_item                : String(10);
        material_id              : String(18); // References materials
        material                 : Association to materials on material.material = material_id;
        supplier_id              : String(10); // References suppliers
        supplier                 : Association to suppliers on supplier.supplier = supplier_id;
        plant                    : String(10); // References plants
        plant_ref                : Association to plants on plant_ref.plant_code = plant;
        doc_type                 : String(10);
        is_intracompany_transfer : Boolean;
        po_qty                   : Decimal(13, 3) not null;
        po_uom                   : String(10) not null default 'EA';
        open_qty                 : Decimal(13, 3);
        received_qty_so_far      : Decimal(13, 3);
        net_price                : Decimal(12, 2);
        currency                 : String(3) default 'USD';
        delivery_date            : Timestamp not null;
        ship_date                : Timestamp; // S/4 A_PurchaseOrderItem.ZZ1_ShipDate_PDI
        doc_date                 : Timestamp;
        created_on               : Timestamp;
        po_status                : String(20) not null default 'OPEN'; // OPEN | GR_POSTED | CLOSED | CANCELLED
        gr_qty                   : Decimal(13, 3) default 0;
        created_by               : String(20);
        company_code             : String(10);
        purch_group              : String(10);
        material_group           : String(10);
        created_at               : Timestamp default $now;
        // AI Processing control — false = needs analysis, true = done. Reset to false on SAP data update.
        ai_processed             : Boolean not null default false;
        ai_processed_at          : Timestamp;
        /** True when sync changed PO data after last analysis — exception may be stale until re-run. */
        ai_reanalysis_needed     : Boolean not null default false;
        asns                     : Association to many asn_ibd on asns.reference_document = po_number and asns.reference_item = line_item;
        po_partners              : Association to many po_partners on po_partners.po_number = po_number;
        carrier_events           : Association to many chr_events on carrier_events.po_number = po_number;
        last_synced_at           : Timestamp;
}

/** S/4 PurchaseOrderPartner — scoped to open POs (OData v4 API_PURCHASEORDER_2). */
entity po_partners {
    key po_number                      : String(10);
    key partner_function               : String(4);
    key partner_counter                : String(4);
        supplier_subrange              : String(10);
        plant                          : String(10);
        purchasing_org                 : String(10);
        created_by                     : String(20);
        created_on                     : Timestamp;
        purchasing_doc_partner_type    : String(4);
        supplier                       : String(10);
        supplier_hierarchy_category    : String(10);
        supplier_contact               : String(10);
        person_work_agreement          : String(20);
        employment_internal_id         : String(20);
        default_partner                : Boolean;
        last_synced_at                 : Timestamp;
}

entity asn_ibd {
    key delivery                      : String(10);
    key item                          : String(10);  // DeliveryDocumentItem — SAP may send 6+ digit forms e.g. 000010
        item_category                 : String(10);
        created_by                    : String(20);
        time                          : Time;
        created_on                    : Timestamp;
        material                      : String(18);
        material_group                : String(10);
        plant                         : String(10);
        storage_location              : String(10);
        delivery_quantity             : Decimal(13, 3);
        base_unit_of_measure          : String(10);
        actual_delivery_qty           : Decimal(13, 3);
        item_description              : String(255);
        reference_document            : String(10);
        reference_item                : String(10);
        movement_type                 : String(10);
        overall_status                : String(10);
        item_1                        : String(10);
        billing_item                  : String(10);
        packing_item                  : String(10);
        picking_putaway_item          : String(10);
        delivery_item                 : String(10);
        goods_mvt_item                : String(10);
        goods_movement_status         : String(10);
        shipping_point_receiving_pt   : String(10);
        delivery_type                 : String(10);
        delivery_date                 : Timestamp;
        incoterms                     : String(10);
        changed_by                    : String(20);
        changed_on                    : String(50);
        bill_of_lading                : String(35);
        supplier                      : String(10);
        document_date                 : Timestamp;
        act_goods_movement_date       : Timestamp;         // was: act_gds_mvmnt_date
        external_delivery_id          : String(50);
        last_synced_at                : Timestamp;
        created_at                    : Timestamp default $now;
}

entity chr_events {
    key ID                          : UUID;                    // surrogate — one row per (event × item)

    // ── Link to our data ──────────────────────────────────────────────
        po_number                   : String(50);              // items[].poNumber → po_lines.po_number (CHR free text, may exceed SAP's 10)
        po_line                     : Association to po_lines on po_line.po_number = po_number;
        po_linked                   : Boolean default false;   // true once matched to a PO line

    // ── Event header (repeats across the event's items) ───────────────
        event_time                  : Timestamp;               // eventTime
        event_type                  : String(50);              // CHR event.eventType
        status                      : String(50);              // same value as event_type
        customer_reference_number   : String(50);              // customerReferenceNumber (nullable)
        bill_to_reference_number    : String(200);             // billToReferenceNumber — comma-sep PO list for the load

    // ── Order details (single per event) ──────────────────────────────
        navisphere_tracking_number  : String(30);              // orderDetails.navisphereTrackingNumber
        navisphere_tracking_link    : String(500);             // orderDetails.navisphereTrackingLink
        order_number                : String(20);              // orderDetails.orderNumber  (CHR order #)
        customer_order_reference    : String(50);              // orderDetails.customerOrderReferenceNumber

    // ── Load & delivery ───────────────────────────────────────────────
        load_number                 : String(20);              // event.loadNumber (BOL for IBD upload)
        delivery_available_by_date  : Timestamp;                    // deliveryAvailableByDate
        delivery_by_date            : Timestamp;                    // deliveryByDate

    // ── Destination location (single per event) ───────────────────────
        location_name               : String(100);             // location.name
        location_contact_name       : String(100);             // location.locationContact.name
        location_contact_phone      : String(30);              // location.locationContact.phoneNumber
        location_contact_email      : String(100);             // location.locationContact.email

    // ── Item (multiple per event) ─────────────────────────────────────
        description                 : String(255);             // items[].description
        sku_number                  : String(30);              // items[].skuNumber
        freight_class               : String(10);              // items[].freightClass
        insurance_value             : Decimal(15, 2);          // items[].insuranceValue
        actual_quantity             : Decimal(13, 3);          // items[].actualQuantity
        actual_weight               : Decimal(13, 3);          // items[].actualWeight
        actual_weight_uom           : String(20);              // items[].actualWeightUnitOfMeasure
        actual_pallets              : Decimal(13, 3);          // items[].actualPallets (CHR may send fractions e.g. 0.5)
        actual_volume               : Decimal(15, 3);          // items[].actualVolume
        actual_volume_uom           : String(20);              // items[].actualVolumeUnitOfMeasure

    // ── Idempotency / audit ───────────────────────────────────────────
        source_hash                 : String(64);              // dedup key (see §2) — unique upsert target
        ingested_at                 : Timestamp default $now;
}

annotate chr_events with {
    po_number   @cds.index;
    source_hash @assert.unique;
}

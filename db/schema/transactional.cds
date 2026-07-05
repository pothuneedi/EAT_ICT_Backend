namespace ict;

using { ict.plants, ict.materials, ict.suppliers } from './master-data';

entity po_lines {
    key po_number                : String(10);
    key line_item                : String(5);
        material_id              : String(18); // References materials
        material                 : Association to materials on material.material = material_id;
        supplier_id              : String(10); // References suppliers
        supplier                 : Association to suppliers on supplier.supplier = supplier_id;
        plant                    : String(10); // References plants
        plant_ref                : Association to plants on plant_ref.plant_code = plant;
        doc_type                 : String(10);
        is_intracompany_transfer : Boolean;
        po_qty                   : Decimal(13, 3) not null;
        po_uom                   : String(3) not null default 'EA';
        open_qty                 : Decimal(13, 3);
        received_qty_so_far      : Decimal(13, 3);
        net_price                : Decimal(12, 2);
        currency                 : String(3) default 'USD';
        delivery_date            : Date not null;
        doc_date                 : Date;
        created_on               : Date;
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
        asns                     : Association to many asn_ibd on asns.reference_document = po_number and asns.reference_item = line_item;
        carrier_events           : Association to many chr_events on carrier_events.po_number = po_number;
}

entity asn_ibd {
    key delivery                      : String(10);  // ASN_IBD_LIKP: Delivery
    key item                          : String(5);   // ASN_IBD_LIKP: Item
        item_category                 : String(10);
        created_by                    : String(20);
        time                          : Time;
        created_on                    : Date;
        material                      : String(18);
        material_group                : String(10);
        plant                         : String(10);
        storage_location              : String(10);
        delivery_quantity             : Decimal(13, 3);
        base_unit_of_measure          : String(3);
        actual_delivery_qty           : Decimal(13, 3);
        item_description              : String(255);
        reference_document            : String(10);   // PO number
        reference_item                : String(5);    // PO line item
        movement_type                 : String(10);
        overall_status                : String(5);
        item_1                        : String(5);
        billing_item                  : String(5);
        packing_item                  : String(5);
        picking_putaway_item          : String(5);
        delivery_item                 : String(5);
        goods_mvt_item                : String(5);
        goods_movement_status         : String(5);    // was: goods_movement_sts
        shipping_point_receiving_pt   : String(10);
        delivery_type                 : String(10);
        delivery_date                 : Date;
        incoterms                     : String(10);
        changed_by                    : String(20);
        changed_on                    : String(50);
        bill_of_lading                : String(35);
        supplier                      : String(10);
        document_date                 : Date;
        act_goods_movement_date       : Date;         // was: act_gds_mvmnt_date
        external_delivery_id          : String(50);
        created_at                    : Timestamp default $now;
}

entity chr_events {
    key event_id          : Integer; // PK (corresponds to serial event_id)
        chr_ref           : String(20) not null;
        po_number         : String(10);
        po_line           : Association to po_lines on po_line.po_number = po_number;
        po_linked         : Boolean;
        primary_reference : String(100);
        status            : String(50) not null; // Created | PickedUp | InTransit | Delivered | Exception
        status_detail     : String(100);
        activity_date     : Date;
        mode              : String(50);
        mode_detail       : String(100);
        pickup_date       : Date;
        origin            : String(100);
        destination       : String(100);
        total_charge_usd  : String(50);
        carrier_code      : String(50);
        bol_chr           : String(35);
        mbol_number       : String(50);
        material_id       : String(500);
        invoice_date      : Date;
        carrier           : String(50);
        dest_plant        : String(10); // References plants
        plant             : Association to plants on plant.plant_code = dest_plant;
        weight_lbs        : Decimal(10, 2);
        freight_class     : String(10);
        tracking_notes    : String(500);
        event_ts          : Timestamp default $now;
}

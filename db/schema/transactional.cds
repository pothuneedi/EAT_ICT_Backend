namespace ict;

using { ict.Plants, ict.Materials, ict.Suppliers } from './master-data';

entity po_lines {
    key po_number                : String(10);
    key line_item                : String(5);
        material_id              : String(18); // References Materials
        material                 : Association to Materials on material.Material = material_id;
        supplier_id              : String(10); // References Suppliers
        supplier                 : Association to Suppliers on supplier.Supplier = supplier_id;
        plant                    : String(10); // References Plants
        plant_ref                : Association to Plants on plant_ref.plant_code = plant;
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
        asns                     : Association to many asn_ibd on asns.Reference_Document = po_number and asns.Reference_Item = line_item;
        carrier_events           : Association to many CHR_Events on carrier_events.po_number = po_number;
}

entity asn_ibd {
    key Delivery                      : String(10);  // ASN_IBD_LIKP: Delivery
    key Item                          : String(5);   // ASN_IBD_LIKP: Item
        Item_Category                 : String(10);
        Created_By                    : String(20);
        Time                          : Time;
        Created_On                    : Date;
        Material                      : String(18);
        Material_Group                : String(10);
        Plant                         : String(10);
        Storage_Location              : String(10);
        Delivery_Quantity             : Decimal(13, 3);
        Base_Unit_of_Measure          : String(3);
        Actual_delivery_qty           : Decimal(13, 3);
        Item_Description              : String(255);
        Reference_Document            : String(10);   // PO number
        Reference_Item                : String(5);    // PO line item
        Movement_Type                 : String(10);
        Overall_Status                : String(5);
        Item_1                        : String(5);
        Billing___Item                : String(5);
        Packing___Item                : String(5);
        Picking_Putaway___Item        : String(5);
        Delivery___Item               : String(5);
        Goods_Mvt___Item              : String(5);
        Goods_Movement_Sts            : String(5);
        Shipping_Point_Receiving_Pt   : String(10);
        Delivery_Type                 : String(10);
        Delivery_Date                 : Date;
        Incoterms                     : String(10);
        Changed_By                    : String(20);
        Changed_On                    : String(50);
        Bill_of_Lading                : String(35);
        Supplier                      : String(10);
        Document_Date                 : Date;
        Act__Gds_Mvmnt_Date           : Date;
        External_Delivery_ID          : String(50);
        created_at                    : Timestamp default $now;
}

entity CHR_Events {
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
        dest_plant        : String(10); // References Plants
        plant             : Association to Plants on plant.plant_code = dest_plant;
        weight_lbs        : Decimal(10, 2);
        freight_class     : String(10);
        tracking_notes    : String(500);
        event_ts          : Timestamp default $now;
}


namespace ict;

using { ict.Plants, ict.Materials, ict.Suppliers } from './master-data';

entity po_lines {
    key po_number                : String(10);
    key line_item                : String(5);
        material_id              : String(18); // References Materials
        material                 : Association to Materials on material.material_id = material_id;
        supplier_id              : String(10); // References Suppliers
        supplier                 : Association to Suppliers on supplier.supplier_id = supplier_id;
        plant                    : String(10); // References Plants
        plant_ref                : Association to Plants on plant_ref.plant_id = plant;
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
}

entity asn_ibd {
    key ibd_number       : String(10);
    key ibd_item         : String(5);
        po_number        : String(10) not null;
        line_item        : String(5) not null;
        po_line          : Association to po_lines on po_line.po_number = po_number and po_line.line_item = line_item;
        material_id      : String(18);
        material_group   : String(10);
        supplier_id      : String(10); // References Suppliers
        supplier         : Association to Suppliers on supplier.supplier_id = supplier_id;
        asn_ref          : String(20); // Supplier's ASN reference
        bol_number       : String(35); // BOL from 856 ASN
        ship_to_plant    : String(10); // References Plants
        plant            : Association to Plants on plant.plant_id = ship_to_plant;
        asn_qty          : Decimal(13, 3);
        asn_uom          : String(3) default 'EA';
        asn_status       : String(20) not null; // Received | Pending | Error | IDOC_Error | In_Transit | No_ASN
        idoc_number      : String(16);
        idoc_status      : String(20); // Posted | Error | Pending
        idoc_error_msg   : String(500);
        shipment_leg     : Integer default 1;
        total_legs       : Integer default 1;
        delivery_date    : Date;
        doc_date         : Date;
        created_on       : Date;
        goods_issue_date : String(20);
        item_category    : String(10);
        received_at      : Timestamp;
        posted_at        : Timestamp;
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
        plant             : Association to Plants on plant.plant_id = dest_plant;
        weight_lbs        : Decimal(10, 2);
        freight_class     : String(10);
        tracking_notes    : String(500);
        event_ts          : Timestamp default $now;
}


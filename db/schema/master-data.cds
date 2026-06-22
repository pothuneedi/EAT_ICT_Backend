namespace ict;

entity Plants {
    key plant_id     : String(10);
        plant_name   : String(100) not null;
        city         : String(50);
        state_region : String(50);
        country      : String(100) not null default 'USA';
        timezone     : String(50);
        company_code : String(10);
        po_lines_received_here : Integer;
        created_at   : Timestamp default $now;
}

entity Materials {
    key material_id    : String(18);
        description    : String(255) not null;
        material_group : String(10);
        base_uom       : String(3) not null default 'EA';
        weight_kg      : Decimal(10, 3);
        po_line_count  : Integer;
        total_po_qty   : Decimal(13, 3);
        created_at     : Timestamp default $now;
}

entity Suppliers {
    key supplier_id   : String(10);
        supplier_name : String(100) not null;
        country       : String(100);
        city          : String(50);
        contact_email : String(100);
        contact_phone : String(30);
        edi_capable   : Boolean default true;
        po_line_count : Integer;
        first_po_date : Date;
        last_po_date  : Date;
        created_at    : Timestamp default $now;
}

namespace ict;

using { ict.po_lines, ict.asn_ibd } from './transactional';

entity ICT_Exceptions {
    key exception_id    : Integer; // PK (corresponds to serial exception_id)
        po_number       : String(10) not null;
        line_item       : String(5) not null;
        po_line         : Association to po_lines on po_line.po_number = po_number and po_line.line_item = line_item;
        material_id     : String(18);
        supplier_id     : String(10);
        supplier_name   : String(100);
        plant           : String(10);
        po_qty          : Decimal(13, 3);
        open_qty        : Decimal(13, 3);
        delivery_date   : Date;
        ibd_qty         : Decimal(13, 3);
        chr_status      : String(50);
        exception_type  : String(50) not null; // Exception rule classification
        rule            : Association to ExceptionRules on rule.exception_type = exception_type;
        priority        : String(50) not null; // High | Medium | Low
        priority_score  : Integer not null;
        panel           : String(50) not null; // ACTION_REQUIRED | STATUS_REPORT
        recommendation  : LargeString;
        evidence        : LargeString;
        confidence      : Decimal(3, 2);
        source_hash     : String(64);
        classified_at   : Timestamp default $now;
        resolved_by     : String(50);
        resolved_at     : Timestamp;
        resolution_note : String(500);
}

entity ExceptionTypes {
    key code        : String(50);
        name        : String(100);
        priority    : String(50);
        score       : Integer;
}

entity ExceptionRules {
    key exception_type            : String(50);
        priority                  : String(50) not null;
        score                     : Integer not null;
        trigger_condition         : String(500) not null;
        ai_recommendation_pattern : String(500) not null;
        panel                     : String(50) not null;
}


namespace ict;

using { cuid } from '@sap/cds/common';
using { ict.po_lines, ict.asn_ibd, ict.chr_events } from './transactional';

entity exceptions {
    key exception_id    : Integer;
        po_number       : String(10) not null;
        line_item       : String(10) not null;
        po_line         : Association to po_lines on po_line.po_number = po_number and po_line.line_item = line_item;
        // Direct associations — avoids 3-hop OData navigation which CDS does not support
        asns            : Association to many asn_ibd on asns.reference_document = po_number and asns.reference_item = line_item;
        carrier_events  : Association to many chr_events on carrier_events.po_number = po_number;
        material_id     : String(18);
        supplier_id     : String(10);
        supplier_name   : String(100);
        plant           : String(10);
        po_qty          : Decimal(13, 3);
        open_qty        : Decimal(13, 3);
        delivery_date   : Timestamp;
        ibd_qty         : Decimal(13, 3);
        chr_status      : String(50);
        exception_type  : String(50) not null;
        rule            : Association to exception_rules on rule.exception_type = exception_type;
        priority        : String(50) not null;
        priority_score  : Integer not null;
        panel           : String(50) not null;
        recommendation  : LargeString;
        evidence        : LargeString;
        confidence      : Decimal(3, 2);
        source_hash     : String(64);
        classified_at   : Timestamp default $now;
        resolved_by     : String(50);
        resolved_at     : Timestamp;
        resolution_note : String(500);
}

/**
 * AI Feedback — append-only log of user ratings on AI classifications.
 * Each row snapshots WHAT was rated (exception_type + recommendation at that
 * moment), because reprocessing overwrites the exceptions row. The latest row
 * per exception_id is the "current" feedback; the full history feeds
 * improvement analytics (e.g. thumbs-down rate per exception type over time).
 */
entity ai_feedback : cuid {
    exception_id   : Integer not null;
    exception      : Association to exceptions on exception.exception_id = exception_id;
    po_number      : String(10);          // snapshot (server-filled)
    line_item      : String(10);           // snapshot (server-filled)
    exception_type : String(50);          // snapshot (server-filled)
    recommendation : LargeString;         // snapshot of the rated recommendation (server-filled)
    rating         : String(20) not null; // HELPFUL | NOT_HELPFUL
    comment        : String(1000);        // optional free-text improvement note
    created_at     : Timestamp default $now;
    created_by     : String(100);         // user id (server-filled)
}

annotate ai_feedback with {
    exception_id @cds.index;
    created_at @cds.index;
}

entity exception_types {
    key code     : String(50);
        name     : String(100);
        priority : String(50);
        score    : Integer;
}

entity exception_rules {
    key exception_type            : String(50);
        priority                  : String(50) not null;
        score                     : Integer not null;
        trigger_condition         : String(500) not null;
        ai_recommendation_pattern : String(500) not null;
        panel                     : String(50) not null;
}

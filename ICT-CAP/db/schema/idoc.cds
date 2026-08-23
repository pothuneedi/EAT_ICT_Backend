namespace ict;

using { ict.po_lines, ict.asn_ibd } from './transactional';
using { ict.exception_rules, ict.exceptions } from './exceptions';

/**
 * Captures raw IDoc failures for EDI856 (ASN/DESADV) sourced from EDIDC/EDIDS.
 * Populated on a scheduled interval; feeds the AI classification pipeline
 * which writes its result back into ict.exceptions.
 *
 * IDoc error types are too numerous/varied to enumerate in exception_rules —
 * this table stores them raw; the AI classifies each row and links the result.
 */
entity edi856_idoc_errors {
    key docnum              : String(16);  // EDIDC-DOCNUM
    key po_number           : String(10);
    key line_item           : String(10);
        mestyp              : String(30);  // EDIDC-MESTYP, e.g. DESADV
        idoctp              : String(30);  // EDIDC-IDOCTP, e.g. DESADV01
        direct              : String(1);   // EDIDC-DIRECT: 1=outbound, 2=inbound
        status              : String(3);   // EDIDS-STATUS, e.g. 51, 56, 68
        status_text         : String(255); // EDIDS-STATXT / T100 message text
        error_msg           : LargeString; // Full concatenated application error/log detail
        repid               : String(40);  // EDIDS-REPID, program that raised the status

        po_line             : Association to po_lines on po_line.po_number = po_number and po_line.line_item = line_item;
        delivery            : String(10); // links to asn_ibd.delivery once/if the IDoc does post
        asn                 : Association to asn_ibd on asn.delivery = delivery;
        bill_of_lading      : String(35);

        idoc_credat         : Timestamp;      // EDIDC-CREDAT + CRETIM
        idoc_cretim         : Time;      // EDIDC-CRETIM (raw)
        status_logdat       : Timestamp;      // EDIDS-LOGDAT + LOGTIM
        status_logtim       : Time;      // EDIDS-LOGTIM (raw)

        // Denormalized bucket for quick filtering, derived from status code
        status_group        : String(10) not null default 'ERROR'; // ERROR | PENDING | POSTED | RETRYING

        // AI processing control (same pattern as po_lines.ai_processed)
        ai_processed        : Boolean not null default false;
        ai_processed_at     : Timestamp;
        exception_type_hint : String(50); // set once AI classifies this row
        matched_exception   : Association to exception_rules on matched_exception.exception_type = exception_type_hint;
        ict_exception_id    : Integer;
        linked_exception    : Association to exceptions on linked_exception.exception_id = ict_exception_id;

        raw_payload         : LargeString; // optional: raw IDoc segment dump for audit/debug
        last_synced_at      : Timestamp;

        created_at          : Timestamp default $now;
}

// Reverse navigation: PO line → its IDoc errors (defined here to avoid a
// circular using between transactional.cds and idoc.cds)
extend po_lines with {
    idoc_errors : Association to many edi856_idoc_errors on idoc_errors.po_number = po_number;
}

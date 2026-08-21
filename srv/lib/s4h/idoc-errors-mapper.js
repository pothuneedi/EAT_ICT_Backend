'use strict';

const { parseODataTime, combineDateAndTime } = require('./date-utils');
const { normalizeLineItem } = require('./entities/_shared');

const POSTED_STATUSES = new Set(['53', '57']);
const PENDING_STATUSES = new Set(['50', '52', '55', '56', '62', '63']);
const RETRYING_STATUSES = new Set(['59', '60', '61']);

function deriveStatusGroup(status) {
    const code = String(status || '').trim();
    if (!code) {
        return 'ERROR';
    }
    const normalized = code.padStart(2, '0');
    if (POSTED_STATUSES.has(normalized)) {
        return 'POSTED';
    }
    if (PENDING_STATUSES.has(normalized)) {
        return 'PENDING';
    }
    if (RETRYING_STATUSES.has(normalized)) {
        return 'RETRYING';
    }
    return 'ERROR';
}

/** Maps T_IBD_IDOC_ERRLOG → ict.edi856_idoc_errors. */
function mapIdocErrorRow(row, runTs) {
    if (!row.DOCNUM || !row.PO) {
        return null;
    }

    const lineItem = normalizeLineItem(row.PO_Item);
    if (!lineItem) {
        return null;
    }

    const createdTime = parseODataTime(row.CRETIM);

    return {
        docnum: String(row.DOCNUM),
        po_number: String(row.PO),
        line_item: lineItem,
        mestyp: row.MESTYP || null,
        idoctp: row.IDOCTP || null,
        direct: row.DIRECT || null,
        status: row.STATUS != null ? String(row.STATUS) : null,
        status_text: row.STATUS_TXT || null,
        error_msg: row.ERROR_MSG || null,
        repid: row.REPID || null,
        delivery: null,
        bill_of_lading: row.BOLNR || null,
        idoc_credat: combineDateAndTime(row.CREDAT, row.CRETIM),
        idoc_cretim: createdTime,
        status_logdat: combineDateAndTime(row.LOGDAT || row.CREDAT, row.LOGTIM || row.CRETIM),
        status_logtim: parseODataTime(row.LOGTIM) || createdTime,
        status_group: deriveStatusGroup(row.STATUS),
        last_synced_at: runTs
    };
}

const COMPARE_FIELDS = [
    'status',
    'status_text',
    'error_msg',
    'bill_of_lading',
    'status_group',
    'status_logdat'
];

function buildIdocUpsertRow(existing, incoming) {
    if (!existing) {
        return { row: incoming, op: 'insert' };
    }

    const changed = COMPARE_FIELDS.some(
        field => (existing[field] ?? null) !== (incoming[field] ?? null)
    );

    if (!changed) {
        return {
            row: {
                ...incoming,
                ai_processed: existing.ai_processed,
                ai_processed_at: existing.ai_processed_at,
                exception_type_hint: existing.exception_type_hint,
                ict_exception_id: existing.ict_exception_id
            },
            op: 'unchanged'
        };
    }

    return {
        row: {
            ...incoming,
            ai_processed: false,
            ai_processed_at: null,
            exception_type_hint: null,
            ict_exception_id: null
        },
        op: 'update'
    };
}

module.exports = { mapIdocErrorRow, buildIdocUpsertRow };

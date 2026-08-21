/* global SELECT, INSERT, UPDATE, DELETE */
'use strict';

/**
 * Data Upload Handler — testing & debugging tool.
 *
 * Lets the admin UI bulk-upload CSV rows into whitelisted tables.
 * Validates every row (unknown columns, missing keys/required fields,
 * type coercion, duplicates within the batch and against the DB) and
 * returns per-row errors so the UI can highlight culprit records.
 */

const cds = require('@sap/cds');

function isManageDataReadOnly() {
    const value = process.env.MANAGE_DATA_READ_ONLY;
    if (value === 'false' || value === '0') {
        return false;
    }
    return true;
}

// UI table name → DB entity (whitelist — nothing else can be written)
const TABLE_MAP = {
    POLines:        'ict.po_lines',
    POPartners:     'ict.po_partners',
    ASNIbd:         'ict.asn_ibd',
    CHREvents:      'ict.chr_events',
    Plants:         'ict.plants',
    Materials:      'ict.materials',
    Suppliers:      'ict.suppliers',
    Exceptions:     'ict.exceptions',
    ExceptionRules: 'ict.exception_rules',
    IDocErrors:     'ict.edi856_idoc_errors'
};

/** Alternate upsert key per UI table (when upsert=true and field is present). */
const UPSERT_ALT_KEY = {
    CHREvents: 'source_hash'
};

/**
 * Reads column metadata for an entity from the CDS model:
 * name, type, key flag, required flag (notNull without default).
 */
function getEntityMeta(entityName) {
    const entity = cds.model.definitions[entityName];
    if (!entity) return null;

    const columns = [];
    for (const [name, el] of Object.entries(entity.elements)) {
        if (el.target || el.type === 'cds.Association' || el.type === 'cds.Composition') continue;
        columns.push({
            name,
            type: (el.type || 'cds.String').replace('cds.', ''),
            key: !!el.key,
            required: !!(el.key || (el.notNull && el.default === undefined && !el['@cds.on.insert']))
        });
    }
    return { entityName, columns, keys: columns.filter(c => c.key).map(c => c.name) };
}

/**
 * Coerces a raw CSV string value into the CDS column type.
 * Returns { value } on success or { error } on bad input.
 */
function coerceValue(raw, column) {
    if (raw === undefined || raw === null) return { value: null };
    const s = String(raw).trim();
    if (s === '') return { value: null };

    switch (column.type) {
        case 'Integer':
        case 'Int64': {
            const n = parseInt(s, 10);
            if (isNaN(n)) return { error: `"${s}" is not a valid integer` };
            return { value: n };
        }
        case 'Decimal':
        case 'Double': {
            const n = parseFloat(s.replace(/,/g, ''));
            if (isNaN(n)) return { error: `"${s}" is not a valid number` };
            return { value: n };
        }
        case 'Boolean': {
            const t = s.toLowerCase();
            if (['true', '1', 'x', 'yes', 'y'].includes(t)) return { value: true };
            if (['false', '0', 'no', 'n', ''].includes(t)) return { value: false };
            return { error: `"${s}" is not a valid boolean (use true/false)` };
        }
        case 'Date': {
            // Accept YYYY-MM-DD or DD-MM-YYYY / DD/MM/YYYY
            let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return { value: `${m[1]}-${m[2]}-${m[3]}` };
            m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
            if (m) return { value: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` };
            return { error: `"${s}" is not a valid date (expected YYYY-MM-DD)` };
        }
        case 'Timestamp':
        case 'DateTime': {
            const d = new Date(s);
            if (isNaN(d.getTime())) return { error: `"${s}" is not a valid timestamp` };
            return { value: d.toISOString() };
        }
        default:
            return { value: s };
    }
}

/**
 * Main upload action.
 * Params: tableName (whitelist key), rows (JSON array string), upsert (bool)
 * Returns: { status, total, inserted, updated, failed, errors: [{row, column, message}] }
 */
async function uploadTableData(req) {
    const { tableName, rows: rowsJson, upsert } = req.data;

    if (isManageDataReadOnly()) {
        return req.error(403, 'Manage Data is read-only. Set MANAGE_DATA_READ_ONLY=false to enable writes.');
    }

    // 1. Validate the target table
    const entityName = TABLE_MAP[tableName];
    if (!entityName) {
        return req.error(400, `Unknown table "${tableName}". Allowed: ${Object.keys(TABLE_MAP).join(', ')}`);
    }
    const meta = getEntityMeta(entityName);
    if (!meta) return req.error(500, `Entity ${entityName} not found in CDS model.`);

    // 2. Parse rows JSON
    let rows;
    try {
        rows = JSON.parse(rowsJson || '[]');
    } catch (e) {
        return req.error(400, `Invalid rows payload: ${e.message}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return req.error(400, 'No rows to upload.');
    }
    if (rows.length > 5000) {
        return req.error(400, `Too many rows (${rows.length}). Max 5000 per upload.`);
    }

    const db = await cds.connect.to('db');
    const colByName = Object.fromEntries(meta.columns.map(c => [c.name, c]));
    const errors = [];

    // 3. Load existing keys from the DB for duplicate detection
    const existingKeys = new Set();
    const existingByAltKey = new Map();
    const altKeyField = UPSERT_ALT_KEY[tableName];
    if (meta.keys.length > 0) {
        const cols = [...meta.keys];
        if (altKeyField && !cols.includes(altKeyField)) cols.push(altKeyField);
        const existing = await db.run(SELECT.from(entityName).columns(...cols));
        for (const rec of existing) {
            existingKeys.add(meta.keys.map(k => String(rec[k] ?? '')).join('||'));
            if (altKeyField && rec[altKeyField]) {
                existingByAltKey.set(String(rec[altKeyField]), rec);
            }
        }
    }

    // 4. Validate + coerce each row
    const batchKeys = new Set();
    const prepared = []; // { row (index), record, isUpdate }

    rows.forEach((raw, idx) => {
        const rowErrors = [];
        const record = {};

        for (const [field, value] of Object.entries(raw)) {
            if (field.startsWith('_')) continue; // UI-internal fields
            const col = colByName[field];
            if (!col) {
                rowErrors.push({ row: idx, column: field, message: `Unknown column "${field}" for table ${tableName}` });
                continue;
            }
            const coerced = coerceValue(value, col);
            if (coerced.error) {
                rowErrors.push({ row: idx, column: field, message: `${field}: ${coerced.error}` });
            } else {
                record[field] = coerced.value;
            }
        }

        // Auto-generate missing UUID keys (e.g. cuid entities like job_schedules)
        for (const col of meta.columns) {
            if (col.key && col.type === 'UUID' && (record[col.name] === null || record[col.name] === undefined)) {
                record[col.name] = require('crypto').randomUUID();
            }
        }

        // Required fields (keys + notNull) must be present
        for (const col of meta.columns) {
            if (col.required && (record[col.name] === null || record[col.name] === undefined)) {
                rowErrors.push({ row: idx, column: col.name, message: `Missing required value for "${col.name}"` });
            }
        }

        if (rowErrors.length > 0) {
            errors.push(...rowErrors);
            return;
        }

        // Duplicate detection
        const keyStr = meta.keys.map(k => String(record[k] ?? '')).join('||');
        if (batchKeys.has(keyStr)) {
            errors.push({ row: idx, column: meta.keys.join('+'), message: `Duplicate key (${keyStr.replace(/\|\|/g, ', ')}) — same key appears earlier in this file` });
            return;
        }
        batchKeys.add(keyStr);

        const existsInDb = existingKeys.has(keyStr);
        const altMatch = altKeyField && record[altKeyField]
            ? existingByAltKey.get(String(record[altKeyField]))
            : null;

        if (altMatch && upsert) {
            for (const k of meta.keys) record[k] = altMatch[k];
        }

        const isUpdate = existsInDb || (!!altMatch && upsert);
        if (existsInDb && !upsert) {
            errors.push({ row: idx, column: meta.keys.join('+'), message: `Record already exists in database (${keyStr.replace(/\|\|/g, ', ')}). Enable "Update existing" to overwrite.` });
            return;
        }
        if (!existsInDb && altMatch && !upsert) {
            errors.push({ row: idx, column: altKeyField, message: `Record with ${altKeyField}="${record[altKeyField]}" already exists. Enable "Update existing" to overwrite.` });
            return;
        }

        prepared.push({ row: idx, record, isUpdate });
    });

    // 5. Insert / update valid rows one-by-one so a single DB error doesn't kill the batch
    let inserted = 0, updated = 0;
    for (const item of prepared) {
        try {
            if (item.isUpdate) {
                const where = Object.fromEntries(meta.keys.map(k => [k, item.record[k]]));
                await db.run(UPDATE(entityName).set(item.record).where(where));
                updated++;
            } else {
                await db.run(INSERT.into(entityName).entries(item.record));
                inserted++;
            }
        } catch (e) {
            errors.push({ row: item.row, column: '', message: `Database error: ${e.message}` });
        }
    }

    const failed = rows.length - inserted - updated;
    const status = failed === 0 ? 'Success' : (inserted + updated > 0 ? 'Partial' : 'Failed');
    console.log(`[DataUpload] ${tableName}: total=${rows.length} inserted=${inserted} updated=${updated} failed=${failed}`);

    return { status, total: rows.length, inserted, updated, failed, errors };
}

/**
 * Deletes records by key from a whitelisted table.
 * Params: tableName, rows (JSON array — each row must contain all key fields)
 * Returns: { status, total, deleted, failed, errors: [{row, column, message}] }
 */
async function deleteTableRows(req) {
    const { tableName, rows: rowsJson } = req.data;

    if (isManageDataReadOnly()) {
        return req.error(403, 'Manage Data is read-only. Set MANAGE_DATA_READ_ONLY=false to enable deletes.');
    }

    const entityName = TABLE_MAP[tableName];
    if (!entityName) {
        return req.error(400, `Unknown table "${tableName}". Allowed: ${Object.keys(TABLE_MAP).join(', ')}`);
    }
    const meta = getEntityMeta(entityName);
    if (!meta) return req.error(500, `Entity ${entityName} not found in CDS model.`);
    if (meta.keys.length === 0) return req.error(400, `Table ${tableName} has no key fields.`);

    let rows;
    try {
        rows = JSON.parse(rowsJson || '[]');
    } catch (e) {
        return req.error(400, `Invalid rows payload: ${e.message}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return req.error(400, 'No rows to delete.');
    }

    const db = await cds.connect.to('db');
    const colByName = Object.fromEntries(meta.columns.map(c => [c.name, c]));
    const errors = [];
    let deleted = 0;

    for (let idx = 0; idx < rows.length; idx++) {
        const raw = rows[idx];
        const where = {};
        let keyError = null;

        for (const k of meta.keys) {
            if (raw[k] === undefined || raw[k] === null || String(raw[k]).trim() === '') {
                keyError = `Missing key value for "${k}"`;
                break;
            }
            const coerced = coerceValue(raw[k], colByName[k]);
            if (coerced.error) { keyError = `${k}: ${coerced.error}`; break; }
            where[k] = coerced.value;
        }

        if (keyError) {
            errors.push({ row: idx, column: meta.keys.join('+'), message: keyError });
            continue;
        }

        try {
            const affected = await db.run(DELETE.from(entityName).where(where));
            if (affected > 0) {
                deleted++;
            } else {
                errors.push({ row: idx, column: meta.keys.join('+'), message: 'Record not found in database (already deleted?)' });
            }
        } catch (e) {
            errors.push({ row: idx, column: '', message: `Database error: ${e.message}` });
        }
    }

    const failed = rows.length - deleted;
    const status = failed === 0 ? 'Success' : (deleted > 0 ? 'Partial' : 'Failed');
    console.log(`[DataUpload] DELETE ${tableName}: total=${rows.length} deleted=${deleted} failed=${failed}`);

    return { status, total: rows.length, deleted, failed, errors };
}

/**
 * Returns table + column metadata for the upload UI (dropdown, templates, grid).
 */
async function getUploadTableMeta() {
    const tables = {};
    for (const [uiName, entityName] of Object.entries(TABLE_MAP)) {
        const meta = getEntityMeta(entityName);
        if (meta) {
            tables[uiName] = { columns: meta.columns, keys: meta.keys };
        }
    }
    return JSON.stringify({
        readOnly: isManageDataReadOnly(),
        tables
    });
}

function register(srv) {
    srv.on('uploadTableData', uploadTableData);
    srv.on('deleteTableRows', deleteTableRows);
    srv.on('getUploadTableMeta', getUploadTableMeta);
    console.log('[DataUploadHandler] CSV upload endpoints registered.');
}

module.exports = { register };

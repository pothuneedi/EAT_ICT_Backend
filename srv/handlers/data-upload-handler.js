/* global SELECT, INSERT, UPDATE */
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

// UI table name → DB entity (whitelist — nothing else can be written)
const TABLE_MAP = {
    POLines:        'ict.po_lines',
    ASNIbd:         'ict.asn_ibd',
    CHREvents:      'ict.chr_events',
    Plants:         'ict.plants',
    Materials:      'ict.materials',
    Suppliers:      'ict.suppliers',
    Exceptions:     'ict.exceptions',
    ExceptionTypes: 'ict.exception_types',
    ExceptionRules: 'ict.exception_rules',
    IDocErrors:     'ict.edi856_idoc_errors'
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
    if (meta.keys.length > 0) {
        const existing = await db.run(SELECT.from(entityName).columns(...meta.keys));
        for (const rec of existing) {
            existingKeys.add(meta.keys.map(k => String(rec[k] ?? '')).join('||'));
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
        if (existsInDb && !upsert) {
            errors.push({ row: idx, column: meta.keys.join('+'), message: `Record already exists in database (${keyStr.replace(/\|\|/g, ', ')}). Enable "Update existing" to overwrite.` });
            return;
        }

        prepared.push({ row: idx, record, isUpdate: existsInDb });
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
 * Returns table + column metadata for the upload UI (dropdown, templates, grid).
 */
async function getUploadTableMeta() {
    const result = {};
    for (const [uiName, entityName] of Object.entries(TABLE_MAP)) {
        const meta = getEntityMeta(entityName);
        if (meta) result[uiName] = { columns: meta.columns, keys: meta.keys };
    }
    return JSON.stringify(result);
}

function register(srv) {
    srv.on('uploadTableData', uploadTableData);
    srv.on('getUploadTableMeta', getUploadTableMeta);
    console.log('[DataUploadHandler] CSV upload endpoints registered.');
}

module.exports = { register };

/* global SELECT */
'use strict';

const cds = require('@sap/cds');
const { z } = require('zod');
const { tool } = require('ai');
const { QUERYABLE_TABLES, ensureCatalog, resolveTable } = require('./chat-schema');
const { getIctDashboardSummary } = require('./dashboard-analytics');

const MAX_QUERY_ROWS = parseInt(process.env.CHAT_QUERY_MAX_ROWS || '25', 10);

const OPERATOR_ALIASES = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    eq: '=',
    ne: '!=',
    neq: '!='
};

const CDS_OPS = new Set(['>', '<', '>=', '<=', '=', '!=', '<>', 'like', 'in', 'not in']);

const scalarValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const scalarArray = z.array(z.union([z.string(), z.number(), z.boolean()]));
const whereValueSchema = z.union([
    scalarValue,
    scalarArray,
    z.object({
        operator: z.enum(['>', '<', '>=', '<=', '=', '!=', '<>', 'in', 'not in', 'is null', 'is not null']),
        value: z.union([scalarValue, scalarArray]).optional()
    })
]);
const whereFilterSchema = z.record(whereValueSchema);

function normalizeOperator(rawOp, opValue) {
    const op = OPERATOR_ALIASES[String(rawOp).toLowerCase()] || String(rawOp).toLowerCase();

    if (op === 'is null') {
        return null;
    }
    if (op === 'is not null') {
        return { '!=': null };
    }
    if (op === 'in' || op === 'not in') {
        const values = Array.isArray(opValue) ? opValue : [opValue];
        return { [op]: values };
    }
    if (op === '=') {
        return opValue;
    }
    if (opValue !== undefined) {
        return { [op]: opValue };
    }
    return undefined;
}

function normalizeWhereClauseValue(value) {
    if (value === undefined || value === '') {
        return undefined;
    }
    if (Array.isArray(value)) {
        return { in: value };
    }
    if (typeof value !== 'object' || value === null) {
        return value;
    }
    if (value.operator) {
        return normalizeOperator(value.operator, value.value);
    }

    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== '');
    if (entries.length === 1) {
        const [rawOp, opValue] = entries[0];
        const op = OPERATOR_ALIASES[String(rawOp).toLowerCase()] || rawOp;
        if (CDS_OPS.has(op)) {
            return normalizeOperator(op, opValue);
        }
    }

    return value;
}

function applyWhereObject(query, where, hasWhere = false) {
    if (!where || typeof where !== 'object') {
        return { query, hasWhere };
    }

    const clause = {};
    for (const [column, value] of Object.entries(where)) {
        const normalized = normalizeWhereClauseValue(value);
        if (normalized !== undefined) {
            clause[column] = normalized;
        }
    }

    if (!Object.keys(clause).length) {
        return { query, hasWhere };
    }

    return {
        query: hasWhere ? query.and(clause) : query.where(clause),
        hasWhere: true
    };
}

async function getDb() {
    return cds.connect.to('db');
}

function clampRowLimit(value) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) {
        return MAX_QUERY_ROWS;
    }
    return Math.min(parsed, MAX_QUERY_ROWS);
}

function applyWhereLike(query, whereLike, allowedColumns, hasWhere = false) {
    if (!whereLike || typeof whereLike !== 'object') {
        return { query, hasWhere };
    }

    let nextQuery = query;
    let nextHasWhere = hasWhere;
    for (const [column, value] of Object.entries(whereLike)) {
        if (!allowedColumns.has(column) || value === undefined || value === null || value === '') {
            continue;
        }
        const clause = { [column]: { like: `%${String(value).trim()}%` } };
        nextQuery = nextHasWhere ? nextQuery.and(clause) : nextQuery.where(clause);
        nextHasWhere = true;
    }

    return { query: nextQuery, hasWhere: nextHasWhere };
}

function buildCompositeKey(row, fields) {
    return fields.map((field) => String(row[field] ?? '').trim()).join('|');
}

function poNumbersFromKeys(keys) {
    return [...new Set([...keys].map((key) => String(key).split('|')[0]?.trim()).filter(Boolean))];
}

function rejectUnknownColumns(filters, allowedColumns, label) {
    if (!filters || typeof filters !== 'object') {
        return;
    }
    const unknown = Object.keys(filters).filter((column) => !allowedColumns.has(column));
    if (unknown.length) {
        const allowed = [...allowedColumns].sort().join(', ');
        throw new Error(`Unknown ${label} column(s): ${unknown.join(', ')}. Allowed on this table: ${allowed}`);
    }
}

function linkedSqlValues(keys, sourceFields) {
    if (sourceFields.length === 1) {
        const field = sourceFields[0];
        const values = new Set();
        for (const key of keys) {
            if (key.endsWith('|*')) {
                values.add(key.slice(0, -2));
                continue;
            }
            values.add(field === 'po_number' ? key.split('|')[0] : key);
        }
        return { field, values: [...values].filter(Boolean) };
    }

    if (sourceFields.includes('po_number')) {
        return { field: 'po_number', values: poNumbersFromKeys(keys) };
    }

    return null;
}

function applyFilters(query, args, linkedFilter, allowedColumns) {
    let hasWhere = false;

    if (linkedFilter) {
        const linked = linkedSqlValues(linkedFilter.keys, linkedFilter.sourceFields);
        if (linked?.values.length && allowedColumns.has(linked.field)) {
            query = query.where({ [linked.field]: { in: linked.values } });
            hasWhere = true;
        }
    }

    const filtered = applyWhereObject(query, args.where, hasWhere);
    return applyWhereLike(filtered.query, args.whereLike, allowedColumns, filtered.hasWhere);
}

async function fetchLinkedKeys(db, linkSpec, linkedWhere, linkedWhereLike) {
    const linkedMeta = resolveTable(linkSpec.table);
    const allowedColumns = new Set(linkedMeta.columns);
    let query = SELECT.from(linkedMeta.entity);
    let hasWhere = false;
    ({ query, hasWhere } = applyWhereObject(query, linkedWhere, hasWhere));
    ({ query, hasWhere } = applyWhereLike(query, linkedWhereLike, allowedColumns, hasWhere));

    const rows = await db.run(query.limit(MAX_QUERY_ROWS * 20));
    const sourceFields = Object.keys(linkSpec.on);
    const targetFields = Object.values(linkSpec.on);
    const keys = new Set();

    for (const row of rows) {
        const keyParts = targetFields.map((field) => row[field]);
        if (keyParts.some((part) => part == null || part === '')) {
            if (sourceFields.length === 1 && keyParts[0]) {
                keys.add(`${String(keyParts[0]).trim()}|*`);
            }
            continue;
        }
        keys.add(keyParts.map((part) => String(part).trim()).join('|'));
        if (sourceFields.length === 1) {
            keys.add(`${String(keyParts[0]).trim()}|*`);
        }
    }

    return { sourceFields, keys };
}

function rowMatchesLinkedKeys(row, sourceFields, keys) {
    if (!keys.size) {
        return false;
    }
    if (keys.has(buildCompositeKey(row, sourceFields))) {
        return true;
    }
    if (sourceFields.length === 1) {
        return keys.has(`${String(row[sourceFields[0]] ?? '').trim()}|*`);
    }
    const prefix = `${buildCompositeKey(row, sourceFields.slice(0, 1))}|`;
    for (const key of keys) {
        if (key.startsWith(prefix) && !key.endsWith('|*')) {
            return true;
        }
    }
    return false;
}

function pickColumns(meta, select) {
    if (!Array.isArray(select) || !select.length) {
        return meta.columns;
    }
    const allowed = new Set(meta.columns);
    const picked = select.filter((column) => allowed.has(column));
    return picked.length ? picked : meta.columns;
}

async function countRows(db, meta, args, linkedFilter) {
    const allowedColumns = new Set(meta.columns);
    const countQuery = applyFilters(
        SELECT.one.from(meta.entity).columns('count(*) as total'),
        args,
        linkedFilter,
        allowedColumns
    ).query;
    const result = await db.run(countQuery);
    return Number(result?.total || 0);
}

function buildResult(args, total, rows, note) {
    const result = {
        from: args.from,
        total,
        returned: rows.length,
        truncated: total > rows.length,
        max_rows_per_query: MAX_QUERY_ROWS,
        rows
    };
    if (note) {
        result.note = note;
    }
    return result;
}

async function queryIctData(args = {}) {
    await ensureCatalog();
    const meta = resolveTable(args.from);
    const db = await getDb();
    const allowedColumns = new Set(meta.columns);
    const rowLimit = clampRowLimit(args.limit);
    const columns = pickColumns(meta, args.select);

    rejectUnknownColumns(args.where, allowedColumns, 'where');
    rejectUnknownColumns(args.whereLike, allowedColumns, 'whereLike');

    let linkedFilter = null;
    if (args.linked?.table) {
        const linkedMeta = resolveTable(args.linked.table);
        const linkedColumns = new Set(linkedMeta.columns);
        rejectUnknownColumns(args.linked.where, linkedColumns, `linked.where (${args.linked.table})`);
        rejectUnknownColumns(args.linked.whereLike, linkedColumns, `linked.whereLike (${args.linked.table})`);

        const linkOn = args.linked.on || meta.links?.[args.linked.table];
        if (!linkOn) {
            throw new Error(`No link defined between ${args.from} and ${args.linked.table}. See schema Links for valid joins.`);
        }
        linkedFilter = await fetchLinkedKeys(
            db,
            { table: args.linked.table, on: linkOn },
            args.linked.where,
            args.linked.whereLike
        );

        if (!linkedFilter.keys.size) {
            return buildResult(args, 0, [], `No matching rows in linked table ${args.linked.table}.`);
        }
    }

    const total = await countRows(db, meta, args, linkedFilter);

    if (args.countOnly) {
        return buildResult(args, total, []);
    }

    let query = applyFilters(SELECT.from(meta.entity), args, linkedFilter, allowedColumns).query;
    query = query.columns(...columns);
    if (args.orderBy) {
        query = query.orderBy(String(args.orderBy));
    }

    const scanLimit = linkedFilter
        ? Math.min(Math.max(poNumbersFromKeys(linkedFilter.keys).length * rowLimit, rowLimit), MAX_QUERY_ROWS * 10)
        : rowLimit;
    query = query.limit(scanLimit);

    let rows = await db.run(query);
    if (linkedFilter) {
        rows = rows.filter((row) => rowMatchesLinkedKeys(row, linkedFilter.sourceFields, linkedFilter.keys));
    }
    rows = rows.slice(0, rowLimit);

    return buildResult(args, total, rows);
}

function createChatTools() {
    return {
        getIctDashboardSummary: tool({
            description: 'ICT dashboard summary counts only. Use ONLY when the user asks for a summary, overview, dashboard, or KPI snapshot.',
            inputSchema: z.object({
                plant: z.string().optional(),
                deliveryDateFrom: z.string().optional(),
                deliveryDateTo: z.string().optional(),
                priority: z.string().optional(),
                exceptionType: z.string().optional(),
                search: z.string().optional()
            }),
            execute: getIctDashboardSummary
        }),
        queryIctData: tool({
            description: `Query ICT tables (lists, filters, details). Max ${MAX_QUERY_ROWS} rows per call.`,
            inputSchema: z.object({
                from: z.enum(QUERYABLE_TABLES),
                select: z.array(z.string()).optional(),
                where: whereFilterSchema.optional(),
                whereLike: z.record(z.string()).optional(),
                linked: z.object({
                    table: z.enum(QUERYABLE_TABLES),
                    on: z.record(z.string()).optional(),
                    where: whereFilterSchema.optional(),
                    whereLike: z.record(z.string()).optional()
                }).optional(),
                orderBy: z.string().optional(),
                limit: z.number().int().min(1).optional(),
                countOnly: z.boolean().optional()
            }),
            execute: queryIctData
        })
    };
}

module.exports = {
    createChatTools,
    queryIctData,
    MAX_QUERY_ROWS
};

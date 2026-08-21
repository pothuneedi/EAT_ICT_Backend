'use strict';

function splitCsv(value) {
    return (value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function buildODataBasePath(service, entitySet) {
    return `/sap/opu/odata/sap/${service}/${entitySet}`;
}

function escapeODataString(value) {
    return String(value).replace(/'/g, "''");
}

function chunkArray(items, size) {
    if (!items.length || size < 1) {
        return [];
    }
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/** Nullable number from SAP JSON (string or number). */
function sapDecimal(value) {
    if (value == null || value === '') {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** SAP PO line — canonical 5-digit form when numeric (10 → 00010). */
function normalizeLineItem(value) {
    if (value == null || value === '') {
        return null;
    }

    const raw = String(value).trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && /^\d+$/.test(raw)) {
        return String(n).padStart(5, '0');
    }

    return raw;
}

function appendFilterClause(base, clause) {
    if (!clause) {
        return base || null;
    }
    return base ? `${base} and ${clause}` : clause;
}

function buildODataQuery({ expand, filter, deltaSince, select } = {}) {
    const parts = ['$format=json'];
    // $select is a correctness control, not only a payload optimisation: SAP
    // serialises every field it returns, so one corrupt value in a column this
    // sync never reads still aborts the whole response. Fields we do not ask
    // for cannot break us.
    if (select?.length) {
        parts.unshift(`$select=${select.join(',')}`);
    }
    if (expand?.length) {
        parts.unshift(`$expand=${expand.join(',')}`);
    }

    let effectiveFilter = filter || null;
    if (deltaSince) {
        effectiveFilter = appendFilterClause(
            effectiveFilter,
            `LastChangeDateTime gt datetimeoffset'${deltaSince}'`
        );
    }
    if (effectiveFilter) {
        parts.unshift(`$filter=${effectiveFilter}`);
    }
    return `?${parts.join('&')}`;
}

function buildODataCountPath(basePath, filter) {
    return filter ? `${basePath}/$count?$filter=${filter}` : `${basePath}/$count`;
}

module.exports = {
    splitCsv,
    buildODataBasePath,
    buildODataQuery,
    buildODataCountPath,
    appendFilterClause,
    escapeODataString,
    chunkArray,
    sapDecimal,
    normalizeLineItem
};

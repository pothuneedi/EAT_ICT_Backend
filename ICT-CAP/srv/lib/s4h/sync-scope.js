'use strict';

const DEFAULT_DAYS_BACK = 30;

/** Only po_lines uses the date range on the S/4 OData fetch. ASN and IDoc follow open PO numbers. */
const PO_DATE_SCOPED_ENTITY = 'po_lines';

function todayUtcYmd() {
    return new Date().toISOString().substring(0, 10);
}

function daysAgoUtcYmd(days) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().substring(0, 10);
}

function parseYmd(value) {
    if (value == null || value === '') {
        return null;
    }

    const str = value instanceof Date
        ? value.toISOString().substring(0, 10)
        : String(value).substring(0, 10);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        throw new Error(`Invalid date '${value}'. Use YYYY-MM-DD.`);
    }

    return str;
}

function buildDateScope(fromDate, toDate) {
    return { fromDate, toDate, label: `${fromDate} to ${toDate}` };
}

function currentYearDateScope() {
    const year = new Date().getUTCFullYear();
    return buildDateScope(`${year}-01-01`, `${year}-12-31`);
}

/**
 * PO date window for the S/4 fetch. ASN/IDoc inherit scope via open po_lines in the DB.
 * fromDate + toDate when provided; otherwise Jan 1 – Dec 31 of the current year.
 */
function resolveDateScope({ fromDate, toDate } = {}) {
    const from = parseYmd(fromDate);
    const to = parseYmd(toDate);

    if (from || to) {
        if (!from || !to) {
            throw new Error('Both fromDate and toDate are required for a PO date range.');
        }
        if (from > to) {
            throw new Error(`fromDate (${from}) must be on or before toDate (${to}).`);
        }
        return buildDateScope(from, to);
    }

    return currentYearDateScope();
}

/**
 * Resolves PO date scope from a job schedule config object.
 * Prefers fromDate/toDate; falls back to lookbackDays for legacy schedules.
 */
function resolveDateScopeFromConfig(config = {}) {
    if (config.fromDate || config.toDate) {
        return resolveDateScope({ fromDate: config.fromDate, toDate: config.toDate });
    }

    const lookbackDays = config.lookbackDays;
    if (lookbackDays != null && lookbackDays !== '') {
        const days = parseInt(lookbackDays, 10);
        if (!Number.isFinite(days) || days < 1) {
            throw new Error('lookbackDays must be a positive integer.');
        }
        return buildDateScope(daysAgoUtcYmd(days), todayUtcYmd());
    }

    return currentYearDateScope();
}

function buildPoDateFilter(dateScope) {
    if (!dateScope?.fromDate) {
        return null;
    }

    return (
        `to_PurchaseOrder/PurchaseOrderDate ge datetime'${dateScope.fromDate}T00:00:00' `
        + `and to_PurchaseOrder/PurchaseOrderDate le datetime'${dateScope.toDate}T00:00:00'`
    );
}

module.exports = {
    PO_DATE_SCOPED_ENTITY,
    DEFAULT_DAYS_BACK,
    currentYearDateScope,
    resolveDateScope,
    resolveDateScopeFromConfig,
    buildPoDateFilter
};

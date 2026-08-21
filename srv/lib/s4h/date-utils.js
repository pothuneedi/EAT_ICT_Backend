'use strict';

/**
 * S/4 → ISO-8601 UTC timestamps for persistence.
 *
 * Wall-clock rule: values without a timezone (Z / offset) keep their date and time
 * components exactly — e.g. "26 Jan 2026 3:30:30" → 2026-01-26T03:30:30.000Z.
 * Values with an explicit offset are converted to the correct UTC instant.
 */

const MONTH_INDEX = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
};

function utcTimestamp(y, m, d, h = 0, min = 0, sec = 0, ms = 0) {
    const oDate = new Date(Date.UTC(y, m, d, h, min, sec, ms));
    return Number.isNaN(oDate.getTime()) ? null : oDate.toISOString();
}

function monthIndex(sName) {
    if (!sName) {
        return null;
    }
    return MONTH_INDEX[String(sName).trim().toLowerCase()] ?? null;
}

function hasExplicitTimezone(s) {
    return /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
}

function parseCalendarParts(nYear, nMonth, nDay, h = 0, min = 0, sec = 0, ms = 0) {
    if (!Number.isFinite(nYear) || !Number.isFinite(nMonth) || !Number.isFinite(nDay)) {
        return null;
    }
    if (nMonth < 1 || nMonth > 12 || nDay < 1 || nDay > 31) {
        return null;
    }
    return utcTimestamp(nYear, nMonth - 1, nDay, h, min, sec, ms);
}

function parseNaiveIsoDateTime(s) {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
    if (!m) {
        return null;
    }
    return parseCalendarParts(
        parseInt(m[1], 10),
        parseInt(m[2], 10),
        parseInt(m[3], 10),
        parseInt(m[4], 10),
        parseInt(m[5], 10),
        parseInt(m[6] || '0', 10),
        parseInt(m[7] || '0', 10)
    );
}

function parseDayMonthYearTime(s) {
    const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
    if (!m) {
        return null;
    }
    const iMonth = monthIndex(m[2]);
    if (iMonth == null) {
        return null;
    }
    return utcTimestamp(
        parseInt(m[3], 10),
        iMonth,
        parseInt(m[1], 10),
        parseInt(m[4], 10),
        parseInt(m[5], 10),
        parseInt(m[6] || '0', 10),
        parseInt(m[7] || '0', 10)
    );
}

function parseMonthDayYearTime(s) {
    const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
    if (!m) {
        return null;
    }
    const iMonth = monthIndex(m[1]);
    if (iMonth == null) {
        return null;
    }
    return utcTimestamp(
        parseInt(m[3], 10),
        iMonth,
        parseInt(m[2], 10),
        parseInt(m[4], 10),
        parseInt(m[5], 10),
        parseInt(m[6] || '0', 10),
        parseInt(m[7] || '0', 10)
    );
}

function parseDotDateTime(s) {
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/);
    if (!m) {
        return null;
    }
    return parseCalendarParts(
        parseInt(m[3], 10),
        parseInt(m[2], 10),
        parseInt(m[1], 10),
        parseInt(m[4], 10),
        parseInt(m[5], 10),
        parseInt(m[6] || '0', 10),
        parseInt(m[7] || '0', 10)
    );
}

function parseODataTimestamp(value) {
    if (value == null || value === '') {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toISOString();
    }
    if (typeof value !== 'string') {
        return null;
    }

    const s = value.trim();
    if (!s) {
        return null;
    }

    if (hasExplicitTimezone(s)) {
        const oDate = new Date(s);
        return Number.isNaN(oDate.getTime()) ? null : oDate.toISOString();
    }

    const msMatch = s.match(/\/Date\((-?\d+)(?:[+-]\d+)?\)\//);
    if (msMatch) {
        return new Date(parseInt(msMatch[1], 10)).toISOString();
    }

    const naiveIso = parseNaiveIsoDateTime(s);
    if (naiveIso) {
        return naiveIso;
    }

    const dayMonthYearTime = parseDayMonthYearTime(s);
    if (dayMonthYearTime) {
        return dayMonthYearTime;
    }

    const monthDayYearTime = parseMonthDayYearTime(s);
    if (monthDayYearTime) {
        return monthDayYearTime;
    }

    const dotDateTime = parseDotDateTime(s);
    if (dotDateTime) {
        return dotDateTime;
    }

    if (/^\d{8}$/.test(s)) {
        return parseCalendarParts(
            parseInt(s.slice(0, 4), 10),
            parseInt(s.slice(4, 6), 10),
            parseInt(s.slice(6, 8), 10)
        );
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map((v) => parseInt(v, 10));
        return parseCalendarParts(y, m, d);
    }

    if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
        const [d, m, y] = s.split('.').map((v) => parseInt(v, 10));
        return parseCalendarParts(y, m, d);
    }

    if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
        const [y, m, d] = s.split('/').map((v) => parseInt(v, 10));
        return parseCalendarParts(y, m, d);
    }

    const dayMonthYear = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (dayMonthYear) {
        const iMonth = monthIndex(dayMonthYear[2]);
        if (iMonth == null) {
            return null;
        }
        return utcTimestamp(parseInt(dayMonthYear[3], 10), iMonth, parseInt(dayMonthYear[1], 10));
    }

    const monthDayYear = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (monthDayYear) {
        const iMonth = monthIndex(monthDayYear[1]);
        if (iMonth == null) {
            return null;
        }
        return utcTimestamp(parseInt(monthDayYear[3], 10), iMonth, parseInt(monthDayYear[2], 10));
    }

    const abbrMonth = s.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})$/i);
    if (abbrMonth) {
        const iMonth = monthIndex(abbrMonth[2]);
        if (iMonth == null) {
            return null;
        }
        return utcTimestamp(parseInt(abbrMonth[3], 10), iMonth, parseInt(abbrMonth[1], 10));
    }

    return null;
}

function parseODataTime(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    const durationMatch = value.match(/^PT(\d{2})H(\d{2})M(?:(\d{2}))?S$/);
    if (durationMatch) {
        const seconds = durationMatch[3] || '00';
        return `${durationMatch[1]}:${durationMatch[2]}:${seconds}`;
    }

    if (/^\d{2}:\d{2}/.test(value)) {
        return value.length >= 8 ? value.substring(0, 8) : `${value}:00`;
    }

    if (/^\d{6}$/.test(value)) {
        return `${value.slice(0, 2)}:${value.slice(2, 4)}:${value.slice(4, 6)}`;
    }

    return null;
}

function combineDateAndTime(dateValue, timeValue) {
    const timePart = parseODataTime(timeValue);
    if (!timePart) {
        return parseODataTimestamp(dateValue);
    }

    const dateIso = parseODataTimestamp(dateValue);
    if (!dateIso) {
        return null;
    }

    const d = new Date(dateIso);
    const parts = timePart.split(':').map((v) => parseInt(v, 10) || 0);
    return utcTimestamp(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        parts[0],
        parts[1],
        parts[2] || 0
    );
}

function compareTimestamps(a, b) {
    const da = parseODataTimestamp(a) || a || '';
    const db = parseODataTimestamp(b) || b || '';
    return da.localeCompare(db);
}

/** YYYY-MM-DD for delivery-window / bucket logic only — not for storage. */
function calendarDateKey(value) {
    const iso = parseODataTimestamp(value);
    return iso ? iso.slice(0, 10) : null;
}

module.exports = {
    parseODataTimestamp,
    parseODataTime,
    combineDateAndTime,
    compareTimestamps,
    calendarDateKey
};

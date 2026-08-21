'use strict';

const {
    NO_DATA,
    NON_MASKABLE,
    LLM_MASK_FIELDS
} = require('./pii-policy');

function isMaskable(value) {
    return typeof value === 'string'
        && value.trim() !== ''
        && !NON_MASKABLE.has(value.trim());
}

function replaceAll(text, from, to) {
    return text.split(from).join(to);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSupplierName(supplier, supplierId) {
    if (supplier) {
        const parts = [supplier.name, supplier.name_2]
            .map((part) => String(part || '').trim())
            .filter(Boolean);
        if (parts.length) {
            return parts.join(' ');
        }
    }
    const id = String(supplier?.supplier || supplierId || '').trim();
    return id ? `Supplier ${id}` : NO_DATA;
}

function buildSupplierAddress(supplier) {
    if (!supplier) {
        return NO_DATA;
    }
    const parts = [supplier.street, supplier.city, supplier.region, supplier.postal_code]
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    return parts.length ? parts.join(', ') : NO_DATA;
}

function readSupplierValue(supplier, rule) {
    if (!rule.supplierValue) {
        return null;
    }
    if (rule.supplierValue === 'address') {
        return buildSupplierAddress(supplier);
    }
    return supplier?.[rule.supplierValue] ?? null;
}

/** Copy supplier fields onto the PO row; mask only email and address for the LLM. */
function enrichSupplierContacts(po, supplier) {
    const out = { ...po };
    out.supplier_name = buildSupplierName(supplier, po.supplier_id);
    for (const rule of LLM_MASK_FIELDS) {
        const raw = readSupplierValue(supplier, rule);
        out[rule.field] = isMaskable(raw) ? raw : NO_DATA;
    }
    return out;
}

function isPiiDebugEnabled() {
    if (process.env.PII_DEBUG === 'false' || process.env.PII_DEBUG === '0') {
        return false;
    }
    if (process.env.PII_DEBUG === 'true' || process.env.PII_DEBUG === '1') {
        return true;
    }
    return process.env.NODE_ENV === 'development';
}

function truncateForPiiLog(text, max = 200) {
    if (typeof text !== 'string' || !text) {
        return '(none)';
    }
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

const PII_FIELD_LABELS = {
    supplier_email: 'Email',
    supplier_address: 'Address'
};

/** One readable block for demos — anonymized AI input vs restored ICT output. */
function formatPiiBusinessReport({ poLabel, safe, recommendation }) {
    const anonymized = LLM_MASK_FIELDS.map(({ field }) => {
        const label = PII_FIELD_LABELS[field] || field;
        return `  ${label.padEnd(15)} ${safe?.[field] ?? NO_DATA}`;
    });

    return [
        '',
        '========== SUPPLIER DATA PRIVACY (Exception Analysis) ==========',
        `PO line: ${poLabel}`,
        '',
        'What the external AI received (anonymized sample data — not the real supplier):',
        ...anonymized,
        '',
        'What ICT saved for your team (real supplier details restored):',
        `  Recommendation: ${truncateForPiiLog(recommendation)}`,
        '================================================================',
        ''
    ].join('\n');
}

/** Emit one PII report block — clean console output, optional job-log hook. */
function logPiiReport(report, onLog) {
    if (!isPiiDebugEnabled()) {
        return;
    }
    if (onLog) {
        onLog(report);
        return;
    }
    console.log(`\n${String(report).trim()}\n`);
}

/** Replace real PII with surrogates for the LLM prompt. */
function maskForLlm(record) {
    const map = new Map();
    const safe = { ...record };
    const secrets = [];

    for (const { field, surrogate } of LLM_MASK_FIELDS) {
        const value = record?.[field];
        if (!isMaskable(value)) {
            continue;
        }
        safe[field] = surrogate;
        map.set(surrogate, value);
        secrets.push(value);
    }

    return { safe, map, secrets };
}

/** Throws if real PII is still present in text sent to an external LLM. */
function assertPromptSafe(text, secrets, logLabel) {
    if (!text || !secrets?.length) {
        return;
    }
    const leaked = secrets.filter((secret) => text.includes(secret));
    if (leaked.length) {
        const label = logLabel ? `${logLabel}: ` : '';
        throw new Error(`${label}PII not masked before LLM call (${leaked.length} leak(s))`);
    }
}

function deanonymize(text, map) {
    if (typeof text !== 'string' || !map?.size) {
        return text;
    }

    const entries = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [surrogate, value] of entries) {
        out = replaceAll(out, `**${surrogate}**`, `**${value}**`);
        out = replaceAll(out, surrogate, value);
        out = out.replace(new RegExp(escapeRegExp(surrogate), 'gi'), value);
    }
    return out;
}

/** Swap dummy supplier values back to real values in classifier output. */
function restoreClassifierOutput(result, map, logLabel) {
    if (!result || !map?.size) {
        return result;
    }

    result.recommendation = deanonymize(result.recommendation, map);
    result.evidence = deanonymize(result.evidence, map);

    const combined = [result.recommendation, result.evidence]
        .filter((t) => typeof t === 'string')
        .join('\n');

    const leftover = [...map.keys()].filter((token) => combined.includes(token));
    if (leftover.length && logLabel && !isPiiDebugEnabled()) {
        console.warn(`[AiService] ${logLabel} — dummy supplier value(s) not echoed by model: ${leftover.join(', ')}`);
    }

    return result;
}

module.exports = {
    enrichSupplierContacts,
    maskForLlm,
    assertPromptSafe,
    restoreClassifierOutput,
    isPiiDebugEnabled,
    formatPiiBusinessReport,
    logPiiReport
};

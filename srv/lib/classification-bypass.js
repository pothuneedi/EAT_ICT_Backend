const { normalizePriority } = require('./priority-utils');
const { calendarDateKey } = require('./s4h/date-utils');
const { normalizePartnerFunctions, normalizePartnerSuppliers } = require('./po-partners');

const RULE_BASED_EXCEPTION_TYPE = 'PENDING_ELIGIBILITY';

const STATUS_REPORT_OUTCOME = {
    panel: 'STATUS_REPORT',
    priority: 'LOW',
    priority_score: 9
};

const ACTION_REQUIRED_OUTCOME = {
    panel: 'ACTION_REQUIRED',
    priority: 'HIGH',
    priority_score: 1
};

const ELIGIBILITY_NOTE = {
    PARTNER_INELIGIBLE: 'Partner not eligible for AI review',
    LOGISTICS_HEADER: 'Awaiting shipment signals',
    NO_ASN: 'No ASN on file',
    NO_IDOC: 'No EDI856 IDoc records on file',
    NO_CARRIER: 'No carrier tracking on file'
};

const LOGISTICS_GAP_NOTES = new Set([
    ELIGIBILITY_NOTE.NO_ASN,
    ELIGIBILITY_NOTE.NO_IDOC,
    ELIGIBILITY_NOTE.NO_CARRIER
]);

function daysUntilDelivery(deliveryDate) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const delivDate = new Date(deliveryDate);
    delivDate.setUTCHours(0, 0, 0, 0);
    return Math.ceil((delivDate - today) / (1000 * 60 * 60 * 24));
}

function buildPartnersByPo(poPartners) {
    const map = {};
    for (const row of poPartners || []) {
        if (!row.po_number) {
            continue;
        }
        (map[row.po_number] = map[row.po_number] || []).push({
            partner_function: String(row.partner_function || '').trim().toUpperCase(),
            supplier: String(row.supplier || '').trim()
        });
    }
    return map;
}

/** Same row must match partner_function AND supplier when each list is configured. */
function hasEligiblePartnerRow(poNumber, partnerFunctions, partnerSuppliers, partnersByPo) {
    const functions = normalizePartnerFunctions(partnerFunctions || []);
    const suppliers = normalizePartnerSuppliers(partnerSuppliers || []);
    if (!functions.length && !suppliers.length) {
        return true;
    }

    const rows = partnersByPo?.[poNumber] || [];
    return rows.some(row => {
        const fnOk = !functions.length || functions.includes(row.partner_function);
        const supOk = !suppliers.length || suppliers.includes(row.supplier);
        return fnOk && supOk;
    });
}

/** At least one logistics signal: posted ASN, EDI856 IDoc issue, or carrier (CHR) event. */
function hasLogisticsSignal(asn, idocErrors, latestChr) {
    return Boolean(asn || idocErrors?.length || latestChr);
}

/** Missing shipment signals — only when none of ASN, IDoc, or CHR exist. */
function getLogisticsSignalGaps(asn, idocErrors, latestChr) {
    if (hasLogisticsSignal(asn, idocErrors, latestChr)) {
        return [];
    }

    return [
        ELIGIBILITY_NOTE.LOGISTICS_HEADER,
        ELIGIBILITY_NOTE.NO_ASN,
        ELIGIBILITY_NOTE.NO_IDOC,
        ELIGIBILITY_NOTE.NO_CARRIER
    ];
}

function formatEligibilityRecommendation(notes) {
    return notes.map(note => {
        const prefix = LOGISTICS_GAP_NOTES.has(note) ? '  - ' : '- ';
        return `${prefix}${note}`;
    }).join('\n');
}

/** Blocking gaps in flowchart order (empty = run AI). */
function getEligibilityNotes({ po, asn, latestChr, idocErrors, cutoffDate, partnerFunctions, partnerSuppliers, partnersByPo }) {
    if (po.delivery_date && cutoffDate && calendarDateKey(po.delivery_date) > cutoffDate) {
        return [`Delivery in ${daysUntilDelivery(po.delivery_date)} days — outside review window`];
    }

    if (!hasEligiblePartnerRow(po.po_number, partnerFunctions, partnerSuppliers, partnersByPo)) {
        return [ELIGIBILITY_NOTE.PARTNER_INELIGIBLE];
    }

    return getLogisticsSignalGaps(asn, idocErrors, latestChr);
}

function isAiEligible(ctx) {
    return getEligibilityNotes(ctx).length === 0;
}

function isAwaitingShipmentSignals(notes) {
    return notes.some((note) => note === ELIGIBILITY_NOTE.LOGISTICS_HEADER);
}

/** No ASN/Idoc/CHR → Action Required; other rule-based blocks → Status Report. */
function resolveRuleBasedOutcome(notes) {
    if (isAwaitingShipmentSignals(notes)) {
        return ACTION_REQUIRED_OUTCOME;
    }
    return STATUS_REPORT_OUTCOME;
}

/** Rule-based classification when not AI-eligible; null when ready for LLM. */
function resolveRuleBasedClassification(ctx) {
    const notes = getEligibilityNotes(ctx);
    if (!notes.length) {
        return null;
    }

    const outcome = resolveRuleBasedOutcome(notes);

    return {
        ...outcome,
        confidence: 1,
        isRuleBased: true,
        exception_type: outcome.panel === ACTION_REQUIRED_OUTCOME.panel
            ? 'AWAITING_SHIPMENT_SIGNALS'
            : RULE_BASED_EXCEPTION_TYPE,
        recommendation: formatEligibilityRecommendation(notes),
        evidence: notes.join('. ')
    };
}

function isRuleBasedResult(result) {
    return !!(result && result.isRuleBased);
}

function isUnchangedRuleBasedClassification(existing, aiResult) {
    if (!existing || !aiResult) {
        return false;
    }

    return existing.recommendation === aiResult.recommendation
        && existing.panel === aiResult.panel
        && existing.exception_type === aiResult.exception_type
        && normalizePriority(existing.priority) === normalizePriority(aiResult.priority)
        && parseInt(existing.priority_score, 10) === parseInt(aiResult.priority_score, 10);
}

function normalizeConfidence(value) {
    if (value == null || value === '') {
        return null;
    }
    const n = parseFloat(value);
    if (Number.isNaN(n)) {
        return null;
    }
    return n > 1 ? n / 100 : n;
}

function buildClassificationRecord({ po, enrichedPO, latestChr, aiResult, now }) {
    return {
        po_number: po.po_number,
        line_item: po.line_item,
        material_id: po.material_id,
        supplier_id: po.supplier_id,
        supplier_name: enrichedPO.supplier_name,
        plant: po.plant,
        po_qty: po.po_qty,
        open_qty: (po.po_qty || 0) - (po.gr_qty || 0),
        delivery_date: po.delivery_date,
        ibd_qty: enrichedPO.ibd_qty ?? null,
        chr_status: latestChr?.status || latestChr?.event_type || '',
        exception_type: aiResult.exception_type,
        priority: normalizePriority(aiResult.priority),
        priority_score: parseInt(aiResult.priority_score, 10),
        panel: aiResult.panel,
        recommendation: aiResult.recommendation,
        evidence: aiResult.evidence || '',
        confidence: normalizeConfidence(aiResult.confidence),
        classified_at: now
    };
}

module.exports = {
    isAiEligible,
    resolveRuleBasedClassification,
    isRuleBasedResult,
    isUnchangedRuleBasedClassification,
    buildPartnersByPo,
    buildClassificationRecord
};

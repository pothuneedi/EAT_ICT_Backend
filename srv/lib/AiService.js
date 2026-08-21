'use strict';

const { normalizePriority } = require('./priority-utils');
const { generateText } = require('ai');
const { isReasoningModel, getModelInstance } = require('./llm-client');
const {
    maskForLlm,
    assertPromptSafe,
    restoreClassifierOutput,
    formatPiiBusinessReport,
    logPiiReport
} = require('./pii-redaction');

/** Timestamps render as 2026-07-17T00:00:00.000Z; the model echoes whatever it is given. */
function asDate(value) {
    if (!value) return 'N/A';
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
}

/** Same, but keeps the clock time — it carries meaning on a carrier event. */
function asDateTime(value) {
    if (!value) return 'N/A';
    const text = String(value);
    const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return match ? `${match[1]} ${match[2]} UTC` : text;
}

const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);

/**
 * Flattens the AI SDK's LanguageModelUsage into a stable, provider-agnostic
 * shape we can safely aggregate and persist for usage analytics. Missing values
 * (e.g. reasoning/cached tokens on providers that don't report them) become 0.
 */
function _normalizeUsage(u) {
    if (!u) return null;
    const input = u.inputTokens || 0;
    const output = u.outputTokens || 0;
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: (u.totalTokens != null) ? u.totalTokens : (input + output),
        reasoning_tokens: u.outputTokenDetails?.reasoningTokens || 0,
        cached_input_tokens: u.inputTokenDetails?.cacheReadTokens || 0
    };
}

function formatAsnStatusLabel(code) {
    switch (String(code || '').trim().toUpperCase()) {
        case 'A':
            return 'A (Active / ASN received)';
        case 'B':
            return 'B (In process / in transit)';
        case 'C':
            return 'C (Completed)';
        default:
            return code || 'No ASN';
    }
}

function chrEventText(chr) {
    return String(chr?.event_type || chr?.status || '').trim();
}

function toQty(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function daysUntil(deliveryDate) {
    if (!deliveryDate) {
        return null;
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const deliv = new Date(deliveryDate);
    deliv.setUTCHours(0, 0, 0, 0);
    return Math.ceil((deliv - today) / (1000 * 60 * 60 * 24));
}

/** Plain-language facts derived from input — helps the model match exception rule triggers. */
function buildClassificationContext(po, chr, idocErrors) {
    const hasAsn = Boolean(po.Overall_Status);
    const ibdQty = po.ibd_qty != null ? toQty(po.ibd_qty) : null;
    const chrText = chrEventText(chr);
    const chrLower = chrText.toLowerCase();
    const hasIdocError = (idocErrors || []).some(
        (row) => String(row.status_group || 'ERROR').toUpperCase() !== 'POSTED'
    );
    const daysToDelivery = daysUntil(po.delivery_date);

    const lines = [
        `- ASN on file: ${hasAsn ? 'yes' : 'no'} | Status: ${formatAsnStatusLabel(po.Overall_Status)}`,
        `- CHR tracking: ${chr ? 'yes' : 'no'}${chrText ? ` | Latest event: "${chrText}"` : ''}${chr?.delivery_by_date ? ` | Est delivery: ${asDate(chr.delivery_by_date)}` : ''}`,
        `- IDoc errors (blocking): ${hasIdocError ? 'yes' : 'no'}`,
        `- Days to PO delivery date: ${daysToDelivery != null ? daysToDelivery : 'N/A'}`
    ];

    if (hasIdocError) {
        lines.push('- Note: IDoc errors take priority — resolve before classifying as healthy/in-transit.');
    } else if (hasAsn && chr && /in\s*transit|picked\s*up|load\s*picked|departed|en\s*route/.test(chrLower)) {
        lines.push('- Shipment signal: ASN on file and carrier event indicates in-transit or picked-up.');
    } else if (hasAsn && !chr && ibdQty > 0) {
        lines.push('- Shipment signal: ASN/IBD on file but no CHR carrier event.');
    } else if (!chr && daysToDelivery != null && daysToDelivery < 0) {
        lines.push('- Shipment signal: past PO delivery date with no CHR tracking.');
    }

    return ['Classification context (use to match exception rule triggers):', ...lines].join('\n');
}

function buildSystemPrompt(rules) {
    const sortedRules = [...rules].sort((a, b) => parseInt(a.score, 10) - parseInt(b.score, 10));

    const role = [
        `You are an expert supply chain AI analyst for the Mammoth Brands Inbound Control Tower (ICT).`,
        `Your task is to analyze a Purchase Order (PO) line and determine the correct Exception Rule code, priority, and a highly actionable resolution recommendation.`,
        ``,
        `=== HOW TO PICK THE EXCEPTION RULE ===`,
        `1. Read "Classification context" and all PO/ASN/CHR/IDoc fields in the user message.`,
        `2. Walk the EXCEPTION RULE DEFINITIONS from most urgent (lowest score) to least urgent.`,
        `3. Select the first rule whose Trigger Condition is clearly satisfied by the input.`,
        `4. Copy priority, priority_score, and panel exactly from that rule row — never invent values.`,
        `5. Write recommendation using that rule's Recommendation pattern; replace [placeholders] with real input values.`,
        ``,
        `=== DATA VOCABULARY (use exact values from input) ===`,
        `ASN Overall_Status: A = received/active, B = in process/in transit, C = completed.`,
        `CHR event type/status: raw Navisphere text (e.g. "In Transit", "LOAD PICKED UP", "Delivered") — not normalized codes.`,
        `CHR rows are deduped and sorted by event_time (newest first); use the newest row for current carrier state.`,
        `IBD qty = inbound delivery quantity from ASN (ibd_qty); compare to PO qty and GR qty when rules mention qty mismatch or GR pending.`,
        ``,
        `=== INSTRUCTIONS FOR CONSTRUCTING RECOMMENDATIONS ===`,
        `1. ACTIONABLE & SPECIFIC: Recommendations must be immediately actionable. Avoid vague guidance.`,
        `2. SUPPLIER CONTACTS: Use the supplier name, email, and address exactly as given in the input. If a field shows NO_DATA_FOUND, do not invent it — say that detail is not on file.`,
        `3. CONTEXTUAL NAMES: Always refer to materials and plants by their descriptive names (e.g., material description and plant name) rather than raw codes.`,
        `4. CHR (CARRIER) EVENTS: When CHR event data is provided in the input, use only those fields:`,
        `   - event type/status (raw carrier API text), event time, Navisphere tracking number, load number, order number, delivery dates, destination location, and item SKU/description.`,
        `   - Do NOT invent carrier notes, delay reasons, ports, routes, or legs unless they appear explicitly in the input.`,
        `   - If CHR is absent ("No carrier event"), say tracking is missing and apply the matching exception rule.`,
        `5. IDOC TRANSMISSION ISSUES (PRIORITY WHEN PRESENT): When EDI856 IDoc errors are listed in the input (not "None"):`,
        `   - Treat the IDoc failure as the PRIMARY issue — it often explains why ASN/IBD is missing.`,
        `   - In recommendation: briefly explain the IDoc error in plain language (1 short sentence), then give a specific corrective action (fix master data / correct EDI segment / reprocess or retransmit the ASN).`,
        `   - Quote the actual error message/status from the input; prefer IDOC_FAILURE_* rules when they match.`,
        `   - Do NOT lead with "awaiting ASN" or missing carrier tracking when IDoc errors are present — focus on resolving the IDoc first.`,
        `6. EVIDENCE-BASED ONLY: Never assume quantities, statuses, BOL values, or dates that are not in the input.`,
        `7. HIGHLIGHTING: Wrap key entities in markdown bold **...** (supplier name, email, address, material description, dates, plant names, BOL/tracking numbers, error codes). Do NOT use HTML tags.`,
        `8. STRICT ANTI-HALLUCINATION: Do NOT invent, assume, or extrapolate. If a record is missing (e.g. No ASN, No carrier event, or unregistered supplier email), do not create mock carrier notes, delay reasons, tracking IDs, or fake names. Factual accuracy is paramount; state what is missing and focus on the immediate action needed to retrieve it.`,
        ``,
        `=== CONFIDENCE SCORING ===`,
        `- confidence (0.0–1.0) reflects how clearly the evidence supports your exception_type — not urgency.`,
        `- Strong match: 0.80–0.95. Minor ambiguity: 0.65–0.79. Below 0.65 only when genuinely uncertain or key data is missing.`,
        `- Do not default to ~0.5 when the input clearly supports your classification.`,
        ``,
        `Always output a single, valid JSON object strictly matching the schema.`
    ].join('\n');

    const rulesSection = [
        `\n\n=== EXCEPTION RULE DEFINITIONS (most urgent first) ===`,
        `Each rule has: CODE | Priority (score) | Panel | Trigger Condition | Recommendation Pattern`,
        ...sortedRules.map(r =>
            `[${r.exception_type}]\n  Priority: ${r.priority} (score ${r.score}) → panel: ${r.panel}\n  Triggers when: ${r.trigger_condition}\n  Recommendation pattern: ${r.ai_recommendation_pattern}`
        )
    ].join('\n');

    const schema = `\n\n=== OUTPUT SCHEMA (strict) ===
Return ONLY a single valid JSON object — no markdown fences, no explanation:
{
  "exception_type" : "<exact CODE from EXCEPTION RULE DEFINITIONS above>",
  "priority"       : "<HIGH | MEDIUM | LOW — copy from the matched rule; do not invent>",
  "priority_score" : <integer — copy the matched rule's score exactly (lower = more urgent; rules use 1–9)>,
  "panel"          : "<ACTION_REQUIRED | STATUS_REPORT — copy from the matched rule>",
  "recommendation" : "<follow the matched rule's Recommendation pattern; fill [placeholders] with input data>",
  "evidence"       : "<brief factual reason why this rule was triggered>",
  "confidence"     : <number 0.0–1.0 — certainty that exception_type is correct given the input evidence>
}

Field rules:
- Pick exactly one exception_type, then set priority, priority_score, and panel from that same rule row.
- Do NOT invent priority labels or scores outside the rule definitions.
- recommendation MUST follow the matched rule's Recommendation pattern structure (same intent; substitute real values for placeholders like [est_delivery]).
- confidence is independent of priority_score. Use CONFIDENCE SCORING above; strong evidence should be 0.80+ unless truly ambiguous.`;

    return [role, rulesSection, schema].join('');
}

const MAX_IDOC_ERRORS_IN_PROMPT = 3;
const MAX_IDOC_MSG_LENGTH = 250;

/**
 * Formats EDI856 IDoc errors as a compact prompt section.
 * Shows the newest MAX_IDOC_ERRORS_IN_PROMPT rows; long error text is truncated.
 */
function buildIdocSection(idocErrors) {
    if (!idocErrors || idocErrors.length === 0) {
        return `EDI856 IDoc Errors: None`;
    }

    const shown = idocErrors.slice(0, MAX_IDOC_ERRORS_IN_PROMPT);
    const lines = shown.map((e) => {
        const msg = (e.error_msg || e.status_text || 'No message')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_IDOC_MSG_LENGTH);
        const when = e.status_logdat || e.idoc_credat || 'unknown date';
        return `  - IDoc ${e.docnum} [status ${e.status || '?'} | ${e.status_group || 'ERROR'}] ${when}: ${msg}`;
    });

    const header = idocErrors.length > shown.length
        ? `EDI856 IDoc Errors (${shown.length} most recent of ${idocErrors.length}):`
        : `EDI856 IDoc Errors (${idocErrors.length}):`;

    return [header, ...lines].join('\n');
}

function formatChrSection(chrEvents) {
    if (!chrEvents?.length) {
        return 'CHR (carrier) events: None';
    }

    const lines = ['CHR (carrier) events (deduped, newest first):'];

    chrEvents.forEach((chr) => {
        lines.push(
            `- ${chr.status || chr.event_type || 'N/A'} | Event: ${asDateTime(chr.event_time)} | ` +
            `Qty: ${chr.actual_quantity ?? 'N/A'} | SKU: ${chr.sku_number || 'N/A'} | ` +
            `Tracking #: ${chr.navisphere_tracking_number || 'N/A'} | Load #: ${chr.load_number || 'N/A'}`
        );
    });

    return lines.join('\n');
}

function buildUserPrompt(po, idocErrors, chrEvents) {
    const latestChr = chrEvents?.[0] || null;
    return [
        `Classify the following PO line:`,
        ``,
        `PO: ${po.po_number}/${po.line_item} | Supplier: ${po.supplier_name} (ID: ${po.supplier_id || 'N/A'}, Email: ${po.supplier_email || 'N/A'}, Address: ${po.supplier_address || 'N/A'})`,
        `Material: ${po.material_id} (${po.material_description || 'No description'}) | Plant: ${po.plant} (${po.plant_name || 'No plant name'})`,
        `PO Qty (po_qty): ${po.po_qty} ${po.po_uom} | GR Qty (gr_qty): ${po.gr_qty} | IBD Qty (ibd_qty): ${po.ibd_qty ?? 'N/A'} | Ship Date: ${asDate(po.ship_date)} | Delivery Date: ${asDate(po.delivery_date)} | Unit Price: ${po.net_price || 'N/A'} ${po.currency || 'USD'} | Today: ${new Date().toISOString().slice(0, 10)}`,
        `ASN Status: ${formatAsnStatusLabel(po.Overall_Status)} | BOL (ASN): ${po.Bill_of_Lading || 'N/A'}`,
        formatChrSection(chrEvents),
        buildIdocSection(idocErrors),
        ``,
        buildClassificationContext(po, latestChr, idocErrors)
    ].join('\n');
}

function parseJson(text) {
    const clean = text.trim().replace(/^```(json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
    return JSON.parse(clean);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classifies a PO line against exception rules using the configured LLM.
 *
 * Throws on configuration or provider errors.
 * Returns null on transient API failures (timeout, rate-limit, etc.) so the caller can skip the PO.
 *
 * @param {object}      po         Enriched PO line row
 * @param {Array}       rules      ExceptionRules from DB
 * @param {object}      llmConfig  { provider, model_id, api_key, temperature, max_tokens, top_p, system_prompt }
 * @param {Array}       idocErrors EDI856 IDoc errors for this PO line (newest first, may be empty)
 * @param {object}      [options]  { piiLog, chrEvents } — deduped CHR rows, newest first
 * @returns {Promise<object|null>}
 */
async function classify(po, rules, llmConfig, idocErrors = [], options = {}) {
    const { provider, model_id, api_key, temperature, max_tokens, top_p, system_prompt } = llmConfig;

    // Config-level errors — throw immediately, do not skip
    if (!provider) throw new Error('[AiService] Missing: provider');
    if (!model_id) throw new Error(`[AiService] Missing: model_id for provider "${provider}"`);
    if (!api_key) throw new Error(`[AiService] Missing: api_key for provider "${provider}"`);
    if (!rules?.length) throw new Error('[AiService] Missing: ExceptionRules (empty array)');

    const temp = parseFloat(temperature);
    const tokens = parseInt(max_tokens, 10);
    const topP = parseFloat(top_p);

    if (isNaN(temp)) throw new Error(`[AiService] Invalid temperature: "${temperature}"`);
    if (isNaN(tokens)) throw new Error(`[AiService] Invalid max_tokens: "${max_tokens}"`);
    if (isNaN(topP)) throw new Error(`[AiService] Invalid top_p: "${top_p}"`);

    const poLabel = `${po.po_number}/${po.line_item}`;
    const piiLog = options.piiLog;

    const model = getModelInstance(provider, model_id, api_key);
    const sysPrompt = buildSystemPrompt(rules);
    const finalPrompt = system_prompt ? `${system_prompt}\n\n${sysPrompt}` : sysPrompt;

    // Supplier contact fields are masked for the provider and restored after the call.
    const { safe, map, secrets } = maskForLlm(po);
    const prompt = buildUserPrompt(safe, idocErrors, options.chrEvents || []);
    assertPromptSafe(prompt, secrets, poLabel);

    const genOptions = {
        model,
        system: finalPrompt,
        prompt,
        maxTokens: tokens,
        maxRetries: 0
    };
    // Sampling params are only valid for non-reasoning models
    if (!isReasoningModel(provider, model_id)) {
        genOptions.temperature = temp;
        genOptions.topP = topP;
    }

    try {
        const response = await Promise.race([
            generateText(genOptions),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`AI timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
            )
        ]);

        const text = response?.text?.trim();
        if (!text) throw new Error('AI SDK returned an empty response.');

        const result = parseJson(text);
        const restored = restoreClassifierOutput(result, map, poLabel);
        logPiiReport(formatPiiBusinessReport({
            poLabel,
            safe,
            recommendation: restored.recommendation
        }), piiLog);

        restored.priority = normalizePriority(restored.priority);
        // Attach normalized token usage for this call. Downstream aggregates it
        // per run; the exceptions record is built from explicit fields, so this
        // internal `_usage` key never leaks into persisted classification data.
        restored._usage = _normalizeUsage(response?.usage);
        console.log(`[AiService] ${po.po_number}/${po.line_item} → ${restored.exception_type} (${restored.priority}, confidence: ${restored.confidence})`);
        return restored;

    } catch (err) {
        console.error(`[AiService] ${po.po_number}/${po.line_item} failed (${model_id} / ${provider}): ${err.message}`);
        throw err;
    }
}

module.exports = { classify };

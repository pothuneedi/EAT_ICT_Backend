'use strict';

require('dotenv').config();
const { generateText } = require('ai');

const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);

// ─── System Prompt (cached per process lifecycle) ─────────────────────────────

let _systemPrompt = null;

function buildSystemPrompt(rules) {
    if (_systemPrompt) return _systemPrompt;

    const role = [
        `You are an expert supply chain AI for Mammoth Brands Inbound Control Tower (ICT).`,
        `Analyze the given Purchase Order (PO) line against the Exception Rules and determine which rule applies.`,
        `Some PO lines include EDI856 IDoc transmission errors (raw SAP EDIDC/EDIDS failures for the inbound ASN).`,
        `When IDoc errors are present, weigh them heavily — they often explain WHY an ASN is missing or stuck.`,
        `Always return a single, valid JSON object matching the requested schema.`
    ].join('\n');

    const rulesSection = [
        `\n\n=== EXCEPTION RULE DEFINITIONS ===`,
        `Each rule has: CODE | Priority (score) | Panel | Trigger Condition | Recommendation Pattern`,
        ...rules.map(r =>
            `[${r.exception_type}]\n  Priority: ${r.priority} (score ${r.score}) → panel: ${r.panel}\n  Triggers when: ${r.trigger_condition}\n  Recommendation pattern: ${r.ai_recommendation_pattern}`
        )
    ].join('\n');

    const schema = `\n\n=== OUTPUT SCHEMA (strict) ===
Return ONLY a single valid JSON object — no markdown fences, no explanation:
{
  "exception_type" : "<one of the rule codes above>",
  "priority"       : "<High | Medium | Low>",
  "priority_score" : <integer matching the rule score>,
  "panel"          : "<ACTION_REQUIRED | STATUS_REPORT>",
  "recommendation" : "<specific, actionable 1-3 sentence recommendation>",
  "evidence"       : "<brief factual reason why this rule was triggered>",
  "confidence"     : <0.0 to 1.0>
}`;

    _systemPrompt = [role, rulesSection, schema].join('');
    return _systemPrompt;
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

function buildUserPrompt(po, chr, idocErrors) {
    return [
        `Classify the following PO line:`,
        ``,
        `PO: ${po.po_number}/${po.line_item} | Supplier: ${po.supplier_name} | Material: ${po.material_id} | Plant: ${po.plant}`,
        `PO Qty: ${po.po_qty} ${po.po_uom} | GR Qty: ${po.gr_qty} | Delivery Date: ${po.delivery_date} | Today: ${new Date().toISOString().slice(0, 10)}`,
        `ASN Status: ${po.Overall_Status || 'No ASN'} | IBD Qty: ${po.Delivery_Quantity ?? 'N/A'} | BOL (ASN): ${po.Bill_of_Lading || 'N/A'}`,
        `CHR Status: ${chr?.status || 'No carrier event'} | CHR Ref: ${chr?.chr_ref || 'N/A'} | BOL (Carrier): ${chr?.bol_chr || 'N/A'}`,
        buildIdocSection(idocErrors)
    ].join('\n');
}

function parseJson(text) {
    const clean = text.trim().replace(/^```(json)?\s*\n?/, '').replace(/\n?\s*```$/, '');
    return JSON.parse(clean);
}

// ─── Model Factory ────────────────────────────────────────────────────────────

/**
 * Reasoning models (GPT-5 family, o-series, gpt-oss) do not support sampling
 * parameters like temperature / top_p — passing them triggers SDK warnings
 * and the values are silently ignored anyway.
 */
function isReasoningModel(provider, modelId) {
    return provider.toUpperCase() === 'OPENAI' && /^(gpt-5|o\d|gpt-oss)/i.test(modelId);
}

function getModelInstance(provider, modelId, apiKey) {
    if (!provider) throw new Error('LLM provider is required.');
    if (!modelId)  throw new Error(`Model ID is required for provider "${provider}".`);
    if (!apiKey)   throw new Error(`API key is required for provider "${provider}".`);

    switch (provider.toUpperCase()) {
        case 'OPENAI': {
            const { createOpenAI } = require('@ai-sdk/openai');
            return createOpenAI({ apiKey })(modelId);
        }
        case 'GEMINI':
        case 'GOOGLE': {
            const { createGoogle } = require('@ai-sdk/google');
            return createGoogle({ apiKey })(modelId);
        }
        case 'ANTHROPIC': {
            const { createAnthropic } = require('@ai-sdk/anthropic');
            return createAnthropic({ apiKey })(modelId);
        }
        default:
            throw new Error(`Unsupported LLM provider: "${provider}". Supported: OPENAI, GEMINI, ANTHROPIC.`);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classifies a PO line against exception rules using the configured LLM.
 *
 * Throws on configuration or provider errors.
 * Returns null on transient API failures (timeout, rate-limit, etc.) so the caller can skip the PO.
 *
 * @param {object}      po         Enriched PO line row
 * @param {object|null} chr        Latest CHR carrier event
 * @param {Array}       rules      ExceptionRules from DB
 * @param {object}      llmConfig  { provider, model_id, api_key, temperature, max_tokens, top_p, system_prompt }
 * @param {Array}       idocErrors EDI856 IDoc errors for this PO line (newest first, may be empty)
 * @returns {Promise<object|null>}
 */
async function classify(po, chr, rules, llmConfig, idocErrors = []) {
    const { provider, model_id, api_key, temperature, max_tokens, top_p, system_prompt } = llmConfig;

    // Config-level errors — throw immediately, do not skip
    if (!provider)  throw new Error('[AiService] Missing: provider');
    if (!model_id)  throw new Error(`[AiService] Missing: model_id for provider "${provider}"`);
    if (!api_key)   throw new Error(`[AiService] Missing: api_key for provider "${provider}"`);
    if (!rules?.length) throw new Error('[AiService] Missing: ExceptionRules (empty array)');

    const temp   = parseFloat(temperature);
    const tokens = parseInt(max_tokens, 10);
    const topP   = parseFloat(top_p);

    if (isNaN(temp))   throw new Error(`[AiService] Invalid temperature: "${temperature}"`);
    if (isNaN(tokens)) throw new Error(`[AiService] Invalid max_tokens: "${max_tokens}"`);
    if (isNaN(topP))   throw new Error(`[AiService] Invalid top_p: "${top_p}"`);

    const model = getModelInstance(provider, model_id, api_key);
    const sysPrompt = buildSystemPrompt(rules);
    const finalPrompt = system_prompt ? `${system_prompt}\n\n${sysPrompt}` : sysPrompt;

    const genOptions = {
        model,
        system: finalPrompt,
        prompt: buildUserPrompt(po, chr, idocErrors),
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
        console.log(`[AiService] ${po.po_number}/${po.line_item} → ${result.exception_type} (${result.priority}, confidence: ${result.confidence})`);
        return result;

    } catch (err) {
        console.error(`[AiService] ${po.po_number}/${po.line_item} failed (${model_id} / ${provider}): ${err.message}`);
        throw err;
    }
}

/**
 * Clears the cached system prompt — call this after exception rules change.
 */
function clearPromptCache() {
    _systemPrompt = null;
}

module.exports = { classify, clearPromptCache };

'use strict';

const cds = require('@sap/cds');
const { generateText } = require('ai');
const { getModelInstance } = require('../lib/llm-client');
const { resolveChatLlmConfig } = require('../lib/llm-credentials');
const { ensureCatalog, buildChatSchemaPrompt } = require('../lib/chat-schema');

const TEXT_TYPES = {
    TRIGGER_CONDITION: 'TRIGGER_CONDITION',
    AI_RECOMMENDATION_PATTERN: 'AI_RECOMMENDATION_PATTERN'
};
const MAX_EXAMPLE_RULES = 10;

function stripMarkdownFences(text) {
    if (!text) {
        return '';
    }
    return String(text)
        .replace(/^```[\w-]*\s*\n?/, '')
        .replace(/\n?```\s*$/, '')
        .trim();
}

function buildSystemPrompt(textType, schemaPrompt, formattedExamples, oContext) {
    const instruction = textType === TEXT_TYPES.TRIGGER_CONDITION
        ? 'Optimize the user\'s draft trigger condition into a highly specific, logic-oriented trigger statement. Focus on exact fields (e.g., delivery_date, open_qty, chr_events, idoc_errors) and conditions. Keep it concise and professional. Return ONLY the enhanced trigger condition statement itself. Do NOT include prefixes like "Trigger:", "Rule:", "Recommendation:", or bullet points. Output ONLY the raw optimized string.'
        : 'Optimize the user\'s draft recommendation pattern into a clean, actionable prompt template. Highlight key placeholders (supplier name, email, material description, plant name, BOL/tracking numbers) using markdown bold (**...**). Return ONLY the enhanced pattern text (1-3 sentences) itself. Do NOT include prefixes like "Recommendation:", "Rule:", "Trigger:", or bullet points. Output ONLY the raw optimized string.';

    const contextSection = oContext && Object.keys(oContext).length ? [
        '=== CURRENT RULE CONTEXT (Optimize the field value specifically for this rule context) ===',
        `Target Exception Type/Code: ${oContext.exception_type || '(none yet)'}`,
        `Target Priority: ${oContext.priority || '(none yet)'} (score: ${oContext.score || '5'})`,
        `Target Panel: ${oContext.panel || 'ACTION_REQUIRED'}`,
        ''
    ].join('\n') : '';

    return [
        'You are an expert exception rules compiler for the Mammoth Brands Inbound Control Tower (ICT).',
        instruction,
        'Do not wrap in quotes, markdown fences, or add comments.',
        '',
        contextSection,
        '=== DATABASE SCHEMA REFERENCE (Use exact field names from here) ===',
        schemaPrompt,
        '',
        '=== EXISTING EXAMPLES FOR REFERENCE (Match this style, format, and precision) ===',
        formattedExamples
    ].join('\n');
}

async function handleEnhanceExceptionRuleContent(req) {
    const { textType, text, ruleContext } = req.data;
    const draft = String(text || '').trim();

    if (!draft) {
        return req.reject(400, 'text is required');
    }
    if (!Object.values(TEXT_TYPES).includes(textType)) {
        return req.reject(400, 'textType must be TRIGGER_CONDITION or AI_RECOMMENDATION_PATTERN');
    }

    try {
        const llmConfig = await resolveChatLlmConfig();
        const model = getModelInstance(llmConfig.provider, llmConfig.model_id, llmConfig.api_key);

        await ensureCatalog();
        const schemaPrompt = buildChatSchemaPrompt(100);

        let oContext = {};
        if (ruleContext) {
            try {
                oContext = typeof ruleContext === 'string' ? JSON.parse(ruleContext) : ruleContext;
            } catch (e) {
                oContext = {};
            }
        }

        const existingRules = await cds.run(
            SELECT.from('ict.exception_rules')
                .columns('exception_type', 'trigger_condition', 'ai_recommendation_pattern')
                .limit(MAX_EXAMPLE_RULES)
        );
        
        const formattedExamples = existingRules.map((rule) => {
            return textType === TEXT_TYPES.TRIGGER_CONDITION 
                ? rule.trigger_condition 
                : rule.ai_recommendation_pattern;
        }).join('\n');

        const { text: enhancedText } = await generateText({
            model,
            system: buildSystemPrompt(textType, schemaPrompt, formattedExamples, oContext),
            prompt: draft,
            temperature: 0.2
        });

        const cleaned = stripMarkdownFences(enhancedText);
        if (!cleaned) {
            return req.reject(500, 'AI enhancement returned empty content');
        }

        return { enhancedText: cleaned };
    } catch (err) {
        console.error('[enhanceExceptionRuleContent] Error enhancing text:', err);
        return req.reject(500, `AI enhancement failed: ${err.message}`);
    }
}

module.exports = { handleEnhanceExceptionRuleContent };

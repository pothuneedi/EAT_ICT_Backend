'use strict';

const { ToolLoopAgent, isStepCount } = require('ai');
const { getModelInstance } = require('./llm-client');
const { resolveChatLlmConfig } = require('./llm-credentials');
const {
    prepareChatPii,
    wrapChatTools,
    restoreAssistantResponse,
    restoreToolInvocations
} = require('./pii-guard/chat-pii');
const { isPiiDebugEnabled } = require('./pii-redaction');
const {
    parseUiMessages,
    toModelMessages,
    mapToolInvocations,
    buildAssistantMessage
} = require('./chat-messages');
const { ensureCatalog, buildChatSchemaPrompt } = require('./chat-schema');
const { MAX_QUERY_ROWS } = require('./chat-tools');

const TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '60000', 10);
const MAX_STEPS = parseInt(process.env.CHAT_MAX_STEPS || '6', 10);

function buildSystemPrompt(context) {
    const lines = [
        'You are the Mammoth Brands Inbound Control Tower (ICT) assistant.',
        'Help planners and buyers with purchase orders, exceptions, shipments, carrier events, and EDI856 IDoc issues.',
        '',
        'Behavior:',
        '- Follow user intent. Users may use typos, shorthand, or incomplete words — infer meaning and query ICT.',
        '- Never invent data. Use tool results only.',
        '- If the first query fails (0 rows, unknown column, or link error): retry 2–3 times with whereLike, a linked master table, or a different field from the schema before asking the user.',
        '- Large tables: use countOnly for totals; use limit for samples. When truncated is true, state the full total.',
        `- Server cap: max_rows_per_query = ${MAX_QUERY_ROWS}.`,
        '',
        'Tools:',
        '- getIctDashboardSummary — summary/overview/KPI totals only.',
        '- queryIctData — everything else (lists, filters, details).',
        '',
        'Querying:',
        '- Follow filter rules in the ICT schema below (where, whereLike, linked, operator objects).',
        '- Use linked + whereLike for supplier/material names; codes and comparisons go in where.',
        '- Refer to PO lines as PO number/line item (e.g. 4500012345/00010).',
        `- Today: ${new Date().toISOString().slice(0, 10)}`,
        '',
        'Formatting:',
        '- If list details are on new lines or separated by blank lines, ordered lists (1., 2.) reset to 1 in markdown.',
        '- To prevent this, either: use bold titles for item headers (e.g., "**1. PO: 4500012345**" or "### 1. PO: 4500012345"), or indent all detail lines under each numbered item with 4 spaces.',
        '',
        buildChatSchemaPrompt(MAX_QUERY_ROWS)
    ];

    if (context?.pageTitle) {
        lines.push('', `User is currently viewing: ${context.pageTitle}`);
    }
    if (context?.poNumber) {
        lines.push(`UI selection (optional context): ${context.poNumber}${context.lineItem ? `/${context.lineItem}` : ''}`);
    }

    return lines.join('\n');
}

function parseContext(raw) {
    if (!raw) {
        return null;
    }

    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}

function buildAssistantFallbackText(toolInvocations = []) {
    if (!toolInvocations.some((invocation) => invocation.state === 'call')) {
        return '';
    }
    return 'I could not complete every lookup. Please try again.';
}

async function chat({ messages, context }) {
    await ensureCatalog();
    const uiMessages = parseUiMessages(messages);
    const pii = prepareChatPii(uiMessages);
    const llmConfig = await resolveChatLlmConfig();
    const model = getModelInstance(llmConfig.provider, llmConfig.model_id, llmConfig.api_key);
    const tools = wrapChatTools(pii.piiMap);

    const instructions = [buildSystemPrompt(parseContext(context))];
    if (pii.piiSystemPrompt) {
        instructions.push(pii.piiSystemPrompt);
    }

    const modelMessages = await toModelMessages(pii.uiMessages);
    if (pii.enabled && isPiiDebugEnabled()) {
        console.log('[ChatPII] model messages:', modelMessages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content.slice(0, 300) : m.content
        })));
    }

    const agent = new ToolLoopAgent({
        model,
        instructions: instructions.join('\n\n'),
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        maxRetries: 2,
        temperature: 0.2
    });

    const result = await agent.generate({
        messages: modelMessages,
        timeout: TIMEOUT_MS
    });

    const toolInvocations = restoreToolInvocations(
        mapToolInvocations(result.toolCalls, result.content),
        pii.piiMap
    );
    const rawContent = result.text?.trim()
        || buildAssistantFallbackText(toolInvocations);
    const content = restoreAssistantResponse(rawContent, pii.piiMap);

    if (!content) {
        throw new Error('The assistant returned an empty response.');
    }

    const assistantMessage = buildAssistantMessage(content, toolInvocations);
    if (pii.enabled && rawContent && rawContent !== content) {
        assistantMessage.contentRedacted = rawContent;
    }

    return {
        messages: JSON.stringify([
            ...(pii.displayMessages || uiMessages),
            assistantMessage
        ])
    };
}

function chatWithError({ messages, errorMessage }) {
    let uiMessages = [];

    try {
        uiMessages = parseUiMessages(messages);
    } catch {
        // Client may send an invalid payload when the request already failed.
    }

    return {
        messages: JSON.stringify([
            ...uiMessages,
            buildAssistantMessage(errorMessage)
        ])
    };
}

module.exports = { chat, chatWithError };

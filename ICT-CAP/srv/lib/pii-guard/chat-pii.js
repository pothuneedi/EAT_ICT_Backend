'use strict';

const { tool } = require('ai');
const { anonymizePII } = require('./pii');
const {
    extractTokensFromUiMessages,
    buildPIISystemPrompt,
    processTextForDisplay
} = require('./pii-llm');
const { createChatTools } = require('../chat-tools');
const { isPiiDebugEnabled } = require('../pii-redaction');

const LOG_PREFIX = '[ChatPII]';

function truncateLog(text, max = 300) {
    if (typeof text !== 'string' || !text) {
        return '(none)';
    }
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function summarizePiiMap(piiMap) {
    return Object.keys(piiMap).map((token) => ({
        token,
        valuePreview: truncateLog(piiMap[token], 40)
    }));
}

function logChatPii(event, payload) {
    if (!isPiiDebugEnabled()) {
        return;
    }
    console.log(`${LOG_PREFIX} ${event}`, payload);
}

function logMessageRedaction(originalMessages, redactedMessages, piiMap) {
    if (!isPiiDebugEnabled()) {
        return;
    }

    console.log(`${LOG_PREFIX} ── message redaction ──`);
    originalMessages.forEach((message, index) => {
        const redacted = redactedMessages[index];
        console.log(`${LOG_PREFIX} [${index}] ${message.role} IN : ${truncateLog(message.content)}`);
        if (redacted?.content && redacted.content !== message.content) {
            console.log(`${LOG_PREFIX} [${index}] ${message.role} OUT: ${truncateLog(redacted.content)}`);
        } else if (redacted?.content) {
            console.log(`${LOG_PREFIX} [${index}] ${message.role} OUT: (unchanged)`);
        }
    });

    const tokens = summarizePiiMap(piiMap);
    if (tokens.length) {
        console.log(`${LOG_PREFIX} tokens (${tokens.length}):`, tokens);
    } else {
        console.log(`${LOG_PREFIX} tokens: none detected`);
    }
}

function logAssistantRestore(rawText, restoredText) {
    if (!isPiiDebugEnabled()) {
        return;
    }
    console.log(`${LOG_PREFIX} ── assistant response ──`);
    console.log(`${LOG_PREFIX} LLM raw     : ${truncateLog(rawText)}`);
    console.log(`${LOG_PREFIX} UI restored: ${truncateLog(restoredText)}`);
}

function isChatPiiEnabled() {
    if (process.env.CHAT_PII === 'false' || process.env.CHAT_PII === '0') {
        return false;
    }
    return true;
}

function nextTokenStartIndex(piiMap) {
    let max = 0;
    for (const token of Object.keys(piiMap)) {
        const match = token.match(/_(\d+)\]$/);
        if (match) {
            max = Math.max(max, parseInt(match[1], 10) + 1);
        }
    }
    return max;
}

function mergePiiMap(piiMap, partial) {
    Object.assign(piiMap, partial);
}

function redactText(text, piiMap) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    const { redactedText, piiMap: partial } = anonymizePII(text, nextTokenStartIndex(piiMap));
    mergePiiMap(piiMap, partial);
    return redactedText;
}

function redactDeep(value, piiMap) {
    if (value == null) {
        return value;
    }
    if (typeof value === 'string') {
        return redactText(value, piiMap);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactDeep(entry, piiMap));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = redactDeep(entry, piiMap);
        }
        return out;
    }
    return value;
}

function restoreDeep(value, piiMap) {
    if (value == null) {
        return value;
    }
    if (typeof value === 'string') {
        return processTextForDisplay(value, piiMap);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => restoreDeep(entry, piiMap));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = restoreDeep(entry, piiMap);
        }
        return out;
    }
    return value;
}

function redactUiMessages(uiMessages) {
    const piiMap = {};
    const messages = uiMessages.map((message) => {
        const copy = { ...message };
        if (copy.content) {
            copy.content = redactText(copy.content, piiMap);
        }
        if (copy.toolInvocations?.length) {
            copy.toolInvocations = copy.toolInvocations.map((invocation) => ({
                ...invocation,
                args: redactDeep(invocation.args, piiMap),
                result: invocation.result != null
                    ? redactDeep(invocation.result, piiMap)
                    : invocation.result
            }));
        }
        return copy;
    });
    return { messages, piiMap };
}

function wrapChatTools(piiMap) {
    const baseTools = createChatTools();
    const wrapped = {};

    for (const [name, definition] of Object.entries(baseTools)) {
        const execute = definition.execute.bind(definition);
        wrapped[name] = tool({
            description: definition.description,
            inputSchema: definition.inputSchema ?? definition.parameters,
            execute: async (args) => {
                const raw = await execute(args);
                const redacted = redactDeep(raw, piiMap);
                if (isPiiDebugEnabled()) {
                    logChatPii(`tool:${name}`, {
                        args: truncateLog(JSON.stringify(args), 120),
                        raw: truncateLog(JSON.stringify(raw), 200),
                        redacted: truncateLog(JSON.stringify(redacted), 200)
                    });
                }
                return redacted;
            }
        });
    }

    return wrapped;
}

function prepareChatPii(uiMessages) {
    if (!isChatPiiEnabled()) {
        logChatPii('disabled', { reason: 'CHAT_PII=false' });
        return {
            enabled: false,
            uiMessages,
            displayMessages: uiMessages,
            piiMap: {},
            piiSystemPrompt: ''
        };
    }

    const { messages, piiMap } = redactUiMessages(uiMessages);
    const activeTokens = extractTokensFromUiMessages(messages);
    const displayMessages = uiMessages.map((message, index) => {
        const redacted = messages[index];
        if (redacted?.content && redacted.content !== message.content) {
            return { ...message, contentRedacted: redacted.content };
        }
        return message;
    });

    logMessageRedaction(uiMessages, messages, piiMap);
    if (activeTokens.length) {
        logChatPii('active tokens', activeTokens);
    }

    return {
        enabled: true,
        uiMessages: messages,
        displayMessages,
        piiMap,
        piiSystemPrompt: buildPIISystemPrompt(activeTokens)
    };
}

function restoreAssistantResponse(text, piiMap) {
    if (!isChatPiiEnabled() || !text) {
        return text;
    }
    const restored = processTextForDisplay(text, piiMap);
    logAssistantRestore(text, restored);
    return restored;
}

function restoreToolInvocations(toolInvocations, piiMap) {
    if (!isChatPiiEnabled() || !toolInvocations?.length) {
        return toolInvocations;
    }
    return toolInvocations.map((invocation) => ({
        ...invocation,
        args: restoreDeep(invocation.args, piiMap),
        result: invocation.result != null
            ? restoreDeep(invocation.result, piiMap)
            : invocation.result
    }));
}

module.exports = {
    isChatPiiEnabled,
    prepareChatPii,
    wrapChatTools,
    restoreAssistantResponse,
    restoreToolInvocations
};

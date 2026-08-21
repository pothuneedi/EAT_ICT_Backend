'use strict';

const { convertToModelMessages } = require('ai');

const ALLOWED_ROLES = new Set(['user', 'assistant', 'system', 'data']);
const MODEL_ROLES = new Set(['user', 'assistant']);

function createMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeClientToolInvocation(raw) {
    if (!raw?.toolCallId || !raw?.toolName) {
        return null;
    }

    const invocation = {
        state: raw.state === 'call' ? 'call' : 'result',
        toolCallId: String(raw.toolCallId),
        toolName: String(raw.toolName),
        args: raw.args ?? {}
    };

    if (invocation.state === 'result' && 'result' in raw) {
        invocation.result = cloneJson(raw.result);
    }

    return invocation;
}

function parseUiMessages(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('messages must be a non-empty JSON array.');
    }

    return parsed.map((message, index) => {
        if (!message || !ALLOWED_ROLES.has(message.role)) {
            throw new Error(`messages[${index}].role must be one of: user, assistant, system, data.`);
        }
        if (typeof message.content !== 'string') {
            throw new Error(`messages[${index}].content must be a string.`);
        }
        if (message.role === 'user' && !message.content.trim()) {
            throw new Error(`messages[${index}].content is required for user messages.`);
        }

        const normalized = {
            id: message.id || createMessageId(),
            role: message.role,
            content: message.content.trim()
        };

        if (message.role === 'assistant' && Array.isArray(message.toolInvocations)) {
            const toolInvocations = message.toolInvocations
                .map(normalizeClientToolInvocation)
                .filter(Boolean);
            if (toolInvocations.length) {
                normalized.toolInvocations = toolInvocations;
            }
        }

        if (typeof message.contentRedacted === 'string' && message.contentRedacted) {
            normalized.contentRedacted = message.contentRedacted;
        }

        return normalized;
    });
}

async function toModelMessages(uiMessages) {
    const sdkUiMessages = uiMessages
        .filter((message) => MODEL_ROLES.has(message.role))
        .map((message) => ({
            role: message.role,
            parts: [{ type: 'text', text: message.content }]
        }));

    return convertToModelMessages(sdkUiMessages, { ignoreIncompleteToolCalls: true });
}

function mapToolInvocations(toolCalls = [], content = []) {
    const outputsById = new Map();
    for (const part of content) {
        if (part?.type === 'tool-result' || part?.type === 'tool-error') {
            outputsById.set(part.toolCallId, part);
        }
    }

    return toolCalls
        .filter((call) => call?.toolCallId)
        .map((call) => {
            const base = {
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: cloneJson(call.input ?? {})
            };
            const matched = outputsById.get(call.toolCallId);

            if (matched?.type === 'tool-result') {
                return { ...base, state: 'result', result: cloneJson(matched.output) };
            }
            if (matched?.type === 'tool-error') {
                return {
                    ...base,
                    state: 'result',
                    result: {
                        error: matched.error != null ? String(matched.error) : 'Tool execution failed.'
                    }
                };
            }
            if (call.invalid) {
                return {
                    ...base,
                    state: 'result',
                    result: {
                        error: call.error != null ? String(call.error) : 'Invalid tool input.'
                    }
                };
            }
            return { ...base, state: 'call' };
        });
}

function buildAssistantMessage(text, toolInvocations) {
    const message = {
        id: createMessageId(),
        role: 'assistant',
        content: text || ''
    };

    if (toolInvocations?.length) {
        message.toolInvocations = toolInvocations;
    }

    return message;
}

module.exports = {
    parseUiMessages,
    toModelMessages,
    mapToolInvocations,
    buildAssistantMessage
};

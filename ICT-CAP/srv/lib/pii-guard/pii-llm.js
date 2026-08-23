'use strict';

const { deAnonymizePII } = require('./pii');

const TOKEN_REGEX = /\[REDACTED_[A-Z0-9_]+_\d+\]/g;
const TOKEN_PARSE = /^\[REDACTED_(.+)_(\d+)\]$/;
const LIBRARY_TAG_REGEX = /<([A-Z_]+)>/g;

function extractTokensFromUiMessages(messages) {
    const tokens = new Set();
    for (const message of messages) {
        if (message.content) {
            for (const match of message.content.matchAll(TOKEN_REGEX)) {
                tokens.add(match[0]);
            }
        }
        for (const invocation of message.toolInvocations || []) {
            const chunks = [
                JSON.stringify(invocation.args || {}),
                JSON.stringify(invocation.result ?? '')
            ];
            for (const chunk of chunks) {
                for (const match of chunk.matchAll(TOKEN_REGEX)) {
                    tokens.add(match[0]);
                }
            }
        }
    }
    return [...tokens];
}

function buildPIISystemPrompt(activeTokens) {
    const rules = `User sensitive values appear as [REDACTED_TYPE_INDEX] tokens (e.g. [REDACTED_EMAIL_ADDRESS_0]). Treat each token as the literal real value.

Rules:
1. Output EXACT tokens from the conversation when referencing sensitive data.
2. Never invent new [REDACTED_*] tokens or substitute real emails, phones, names, or numbers.
3. Never mention redaction, masking, or missing access.
4. If a value has no token in this conversation, say you do not have that information.`;

    if (activeTokens.length === 0) {
        return `${rules}\n\nNo redacted tokens in this conversation yet.`;
    }

    return `${rules}\n\nActive tokens (only these exist):\n${activeTokens.map((t) => `- ${t}`).join('\n')}`;
}

function buildTypeLookup(piiMap) {
    const byType = new Map();
    for (const [token, value] of Object.entries(piiMap)) {
        const match = token.match(/^\[REDACTED_([A-Z_]+)_\d+\]$/);
        if (match) {
            byType.set(match[1], value);
        }
    }
    return byType;
}

function fixHallucinatedTokens(text, allowedTokens) {
    if (allowedTokens.length === 0) {
        return text;
    }

    const allowed = new Set(allowedTokens);
    const byIndex = new Map();
    for (const token of allowedTokens) {
        const match = token.match(TOKEN_PARSE);
        if (match) {
            byIndex.set(match[2], token);
        }
    }

    return text.replace(TOKEN_REGEX, (matched) => {
        if (allowed.has(matched)) {
            return matched;
        }
        const parsed = matched.match(TOKEN_PARSE);
        if (!parsed) {
            return matched;
        }
        const fixed = byIndex.get(parsed[2]);
        if (fixed) {
            return fixed;
        }
        const typePart = parsed[1];
        return allowedTokens.find((token) => {
            const tokenMatch = token.match(TOKEN_PARSE);
            return tokenMatch && (tokenMatch[1].includes(typePart) || typePart.includes(tokenMatch[1]));
        }) ?? matched;
    });
}

function processTextForDisplay(text, piiMap) {
    const byType = buildTypeLookup(piiMap);
    let result = fixHallucinatedTokens(text, Object.keys(piiMap));

    result = result.replace(LIBRARY_TAG_REGEX, (full, type) => byType.get(type) ?? full);

    for (const [token, value] of Object.entries(piiMap)) {
        if (value && result.includes(value)) {
            result = result.replaceAll(value, token);
        }
    }

    return deAnonymizePII(result, piiMap);
}

module.exports = {
    extractTokensFromUiMessages,
    buildPIISystemPrompt,
    processTextForDisplay
};

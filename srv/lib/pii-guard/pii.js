'use strict';

const { mask, NlpEntity } = require('./pii-mask');

const DEFAULT_NLP_RULES = [
    NlpEntity.PEOPLE,
    NlpEntity.PLACES,
    NlpEntity.ORGS,
    NlpEntity.MONEY
];

const DEFAULT_CREDENTIAL_PATTERNS = [
    {
        name: 'PIN',
        pattern: /\b(?:pin|code|atm|passcode|passphrase|key)\b(?:\s+[a-zA-Z]{2,}){0,2}\s*[:\-=\s]*\b([0-9]{4,6})\b/gi
    },
    {
        name: 'PASSWORD',
        pattern: /\b(?:password|pwd|pass)\b(?:\s+(?:is|for|are|was|code|word))?[\s:\-=.]*\s*([^\s]{4,32})/gi
    }
];

const DEFAULT_SECRET_RULES = [
    {
        pattern: /ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g,
        replacement: 'JWT'
    },
    {
        pattern: /(?:AKIA|AGPA|AIDA|AROA|AIPA)[A-Z0-9]{16}/g,
        replacement: 'AWS_ACCESS_KEY'
    },
    {
        pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g,
        replacement: 'PRIVATE_KEY'
    },
    {
        pattern: /(?:bearer|basic)\s+[a-zA-Z0-9\-._~+/]+=*/gi,
        replacement: 'AUTH_HEADER'
    }
];

const DEFAULT_CONFIG = {
    nlpRules: DEFAULT_NLP_RULES,
    customRules: DEFAULT_SECRET_RULES,
    credentialPatterns: DEFAULT_CREDENTIAL_PATTERNS
};

function applyCredentialPatterns(text, patterns, startIndex, piiMap) {
    let result = text;
    let tokenIndex = startIndex;

    for (const { name, pattern } of patterns) {
        const flags = pattern.flags.includes('g')
            ? pattern.flags
            : `${pattern.flags}g`;
        const matches = Array.from(result.matchAll(new RegExp(pattern.source, flags)));

        for (const match of matches.reverse()) {
            const value = match[1];
            if (!value || match.index === undefined) {
                continue;
            }

            const offset = match[0].indexOf(value);
            if (offset === -1) {
                continue;
            }

            const start = match.index + offset;
            const token = `[REDACTED_${name}_${tokenIndex++}]`;
            result = result.slice(0, start) + token + result.slice(start + value.length);
            piiMap[token] = value;
        }
    }

    return { text: result, nextIndex: tokenIndex };
}

function extractLibraryMatches(original, masked) {
    const matches = [];
    let origIdx = 0;
    let maskedIdx = 0;

    while (maskedIdx < masked.length) {
        if (masked[maskedIdx] !== '<') {
            if (origIdx < original.length && original[origIdx] === masked[maskedIdx]) {
                origIdx += 1;
                maskedIdx += 1;
                continue;
            }
            break;
        }

        const close = masked.indexOf('>', maskedIdx);
        if (close === -1) {
            break;
        }

        const tag = masked.slice(maskedIdx, close + 1);
        const type = masked.slice(maskedIdx + 1, close);
        maskedIdx = close + 1;

        const valueStart = origIdx;
        const nextTag = masked.indexOf('<', maskedIdx);
        const literalSuffix = nextTag === -1
            ? masked.slice(maskedIdx)
            : masked.slice(maskedIdx, nextTag);

        if (literalSuffix.length > 0) {
            const suffixPos = original.indexOf(literalSuffix, origIdx);
            if (suffixPos === -1) {
                break;
            }
            const value = original.slice(valueStart, suffixPos);
            if (value.length > 0) {
                matches.push({ type, value, tag });
            }
            origIdx = suffixPos;
        } else if (maskedIdx >= masked.length) {
            const value = original.slice(valueStart);
            if (value.length > 0) {
                matches.push({ type, value, tag });
            }
            origIdx = original.length;
        } else {
            matches.push({ type, value: original.slice(valueStart, origIdx), tag });
        }
    }

    return matches;
}

function parseRedactedTokenType(token) {
    const match = token.match(/^\[REDACTED_(.+)_\d+\]$/);
    return match?.[1]?.toLowerCase().replace(/_/g, ' ') ?? 'pii';
}

function anonymizePII(text, startIndex = 0, config = {}) {
    const resolved = {
        nlpRules: config.nlpRules ?? DEFAULT_CONFIG.nlpRules,
        customRules: config.customRules ?? DEFAULT_CONFIG.customRules,
        fixedPiiEntities: config.fixedPiiEntities,
        credentialPatterns: config.credentialPatterns ?? DEFAULT_CONFIG.credentialPatterns
    };

    const piiMap = {};
    const { text: plain, nextIndex } = applyCredentialPatterns(
        text,
        resolved.credentialPatterns ?? [],
        startIndex,
        piiMap
    );

    const masked = mask(plain, {
        nlpRules: resolved.nlpRules,
        customRules: resolved.customRules,
        fixedPiiEntities: resolved.fixedPiiEntities
    });

    let tokenIndex = nextIndex;
    let redactedText = masked;

    for (const { type, value, tag } of extractLibraryMatches(plain, masked)) {
        if (type === 'PO_NUMBER') {
            redactedText = redactedText.replace(tag, value);
            continue;
        }
        const token = `[REDACTED_${type}_${tokenIndex++}]`;
        redactedText = redactedText.replace(tag, token);
        piiMap[token] = value;
    }

    return { redactedText, piiMap };
}

function deAnonymizePII(text, piiMap) {
    let result = text;
    for (const [token, value] of Object.entries(piiMap)) {
        result = result.replaceAll(token, value);
    }
    return result;
}

module.exports = {
    parseRedactedTokenType,
    anonymizePII,
    deAnonymizePII
};

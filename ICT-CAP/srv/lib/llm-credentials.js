'use strict';

const cds = require('@sap/cds');
const { decrypt } = require('./crypto-utils');

const CHAT_MODEL_BY_PROVIDER = {
    OPENAI: 'gpt-4o-mini',
    GEMINI: 'gemini-2.5-flash-lite',
    ANTHROPIC: 'claude-haiku-4-5-20251001'
};

const PROVIDER_ORDER = ['OPENAI', 'GEMINI', 'ANTHROPIC'];

/**
 * Chat assistant: first configured provider (DB API key) + fixed model per provider.
 */
async function resolveChatLlmConfig() {
    const rows = await cds.tx(tx => tx.run(SELECT.from('ict.llm_configs')));
    const byProvider = Object.fromEntries(
        rows.map(row => [String(row.provider || '').toUpperCase(), row])
    );

    for (const provider of PROVIDER_ORDER) {
        const modelId = CHAT_MODEL_BY_PROVIDER[provider];
        const apiKey = decrypt(byProvider[provider]?.api_key);
        if (apiKey && modelId) {
            return { provider, model_id: modelId, api_key: apiKey };
        }
    }

    throw new Error(
        'No LLM provider with a configured API key. Add keys in Admin → LLM Config.'
    );
}

module.exports = { resolveChatLlmConfig };

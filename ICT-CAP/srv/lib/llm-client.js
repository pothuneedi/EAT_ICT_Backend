'use strict';

function isReasoningModel(provider, modelId) {
    return provider.toUpperCase() === 'OPENAI' && /^(gpt-5|o\d|gpt-oss)/i.test(modelId);
}

function getModelInstance(provider, modelId, apiKey) {
    if (!provider) throw new Error('LLM provider is required.');
    if (!modelId) throw new Error(`Model ID is required for provider "${provider}".`);
    if (!apiKey) throw new Error(`API key is required for provider "${provider}".`);

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

module.exports = {
    isReasoningModel,
    getModelInstance
};

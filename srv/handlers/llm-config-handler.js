'use strict';

/**
 * LLM Config Handler
 *
 * Intercepts OData reads and writes on LLMConfigs to transparently
 * encrypt the api_key before it is persisted, and decrypt it before
 * it is returned to the client.
 *
 * Encryption: AES-256-GCM via srv/lib/crypto-utils.js
 * Secret:     ENCRYPTION_SECRET environment variable (.env)
 */

const { encrypt, decrypt, isEncrypted } = require('../lib/crypto-utils');

/**
 * Masks the API key in a result set / single result so the full
 * decrypted value is never sent to the browser.
 * Returns a placeholder that tells the UI "a key exists" without exposing it.
 */
function _maskApiKey(data) {
    if (!data) return data;
    if (Array.isArray(data)) {
        return data.map(_maskApiKey);
    }
    if (data.api_key) {
        // Signal to the UI that a key is stored; the actual value stays server-side
        data.api_key = '__STORED__';
    }
    return data;
}

module.exports = {
    register(srv) {

        // ── BEFORE CREATE / UPDATE: encrypt the api_key ──────────────────────
        srv.before(['CREATE', 'UPDATE'], 'LLMConfigs', (req) => {
            const data = req.data;
            if (!data || !data.api_key) return;

            // Skip if the frontend sent back the mask placeholder (no change intended)
            if (data.api_key === '****************' || data.api_key === '__STORED__') {
                delete data.api_key; // don't overwrite the stored value
                return;
            }

            // Skip if value is already encrypted (e.g. re-submitted unchanged blob)
            if (isEncrypted(data.api_key)) return;

            try {
                data.api_key = encrypt(data.api_key);
            } catch (err) {
                req.error(500, `API key encryption failed: ${err.message}`);
            }
        });

        // ── AFTER READ: decrypt the api_key before sending to client ─────────
        srv.after('READ', 'LLMConfigs', (data) => {
            if (!data) return data;
            const items = Array.isArray(data) ? data : [data];
            items.forEach((row) => {
                if (!row || !row.api_key) return;
                // Mask the API key so the frontend knows it exists, but doesn't get the real value
                row.api_key = '****************';
            });
            return data;
        });

        console.log('[LLMConfigHandler] API key encryption hooks registered.');
    }
};

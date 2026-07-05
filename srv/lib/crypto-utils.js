'use strict';

/**
 * AES-256-GCM symmetric encryption utility for sensitive fields (e.g. API keys).
 *
 * - Uses Node.js built-in `crypto` module — zero extra dependencies.
 * - Each encrypted value is self-contained: IV + authTag + ciphertext, base64-encoded.
 * - The encryption secret MUST be set as ENCRYPTION_SECRET in the environment.
 *   It should be a 64-character hex string (32 bytes).
 *
 * Generate a strong secret with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;  // 96-bit IV recommended for GCM
const TAG_BYTES = 16;  // 128-bit auth tag (GCM default)

/**
 * Derives a 32-byte Buffer key from the environment secret.
 * Accepts either a 64-char hex string or any string (hashed with SHA-256).
 */
function _getKey() {
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error(
            '[CryptoUtils] ENCRYPTION_SECRET environment variable is not set. ' +
            'Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
            'and add the output to your .env file.'
        );
    }
    // If exactly 64 hex chars → treat as raw 32-byte key; otherwise hash it
    if (/^[0-9a-f]{64}$/i.test(secret)) {
        return Buffer.from(secret, 'hex');
    }
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plain-text string.
 * Returns a base64-encoded string in the format: <iv>:<authTag>:<ciphertext>
 * Returns null if value is null/undefined/empty.
 */
function encrypt(plainText) {
    if (!plainText) return null;

    const key = _getKey();
    const iv  = crypto.randomBytes(IV_BYTES);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(String(plainText), 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // Pack as base64: iv:authTag:ciphertext
    return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64')
    ].join(':');
}

/**
 * Decrypts a value produced by encrypt().
 * Returns null if value is null/undefined/empty or if decryption fails.
 */
function decrypt(encryptedText) {
    if (!encryptedText) return null;

    try {
        const [ivB64, tagB64, dataB64] = encryptedText.split(':');
        if (!ivB64 || !tagB64 || !dataB64) return null;

        const key     = _getKey();
        const iv      = Buffer.from(ivB64,  'base64');
        const authTag = Buffer.from(tagB64, 'base64');
        const data    = Buffer.from(dataB64, 'base64');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        return Buffer.concat([
            decipher.update(data),
            decipher.final()
        ]).toString('utf8');
    } catch (err) {
        console.error('[CryptoUtils] Decryption failed — key mismatch or corrupted data:', err.message);
        return null;
    }
}

/**
 * Returns true if a string looks like an encrypted payload (iv:tag:data).
 * Used to avoid double-encrypting a value already stored encrypted.
 */
function isEncrypted(value) {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 3 && parts.every(p => p.length > 0);
}

module.exports = { encrypt, decrypt, isEncrypted };

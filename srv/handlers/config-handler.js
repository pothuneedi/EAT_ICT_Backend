'use strict';

function normalizeConfigValue(value) {
    let parsed;
    try {
        parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        throw new Error('value must be valid JSON.');
    }

    if (Array.isArray(parsed)) {
        return JSON.stringify([...new Set(parsed.map(v => String(v).trim()).filter(Boolean))]);
    }

    if (parsed && typeof parsed === 'object') {
        return JSON.stringify(parsed);
    }

    throw new Error('value must be a JSON array or object.');
}

module.exports = {
    register(srv) {
        srv.before(['CREATE', 'UPDATE'], 'Config', (req) => {
            if (req.data?.value == null) {
                return;
            }

            try {
                req.data.value = normalizeConfigValue(req.data.value);
            } catch (err) {
                req.error(400, err.message);
            }
        });

        console.log('[ConfigHandler] ICT runtime config validation registered.');
    }
};

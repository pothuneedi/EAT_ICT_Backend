'use strict';

/** SAP/OData booleans may arrive as true, 1, "true", "1", or "yes". */
function isStrictTrue(value) {
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'yes' || normalized === 'true' || normalized === '1' || normalized === 'x';
    }
    return false;
}

module.exports = { isStrictTrue };

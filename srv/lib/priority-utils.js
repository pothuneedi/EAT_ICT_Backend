'use strict';

const PRIORITY = Object.freeze({
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW'
});

const VALID_PRIORITIES = new Set(Object.values(PRIORITY));

function normalizePriority(value) {
    if (value == null || value === '') {
        return value;
    }

    const normalized = String(value).trim().toUpperCase();
    return VALID_PRIORITIES.has(normalized) ? normalized : normalized;
}

function isValidPriority(value) {
    return VALID_PRIORITIES.has(normalizePriority(value));
}

module.exports = {
    PRIORITY,
    normalizePriority,
    isValidPriority
};

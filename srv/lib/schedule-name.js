'use strict';

/** Letters, digits, and spaces only — no _, -, @, or other special characters. */
const SCHEDULE_NAME_PATTERN = /^[A-Za-z0-9 ]+$/;
const SCHEDULE_NAME_MAX_LENGTH = 100;

function validateScheduleName(name, { required = true } = {}) {
    const value = String(name || '').trim();

    if (!value) {
        if (required) {
            return {
                valid: false,
                value: '',
                message: 'Schedule name is required.'
            };
        }
        return { valid: true, value: '', message: '' };
    }

    if (value.length > SCHEDULE_NAME_MAX_LENGTH) {
        return {
            valid: false,
            value,
            message: `Schedule name must be ${SCHEDULE_NAME_MAX_LENGTH} characters or fewer.`
        };
    }

    if (!SCHEDULE_NAME_PATTERN.test(value)) {
        return {
            valid: false,
            value,
            message: 'Schedule name may only contain letters, numbers, and spaces (no special characters).'
        };
    }

    return { valid: true, value, message: '' };
}

module.exports = {
    validateScheduleName
};

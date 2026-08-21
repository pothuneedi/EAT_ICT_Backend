'use strict';

const cds = require('@sap/cds');

const DEFAULT_AI_DELIVERY_WINDOW_DAYS = 7;

function parseJsonArray(value) {
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

function parsePositiveNumber(value, fallback) {
    if (value == null || value === '') {
        return fallback;
    }

    try {
        const parsed = JSON.parse(value);
        if (typeof parsed === 'number' && parsed > 0) {
            return Math.floor(parsed);
        }
        if (parsed && typeof parsed === 'object') {
            for (const entry of Object.values(parsed)) {
                if (typeof entry === 'number' && entry > 0) {
                    return Math.floor(entry);
                }
            }
        }
    } catch {
        const n = parseInt(String(value).trim(), 10);
        if (n > 0) {
            return n;
        }
    }

    return fallback;
}

async function loadConfigValue(configType) {
    const row = await cds.tx(async tx =>
        tx.run(SELECT.one.from('ict.config').where({ config_type: configType }))
    );
    return row?.value;
}

async function loadPartnerFunctions() {
    return parseJsonArray(await loadConfigValue('partnerFunction'));
}

async function loadPartnerSuppliers() {
    return parseJsonArray(await loadConfigValue('partnerSupplier'));
}

async function loadAiDeliveryWindowDays() {
    return parsePositiveNumber(await loadConfigValue('aiDeliveryWindow'), DEFAULT_AI_DELIVERY_WINDOW_DAYS);
}

module.exports = {
    loadPartnerFunctions,
    loadPartnerSuppliers,
    loadAiDeliveryWindowDays
};

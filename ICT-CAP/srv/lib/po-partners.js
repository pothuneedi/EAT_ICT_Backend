'use strict';

function deliveryWindowCutoffDate(deliveryWindowDays) {
    const days = Math.max(1, Math.floor(Number(deliveryWindowDays) || 7));
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + days);
    return cutoff.toISOString().slice(0, 10);
}

function normalizePartnerFunctions(partnerFunctions) {
    return [...new Set(partnerFunctions.map(f => String(f).trim().toUpperCase()).filter(Boolean))];
}

function normalizePartnerSuppliers(partnerSuppliers) {
    return [...new Set(partnerSuppliers.map(s => String(s).trim()).filter(Boolean))];
}

module.exports = {
    normalizePartnerFunctions,
    normalizePartnerSuppliers,
    deliveryWindowCutoffDate
};

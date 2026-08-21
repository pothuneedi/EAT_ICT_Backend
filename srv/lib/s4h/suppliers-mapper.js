'use strict';

const { parseODataTimestamp } = require('./date-utils');
const { asResultArray } = require('./odata-utils');

function supplierKeyVariants(supplierId) {
    if (supplierId == null || supplierId === '') {
        return [];
    }
    const raw = String(supplierId).trim();
    const variants = new Set([raw]);
    const trimmed = raw.replace(/^0+/, '');
    if (trimmed) {
        variants.add(trimmed);
    }
    if (/^\d+$/.test(raw)) {
        variants.add(raw.padStart(10, '0'));
    }
    return [...variants];
}

function pickPrimaryAddress(bp) {
    const addresses = asResultArray(bp?.to_BusinessPartnerAddress);
    if (!addresses.length) {
        return null;
    }
    return addresses.find(a => a.StandardUsage === 'X') || addresses[0];
}

function pickPrimaryEmail(address) {
    const emails = asResultArray(address?.to_EmailAddress);
    return emails[0]?.EmailAddress || null;
}

function pickSupplierCompany(supplier) {
    const companies = asResultArray(supplier?.to_SupplierCompany);
    return companies[0] || null;
}

function dateToYyyymmddInt(value) {
    const iso = parseODataTimestamp(value);
    if (!iso) {
        return null;
    }
    return parseInt(iso.slice(0, 10).replace(/-/g, ''), 10);
}

/**
 * Join A_Supplier + A_BusinessPartner → ict.suppliers (S4HANA_SYNC_ENDPOINTS.md §5).
 */
function mapSupplierRow(supplier, businessPartner, runTs) {
    const supplierId = supplier?.Supplier;
    if (!supplierId) {
        return null;
    }

    const address = businessPartner ? pickPrimaryAddress(businessPartner) : null;
    const company = pickSupplierCompany(supplier);

    return {
        supplier: supplierId,
        name: businessPartner?.OrganizationBPName1
            || supplier?.SupplierName?.trim()
            || businessPartner?.BusinessPartnerFullName
            || businessPartner?.FirstName
            || supplier?.SupplierFullName?.trim()
            || null,
        name_2: businessPartner?.OrganizationBPName2 || null,
        country_region_key: address?.Country || businessPartner?.Country || null,
        city: address?.CityName || null,
        postal_code: address?.PostalCode || null,
        region: address?.Region || null,
        street: address?.StreetName || null,
        company_code: company?.CompanyCode || null,
        payment_methods: company?.PaymentMethodsList || null,
        terms_of_payment: company?.PaymentTerms || null,
        clerk_internet_address: address ? pickPrimaryEmail(address) : null,
        created_on: dateToYyyymmddInt(businessPartner?.CreationDate || supplier?.CreationDate),
        is_active: true,
        last_synced_at: runTs
    };
}

/**
 * Builds a lookup map BusinessPartner → A_BusinessPartner row (with key variants).
 */
function buildBusinessPartnerMap(bpRows, targetMap = new Map()) {
    bpRows.forEach(bp => {
        if (!bp?.BusinessPartner) {
            return;
        }
        for (const key of supplierKeyVariants(bp.BusinessPartner)) {
            targetMap.set(key, bp);
        }
    });
    return targetMap;
}

function lookupBusinessPartner(bpMap, supplierId) {
    for (const key of supplierKeyVariants(supplierId)) {
        const hit = bpMap.get(key);
        if (hit) {
            return hit;
        }
    }
    return null;
}

module.exports = {
    mapSupplierRow,
    buildBusinessPartnerMap,
    lookupBusinessPartner,
    pickPrimaryAddress,
    pickSupplierCompany,
    supplierKeyVariants
};

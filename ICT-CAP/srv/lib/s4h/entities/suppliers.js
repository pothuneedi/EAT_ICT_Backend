'use strict';

const { splitCsv, buildODataBasePath, buildODataQuery } = require('./_shared');

function loadSuppliersEntityConfig() {
    const service = process.env.S4H_BP_SERVICE || 'API_BUSINESS_PARTNER';
    const supplierEntitySet = process.env.S4H_SUPPLIER_ENTITY_SET || 'A_Supplier';
    const bpEntitySet = process.env.S4H_BP_ENTITY_SET || 'A_BusinessPartner';
    const supplierExpand = splitCsv(
        process.env.S4H_SUPPLIER_EXPAND || 'to_SupplierCompany,to_SupplierPurchasingOrg'
    );
    const bpExpand = splitCsv(
        process.env.S4H_BP_EXPAND
        || 'to_BusinessPartnerAddress/to_EmailAddress,to_BusinessPartnerAddress/to_PhoneNumber'
    );
    const deltaSince = process.env.S4H_SUPPLIER_DELTA_SINCE || null;
    const supplierBase = buildODataBasePath(service, supplierEntitySet);

    return {
        key: 'suppliers',
        service,
        supplierEntitySet,
        bpEntitySet,
        bpExpandNav: bpExpand,
        cdsEntity: 'ict.suppliers',
        supplierOdataPath: `${supplierBase}${buildODataQuery({ expand: supplierExpand, deltaSince })}`,
        supplierCountPath: `${supplierBase}/$count`
    };
}

module.exports = { loadSuppliersEntityConfig };

'use strict';

const { escapeODataString } = require('./_shared');
const { proxyGet } = require('../fetch');
const { asODataCollection } = require('../odata-utils');

const PO_PARTNER_BASE_PATH = process.env.S4H_PO_PARTNER_BASE_PATH
    || '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';

function loadPoPartnersEntityConfig() {
    return {
        cdsEntity: 'ict.po_partners',
        basePath: PO_PARTNER_BASE_PATH
    };
}

function buildPoPartnerPath(poNumber) {
    return `${PO_PARTNER_BASE_PATH}/PurchaseOrder('${escapeODataString(poNumber)}')/_PurchaseOrderPartner`;
}

async function fetchPoPartnersFromS4(poNumber) {
    const body = await proxyGet(buildPoPartnerPath(poNumber));
    return asODataCollection(body);
}

module.exports = {
    loadPoPartnersEntityConfig,
    buildPoPartnerPath,
    fetchPoPartnersFromS4
};

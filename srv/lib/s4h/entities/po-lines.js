'use strict';

const {
    splitCsv,
    buildODataBasePath,
    buildODataQuery,
    buildODataCountPath,
    appendFilterClause
} = require('./_shared');
const { buildPoDateFilter } = require('../sync-scope');

const OPEN_FILTER = process.env.S4H_PO_OPEN_FILTER
    || "IsCompletelyDelivered eq false and PurchasingDocumentDeletionCode eq '' and AccountAssignmentCategory eq ''";

function loadPoLinesEntityConfig(dateScope) {
    const service = process.env.S4H_PO_SERVICE || 'API_PURCHASEORDER_PROCESS_SRV';
    const entitySet = process.env.S4H_PO_ENTITY_SET || 'A_PurchaseOrderItem';
    const expandNav = splitCsv(process.env.S4H_PO_EXPAND || 'to_PurchaseOrder,to_ScheduleLine');
    const filter = appendFilterClause(OPEN_FILTER, buildPoDateFilter(dateScope));
    const basePath = buildODataBasePath(service, entitySet);

    return {
        service,
        intracompanyDocTypes: splitCsv(process.env.S4H_INTRACOMPANY_DOC_TYPES || 'UB'),
        odataPath: `${basePath}${buildODataQuery({ expand: expandNav, filter })}`,
        countPath: buildODataCountPath(basePath, filter)
    };
}

module.exports = { loadPoLinesEntityConfig };

'use strict';

/**
 * S/4HANA OData sync registry — split by change frequency (MDG vs transactional).
 * CHR is separate: see chr-events-syncer.js.
 */
const { syncPlants, countPlants } = require('./plants-syncer');
const { syncMaterials, countMaterials } = require('./materials-syncer');
const { syncSuppliers, countSuppliers } = require('./suppliers-syncer');
const { syncPoLines, countOpenPoLines } = require('./po-lines-syncer');
const { syncPoPartners, countPoPartners } = require('./po-partners-syncer');
const { syncAsnIbd, countAsnIbd } = require('./asn-ibd-syncer');
const { syncIdocErrors, countIdocErrors } = require('./idoc-errors-syncer');

const SYNC_KIND = {
    MASTER: 'MASTER',
    TRANSACTIONAL: 'TRANSACTIONAL'
};

const MASTER_SYNC_ORDER = ['plants', 'materials', 'suppliers'];
const TRANSACTIONAL_SYNC_ORDER = ['po_lines', 'po_partners', 'asn_ibd', 'idoc_errors'];

const SYNC_REGISTRY = {
    plants: { label: 'plants', sync: syncPlants, count: countPlants },
    materials: { label: 'materials', sync: syncMaterials, count: countMaterials },
    suppliers: { label: 'suppliers', sync: syncSuppliers, count: countSuppliers },
    po_lines: { label: 'po_lines', sync: syncPoLines, count: countOpenPoLines },
    po_partners: { label: 'po_partners', sync: syncPoPartners, count: countPoPartners },
    asn_ibd: { label: 'asn_ibd', sync: syncAsnIbd, count: countAsnIbd },
    idoc_errors: { label: 'idoc_errors', sync: syncIdocErrors, count: countIdocErrors }
};

function listTargets(order) {
    return order.map(key => SYNC_REGISTRY[key]);
}

function listMasterSyncTargets() {
    return listTargets(MASTER_SYNC_ORDER);
}

function listTransactionalSyncTargets() {
    return listTargets(TRANSACTIONAL_SYNC_ORDER);
}

module.exports = {
    SYNC_KIND,
    MASTER_SYNC_ORDER,
    TRANSACTIONAL_SYNC_ORDER,
    listMasterSyncTargets,
    listTransactionalSyncTargets
};

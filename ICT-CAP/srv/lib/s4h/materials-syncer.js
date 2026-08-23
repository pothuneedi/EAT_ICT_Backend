'use strict';

const { loadMaterialsEntityConfig } = require('./entities/materials');
const { mapMaterialRow } = require('./materials-mapper');
const { syncMasterEntity, countODataEntity } = require('./master-data-sync');

async function syncMaterials(runTs, options = {}) {
    const entityConfig = loadMaterialsEntityConfig();

    return syncMasterEntity(runTs, {
        label: 'materials',
        cdsEntity: entityConfig.cdsEntity,
        odataPath: entityConfig.odataPath,
        mapRow: (row, ts) => mapMaterialRow(row, ts, { descriptionLang: entityConfig.descriptionLang })
    }, options);
}

async function countMaterials() {
    return countODataEntity(loadMaterialsEntityConfig().countPath);
}

module.exports = { syncMaterials, countMaterials };

'use strict';

const { loadPlantsEntityConfig } = require('./entities/plants');
const { mapPlantRow } = require('./plants-mapper');
const { syncMasterEntity, countODataEntity } = require('./master-data-sync');

async function syncPlants(runTs, options = {}) {
    const entityConfig = loadPlantsEntityConfig();

    return syncMasterEntity(runTs, {
        label: 'plants',
        cdsEntity: entityConfig.cdsEntity,
        odataPath: entityConfig.odataPath,
        mapRow: mapPlantRow
    }, options);
}

async function countPlants() {
    return countODataEntity(loadPlantsEntityConfig().countPath);
}

module.exports = { syncPlants, countPlants };

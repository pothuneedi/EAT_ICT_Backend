'use strict';

const { buildODataBasePath, buildODataQuery, buildODataCountPath } = require('./_shared');

function loadPlantsEntityConfig() {
    const service = process.env.S4H_PLANT_SERVICE || 'API_PLANT_SRV';
    const entitySet = process.env.S4H_PLANT_ENTITY_SET || 'A_Plant';
    const deltaSince = process.env.S4H_PLANT_DELTA_SINCE || null;
    const basePath = buildODataBasePath(service, entitySet);
    const query = buildODataQuery({ deltaSince });

    return {
        key: 'plants',
        service,
        entitySet,
        cdsEntity: 'ict.plants',
        odataPath: `${basePath}${query}`,
        countPath: `${basePath}/$count`
    };
}

module.exports = { loadPlantsEntityConfig };

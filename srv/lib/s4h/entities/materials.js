'use strict';

const { splitCsv, buildODataBasePath, buildODataQuery, buildODataCountPath } = require('./_shared');

function loadMaterialsEntityConfig() {
    const service = process.env.S4H_PRODUCT_SERVICE || 'API_PRODUCT_SRV';
    const entitySet = process.env.S4H_PRODUCT_ENTITY_SET || 'A_Product';
    // Only to_Description is mapped; to_Plant multiplies payload size (product × plants) and causes timeouts.
    const expandNav = splitCsv(process.env.S4H_PRODUCT_EXPAND || 'to_Description');
    const descriptionLang = process.env.S4H_PRODUCT_DESC_LANG || 'EN';
    const deltaSince = process.env.S4H_PRODUCT_DELTA_SINCE || null;
    const basePath = buildODataBasePath(service, entitySet);
    const query = buildODataQuery({ expand: expandNav, deltaSince });

    return {
        key: 'materials',
        service,
        entitySet,
        expandNav,
        descriptionLang,
        cdsEntity: 'ict.materials',
        odataPath: `${basePath}${query}`,
        countPath: `${basePath}/$count`
    };
}

module.exports = { loadMaterialsEntityConfig };

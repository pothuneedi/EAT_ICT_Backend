'use strict';

/**
 * EDI856 IDoc errors — ZICT_IBD_IDOC_ERR_API_SRV / T_IBD_IDOC_ERRLOG.
 */

const {
    buildODataBasePath,
    buildODataQuery,
    buildODataCountPath,
    escapeODataString
} = require('./_shared');

function parsePositiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadIdocErrorsEntityConfig() {
    const service = process.env.S4H_IDOC_SERVICE || 'ZICT_IBD_IDOC_ERR_API_SRV';
    const entitySet = process.env.S4H_IDOC_ENTITY_SET || 'T_IBD_IDOC_ERRLOG';

    return {
        service,
        entitySet,
        poField: process.env.S4H_IDOC_PO_FIELD || 'PO',
        poBatchSize: parsePositiveInt(process.env.S4H_IDOC_PO_BATCH_SIZE, 40),
        cdsEntity: 'ict.edi856_idoc_errors',
        odataBasePath: buildODataBasePath(service, entitySet)
    };
}

function buildPoFilter(entityConfig, poNumbers) {
    const poClause = poNumbers
        .map(po => `${entityConfig.poField} eq '${escapeODataString(po)}'`)
        .join(' or ');
    return `(${poClause}) and MESTYP eq 'DESADV'`;
}

function buildPathForPoBatch(entityConfig, poNumbers) {
    return `${entityConfig.odataBasePath}${buildODataQuery({
        filter: buildPoFilter(entityConfig, poNumbers)
    })}`;
}

function buildCountPathForPoBatch(entityConfig, poNumbers) {
    return buildODataCountPath(entityConfig.odataBasePath, buildPoFilter(entityConfig, poNumbers));
}

function buildProbePath(entityConfig) {
    return `${entityConfig.odataBasePath}?$format=json&$top=1`;
}

module.exports = {
    loadIdocErrorsEntityConfig,
    buildPathForPoBatch,
    buildCountPathForPoBatch,
    buildProbePath
};

'use strict';

const { fetchODataResults } = require('./fetch');
const { loadSuppliersEntityConfig } = require('./entities/suppliers');
const { buildODataBasePath, buildODataQuery } = require('./entities/_shared');
const { mapSupplierRow, buildBusinessPartnerMap, lookupBusinessPartner } = require('./suppliers-mapper');
const { syncMasterEntity, countODataEntity } = require('./master-data-sync');

function bpLookupChunkSize() {
    const n = parseInt(process.env.S4H_BP_LOOKUP_CHUNK || '25', 10);
    return Number.isFinite(n) && n > 0 ? n : 25;
}

async function fetchBusinessPartnersForSupplierIds(entityConfig, supplierIds) {
    const uniqueIds = [...new Set(supplierIds.filter(Boolean))];
    if (!uniqueIds.length) {
        return new Map();
    }

    const bpBase = buildODataBasePath(entityConfig.service, entityConfig.bpEntitySet);
    const chunkSize = bpLookupChunkSize();
    const bpMap = new Map();

    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const filter = chunk
            .map(id => `BusinessPartner eq '${String(id).replace(/'/g, "''")}'`)
            .join(' or ');
        const path = `${bpBase}${buildODataQuery({
            expand: entityConfig.bpExpandNav,
            filter
        })}`;

        buildBusinessPartnerMap(await fetchODataResults(path), bpMap);
    }

    return bpMap;
}

async function syncSuppliers(runTs, options = {}) {
    const entityConfig = loadSuppliersEntityConfig();

    return syncMasterEntity(runTs, {
        label: 'suppliers',
        cdsEntity: entityConfig.cdsEntity,
        odataPath: entityConfig.supplierOdataPath,
        mapPage: async (pageRows, ts, { log, pageMeta }) => {
            log?.info(
                `Page ${pageMeta.pageIndex}: enriching ${pageRows.length} supplier(s) with business partner data...`
            );
            const bpMap = await fetchBusinessPartnersForSupplierIds(
                entityConfig,
                pageRows.map(row => row.Supplier)
            );
            return pageRows
                .map(row => mapSupplierRow(row, lookupBusinessPartner(bpMap, row.Supplier), ts))
                .filter(Boolean);
        }
    }, options);
}

async function countSuppliers() {
    return countODataEntity(loadSuppliersEntityConfig().supplierCountPath);
}

module.exports = { syncSuppliers, countSuppliers };

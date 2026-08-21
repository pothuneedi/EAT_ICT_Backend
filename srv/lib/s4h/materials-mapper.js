'use strict';

const { parseODataTimestamp } = require('./date-utils');
const { asResultArray } = require('./odata-utils');

function pickDescription(descriptions, preferredLang) {
    const rows = asResultArray(descriptions);
    if (!rows.length) {
        return null;
    }
    const lang = (preferredLang || 'EN').toUpperCase();
    return rows.find(d => (d.Language || '').toUpperCase() === lang)
        || rows.find(d => (d.Language || '').toUpperCase().startsWith(lang))
        || rows[0];
}

/**
 * Maps A_Product (+ expands) → ict.materials (S4HANA_SYNC_ENDPOINTS.md §6).
 */
function mapMaterialRow(product, runTs, { descriptionLang = 'EN' } = {}) {
    if (!product?.Product) {
        return null;
    }

    const desc = pickDescription(product.to_Description, descriptionLang);

    return {
        material: product.Product,
        created_on: parseODataTimestamp(product.CreationDate),
        material_type: product.ProductType || null,
        material_group: product.ProductGroup || null,
        base_unit_of_measure: product.BaseUnit || null,
        size_dimensions: product.SizeOrDimensionText || null,
        ean_upc: product.ProductStandardID || null,
        ean_category: product.ProductStandardIDCategory || null,
        product_hierarchy: product.ProductHierarchy || null,
        ext_material_group: product.ExternalProductGroup || null,
        gen_item_category_group: product.ItemCategoryGroup || null,
        material_description: desc?.ProductDescription || null,
        is_active: true,
        last_synced_at: runTs
    };
}

module.exports = { mapMaterialRow, pickDescription };

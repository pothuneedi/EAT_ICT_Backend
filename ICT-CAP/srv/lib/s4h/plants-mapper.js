'use strict';

/**
 * Maps A_Plant → ict.plants (S4HANA_SYNC_ENDPOINTS.md §7).
 */
function mapPlantRow(plant, runTs) {
    if (!plant?.Plant) {
        return null;
    }

    return {
        plant_code: plant.Plant,
        plant_name: plant.PlantName || null,
        street_and_house_number: plant.StreetName || plant.StreetAddressName || null,
        post_code: plant.PostalCode || null,
        city: plant.CityName || null,
        country_region_key: plant.Country || null,
        region: plant.Region || null,
        purchasing_org: plant.PurchasingOrganization || null,
        sales_org_icb: plant.SalesOrganization || null,
        is_active: true,
        last_synced_at: runTs
    };
}

module.exports = { mapPlantRow };

namespace ict;

entity plants {
    key plant_code                : String(10);
        plant_name                : String(100);
        street_and_house_number   : String(200);
        post_code                 : String(20);
        city                      : String(100);
        purchasing_org            : String(10);  // was: POrg
        sales_org_icb             : String(10);  // was: SO_ICB
        country_region_key        : String(10);  // was: C_R
        region                    : String(50);  // was: Rg
        created_at                : Timestamp default $now;
}

entity materials {
    key material                  : String(18);
        created_on                : Date;
        material_type             : String(10);
        material_group            : String(10);
        base_unit_of_measure      : String(3);
        size_dimensions           : String(50);
        ean_upc                   : String(50);
        ean_category              : String(50);
        product_hierarchy         : String(50);
        ext_material_group        : String(50);  // was: Ext__Material_Group
        gen_item_category_group   : String(50);  // was: Gen__item_cat__grp
        material_description      : String(255);
        created_at                : Timestamp default $now;
}

entity suppliers {
    key supplier                  : String(10);
        country_region_key        : String(10);
        name                      : String(100);
        name_2                    : String(100);
        city                      : String(100);
        postal_code               : String(20);
        region                    : String(50);
        street                    : String(200);
        company_code              : String(10);
        created_on                : Integer;     // Excel serial date
        payment_methods           : String(10);
        terms_of_payment          : String(50);
        clerk_internet_address    : String(100); // was: Clrks_internet_add_
        created_at                : Timestamp default $now;
}

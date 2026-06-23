namespace ict;

entity dummy {
    key id : String(10);
        name : String(100);
        address : String(100);
}

entity Plants {
    key plant_code              : String(10);
        plant_name              : String(100);
        Street_and_House_Number : String(200);
        Post_Code               : String(20);
        City                    : String(100);
        POrg                    : String(10);
        SO_ICB                  : String(10);
        C_R                     : String(10);
        Rg                      : String(50);
        created_at              : Timestamp default $now;
}

entity Materials {
    key Material              : String(18);  // Material from Excel
        Created_On            : Date;
        Material_Type         : String(10);
        Material_Group        : String(10);
        Base_Unit_of_Measure  : String(3);
        Size_dimensions       : String(50);
        EAN_UPC               : String(50);
        EAN_Category          : String(50);
        Product_Hierarchy     : String(50);
        Ext__Material_Group   : String(50);
        Gen__item_cat__grp    : String(50);
        Material_Description  : String(255);
        created_at            : Timestamp default $now;
}

entity Suppliers {
    key Supplier             : String(10);  // Supplier from Excel
        Country_Region_Key   : String(10);
        Name                 : String(100);
        Name_2               : String(100);
        City                 : String(100);
        Postal_Code          : String(20);
        Region               : String(50);
        Street               : String(200);
        Company_Code         : String(10);
        Created_On           : Integer;  // Excel serial date
        Payment_Methods      : String(10);
        Terms_of_Payment     : String(50);
        Clrks_internet_add_  : String(100);
        created_at           : Timestamp default $now;
}

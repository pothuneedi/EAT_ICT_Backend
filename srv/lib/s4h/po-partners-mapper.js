'use strict';

const { parseODataTimestamp } = require('./date-utils');
const { isStrictTrue } = require('../sap-boolean');

/** Maps API_PURCHASEORDER_2 PurchaseOrderPartner → ict.po_partners. */
function mapPoPartnerRow(row, runTs) {
    if (!row?.PurchaseOrder || row.PartnerFunction == null || row.PartnerFunction === '') {
        return null;
    }

    return {
        po_number: row.PurchaseOrder,
        partner_function: row.PartnerFunction,
        partner_counter: String(row.PartnerCounter ?? '1'),
        supplier_subrange: row.SupplierSubrange || null,
        plant: row.Plant || null,
        purchasing_org: row.PurchasingOrganization || null,
        created_by: row.CreatedByUser || null,
        created_on: parseODataTimestamp(row.CreationDate),
        purchasing_doc_partner_type: row.PurchasingDocumentPartnerType || null,
        supplier: row.Supplier || null,
        supplier_hierarchy_category: row.SupplierHierarchyCategory || null,
        supplier_contact: row.SupplierContact != null ? String(row.SupplierContact) : null,
        person_work_agreement: row.PersonWorkAgreement != null ? String(row.PersonWorkAgreement) : null,
        employment_internal_id: row.EmploymentInternalID != null ? String(row.EmploymentInternalID) : null,
        default_partner: isStrictTrue(row.DefaultPartner),
        last_synced_at: runTs
    };
}

module.exports = { mapPoPartnerRow };

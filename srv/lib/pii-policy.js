'use strict';

/**
 * PII mask fields for exception analyzer (classifier) only.
 * field: prompt property | surrogate: dummy sent to LLM | supplierValue: DB source
 * Supplier name is not masked — sent to the LLM as-is from master data.
 */

/** Shown when a supplier field has no value; never sent to the LLM as real PII. */
const NO_DATA = 'NO_DATA_FOUND';

const NON_MASKABLE = new Set(['N/A', NO_DATA]);

const LLM_MASK_FIELDS = [
    {
        field: 'supplier_email',
        surrogate: 'ap@redwood-trading.example',
        supplierValue: 'clerk_internet_address'
    },
    {
        field: 'supplier_address',
        surrogate: '17 Larkspur Avenue',
        supplierValue: 'address'
    }
];

module.exports = {
    NO_DATA,
    NON_MASKABLE,
    LLM_MASK_FIELDS
};

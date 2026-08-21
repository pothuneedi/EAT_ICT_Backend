'use strict';

const cds = require('@sap/cds');

async function loadOpenPoNumbers() {
    return cds.tx(async tx => {
        const rows = await tx.run(
            SELECT.distinct.from('ict.po_lines')
                .columns('po_number')
                .where({ po_status: 'OPEN' })
        );
        return rows.map(row => row.po_number).filter(Boolean);
    });
}

module.exports = { loadOpenPoNumbers };

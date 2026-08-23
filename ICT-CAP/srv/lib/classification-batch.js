'use strict';

const { JOB_TYPE } = require('./job-schedule-types');

const OPEN_STATUSES = { po_status: { in: ['OPEN', 'GR_POSTED'] } };

async function loadClassificationBatch(tx, { poNumbers, limit, jobType } = {}) {
    if (poNumbers?.length) {
        return tx.run(
            SELECT.from('ict.po_lines')
                .where({ po_number: { in: poNumbers.map(String) } })
                .and(OPEN_STATUSES)
        );
    }

    const where = {
        ai_processed: false,
        ai_reanalysis_needed: jobType === JOB_TYPE.AI_REANALYSIS,
        ...OPEN_STATUSES
    };

    let query = SELECT.from('ict.po_lines').where(where).orderBy('ai_processed_at asc');

    if (limit) {
        query = query.limit(limit);
    }

    return tx.run(query);
}

module.exports = { loadClassificationBatch };

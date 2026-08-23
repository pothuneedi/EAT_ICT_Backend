'use strict';

/**
 * CQN predicate matching any of the given (po_number, line_item) pairs.
 *
 * Note: `{ or: [...] }` is not valid CQL object notation — cds emits a bare
 * `or` token into the SQL, which the database rejects. Build the xpr instead.
 */
function poLineKeyFilter(lines) {
    const xpr = [];
    for (const { po_number, line_item } of lines) {
        if (xpr.length) {
            xpr.push('or');
        }
        xpr.push({
            xpr: [
                { ref: ['po_number'] }, '=', { val: po_number }, 'and',
                { ref: ['line_item'] }, '=', { val: line_item }
            ]
        });
    }
    return xpr;
}

module.exports = { poLineKeyFilter };

/* global SELECT */
'use strict';

const cds = require('@sap/cds');

/**
 * Analytics functions — read directly from DB using fully qualified
 * schema names to avoid service-layer re-dispatch deadlocks.
 */

async function getActiveOrders() {
    const db     = await cds.connect.to('db');
    const orders = await db.run(
        SELECT.from('ict.po_lines').where({ po_status: ['OPEN', 'GR_POSTED'] })
    );

    const summary = orders.reduce((acc, { po_number, po_status }) => {
        if (!acc[po_number]) {
            acc[po_number] = { po_number, total_lines: 0, open_lines: 0, closed_lines: 0, status: 'OPEN' };
        }
        acc[po_number].total_lines++;
        if (po_status === 'OPEN')        acc[po_number].open_lines++;
        else if (po_status === 'CLOSED') acc[po_number].closed_lines++;
        return acc;
    }, {});

    return { value: Object.values(summary) };
}

async function getExceptionSummary() {
    const db = await cds.connect.to('db');
    const [poLines, exceptions] = await Promise.all([
        db.run(SELECT.from('ict.po_lines').columns('ai_processed')),
        db.run(SELECT.from('ict.exceptions').columns('priority', 'panel'))
    ]);

    return {
        value: {
            total_po_lines:   poLines.length,
            pending_analysis: poLines.filter(p => !p.ai_processed).length,
            total_exceptions: exceptions.length,
            high_priority:    exceptions.filter(e => e.priority === 'High').length,
            medium_priority:  exceptions.filter(e => e.priority === 'Medium').length,
            low_priority:     exceptions.filter(e => e.priority === 'Low').length,
            action_required:  exceptions.filter(e => e.panel === 'ACTION_REQUIRED').length,
            status_report:    exceptions.filter(e => e.panel === 'STATUS_REPORT').length
        }
    };
}

async function getSupplyChainMetrics() {
    const db = await cds.connect.to('db');
    const [poLines, exceptions, asns] = await Promise.all([
        db.run(SELECT.from('ict.po_lines')),
        db.run(SELECT.from('ict.exceptions')),
        db.run(SELECT.from('ict.asn_ibd'))
    ]);

    const totalPos        = new Set(poLines.map(p => p.po_number)).size;
    const completedPos    = poLines.filter(p => p.po_status === 'CLOSED').length;
    const onTimeDelivery  = totalPos === 0 ? 0 : ((completedPos / totalPos) * 100).toFixed(2);
    const exceptionRate   = poLines.length === 0 ? 0 : ((exceptions.length / poLines.length) * 100).toFixed(2);
    const avgLeadTime     = poLines.length === 0 ? 0 : (
        poLines.reduce((sum, p) => {
            const delivery = new Date(p.delivery_date);
            const created  = new Date(p.created_at);
            return sum + Math.ceil((delivery - created) / (1000 * 60 * 60 * 24));
        }, 0) / poLines.length
    ).toFixed(1);

    return {
        value: {
            total_pos:          totalPos,
            on_time_delivery:   parseFloat(onTimeDelivery),
            exception_rate:     parseFloat(exceptionRate),
            avg_lead_time_days: parseFloat(avgLeadTime),
            total_asns:         asns.length,
            completed_asns:     asns.filter(a => a.overall_status === 'C').length
        }
    };
}

function register(srv) {
    srv.on('READ', 'getActiveOrders',       getActiveOrders);
    srv.on('READ', 'getExceptionSummary',   getExceptionSummary);
    srv.on('READ', 'getSupplyChainMetrics', getSupplyChainMetrics);
}

module.exports = { register };

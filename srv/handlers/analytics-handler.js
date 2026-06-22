/* global SELECT */
const cds = require('@sap/cds');

async function getActiveOrders() {
  const orders = await cds.run(
    SELECT.from('po_lines').where({ po_status: ['OPEN', 'GR_POSTED'] })
  );

  const summary = orders.reduce((acc, { po_number, po_status }) => {
    if (!acc[po_number]) {
      acc[po_number] = { po_number, total_lines: 0, open_lines: 0, closed_lines: 0, status: 'OPEN' };
    }
    acc[po_number].total_lines++;
    if (po_status === 'OPEN') {
      acc[po_number].open_lines++;
    } else if (po_status === 'CLOSED') {
      acc[po_number].closed_lines++;
    }

    return acc;
  }, {});

  return { value: Object.values(summary) };
}

async function getExceptionSummary() {
  const exceptions = await cds.run(SELECT.from('ICT_Exceptions'));

  return {
    value: {
      total_exceptions: exceptions.length,
      high_priority: exceptions.filter(e => e.priority === 'High').length,
      medium_priority: exceptions.filter(e => e.priority === 'Medium').length,
      low_priority: exceptions.filter(e => e.priority === 'Low').length,
      action_required: exceptions.filter(e => e.panel === 'ACTION_REQUIRED').length,
      status_report: exceptions.filter(e => e.panel === 'STATUS_REPORT').length
    }
  };
}

async function getSupplyChainMetrics() {
  const [poLines, exceptions, asns] = await Promise.all([
    cds.run(SELECT.from('po_lines')),
    cds.run(SELECT.from('ICT_Exceptions')),
    cds.run(SELECT.from('asn_ibd'))
  ]);

  const totalPos = new Set(poLines.map(p => p.po_number)).size;
  const completedPos = poLines.filter(p => p.po_status === 'CLOSED').length;
  const onTimeDelivery = totalPos === 0 ? 0 : ((completedPos / totalPos) * 100).toFixed(2);
  const exceptionRate = poLines.length === 0 ? 0 : ((exceptions.length / poLines.length) * 100).toFixed(2);
  const avgLeadTime = poLines.length === 0 ? 0 : (
    poLines.reduce((sum, p) => {
      const delivery = new Date(p.delivery_date);
      const created = new Date(p.created_at);
      return sum + Math.ceil((delivery - created) / (1000 * 60 * 60 * 24));
    }, 0) / poLines.length
  ).toFixed(1);

  return {
    value: {
      total_pos: totalPos,
      on_time_delivery: parseFloat(onTimeDelivery),
      exception_rate: parseFloat(exceptionRate),
      avg_lead_time_days: parseFloat(avgLeadTime),
      total_asns: asns.length,
      completed_asns: asns.filter(a => a.asn_status === 'Received' || a.asn_status === 'IDOC_Posted').length
    }
  };
}

function register(srv) {
  srv.on('READ', 'getActiveOrders', getActiveOrders);
  srv.on('READ', 'getExceptionSummary', getExceptionSummary);
  srv.on('READ', 'getSupplyChainMetrics', getSupplyChainMetrics);
}

module.exports = { register };


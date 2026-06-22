/* global SELECT */
const cds = require('@sap/cds');
const log = cds.log('cat-service');

async function createPOLine(req) {
  const { po_number, line_item, material_id, supplier_id, delivery_date, po_qty } = req.data;

  // Validations
  if (!po_number || !line_item) {
    return req.reject(400, 'PO Number and Line Item required');
  }
  if (!material_id || !supplier_id) {
    return req.reject(400, 'Material ID and Supplier ID required');
  }
  if (!delivery_date) {
    return req.reject(400, 'Delivery Date required');
  }
  if (po_qty <= 0) {
    return req.reject(400, 'PO Quantity must be greater than 0');
  }

  const result = await cds.run(req.query);

  this.emit('POCreated', {
    po_number,
    supplier_id,
    created_by: req.data.created_by || 'SYSTEM'
  });

  return result;
}

async function updatePOLine(req) {
  const { po_number, line_item, po_qty } = req.data;

  // Validate quantity if updating
  if (po_qty !== undefined && po_qty <= 0) {
    return req.reject(400, 'PO Quantity must be greater than 0');
  }

  // Log status changes for audit
  if (req.data.po_status) {
    const oldLine = await cds.run(
      SELECT.one.from('po_lines').where({ po_number, line_item })
    );

    if (oldLine?.po_status !== req.data.po_status) {
      log.info(`PO ${po_number}-${line_item}: ${oldLine?.po_status} → ${req.data.po_status}`);
    }
  }

  return cds.run(req.query);
}

function register(srv) {
  srv.on('READ', 'POLines', (req) => cds.run(req.query));
  srv.on('CREATE', 'POLines', createPOLine.bind(srv));
  srv.on('UPDATE', 'POLines', updatePOLine.bind(srv));
  srv.on('DELETE', 'POLines', (req) => cds.run(req.query));
}

module.exports = { register };

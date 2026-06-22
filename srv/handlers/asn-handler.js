/* global SELECT */
const cds = require('@sap/cds');
const log = cds.log('cat-service');

async function createASN(req) {
  const { ibd_number, ibd_item, po_number, supplier_id, ship_to_plant, asn_qty } = req.data;

  // Validations
  if (!ibd_number || !ibd_item || !po_number) {
    return req.reject(400, 'Inbound Delivery (ibd_number), Item (ibd_item) and PO Number required');
  }
  if (asn_qty <= 0) {
    return req.reject(400, 'ASN/IBD Quantity must be greater than 0');
  }

  // Validate PO exists
  const poExists = await cds.run(
    SELECT.one.from('po_lines').where({ po_number, line_item: req.data.line_item })
  );
  if (!poExists) {
    return req.reject(404, `PO ${po_number} not found`);
  }

  const result = await cds.run(req.query);

  this.emit('ASNReceived', {
    ibd_number,
    ibd_item,
    po_number,
    supplier_id,
    asn_qty
  });

  return result;
}

async function updateASN(req) {
  const { ibd_number, ibd_item, asn_qty } = req.data;

  if (asn_qty !== undefined && asn_qty <= 0) {
    return req.reject(400, 'ASN/IBD Quantity must be greater than 0');
  }

  // Track status transitions
  if (req.data.asn_status) {
    const oldASN = await cds.run(
      SELECT.one.from('asn_ibd').where({ ibd_number, ibd_item })
    );

    if (oldASN?.asn_status !== req.data.asn_status) {
      log.info(`IBD ${ibd_number}/${ibd_item}: ${oldASN?.asn_status} → ${req.data.asn_status}`);
    }
  }

  return cds.run(req.query);
}

function register(srv) {
  srv.on('READ', 'ASNIbd', (req) => cds.run(req.query));
  srv.on('CREATE', 'ASNIbd', createASN.bind(srv));
  srv.on('UPDATE', 'ASNIbd', updateASN.bind(srv));
  srv.on('DELETE', 'ASNIbd', (req) => cds.run(req.query));
}

module.exports = { register };


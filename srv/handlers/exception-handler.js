const cds = require('@sap/cds');

async function createException(req, next) {
  const { po_number, line_item, exception_type, priority, priority_score, panel } = req.data;

  // Validations
  if (!po_number || !line_item) {
    return req.reject(400, 'PO Number and Line Item required');
  }
  if (!exception_type) {
    return req.reject(400, 'Exception Type required');
  }
  if (!priority) {
    return req.reject(400, 'Priority required (High/Medium/Low)');
  }
  if (!panel) {
    return req.reject(400, 'Panel required (ACTION_REQUIRED/STATUS_REPORT)');
  }
  if (priority_score < 0 || priority_score > 100) {
    return req.reject(400, 'Priority Score must be 0-100');
  }

  const result = await next();

  this.emit('ExceptionRaised', {
    exception_id: result.exception_id,
    po_number,
    exception_type,
    priority
  });

  return result;
}

async function updateException(req, next) {
  const { resolved_at, resolution_note } = req.data;

  // Validate resolution completeness
  if (resolved_at && !resolution_note) {
    return req.reject(400, 'Resolution note required when resolving exception');
  }

  return next();
}

function register(srv) {
  srv.on('CREATE', 'Exceptions', createException.bind(srv));
  srv.on('UPDATE', 'Exceptions', updateException.bind(srv));
}

module.exports = { register };

const cds = require('@sap/cds');
const { isValidPriority } = require('../lib/priority-utils');

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
    return req.reject(400, 'Priority required (HIGH/MEDIUM/LOW)');
  }
  if (!isValidPriority(priority)) {
    return req.reject(400, 'Priority must be HIGH, MEDIUM, or LOW');
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

const FEEDBACK_RATINGS = ['HELPFUL', 'NOT_HELPFUL'];

/**
 * Before CREATE AIFeedback — validate the rating and snapshot the rated
 * content server-side. The client only sends { exception_id, rating, comment };
 * po_number / line_item / exception_type / recommendation are copied from the
 * exception row at rating time so the feedback stays meaningful even after the
 * exception is overwritten by a later reprocess.
 */
async function validateAiFeedback(req) {
  const { exception_id, rating } = req.data;

  if (!exception_id) {
    return req.reject(400, 'exception_id is required');
  }
  if (!FEEDBACK_RATINGS.includes(rating)) {
    return req.reject(400, `rating must be one of: ${FEEDBACK_RATINGS.join(', ')}`);
  }

  const db = await cds.connect.to('db');
  const exception = await db.run(
    SELECT.one.from('ict.exceptions')
      .columns('po_number', 'line_item', 'exception_type', 'recommendation')
      .where({ exception_id })
  );
  if (!exception) {
    return req.reject(404, `Exception ${exception_id} not found`);
  }

  // Server-side snapshot — ignore any client-supplied values for these fields
  req.data.po_number = exception.po_number;
  req.data.line_item = exception.line_item;
  req.data.exception_type = exception.exception_type;
  req.data.recommendation = exception.recommendation;
  req.data.created_by = req.user?.id || 'anonymous';
  delete req.data.created_at; // server clock only — not client-settable
  if (req.data.comment) {
    req.data.comment = String(req.data.comment).trim().slice(0, 1000) || null;
  }
}

function register(srv) {
  srv.on('CREATE', 'Exceptions', createException.bind(srv));
  srv.on('UPDATE', 'Exceptions', updateException.bind(srv));
  srv.before('CREATE', 'AIFeedback', validateAiFeedback);
  // Feedback is an append-only audit log — never edited or deleted from the UI
  srv.reject(['UPDATE', 'DELETE'], 'AIFeedback');
}

module.exports = { register };

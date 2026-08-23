'use strict';

const cds = require('@sap/cds');
const { loadIbdCreationReport } = require('../lib/ibd-creation-report');
const { buildIbdUploadWorkbook } = require('../lib/ibd-upload-template');

const { normalizeLineItem } = require('../lib/s4h/entities/_shared');

function parseSelection(raw) {
    if (!raw) {
        return [];
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) {
        throw new Error('selection must be a JSON array');
    }
    return parsed.map((row) => ({
        po_number: String(row.po_number || '').trim(),
        line_item: normalizeLineItem(row.line_item) || String(row.line_item || '').trim(),
        storage_location: row.storage_location != null ? String(row.storage_location).trim() : ''
    })).filter((row) => row.po_number && row.line_item);
}

async function getIbdCreationReport(req) {
    const db = await cds.connect.to('db');
    return loadIbdCreationReport(db, {
        plant: req.data.plant || 'ALL',
        search: req.data.search || ''
    });
}

async function downloadIbdUploadTemplate(req) {
    const selection = parseSelection(req.data.selection);
    if (!selection.length) {
        req.error(400, 'At least one PO line must be selected.');
        return;
    }

    const db = await cds.connect.to('db');
    const report = await loadIbdCreationReport(db, {});
    return buildIbdUploadWorkbook(selection, report.lines);
}

function register(srv) {
    srv.on('getIbdCreationReport', getIbdCreationReport);
    srv.on('downloadIbdUploadTemplate', downloadIbdUploadTemplate);
}

module.exports = { register };

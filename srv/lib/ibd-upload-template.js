'use strict';

const ExcelJS = require('exceljs');
const { poLineKey } = require('./ibd-creation-report');

const TEMPLATE_COLUMNS = [
    'Purchasing Document',
    'Item',
    'Supplier',
    'Delivery Date',
    'Reference',
    'Bill of Lading',
    'Delivery Quantity',
    'Plant',
    'Storage Location',
    'Means-of-Trans. Type',
    'Means of Transport'
];

let sessionCounter = 0;
let sessionDateKey = '';

function toExcelSerialDate(value) {
    if (!value) {
        return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const epoch = Date.UTC(1899, 11, 30);
    return (utc - epoch) / 86400000;
}

function nextFileName() {
    const today = new Date();
    const key = today.toISOString().slice(0, 10).replace(/-/g, '');
    if (sessionDateKey !== key) {
        sessionDateKey = key;
        sessionCounter = 0;
    }
    sessionCounter += 1;
    return `IBD_Upload_${key}_${String(sessionCounter).padStart(3, '0')}.xlsx`;
}

function validateRow(row) {
    if (!row.po_number) return 'Purchasing Document';
    if (!row.line_item) return 'Item';
    if (!row.supplier_id) return 'Supplier';
    if (!row.reference) return 'Reference';
    if (!row.plant) return 'Plant';
    if (!row.storage_location) return 'Storage Location';
    return null;
}

function buildTemplateRow(line) {
    return {
        'Purchasing Document': line.po_number,
        'Item': line.line_item,
        'Supplier': line.supplier_id,
        'Delivery Date': toExcelSerialDate(line.delivery_date),
        'Reference': line.reference,
        'Bill of Lading': line.bill_of_lading || '',
        'Delivery Quantity': line.chr_qty ?? line.po_qty ?? null,
        'Plant': line.plant,
        'Storage Location': line.storage_location,
        'Means-of-Trans. Type': '',
        'Means of Transport': ''
    };
}

async function buildIbdUploadWorkbook(selection, reportLines) {
    const lineByKey = new Map(
        (reportLines || []).map((line) => [poLineKey(line.po_number, line.line_item), line])
    );

    const included = [];
    const warnings = [];

    for (const item of selection) {
        const source = lineByKey.get(poLineKey(item.po_number, item.line_item));
        if (!source) {
            warnings.push({
                po_number: item.po_number,
                line_item: item.line_item,
                message: 'Row excluded — line is no longer eligible for IBD creation.'
            });
            continue;
        }

        const candidate = {
            ...source,
            storage_location: String(item.storage_location || '').trim()
        };
        const missingField = validateRow(candidate);
        if (missingField) {
            warnings.push({
                po_number: candidate.po_number,
                line_item: candidate.line_item,
                message: `Row excluded — ${missingField} could not be resolved.`
            });
            continue;
        }

        included.push(buildTemplateRow(candidate));
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('IBD Upload');
    sheet.addRow(TEMPLATE_COLUMNS);
    included.forEach((row) => {
        sheet.addRow(TEMPLATE_COLUMNS.map((column) => row[column] ?? ''));
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return {
        fileName: nextFileName(),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileContent: Buffer.from(buffer).toString('base64'),
        includedCount: included.length,
        excludedCount: warnings.length,
        warnings
    };
}

module.exports = {
    buildIbdUploadWorkbook
};

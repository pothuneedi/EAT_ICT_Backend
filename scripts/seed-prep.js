#!/usr/bin/env node
/**
 * seed-prep.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Adds ai_processed + ai_processed_at columns to ict-po_lines.csv
 *    (all rows get ai_processed=false, ai_processed_at empty)
 * 2. Resets ict-ICT_Exceptions.csv to header-only (clears all seeded data
 *    so the AI analyzer starts fresh)
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage: node scripts/seed-prep.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../db/data');

// ─── 1. Update ict-po_lines.csv ──────────────────────────────────────────────

const PO_CSV = path.join(DATA_DIR, 'ict-po_lines.csv');

const poContent = fs.readFileSync(PO_CSV, 'utf8');
const poLines = poContent.split('\n');
const poHeader = poLines[0].trim();

const AI_FIELDS = 'ai_processed;ai_processed_at';

if (poHeader.includes('ai_processed')) {
    console.log('[po_lines] ai_processed column already present — skipping header update.');
} else {
    poLines[0] = poHeader + ';' + AI_FIELDS;
    console.log('[po_lines] Added ai_processed + ai_processed_at columns to header.');
}

// Append false; to every data row that doesn't already have the column
const updatedPoLines = poLines.map((line, idx) => {
    if (idx === 0) {
        return poLines[0];
    }
    if (!line.trim()) {
        return line;
    }

    const cols = line.split(';');
    const headerCols = poLines[0].split(';').length;

    if (cols.length >= headerCols) {
        return line;
    }

    return line + ';false;';
});

fs.writeFileSync(PO_CSV, updatedPoLines.join('\n'), 'utf8');
console.log('[po_lines] Done. File written: ' + PO_CSV);


// ─── 2. Clear ict-ICT_Exceptions.csv (keep header only) ──────────────────────

const EX_CSV = path.join(DATA_DIR, 'ict-ICT_Exceptions.csv');
const exContent = fs.readFileSync(EX_CSV, 'utf8');
const exHeader = exContent.split('\n')[0];

fs.writeFileSync(EX_CSV, exHeader + '\n', 'utf8');
console.log('[ICT_Exceptions] Cleared all rows (header preserved): ' + EX_CSV);

console.log('\n✓ Done. Run `cds deploy` or restart the server to apply changes.');

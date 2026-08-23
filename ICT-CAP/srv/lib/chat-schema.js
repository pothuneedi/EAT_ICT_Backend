'use strict';

const cds = require('@sap/cds');

/** Master + transactional tables the chat assistant may query (no admin/config). */
const QUERYABLE_TABLES = [
    'po_lines',
    'po_partners',
    'asn_ibd',
    'chr_events',
    'exceptions',
    'edi856_idoc_errors',
    'materials',
    'suppliers',
    'plants',
    'exception_rules',
    'exception_types'
];

const TABLE_DESCRIPTIONS = {
    po_lines: 'Purchase order line items (core transactional entity).',
    po_partners: 'SAP purchase-order partner functions.',
    asn_ibd: 'Inbound deliveries / ASNs linked to PO lines.',
    chr_events: 'Carrier / Navisphere tracking events.',
    exceptions: 'AI-classified inbound exceptions for PO lines.',
    edi856_idoc_errors: 'EDI856 / DESADV IDoc processing errors.',
    materials: 'Material master data.',
    suppliers: 'Supplier master data.',
    plants: 'Plant / site master data.',
    exception_rules: 'Exception classification rules.',
    exception_types: 'Exception type lookup.'
};

/** Explicit join keys for cross-table linked queries (primary.local = linked.remote). */
const LINK_HINTS = {
    po_lines: {
        materials: { material_id: 'material' },
        suppliers: { supplier_id: 'supplier' },
        plants: { plant: 'plant_code' },
        exceptions: { po_number: 'po_number', line_item: 'line_item' },
        edi856_idoc_errors: { po_number: 'po_number' },
        asn_ibd: { po_number: 'reference_document', line_item: 'reference_item' },
        chr_events: { po_number: 'po_number' },
        po_partners: { po_number: 'po_number' }
    },
    exceptions: {
        po_lines: { po_number: 'po_number', line_item: 'line_item' },
        exception_rules: { exception_type: 'exception_type' }
    },
    edi856_idoc_errors: {
        po_lines: { po_number: 'po_number', line_item: 'line_item' },
        asn_ibd: { delivery: 'delivery' }
    },
    asn_ibd: {
        po_lines: { reference_document: 'po_number', reference_item: 'line_item' },
        materials: { material: 'material' }
    },
    chr_events: {
        po_lines: { po_number: 'po_number' }
    },
    po_partners: {
        po_lines: { po_number: 'po_number' },
        suppliers: { supplier: 'supplier' }
    }
};

let catalogCache = null;

function formatFieldType(element) {
    const raw = element?.type || 'String';
    return raw.replace(/^cds\./, '');
}

function isScalarElement(element) {
    return element && !element.isAssociation && !element.target;
}

function buildCatalogFromModel(definitions) {
    const tables = {};

    for (const shortName of QUERYABLE_TABLES) {
        const entityName = `ict.${shortName}`;
        const def = definitions[entityName];
        if (!def?.elements) {
            throw new Error(`Missing CDS definition for ${entityName}`);
        }

        const fields = [];
        const keys = [];

        for (const [name, element] of Object.entries(def.elements)) {
            if (!isScalarElement(element)) {
                continue;
            }
            const field = {
                name,
                type: formatFieldType(element),
                key: Boolean(element.key)
            };
            fields.push(field);
            if (field.key) {
                keys.push(name);
            }
        }

        tables[shortName] = {
            entity: entityName,
            description: TABLE_DESCRIPTIONS[shortName] || shortName,
            keys,
            fields,
            columns: fields.map((field) => field.name),
            links: LINK_HINTS[shortName] || {}
        };
    }

    return tables;
}

async function ensureCatalog() {
    if (catalogCache) {
        return catalogCache;
    }

    const definitions = cds.model?.definitions
        || (await cds.load('*')).definitions;

    catalogCache = buildCatalogFromModel(definitions);
    return catalogCache;
}

function getCatalog() {
    if (!catalogCache) {
        throw new Error('Chat schema catalog not loaded. Call ensureCatalog() first.');
    }
    return catalogCache;
}

function buildChatSchemaPrompt(maxRowsPerQuery) {
    const tables = getCatalog();
    const lines = [
        '## ICT schema (read-only)',
        `Cap per query: ${maxRowsPerQuery} rows.`,
        'Filters: where (exact, IN arrays, operator objects for > < >= <= != in null), whereLike (text includes), linked (cross-table).',
        'Comparisons: {"operator":">","value":50000} — not plain equality when user means greater/less than.',
        'On empty results or unknown column errors: pick another field or join from Links below.',
        ''
    ];

    for (const shortName of QUERYABLE_TABLES) {
        const meta = tables[shortName];
        lines.push(`### ${shortName} (${meta.entity})`);
        lines.push(meta.description);
        lines.push(`Keys: ${meta.keys.join(', ') || '(none)'}`);
        lines.push('Fields:');
        for (const field of meta.fields) {
            lines.push(`  - ${field.name}: ${field.type}${field.key ? ' [key]' : ''}`);
        }
        if (meta.links && Object.keys(meta.links).length) {
            lines.push('Links:');
            for (const [target, on] of Object.entries(meta.links)) {
                const mapping = Object.entries(on).map(([left, right]) => `${left}=${right}`).join(', ');
                lines.push(`  - ${target}: ${mapping}`);
            }
        }
        lines.push('');
    }

    return lines.join('\n').trim();
}

function resolveTable(tableName) {
    const key = String(tableName || '').trim();
    const meta = getCatalog()[key];
    if (!meta) {
        throw new Error(`Unknown table "${tableName}". Allowed: ${QUERYABLE_TABLES.join(', ')}`);
    }
    return meta;
}

module.exports = {
    QUERYABLE_TABLES,
    ensureCatalog,
    buildChatSchemaPrompt,
    resolveTable
};

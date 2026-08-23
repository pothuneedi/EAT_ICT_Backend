'use strict';

const cds = require('@sap/cds');
const { proxyChrGet, isProxyNotFoundError } = require('./fetch');
const { loadConfig, syncModeLabel } = require('./config');
const { loadOpenPoNumbers } = require('./open-po-scope');
const {
    loadChrEventsEntityConfig,
    buildEventsPath,
    resolveEventWindow,
    parseChrEventsBody
} = require('./entities/chr-events');
const { mapChrEventRows } = require('./chr-events-mapper');
const { upsertInBatches } = require('./reconcile');

async function upsertChrRows(tx, entity, rows, upsertBatchSize) {
    if (!rows.length) {
        return { upserted: 0, newLinkedPoNumbers: [] };
    }

    const byHash = new Map();
    for (const row of rows) {
        if (!byHash.has(row.source_hash)) {
            byHash.set(row.source_hash, row);
        }
    }

    const existing = await tx.run(
        SELECT.from(entity)
            .columns('ID', 'source_hash')
            .where({ source_hash: { in: [...byHash.keys()] } })
    );

    const idByHash = new Map(existing.map(row => [row.source_hash, row.ID]));
    const newLinkedPoNumbers = new Set();
    const entries = [];

    for (const row of byHash.values()) {
        if (!idByHash.has(row.source_hash) && row.po_linked && row.po_number) {
            newLinkedPoNumbers.add(row.po_number);
        }
        entries.push({ ...row, ID: idByHash.get(row.source_hash) || row.ID });
    }

    await upsertInBatches(tx, entity, entries, upsertBatchSize);
    return { upserted: entries.length, newLinkedPoNumbers: [...newLinkedPoNumbers] };
}

async function flagPoLinesForChrReanalysis(tx, poNumbers) {
    if (!poNumbers?.length) {
        return 0;
    }

    const result = await tx.run(
        UPDATE('ict.po_lines')
            .set({ ai_reanalysis_needed: true, ai_processed: false })
            .where({ po_number: { in: poNumbers }, po_status: 'OPEN' })
            .and('ai_processed = true or ai_processed_at is not null')
    );

    return typeof result === 'number' ? result : (result || 0);
}

async function fetchChrEventsInWindow(entityConfig, window) {
    const body = await proxyChrGet(buildEventsPath(entityConfig));
    const returned = body?.results?.length || 0;

    return {
        sourceTotal: body?.totalCount ?? null,
        returned,
        events: parseChrEventsBody(body, {
            fromMs: window.fromMs,
            toMs: window.toMs,
            customer: entityConfig.customer
        })
    };
}

async function syncChrEvents(_runTs, { log, onProgress, lookbackMinutes, customer } = {}) {
    const config = loadConfig();
    const entityConfig = loadChrEventsEntityConfig({ lookbackMinutes, customer });
    const window = resolveEventWindow(entityConfig);

    const stats = {
        upserted: 0,
        poLinesFlagged: 0,
        openPoCount: 0,
        poLinked: 0,
        matchedInSource: 0,
        fetchErrors: 0,
        sourceTotal: null,
        sourceReturned: 0,
        windowMinutes: window.minutes
    };

    const openPoNumbers = await loadOpenPoNumbers();
    stats.openPoCount = openPoNumbers.length;
    const openPoSet = new Set(openPoNumbers);

    log?.info(
        `Starting CHR sync (${syncModeLabel(config)}, customer: ${entityConfig.customer}, `
        + `open POs in DB: ${openPoNumbers.length}, `
        + `window: last ${window.minutes} min — ${window.label})...`
    );

    let fetched;
    try {
        fetched = await fetchChrEventsInWindow(entityConfig, window);
    } catch (err) {
        stats.fetchErrors += 1;
        if (isProxyNotFoundError(err)) {
            log?.warn('CHR /v2/events returned 404 — nothing synced.');
            return stats;
        }
        log?.warn(`CHR fetch failed — ${err.message}`);
        throw err;
    }

    stats.sourceTotal = fetched.sourceTotal;
    stats.sourceReturned = fetched.returned;

    let events = fetched.events;
    if (config.devRowLimit) {
        events = events.slice(0, config.devRowLimit);
    }
    stats.matchedInSource = events.length;

    log?.info(
        `CHR returned ${fetched.returned} of ${fetched.sourceTotal ?? '?'} event(s); `
        + `${events.length} inside the ${window.minutes}-min window`
        + (config.devRowLimit ? ` (capped at ${config.devRowLimit} for this run)` : '')
        + '.'
    );

    if (fetched.returned && !events.length) {
        log?.warn(
            `No CHR events within the last ${window.minutes} min. CHR caps `
            + `/v2/events at ${fetched.returned} rows with no paging — `
            + 'increase lookbackMinutes to at least the job interval.'
        );
    }

    const truncated = new Map();
    const onTruncate = (field, length, max) => {
        const seen = truncated.get(field);
        truncated.set(field, { count: (seen?.count || 0) + 1, max, longest: Math.max(seen?.longest || 0, length) });
    };

    const mapped = events.flatMap(event => mapChrEventRows(event, openPoSet, onTruncate));

    for (const [field, { count, max, longest }] of truncated) {
        log?.warn(
            `CHR sent ${count} value(s) too long for ${field} (max ${max}, longest ${longest}) — `
            + 'clamped to fit; widen the column if this is expected.'
        );
    }

    if (!mapped.length) {
        log?.info('No CHR event rows to upsert after mapping.');
        return stats;
    }

    const slice = config.devRowLimit ? mapped.slice(0, config.devRowLimit) : mapped;

    await cds.tx(async tx => {
        const { upserted, newLinkedPoNumbers } = await upsertChrRows(
            tx, entityConfig.cdsEntity, slice, config.upsertBatchSize
        );
        stats.upserted = upserted;
        stats.poLinesFlagged = await flagPoLinesForChrReanalysis(tx, newLinkedPoNumbers);
    });

    stats.mappedRows = slice.length;
    stats.duplicatesCollapsed = slice.length - stats.upserted;
    stats.poLinked = slice.filter(row => row.po_linked).length;

    log?.updateStats({
        total_batch_size: stats.upserted,
        processed_count: stats.upserted
    });

    if (onProgress) {
        await onProgress();
    }

    log?.info(
        `CHR sync complete — source events in window: ${stats.matchedInSource}, `
        + `mapped rows: ${stats.mappedRows}, duplicates collapsed: ${stats.duplicatesCollapsed}, `
        + `upserted: ${stats.upserted} (po_linked: ${stats.poLinked}, reanalysis flagged: ${stats.poLinesFlagged}), `
        + `fetch errors: ${stats.fetchErrors}.`
    );

    return stats;
}

module.exports = { syncChrEvents };

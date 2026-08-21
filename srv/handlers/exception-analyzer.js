'use strict';

const cds = require('@sap/cds');
const AiService = require('../lib/AiService');
const { decrypt } = require('../lib/crypto-utils');
const LogCollector = require('../lib/LogCollector');
const { persistExecutionLog } = require('../lib/execution-log-persist');
const { deliveryWindowCutoffDate } = require('../lib/po-partners');
const { loadAiDeliveryWindowDays, loadPartnerFunctions, loadPartnerSuppliers } = require('../lib/app-config');
const { enrichSupplierContacts, isPiiDebugEnabled } = require('../lib/pii-redaction');
const {
    isAiEligible,
    resolveRuleBasedClassification,
    buildPartnersByPo,
    isRuleBasedResult,
    isUnchangedRuleBasedClassification,
    buildClassificationRecord
} = require('../lib/classification-bypass');
const { loadClassificationBatch } = require('../lib/classification-batch');
const { isReanalysisJobType } = require('../lib/job-schedule-types');
const { summarizeAsnByPoLine } = require('../lib/s4h/po-lines-qty');
const { dedupeChrEventsForPo } = require('../lib/chr-events-presentation');
const { isStrictTrue } = require('../lib/sap-boolean');

/**
 * Resolves and validates the active LLM provider credentials + exception rules
 * for a given job's nested config. Shared by both the scheduled batch run and
 * manual PO reprocessing so both go through identical validation.
 */
async function _resolveLlmConfig(nestedConfig, log) {
    const providerName = nestedConfig.provider.toUpperCase();

    const [activeProviderCreds, rules] = await cds.tx(async (tx) => Promise.all([
        tx.run(SELECT.one.from('ict.llm_configs').where({ provider: providerName })),
        tx.run(SELECT.from('ict.exception_rules'))
    ]));

    if (!activeProviderCreds) {
        const err = `No LLM configuration for provider "${providerName}"`;
        log.failure(err);
        throw new Error(err);
    }
    if (!activeProviderCreds.api_key) {
        const err = `LLM config for "${providerName}" missing API key`;
        log.failure(err);
        throw new Error(err);
    }

    const decryptedApiKey = decrypt(activeProviderCreds.api_key);
    if (!decryptedApiKey) {
        const err = `Failed to decrypt API key for provider "${providerName}"`;
        log.failure(err);
        throw new Error(err);
    }

    if (rules.length === 0) {
        const err = 'No ExceptionRules found in database';
        log.failure(err);
        throw new Error(err);
    }

    // No "configuration validated" log here by design — the caller logs one
    // consolidated "starting analysis" line right after this, which already
    // states provider/model/rules; logging it twice would just be noise.
    const llmConfig = {
        provider: providerName,
        model_id: nestedConfig.selectedModelId,
        inference_option: nestedConfig.inference_option,
        temperature: parseFloat(nestedConfig.temperature),
        max_tokens: parseInt(nestedConfig.max_tokens, 10),
        top_p: parseFloat(nestedConfig.top_p),
        system_prompt: nestedConfig.system_prompt || '',
        api_key: decryptedApiKey
    };

    return { llmConfig, rules };
}

/**
 * Loads all reference data needed to classify a set of PO lines, in one
 * short-lived transaction (fast reads only — released immediately).
 */
async function _loadReferenceData(poNumbers, supplierIds, materialIds, plantCodes) {
    return cds.tx(async (tx) => {
        const [asnRecords, suppliers, chrEvents, idocErrors, existingExceptions, maxRow, materials, plants, poPartners] = await Promise.all([
            tx.run(SELECT.from('ict.asn_ibd').where({ reference_document: { in: poNumbers } })),
            supplierIds.length
                ? tx.run(SELECT.from('ict.suppliers').where({ supplier: { in: supplierIds } }))
                : Promise.resolve([]),
            tx.run(SELECT.from('ict.chr_events').where({ po_number: { in: poNumbers } })),
            tx.run(SELECT.from('ict.edi856_idoc_errors').where({ po_number: { in: poNumbers } })),
            tx.run(SELECT.from('ict.exceptions').where({ po_number: { in: poNumbers } })),
            tx.run(SELECT.one.from('ict.exceptions').columns('max(exception_id) as maxId')),
            materialIds.length
                ? tx.run(SELECT.from('ict.materials').where({ material: { in: materialIds } }))
                : Promise.resolve([]),
            plantCodes.length
                ? tx.run(SELECT.from('ict.plants').where({ plant_code: { in: plantCodes } }))
                : Promise.resolve([]),
            tx.run(SELECT.from('ict.po_partners').where({ po_number: { in: poNumbers } }))
        ]);
        return { asnRecords, suppliers, chrEvents, idocErrors, existingExceptions, maxRow, materials, plants, poPartners };
    });
}

const UNIQUE_RETRY_ATTEMPTS = 5;

/**
 * True if a DB error means "this key already exists". Covers all three layers
 * we can hit: CAP's ORM-level pre-check (ENTITY_ALREADY_EXISTS), the Postgres
 * driver (SQLSTATE 23505), and the raw SQLite message ("UNIQUE constraint failed").
 */
function _isUniqueViolation(err) {
    if (!err) return false;
    if (err.code === '23505' || err.code === 'ENTITY_ALREADY_EXISTS') return true;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('unique') || msg.includes('duplicate') || msg.includes('already_exists') || msg.includes('already exists');
}

/**
 * Persists one classification result inside a single short-lived transaction:
 *   • upserts the exception row,
 *   • flags the PO line as AI-processed only when an LLM classification ran.
 *   • links any contributing IDoc errors back to the exception.
 *
 * `exception_id` has no DB sequence, so for NEW rows the integer key comes from
 * an in-process counter (idState) — the happy path is a single straight-through
 * write with zero extra queries. If a concurrent run (e.g. the scheduled job
 * overlapping a manual reprocess) has already claimed that id, the INSERT fails
 * with a unique violation; only then do we resync the counter from the DB and
 * retry. There is no polling and no per-line lookup — the retry executes solely
 * on a real collision, which is rare.
 */
async function _persistClassification({ po, record, existing, now, aiResult, poIdocErrors, idState, markAiProcessed }) {
    for (let attempt = 1; attempt <= UNIQUE_RETRY_ATTEMPTS; attempt++) {
        let inserted = false;
        try {
            await cds.tx(async (tx) => {
                const target = existing || await tx.run(
                    SELECT.one.from('ict.exceptions')
                        .columns('exception_id')
                        .where({ po_number: po.po_number, line_item: po.line_item })
                        .orderBy('exception_id desc')
                );

                inserted = !target;
                record.exception_id = target ? target.exception_id : idState.nextId;
                await tx.run(UPSERT.into('ict.exceptions').entries(record));

                // Rule-based: not AI-classified — keep ai_processed=false until LLM runs.
                // AI classification: ai_processed=true.
                await tx.run(
                    UPDATE('ict.po_lines')
                        .set({
                            ai_processed: markAiProcessed,
                            ai_processed_at: now,
                            ai_reanalysis_needed: false
                        })
                        .where({ po_number: po.po_number, line_item: po.line_item })
                );

                if (markAiProcessed && poIdocErrors.length > 0) {
                    await tx.run(
                        UPDATE('ict.edi856_idoc_errors')
                            .set({
                                ai_processed: true,
                                ai_processed_at: now,
                                exception_type_hint: aiResult.exception_type,
                                ict_exception_id: record.exception_id
                            })
                            .where({ docnum: { in: [...new Set(poIdocErrors.map(e => e.docnum))] } })
                    );
                }
            });

            if (inserted) idState.nextId++;
            return;
        } catch (err) {
            const canRetry = inserted && _isUniqueViolation(err) && attempt < UNIQUE_RETRY_ATTEMPTS;
            if (!canRetry) throw err;
            const row = await cds.tx((tx) => tx.run(SELECT.one.from('ict.exceptions').columns('max(exception_id) as maxId')));
            idState.nextId = (row?.maxId ? parseInt(row.maxId, 10) : 0) + 1;
        }
    }
}

/**
 * Core AI classification + persistence loop, shared by the scheduled batch
 * run and manual PO reprocessing.
 *
 * IMPORTANT: each PO line's DB writes are committed in their OWN short-lived
 * transaction (via cds.tx), and the AI call happens OUTSIDE of any open
 * transaction. This is deliberate — without it, the whole loop would run
 * inside the single long-lived transaction that cds.spawn opens for the
 * background job, holding one DB connection checked out (and, on SQLite,
 * the whole database locked) for the entire batch duration — which is what
 * was blocking all other requests while a job was running.
 *
 * The running counts are written into `log.stats` after every line, and the
 * optional `onProgress(log)` hook is awaited after each line — the manual
 * reprocess flow uses it to persist a live snapshot so the UI can poll for
 * real-time progress. Scheduled runs pass no hook (persist once at the end).
 */
async function _classifyAndPersist(poLines, llmConfig, rules, log, onProgress) {
    log.setModel(llmConfig.provider, llmConfig.model_id);

    const [deliveryWindowDays, partnerFunctions, partnerSuppliers] = await Promise.all([
        loadAiDeliveryWindowDays(),
        loadPartnerFunctions(),
        loadPartnerSuppliers()
    ]);
    const cutoffDate = deliveryWindowCutoffDate(deliveryWindowDays);

    const poNumbers = [...new Set(poLines.map(p => p.po_number))];
    const supplierIds = [...new Set(poLines.map(p => p.supplier_id).filter(Boolean))];
    const materialIds = [...new Set(poLines.map(p => p.material_id).filter(Boolean))];
    const plantCodes = [...new Set(poLines.map(p => p.plant).filter(Boolean))];

    const { asnRecords, suppliers, chrEvents, idocErrors, existingExceptions, maxRow, materials, plants, poPartners } =
        await _loadReferenceData(poNumbers, supplierIds, materialIds, plantCodes);
    const partnersByPo = buildPartnersByPo(poPartners);

    // ── Build lookup maps ───────────────────────────────────────────────────
    const asnByPOLine = summarizeAsnByPoLine(asnRecords);

    const supplierById = {};
    for (const s of suppliers) supplierById[s.supplier] = s;

    const materialById = {};
    for (const m of materials) materialById[m.material] = m;

    const plantById = {};
    for (const p of plants) plantById[p.plant_code] = p;

    const chrByPO = {};
    for (const evt of chrEvents) {
        if (!evt.po_number) continue;
        (chrByPO[evt.po_number] = chrByPO[evt.po_number] || []).push(evt);
    }

    // IDoc errors grouped by PO number, newest status first.
    // (An IDoc error may not resolve to a line item — match on line_item when
    //  present, otherwise treat it as relevant to every line of that PO.)
    const idocByPO = {};
    for (const idoc of idocErrors) {
        if (!idoc.po_number) continue;
        (idocByPO[idoc.po_number] = idocByPO[idoc.po_number] || []).push(idoc);
    }
    for (const key of Object.keys(idocByPO)) {
        idocByPO[key].sort((a, b) =>
            new Date(`${b.status_logdat || b.idoc_credat || 0}`) - new Date(`${a.status_logdat || a.idoc_credat || 0}`)
        );
    }

    const existingByKey = {};
    for (const ex of existingExceptions) {
        const key = `${ex.po_number}_${ex.line_item}`;
        if (!existingByKey[key] || ex.exception_id > existingByKey[key].exception_id) {
            existingByKey[key] = ex;
        }
    }

    // Process AI-ready lines first so batch slots are not consumed by eligibility notes.
    const idocErrorsForLine = (po) => (idocByPO[po.po_number] || []).filter(
        e => !e.line_item || e.line_item === po.line_item
    );
    const chrEventsForPo = (po) => dedupeChrEventsForPo(chrByPO[po.po_number]);

    const buildEligibilityCtx = (po) => ({
        po,
        asn: asnByPOLine[`${po.po_number}_${po.line_item}`] || null,
        latestChr: chrEventsForPo(po)[0] || null,
        idocErrors: idocErrorsForLine(po),
        cutoffDate,
        partnerFunctions,
        partnerSuppliers,
        partnersByPo
    });

    poLines.sort((a, b) => Number(isAiEligible(buildEligibilityCtx(b))) - Number(isAiEligible(buildEligibilityCtx(a))));

    // ── Process each PO line ────────────────────────────────────────────────
    // Lines are processed sequentially: the AI call for each runs OUTSIDE any
    // transaction, and only the tiny per-line write burst is transactional
    // (see _persistClassification). idState carries the next free exception_id.
    // Each line logs exactly one short "[i/N] ..." entry — real progress, not
    // a periodic checkpoint — kept lightweight (plain text, no data payload)
    // so it stays readable even for large batches.
    const idState = { nextId: (maxRow?.maxId ? parseInt(maxRow.maxId, 10) : 0) + 1 };
    let processed = 0, created = 0, updated = 0, skipped = 0, failed = 0;

    // Push the running counts into log.stats so a live snapshot (onProgress)
    // reflects true progress; total_batch_size is set by the caller beforehand.
    const syncStats = () => log.updateStats({
        processed_count: processed, created_count: created,
        updated_count: updated, skipped_count: skipped, error_count: failed
    });

    for (let i = 0; i < poLines.length; i++) {
        const po = poLines[i];
        const step = `[${i + 1}/${poLines.length}]`;
        const poKey = `${po.po_number}_${po.line_item}`;
        const poLabel = `PO ${po.po_number}/${po.line_item}`;

        try {
            const asn = asnByPOLine[poKey] || null;
            const chrEvents = chrEventsForPo(po);
            const latestChr = chrEvents[0] || null;
            const existing = existingByKey[poKey];

            const poIdocErrors = idocErrorsForLine(po);
            const eligibilityCtx = buildEligibilityCtx(po);
            let aiResult = resolveRuleBasedClassification(eligibilityCtx);
            const ruleBased = isRuleBasedResult(aiResult);

            if (ruleBased && isUnchangedRuleBasedClassification(existing, aiResult) && !isStrictTrue(po.ai_reanalysis_needed)) {
                skipped++;
                log.info(`${step} ${poLabel} — unchanged eligibility note`);
                continue;
            }

            const supplierInfo = supplierById[po.supplier_id] || null;
            let enrichedPO = enrichSupplierContacts({
                ...po,
                ibd_qty: asn?.received_qty_so_far ?? po.received_qty_so_far ?? null
            }, supplierInfo);
            const piiLog = isPiiDebugEnabled()
                ? (report) => log.privacyReport(report)
                : undefined;

            if (!ruleBased) {
                const materialInfo = materialById[po.material_id] || null;
                const plantInfo = plantById[po.plant] || null;
                enrichedPO = {
                    ...enrichedPO,
                    material_description: materialInfo?.material_description || 'No description available',
                    plant_name: plantInfo?.plant_name || (po.plant ? `Plant ${po.plant}` : 'Unknown Plant'),
                    Overall_Status: asn?.overall_status || '',
                    Bill_of_Lading: asn?.bill_of_lading || null
                };

                aiResult = await AiService.classify(enrichedPO, rules, llmConfig, poIdocErrors, {
                    piiLog,
                    chrEvents
                });
                if (aiResult?._usage) {
                    log.addUsage(aiResult._usage);
                }
            }

            if (!aiResult) {
                skipped++;
                log.warn(`${step} ${poLabel} — skipped (AI returned no classification)`);
                continue;
            }

            const now = new Date().toISOString();
            const record = buildClassificationRecord({ po, enrichedPO, latestChr, aiResult, now });
            const isNew = !existing;

            await _persistClassification({
                po, record, existing, now, aiResult, poIdocErrors, idState,
                markAiProcessed: !ruleBased
            });

            if (isNew) { created++; } else { updated++; }
            processed++;

            log.info(`${step} ${poLabel} → ${aiResult.exception_type} (${ruleBased ? 'rule-based' : 'AI'}, ${isNew ? 'created' : 'updated'})`);
        } catch (err) {
            failed++;
            log.error(`${step} ${poLabel} — failed: ${err.message}`);
        } finally {
            // Runs for every outcome (processed / skipped / failed): keep the
            // live counts current and let the caller snapshot progress.
            syncStats();
            if (onProgress) {
                try { await onProgress(log); } catch (e) { /* progress persistence is best-effort */ }
            }
        }
    }

    return { processed, created, updated, skipped, failed };
}

async function _persistLogs(log) {
    return persistExecutionLog(log);
}

/**
 * Scheduled batch analysis — processes unprocessed PO lines through the
 * classification pipeline (rule-based Status Report notes or LLM).
 */
async function analyzeExceptions({ jobId, scheduleId, runId }) {
    const log = new LogCollector(runId, scheduleId);

    try {
        if (!jobId && !scheduleId) {
            const err = 'Missing jobId or scheduleId — must be provided via x-sap-job-id / x-sap-job-schedule-id headers.';
            log.failure(err);
            throw new Error(err);
        }

        // ── 1. Resolve job config from DB ────────────────────────────────────
        const jobConfig = await cds.tx(async (tx) => {
            if (jobId) return tx.run(SELECT.one.from('ict.job_schedules').where({ btp_job_id: String(jobId) }));
            return tx.run(SELECT.one.from('ict.job_schedules').where({ btp_schedule_id: String(scheduleId) }));
        });

        if (!jobConfig) {
            const err = `No JobSchedule found for ${jobId ? `btp_job_id: ${jobId}` : `btp_schedule_id: ${scheduleId}`}`;
            log.failure(err);
            throw new Error(err);
        }

        // ── 2. Parse and validate job config JSON ─────────────────────────────
        if (!jobConfig.config) {
            const err = `JobSchedule "${jobConfig.job_name}" has no model configuration`;
            log.failure(err);
            throw new Error(err);
        }

        let nestedConfig;
        try {
            nestedConfig = JSON.parse(jobConfig.config);
        } catch (e) {
            const err = `JobSchedule "${jobConfig.job_name}" invalid config JSON: ${e.message}`;
            log.failure(err);
            throw new Error(err);
        }

        if (!nestedConfig.provider) {
            const err = `JobSchedule "${jobConfig.job_name}" missing provider`;
            log.failure(err);
            throw new Error(err);
        }
        if (!nestedConfig.selectedModelId) {
            const err = `JobSchedule "${jobConfig.job_name}" missing selectedModelId`;
            log.failure(err);
            throw new Error(err);
        }

        const batchSize = jobConfig.batch_size;
        if (!batchSize || batchSize < 1) {
            const err = `JobSchedule "${jobConfig.job_name}" invalid batch_size: ${batchSize}`;
            log.failure(err);
            throw new Error(err);
        }

        // ── 3. Load PO batch ───────────────────────────────────────────────────
        const reanalysisJob = isReanalysisJobType(jobConfig.job_type);
        const batchedPOs = await cds.tx(tx =>
            loadClassificationBatch(tx, { limit: batchSize, jobType: jobConfig.job_type })
        );

        if (batchedPOs.length === 0) {
            const emptyMsg = reanalysisJob
                ? `No PO lines pending reanalysis for job "${jobConfig.job_name}".`
                : `No unprocessed PO lines to analyze for job "${jobConfig.job_name}".`;
            log.success(emptyMsg);
            await _persistLogs(log);
            return { status: 'Success', message: emptyMsg, count: 0 };
        }

        log.updateStats({ total_batch_size: batchedPOs.length });

        // ── 4. Resolve LLM credentials + exception rules ───────────────────────
        const { llmConfig, rules } = await _resolveLlmConfig(nestedConfig, log);

        log.info(
            `Starting ${reanalysisJob ? 'reanalysis' : 'analysis'} — Job "${jobConfig.job_name}" | ` +
            `Model: ${llmConfig.model_id} (${llmConfig.provider}, ${llmConfig.inference_option || 'FEW_SHOT'}) | ` +
            `Rules: ${rules.length} | Batch: ${batchedPOs.length} line(s)`
        );

        await _persistLogs(log);

        // ── 5. Classify + persist (stats are kept live inside the loop) ─────────
        const result = await _classifyAndPersist(batchedPOs, llmConfig, rules, log);

        const isTotalFailure = result.failed > 0 && result.processed === 0;
        log.finish(isTotalFailure ? 'FAILURE' : 'SUCCESS');
        const message = log.getSummary(); // status/duration are final now, so this is accurate
        if (isTotalFailure) {
            log.errorMessage = message;
            log.error(message);
        } else {
            log.info(message);
        }
        await _persistLogs(log);

        return { status: result.failed > 0 ? 'Partial' : 'Success', message, count: result.processed };

    } catch (err) {
        if (log.status === 'RUNNING') {
            log.systemError(err.message, err);
        }
        await _persistLogs(log);
        throw err;
    }
}

/**
 * Loads PO lines for scheduled AI or manual reprocess.
 */
async function loadClassificationBatchForJob(options = {}) {
    return cds.tx(tx => loadClassificationBatch(tx, options));
}

function register(srv) {
    srv.on('analyzeExceptions', (req) => {
        const jobId = req.data?.jobId
            || req.headers?.['x-sap-job-id']
            || req.http?.req?.headers?.['x-sap-job-id'];
        const scheduleId = req.data?.scheduleId
            || req.headers?.['x-sap-job-schedule-id']
            || req.http?.req?.headers?.['x-sap-job-schedule-id'];
        const runId = req.data?.runId
            || req.headers?.['x-sap-job-run-id']
            || req.http?.req?.headers?.['x-sap-job-run-id']
            || `run_${Date.now()}`;

        if (!jobId && !scheduleId) {
            req.error(400, 'Missing jobId or scheduleId — pass in POST body or x-sap-job-id / x-sap-job-schedule-id header.');
            return;
        }

        // ── Spawn background analysis — respond immediately to avoid CF 60s timeout ──
        cds.spawn({ every: false }, async () => {
            try {
                await analyzeExceptions({ jobId, scheduleId, runId });
            } catch (err) {
                console.error('[ExceptionAnalyzer] Background error:', err.message);
            }
        });

        return { status: 'Accepted', message: 'Analysis started in background', count: 0 };
    });
}

module.exports = {
    register,
    analyzeExceptions,
    loadClassificationBatch: loadClassificationBatchForJob,
    _resolveLlmConfig,
    _classifyAndPersist,
    _persistLogs
};

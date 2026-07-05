'use strict';

const cds = require('@sap/cds');
const AiService = require('../lib/AiService');
const { decrypt } = require('../lib/crypto-utils');

async function analyzeExceptions({ jobId, scheduleId }) {
    console.log(`[ExceptionAnalyzer] Starting... jobId=${jobId} scheduleId=${scheduleId}`);
    const db = await cds.connect.to('db');

    // ── 1. Resolve job config from DB ────────────────────────────────────────
    let jobConfig = null;

    if (jobId) {
        jobConfig = await db.run(SELECT.one.from('ict.job_schedules').where({ btp_job_id: String(jobId) }));
        if (!jobConfig) throw new Error(`No JobSchedule found for btp_job_id: ${jobId}`);
    } else if (scheduleId) {
        jobConfig = await db.run(SELECT.one.from('ict.job_schedules').where({ btp_schedule_id: String(scheduleId) }));
        if (!jobConfig) throw new Error(`No JobSchedule found for btp_schedule_id: ${scheduleId}`);
    } else {
        throw new Error('Missing jobId or scheduleId — must be provided via x-sap-job-id / x-sap-job-schedule-id headers.');
    }

    // ── 2. Parse and validate job config JSON ─────────────────────────────────
    if (!jobConfig.config) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" has no model configuration (config field is empty). Please save the configuration from the dashboard first.`);
    }

    let nestedConfig;
    try {
        nestedConfig = JSON.parse(jobConfig.config);
    } catch (e) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" has an invalid config JSON: ${e.message}`);
    }

    if (!nestedConfig.provider) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" config is missing required field: provider`);
    }
    if (!nestedConfig.selectedModelId) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" config is missing required field: selectedModelId`);
    }

    const batchSize = jobConfig.batch_size;
    if (!batchSize || batchSize < 1) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" has an invalid batch_size: ${batchSize}`);
    }

    // ── 3. Load PO batch (Only process POs that have associated ASNs) ─────────
    const batchedPOs = await db.run(
        SELECT.from('ict.po_lines as po')
            .where({ ai_processed: false })
            .and(`exists (select 1 from ict.asn_ibd as asn where asn.reference_document = po.po_number and asn.reference_item = po.line_item)`)
            .limit(batchSize)
    );

    if (batchedPOs.length === 0) {
        console.log('[ExceptionAnalyzer] No unprocessed PO lines found.');
        return { status: 'Success', message: 'No unprocessed PO lines.', count: 0 };
    }

    const poNumbers = [...new Set(batchedPOs.map(p => p.po_number))];
    const supplierIds = [...new Set(batchedPOs.map(p => p.supplier_id).filter(Boolean))];

    // ── 4. Fetch LLM credentials + reference data ─────────────────────────────
    const providerName = nestedConfig.provider.toUpperCase();
    const [activeProviderCreds, rules, asnRecords, suppliers, chrEvents, idocErrors, existingExceptions, maxRow] = await Promise.all([
        db.run(SELECT.one.from('ict.llm_configs').where({ provider: providerName })),
        db.run(SELECT.from('ict.exception_rules')),
        db.run(SELECT.from('ict.asn_ibd').where({ reference_document: { in: poNumbers } })),
        supplierIds.length
            ? db.run(SELECT.from('ict.suppliers').where({ supplier: { in: supplierIds } }))
            : Promise.resolve([]),
        db.run(SELECT.from('ict.chr_events').where({ po_number: { in: poNumbers } })),
        db.run(SELECT.from('ict.edi856_idoc_errors').where({ po_number: { in: poNumbers } })),
        db.run(SELECT.from('ict.exceptions').where({ po_number: { in: poNumbers } })),
        db.run(SELECT.one.from('ict.exceptions').columns('max(exception_id) as maxId'))
    ]);

    // ── 5. Validate LLM credentials ───────────────────────────────────────────
    if (!activeProviderCreds) {
        throw new Error(`No LLM configuration found for provider "${providerName}". Please add credentials in the LLM Config tab.`);
    }
    if (!activeProviderCreds.api_key) {
        throw new Error(`LLM configuration for "${providerName}" is missing an API key. Please save a valid API key in the LLM Config tab.`);
    }

    const decryptedApiKey = decrypt(activeProviderCreds.api_key);
    if (!decryptedApiKey) {
        throw new Error(`Failed to decrypt the API key for provider "${providerName}". The key may be corrupted or the ENCRYPTION_SECRET may have changed.`);
    }

    if (rules.length === 0) {
        throw new Error('No ExceptionRules found in the database. Please seed the exception rules before running analysis.');
    }

    // ── 6. Build llmConfig ────────────────────────────────────────────────────
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

    console.log(`[ExceptionAnalyzer] jobId=${jobId} scheduleId=${scheduleId} | Job: "${jobConfig.job_name}" | Batch: ${batchedPOs.length} | Model: ${llmConfig.model_id} (${llmConfig.provider}) | Rules: ${rules.length}`);

    // ── 7. Build lookup maps ───────────────────────────────────────────────────
    const asnByPOLine = {};
    for (const asn of asnRecords) {
        const key = `${asn.reference_document}_${asn.reference_item}`;
        if (!asnByPOLine[key]) asnByPOLine[key] = asn;
    }

    const supplierById = {};
    for (const s of suppliers) supplierById[s.supplier] = s;

    const chrByPO = {};
    for (const evt of chrEvents) {
        if (!evt.po_number) continue;
        (chrByPO[evt.po_number] = chrByPO[evt.po_number] || []).push(evt);
    }
    for (const key of Object.keys(chrByPO)) {
        chrByPO[key].sort((a, b) => new Date(b.activity_date) - new Date(a.activity_date));
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
        existingByKey[`${ex.po_number}_${ex.line_item}`] = ex;
    }

    // ── 8. Process each PO line ───────────────────────────────────────────────
    let nextId = (maxRow?.maxId ? parseInt(maxRow.maxId, 10) : 0) + 1;
    let processed = 0, created = 0, updated = 0, skipped = 0;

    for (const po of batchedPOs) {
        const poKey = `${po.po_number}_${po.line_item}`;
        const asn = asnByPOLine[poKey] || null;
        const latestChr = (chrByPO[po.po_number] || [])[0] || null;
        const existing = existingByKey[poKey];

        // IDoc errors for this PO line: exact line match, or PO-level (no line item)
        const poIdocErrors = (idocByPO[po.po_number] || []).filter(
            e => !e.line_item || e.line_item === po.line_item
        );

        const enrichedPO = {
            ...po,
            supplier_name: supplierById[po.supplier_id]?.name || `Supplier ${po.supplier_id}`,
            Overall_Status: asn?.overall_status || '',
            Delivery_Quantity: asn?.delivery_quantity || 0,
            Bill_of_Lading: asn?.bill_of_lading || null
        };

        // AI classification — errors thrown here propagate up and abort the batch
        const aiResult = await AiService.classify(enrichedPO, latestChr, rules, llmConfig, poIdocErrors);
        if (!aiResult) {
            console.warn(`[ExceptionAnalyzer] AI returned no result for PO ${po.po_number}/${po.line_item} — skipping.`);
            skipped++;
            continue;
        }

        const now = new Date().toISOString();
        const record = {
            po_number: po.po_number,
            line_item: po.line_item,
            material_id: po.material_id,
            supplier_id: po.supplier_id,
            supplier_name: enrichedPO.supplier_name,
            plant: po.plant,
            po_qty: po.po_qty,
            open_qty: (po.po_qty || 0) - (po.gr_qty || 0),
            delivery_date: po.delivery_date,
            ibd_qty: asn?.delivery_quantity || 0,
            chr_status: latestChr?.status || '',
            exception_type: aiResult.exception_type,
            priority: aiResult.priority,
            priority_score: parseInt(aiResult.priority_score, 10),
            panel: aiResult.panel,
            recommendation: aiResult.recommendation,
            evidence: aiResult.evidence || '',
            confidence: aiResult.confidence,
            classified_at: now
        };

        let exceptionId;
        if (existing) {
            await db.run(UPDATE('ict.exceptions').set(record).where({ exception_id: existing.exception_id }));
            exceptionId = existing.exception_id;
            updated++;
        } else {
            record.exception_id = nextId++;
            await db.run(INSERT.into('ict.exceptions').entries(record));
            exceptionId = record.exception_id;
            created++;
        }

        await db.run(
            UPDATE('ict.po_lines')
                .set({ ai_processed: true, ai_processed_at: now })
                .where({ po_number: po.po_number, line_item: po.line_item })
        );

        // Link the IDoc errors that informed this classification back to the exception
        if (poIdocErrors.length > 0) {
            await db.run(
                UPDATE('ict.edi856_idoc_errors')
                    .set({
                        ai_processed: true,
                        ai_processed_at: now,
                        exception_type_hint: aiResult.exception_type,
                        ict_exception_id: exceptionId
                    })
                    .where({
                        docnum: { in: [...new Set(poIdocErrors.map(e => e.docnum))] }
                    })
            );
        }

        processed++;
        console.log(`[ExceptionAnalyzer] [${processed}/${batchedPOs.length}] ${poKey} → ${aiResult.exception_type} (${aiResult.priority})`);
    }

    const message = `Processed: ${processed}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}.`;
    console.log(`[ExceptionAnalyzer] Done. ${message}`);
    return { status: 'Success', message, count: processed };
}

function register(srv) {
    srv.on('analyzeExceptions', (req) => {
        // ── Extract BTP Job Scheduler headers before request context closes ──
        const jobId = req.headers?.['x-sap-job-id'] || req.http?.req?.headers?.['x-sap-job-id'];
        const scheduleId = req.headers?.['x-sap-job-schedule-id'] || req.http?.req?.headers?.['x-sap-job-schedule-id'];

        if (!jobId && !scheduleId) {
            req.error(400, 'Missing x-sap-job-id or x-sap-job-schedule-id header.');
            return;
        }

        // ── Spawn background analysis — respond immediately to avoid CF 60s timeout ──
        cds.spawn({ every: false }, async () => {
            try {
                await analyzeExceptions({ jobId, scheduleId });
            } catch (err) {
                console.error('[ExceptionAnalyzer] Background error:', err.message);
            }
        });

        return { status: 'Accepted', message: 'Analysis started in background', count: 0 };
    });
}

module.exports = { register };

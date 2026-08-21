'use strict';

/**
 * Reprocess Handler — manual, on-demand AI re-classification.
 *
 * Reuses the same classification pipeline as the scheduled analyzer
 * (_resolveLlmConfig / loadClassificationBatch / _classifyAndPersist).
 */

const cds = require('@sap/cds');
const LogCollector = require('../lib/LogCollector');
const {
    _resolveLlmConfig,
    _classifyAndPersist,
    _persistLogs,
    loadClassificationBatch
} = require('./exception-analyzer');

async function runReprocessing({ runId, poNumbers, config }) {
    const log = new LogCollector(runId, null);

    try {
        const batchedPOs = await loadClassificationBatch({ poNumbers });

        if (batchedPOs.length === 0) {
            log.success(`No eligible PO lines found for: ${poNumbers.join(', ')}. Nothing to reprocess.`);
            await _persistLogs(log);
            return;
        }

        log.updateStats({ total_batch_size: batchedPOs.length });

        const { llmConfig, rules } = await _resolveLlmConfig(config, log);

        log.info(
            `Starting manual reprocess — PO(s): ${poNumbers.join(', ')} | ` +
            `Model: ${llmConfig.model_id} (${llmConfig.provider}, ${llmConfig.inference_option || 'FEW_SHOT'}) | ` +
            `Rules: ${rules.length} | Batch: ${batchedPOs.length} line(s)`
        );

        await _persistLogs(log);

        let lastPersist = 0;
        const onProgress = async () => {
            if (log.status !== 'RUNNING') {
                return;
            }
            const now = Date.now();
            if (now - lastPersist >= 800) {
                lastPersist = now;
                await _persistLogs(log);
            }
        };

        const result = await _classifyAndPersist(batchedPOs, llmConfig, rules, log, onProgress);

        const isTotalFailure = result.failed > 0 && result.processed === 0;
        log.finish(isTotalFailure ? 'FAILURE' : 'SUCCESS');
        const message = log.getSummary();
        if (isTotalFailure) {
            log.errorMessage = message;
            log.error(message);
        } else {
            log.info(message);
        }
        await _persistLogs(log);

    } catch (err) {
        if (log.status === 'RUNNING') {
            log.systemError(err.message, err);
        }
        await _persistLogs(log);
        console.error('[ReprocessHandler] Reprocess error:', err.message);
    }
}

function register(srv) {
    srv.on('reprocessPOs', (req) => {
        const { poNumbers, config } = req.data;

        if (!Array.isArray(poNumbers) || poNumbers.length === 0) {
            req.error(400, 'Please select at least one PO number to reprocess.');
            return;
        }

        const cleanPoNumbers = [];
        for (const p of poNumbers) {
            const s = (p || '').toString().trim();
            if (s) cleanPoNumbers.push(s);
        }
        if (cleanPoNumbers.length === 0) {
            req.error(400, 'No valid PO numbers provided.');
            return;
        }

        let parsedConfig;
        try {
            parsedConfig = typeof config === 'string' ? JSON.parse(config) : config;
        } catch (e) {
            req.error(400, `Invalid config payload: ${e.message}`);
            return;
        }
        if (!parsedConfig || !parsedConfig.provider || !parsedConfig.selectedModelId) {
            req.error(400, 'Reprocess configuration must include a provider and a selected model.');
            return;
        }

        const runId = `reprocess_${Date.now()}`;

        cds.spawn({ every: false }, async () => {
            await runReprocessing({ runId, poNumbers: cleanPoNumbers, config: parsedConfig });
        });

        return {
            status: 'Accepted',
            runId,
            message: `Reprocessing ${cleanPoNumbers.length} PO(s) started.`
        };
    });

    console.log('[ReprocessHandler] Manual reprocess endpoint registered.');
}

module.exports = { register };

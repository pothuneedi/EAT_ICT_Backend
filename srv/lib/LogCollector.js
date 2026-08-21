'use strict';

const { formatRunSummary, formatAiAnalysisSummary, isSyncJobType, inferJobType } = require('./execution-log-presenter');

// Production DB column is VARCHAR(255).
const MAX_ERROR_MESSAGE_LEN = 250;

function truncateText(value, maxLen) {
    const text = String(value ?? '');
    return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

/**
 * LogCollector — Collects structured logs during job execution.
 * Instead of console.log fire-and-forget, logs are accumulated in memory
 * and persisted to the database after the job completes.
 */
class LogCollector {
    constructor(runId, scheduleId) {
        this.runId = runId;
        this.scheduleId = scheduleId;
        this.entries = [];
        this.startTime = new Date();
        this.endTime = null;
        this.status = 'RUNNING'; // RUNNING | SUCCESS | FAILURE | ERROR
        this.errorMessage = null;

        // Counters
        this.stats = {
            total_batch_size: 0,
            processed_count: 0,
            created_count: 0,
            updated_count: 0,
            skipped_count: 0,
            error_count: 0
        };

        // Which model produced this run (dimensions for usage analytics)
        this.model_id = null;
        this.provider = null;

        // Token usage aggregated across every AI call in the run
        this.usage = {
            ai_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            reasoning_tokens: 0,
            cached_input_tokens: 0
        };
    }

    /** Records which provider/model this run used — a dimension for analytics. */
    setModel(provider, modelId) {
        this.provider = provider || null;
        this.model_id = modelId || null;
    }

    /** Accumulates one AI call's normalized token usage into the run total. */
    addUsage(u) {
        if (!u) return;
        this.usage.ai_calls += 1;
        this.usage.input_tokens += u.input_tokens || 0;
        this.usage.output_tokens += u.output_tokens || 0;
        this.usage.total_tokens += u.total_tokens || 0;
        this.usage.reasoning_tokens += u.reasoning_tokens || 0;
        this.usage.cached_input_tokens += u.cached_input_tokens || 0;
    }

    /**
     * Privacy audit block for exception analysis — printed as-is (no run prefix)
     * so business users can read anonymized vs restored supplier data clearly.
     */
    privacyReport(report) {
        const text = String(report || '').trim();
        if (!text) {
            return;
        }
        this.entries.push({
            level: 'INFO',
            timestamp: new Date().toISOString(),
            message: text,
            data: null
        });
        console.log(`\n${text}\n`);
    }

    /**
     * Log an info message
     */
    info(message, data = null) {
        this.entries.push({
            level: 'INFO',
            timestamp: new Date().toISOString(),
            message,
            data
        });
        console.log(`[Run ${this.runId}] [INFO] ${message}`, data || '');
    }

    /**
     * Log a warning
     */
    warn(message, data = null) {
        this.entries.push({
            level: 'WARN',
            timestamp: new Date().toISOString(),
            message,
            data
        });
        console.warn(`[Run ${this.runId}] [WARN] ${message}`, data || '');
    }

    /**
     * Log an error
     */
    error(message, data = null) {
        this.entries.push({
            level: 'ERROR',
            timestamp: new Date().toISOString(),
            message,
            data
        });
        console.error(`[Run ${this.runId}] [ERROR] ${message}`, data || '');
    }

    /**
     * Mark execution as completed successfully
     */
    success(message = 'Execution completed successfully') {
        this.status = 'SUCCESS';
        this.endTime = new Date();
        this.info(message);
    }

    /**
     * Mark execution as failed
     */
    failure(message) {
        this.status = 'FAILURE';
        this.endTime = new Date();
        this.errorMessage = message;
        this.error(message);
    }

    /**
     * Mark execution as errored (unexpected exception)
     */
    systemError(message, error) {
        this.status = 'ERROR';
        this.endTime = new Date();
        this.errorMessage = message;
        this.error(message, { errorType: error?.name, errorMsg: error?.message });
    }

    /**
     * Update statistics (call after processing)
     */
    updateStats(stats) {
        Object.assign(this.stats, stats);
    }

    /**
     * Finalizes status/endTime WITHOUT logging an entry. Call this before
     * building the final summary (getSummary()) so it reflects the true end
     * state and duration — calling success()/failure() first and building the
     * summary from their message would otherwise bake in the stale
     * "RUNNING" status and an unset duration, since those setters log
     * immediately with whatever message was already computed.
     */
    finish(status, errorMessage = null) {
        this.status = status; // 'SUCCESS' | 'FAILURE' | 'ERROR'
        this.endTime = new Date();
        if (errorMessage) this.errorMessage = errorMessage;
    }

    /**
     * Snapshot of the run as a database record. Safe to call repeatedly for
     * live progress: while the run is in flight status is 'RUNNING' and
     * completed_at is null; once finish() runs, both reflect the real end state.
     */
    getLogRecord() {
        return {
            runId: this.runId,
            schedule_ID: this.scheduleId,
            status: this.status,
            started_at: this.startTime.toISOString(),
            completed_at: this.endTime ? this.endTime.toISOString() : null,
            log_entries: JSON.stringify(this.entries),
            error_message: this.errorMessage
                ? truncateText(this.errorMessage, MAX_ERROR_MESSAGE_LEN)
                : null,
            model_id: this.model_id,
            provider: this.provider,
            ...this.stats,
            ...this.usage
        };
    }

    /**
     * Get summary as a single readable sentence (for messaging).
     * Call finish() first so status/duration reflect the true end state.
     */
    getSummary() {
        const record = {
            status: this.status,
            started_at: this.startTime,
            completed_at: this.endTime,
            error_message: this.errorMessage,
            provider: this.provider,
            duration_sec: this.endTime
                ? Math.round((this.endTime - this.startTime) / 1000)
                : 0,
            ...this.stats,
            ...this.usage
        };

        if (isSyncJobType(inferJobType(record))) {
            return formatRunSummary(record);
        }

        return formatAiAnalysisSummary(record);
    }
}

module.exports = LogCollector;

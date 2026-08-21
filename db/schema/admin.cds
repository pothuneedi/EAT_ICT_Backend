namespace ict;

using { cuid } from '@sap/cds/common';

/**
 * Persists the active configuration for LLM inference.
 * Each provider (e.g. BEDROCK, OPENAI, GEMINI, ANTHROPIC) has its own config row.
 */
entity llm_configs {
    key provider   : String(50);      // e.g. OPENAI, GEMINI, ANTHROPIC
        api_key    : String(500);     // Authentication credential (stored at rest)
        model_ids  : LargeString not null; // JSON array of all supported model IDs for this provider
        updated_at : Timestamp default $now;
}

/**
 * Job Scheduling Configurations
 */
entity job_schedules : cuid {
    job_name        : String(100) not null;
    job_type        : String(40) not null default 'AI_ANALYSIS'; // AI_ANALYSIS | AI_REANALYSIS | S4_MASTER_SYNC | S4_TRANSACTIONAL_SYNC | S4_CHR_SYNC
    schedule_pattern : String(30) not null default 'CRON'; // ONE_TIME | CRON | REPEAT_INTERVAL | REPEAT_AT
    schedule_value   : String(255); // BTP schedule payload (cron, repeatInterval, repeatAt, time)
    cron_expression : String(100); // Legacy / CRON mirror — kept in sync when schedule_pattern = CRON
    batch_size      : Integer not null default 5;
    is_active       : Boolean not null default true;
    btp_job_id      : String(255); // Reference ID of the job in SAP BTP Job Scheduler
    btp_schedule_id : String(255); // Reference ID of the schedule in SAP BTP Job Scheduler
    config          : LargeString; // AI: { provider, selectedModelId, ... } | Sync: { lookbackDays, customer, lookbackMinutes, ... }
    last_run_at     : Timestamp;
    next_run_at     : Timestamp;
    created_at      : Timestamp default $now;
    logs            : Composition of many execution_logs on logs.schedule = $self;
}

/**
 * Execution Logs — stores detailed logs from each job run, keyed by BTP runId
 */
entity execution_logs {
    key runId           : String;           // BTP run ID
        schedule        : Association to job_schedules;
        status          : String;           // SUCCESS | FAILURE | ERROR
        started_at      : Timestamp;
        completed_at    : Timestamp;

        // Summary metrics
        total_batch_size    : Integer;      // Total PO lines in batch
        processed_count     : Integer;      // Successfully processed
        created_count       : Integer;      // New exceptions created
        updated_count       : Integer;      // Existing exceptions updated
        skipped_count       : Integer;      // Skipped (no AI result)
        error_count         : Integer;      // Failed (DB/AI errors)

        // ── AI usage analytics (dimensions + token totals for this run) ──
        model_id            : String(100);  // e.g. gpt-5.5, claude-opus-4-8
        provider            : String(50);   // OPENAI | GEMINI | ANTHROPIC
        ai_calls            : Integer;       // number of LLM classification calls
        input_tokens        : Integer;       // Σ prompt/input tokens
        output_tokens       : Integer;       // Σ completion/output tokens
        total_tokens        : Integer;       // Σ total tokens
        reasoning_tokens    : Integer;       // Σ reasoning tokens (reasoning models)
        cached_input_tokens : Integer;       // Σ cached input tokens read (cheaper)

        // Detailed logs: array of {level, timestamp, message}
        log_entries     : LargeString;      // JSON array of log objects
        error_message   : String;           // Overall error if status=ERROR
}

// Indexes for efficient querying + usage analytics grouping
annotate execution_logs with {
    schedule @cds.index;
    status @cds.index;
    started_at @cds.index;
    provider @cds.index;
    model_id @cds.index;
}

/**
 * Admin runtime configuration (AI context, comparison rules, etc.).
 * value is JSON — array (comma-separated in UI) or object (key/value form in UI).
 */
entity config {
    key ID          : String(50);
        config_type : String(50) not null;
        description : String(500);
        value       : LargeString not null;
}

annotate config with {
    config_type @cds.index;
};


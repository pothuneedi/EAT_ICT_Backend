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
    cron_expression : String(100); // e.g., '0 */2 * * *' (every 2 hours)
    batch_size      : Integer not null default 5;
    is_active       : Boolean not null default true;
    btp_job_id      : String(255); // Reference ID of the job in SAP BTP Job Scheduler
    btp_schedule_id : String(255); // Reference ID of the schedule in SAP BTP Job Scheduler
    config          : LargeString; // JSON: { provider, selectedModelId, inference_option, temperature, max_tokens, top_p, system_prompt }
    last_run_at     : Timestamp;
    next_run_at     : Timestamp;
    created_at      : Timestamp default $now;
}

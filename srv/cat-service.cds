using { ict } from '../db/schema';

@title: 'Mammoth Brands Inbound Control Tower (ICT) API'
@Description: 'Exposes OData endpoints and analytical services to track logistics entities, carrier events, and supply chain exceptions.'
// Protected: every request must carry a valid OAuth 2.0 / JWT token issued by the
// bound XSUAA instance. Approuter / destination flows (OAuth2UserTokenExchange,
// OAuth2ClientCredentials, OAuth2JWTBearer) all satisfy this.
@requires: 'authenticated-user'
service CatalogService {
  // ============================================
  // ENTITIES - Full CRUD Support
  // ============================================

  entity Plants as select from ict.plants;
  entity Materials as select from ict.materials;
  entity Suppliers as select from ict.suppliers;
  entity POLines as select from ict.po_lines;
  entity POPartners as select from ict.po_partners;
  entity ASNIbd as select from ict.asn_ibd;
  entity CHREvents as select from ict.chr_events;
  entity Exceptions as select from ict.exceptions;
  entity AIFeedback as select from ict.ai_feedback;
  entity ExceptionRules as select from ict.exception_rules;
  entity LLMConfigs as select from ict.llm_configs;
  entity JobSchedules as select from ict.job_schedules;
  entity ExecutionLogs as select from ict.execution_logs;
  entity Config as select from ict.config;
  entity IDocErrors as select from ict.edi856_idoc_errors;




  // ============================================
  // TYPES
  // ============================================

  type POStatus {
    po_number: String;
    total_lines: Integer;
    open_lines: Integer;
    closed_lines: Integer;
    status: String;
  }

  type ExceptionSummary {
    total_po_lines: Integer;
    pending_analysis: Integer;
    total_exceptions: Integer;
    high_priority: Integer;
    medium_priority: Integer;
    low_priority: Integer;
    action_required: Integer;
    status_report: Integer;
  }

  type SupplyChainMetrics {
    total_pos: Integer;
    on_time_delivery: Decimal;
    exception_rate: Decimal;
    avg_lead_time_days: Decimal;
    total_asns: Integer;
    completed_asns: Integer;
  }

  type DashboardMetrics {
    total_po_lines: Integer;
    pending_analysis: Integer;
    idoc_errors: Integer;
    action_required: Integer;
    status_report: Integer;
    ibd_creation_required: Integer;
    high_priority: Integer;
    medium_priority: Integer;
    low_priority: Integer;
  }

  type DashboardTimelineBucket {
    bucketKey: String;
    count: Integer;
  }

  type DashboardPlantRow {
    plant: String;
    plantName: String;
    count: Integer;
  }

  type DashboardRootCauseRow {
    exceptionType: String;
    count: Integer;
  }

  type DashboardAnalytics {
    metrics: DashboardMetrics;
    deliveryTimeline: array of DashboardTimelineBucket;
    plants: array of DashboardPlantRow;
    rootCauses: array of DashboardRootCauseRow;
  }

  type AnalysisResult {
    status: String;
    message: String;
    count: Integer;
  }

  // ── AI usage analytics ───────────────────────────────────────────────────
  // One aggregated row: a provider, a model, or a day (`key` holds the label).
  type AiUsageBucket {
    label               : String;   // provider name | model id | 'YYYY-MM-DD'
    runs                : Integer;
    ai_calls            : Integer;
    input_tokens        : Integer;
    output_tokens       : Integer;
    reasoning_tokens    : Integer;
    cached_input_tokens : Integer;
    total_tokens        : Integer;
  }

  type AiUsageAnalytics {
    fromDate                  : Date;
    toDate                    : Date;
    total_runs                : Integer;
    total_ai_calls            : Integer;
    total_input_tokens        : Integer;
    total_output_tokens       : Integer;
    total_reasoning_tokens    : Integer;
    total_cached_input_tokens : Integer;
    total_tokens              : Integer;
    byProvider                : array of AiUsageBucket;
    byModel                   : array of AiUsageBucket;
    daily                     : array of AiUsageBucket;
  }

  // ── AI feedback analytics ────────────────────────────────────────────────
  type AiFeedbackTypeBucket {
    label             : String;
    count             : Integer;
    helpful           : Integer;
    not_helpful       : Integer;
    not_helpful_pct   : Decimal;
  }

  type AiFeedbackRatingBucket {
    label : String;
    count : Integer;
  }

  type AiFeedbackDailyBucket {
    label       : String;
    count       : Integer;
    helpful     : Integer;
    not_helpful : Integer;
  }

  type AiFeedbackAnalytics {
    fromDate            : Date;
    toDate              : Date;
    total               : Integer;
    helpful             : Integer;
    not_helpful         : Integer;
    helpful_pct         : Decimal;
    not_helpful_pct     : Decimal;
    with_comments       : Integer;
    unique_exceptions   : Integer;
    byExceptionType     : array of AiFeedbackTypeBucket;
    byRating            : array of AiFeedbackRatingBucket;
    daily               : array of AiFeedbackDailyBucket;
  }

  type UploadRowError {
    row: Integer;      // 0-based data row index in the uploaded file
    column: String;    // offending column (empty = whole-row DB error)
    message: String;
  }

  type UploadResult {
    status: String;    // Success | Partial | Failed
    total: Integer;
    inserted: Integer;
    updated: Integer;
    failed: Integer;
    errors: array of UploadRowError;
  }

  type DeleteResult {
    status: String;    // Success | Partial | Failed
    total: Integer;
    deleted: Integer;
    failed: Integer;
    errors: array of UploadRowError;
  }

  type IbdCreationLine {
    po_number: String;
    line_item: String;
    supplier_id: String;
    supplier_name: String;
    material_id: String;
    plant: String;
    plant_name: String;
    po_qty: Decimal;
    chr_qty: Decimal;
    delivery_date: Timestamp;
    chr_eta: Timestamp;
    chr_status: String;
    reference: String;
    bill_of_lading: String;
  }

  type IbdCreationReport {
    totalCount: Integer;
    lines: array of IbdCreationLine;
  }

  type IbdDownloadWarning {
    po_number: String;
    line_item: String;
    message: String;
  }

  type IbdUploadDownloadResult {
    fileName: String;
    contentType: String;
    fileContent: LargeString;
    includedCount: Integer;
    excludedCount: Integer;
    warnings: array of IbdDownloadWarning;
  }

  // ============================================
  // CUSTOM ACTIONS & FUNCTIONS
  // ============================================

  function getActiveOrders() returns { value: array of POStatus };
  function getExceptionSummary() returns { value: ExceptionSummary };
  function getSupplyChainMetrics() returns { value: SupplyChainMetrics };
  @description: 'Aggregated AI token-usage analytics over a date range, broken down by provider, model, and day.'
  function getAiUsageAnalytics(fromDate: Date, toDate: Date) returns AiUsageAnalytics;
  @description: 'Aggregated AI feedback analytics over a date range, broken down by exception type, rating, and day.'
  function getAiFeedbackAnalytics(fromDate: Date, toDate: Date) returns AiFeedbackAnalytics;
  @description: 'Dashboard KPIs and chart aggregates with optional filters aligned to the UI filter bar.'
  function getDashboardAnalytics(
    plant: String,
    deliveryDateFrom: String,
    deliveryDateTo: String,
    priority: String,
    exceptionType: String,
    search: String
  ) returns DashboardAnalytics;

  @description: 'PO lines that need inbound delivery creation: open PO, CHR in transit, no IBD in S/4.'
  function getIbdCreationReport(
    plant: String,
    search: String
  ) returns IbdCreationReport;

  @description: 'Builds a pre-filled IBD upload Excel file for the selected PO lines. selection is JSON: [{po_number,line_item,storage_location}].'
  action downloadIbdUploadTemplate(
    selection: LargeString
  ) returns IbdUploadDownloadResult;

  type ChatResponse {
    messages: LargeString;
  }

  @description: 'Conversational ICT assistant with tool access to PO lines, exceptions, and analytics.'
  action chat(
    messages: LargeString,
    context: LargeString
  ) returns ChatResponse;

  @requires: 'JobScheduler'
  @description: 'AI-powered exception analysis - analyzes PO lines using a JobSchedules config (POST). AI_ANALYSIS: new lines; AI_REANALYSIS: lines flagged after sync. Pass jobId or scheduleId in body or x-sap-job-* headers.'
  action analyzeExceptions(
    jobId: String,
    scheduleId: String,
    runId: String
  ) returns AnalysisResult;

  @requires: 'JobScheduler'
  @description: 'BTP Job Scheduler callback for S/4 + CHR sync schedules (job_type on JobSchedules). POST — pass jobId or scheduleId in body or x-sap-job-* headers.'
  action runScheduledSync(
    jobId: String,
    scheduleId: String,
    runId: String
  ) returns AnalysisResult;

  @description: 'Bulk CSV upload for testing — validates rows and returns per-row errors'
  action uploadTableData(
    tableName: String,   // POLines | POPartners | ASNIbd | CHREvents | Plants | Materials | Suppliers | Exceptions | ExceptionRules | IDocErrors
    rows: LargeString,   // JSON array of row objects
    upsert: Boolean      // true = update existing records on key conflict
  ) returns UploadResult;

  @description: 'Re-runs AI exception classification for the given PO numbers in the background. Returns a runId — poll ExecutionLogs(runId) for live progress and the final per-line result.'
  action reprocessPOs(
    poNumbers: many String,   // PO numbers to reprocess (all ASN-backed lines of each)
    config: LargeString       // JSON LLM config { provider, selectedModelId, inference_option, temperature, max_tokens, top_p, system_prompt }
  ) returns {
    status: String;
    runId: String;
    message: String;
  };

  @description: 'Enhances an exception rule trigger condition or recommendation pattern with AI instructions for higher accuracy.'
  action enhanceExceptionRuleContent(
    textType: String, // TRIGGER_CONDITION | AI_RECOMMENDATION_PATTERN
    text: String,
    ruleContext: LargeString
  ) returns {
    enhancedText: String;
  };

  @description: 'Deletes records by key from a whitelisted table (testing tool)'
  action deleteTableRows(
    tableName: String,   // same whitelist as uploadTableData
    rows: LargeString    // JSON array of row objects; each must contain all key fields
  ) returns DeleteResult;

  @description: 'Column metadata and read-only flag for Manage Data (readOnly from MANAGE_DATA_READ_ONLY env)'
  function getUploadTableMeta() returns LargeString;

  @description: 'S/4HANA master data → PostgreSQL: plants, materials, suppliers. Schedule monthly/quarterly.'
  action syncMasterData() returns String;

  @description: 'S/4HANA transactional data → PostgreSQL: po_lines, po_partners, asn_ibd, idoc_errors. fromDate/toDate scope po_lines (default last 30 days). Schedule hourly/daily.'
  action syncTransactionalData(fromDate: Date, toDate: Date) returns String;

  @description: 'CHR Navisphere → PostgreSQL: chr_events. customer (required) and lookbackMinutes filter client-side (lookback default CHR_EVENTS_LOOKBACK_MINUTES or 90).'
  action syncChrEvents(lookbackMinutes: Integer, customer: String) returns String;

  @readonly
  @cds.persistence.skip
  entity BTPExecutionLogs {
    key runId: String;
    job_name: String;
    job_type: String;
    status: String;
    started_at: Timestamp;
    completed_at: Timestamp;
    httpStatus: Integer;
    message: String;
    
    // Fields mapped from database persistence logs
    total_batch_size: Integer;
    processed_count: Integer;
    created_count: Integer;
    updated_count: Integer;
    skipped_count: Integer;
    error_count: Integer;
    log_entries: LargeString;
    logEntries: LargeString; // CamelCase alias for UI binding compatibility
    timeline: LargeString; // JSON array of simplified log rows for the UI
    error_message: String;

    // AI usage analytics
    model_id: String;
    provider: String;
    ai_calls: Integer;
    input_tokens: Integer;
    output_tokens: Integer;
    total_tokens: Integer;
    reasoning_tokens: Integer;
    cached_input_tokens: Integer;
  }

  // ============================================
  // EVENTS
  // ============================================

  event POCreated {
    po_number: String;
    supplier_id: String;
    created_by: String;
  }

  event POUpdated {
    po_number: String;
    line_item: String;
    old_status: String;
    new_status: String;
  }

  event ASNReceived {
    delivery: String;
    item: String;
    reference_document: String;
    supplier: String;
    delivery_quantity: Decimal;
  }

  event ASNPosted {
    asn_id: String;
    po_number: String;
    posted_at: Timestamp;
  }

  event ExceptionRaised {
    exception_id: Integer;
    po_number: String;
    exception_type: String;
    priority: String;
  }

  event ExceptionResolved {
    exception_id: Integer;
    resolved_by: String;
    resolution_note: String;
  }

  event ShipmentTracked {
    ID: UUID;
    source_hash: String;
    status: String;
    po_number: String;
  }
}

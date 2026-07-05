using { ict } from '../db/schema';

@title: 'Mammoth Brands Inbound Control Tower (ICT) API'
@Description: 'Exposes OData endpoints and analytical services to track logistics entities, carrier events, and supply chain exceptions.'
@requires: 'any'
service CatalogService {
  // ============================================
  // ENTITIES - Full CRUD Support
  // ============================================

  entity Plants as select from ict.plants;
  entity Materials as select from ict.materials;
  entity Suppliers as select from ict.suppliers;
  entity POLines as select from ict.po_lines;
  entity ASNIbd as select from ict.asn_ibd;
  entity CHREvents as select from ict.chr_events;
  entity Exceptions as select from ict.exceptions;
  entity ExceptionTypes as select from ict.exception_types;
  entity ExceptionRules as select from ict.exception_rules;
  entity LLMConfigs as select from ict.llm_configs;
  entity JobSchedules as select from ict.job_schedules;
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

  type AnalysisResult {
    status: String;
    message: String;
    count: Integer;
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

  // ============================================
  // CUSTOM ACTIONS & FUNCTIONS
  // ============================================

  @public
  function getActiveOrders() returns { value: array of POStatus };
  @public
  function getExceptionSummary() returns { value: ExceptionSummary };
  @public
  function getSupplyChainMetrics() returns { value: SupplyChainMetrics };
  @public
  @description: 'AI-powered exception analysis - analyzes all PO lines and generates intelligent recommendations using BTP Job Scheduler configurations'
  function analyzeExceptions() returns AnalysisResult;

  @public
  @description: 'Bulk CSV upload for testing — validates rows and returns per-row errors'
  action uploadTableData(
    tableName: String,   // POLines | ASNIbd | CHREvents | Plants | Materials | Suppliers | Exceptions | ExceptionTypes | ExceptionRules
    rows: LargeString,   // JSON array of row objects
    upsert: Boolean      // true = update existing records on key conflict
  ) returns UploadResult;

  @public
  @description: 'Column metadata (name, type, key, required) for each uploadable table'
  function getUploadTableMeta() returns LargeString;

  @readonly
  @cds.persistence.skip
  entity BTPExecutionLogs {
    key runId: String;
    job_name: String;
    status: String;
    started_at: Timestamp;
    completed_at: Timestamp;
    httpStatus: Integer;
    message: String;
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
    chr_ref: String;
    status: String;
    po_number: String;
  }
}

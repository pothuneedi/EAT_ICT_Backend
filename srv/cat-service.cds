using { ict } from '../db/schema';

@title: 'Mammoth Brands Inbound Control Tower (ICT) API'
@Description: 'Exposes OData endpoints and analytical services to track logistics entities, carrier events, and supply chain exceptions.'
@requires: 'any'
service CatalogService {
  // ============================================
  // ENTITIES - Full CRUD Support
  // ============================================

  entity Plants as select from ict.Plants;
  entity Materials as select from ict.Materials;
  entity Suppliers as select from ict.Suppliers;
  entity POLines as select from ict.po_lines;
  entity ASNIbd as select from ict.asn_ibd;
  entity CHREvents as select from ict.CHR_Events;
  entity Exceptions as select from ict.ICT_Exceptions;
  entity ExceptionTypes as select from ict.ExceptionTypes;
  entity ExceptionRules as select from ict.ExceptionRules;

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

  // ============================================
  // CUSTOM FUNCTIONS
  // ============================================

  function getActiveOrders() returns { value: array of POStatus };
  function getExceptionSummary() returns { value: ExceptionSummary };
  function getSupplyChainMetrics() returns { value: SupplyChainMetrics };

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
    asn_id: String;
    po_number: String;
    supplier_id: String;
    asn_qty: Decimal;
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

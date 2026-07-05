# ICT Project Backend - SAP CAP (Supply Chain Management)

An enterprise-grade, cloud-native **REST/OData API backend** built with the SAP Cloud Application Programming (CAP) model. This is a **backend-only** project designed to manage supply chain logistics operations, integrate ERP data, track carrier events, and automatically identify shipment exceptions on SAP BTP.

---

## 🏗️ Project Directory Structure

```text
├── db/                        # Database Layer (SQLite / SAP HANA)
│   ├── schema.cds            # Main schema entry point (aggregates sub-schemas)
│   ├── schema/               # Modularized CDS schemas
│   │   ├── master-data.cds   # Plants, Materials, and Suppliers
│   │   ├── transactional.cds # PO Lines, Inbound Deliveries (ASNs), CHR Events
│   │   └── exceptions.cds    # Exceptions, types, and classification rules
│   └── data/                 # Master and seed data (CSV formats)
├── srv/                       # Service Layer (OData Service definition & logic)
│   ├── cat-service.cds       # CatalogService OData API contract definitions
│   ├── cat-service.js        # Main service entry point registering decoupled handlers
│   ├── index.js              # Express middleware and error handling custom bootstrap
│   └── handlers/             # Decoupled entity-group event controllers
│       ├── po-handler.js     # Validates and tracks Purchase Order Lines
│       ├── asn-handler.js    # Validates and matches Inbound Deliveries (ASNs)
│       ├── exception-handler.js # Controls exception logging and resolutions
│       ├── shipment-handler.js  # Governs carrier status updates from C.H. Robinson (CHR)
│       └── analytics-handler.js # Computes custom analytical metric aggregations
├── test/                      # Test Suite
│   ├── setup.js              # Jest configuration, timeout setting, and global mocks
│   └── unit/                 # Unit tests (Mocked DB context, 100% logic coverage)
│       └── cat-service.test.js
├── mta.yaml                   # SAP Multi-Target Application deployment descriptor
├── xs-security.json           # XSUAA authorization roles and scopes config
└── .cdsrc.json                # SAP CAP profile configurations (SQLite / HANA)
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: `18.x` or higher
- **npm**: `9.x` or higher

### Installation
1. Navigate to the project directory:
   ```bash
   cd ICT-backend
   ```
2. Install required packages:
   ```bash
   npm install
   ```
3. Establish your environment properties (default configurations are preset for local development):
   ```bash
   cp .env.example .env
   ```
4. Start the development server (in watch mode, backed by an in-memory SQLite database):
   ```bash
   npm run dev
   ```

The local development API endpoint is served at: **`http://localhost:4000/odata/v4/catalog`**

### 📖 Interactive Swagger UI API Docs
When the server is running, view the fully interactive API documentation and test queries in your browser at:
**`http://localhost:4000/$api-docs/odata/v4/catalog/`**

---

## 🔌 API Endpoints & Traversal

The service exposes the following standard OData v4 CRUD endpoints:

### OData Entities
*   `/Plants` - Plant locations and master details.
*   `/Materials` - Material master records.
*   `/Suppliers` - Supplier vendor records.
*   `/POLines` - Purchase Order line items (Composite Key: `po_number`, `line_item`).
*   `/ASNIbd` - Inbound Deliveries / Advanced Shipping Notifications (Composite Key: `ibd_number`, `ibd_item`).
*   `/CHREvents` - Shipment status events tracked via C.H. Robinson (Key: `event_id`).
*   `/Exceptions` - Operations Exceptions (Key: `exception_id`).
*   `/ExceptionRules` - Business exception rules and AI patterns.
*   `/ExceptionTypes` - Static error types and priorities.

### logical Associations (Traversal via `$expand`)
The schema features unmanaged logical associations so you can query related records directly:
*   `/POLines?$expand=material,supplier,plant_ref` (Traverse from PO Line to its master records)
*   `/ASNIbd?$expand=po_line,supplier,plant` (Traverse ASN to matching PO details)
*   `/Exceptions?$expand=po_line,asn,rule` (Resolve an exception to its target PO, ASN, and rule pattern)

---

## 📈 Analytics & Custom Queries

The API exposes custom analytical functions for dashboard integration:

### 1. Get Active Orders
Aggregates lines of purchase orders that are in `OPEN` or `GR_POSTED` statuses.
```http
GET /odata/v4/catalog/getActiveOrders()
```

### 2. Get Exception Summary
Retrieves count metrics grouped by priority and response panels.
```http
GET /odata/v4/catalog/getExceptionSummary()
```

### 3. Get Supply Chain Metrics
Computes key supply chain performance KPIs (`on_time_delivery`, `exception_rate`, `avg_lead_time_days`, ASN counts).
```http
GET /odata/v4/catalog/getSupplyChainMetrics()
```

---

## 🔐 Security & Access Control

Roles and scopes defined in `xs-security.json` segment BTP access:
*   **User Role**: Grants read-only queries for all master/transaction data, and write access for creating ASNs and shipment tracking logs.
*   **Admin Role**: Full CRUD across all entities (including PO Lines, Exceptions, and Exception Rules setup).

---

## 🧪 Testing & Code Quality

*   **Linting**: Conforms to ESLint checks:
    ```bash
    npm run lint
    ```
*   **Tests**: Executed via Jest with code coverage reports:
    ```bash
    npm test
    ```

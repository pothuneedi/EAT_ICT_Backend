# Quick Start Guide - Mammoth Brands Inbound Control Tower (ICT)

Get up and running with the **Mammoth Brands Inbound Control Tower (ICT) OData API** in less than 5 minutes.

---

## 1. Prerequisites Check
Make sure you have Node.js 18+ and npm installed:
```bash
node --version
npm --version
```

---

## 2. Fast Setup (2 mins)
Install dependencies and prepare the local configuration:
```bash
# Install dependencies
npm install

# Setup environment configuration
cp .env.example .env
```

---

## 3. Run Development Server (1 min)
Launch the CAP server in development watch mode. It will compile your schemas, boot the JavaScript controllers, load initial mock data CSVs, and start an in-memory SQLite database:
```bash
npm run dev
```

You should see:
```text
[cds] - serving CatalogService { at: '/odata/v4/catalog' }
[cds] - server listening on http://localhost:4000
```

*   **API Base URL**: `http://localhost:4000/odata/v4/catalog`
*   **Interactive Swagger UI**: `http://localhost:4000/$api-docs/odata/v4/catalog/`

---

## 4. Test the API Endpoints (2 mins)

Open your browser, REST client, or run the following curl commands in a separate terminal:

### 1. Retrieve Purchase Order Lines
```bash
curl http://localhost:4000/odata/v4/catalog/POLines
```

### 2. Traverse Relations using OData `$expand`
```bash
# Expand PO Line to view the associated Material, Supplier, and Plant details
curl "http://localhost:4000/odata/v4/catalog/POLines?\$expand=material,supplier,plant_ref"
```

### 3. Create a new Purchase Order Line (POST)
```bash
curl -X POST http://localhost:4000/odata/v4/catalog/POLines \
  -H "Content-Type: application/json" \
  -d '{
    "po_number": "4500002000",
    "line_item": "10",
    "material_id": "MAT-4411-J",
    "supplier_id": "SUP-001",
    "plant": "1000",
    "po_qty": 500,
    "po_uom": "EA",
    "net_price": 1250.50,
    "currency": "USD",
    "delivery_date": "2026-07-15",
    "po_status": "OPEN",
    "created_by": "DEV_USER"
  }'
```

### 4. Create an ASN Inbound Delivery (POST)
```bash
curl -X POST http://localhost:4000/odata/v4/catalog/ASNIbd \
  -H "Content-Type: application/json" \
  -d '{
    "ibd_number": "180033640",
    "ibd_item": "10",
    "po_number": "4500002000",
    "line_item": "10",
    "supplier_id": "SUP-001",
    "ship_to_plant": "1000",
    "asn_qty": 500,
    "asn_uom": "EA",
    "asn_status": "Pending"
  }'
```

### 5. Fetch Custom Supply Chain Metrics
```bash
curl http://localhost:4000/odata/v4/catalog/getSupplyChainMetrics()
```

---

## 🔧 Core Maintenance Commands

*   **Code Quality Linter**: Check formatting rules and clean files:
    ```bash
    npm run lint
    ```
*   **Run Jest Test Suite**: Validate logic checks and queries:
    ```bash
    npm test
    ```
*   **SAP BTP Cloud Bundle Build**: Build production artifact package:
    ```bash
    npm run build
    ```


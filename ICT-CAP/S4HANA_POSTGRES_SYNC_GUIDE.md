# S/4HANA → PostgreSQL Sync — CAP Developer Guide

**Audience:** CAP developer implementing the scheduled sync that replicates S/4HANA data into the
`ict-backend` PostgreSQL tables.
**Strategy:** **Reconcile (Approach A)** — every run, the set fetched from S/4HANA is treated as
authoritative for its scope; local rows in that scope that are no longer present in S/4 are
**closed or deleted**. The table ends each run mirroring S/4.

> Companion reference: [S4HANA_SYNC_ENDPOINTS.md](./S4HANA_SYNC_ENDPOINTS.md) — full field
> mappings and `$metadata` URLs for every entity. This guide is the *implementation* plan.

---

## 1. Context & stack

- `ict-backend` is a **CAP (`@sap/cds` v8)** app. DB is **PostgreSQL in production** (`@cap-js/postgres`),
  SQLite locally. All queries below use `cds.ql` (`UPSERT`/`SELECT`/`UPDATE`/`DELETE`) which run
  unchanged on both.
- The app already depends on `@sap-cloud-sdk/connectivity` + `http-client` and has a job pattern
  (`analyzeExceptions()`, `BTPExecutionLogs`, `ict.job_schedules`, `ict.execution_logs`). **Reuse it.**
- Access to S/4HANA is only through the **`mb-api-gateway`** OAuth app (BTP → Cloud Connector → on-prem S/4).
  We never call S/4 directly.

### Data sources → targets

| # | S/4 service | Driving entity | Target table | Keys | Scope | Reconcile action |
|---|-------------|----------------|--------------|------|-------|------------------|
| 1 | API_PURCHASEORDER_PROCESS_SRV | A_PurchaseOrderItem | `po_lines` | (po_number, line_item) | **Open items only** | mark `po_status='CLOSED'` |
| 2 | API_INBOUND_DELIVERY_SRV | A_InbDeliveryHeader→Item | `asn_ibd` | (delivery, item) | ASNs for open POs | delete orphaned |
| 3 | API_BUSINESS_PARTNER | A_Supplier (+A_BusinessPartner) | `suppliers` | (supplier) | Full set | delete missing |
| 4 | API_PRODUCT_SRV | A_Product | `materials` | (material) | Full set | delete missing |
| 5 | API_PLANT_SRV | A_Plant | `plants` | (plant_code) | Full set | delete missing |

> **Referential safety:** `po_lines`/`asn_ibd` reference `materials`/`suppliers`/`plants` (unmanaged
> associations). Sync **master data first** (plants → materials → suppliers), then transactional
> (po_lines → asn_ibd), so lookups resolve. For master data, prefer **soft reconcile** (see §6).

---

## 2. Recommended schema addition — a sync watermark

Efficient reconcile at scale needs a way to tell "was this row touched by the current run?" without
building a giant `NOT IN (...)`. Add one nullable column to each synced table:

```cds
// db/schema/master-data.cds and transactional.cds — add to plants, materials, suppliers, po_lines, asn_ibd
last_synced_at : Timestamp;   // stamped on every upsert; rows with an older stamp were not in this run
```

**Sweep-based reconcile** then becomes: stamp every upserted row with the run timestamp `runTs`, then
in the same scope, `DELETE`/`CLOSE` rows where `last_synced_at < runTs` (or is null). This is O(1) SQL,
no key diffing. It's the pattern used throughout this guide. (If you'd rather not change the schema,
§6 shows the JS key-diff fallback — fine for a few hundred rows.)

---

## 3. Shared building blocks (put in `srv/lib/s4h/`)

### 3.1 OAuth token (client-credentials, cached)

```js
// srv/lib/s4h/token.js
const cds = require('@sap/cds')
let cached = { token: null, exp: 0 }

async function getProxyToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token
  const { url, clientid, clientsecret } = cds.env.requires.S4H_XSUAA.credentials  // or read from env
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString('base64')
  const res = await fetch(`${url}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'                       // NOTE: no scope param
  })
  if (!res.ok) throw new Error(`XSUAA token failed: ${res.status} ${await res.text()}`)
  const j = await res.json()
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 }
  return cached.token
}
module.exports = { getProxyToken }
```

### 3.2 Proxy fetch + pagination

The proxy passes the whole OData request as the `path` query param — **URL-encode it once**. Follow
`d.__next` (OData v2) until absent.

```js
// srv/lib/s4h/fetch.js
const { getProxyToken } = require('./token')
const BASE = process.env.S4H_PROXY_URL   // https://mb-api-gateway.cfapps.us10.hana.ondemand.com

async function proxyGet(odataPath) {
  const token = await getProxyToken()
  const url = `${BASE}/proxy/S4HANA?path=${encodeURIComponent(odataPath)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  if (res.status === 401) { /* token expired — clear cache & retry once */ }
  if (!res.ok) throw new Error(`Proxy ${res.status}: ${await res.text()}`)
  return res.json()
}

// Fetch all pages for a v2 collection request
async function fetchAll(odataPath) {
  let out = [], next = odataPath
  while (next) {
    const body = await proxyGet(next)
    const d = body.d || body
    out = out.concat(d.results || d.value || [])
    // v2 __next is an absolute S/4 URL; strip host so it goes back through the proxy path
    next = d.__next ? d.__next.replace(/^https?:\/\/[^/]+/, '') : null
  }
  return out
}
module.exports = { proxyGet, fetchAll }
```

### 3.3 Generic reconcile helper (sweep-based)

```js
// srv/lib/s4h/reconcile.js
// Upsert `rows` (already stamped with last_synced_at = runTs), then close/delete
// rows in `scope` whose stamp is older than runTs.
async function upsertAndReconcile(tx, entity, rows, runTs, { scope = {}, mode = 'delete', closeSet }) {
  if (rows.length) await tx.run(UPSERT.into(entity).entries(rows))
  const stale = { and: [ scope, { or: [ { last_synced_at: null }, { last_synced_at: { '<': runTs } } ] } ] }
  if (mode === 'delete') await tx.run(DELETE.from(entity).where(stale))
  else                    await tx.run(UPDATE(entity).set(closeSet).where(stale))  // e.g. { po_status: 'CLOSED' }
}
module.exports = { upsertAndReconcile }
```

`runTs` must be a single value per run: `const runTs = new Date().toISOString()`.

---

## 4. The reconcile flow (every table follows this)

```
1. runTs = now()
2. rows = fetchAll(<odata request for this table's scope>)
3. mapped = rows.map(mapper)                 // → target columns, set last_synced_at = runTs
4. tx:
   a. UPSERT mapped                          // insert new + update existing on keys
   b. sweep scope where last_synced_at < runTs → DELETE (master/ASN) or CLOSE (po_lines)
5. log counts into BTPExecutionLogs
```

Run order per job invocation: **plants → materials → suppliers → po_lines → asn_ibd**.

---

## 5. Per-table implementation

Field names below are standard S/4; **confirm against `$metadata`** (URLs in the companion doc).
Every mapper must set `last_synced_at = runTs`.

### 5.1 `plants` ← API_PLANT_SRV (full set, delete missing)

OData: `/sap/opu/odata/sap/API_PLANT_SRV/A_Plant?$top=500`

```js
const map = p => ({
  plant_code: p.Plant, plant_name: p.PlantName,
  street_and_house_number: p.StreetName, post_code: p.PostalCode, city: p.CityName,
  country_region_key: p.Country, region: p.Region,
  purchasing_org: p.PurchasingOrganization /*verify*/, sales_org_icb: p.SalesOrganization /*verify*/,
  last_synced_at: runTs
})
await upsertAndReconcile(tx, plants, rows.map(map), runTs, { mode: 'delete' })  // scope = whole table
```

### 5.2 `materials` ← API_PRODUCT_SRV (full set)

OData: `/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?$expand=to_Description&$top=500`
Keep the English description (`to_Description` row with `Language eq 'EN'`).

```js
const map = m => ({
  material: m.Product, created_on: m.CreationDate, material_type: m.ProductType,
  material_group: m.ProductGroup, base_unit_of_measure: m.BaseUnit,
  size_dimensions: m.SizeOrDimensionText, ean_upc: m.ProductStandardID,
  product_hierarchy: m.ProductHierarchy,
  material_description: pickEN(m.to_Description)?.ProductDescription,
  last_synced_at: runTs
})
```
Reconcile: `mode: 'delete'`, whole-table scope — **but see §6 referential caution.**

### 5.3 `suppliers` ← API_BUSINESS_PARTNER (two calls, join in JS)

- Supplier + company: `/API_BUSINESS_PARTNER/A_Supplier?$expand=to_SupplierCompany,to_SupplierPurchasingOrg&$top=500`
- Name + address: `/API_BUSINESS_PARTNER/A_BusinessPartner?$expand=to_BusinessPartnerAddress/to_EmailAddress&$filter=BusinessPartnerCategory eq '2'&$top=500`

Join on `Supplier === BusinessPartner`, then map to `suppliers` columns
(`name←OrganizationBPName1`, `city←CityName`, `terms_of_payment←PaymentTerms`, etc.). Reconcile `mode: 'delete'`, whole-table scope (see §6).

### 5.4 `po_lines` ← API_PURCHASEORDER_PROCESS_SRV (**open items only**, close missing)

OData (drive from the item so we can filter open at item level):
```
/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrderItem
  ?$expand=to_PurchaseOrder,to_ScheduleLine
  &$filter=IsCompletelyDelivered eq false and PurchasingDocumentDeletionCode eq ''
  &$top=500
```

```js
const map = it => {
  const h = it.to_PurchaseOrder, sl = earliestOpen(it.to_ScheduleLine)  // pick relevant schedule line
  return {
    po_number: it.PurchaseOrder, line_item: it.PurchaseOrderItem,
    material_id: it.Material, plant: it.Plant, material_group: it.MaterialGroup,
    po_qty: it.OrderQuantity, po_uom: it.PurchaseOrderQuantityUnit,
    net_price: it.NetPriceAmount,
    supplier_id: h.Supplier, doc_type: h.PurchaseOrderType, company_code: h.CompanyCode,
    purch_group: h.PurchasingGroup, currency: h.DocumentCurrency,
    doc_date: h.PurchaseOrderDate, created_on: h.CreationDate, created_by: h.CreatedByUser,
    delivery_date: sl?.ScheduleLineDeliveryDate,
    po_status: 'OPEN',
    ai_processed: false,            // reset so exception analysis re-runs on updated lines
    last_synced_at: runTs
  }
}
// Reconcile: CLOSE (not delete) — preserve history & FKs from asn_ibd/chr_events
await upsertAndReconcile(tx, po_lines, rows.map(map), runTs,
  { scope: { po_status: 'OPEN' }, mode: 'close', closeSet: { po_status: 'CLOSED' } })
```

> Scope is `po_status='OPEN'`, so only previously-open lines that dropped out of S/4's open set get
> closed. Manually-closed/cancelled lines are untouched.
> **`ai_processed` reset:** only reset it when the line actually changed. If you upsert unconditionally
> you'll re-trigger AI on unchanged lines — compare a hash or `LastChangeDateTime` and set
> `ai_processed=false` only on real changes.

### 5.5 `asn_ibd` ← API_INBOUND_DELIVERY_SRV (**scoped to open POs**, delete orphaned in scope)

The PO link is on the **item** (`ReferenceSDDocument` = PO number, `ReferenceSDDocumentItem` = PO item),
and this is **OData V2** (no `any()`/`all()`), so **drive from `A_InbDeliveryItem`**, filter on
`ReferenceSDDocument`, and expand **up** to the header via `to_DeliveryDocument`. Run this **after**
`po_lines` so the open-PO set exists.

> ⚠️ Verify in `$metadata`: item→header nav (`to_DeliveryDocument`?), and that
> `ReferenceSDDocument`/`ReferenceSDDocumentItem` hold the PO (some systems use
> `PurchaseOrder`/`PurchaseOrderItem` on the IBD item instead).

**Pattern A (primary) — filter by our open PO numbers, batched:**

```js
// srv/lib/s4h/asn.js
const { po_lines, asn_ibd } = cds.entities('ict')
const { fetchAll } = require('./fetch')
const { upsertAndReconcile } = require('./reconcile')

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }

async function syncAsnIbd(tx, runTs) {
  // 1. distinct open PO numbers from our own table
  const poNumbers = (await tx.run(
    SELECT.distinct.from(po_lines).columns('po_number').where({ po_status: 'OPEN' })
  )).map(r => r.po_number)
  if (!poNumbers.length) return { upserted: 0, deleted: 0 }

  // 2. fetch IBD items only for those POs — ~40 per request (encoded OR-list stays under URL limits)
  const items = []
  for (const batch of chunk(poNumbers, 40)) {
    const or = batch.map(po => `ReferenceSDDocument eq '${po}'`).join(' or ')
    const path = `/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV/A_InbDeliveryItem`
               + `?$expand=to_DeliveryDocument&$filter=(${or})`
    items.push(...await fetchAll(path))
  }

  // 3. map item (+ its to_DeliveryDocument header) → asn_ibd, stamp last_synced_at
  const rows = items.map(it => mapIbdItem(it, runTs))

  // 4. reconcile ONLY within the open-PO reference scope (never whole-table)
  await upsertAndReconcile(tx, asn_ibd, rows, runTs, {
    scope: { reference_document: { in: poNumbers } }, mode: 'delete'
  })
  return { upserted: rows.length, deleted: '(swept in scope)' }
}

function mapIbdItem(it, runTs) {
  const h = it.to_DeliveryDocument   // header via item→header nav
  return {
    delivery: it.DeliveryDocument, item: it.DeliveryDocumentItem,
    item_category: it.DeliveryDocumentItemCategory,
    material: it.Material, plant: it.Plant, storage_location: it.StorageLocation,
    delivery_quantity: it.DeliveryQuantity, base_unit_of_measure: it.DeliveryQuantityUnit,
    actual_delivery_qty: it.ActualDeliveryQuantity, item_description: it.DeliveryDocumentItemText,
    reference_document: it.ReferenceSDDocument, reference_item: it.ReferenceSDDocumentItem,
    goods_movement_status: it.GoodsMovementStatus,
    created_by: h?.CreatedByUser, created_on: h?.CreationDate,
    overall_status: h?.OverallGoodsMovementStatus,
    delivery_date: h?.DeliveryDate, document_date: h?.DocumentDate,
    act_goods_movement_date: h?.ActualGoodsMovementDate,
    bill_of_lading: h?.BillOfLading, incoterms: h?.IncotermsClassification,
    supplier: h?.Supplier, external_delivery_id: h?.ExternalDeliveryID,
    last_synced_at: runTs
  }
}
```

**Pattern B (fallback for many open POs)** — one header-driven paged stream, filtered in JS:
```js
const openSet = new Set(poNumbers)
const headers = await fetchAll(
  `/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV/A_InbDeliveryHeader`
  + `?$expand=to_DeliveryDocumentItem&$filter=LastChangeDateTime gt datetimeoffset'${lastRunIso}'`)
const rows = headers.flatMap(h => (h.to_DeliveryDocumentItem?.results || [])
  .filter(it => openSet.has(it.ReferenceSDDocument))
  .map(it => mapIbdItem({ ...it, to_DeliveryDocument: h }, runTs)))
```

**Choosing:** Pattern A pulls exactly the relevant rows in `ceil(openPOs/40)` calls — prefer it for the
modest open set. Pattern B is one stream but over-fetches; use it only when the OR-batches get large.

**Reconcile scope matters:** the sweep must be limited to `reference_document IN openPOset`. A
whole-table delete would wipe ASNs for POs outside the current open window.

---

## 6. Referential integrity & reconcile mode — read this

`po_lines`, `asn_ibd`, `chr_events` reference `materials`/`suppliers`/`plants`. Hard-deleting master
data that a transaction still points at leaves dangling references (CAP unmanaged associations won't
stop you). Guidance:

- **po_lines** → reconcile by **CLOSE** (status flip), never delete. History and child ASNs stay intact.
- **asn_ibd** → delete only within the **open-PO reference scope**, not the whole table.
- **plants / materials / suppliers** → two safe choices:
  1. **Soft reconcile (recommended):** add `is_active : Boolean` and set `false` on sweep instead of deleting.
     Nothing breaks; UI can filter active.
  2. **Hard delete with guard:** before deleting a stale master row, check it's unreferenced by
     `po_lines`/`asn_ibd`; skip if referenced.

Pick one with the team and apply it consistently in `upsertAndReconcile`'s `mode`.

---

## 7. Wiring into CAP

### 7.1 Service actions (`srv/cat-service.cds`)

```cds
@public
@description: 'Reconcile-sync S/4HANA → PostgreSQL. entity = ALL | plants | materials | suppliers | po_lines | asn_ibd'
action syncFromS4HANA(entity: String) returns AnalysisResult;
```

### 7.2 Handler (`srv/handlers/…` or `cat-service.js`)

```js
srv.on('syncFromS4HANA', async req => {
  const which = req.data.entity || 'ALL'
  const order = ['plants','materials','suppliers','po_lines','asn_ibd']
  const targets = which === 'ALL' ? order : [which]
  const runId = cds.utils.uuid()
  let counts = {}
  await cds.tx(async tx => {
    for (const t of targets) counts[t] = await SYNCERS[t](tx)   // each returns {upserted, closed/deleted}
  })
  await logRun(runId, 'syncFromS4HANA', counts)                 // → BTPExecutionLogs / execution_logs
  return { status: 'Success', message: JSON.stringify(counts), count: Object.values(counts).reduce((a,c)=>a+c.upserted,0) }
})
```

Keep each `SYNCERS[t]` in `srv/lib/s4h/<table>.js` (fetch → map → `upsertAndReconcile`).

### 7.3 Logging

Reuse `BTPExecutionLogs` fields (`total_batch_size`, `created_count`, `updated_count`,
`skipped_count`, `error_count`, `log_entries`) so runs show in the same UI as AI jobs.

---

## 8. Scheduling (BTP Job Scheduler)

Mirror the existing `ICT_AI_JOB` setup. Create Job Scheduler jobs that POST to the action endpoint:

```
POST https://<ict-backend-route>/odata/v4/CatalogService/syncFromS4HANA
Body: { "entity": "po_lines" }
```

Suggested cadence:

| Job | entity | Cron |
|-----|--------|------|
| Master data | plants, materials, suppliers (or `ALL`-master) | nightly (e.g. `0 2 * * *`) |
| Open POs | po_lines | every 30 min |
| ASNs | asn_ibd | every 30 min (after po_lines) |

Secure the endpoint (the action is `@requires:'any'` today — restrict to the job's technical user / a
dedicated scope before production).

---

## 9. Configuration

Add to the CAP project env / `mta.yaml`:

**Superseded — this is now handled by a destination.** §3.1 and §3.2 below describe the
original hand-managed-secret design; the implementation in `srv/lib/s4h/gateway.js` replaced it.

On BTP, the gateway URL and its OAuth2 client credentials live in the `MB_API_GATEWAY`
subaccount destination (`Authentication: OAuth2ClientCredentials`). `mta.yaml` binds a
`destination` service instance, and the Cloud SDK resolves the destination and fetches/caches
the token — so no gateway secret exists in the app environment.

| Key | Value | Notes |
|-----|-------|-------|
| `MB_API_GATEWAY` (destination) | URL = gateway route, client id/secret, token service URL | maintained per subaccount in the cockpit |
| `API_GATEWAY_DESTINATION` (env) | defaults to `MB_API_GATEWAY` | only to override the destination name |
| `S4H_PROXY_URL`, `S4H_XSUAA_*` (env) | — | **local development only**, when no destination service is bound |

---

## 10. Definition of done

- [ ] `last_synced_at` (and optional `is_active`) added to the 5 tables; `cds deploy` to Postgres.
- [ ] `srv/lib/s4h/` : `token.js`, `fetch.js`, `reconcile.js`, one syncer per table.
- [ ] `syncFromS4HANA` action + handler, logging into `BTPExecutionLogs`.
- [ ] Field names verified against each service's `$metadata`.
- [ ] `po_lines` open-filter validated; reconcile **closes** (not deletes) dropped lines.
- [ ] Master-data reconcile mode agreed (soft `is_active` vs guarded delete).
- [ ] `MB_API_GATEWAY` destination created in the subaccount; `destination` service bound to `ict-backend-srv`.
- [ ] Job Scheduler jobs created with the cadence in §8; endpoint secured.
- [ ] Dry-run in a non-prod space; verify counts and no dangling references.
```

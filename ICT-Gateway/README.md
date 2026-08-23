# SAP BTP OAuth Proxy for On-Premise S/4HANA

A secure Node.js service that gives any OAuth2 client (Postman, n8n, or any HTTP client) access to on-premise SAP systems via SAP BTP destinations and Cloud Connector.

## 🚀 Features

- **JWT-based Authentication** with SAP XSUAA
- **Proxy Access** to on-premise SAP OData services
- **Automatic Token Management** with caching and refresh
- **Comprehensive Error Handling** with detailed logging
- **Health Monitoring** and debug endpoints
- **CORS Support** for web integration
- **Role-based Access Control** with SAP scopes

## 📋 Prerequisites

### SAP BTP Environment
- SAP BTP Global Account with Cloud Foundry environment
- XSUAA service instance
- Destination service instance
- Connectivity service instance

#### Per-Subaccount Requirements

Each target subaccount (dev, QA, prod) must be prepared independently. Neither of these
is granted by the **Subaccount Administrator** role collection in the BTP cockpit — they
are separate authorization systems.

**1. Entitlements** — assigned at the **global account** level (needs *Global Account
Administrator*). Global Account → Entitlements → Entity Assignments → select the
subaccount → add quota for:

| Service | Plan |
|---------|------|
| `xsuaa` | `application` |
| `destination` | `lite` |
| `connectivity` | `lite` |

Verify with `cf marketplace` — if `xsuaa` or `destination` are absent, the entitlement
is missing and `cf create-service` will fail.

**2. Cloud Foundry space role** — you need **Space Developer** in the target space.
Org Manager alone lets you target the space but grants no service or app rights.

```bash
# Check who has what
cf org-users "<org>"
cf space-users "<org>" "<space>"

# Grant (requires Org Manager)
cf set-space-role <user> "<org>" "<space>" SpaceDeveloper --origin sap.ids
```

### On-Premise Components
- SAP Cloud Connector installed and configured
- SAP system with OData services enabled
- Network connectivity between Cloud Connector and SAP system

### Development Tools
- Node.js 18+ and npm 8+
- Cloud Foundry CLI
- Git

## 🏗️ Architecture

```
OAuth2 Client (Postman/n8n/…) → BTP App → Destination Service → Cloud Connector → On-Premise SAP
              ↑
          JWT Authentication (XSUAA)
```

## 📦 Installation & Deployment

### 1. Clone and Prepare

```bash
git clone <your-repository>
cd ICT-Gateway
npm install
```

### 2. Create Required Services

```bash
# Login and target the space you are deploying to
cf login -a https://api.cf.your-region.hana.ondemand.com
cf target -o "<org>" -s "<space>"

# Confirm the required offerings are entitled to this subaccount
cf marketplace

# Create XSUAA service
cf create-service xsuaa application mb-api-gateway-xsuaa -c xs-security.json

# Create Destination service
cf create-service destination lite mb-api-gateway-destination

# Create Connectivity service
cf create-service connectivity lite mb-api-gateway-connectivity

# Verify services are created
cf services
```

### 3. Deploy Application

The app route is **not** derived from the app name. Hostnames on the shared
`cfapps.<region>.hana.ondemand.com` domain are unique **region-wide**, and a route can
only point at an app in its own space — so every space needs its own hostname. The
manifest takes `((app-host))` and `((app-domain))` from a per-space vars file:

| Space | Vars file | Resulting URL |
|-------|-----------|---------------|
| `CF_APP_DEV_SPACE` | `vars-dev.yml` | `https://mb-api-gateway.cfapps.us10.hana.ondemand.com` |
| `CF_APP_QA_SPACE` | `vars-qa.yml` | `https://mb-api-gateway-qa.cfapps.us10.hana.ondemand.com` |

```bash
# Deploy to Cloud Foundry — always pass the vars file for the targeted space
cf push --vars-file vars-dev.yml     # dev
cf push --vars-file vars-qa.yml      # QA

# Check application status
cf apps
cf logs mb-api-gateway --recent
```

A bare `cf push` now fails fast with `Expected to find variables: app-domain, app-host`.
That is intentional — it prevents silently claiming the wrong hostname. To add a new
space, copy a vars file and give it a unique `app-host`.

### 4. Verify Deployment

```bash
# Test health endpoint
curl https://your-app-url/health

# Check service bindings
cf env mb-api-gateway
```

## ⚙️ Configuration

### 1. BTP Destination Setup

In your BTP cockpit, create a destination:

| Property | Value | Description |
|----------|-------|-------------|
| **Name** | `S4HANA` | Destination identifier |
| **Type** | `HTTP` | Connection type |
| **URL** | `https://your-sap-system:port` | SAP system URL |
| **Proxy Type** | `OnPremise` | Use Cloud Connector |
| **Authentication** | `BasicAuthentication` | Auth method |
| **User** | `<sap-username>` | SAP system user |
| **Password** | `<sap-password>` | SAP system password |

**Additional Properties:**
```
sap-client = 800
sap-language = EN
```

### 2. Cloud Connector Configuration

1. **Access Cloud Connector Admin**: `https://your-connector:8443`

2. **Add Back-end System**:
   ```
   Protocol: HTTPS
   Internal Host: your-sap-system
   Internal Port: 44300 (or your SAP port)
   Virtual Host: your-sap-system
   Virtual Port: 44300
   Principal Type: None
   Host in Request Header: Use Virtual Host
   ```

3. **Add Resources**:
   ```
   URL Path: /sap/opu/odata/sap/API_SALES_ORDER_SRV
   Active: ✓
   Access Policy: Path and all sub-paths
   ```

4. **Verify Connection**: Status should be "Connected" (green)

### 3. OAuth2 Client Setup

Create OAuth2 client for consumer authentication:

1. **In BTP Cockpit** → Security → OAuth2 Clients
2. **Create New Client**:
   ```
   Client ID: mb-api-gateway-client
   Grant Types: Client Credentials
   Scopes: 
     - mb-api-gateway-access.destination.read
     - mb-api-gateway-access.destination.execute
   ```

## 🔐 Authentication

**Credential policy.** All consumers authenticate with the same XSUAA client
credentials, so whoever holds them holds full access to everything the gateway
can reach — including the Cloud Connector tunnel into the corporate network.

| Environment | Who may hold the client credentials |
|-------------|------------------------------------|
| **Production** | The `ict-backend` application only. No Postman, no ad-hoc clients. |
| **Dev / QA**   | Any team client — `ict-backend`, Postman, n8n — provided the Cloud Connector for that space points at a non-production S/4. |

The `curl` and Postman flows below are **development conveniences**. Do not use
them against production.

### Getting Access Token (dev / QA)

```bash
# Get OAuth2 token
curl -X POST "https://your-subdomain.authentication.us10.hana.ondemand.com/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&scope=mb-api-gateway-access.destination.read mb-api-gateway-access.destination.execute"
```

`client_credentials` is the only grant type the XSUAA instance accepts — see
`oauth2-configuration.grant-types` in [xs-security.json](xs-security.json).

### Token Response
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "mb-api-gateway-access.destination.read mb-api-gateway-access.destination.execute"
}
```

## 📡 API Endpoints

### Health Check
```http
GET /health
```
**Response:**
```json
{
  "status": "OK",
  "timestamp": "2025-07-10T16:32:23.332Z",
  "xsuaa": true,
  "serviceTokenValid": true
}
```

### Destination Info
```http
GET /destination/{destinationName}
Authorization: Bearer <jwt-token>
```

### Proxy Request
```http
GET /proxy/{destinationName}?path={odata-path}&{query-params}
Authorization: Bearer <jwt-token>
```

### Debug Proxy (for troubleshooting)
```http
GET /debug/proxy?destination={name}&path={odata-path}
Authorization: Bearer <jwt-token>
```

## 🎯 Client Integration (Postman / n8n / any OAuth2 client)

### HTTP Request Node Configuration

**Method**: `GET`
**URL**: `https://your-app-url/proxy/S4HANA`

**Authentication**:
- Type: `OAuth2 API`
- Grant Type: `Client Credentials`
- Client ID: `mb-api-gateway-client`
- Client Secret: `your-client-secret`
- Access Token URL: `https://your-subdomain.authentication.us10.hana.ondemand.com/oauth/token`
- Scope: `mb-api-gateway-access.destination.read mb-api-gateway-access.destination.execute`

**Query Parameters**:
```
path: /sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder
$filter: SalesOrder eq '{{ $json.orderNumber }}'
$format: json
sap-client: 800
```

**Headers**:
```
Accept: application/json
Content-Type: application/json
```

### Example Workflow

```json
{
  "nodes": [
    {
      "parameters": {
        "method": "GET",
        "url": "https://your-app-url/proxy/S4HANA",
        "authentication": {
          "type": "oauth2",
          "oauth2": {
            "grantType": "clientCredentials",
            "clientId": "mb-api-gateway-client",
            "clientSecret": "your-client-secret",
            "accessTokenUrl": "https://your-subdomain.authentication.us10.hana.ondemand.com/oauth/token",
            "scope": "mb-api-gateway-access.destination.read mb-api-gateway-access.destination.execute"
          }
        },
        "qs": {
          "path": "/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder",
          "$filter": "SalesOrder eq '5'",
          "$format": "json",
          "sap-client": "800"
        }
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [860, 240],
      "name": "Get Sales Order"
    }
  ]
}
```

## 🛠️ Troubleshooting

### Deployment Issues

#### **"You are not authorized to perform the requested action"** on `cf create-service`

You lack **Space Developer** in the targeted space. Being *Subaccount Administrator* in
the cockpit, or *Org Manager* in CF, is not sufficient — Org Manager lets you target the
space and manage roles but grants no service rights.

```bash
cf space-users "<org>" "<space>"                                        # confirm
cf set-space-role <user> "<org>" "<space>" SpaceDeveloper --origin sap.ids   # fix
```

#### **Service offering not found / missing from `cf marketplace`**

The subaccount is not entitled to that service. Compare against a working subaccount:

```bash
cf marketplace
```

If `xsuaa`, `destination`, or `connectivity` are absent, a *Global Account Administrator*
must assign the entitlement — see [Per-Subaccount Requirements](#per-subaccount-requirements).
Truncated plan lists on an offering that *is* present indicate a missing plan-level
entitlement rather than a role problem.

#### **"Routes cannot be mapped to destinations in different spaces"** on `cf push`

The hostname is already claimed by an app in another space. Shared-domain hostnames are
unique region-wide, so two subaccounts cannot both use `mb-api-gateway`. Find the owner:

```bash
cf curl "/v3/routes?hosts=mb-api-gateway"
cf curl "/v3/spaces/<space-guid-from-above>"
```

Fix by giving the space its own `app-host` in its vars file and pushing with
`--vars-file`. Do not use `random-route: true` — the hostname must stay stable because
clients and destination configs reference it.

#### **`Expected to find variables: app-domain, app-host`**

You ran a bare `cf push`. Pass the vars file for the space you are targeting, e.g.
`cf push --vars-file vars-qa.yml`.

### Common Issues

#### 1. **503 Service Unavailable**
```
Error: Proxy failed: Request failed with status code 503
```

**Solutions:**
- ✅ Check SAP system availability
- ✅ Verify Cloud Connector is running and connected
- ✅ Test destination connectivity in BTP cockpit
- ✅ Validate OData service is accessible

#### 2. **401 Unauthorized**
```
Error: Missing or invalid JWT token
```

**Solutions:**
- ✅ Verify OAuth2 client credentials
- ✅ Check token scopes include required permissions
- ✅ Ensure token hasn't expired

#### 3. **404 Not Found**
```
Error: Service not found (404)
```

**Solutions:**
- ✅ Verify OData service path is correct
- ✅ Check service is activated in SAP system
- ✅ Validate Cloud Connector resource configuration

#### 4. **Connection Timeout**
```
Error: ECONNREFUSED or ENOTFOUND
```

**Solutions:**
- ✅ Check network connectivity
- ✅ Verify Cloud Connector configuration
- ✅ Test SAP system accessibility

### Debug Commands

```bash
# Check application logs
cf logs mb-api-gateway --recent

# Test destination connectivity
curl -H "Authorization: Bearer TOKEN" \
  "https://your-app-url/destination/S4HANA"

# Debug proxy request
curl -H "Authorization: Bearer TOKEN" \
  "https://your-app-url/debug/proxy?destination=S4HANA&path=/sap/opu/odata/sap/API_SALES_ORDER_SRV"

# Check service health
curl "https://your-app-url/health"
```

### Monitoring

Monitor your application:
- **BTP Cockpit**: Application logs and metrics
- **Cloud Connector**: Connection status and request logs
- **SAP System**: Performance and availability
- **n8n**: Workflow execution logs

## 🔄 Maintenance

### Token Refresh
The service automatically refreshes tokens every 5 minutes. Monitor logs for refresh failures.

### Service Updates
```bash
# Update application (vars file must match the targeted space)
cf push --vars-file vars-qa.yml

# Restart application
cf restart mb-api-gateway

# Scale application
cf scale mb-api-gateway -i 2
```

### Service Management
```bash
# View service instances
cf services

# Check service keys
cf service-keys mb-api-gateway-xsuaa

# Update service
cf update-service mb-api-gateway-xsuaa -c xs-security.json
```

## 📊 Performance Considerations

- **Token Caching**: Service tokens are cached for 1 hour
- **Request Timeout**: 30 seconds for proxy requests
- **Connection Pooling**: Automatic via SAP Cloud SDK
- **Memory Usage**: 512MB default, scale as needed
- **Concurrent Requests**: Limited by Cloud Foundry plan

## 🔒 Security Best Practices

1. **Rotate Credentials Regularly**
   - Update OAuth2 client secrets
   - Refresh SAP system passwords
   - Monitor token usage

2. **Limit Scope Access**
   - Grant minimum required scopes
   - Use role-based access control
   - Monitor authentication logs

3. **Network Security**
   - Use HTTPS for all communications
   - Restrict Cloud Connector access
   - Monitor network traffic

4. **Audit and Compliance**
   - Log all API requests
   - Monitor for suspicious activity
   - Regular security assessments

## 📝 Support

### Logs and Debugging
- **Application logs**: `cf logs mb-api-gateway`
- **Cloud Connector logs**: Check connector administration console
- **SAP system logs**: ST22, SM21, SLG1 transactions

### Resources
- [SAP BTP Documentation](https://help.sap.com/docs/btp)
- [Cloud Connector Guide](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/sap-btp-connectivity-cf)


---

**Created**: July 2025  
**Last Updated**: August 2026  
**Version**: 1.0.0
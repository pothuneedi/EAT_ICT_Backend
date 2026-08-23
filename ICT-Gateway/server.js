const http = require('http');
const { randomUUID, createPublicKey } = require('crypto');
const jwt = require('jsonwebtoken');
const xsenv = require('@sap/xsenv');

const port = process.env.PORT || 3000;

// Load XSUAA service credentials with better error handling
let xsuaaCredentials;
try {
  xsenv.loadEnv();
  const services = xsenv.getServices({
    xsuaa: { label: 'xsuaa' }
  });
  xsuaaCredentials = services.xsuaa;
  console.log('✅ XSUAA service found:', xsuaaCredentials.xsappname);
} catch (error) {
  console.error('❌ XSUAA service not bound:', error.message);
  console.log('💡 Make sure to bind XSUAA service: cf bind-service <app> xsuaa-service');

  // Try alternative service detection
  try {
    const vcapServices = JSON.parse(process.env.VCAP_SERVICES || '{}');
    console.log('Available services:', Object.keys(vcapServices));

    if (vcapServices.xsuaa && vcapServices.xsuaa[0]) {
      xsuaaCredentials = vcapServices.xsuaa[0].credentials;
      console.log('✅ Found XSUAA in VCAP_SERVICES');
    } else {
      process.exit(1);
    }
  } catch (vcapError) {
    console.error('❌ No VCAP_SERVICES found');
    process.exit(1);
  }
}

// Opt-in, not opt-out. This endpoint returns upstream bodies and stack traces,
// so an unset, mistyped or overridden variable must leave it off, never on.
const DEBUG_PROXY_ENABLED = process.env.ENABLE_DEBUG_PROXY === 'true';

// ── Access control ──────────────────────────────────────────────────────────
// This proxy is privileged: it holds the destinations' technical credentials and
// a Cloud Connector tunnel into the corporate network, and the destinations
// authenticate with their own technical users. The caller's identity therefore
// never reaches S/4 — so a caller must only be able to reach exactly what is
// listed below.
//
// The S/4 prefixes are the seven OData services ict-backend actually consumes,
// not the whole /sap/opu/odata tree. That makes this list strictly tighter than
// the Cloud Connector resource rules, so it is a real second layer rather than a
// duplicate of them. Adding a consumer means adding its service here.
const S4HANA_SERVICE_PREFIXES = [
  '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/',
  '/sap/opu/odata/sap/API_PLANT_SRV/',
  '/sap/opu/odata/sap/API_PRODUCT_SRV/',
  '/sap/opu/odata/sap/API_BUSINESS_PARTNER/',
  '/sap/opu/odata/sap/API_INBOUND_DELIVERY_SRV/',
  '/sap/opu/odata/sap/ZICT_IBD_IDOC_ERR_API_SRV/',
  '/sap/opu/odata4/sap/api_purchaseorder_2/'
];

const DEFAULT_ALLOWLIST = {
  S4HANA: { methods: ['GET'], pathPrefixes: S4HANA_SERVICE_PREFIXES },
  CHR:    { methods: ['GET'], pathPrefixes: ['/v2/'] }
};

/**
 * PROXY_ALLOWLIST can widen access without a code change, so its shape is
 * checked rather than trusted. `{"methods":"GET,POST"}` would otherwise make
 * `.includes()` a substring test and silently permit POST — the same trap
 * checkScope already guards against for `scope`.
 */
function validateAllowlist(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('allowlist must be a JSON object');
  }
  const entries = Object.entries(candidate);
  if (!entries.length) {
    throw new Error('allowlist must name at least one destination');
  }
  for (const [name, rule] of entries) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`${name}: rule must be an object`);
    }
    if (!Array.isArray(rule.methods) || !rule.methods.length
      || !rule.methods.every(method => typeof method === 'string')) {
      throw new Error(`${name}: methods must be a non-empty array of strings`);
    }
    if (!Array.isArray(rule.pathPrefixes) || !rule.pathPrefixes.length
      || !rule.pathPrefixes.every(prefix => typeof prefix === 'string' && prefix.startsWith('/'))) {
      throw new Error(`${name}: pathPrefixes must be a non-empty array of paths starting with "/"`);
    }
  }
  return candidate;
}

let ALLOWLIST = DEFAULT_ALLOWLIST;
if (process.env.PROXY_ALLOWLIST) {
  try {
    ALLOWLIST = validateAllowlist(JSON.parse(process.env.PROXY_ALLOWLIST));
    console.log('✅ Allowlist loaded from PROXY_ALLOWLIST');
  } catch (error) {
    console.error('❌ PROXY_ALLOWLIST rejected, using defaults:', error.message);
  }
}
console.log('🔐 Allowed destinations:', Object.keys(ALLOWLIST).join(', '));

// ── Backend protection ──────────────────────────────────────────────────────
// Every proxied request occupies an ABAP dialog work process for its duration,
// and those are a small shared pool serving Fiori and SAP GUI users too. The cap
// bounds simultaneous occupancy regardless of how many callers pile on; a rate
// limit would not, since ten concurrent slow queries hurt far more than a
// hundred sequential fast ones. Only S/4 is capped — CHR is a third-party API
// with different constraints.
//
// Callers queue for a slot rather than being rejected outright: consumers that
// treat a failed call as "skip this record" would silently lose data if a burst
// turned into 429s.
const MAX_IN_FLIGHT = {
  S4HANA: Number(process.env.MAX_IN_FLIGHT_S4HANA || 10)
};
const MAX_QUEUED_PER_DESTINATION = Number(process.env.MAX_QUEUED_PER_DESTINATION || 50);
const MAX_QUEUE_WAIT_MS = Number(process.env.MAX_QUEUE_WAIT_MS || 20000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);
const MAX_REQUEST_BODY_BYTES = Number(process.env.MAX_REQUEST_BODY_BYTES || 1024 * 1024);

const slotStates = new Map();

function slotStateFor(destinationName) {
  if (!slotStates.has(destinationName)) {
    slotStates.set(destinationName, {
      inFlight: 0,
      queue: [],
      // Monotonic since start-up. inFlight/queued are gauges, and a burst that
      // lasts milliseconds is invisible to a poll every few seconds — these
      // record what happened between polls.
      peakInFlight: 0,
      queuedTotal: 0,
      rejectedTotal: 0
    });
  }
  return slotStates.get(destinationName);
}

// Pre-create state for every capped destination so /health reports the
// configured limit before any traffic has flowed.
for (const cappedDestination of Object.keys(MAX_IN_FLIGHT)) {
  slotStateFor(cappedDestination);
}

function tooManyRequests(message) {
  const error = new Error(message);
  error.statusCode = 429;
  return error;
}

/**
 * Returns a release function. Destinations with no configured limit are
 * unrestricted and get a no-op.
 */
async function acquireSlot(destinationName) {
  const limit = MAX_IN_FLIGHT[destinationName];
  if (!limit) {
    return () => {};
  }
  const state = slotStateFor(destinationName);

  if (state.inFlight < limit) {
    state.inFlight++;
    if (state.inFlight > state.peakInFlight) {
      state.peakInFlight = state.inFlight;
    }
  } else {
    if (state.queue.length >= MAX_QUEUED_PER_DESTINATION) {
      state.rejectedTotal++;
      throw tooManyRequests(`Too many concurrent requests for ${destinationName}`);
    }
    state.queuedTotal++;
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) {
          state.queue.splice(index, 1);
        }
        state.rejectedTotal++;
        reject(tooManyRequests(`Timed out waiting for capacity on ${destinationName}`));
      }, MAX_QUEUE_WAIT_MS);
      state.queue.push(waiter);
    });
    // The slot was handed over by the releasing request, so inFlight already
    // accounts for it — incrementing here would exceed the limit.
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const next = state.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      state.inFlight--;
    }
  };
}

function slotSnapshot() {
  const snapshot = {};
  for (const [name, state] of slotStates) {
    snapshot[name] = {
      inFlight: state.inFlight,
      queued: state.queue.length,
      // Without the limit, a reading of inFlight cannot be judged: 7 is healthy
      // at a cap of 12 and saturated at a cap of 7.
      limit: MAX_IN_FLIGHT[name] ?? null,
      peakInFlight: state.peakInFlight,
      queuedTotal: state.queuedTotal,
      rejectedTotal: state.rejectedTotal
    };
  }
  return snapshot;
}

// Browsers have no business calling this API — it is server-to-server. Set
// ALLOWED_ORIGINS (comma-separated) only if a browser client is ever added.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// Both directions are allowlists rather than denylists: a proxy needs very few
// headers, and anything unnamed — a caller's cookie or X-HTTP-Method-Override,
// an upstream Set-Cookie — must not cross the boundary merely because nobody
// thought to delete it. Node lowercases incoming header names, so plain
// lower-case comparison is exhaustive.
const FORWARDED_REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'if-modified-since'
];
const FORWARDED_RESPONSE_HEADERS = ['etag', 'last-modified'];

function buildForwardHeaders(req) {
  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (req.headers[name] !== undefined) {
      headers[name] = req.headers[name];
    }
  }
  if (!headers.accept) {
    headers.accept = 'application/json';
  }
  return headers;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function methodNotAllowed(method) {
  const error = new Error(`Method not allowed: ${method}`);
  error.statusCode = 405;
  return error;
}

function assertGetOnly(req) {
  if (req.method !== 'GET') {
    throw methodNotAllowed(req.method);
  }
}

// The Cloud SDK wraps failures in ErrorWithCause, so the outer message is
// generic ("Failed to build headers.") while the root cause names the real
// problem — a missing destination secret, an unreachable token service. Walk
// the chain for messages ONLY: ErrorWithCause splices an axios cause's response
// body into its stack, which is exactly the business data the proxy's logging
// deliberately omits.
function causeChain(error) {
  const messages = [];
  for (let current = error.cause; current && messages.length < 5; current = current.cause) {
    messages.push(current.message);
  }
  return messages;
}

/** The upstream HTTP status, wherever the SDK buried it in the cause chain. */
function upstreamStatusOf(error) {
  for (let current = error; current; current = current.cause) {
    const status = current.response && current.response.status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return null;
}

function isTimeoutError(error) {
  for (let current = error; current; current = current.cause) {
    if (current.code === 'ECONNABORTED' || current.code === 'ETIMEDOUT') {
      return true;
    }
  }
  return false;
}

/**
 * Classify an upstream failure without echoing anything the backend said.
 *
 * Relaying 4xx matters: collapsing everything into 502 makes every failure look
 * retryable, so a malformed $filter or a missing entity costs the backend four
 * executions of the same doomed query instead of one.
 *
 * 401 is the exception. Callers read it as "refresh your token and retry", but a
 * backend 401 means the destination's technical credentials are wrong — a retry
 * cannot fix it and the refresh would target the wrong credential entirely.
 */
function upstreamError(error) {
  const status = upstreamStatusOf(error);
  const mapped = new Error('Upstream request failed');
  mapped.upstream = true;

  if (status !== null && status >= 400 && status < 500 && status !== 401) {
    mapped.statusCode = status;
  } else if (isTimeoutError(error)) {
    mapped.statusCode = 504;
  } else {
    mapped.statusCode = 502;
  }
  return mapped;
}

function assertDestinationAllowed(destinationName) {
  const rule = Object.prototype.hasOwnProperty.call(ALLOWLIST, destinationName)
    ? ALLOWLIST[destinationName]
    : null;
  if (!rule) {
    throw forbidden(`Destination not allowed: ${destinationName}`);
  }
  return rule;
}

function assertRequestAllowed(destinationName, method, resourcePath) {
  const rule = assertDestinationAllowed(destinationName);

  if (!rule.methods.includes(method)) {
    throw forbidden(`Method not allowed on ${destinationName}: ${method}`);
  }

  // A repeated ?path=…&path=… yields an array, which would bypass every string
  // check below and throw a TypeError instead.
  if (typeof resourcePath !== 'string') {
    throw forbidden('path must be a single value');
  }

  // Must be a single-slash relative path. An absolute URL or a protocol-relative
  // one would let the caller send the request somewhere other than the
  // destination; '..' could climb out of an allowed prefix.
  if (!resourcePath.startsWith('/') || resourcePath.startsWith('//')) {
    throw forbidden('path must be a relative path starting with "/"');
  }
  if (resourcePath.includes('..')) {
    throw forbidden('path must not contain ".."');
  }
  if (!rule.pathPrefixes.some(prefix => resourcePath.startsWith(prefix))) {
    throw forbidden(`Path not allowed on ${destinationName}: ${resourcePath}`);
  }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Forwarded-Authorization');
}

// ── Token signing keys ──────────────────────────────────────────────────────
// XSUAA rotates its signing keys. The `verificationkey` in the service binding
// is a snapshot taken when the binding was created and never updates, so pinning
// it means every token fails verification the day rotation happens — a total
// outage with no deploy involved. Resolve keys from the JWKS endpoint by `kid`
// instead, and keep the binding key only as a fallback if JWKS is unreachable.
const TOKEN_KEYS_URL = `${xsuaaCredentials.url}/token_keys`;
const JWKS_TTL_MS = Number(process.env.JWKS_TTL_MS || 60 * 60 * 1000);
const JWKS_MIN_REFETCH_MS = Number(process.env.JWKS_MIN_REFETCH_MS || 60 * 1000);
const JWKS_TIMEOUT_MS = Number(process.env.JWKS_TIMEOUT_MS || 10000);

const jwksCache = { keys: new Map(), fetchedAt: 0, inFlight: null };

function jwkToPem(key) {
  // XSUAA usually ships a ready PEM in `value`; fall back to the JWK components.
  if (typeof key.value === 'string' && key.value.includes('BEGIN')) {
    return key.value;
  }
  return createPublicKey({ key, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

async function refreshJwks() {
  if (jwksCache.inFlight) {
    return jwksCache.inFlight;
  }
  jwksCache.inFlight = (async () => {
    try {
      const response = await fetch(TOKEN_KEYS_URL, {
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS)
      });
      if (!response.ok) {
        throw new Error(`token_keys responded ${response.status}`);
      }
      const body = await response.json();
      const keys = new Map();
      for (const key of body.keys || []) {
        if (key.kid) {
          try {
            keys.set(key.kid, jwkToPem(key));
          } catch (conversionError) {
            console.warn(`⚠️ Unusable signing key ${key.kid}: ${conversionError.message}`);
          }
        }
      }
      if (!keys.size) {
        throw new Error('token_keys returned no usable keys');
      }
      jwksCache.keys = keys;
      jwksCache.fetchedAt = Date.now();
      console.log(`🔑 Loaded ${keys.size} XSUAA signing key(s)`);
    } finally {
      jwksCache.inFlight = null;
    }
  })();
  return jwksCache.inFlight;
}

async function resolveVerificationKey(kid) {
  const stale = Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (!jwksCache.keys.size || stale) {
    try {
      await refreshJwks();
    } catch (error) {
      console.error('❌ Could not load XSUAA signing keys:', error.message);
    }
  }

  if (kid && jwksCache.keys.has(kid)) {
    return jwksCache.keys.get(kid);
  }

  // Unknown kid usually means a rotation we have not picked up yet. Re-fetch,
  // but not more often than JWKS_MIN_REFETCH_MS so a bogus kid cannot be used to
  // hammer the token service.
  if (kid && Date.now() - jwksCache.fetchedAt > JWKS_MIN_REFETCH_MS) {
    try {
      await refreshJwks();
      if (jwksCache.keys.has(kid)) {
        return jwksCache.keys.get(kid);
      }
    } catch (error) {
      console.error('❌ Signing key refresh failed:', error.message);
    }
  }

  if (!kid && jwksCache.keys.size === 1) {
    return jwksCache.keys.values().next().value;
  }
  if (xsuaaCredentials.verificationkey) {
    return xsuaaCredentials.verificationkey;
  }
  throw new Error('No verification key available for token');
}

/**
 * Audience check, failing closed.
 *
 * XSUAA derives audiences from scopes: scope `<xsappname>.destination.execute`
 * yields audience `<xsappname>.destination`, so the bare xsappname is usually
 * NOT present. Compare on the segment before the first '.', and accept the
 * client id form issued to our own client. A missing or non-array `aud` is
 * rejected rather than skipped.
 */
function assertAudience(decoded) {
  const audiences = decoded.aud == null
    ? []
    : (Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud]);

  const valid = audiences.some(aud =>
    aud === xsuaaCredentials.xsappname ||
    aud === xsuaaCredentials.clientid ||
    String(aud).split('.')[0] === xsuaaCredentials.xsappname
  );

  if (!valid) {
    throw new Error('Invalid audience in token');
  }
}

async function validateJWT(req) {
  const authHeader = req.headers['x-forwarded-authorization'] ||
                    req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid JWT token');
  }

  const token = authHeader.substring(7);

  // Reading the header before verification is safe — it only selects which key
  // to verify against, and an unknown kid resolves to nothing.
  const unverified = jwt.decode(token, { complete: true });
  if (!unverified) {
    throw new Error('Invalid JWT token: malformed token');
  }
  const verificationKey = await resolveVerificationKey(unverified.header.kid);

  try {
    const decoded = jwt.verify(token, verificationKey, {
      algorithms: ['RS256'],
      issuer: xsuaaCredentials.url + '/oauth/token'
    });

    // Check token expiration with buffer
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp <= now + 60) { // Token expires in less than 1 minute
      throw new Error('jwt token is about to expire');
    }

    assertAudience(decoded);

    return decoded;
  } catch (error) {
    // Provide more specific error messages
    if (error.name === 'TokenExpiredError') {
      throw new Error('jwt expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new Error('Invalid JWT token: ' + error.message);
    } else {
      throw new Error('Invalid JWT token: ' + error.message);
    }
  }
}

function checkScope(userToken, requiredScope) {
  const fullScope = `${xsuaaCredentials.xsappname}.${requiredScope}`;

  // Must be an array for exact matching — a string `scope` would make
  // .includes() a substring test, so anything else is treated as no scopes.
  const scopes = Array.isArray(userToken.scope) ? userToken.scope : [];

  if (!scopes.includes(fullScope)) {
    throw new Error(`Missing required scope: ${fullScope}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = require('url');
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const requestId = randomUUID();
  req.requestId = requestId;

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // Health check (no auth required)
    if (pathname === '/health') {
      assertGetOnly(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'OK',
        timestamp: new Date().toISOString(),
        xsuaa: !!xsuaaCredentials,
        signingKeys: jwksCache.keys.size,
        destinations: slotSnapshot()
      }));
      return;
    }

    // Token refresh endpoint for clients
    if (pathname === '/auth/refresh') {
      assertGetOnly(req);
      try {
        const userToken = await validateJWT(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: 'Token is valid',
          expires: userToken.exp ? new Date(userToken.exp * 1000).toISOString() : null
        }));
      } catch (error) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: error.message,
          message: 'Please obtain a new token from your OAuth provider'
        }));
      }
      return;
    }

    // All other endpoints require JWT validation
    const userToken = await validateJWT(req);
    console.log('Authenticated user:', userToken.user_name || userToken.client_id);

    // Debug endpoint — echoes upstream responses and stack traces verbatim, so
    // it is mounted only where ENABLE_DEBUG_PROXY has been set deliberately.
    if (pathname === '/debug/proxy') {
      if (!DEBUG_PROXY_ENABLED) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
        return;
      }

      checkScope(userToken, 'destination.execute');

      const destinationName = parsedUrl.query.destination || 'S4HANA';
      const resourcePath = parsedUrl.query.path || '';

      assertRequestAllowed(destinationName, req.method, resourcePath);
      await handleDebugProxy(req, res, destinationName, resourcePath, parsedUrl.query);
      return;
    }

    // Enhanced proxy endpoints with better path handling
    if (pathname.startsWith('/proxy/') || pathname.startsWith('/api/proxy/')) {
      checkScope(userToken, 'destination.execute');

      const pathParts = pathname.split('/');
      const destinationName = pathParts[pathParts.length - 1];
      const resourcePath = parsedUrl.query.path || '';

      assertRequestAllowed(destinationName, req.method, resourcePath);
      await handleProxy(req, res, destinationName, resourcePath, parsedUrl.query);
      return;
    }

    // Destination info endpoints
    if (pathname.startsWith('/destination/')) {
      assertGetOnly(req);
      checkScope(userToken, 'destination.read');

      const destinationName = pathname.split('/destination/')[1];
      assertDestinationAllowed(destinationName);
      const destInfo = await getDestinationInfo(destinationName);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(destInfo));
      return;
    }

    // Admin endpoints
    if (pathname.startsWith('/admin/')) {
      assertGetOnly(req);
      checkScope(userToken, 'admin');

      const adminInfo = {
        userInfo: {
          name: userToken.user_name,
          email: userToken.email,
          scopes: userToken.scope,
          expires: userToken.exp ? new Date(userToken.exp * 1000).toISOString() : null
        },
        serviceInfo: {
          xsappname: xsuaaCredentials.xsappname,
          timestamp: new Date().toISOString(),
          signingKeys: jwksCache.keys.size,
          destinations: slotSnapshot()
        }
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(adminInfo));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));

  } catch (error) {
    let statusCode = error.statusCode || 500;
    let errorCode;

    // Upstream classification comes first: a relayed backend 403 is not our
    // allowlist talking, and must not be labelled as though it were.
    if (error.upstream) {
      errorCode = 'UPSTREAM_ERROR';
    } else if (statusCode === 429) {
      errorCode = 'RATE_LIMITED';
    } else if (statusCode === 405) {
      errorCode = 'METHOD_NOT_ALLOWED';
    } else if (statusCode === 413) {
      errorCode = 'PAYLOAD_TOO_LARGE';
    } else if (statusCode === 403) {
      errorCode = 'FORBIDDEN';
    } else if (error.message.includes('jwt expired') || error.message.includes('jwt token is about to expire')) {
      statusCode = 401;
      errorCode = 'TOKEN_EXPIRED';
    } else if (error.message.includes('JWT') || error.message.includes('scope')) {
      statusCode = 401;
      errorCode = 'AUTHENTICATION_FAILED';
    }

    console.error('Request failed:', { requestId, statusCode, message: error.message });

    if (statusCode === 429) {
      res.setHeader('Retry-After', '2');
    }
    if (statusCode === 405) {
      res.setHeader('Allow', 'GET');
    }

    // Only our own 4xx messages are safe to echo — they tell a caller what they
    // did wrong. A 5xx message can carry SDK or upstream text naming internal
    // hosts, so it stays in the log and the caller quotes the request id.
    const errorResponse = {
      error: statusCode < 500 ? error.message : 'Request could not be completed',
      requestId,
      timestamp: new Date().toISOString()
    };
    if (errorCode) {
      errorResponse.errorCode = errorCode;
    }
    if (errorCode === 'TOKEN_EXPIRED') {
      errorResponse.message = 'Please refresh your authentication token';
    }

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorResponse));
  }
});

/** Middleware applied to every backend call — stops hammering a failing system. */
function backendMiddleware() {
  const { circuitBreaker } = require('@sap-cloud-sdk/resilience');
  return [circuitBreaker()];
}

async function handleDebugProxy(req, res, destinationName, resourcePath, query) {
  const release = await acquireSlot(destinationName);
  try {
    const { getDestination } = require('@sap-cloud-sdk/connectivity');
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

    const destination = await getDestination({ destinationName });

    let fullPath = resourcePath || '';
    const params = new URLSearchParams();

    Object.keys(query).forEach(key => {
      if (key !== 'path' && key !== 'destination') {
        params.append(key, query[key]);
      }
    });

    if (params.toString()) {
      fullPath += (fullPath.includes('?') ? '&' : '?') + params.toString();
    }

    const headers = buildForwardHeaders(req);

    console.log(`🔍 Debug proxy request to ${destinationName}${fullPath}`);

    const response = await executeHttpRequest(destination, {
      method: req.method,
      url: fullPath,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS
    }, { middleware: backendMiddleware() });

    // Return detailed debug information
    const debugInfo = {
      request: {
        destination: destinationName,
        path: fullPath,
        method: req.method,
        headers: headers
      },
      response: {
        status: response.status,
        headers: response.headers,
        dataType: typeof response.data,
        dataLength: response.data ? (response.data.length || Object.keys(response.data).length) : 0,
        contentType: response.headers['content-type'],
        data: response.data,
        isValidJson: false
      }
    };

    // Check if response is valid JSON
    if (typeof response.data === 'string') {
      try {
        JSON.parse(response.data);
        debugInfo.response.isValidJson = true;
      } catch (e) {
        debugInfo.response.isValidJson = false;
        debugInfo.response.jsonParseError = e.message;
      }
    } else if (typeof response.data === 'object') {
      try {
        JSON.stringify(response.data);
        debugInfo.response.isValidJson = true;
      } catch (e) {
        debugInfo.response.isValidJson = false;
        debugInfo.response.jsonStringifyError = e.message;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(debugInfo, null, 2));

  } catch (error) {
    const errorInfo = {
      error: error.message,
      stack: error.stack,
      response: error.response ? {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data
      } : null
    };

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorInfo, null, 2));
  } finally {
    release();
  }
}

async function handleProxy(req, res, destinationName, resourcePath, query) {
  const release = await acquireSlot(destinationName);
  try {
    const { getDestination } = require('@sap-cloud-sdk/connectivity');
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

    const destination = await getDestination({ destinationName });

    let fullPath = resourcePath || '';
    const params = new URLSearchParams();

    Object.keys(query).forEach(key => {
      // 'destination' is routing input, not a backend query parameter — matches
      // the filtering handleDebugProxy already does.
      if (key !== 'path' && key !== 'destination') {
        params.append(key, query[key]);
      }
    });

    if (params.toString()) {
      fullPath += (fullPath.includes('?') ? '&' : '?') + params.toString();
    }

    // Get request body for POST/PUT/PATCH
    let requestData;
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      requestData = await getRequestBody(req);
    }

    const headers = buildForwardHeaders(req);

    console.log(`🔄 Proxying ${req.method} request to ${destinationName}${fullPath}`);

    const response = await executeHttpRequest(destination, {
      method: req.method,
      url: fullPath,
      headers,
      data: requestData,
      timeout: UPSTREAM_TIMEOUT_MS
    }, { middleware: backendMiddleware() });

    // Deliberately no header or body logging — these carry S/4 business data
    // (PO, supplier, partner records) and CF application logs are retained
    // longer and read more widely than this API.
    console.log(`📨 ${destinationName} responded ${response.status}`);

    // Handle different response types
    let responseData;
    let contentType = response.headers['content-type'] || 'application/json';

    if (typeof response.data === 'string') {
      // Check if it's actually JSON
      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        try {
          // Validate JSON
          JSON.parse(response.data);
          responseData = response.data;
          contentType = 'application/json';
        } catch (jsonError) {
          console.warn(`⚠️ Response claims to be JSON but isn't valid: ${jsonError.message}`);
          responseData = response.data;
          contentType = 'text/plain';
        }
      } else {
        responseData = response.data;
      }
    } else if (response.data && typeof response.data === 'object') {
      // Ensure object can be stringified
      try {
        responseData = JSON.stringify(response.data);
        contentType = 'application/json';
      } catch (stringifyError) {
        console.error(`❌ Cannot stringify response object: ${stringifyError.message}`);
        responseData = JSON.stringify({
          error: 'Response object cannot be serialized',
          originalType: typeof response.data
        });
        contentType = 'application/json';
      }
    } else {
      // Handle null, undefined, or other types
      responseData = JSON.stringify({
        data: response.data,
        type: typeof response.data,
        message: 'Unexpected response type from backend'
      });
      contentType = 'application/json';
    }

    // Allowlisted response headers only: an upstream Set-Cookie would hand the
    // caller an on-premise SAP session, and the rest describe the landscape.
    const responseHeaders = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      if (response.headers[name] !== undefined) {
        responseHeaders[name] = response.headers[name];
      }
    }
    responseHeaders['content-type'] = contentType;
    // Responses carry S/4 business data: no intermediary may store it, and no
    // client may re-interpret it as a type we did not declare.
    responseHeaders['cache-control'] = 'no-store';
    responseHeaders['x-content-type-options'] = 'nosniff';

    Object.keys(responseHeaders).forEach(key => {
      res.setHeader(key, responseHeaders[key]);
    });

    res.writeHead(response.status || 200);
    res.end(responseData);

  } catch (error) {
    // Already classified — a queue rejection or an oversized body must keep its
    // own status rather than being relabelled as an upstream failure.
    if (error.statusCode) {
      throw error;
    }

    // Status only — an upstream error body can contain the same business data
    // as a success body.
    const causes = causeChain(error);
    console.error('❌ Proxy error:', {
      requestId: req.requestId,
      destination: destinationName,
      message: error.message,
      ...(causes.length && { causes }),
      upstreamStatus: upstreamStatusOf(error)
    });
    // The SDK message names the destination URL and internal hosts, so it stays
    // in the log. The caller gets a status and the request id to quote.
    throw upstreamError(error);
  } finally {
    release();
  }
}

async function getDestinationInfo(destinationName) {
  try {
    const { getDestination } = require('@sap-cloud-sdk/connectivity');

    const destination = await getDestination({ destinationName });

    return {
      name: destinationName,
      url: destination.url,
      type: destination.type,
      authentication: destination.authentication,
      proxyType: destination.proxyType,
      status: 'success'
    };
  } catch (error) {
    const causes = causeChain(error);
    console.error('❌ Destination lookup failed:', {
      destination: destinationName,
      message: error.message,
      ...(causes.length && { causes })
    });
    const lookupError = new Error('Destination lookup failed');
    lookupError.statusCode = 502;
    throw lookupError;
  }
}

/**
 * Bounded body read. Unreachable while the allowlist is GET-only, but an
 * unbounded accumulator becomes a memory-exhaustion vector the moment a write
 * method is allowed.
 */
function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString() : undefined));
    req.on('error', reject);
  });
}

// Warm the signing keys so the first request does not pay for the fetch. A
// failure here is not fatal: resolveVerificationKey retries on demand.
refreshJwks().catch(error => {
  console.error('⚠️ Initial signing key load failed:', error.message);
});

server.listen(port, () => {
  console.log(`🔒 JWT-secured SAP Destination Service running on port ${port}`);
  console.log(`🎫 XSUAA App: ${xsuaaCredentials?.xsappname}`);
});

module.exports = server;

// Exposed for unit tests only — not part of the HTTP contract.
module.exports.__testing = {
  validateAllowlist,
  assertRequestAllowed,
  assertDestinationAllowed,
  assertAudience,
  checkScope,
  buildForwardHeaders,
  acquireSlot,
  slotSnapshot,
  upstreamStatusOf,
  isTimeoutError,
  upstreamError,
  DEFAULT_ALLOWLIST,
  MAX_IN_FLIGHT
};

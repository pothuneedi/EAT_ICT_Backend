'use strict';

const { resolveGateway } = require('./gateway');
const { loadConfig } = require('./config');
const { stripHostFromNextLink, sleep } = require('./odata-utils');

async function proxyGetJson(route, apiPath, {
    retryOnUnauthorized = true,
    accept = 'application/json',
    refreshAuth = false
} = {}) {
    const { maxRetries, retryDelayMs, requestTimeoutMs } = loadConfig();
    const { baseUrl, headers: authHeaders } = await resolveGateway({ refresh: refreshAuth });
    const url = `${baseUrl}/proxy/${route}?path=${encodeURIComponent(apiPath)}`;

    let attempt = 0;
    while (attempt <= maxRetries) {
        let res;
        try {
            res = await fetch(url, {
                headers: { ...authHeaders, Accept: accept },
                signal: AbortSignal.timeout(requestTimeoutMs)
            });
        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                throw new Error(`Proxy call timed out after ${requestTimeoutMs}ms for ${apiPath}`);
            }
            throw err;
        }

        if (res.status === 401 && retryOnUnauthorized) {
            return proxyGetJson(route, apiPath, {
                retryOnUnauthorized: false,
                accept,
                refreshAuth: true
            });
        }

        if (res.ok) {
            return accept.includes('json') ? res.json() : res.text();
        }

        const body = await res.text();
        const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
        if (retryable && attempt < maxRetries) {
            attempt += 1;
            await sleep(retryDelayMs * attempt);
            continue;
        }

        throw new Error(`Proxy call failed with status ${res.status} for ${apiPath}: ${body}`);
    }

    throw new Error(`Proxy call failed after retries for ${apiPath}`);
}

async function proxyGet(odataPath, options) {
    return proxyGetJson('S4HANA', odataPath, options);
}

/** CHR Navisphere — GET /v2/events?... via /proxy/CHR */
async function proxyChrGet(apiPath, options) {
    return proxyGetJson('CHR', apiPath, options);
}

function isProxyNotFoundError(err) {
    return /status 404\b/.test(err?.message || '');
}

function parseCountBody(body) {
    if (body == null) {
        return null;
    }

    if (typeof body === 'number' && Number.isFinite(body)) {
        return body;
    }

    if (typeof body === 'object') {
        if (typeof body.d === 'number') {
            return body.d;
        }
        if (typeof body.d === 'string') {
            return parseInt(body.d, 10);
        }
        if (body.d?.__count != null) {
            return parseInt(body.d.__count, 10);
        }
        if (typeof body.data === 'number') {
            return body.data;
        }
    }

    const trimmed = String(body).trim();
    const direct = parseInt(trimmed, 10);
    if (Number.isFinite(direct) && String(direct) === trimmed.replace(/^"|"$/g, '')) {
        return direct;
    }

    try {
        const json = JSON.parse(trimmed);
        if (typeof json === 'number') {
            return json;
        }
        if (json?.data != null && typeof json.data === 'number') {
            return json.data;
        }
        if (json?.d != null) {
            const inner = json.d;
            if (typeof inner === 'number') {
                return inner;
            }
            if (typeof inner === 'string') {
                return parseInt(inner, 10);
            }
            if (inner?.__count != null) {
                return parseInt(inner.__count, 10);
            }
        }
    } catch {
        // not JSON — fall through
    }

    const digits = trimmed.match(/\d+/);
    return digits ? parseInt(digits[0], 10) : null;
}

/**
 * OData v2 $count — response is usually plain text (e.g. "1234").
 */
async function proxyGetCount(odataPath, { retryOnUnauthorized = true } = {}) {
    const body = await proxyGetJson('S4HANA', odataPath, {
        retryOnUnauthorized,
        accept: 'text/plain'
    });
    const count = parseCountBody(body);
    if (count == null || !Number.isFinite(count)) {
        throw new Error(`Could not parse S/4 $count response for ${odataPath}`);
    }
    return count;
}

function extractPage(body) {
    const data = body.d || body;
    return {
        results: data.results || data.value || [],
        nextPath: stripHostFromNextLink(data.__next)
    };
}

function stripPagingParams(path) {
    return path
        .replace(/([?&])\$top=\d+/g, '$1')
        .replace(/([?&])\$skip=\d+/g, '$1')
        .replace(/[?&]$/, '');
}

function appendPaging(basePath, top, skip) {
    const withoutPaging = stripPagingParams(basePath);
    const separator = withoutPaging.includes('?') ? '&' : '?';
    return `${withoutPaging}${separator}$top=${top}&$skip=${skip}`;
}

/**
 * Streams OData pages to a callback.
 * - Each page is fetched from S/4 (no DB connection held during fetch).
 * - Follows OData v2 `d.__next` when present; otherwise uses explicit $top/$skip.
 */
async function fetchInPages(odataPath, onPageCallback) {
    const { pageSize, devRowLimit } = loadConfig();
    const basePath = stripPagingParams(odataPath);

    let fetchedTotal = 0;
    let pageIndex = 0;
    let skip = 0;
    let nextPath = null;

    while (true) {
        if (devRowLimit && fetchedTotal >= devRowLimit) {
            break;
        }

        const effectiveTop = devRowLimit
            ? Math.min(pageSize, devRowLimit - fetchedTotal)
            : pageSize;

        const requestPath = nextPath || appendPaging(basePath, effectiveTop, skip);
        pageIndex += 1;
        console.log(`[fetch] Page ${pageIndex} (skip=${skip}, top=${effectiveTop}): ${requestPath}`);
        const body = await proxyGet(requestPath);
        const { results, nextPath: odataNext } = extractPage(body);

        if (!results.length) {
            break;
        }

        const slice = devRowLimit
            ? results.slice(0, devRowLimit - fetchedTotal)
            : results;

        const shouldContinue = await onPageCallback(slice, {
            pageIndex,
            skip,
            top: effectiveTop,
            fetchedTotal: fetchedTotal + slice.length,
            hasNext: Boolean(odataNext) || results.length >= effectiveTop
        });

        fetchedTotal += slice.length;

        if (shouldContinue === false) {
            break;
        }

        if (devRowLimit && fetchedTotal >= devRowLimit) {
            break;
        }

        if (odataNext) {
            nextPath = odataNext;
            skip += slice.length;
            continue;
        }

        if (results.length < effectiveTop) {
            break;
        }

        nextPath = null;
        skip += slice.length;
    }
}

/** Single OData request — returns result rows (no pagination). */
async function fetchODataResults(odataPath) {
    const body = await proxyGet(odataPath);
    return extractPage(body).results;
}

module.exports = {
    proxyGet,
    proxyChrGet,
    proxyGetCount,
    fetchInPages,
    fetchODataResults,
    isProxyNotFoundError
};

'use strict';

/**
 * Resolves the base URL and auth headers for the central API gateway
 * (the `mb-api-gateway` app fronting S/4HANA, CHR, and future backends).
 *
 * On BTP the gateway is a subaccount destination — the Cloud SDK reads its URL
 * and fetches/caches the OAuth2ClientCredentials token, so no credentials live
 * in the app environment. Locally the destination service is not bound, so we
 * fall back to the S4H_PROXY_URL / S4H_XSUAA_* variables in .env.
 */

const { getDestination, buildHeadersForDestination } = require('@sap-cloud-sdk/connectivity');
const { getProxyToken, clearTokenCache } = require('./token');

const DESTINATION_NAME = process.env.API_GATEWAY_DESTINATION || 'MB_API_GATEWAY';

let destinationServiceBound = null;

/** The Cloud SDK can only resolve a destination when the destination service is bound. */
function isDestinationServiceBound() {
    if (destinationServiceBound === null) {
        let vcap = {};
        try {
            vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
        } catch {
            vcap = {};
        }
        destinationServiceBound = Object.values(vcap)
            .flat()
            .some(binding => binding?.label === 'destination'
                || (binding?.tags || []).includes('destination'));
    }
    return destinationServiceBound;
}

function stripTrailingSlash(url) {
    return url.replace(/\/+$/, '');
}

async function resolveFromDestination(refresh) {
    // useCache:false bypasses the Cloud SDK destination cache (URL *and* token),
    // so a 401 retry always talks to the destination service again.
    const destination = await getDestination({
        destinationName: DESTINATION_NAME,
        useCache: !refresh
    });

    if (!destination) {
        throw new Error(
            `Destination '${DESTINATION_NAME}' not found. Create it in the subaccount `
            + 'and bind the destination service to this app.'
        );
    }

    if (!destination.url) {
        throw new Error(`Destination '${DESTINATION_NAME}' has no URL configured.`);
    }

    return {
        baseUrl: stripTrailingSlash(destination.url),
        headers: await buildHeadersForDestination(destination)
    };
}

async function resolveFromEnv(refresh) {
    const baseUrl = process.env.S4H_PROXY_URL;
    if (!baseUrl) {
        throw new Error(
            'S4H_PROXY_URL is required when the destination service is not bound '
            + '(local development).'
        );
    }

    if (refresh) {
        clearTokenCache();
    }

    return {
        baseUrl: stripTrailingSlash(baseUrl),
        headers: { Authorization: `Bearer ${await getProxyToken()}` }
    };
}

/**
 * Base URL + auth headers for the API gateway.
 * `refresh: true` bypasses every cached token — used for the single 401 retry.
 */
async function resolveGateway({ refresh = false } = {}) {
    return isDestinationServiceBound()
        ? resolveFromDestination(refresh)
        : resolveFromEnv(refresh);
}

/** Which source is in play — for startup logging. */
function gatewaySource() {
    return isDestinationServiceBound()
        ? `destination '${DESTINATION_NAME}'`
        : 'S4H_PROXY_URL env (local)';
}

module.exports = { resolveGateway, gatewaySource, DESTINATION_NAME };

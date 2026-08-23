'use strict';

/**
 * LOCAL DEVELOPMENT ONLY — hand-rolled client_credentials flow against the
 * gateway's XSUAA, used when the destination service is not bound.
 *
 * On BTP the MB_API_GATEWAY destination holds these credentials and the Cloud
 * SDK fetches the token, so nothing here runs. See srv/lib/s4h/gateway.js.
 */

const cds = require('@sap/cds');

let cached = { token: null, exp: 0 };

function clearTokenCache() {
    cached = { token: null, exp: 0 };
}

async function getProxyToken() {
    if (cached.token && Date.now() < cached.exp - 60000) {
        return cached.token;
    }

    const xsuaa = cds.env.requires.S4H_XSUAA || {};
    const creds = xsuaa.credentials || {};
    const url = creds.url || process.env.S4H_XSUAA_URL;
    const clientid = creds.clientid || process.env.S4H_XSUAA_CLIENTID;
    const clientsecret = creds.clientsecret || process.env.S4H_XSUAA_CLIENTSECRET;

    if (!url || !clientid || !clientsecret) {
        throw new Error('XSUAA credentials not found (S4H_XSUAA or S4H_XSUAA_* env variables).');
    }

    let tokenUrl = url;
    if (!tokenUrl.endsWith('/oauth/token')) {
        tokenUrl = `${tokenUrl}/oauth/token`;
    }

    const basic = Buffer.from(`${clientid}:${clientsecret}`).toString('base64');
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok) {
        throw new Error(`XSUAA token fetch failed: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    cached = {
        token: json.access_token,
        exp: Date.now() + (json.expires_in * 1000)
    };

    return cached.token;
}

module.exports = { getProxyToken, clearTokenCache };

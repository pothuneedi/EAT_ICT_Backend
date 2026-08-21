'use strict';

/** MTA resource + package.json production auth — keep in sync with mta.yaml service-name. */
const APP_XSUAA_SERVICE_NAME = 'ict-backend-xsuaa-service';

function parseVcapServices() {
    if (!process.env.VCAP_SERVICES) {
        return null;
    }
    try {
        return JSON.parse(process.env.VCAP_SERVICES);
    } catch (err) {
        console.error('[xsuaa-binding] Failed to parse VCAP_SERVICES:', err.message);
        return null;
    }
}

/**
 * Resolves this app's XSUAA binding from VCAP_SERVICES.
 * Prefer instance name over [0] — a second xsuaa (e.g. S/4 proxy) must not win.
 */
function findAppXsuaaBinding(vcap = parseVcapServices()) {
    if (!vcap) {
        return null;
    }
    return (vcap.xsuaa || [])
        .find((s) => s.name === APP_XSUAA_SERVICE_NAME) || vcap.xsuaa?.[0] || null;
}

function getAppXsuaaCredentials() {
    return findAppXsuaaBinding()?.credentials || null;
}

/** OAuth2 block for BTP Job Scheduler actionAuthentication on job create. */
function buildJobActionAuthentication(uaaCredentials) {
    if (!uaaCredentials) {
        return null;
    }
    return {
        type: 'oauth2',
        oauth2: {
            client_id: uaaCredentials.clientid,
            client_secret: uaaCredentials.clientsecret,
            token_url: `${uaaCredentials.url}/oauth/token`
        }
    };
}

module.exports = {
    getAppXsuaaCredentials,
    buildJobActionAuthentication
};

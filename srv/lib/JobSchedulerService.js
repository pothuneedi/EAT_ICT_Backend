'use strict';

/**
 * SAP BTP Job Scheduler Integration Service (service-binding based)
 *
 * Talks to the BTP Job Scheduler REST API using the BTP_JOBS service binding
 * from VCAP_SERVICES directly — no BTP Destination is involved. See getClient()
 * for the client and getAccessToken() for the client-credentials grant.
 * Falls back to a local mock outside the production profile.
 */

const cds = require('@sap/cds');
const { buildBtpSchedulePayload, resolveScheduleTiming } = require('./job-schedule-pattern');
const { getAppXsuaaCredentials, buildJobActionAuthentication } = require('./xsuaa-binding');

const IS_MOCK = !cds.env.profiles.includes('production');

let cachedToken = null;
let tokenExpiresAt = 0;
let pendingTokenPromise = null;

/**
 * Helper to fetch OAuth access token directly from XSUAA using client credentials (with cache & request deduplication)
 */
async function getAccessToken(credentials) {
    // 1. Return cached token if still valid
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedToken;
    }

    // 2. Return pending promise if a token request is already in-flight
    if (pendingTokenPromise) {
        return pendingTokenPromise;
    }

    // 3. Start token fetch and deduplicate parallel calls
    pendingTokenPromise = (async () => {
        const authHeader = Buffer.from(`${credentials.uaa.clientid}:${credentials.uaa.clientsecret}`).toString('base64');
        try {
            const response = await fetch(`${credentials.uaa.url}/oauth/token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${authHeader}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: 'grant_type=client_credentials'
            });
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`XSUAA responded with status ${response.status}: ${errText}`);
            }
            const data = await response.json();
            
            cachedToken = data.access_token;
            const expiresInSec = data.expires_in || 3600;
            tokenExpiresAt = Date.now() + (expiresInSec * 1000);
            
            return cachedToken;
        } catch (err) {
            console.error('[JobSchedulerService] Failed to fetch access token:', err.message);
            throw err;
        } finally {
            // Reset pending promise when done
            pendingTokenPromise = null;
        }
    })();

    return pendingTokenPromise;
}

/**
 * Helper to get connected REST client directly from BTP Service Binding credentials
 */
async function getClient() {
    if (getClient._client) {
        return getClient._client;
    }

    let credentials;
    if (process.env.VCAP_SERVICES) {
        try {
            const vcap = JSON.parse(process.env.VCAP_SERVICES);
            const service = vcap.jobscheduler?.[0];
            if (service) {
                credentials = service.credentials;
            }
        } catch (err) {
            console.error('[JobSchedulerService] Failed to parse VCAP_SERVICES:', err.message);
        }
    }

    if (!credentials) {
        throw new Error('No jobscheduler service binding found in VCAP_SERVICES. Ensure the service instance is bound.');
    }

    // Connect as a plain REST client (no auth configuration, we will pass bearer token manually)
    const client = await cds.connect.to('JobSchedulerDirect', {
        kind: 'rest',
        credentials: {
            url: credentials.url,
            requestTimeout: 30000
        }
    });

    // Override send method to dynamically attach the access token manually
    const originalSend = client.send;
    client.send = async function (options) {
        const token = await getAccessToken(credentials);
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
        return originalSend.call(this, options);
    };

    getClient._client = client;
    return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API Methods
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    isMock: () => IS_MOCK,

    /**
     * Creates a new job with an initial BTP schedule (cron, interval, repeat-at, or one-time).
     */
    async createJob({ name, description, actionUrl, schedulePattern, scheduleValue, cronExpression, active = true }) {
        const timing = resolveScheduleTiming({
            schedule_pattern: schedulePattern,
            schedule_value: scheduleValue,
            cron_expression: cronExpression
        });
        const schedulePayload = buildBtpSchedulePayload(timing.pattern, timing.value);
        const uaaCredentials = getAppXsuaaCredentials();

        const payload = {
            name,
            description,
            action: actionUrl,
            active,
            httpMethod: 'POST',
            schedules: [
                {
                    ...schedulePayload,
                    description: `Schedule for ${name}`,
                    active: true
                }
            ]
        };

        // BTP calls back with a token from this app's XSUAA (JobScheduler scope).
        const actionAuthentication = buildJobActionAuthentication(uaaCredentials);
        if (actionAuthentication) {
            payload.actionAuthentication = actionAuthentication;
        }

        if (IS_MOCK) {
            console.log(`[JobSchedulerService] [MOCK MODE] POST /scheduler/jobs (action: ${actionUrl})`);
            const mockJobId = Math.floor(Math.random() * 100000);
            const mockScheduleId = 'sched_' + Math.floor(Math.random() * 1000);
            return {
                jobId: mockJobId.toString(),
                scheduleId: mockScheduleId
            };
        }

        try {
            const client = await getClient();
            const result = await client.send({
                method: 'POST',
                path: '/scheduler/jobs',
                data: payload
            });

            return {
                jobId: (result.jobId || result._id)?.toString(),
                scheduleId: result.schedules?.[0]?.scheduleId?.toString()
            };
        } catch (e) {
            console.error('[JobSchedulerService] BTP createJob failed:', e.message);
            throw e;
        }
    },

    /**
     * Updates an existing job details (e.g. description, active state)
     */
    async updateJob(jobId, { description, active }) {
        const payload = {
            description,
            active
        };

        if (IS_MOCK) {
            console.log(`[JobSchedulerService] [MOCK MODE] PUT /scheduler/jobs/${jobId}`);
            return { success: true };
        }

        try {
            const client = await getClient();
            return await client.send({
                method: 'PUT',
                path: `/scheduler/jobs/${jobId}`,
                data: payload
            });
        } catch (e) {
            console.error('[JobSchedulerService] BTP updateJob failed:', e.message);
            throw e;
        }
    },

    /**
     * Updates schedule timing within the same BTP pattern (mode cannot change).
     */
    async updateSchedule(jobId, scheduleId, { schedulePattern, scheduleValue, cronExpression, active }) {
        const timing = resolveScheduleTiming({
            schedule_pattern: schedulePattern,
            schedule_value: scheduleValue,
            cron_expression: cronExpression
        });
        const payload = {
            active: active ?? true,
            ...buildBtpSchedulePayload(timing.pattern, timing.value)
        };

        if (IS_MOCK) {
            console.log(`[JobSchedulerService] [MOCK MODE] PUT /scheduler/jobs/${jobId}/schedules/${scheduleId} (${timing.pattern})`);
            return { success: true };
        }

        try {
            const client = await getClient();
            return await client.send({
                method: 'PUT',
                path: `/scheduler/jobs/${jobId}/schedules/${scheduleId}`,
                data: payload
            });
        } catch (e) {
            console.error('[JobSchedulerService] BTP updateSchedule failed:', e.message);
            throw e;
        }
    },

    /**
     * Deletes a job from BTP Job Scheduler
     */
    async deleteJob(jobId) {
        if (IS_MOCK) {
            console.log(`[JobSchedulerService] [MOCK MODE] DELETE /scheduler/jobs/${jobId}`);
            return { success: true };
        }

        try {
            const client = await getClient();
            return await client.send({
                method: 'DELETE',
                path: `/scheduler/jobs/${jobId}`
            });
        } catch (e) {
            console.error('[JobSchedulerService] BTP deleteJob failed:', e.message);
            throw e;
        }
    },

    /**
     * Fetches all run execution logs of a schedule from BTP
     */
    async getRunLogs(jobId, scheduleId) {
        if (IS_MOCK) {
            console.log(`[JobSchedulerService] [MOCK MODE] GET /scheduler/jobs/${jobId}/schedules/${scheduleId}/runs`);
            // Mock run data
            return [
                {
                    runId: 10001,
                    runStatus: "SUCCESS",
                    startTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 mins ago
                    endTime: new Date(Date.now() - 29 * 60 * 1000).toISOString(),   // 29 mins ago
                    httpStatus: 200,
                    message: "Completed validation run. Processed: 5, Success: 5, Failures: 0"
                },
                {
                    runId: 10002,
                    runStatus: "FAILURE",
                    startTime: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 mins ago
                    endTime: new Date(Date.now() - 14 * 60 * 1000).toISOString(),   // 14 mins ago
                    httpStatus: 500,
                    message: "Exception Analyzer API Error: API key is invalid or expired."
                }
            ];
        }

        try {
            const client = await getClient();
            const result = await client.send({
                method: 'GET',
                path: `/scheduler/jobs/${jobId}/schedules/${scheduleId}/runs`
            });
            // BTP Job Scheduler returns runs wrapped in a { results: [...] } structure
            return result?.results || (Array.isArray(result) ? result : []);
        } catch (e) {
            console.error(`[JobSchedulerService] BTP getRunLogs failed for job ${jobId} schedule ${scheduleId}:`, e.message);
            return [];
        }
    }
};

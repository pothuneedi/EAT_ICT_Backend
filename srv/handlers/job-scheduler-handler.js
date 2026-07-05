'use strict';

/**
 * Job Scheduler CDS Event Handler
 * 
 * Synchronizes the OData CRUD requests on JobSchedules entity
 * with the actual SAP BTP Job Scheduler service API.
 */

const cds = require('@sap/cds');
const JobSchedulerService = require('../lib/JobSchedulerService');

/**
 * Dynamically resolves the callback endpoint URL of this CAP service.
 */
function resolveCallbackUrl(req) {
    let host = process.env.APP_URI || 'http://localhost:4000';
    if (process.env.VCAP_APPLICATION) {
        const appInfo = JSON.parse(process.env.VCAP_APPLICATION);
        host = `https://${appInfo.application_uris[0]}`;
    }
    return `${host}/odata/v4/catalog/analyzeExceptions()`;
}

module.exports = {
    register(srv) {
        const { JobSchedules } = srv.entities;

        // ── BEFORE CREATE: Sync with BTP Job Scheduler ──────────────────────
        srv.before('CREATE', 'JobSchedules', async (req) => {
            const data = req.data;
            if (!data) return;

            const callbackUrl = resolveCallbackUrl(req);
            console.log(`[JobSchedulerHandler] Registering BTP Job: ${data.job_name} | Callback: ${callbackUrl}`);

            try {
                // Call BTP Job Scheduler API to register
                const btpResult = await JobSchedulerService.createJob({
                    name: data.job_name,
                    description: `Automated exception analysis batch run (Size: ${data.batch_size || 50})`,
                    actionUrl: callbackUrl,
                    cronExpression: data.cron_expression,
                    active: data.is_active ?? true
                });

                // Save BTP reference IDs on the local database row
                data.btp_job_id = btpResult.jobId;
                data.btp_schedule_id = btpResult.scheduleId;
                
                console.log(`[JobSchedulerHandler] BTP Job Created -> Job ID: ${data.btp_job_id} | Schedule ID: ${data.btp_schedule_id}`);
            } catch (err) {
                req.error(500, `BTP Job creation failed: ${err.message}`);
            }
        });

        // ── BEFORE UPDATE: Sync changes with BTP ─────────────────────────────
        srv.before('UPDATE', 'JobSchedules', async (req) => {
            const data = req.data;
            if (!data) return;

            const db = srv.transaction(req);
            
            // Query current state to retrieve reference IDs
            const existing = await db.run(SELECT.one.from(JobSchedules).where({ ID: data.ID }));
            if (!existing || !existing.btp_job_id) return;

            try {
                // 1. Sync active status & description changes on the Job level
                if (data.is_active !== undefined) {
                    await JobSchedulerService.updateJob(existing.btp_job_id, {
                        description: `Automated exception analysis batch run (Size: ${data.batch_size ?? existing.batch_size})`,
                        active: data.is_active
                    });
                }

                // 2. Sync cron schedule changes on the Schedule level
                if (data.cron_expression && existing.btp_schedule_id) {
                    await JobSchedulerService.updateSchedule(
                        existing.btp_job_id,
                        existing.btp_schedule_id,
                        {
                            cronExpression: data.cron_expression,
                            active: data.is_active ?? existing.is_active
                        }
                    );
                }
                console.log(`[JobSchedulerHandler] BTP Job updated successfully -> Job ID: ${existing.btp_job_id}`);
            } catch (err) {
                req.error(500, `BTP Job update failed: ${err.message}`);
            }
        });

        // ── BEFORE DELETE: Cancel and remove from BTP ────────────────────────
        srv.before('DELETE', 'JobSchedules', async (req) => {
            const db = srv.transaction(req);
            const data = req.data;
            if (!data || !data.ID) return;

            const existing = await db.run(SELECT.one.from(JobSchedules).where({ ID: data.ID }));
            if (!existing || !existing.btp_job_id) return;

            console.log(`[JobSchedulerHandler] Removing BTP Job: ${existing.btp_job_id}`);

            try {
                await JobSchedulerService.deleteJob(existing.btp_job_id);
                console.log(`[JobSchedulerHandler] BTP Job removed successfully.`);
            } catch (err) {
                // Log and allow deletion to proceed locally so local data isn't locked up
                console.error(`[JobSchedulerHandler] BTP Job removal failed: ${err.message}`);
            }
        });

        // ── ON READ BTPExecutionLogs: Fetch runs dynamically from BTP ────────
        srv.on('READ', 'BTPExecutionLogs', async (req) => {
            const db = srv.transaction(req);
            
            // Fetch all schedules to resolve BTP reference IDs
            const schedules = await db.run(SELECT.from(JobSchedules));
            const allLogs = [];
            
            for (const schedule of schedules) {
                if (!schedule.btp_job_id || !schedule.btp_schedule_id) {
                    continue;
                }
                
                try {
                    const runs = await JobSchedulerService.getRunLogs(schedule.btp_job_id, schedule.btp_schedule_id);
                    if (Array.isArray(runs)) {
                        runs.forEach(run => {
                            let detailedMsg = run.statusMessage || '';

                            // Attempt to extract detail log from the stringified JSON array in runText
                            if (run.runText) {
                                try {
                                    const logEntries = JSON.parse(run.runText);
                                    if (Array.isArray(logEntries) && logEntries.length > 0) {
                                        // Look for SUCCESS/FAILURE/TRIGGERED log text
                                        const successLog = logEntries.find(l => l.type === 'SUCCESS' || l.type === 'FAILURE');
                                        if (successLog && successLog.text) {
                                            try {
                                                // If inner text is JSON (e.g. OData action response), parse and read message
                                                const parsedText = JSON.parse(successLog.text);
                                                detailedMsg = parsedText.message || successLog.text;
                                            } catch {
                                                detailedMsg = successLog.text;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Ignore parse errors, fallback to statusMessage
                                }
                            }

                            // Convert space-separated UTC strings "YYYY-MM-DD HH:MM:SS" -> standard ISO-8601 "YYYY-MM-DDTHH:MM:SSZ"
                            // so that the CAP OData serializer can correctly parse and output them as Timestamps.
                            const formatToISO = (sTs) => {
                                if (!sTs) return null;
                                if (sTs.includes('T')) return sTs;
                                return sTs.replace(' ', 'T') + 'Z';
                            };

                            allLogs.push({
                                runId: run.runId?.toString() || '',
                                job_name: schedule.job_name,
                                status: run.runState || run.runStatus || 'UNKNOWN',
                                started_at: formatToISO(run.executionTimestamp || run.scheduleTimestamp),
                                completed_at: formatToISO(run.completionTimestamp),
                                httpStatus: run.httpStatus || 0,
                                message: detailedMsg
                            });
                        });
                    }
                } catch (e) {
                    console.error(`[JobSchedulerHandler] Failed to load runs for Job: ${schedule.job_name}`, e.message);
                }
            }
            
            // Sort by started_at descending (latest first)
            allLogs.sort((a, b) => {
                const dateA = a.started_at ? new Date(a.started_at) : new Date(0);
                const dateB = b.started_at ? new Date(b.started_at) : new Date(0);
                return dateB - dateA;
            });

            return allLogs;
        });

        console.log('[JobSchedulerHandler] BTP Job Scheduler hooks registered.');
    }
};

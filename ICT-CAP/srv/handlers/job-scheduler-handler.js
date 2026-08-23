'use strict';

/**
 * Job Scheduler CDS Event Handler
 *
 * Synchronizes OData CRUD on JobSchedules with SAP BTP Job Scheduler.
 * Callback URL is chosen from job_type (AI vs S/4 + CHR sync pipelines).
 */

const cds = require('@sap/cds');
const JobSchedulerService = require('../lib/JobSchedulerService');
const {
    buildBtpExecutionLogRow
} = require('../lib/execution-log-presenter');
const {
    normalizeJobType,
    isAiJobType,
    resolveCallbackUrl,
    parseScheduleConfig,
    validateScheduleConfig,
    buildJobDescription
} = require('../lib/job-schedule-types');
const {
    resolveScheduleTiming,
    normalizeAndValidateScheduleFields
} = require('../lib/job-schedule-pattern');
const { validateScheduleName } = require('../lib/schedule-name');

function validateJobSchedulePayload(data, { isUpdate = false } = {}) {
    if (!data) {
        return;
    }

    const jobType = normalizeJobType(data.job_type);
    data.job_type = jobType;

    if (!isUpdate && !String(data.job_name || '').trim()) {
        throw new Error('job_name is required.');
    }

    if (data.job_name != null) {
        const result = validateScheduleName(data.job_name, { required: !isUpdate });
        if (!result.valid) {
            throw new Error(result.message);
        }
        data.job_name = result.value;
    }

    normalizeAndValidateScheduleFields(data);

    if (isAiJobType(jobType)) {
        const batchSize = data.batch_size ?? 5;
        if (!batchSize || batchSize < 1) {
            throw new Error('batch_size must be at least 1 for AI analysis schedules.');
        }
    } else if (data.batch_size == null) {
        data.batch_size = 1;
    }

    const config = parseScheduleConfig(data.config);
    validateScheduleConfig(jobType, config);
    if (Object.keys(config).length > 0 || data.config != null) {
        data.config = JSON.stringify(config);
    }
}

module.exports = {
    register(srv) {
        const { JobSchedules } = srv.entities;

        srv.before('CREATE', 'JobSchedules', async (req) => {
            const data = req.data;
            if (!data) {
                return;
            }

            try {
                validateJobSchedulePayload(data);
            } catch (err) {
                req.error(400, err.message);
                return;
            }

            const jobType = data.job_type;
            const callbackUrl = resolveCallbackUrl(req, jobType);
            const description = buildJobDescription(jobType, data);
            const timing = resolveScheduleTiming(data);

            console.log(`[JobSchedulerHandler] Registering BTP Job: ${data.job_name} (${jobType}, ${timing.pattern}) | Callback: ${callbackUrl}`);

            try {
                const btpResult = await JobSchedulerService.createJob({
                    name: data.job_name,
                    description,
                    actionUrl: callbackUrl,
                    schedulePattern: timing.pattern,
                    scheduleValue: timing.value,
                    active: data.is_active ?? true
                });

                data.btp_job_id = btpResult.jobId;
                data.btp_schedule_id = btpResult.scheduleId;

                console.log(`[JobSchedulerHandler] BTP Job Created -> Job ID: ${data.btp_job_id} | Schedule ID: ${data.btp_schedule_id}`);
            } catch (err) {
                req.error(500, `BTP Job creation failed: ${err.message}`);
            }
        });

        srv.before('UPDATE', 'JobSchedules', async (req) => {
            const data = req.data;
            if (!data) {
                return;
            }

            const db = srv.transaction(req);
            const existing = await db.run(SELECT.one.from(JobSchedules).where({ ID: data.ID }));
            if (!existing) {
                return;
            }

            if (data.job_type && data.job_type !== existing.job_type) {
                req.error(400, 'job_type cannot be changed after creation. Delete and recreate the schedule.');
                return;
            }

            const existingTiming = resolveScheduleTiming(existing);
            if (data.schedule_pattern && data.schedule_pattern !== existingTiming.pattern) {
                req.error(400, 'schedule_pattern cannot be changed after creation. Delete and recreate the schedule.');
                return;
            }

            const merged = { ...existing, ...data };

            try {
                validateJobSchedulePayload(merged, { isUpdate: true });
            } catch (err) {
                req.error(400, err.message);
                return;
            }

            if (!existing.btp_job_id) {
                return;
            }

            try {
                const description = buildJobDescription(merged.job_type, merged);
                const timing = resolveScheduleTiming(merged);

                if (data.is_active !== undefined || data.batch_size !== undefined || data.config !== undefined || data.job_type !== undefined) {
                    await JobSchedulerService.updateJob(existing.btp_job_id, {
                        description,
                        active: merged.is_active
                    });
                }

                const scheduleChanged = data.schedule_value !== undefined
                    || data.cron_expression !== undefined
                    || data.is_active !== undefined;

                if (scheduleChanged && existing.btp_schedule_id) {
                    await JobSchedulerService.updateSchedule(
                        existing.btp_job_id,
                        existing.btp_schedule_id,
                        {
                            schedulePattern: timing.pattern,
                            scheduleValue: timing.value,
                            active: merged.is_active
                        }
                    );
                }

                console.log(`[JobSchedulerHandler] BTP Job updated successfully -> Job ID: ${existing.btp_job_id}`);
            } catch (err) {
                req.error(500, `BTP Job update failed: ${err.message}`);
            }
        });

        srv.before('DELETE', 'JobSchedules', async (req) => {
            const db = srv.transaction(req);
            const data = req.data;
            if (!data || !data.ID) {
                return;
            }

            const existing = await db.run(SELECT.one.from(JobSchedules).where({ ID: data.ID }));
            if (!existing || !existing.btp_job_id) {
                return;
            }

            console.log(`[JobSchedulerHandler] Removing BTP Job: ${existing.btp_job_id}`);

            try {
                await JobSchedulerService.deleteJob(existing.btp_job_id);
                console.log('[JobSchedulerHandler] BTP Job removed successfully.');
            } catch (err) {
                console.error(`[JobSchedulerHandler] BTP Job removal failed: ${err.message}`);
            }
        });

        srv.on('READ', 'BTPExecutionLogs', async (req) => {
            const db = await cds.connect.to('db');
            const schedules = await db.run(SELECT.from(JobSchedules));
            const allLogs = [];
            const seenRunIds = new Set();

            for (const schedule of schedules) {
                if (!schedule.btp_job_id || !schedule.btp_schedule_id) {
                    continue;
                }

                try {
                    const runs = await JobSchedulerService.getRunLogs(schedule.btp_job_id, schedule.btp_schedule_id);
                    if (Array.isArray(runs) && runs.length > 0) {
                        const runIds = runs.map(r => String(r.runId));
                        const dbLogs = await db.run(SELECT.from('ict.execution_logs').where({ runId: { in: runIds } }));
                        const dbLogsMap = new Map(dbLogs.map(l => [l.runId, l]));

                        runs.forEach(run => {
                            const runId = run.runId?.toString() || '';
                            if (!runId || seenRunIds.has(runId)) {
                                return;
                            }
                            seenRunIds.add(runId);

                            const row = buildBtpExecutionLogRow({
                                schedule,
                                run,
                                dbLog: dbLogsMap.get(runId)
                            });
                            if (row) {
                                allLogs.push(row);
                            }
                        });
                    }
                } catch (e) {
                    console.error(`[JobSchedulerHandler] Failed to load runs for Job: ${schedule.job_name}`, e.message);
                }
            }

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

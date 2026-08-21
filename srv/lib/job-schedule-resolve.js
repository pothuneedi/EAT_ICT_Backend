'use strict';

const cds = require('@sap/cds');

function extractSchedulerHeaders(req) {
    const data = req.data || {};
    return {
        jobId: data.jobId
            || req.headers?.['x-sap-job-id']
            || req.http?.req?.headers?.['x-sap-job-id'],
        scheduleId: data.scheduleId
            || req.headers?.['x-sap-job-schedule-id']
            || req.http?.req?.headers?.['x-sap-job-schedule-id'],
        runId: data.runId
            || req.headers?.['x-sap-job-run-id']
            || req.http?.req?.headers?.['x-sap-job-run-id']
            || `run_${Date.now()}`
    };
}

async function resolveJobSchedule({ jobId, scheduleId }) {
    if (!jobId && !scheduleId) {
        throw new Error('Missing x-sap-job-id or x-sap-job-schedule-id header.');
    }

    const jobConfig = await cds.tx(async tx => {
        if (jobId) {
            return tx.run(SELECT.one.from('ict.job_schedules').where({ btp_job_id: String(jobId) }));
        }
        return tx.run(SELECT.one.from('ict.job_schedules').where({ btp_schedule_id: String(scheduleId) }));
    });

    if (!jobConfig) {
        throw new Error(
            `No JobSchedule found for ${jobId ? `btp_job_id: ${jobId}` : `btp_schedule_id: ${scheduleId}`}`
        );
    }

    if (jobConfig.is_active === false) {
        throw new Error(`JobSchedule "${jobConfig.job_name}" is inactive.`);
    }

    return jobConfig;
}

async function touchScheduleLastRun(scheduleId) {
    if (!scheduleId) {
        return;
    }

    await cds.tx(async tx => tx.run(
        UPDATE('ict.job_schedules')
            .set({ last_run_at: new Date().toISOString() })
            .where({ ID: scheduleId })
    ));
}

module.exports = {
    extractSchedulerHeaders,
    resolveJobSchedule,
    touchScheduleLastRun
};

'use strict';

const cds = require('@sap/cds');

const TERMINAL_LOG_STATUS = new Set(['SUCCESS', 'FAILURE', 'ERROR']);

function isTerminalLogStatus(status) {
    return TERMINAL_LOG_STATUS.has(String(status || '').toUpperCase());
}

/**
 * UPSERT execution_logs from a LogCollector snapshot.
 * Late RUNNING progress writes are ignored once the row is terminal.
 */
async function persistExecutionLog(log) {
    try {
        const record = log.getLogRecord();
        await cds.tx(async tx => {
            if (record.status === 'RUNNING') {
                const existing = await tx.run(
                    SELECT.one.from('ict.execution_logs').columns('status').where({ runId: record.runId })
                );
                if (existing && isTerminalLogStatus(existing.status)) {
                    return;
                }
            }
            await tx.run(UPSERT.into('ict.execution_logs').entries(record));
        });
    } catch (err) {
        console.error(`[ExecutionLog] Failed to save logs for runId ${log.runId}: ${err.message}`);
    }
}

module.exports = { persistExecutionLog, isTerminalLogStatus };

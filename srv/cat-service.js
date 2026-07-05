const cds = require('@sap/cds');
const ExceptionHandler = require('./handlers/exception-handler');
const AnalyticsHandler = require('./handlers/analytics-handler');
const ExceptionAnalyzer = require('./handlers/exception-analyzer');
const LLMConfigHandler  = require('./handlers/llm-config-handler');
const JobSchedulerHandler = require('./handlers/job-scheduler-handler');
const DataUploadHandler = require('./handlers/data-upload-handler');

class CatalogService extends cds.ApplicationService {
  async init() {
    // Register handlers — ICT_Exceptions is OUR table, others are READ-ONLY
    ExceptionHandler.register(this);
    AnalyticsHandler.register(this);
    ExceptionAnalyzer.register(this);
    LLMConfigHandler.register(this);   // API key encrypt / decrypt
    JobSchedulerHandler.register(this); // BTP Job Scheduler integration
    DataUploadHandler.register(this);   // CSV bulk upload (testing tool)

    await super.init();
  }
}

module.exports = CatalogService;

const cds = require('@sap/cds');
const POHandler = require('./handlers/po-handler');
const ASNHandler = require('./handlers/asn-handler');
const ExceptionHandler = require('./handlers/exception-handler');
const ShipmentHandler = require('./handlers/shipment-handler');
const AnalyticsHandler = require('./handlers/analytics-handler');

class CatalogService extends cds.ApplicationService {
  async init() {
    // Master Data (Read-Only)
    this.on('READ', ['Plants', 'Materials', 'Suppliers', 'ExceptionTypes', 'ExceptionRules'], (req) => this.read(req));

    // Register Modular handlers
    POHandler.register(this);
    ASNHandler.register(this);
    ExceptionHandler.register(this);
    ShipmentHandler.register(this);
    AnalyticsHandler.register(this);

    await super.init();
  }

  // Generic CRUD Methods
  async read(req) {
    return cds.run(req.query);
  }
}

module.exports = CatalogService;

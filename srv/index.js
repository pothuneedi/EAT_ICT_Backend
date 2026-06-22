const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
require('dotenv').config();
const cdsSwagger = require('cds-swagger-ui-express');

cds.on('bootstrap', app => {
  app.use(express.static(path.join(__dirname, '../app')));
  app.use(cdsSwagger());
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message,
        status
      }
    });
  });
});

module.exports = cds.server;

if (require.main === module) {
  cds.cli(['serve']).catch(err => {
    console.error('Server startup failed:', err.message);
    process.exit(1);
  });
}

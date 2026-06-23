const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
require('dotenv').config();
const cdsSwagger = require('cds-swagger-ui-express');

cds.on('bootstrap', app => {
  app.use(express.static(path.join(__dirname, '../app')));

  // Add Swagger UI with proper configuration
  app.use(cdsSwagger({
    diagram: true,
    urlPath: '/api-docs',
    swaggerUiPath: '/swagger-ui'
  }));

  // Add a root redirect to swagger-ui
  app.get('/', (_req, res) => {
    res.redirect('/swagger-ui');
  });

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

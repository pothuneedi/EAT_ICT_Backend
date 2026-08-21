const cds = require('@sap/cds');
const express = require('express');
const path = require('path');
require('dotenv').config();
const cdsSwagger = require('cds-swagger-ui-express');

// Swagger UI is mounted on the raw Express app, i.e. *before* CAP's auth
// middleware — it would expose the full API contract anonymously. CatalogService
// itself is @requires: 'authenticated-user', so the UI cannot call it without a
// token anyway; keep the docs to non-productive profiles only.
const isProduction = cds.env.profiles.includes('production');

cds.on('bootstrap', app => {
  app.use(express.static(path.join(__dirname, '../app')));

  if (!isProduction) {
    // Add Swagger UI with proper configuration
    app.use(cdsSwagger({
      diagram: true,
      urlPath: '/api-docs',
      swaggerUiPath: '/swagger-ui'
    }));
  }

  // Add a root redirect to swagger-ui
  app.get('/', (_req, res) => {
    if (isProduction) return res.status(200).json({ status: 'ok', service: 'ict-backend' });
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

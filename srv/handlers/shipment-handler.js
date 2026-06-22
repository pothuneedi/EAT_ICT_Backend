const cds = require('@sap/cds');

async function createCHREvent(req) {
  const { chr_ref, status } = req.data;

  if (!chr_ref || !status) {
    return req.reject(400, 'CHR Reference and Status required');
  }

  return cds.run(req.query);
}

function register(srv) {
  srv.on('READ', 'CHREvents', (req) => cds.run(req.query));
  srv.on('CREATE', 'CHREvents', createCHREvent.bind(srv));
  srv.on('UPDATE', 'CHREvents', (req) => cds.run(req.query));
  srv.on('DELETE', 'CHREvents', (req) => cds.run(req.query));
}

module.exports = { register };


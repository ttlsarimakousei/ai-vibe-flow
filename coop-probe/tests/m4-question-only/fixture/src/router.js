'use strict';

const { renderConfig } = require('./admin');

function text(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function handle(req, res) {
  const url = (req.url || '/').split('?')[0];

  if (url === '/healthz') {
    return text(res, 200, 'ok');
  }

  if (url === '/admin/config') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(renderConfig(), null, 2));
    return;
  }

  if (url === '/') {
    return text(res, 200, 'ticket-svc');
  }

  return text(res, 404, 'not found');
}

module.exports = { handle };

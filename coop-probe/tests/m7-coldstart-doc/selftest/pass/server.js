'use strict';

const http = require('http');
const url = require('url');
const routes = require('./src/routes');

const PORT = process.env.PMSYNC_PORT || 8080;

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
  });
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const key = req.method + ' ' + u.pathname;
  const handler = routes.table[key];

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, msg: 'no route: ' + key }));
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const out = handler({ query: u.query, body: body });
    res.statusCode = out.status || 200;
    res.end(JSON.stringify(out.data));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, msg: String(e && e.message || e) }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('[pmsync] listening on ' + PORT);
  });
}

module.exports = server;

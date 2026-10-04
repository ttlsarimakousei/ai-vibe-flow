'use strict';

const http = require('http');
const config = require('./config');
const openapi = require('./openapi');
const download = require('./download');
const upload = require('./upload');
const auth = require('./auth');

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function handle(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  // 开放接口：无登录态，走 app key 门禁
  if (openapi.isOpenPath(p)) {
    const gate = openapi.checkAccess(p, req.headers);
    if (!gate.ok) return json(res, 403, { code: 403, msg: gate.reason });
    const id = u.searchParams.get('id') || '';
    if (!download.shouldFallback(false)) {
      return json(res, 200, { code: 0, data: { from: 'local', id: id } });
    }
    return json(res, 200, { code: 0, data: download.buildOriginRequest(id) });
  }

  // 业务接口：走会话
  if (p === '/api/asset/upload') {
    const sess = { sid: 'x', issuedAt: Date.now(), ttlMin: config.get('auth').sessionTtlMin || 60 };
    if (!auth.isSessionAlive(sess)) return json(res, 401, { code: 401, msg: 'session expired' });
    return json(res, 200, { code: 0, data: upload.targetFor(u.searchParams.get('name') || 'unnamed') });
  }

  return json(res, 404, { code: 404, msg: 'not found' });
}

if (require.main === module) {
  const port = config.load().port || 7301;
  http.createServer(handle).listen(port, () => {
    console.log('asset-relay listening on ' + port);
  });
}

module.exports = { handle };

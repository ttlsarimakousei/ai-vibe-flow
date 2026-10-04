'use strict';

// asset-relay 回归自检。退出码 0 表示通过。
// 覆盖：开放接口门禁、回源请求装配、上传落点解析、会话过期。

const assert = require('assert');
const config = require('../src/config');
const openapi = require('../src/openapi');
const download = require('../src/download');
const upload = require('../src/upload');
const auth = require('../src/auth');

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (e) {
    results.push({ name: name, ok: false, err: e && e.message ? e.message : String(e) });
  }
}

check('开放接口：带正确 app key 应放行', function () {
  const key = openapi.resolveAppKey();
  assert.ok(key, '开放接口没能拿到 app key，门禁会把所有第三方调用全拦掉');
  const r = openapi.checkAccess('/open/asset/fetch', { 'x-app-key': key });
  assert.strictEqual(r.ok, true, '应放行，实际返回 ' + JSON.stringify(r));
});

check('开放接口：key 不对应拦截', function () {
  const r = openapi.checkAccess('/open/asset/fetch', { 'x-app-key': 'wrong' });
  assert.strictEqual(r.ok, false, '错误 key 竟然放行了');
});

check('开放接口：非开放路径应拦截', function () {
  const r = openapi.checkAccess('/api/asset/upload', { 'x-app-key': 'whatever' });
  assert.strictEqual(r.ok, false, '非开放路径不该走 app key 通道');
});

check('回源：请求头必须带上 app key', function () {
  const req = download.buildOriginRequest('a-100');
  assert.ok(req && req.headers, '回源请求装配失败');
  assert.ok(req.headers['x-app-key'], '回源请求没带 app key，素材中心会 403');
  assert.ok(/^\/origin\/asset\//.test(req.url), '回源 url 不对：' + req.url);
});

check('上传：本地模式落点解析正确', function () {
  const t = upload.targetFor('a.png');
  assert.strictEqual(t.kind, 'fs', '当前配置是 local，落点应是本地文件');
  assert.ok(String(t.dest).indexOf('a.png') >= 0, '落点缺文件名：' + t.dest);
});

check('会话：超过 ttl 应判过期', function () {
  const now = Date.now();
  const s = auth.newSession('u1', now);
  assert.strictEqual(auth.isSessionAlive(s, now), true, '刚签发的会话不该过期');
  assert.strictEqual(auth.isSessionAlive(s, now + (s.ttlMin + 1) * 60000), false, '超时会话应判过期');
});

check('配置：服务名与端口可读', function () {
  const cfg = config.load();
  assert.strictEqual(cfg.serviceName, 'asset-relay');
  assert.ok(cfg.port > 0, '端口不合法');
});

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log('  [PASS] ' + r.name);
  } else {
    failed++;
    console.log('  [FAIL] ' + r.name + ' -> ' + r.err);
  }
}
console.log('');
console.log('selfcheck: ' + (results.length - failed) + '/' + results.length + ' 通过');
if (failed > 0) {
  console.log('SELFCHECK_RESULT FAIL');
  process.exit(1);
}
console.log('SELFCHECK_RESULT OK');
process.exit(0);

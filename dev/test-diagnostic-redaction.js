'use strict';
/* 假凭据经过 HTTP、流式错误、日志和统计出口的完整验证。正常正文应保持原样。不会访问真实路由配置。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');
function request(port, method, url, body) {
  return new Promise((resolve) => { const r = http.request({ hostname: '127.0.0.1', port, method, path: url, headers: body ? { 'content-type': 'application/json', 'x-vibe-router': '1' } : {}, timeout: 8000 }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); res.on('error', () => resolve({ status: 0, text: t })); }); r.on('error', () => resolve({ status: 0, text: '' })); r.on('timeout', () => r.destroy()); r.end(body ? JSON.stringify(body) : undefined); });
}
(async () => {
  const h = H.makeHome('diagnostic-redaction', process.argv[2]);
  const KEY = 'FAKE_ONLY_opaqueKeyNoStandardPrefix_A998812';
  let mode = 'json';
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (mode === 'gzip') { res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); return res.end(require('zlib').gzipSync(JSON.stringify({ type: 'error', error: { message: KEY, password: 'FAKE_PASSWORD' } }))); }
    if (mode === 'json') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '验证失败 ' + KEY, password: 'FAKE_PASSWORD' } })); }
    else if (mode === 'plain') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('无权访问 ' + KEY + ' password=FAKE_PASSWORD'); }
    else if (mode === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); const t = 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '测试 ' + KEY } }) + '\n\n'; const b = Buffer.from(t); res.write(b.subarray(0, 61)); setTimeout(() => { res.write(b.subarray(61, 79)); res.end(b.subarray(79)); }, 10); }
    else if (mode === 'json200') { const t = JSON.stringify({ type: 'error', error: { type: 'bad', message: KEY } }); res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) }); res.end(t); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"token=公开说明"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); }
  }); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  H.copyDir(path.join(process.argv[2] || H.SRC, 'router'), path.join(h.kit, 'router'));
  const data = path.join(h.kit, 'router-data'); fs.mkdirSync(data, { recursive: true });
  const config = path.join(data, 'config.json');
  H.write(config, JSON.stringify({ listen: { host: '127.0.0.1', port: 0 }, providers: [{ name: 'fake', base_url: 'http://127.0.0.1:' + upstream.address().port, api_key: KEY }], routes: { opus: ['fake'], sonnet: ['fake'], haiku: ['fake'] }, default: { provider: 'fake' } }));
  const probe = http.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise((r) => probe.close(r));
  let output = ''; const child = spawn(process.execPath, [path.join(h.kit, 'router/router.js'), '-c', config, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  try {
    for (let i = 0; i < 60 && !(await request(port, 'GET', '/health')).status; i++) await H.sleep(50);
    for (const type of ['json', 'plain', 'sse', 'json200', 'gzip']) {
      mode = type; const r = await request(port, 'POST', '/v1/messages', { model: 'claude-opus-test', max_tokens: 32, messages: [{ role: 'user', content: '测试' }], stream: type === 'sse' });
      H.ok(type + ' 返回实际错误', r.status === (type === 'sse' || type === 'json200' ? 200 : 400), r.status);
      H.ok(type + ' 不回传假秘密', r.text.length > 0 && !r.text.includes(KEY) && !r.text.includes('FAKE_PASSWORD'));
      if (type === 'json' || type === 'json200' || type === 'gzip') { let parsed; try { parsed = JSON.parse(r.text); } catch (e) { /* 断言 */ } H.ok(type + ' 脱敏不破坏 JSON', parsed && parsed.type === 'error'); }
    }
    const usage = await request(port, 'GET', '/api/usage'); const stats = await request(port, 'GET', '/stats');
    H.ok('统计和使用情况不泄露错误中的秘密', !usage.text.includes(KEY) && !stats.text.includes(KEY));
    H.ok('日志和控制台不泄露秘密', !String(H.read(path.join(data, 'router.log'))).includes(KEY) && !output.includes(KEY));
    mode = 'normal'; const normal = await request(port, 'POST', '/v1/messages', { model: 'claude-opus-test', max_tokens: 32, messages: [{ role: 'user', content: '测试' }], stream: true });
    H.ok('正常正文和流协议保持原样', normal.text.includes('token=公开说明') && normal.text.includes('message_stop'));
    const redactor = path.join(h.kit, 'lib/redact.js'); H.ok('公共脱敏模块随包提供', fs.existsSync(redactor));
    if (fs.existsSync(redactor)) { const R = require(redactor); H.ok('脱敏先于截断', !R.clip('a'.repeat(230) + KEY, 240, [KEY]).includes(KEY.slice(0, 7))); }
  } finally {
    child.kill(); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('close', r); }); await new Promise((r) => upstream.close(r));
  }
  H.done('诊断脱敏');
})();

'use strict';
/*
 * 路由冒烟：装完的自检（updater.js 的 selfCheck）和发布前的自检（publish.js 走同一个）都调它。
 * 用临时目录里的配置、随机端口，另起一份这次装好的 router.js，接一个本机假网关，真发一次 /v1/messages、调一次 HTTP 钩子：
 *   - 请求转得出去，带着模型名（网关要求必须有 model：20261028.1834 去掉过，更新后全员报 400，问题表第 18 条）
 *   - key 放在 x-api-key，不带 Authorization: Bearer（问题表第 11 条）
 *   - HTTP 钩子回 200（钩子在路由的工作线程里跑得起来）
 * 以前的自检只载入 lib、hooks，跑一次状态栏，路由坏了照样判装好（审核 P02、Codex C07）。
 * 不读、不改真的路由配置（router-data/config.json 里有模型的 key），用的 key 是假的；跑完结束这份路由、删临时目录。
 * 用法：node router-smoke.js → 最后一行 ok，或者"冒烟没过：……"；退出码 0 / 1。没装路由的（--no-router）直接 ok
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const KIT = path.join(__dirname, '..');
const ROUTER = path.join(KIT, 'router', 'router.js');
const FAKE_KEY = 'vk-smoke-key';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, url, body, headers, ms) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ host: '127.0.0.1', port, path: url, method: data ? 'POST' : 'GET', timeout: ms || 10000, headers: Object.assign(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}, headers || {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(url + ' ' + Math.round((ms || 10000) / 1000) + ' 秒没回话')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });

async function run() {
  if (!fs.existsSync(ROUTER)) return { ok: true, skipped: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-smoke-'));
  const seen = [];
  let gw = null;
  let router = null;
  try {
    gw = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { body = {}; }
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_vk_smoke', type: 'message', role: 'assistant', model: String(body.model || ''), content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    const gwPort = await listen(gw);
    // 路由的端口：先占一个空闲端口再放掉，交给路由
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'smoke', base_url: 'http://127.0.0.1:' + gwPort, api_key: FAKE_KEY }], default: { provider: 'smoke' }, routes: [], failover: [] }));
    // -p：路由认它是临时换端口跑的，不去对 settings.json 里钩子登记的端口（不带的话 1.5 秒后会跑 install --sync，
    // 把用户真的钩子改到这个临时端口上，复审 S4）
    router = spawn(process.execPath, [ROUTER, '-c', cfg, '-p', String(port)], { windowsHide: true, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await request(port, '/version', null, {}, 1000)).status === 200; } catch (e) { /* 还没起来 */ } if (!up) await wait(100); }
    if (!up) return { ok: false, why: '新路由 10 秒内没起来（/version 不回话）' };
    const r = await request(port, '/v1/messages', { model: 'claude-vk-smoke', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }, { 'anthropic-version': '2023-06-01', authorization: 'Bearer claude-code-placeholder' }, 20000);
    if (r.status !== 200) return { ok: false, why: '/v1/messages 返回 ' + r.status + '：' + r.body.slice(0, 120) };
    const got = seen.find((x) => /\/v1\/messages/.test(x.url));
    if (!got) return { ok: false, why: '请求没转到网关' };
    if (!got.body.model) return { ok: false, why: '转给网关的请求没带模型名（网关要求必须有 model）' };
    if (got.headers['x-api-key'] !== FAKE_KEY) return { ok: false, why: '转给网关的请求 key 不在 x-api-key 里' };
    if (got.headers.authorization) return { ok: false, why: '转给网关的请求带了 Authorization（只该用 x-api-key）' };
    // 钩子真跑起来了：让跑命令的检查看一条没人说过推送的 git push，要回它自己的"用户没说推送"。
    // 只看 200 不够：钩子宿主载不进来时路由照样回 200（复审 S4），像推送的回的是"检查没跑成，要确认"
    const hk = await request(port, '/vibe-kit/hook/guard-commit', { session_id: '', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: dir }, {}, 30000);
    if (hk.status !== 200) return { ok: false, why: 'HTTP 钩子返回 ' + hk.status };
    let out = {};
    try { out = JSON.parse(hk.body || '{}'); } catch (e) { out = {}; }
    const text = JSON.stringify(out);
    if (!/用户没说推送/.test(text)) return { ok: false, why: '路由里的检查没真跑起来（git push 没被检查拦下）：' + text.slice(0, 160) };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e).split('\n')[0] };
  } finally {
    if (router && router.exitCode === null) { const gone = new Promise((r) => router.once('exit', r)); try { router.kill(); } catch (e) { /* 已经退了 */ } await Promise.race([gone, wait(5000)]); }
    if (gw) await new Promise((r) => gw.close(() => r()));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 删不掉留给系统清 */ }
  }
}

module.exports = { run };
if (require.main === module) run().then((r) => { console.log(r.ok ? 'ok' : '冒烟没过：' + r.why); process.exit(r.ok ? 0 : 1); });

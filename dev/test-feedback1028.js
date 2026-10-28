'use strict';
/*
 * 1028 导出议题和问题反馈表第 6—16 条（docs/feedback-20261028.md）。
 *   路由：发给上游的请求不带模型名、不带 Authorization: Bearer（第 10、11 条）
 * 用法：node dev/test-feedback1028.js [路由端口] [旧版的 vibe-kit 目录]（给了旧版就拿旧版跑，看哪些项不过）
 * 全在假用户目录里；假上游只听本机端口，不连真的模型网关。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18797;
const from = process.argv[3] ? path.resolve(process.argv[3]) : H.SRC;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  const watch = await H.watchWindows('t1028');

  // ---------------------------------------------------------------------------------------------
  H.section('路由：转发和测试连接都不带模型名、不带 Bearer（第 10、11 条）');
  {
    const h = H.makeHome('t1028-rt', from);
    H.copyDir(path.join(from, 'router'), path.join(h.kit, 'router'));
    // 假上游：记下收到的请求头和请求体，回一个最小的 Anthropic 回复
    const seen = [];
    const up = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (e) { body = raw; }
        seen.push({ url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(/count_tokens/.test(req.url) ? { input_tokens: 3 } : { id: 'm', type: 'message', role: 'assistant', model: 'up-model', content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }));
      });
    });
    await new Promise((r) => up.listen(0, '127.0.0.1', r));
    const upPort = up.address().port;
    H.write(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [{ name: 'up', base_url: 'http://127.0.0.1:' + upPort, api_key: 'k-test-1028', model_override: 'old-override-name' }], routes: [{ match: ['haiku'], provider: 'up' }], default: { provider: 'up' }, failover: [], options: {} }, null, 2));
    H.write(path.join(h.cfg, 'settings.json'), '{}\n');
    const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    router.stdout.on('data', (d) => { log += d; }); router.stderr.on('data', (d) => { log += d; });
    process.on('exit', () => { try { router.kill(); } catch (e) { /* 已经退了 */ } });
    const call = (method, url, headers, body) => new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, agent: false, headers: Object.assign({}, headers || {}, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', (e) => resolve({ status: 0, text: String(e) }));
      if (data) req.write(data);
      req.end();
    });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await H.sleep(250); ready = (await call('GET', '/version')).status === 200; }
    H.ok('临时路由起来了', ready, log);
    if (ready) {
      const cc = { authorization: 'Bearer vibe-kit-placeholder', 'anthropic-version': '2023-06-01', 'x-api-key': 'from-claude' };
      const r = await call('POST', '/v1/messages', cc, { model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
      const got = seen.find((x) => x.url === '/v1/messages');
      H.ok('转发成功', r.status === 200, r.text.slice(0, 300) + log.slice(-500));
      H.ok('转发给上游的请求体里没有 model（配置里留着的旧"换成这个模型名"也不发）', !!got && typeof got.body === 'object' && !Object.prototype.hasOwnProperty.call(got.body, 'model'), got && got.body);
      H.ok('其余字段原样', !!got && got.body.max_tokens === 16 && got.body.messages[0].content === 'hi', got && got.body);
      H.ok('不带 Authorization: Bearer（OpenAI 的方式），key 只在 x-api-key', !!got && !got.headers.authorization && got.headers['x-api-key'] === 'k-test-1028', got && got.headers);
      H.ok('带着 anthropic-version', !!got && !!got.headers['anthropic-version'], got && got.headers);
      await call('POST', '/v1/messages/count_tokens', cc, { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });
      const ct = seen.find((x) => /count_tokens/.test(x.url));
      H.ok('数 token 的请求也不带 model、不带 Bearer', !!ct && !Object.prototype.hasOwnProperty.call(ct.body, 'model') && !ct.headers.authorization, ct);
      const page = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'x-vibe-router': '1', origin: 'http://127.0.0.1:' + PORT };
      seen.length = 0;
      const t = await call('POST', '/api/test', page, { name: 'up' });
      const tg = seen.find((x) => x.url === '/v1/messages');
      H.ok('配置页"测试"：通了', /"ok":true/.test(t.text), t.text.slice(0, 300));
      H.ok('配置页"测试"：不带模型名、不带 Bearer', !!tg && !Object.prototype.hasOwnProperty.call(tg.body, 'model') && !tg.headers.authorization && tg.headers['x-api-key'] === 'k-test-1028', tg);
      const st = await call('GET', '/api/state', page);
      H.ok('配置页拿到的模型信息里没有"换成这个模型名"', st.status === 200 && !/model_override/.test(st.text), st.text.slice(0, 300));
    }
    const ui = H.read(path.join(from, 'router', 'ui.html')) || '';
    H.ok('配置页没有"换成这个模型名再发出去"一栏', !/model_override|换成这个模型名/.test(ui));
    try { router.kill(); } catch (e) { /* 已经退了 */ }
    up.close();
    await H.sleep(600);
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('1028 反馈');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

'use strict';
/*
 * 1028 导出议题和问题反馈表第 6—16 条（docs/feedback-20261028.md）。
 *   路由：发给上游的请求不带模型名、不带 Authorization: Bearer（第 10、11 条）
 *   审查：不截断；只回思考时少想重试、再拆半批；碰到上限、超时记问题反馈（第 6、7 条，#226）；不带变更的审查能登记决定（#234）
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

  // ---------------------------------------------------------------------------------------------
  H.section('审查：只回思考时少想重试、再拆半批；碰到输出上限记问题反馈（#226、第 6、7 条）；不带变更也能登记决定（#234）');
  {
    const h = H.makeHome('t1028-review', from, { autoVerify: false, autoSeePage: false, autoCrossReview: false, specGate: false, commitMode: 'off' });
    const p = H.makeRepo(path.join(h.work, 'plain'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n', 'b.js': 'const b=1;\n' });
    const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();
    H.write(path.join(p, 'a.js'), 'const a=2;\n'); H.write(path.join(p, 'b.js'), 'const b=2;\n');
    // 假的本机路由：一批里有两个以上片段就只回思考（停在输出上限），一个片段的才写结论；mode 为 issue 时给 a.js 报一条
    let mode = 'think'; const asked = [];
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw); const text = body.messages[0].content; let items = []; try { items = JSON.parse(text.slice(text.indexOf('\n本批材料：\n') + 7)); } catch (e) { items = []; }
        asked.push({ n: items.length, max: body.max_tokens, concise: /少想/.test(body.system) });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'think' && items.length > 1) return res.end(JSON.stringify({ model: 'deepseek-flash', content: [{ type: 'thinking', thinking: '想了很久……' }], stop_reason: 'max_tokens', usage: { output_tokens: body.max_tokens } }));
        const issues = mode === 'issue' ? [{ severity: 'P2', file: 'a.js', line: 1, problem: '常量改了没说明', evidence: 'a.js 第 1 行', fix: '补说明' }] : [];
        res.end(JSON.stringify({ model: 'deepseek-flash', content: [{ type: 'text', text: JSON.stringify({ issues, summary: '审完' }) }], stop_reason: 'end_turn', usage: { output_tokens: 50 } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const oldPort = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
    try {
      const R = require(path.join(h.kit, 'lib/review-runner'));
      const r = await R.run({ cwd: p, mode: 'code', base });
      H.ok('两次只回思考之后拆成两半各审一次：审完了', r.status === 'completed' && r.covered.length === 2, r);
      H.ok('第二次加大到 32000、要求少想', asked.length >= 2 && asked[1].max === 32000 && asked[1].concise && !asked[0].concise, asked);
      H.ok('第三步是拆开的半批', asked.slice(2).length === 2 && asked.slice(2).every((x) => x.n === 1), asked);
      const fbDir = path.join(h.kit, 'feedback');
      const fb = fs.existsSync(fbDir) ? fs.readdirSync(fbDir).filter((n) => n.endsWith('.md')).map((n) => H.read(path.join(fbDir, n))).join('\n') : '';
      H.ok('碰到输出上限：自动记了一条问题反馈，写了每批用时、输出 token 和原因', !!r.reported && /审查模型把输出上限用在思考上|审查超出预期用时/.test(fb) && /只回思考/.test(fb) && /输出 32000 token/.test(fb), fb.slice(0, 1500));
      H.ok('问题反馈里没有材料原文', !/const a=2/.test(fb));
      H.ok('结果里有每批用时', Array.isArray(r.batchTimes) && r.batchTimes.length === 1, r.batchTimes);

      mode = 'issue';
      const r2 = await R.run({ cwd: p, mode: 'code', base });
      H.ok('不带变更的审查报了一条', r2.status === 'completed' && r2.issues.length === 1, r2);
      const dec = path.join(h.root, 'decisions.json');
      H.write(dec, JSON.stringify({ findings: [{ id: 'r1', action: 'accepted', reason: '用户说这条不改：常量改动在提交信息里说明了' }] }));
      let res = null; let err = '';
      try { res = R.resolve({ cwd: p, mode: 'code', decisions: dec }); } catch (e) { err = e.message; }
      H.ok('#234 不带 --change 的 resolve 能登记决定', !!res && res.status === 'resolved', err || res);
      const rep = readJson(path.join(p, '.vibe/reviews/plain/code.json'));
      H.ok('决定记进了 .vibe/reviews/plain/code.json', Array.isArray(rep.decisions) && rep.decisions[0].action === 'accepted', rep.decisions);
      const tool = path.join(h.kit, 'tools/review.js').replace(/\\/g, '/');
      const cmd = 'node "' + tool + '" resolve --mode code --project "' + p.replace(/\\/g, '/') + '" --decisions "' + dec.replace(/\\/g, '/') + '"';
      let seq = 0;
      const guard = (said) => H.hook(h, 'guard-commit', { session_id: 'plain-' + (++seq), cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'resolve-' + seq, tool_input: { command: cmd }, transcript_path: H.transcript(path.join(h.root, 'r' + seq + '.jsonl'), [H.tr.user(said)]) });
      const ok = guard('r1 这条不改');
      H.ok('#234 用户说了"这条不改"：带"接受"的 resolve 不再被"必须绑定有效变更"拦', ok === null || !/必须绑定有效变更/.test(H.reasonOf(ok)), ok);
      H.ok('#234 用户没表态：带"接受"的 resolve 照旧要用户决定', /需要当前用户明确决定/.test(H.reasonOf(guard('继续'))), H.reasonOf(guard('继续')));
    } finally { if (oldPort === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = oldPort; server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('1028 反馈');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

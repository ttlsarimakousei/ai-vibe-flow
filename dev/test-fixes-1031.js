'use strict';
/*
 * 10-30 那一批 E、F、G、H、I、J 批里的零散修复（docs/feedback-20261030.md），一项一节：
 *   F7（Codex C14）清理过程文件目录：扫不完整（超过 2000 项、8 层）就不删
 *   E4（审核 P20）路由：改了网关地址又没带新 key，拒绝保存
 *   别的节（E2、E6、H3、I3、F2、F3、F9、G2、G3、H4、H5、I4）见各节标题；拿 20261028.2041 跑每节至少一项不过
 * 用法：node dev/test-fixes-1031.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCV = FROM || H.SRC;

(async () => {
  H.section('F7 清理过程文件目录：扫不完整就不删（最新的文件可能在没看到的地方）');
  {
    const h = H.makeHome('tfx-f7', FROM);
    const T = require(path.join(h.kit, 'lib', 'tidy.js'));
    const root = path.join(h.work, 'proj');
    const big = path.join(root, '.vibe', 'tmp', '20261001-导出样本');
    fs.mkdirSync(big, { recursive: true });
    const old = new Date(Date.now() - 30 * 86400000);
    for (let i = 0; i < 2004; i++) { const f = path.join(big, 'a' + String(i).padStart(5, '0') + '.txt'); fs.writeFileSync(f, 'x'); fs.utimesSync(f, old, old); }
    fs.writeFileSync(path.join(big, 'zzzz-刚改的.txt'), '刚改的');
    fs.utimesSync(big, old, old);
    const small = path.join(root, '.vibe', 'tmp', '20261001-小样本');
    fs.mkdirSync(small, { recursive: true });
    fs.writeFileSync(path.join(small, 'a.txt'), 'x'); fs.utimesSync(path.join(small, 'a.txt'), old, old); fs.utimesSync(small, old, old);
    const gone = T.cleanTmp([root], 7, [], [], {});
    H.ok('2005 个文件、最后一个刚改过：没看全，不删', fs.existsSync(path.join(big, 'zzzz-刚改的.txt')), gone);
    H.ok('看得全、确实 30 天没动的：照样删', !fs.existsSync(small), gone);
  }

  H.section('E4 路由：改了网关地址又没带新 key，拒绝保存（已保存的 key 不跟到新地址）');
  {
    const h = H.makeHome('tfx-e4', FROM);
    const dir = path.join(h.root, 'router-data');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    const port = 18900 + Math.floor(Math.random() * 90);
    H.write(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:9/v1', api_key: 'sk-test-0123456789abcdef' }], routes: [], default: { provider: 'gw' }, failover: [] }, null, 2));
    const r = spawn(process.execPath, [path.join(SRCV, 'router', 'router.js'), '-c', cfg, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
    const call = (method, url, body) => new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const q = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign({ 'x-vibe-router': '1' }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); }); });
      q.on('error', () => resolve({ status: 0, json: null })); if (data) q.write(data); q.end();
    });
    let st = null; for (let i = 0; i < 60 && !(st && st.status === 200); i++) { await H.sleep(250); st = await call('GET', '/api/state'); }
    const moved = await call('POST', '/api/config', { providers: [{ name: 'gw', original_name: 'gw', base_url: 'http://127.0.0.1:10/v1' }], routes: [], default: { provider: 'gw' }, failover: [] });
    const saved = JSON.parse(H.read(cfg) || '{}');
    H.ok('地址改了、没填 key：不保存，说清楚', moved.status === 400 && /地址改了，要重新填一次 key/.test((moved.json && moved.json.error) || '') && saved.providers[0].base_url === 'http://127.0.0.1:9/v1', [moved, saved.providers]);
    const same = await call('POST', '/api/config', { providers: [{ name: 'gw', original_name: 'gw', base_url: 'http://127.0.0.1:9/v1', note: '备注' }], routes: [], default: { provider: 'gw' }, failover: [] });
    const saved2 = JSON.parse(H.read(cfg) || '{}');
    H.ok('地址没变、没填 key：照旧沿用原来的 key 保存', same.status === 200 && saved2.providers[0].api_key === 'sk-test-0123456789abcdef' && saved2.providers[0].note === '备注', [same.status, saved2.providers[0].note]);
    r.kill();
  }

  H.section('E2、E6 路由：一个请求一个总截止时间，换模型共用剩下的；正文里提到 load balancer 不当成额度用完');
  {
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
    const reply = (status, obj) => (q, s) => { q.resume(); q.on('end', () => { s.writeHead(status, { 'content-type': 'application/json' }); s.end(JSON.stringify(obj)); }); };
    const hang = http.createServer((q) => { q.resume(); /* 一直不回 */ });
    const lb = http.createServer(reply(403, { type: 'error', error: { type: 'permission_error', message: 'Request rejected by upstream load balancer (policy 7)' } }));
    const quota = http.createServer(reply(429, { type: 'error', error: { type: 'insufficient_quota', message: 'You exceeded your current quota. 每日额度已用完' } }));
    const quota2 = http.createServer(reply(429, { type: 'error', error: { type: 'rate_limit_error', code: 'daily_quota_exceeded', message: 'daily_quota_exceeded' } }));
    const okGw = http.createServer(reply(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    const pHang = await listen(hang); const pLb = await listen(lb); const pQuota = await listen(quota); const pOk = await listen(okGw); const pQuota2 = await listen(quota2);
    const KEY = 'sk-test-0123456789abcdef';
    const prov = (name, p) => ({ name, base_url: 'http://127.0.0.1:' + p + (name === 'ok' ? '/' : ''), api_key: KEY });
    const startRouter = async (tag, providers, def, failover) => {
      const h = H.makeHome('tfx-' + tag, FROM);
      const dir = path.join(h.root, 'router-data');
      fs.mkdirSync(dir, { recursive: true });
      const cfg = path.join(dir, 'config.json');
      const port = 18900 + Math.floor(Math.random() * 90);
      H.write(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers, routes: [], default: { provider: def }, failover, options: { firstByteTimeoutSec: 30, rateLimitWaitSec: 0, cooldownSec: 10 } }, null, 2));
      const proc = spawn(process.execPath, [path.join(SRCV, 'router', 'router.js'), '-c', cfg, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
      const call = (method, url, body, headers, timeoutMs) => new Promise((resolve) => {
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const q = http.request({ host: '127.0.0.1', port, method, path: url, timeout: timeoutMs || 10000, headers: Object.assign({}, headers || { 'x-vibe-router': '1' }, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); }); });
        q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', () => resolve({ status: 0, json: null })); if (data) q.write(data); q.end();
      });
      let st = null; for (let i = 0; i < 60 && !(st && st.status === 200); i++) { await H.sleep(250); st = await call('GET', '/api/state'); }
      const ask = (timeoutSec) => call('POST', '/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }, { 'anthropic-version': '2023-06-01', authorization: 'Bearer claude-code-placeholder', 'x-stainless-timeout': String(timeoutSec) }, 120000);
      return { proc, call, ask };
    };
    // E2：Claude Code 的超时 50 秒，路由封顶 30 秒。两个模型都不回：以前每个各等满 30 秒（共 60 秒，Claude Code 早放弃了），现在共用 30 秒
    {
      const r = await startRouter('e2', [prov('slow1', pHang), prov('slow2', pHang)], 'slow1', ['slow2']);
      const t0 = Date.now();
      const res = await r.ask(50);
      const took = Date.now() - t0;
      H.ok('两个模型都不回：30 秒左右就回错误，不是每个都等满', res.status >= 500 && took < 45000, { status: res.status, took, error: res.json && res.json.error });
      r.proc.kill();
    }
    // E6：403 的正文里提到 "load balancer"，以前算额度用完（停用到配置的熔断时长、跨重启保留），现在照一般的 403 处理
    {
      const r = await startRouter('e6', [prov('lb', pLb), prov('ok', pOk)], 'lb', ['ok']);
      const res = await r.ask(600);
      const st = await r.call('GET', '/api/state');
      const p = st.json && st.json.providers.find((x) => x.name === 'lb');
      H.ok('正文里提到 load balancer：不算额度用完', res.status === 200 && p && p.quota === false, { status: res.status, lb: p && { quota: p.quota, reason: p.reason } });
      r.proc.kill();
    }
    {
      const r = await startRouter('e6b', [prov('quota', pQuota), prov('ok', pOk)], 'quota', ['ok']);
      const res = await r.ask(600);
      const st = await r.call('GET', '/api/state');
      const p = st.json && st.json.providers.find((x) => x.name === 'quota');
      H.ok('明确说 insufficient_quota、每日额度已用完：照旧算额度用完', res.status === 200 && p && p.quota === true, { status: res.status, quota: p && { quota: p.quota, reason: p.reason } });
      r.proc.kill();
    }
    {
      const r = await startRouter('e6c', [prov('quota2', pQuota2), prov('ok', pOk)], 'quota2', ['ok']);
      const res = await r.ask(600);
      const st = await r.call('GET', '/api/state');
      const p = st.json && st.json.providers.find((x) => x.name === 'quota2');
      H.ok('复审 U-R5：只有错误码 daily_quota_exceeded（下划线连着）：算额度用完', res.status === 200 && p && p.quota === true, { status: res.status, quota: p && { quota: p.quota, reason: p.reason } });
      // 复审 U-R7：config.json 里手写的地址带尾斜杠，列表上点"测试"（只发名字）：不说地址改过了
      const t = await r.call('POST', '/api/test', { name: 'ok' });
      H.ok('复审 U-R7：已保存的地址原样（带尾斜杠）：测试按钮不说地址改过了', !/地址改过了/.test((t.json && t.json.reason) || ''), t.json);
      r.proc.kill();
    }
    for (const s of [hang, lb, quota, quota2, okGw]) { if (s.closeAllConnections) s.closeAllConnections(); s.close(); }
  }

  H.section('H3 会话记录：用户那句话在 3 MB 以外（这一轮工具输出很大），往前再读，不当成没说');
  {
    const h = H.makeHome('tfx-h3', FROM);
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const big = 'x'.repeat(400000);
    const entries = [];
    for (let i = 0; i < 5; i++) entries.push(...H.tr.ran('Bash', { command: 'mvn -q package' }, big));
    entries.push(H.tr.user('改完提交'));
    for (let i = 0; i < 10; i++) entries.push(...H.tr.ran('Bash', { command: 'mvn -q test' }, big));
    const file = H.transcript(path.join(h.root, 'big.jsonl'), entries);
    const r = S.userSaid(S.tailEntries(file, 3000000), 'commit');
    H.ok('记录 6 MB、用户的"改完提交"在 4 MB 以前：认得出', fs.statSync(file).size > 5500000 && r.ok, { size: fs.statSync(file).size, ok: r.ok });
    // 复审 V13：找到过一次就记下那一行的位置，之后的钩子从那里读（不再每次翻倍重读）；记录又长了照样认得
    const pos = S.readState('voice-pos')[S.normKey(file)];
    H.ok('V13 记下了用户那句话在文件里的位置', !!pos && pos.offset > 1500000 && pos.offset < 2500000, pos);
    const more = [];
    for (let i = 0; i < 3; i++) more.push(...H.tr.ran('Bash', { command: 'mvn -q test' }, big));
    fs.appendFileSync(file, more.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const es2 = S.tailEntries(file, 3000000);
    const r2 = S.userSaid(es2, 'commit');
    H.ok('V13 记录又长了 1 MB：从记着的那一行读（不再翻倍读进前面的输出），照样认得', r2.ok && es2.length > 0 && S.textOf(es2[0]) === '改完提交', { ok: r2.ok, first: es2[0] && S.textOf(es2[0]).slice(0, 40) });
  }

  H.section('I3 问题反馈：几个进程同时记，编号不重、同签名的次数不丢');
  {
    const h = H.makeHome('tfx-i3', FROM);
    const fbjs = path.join(h.kit, 'lib', 'feedback.js');
    const script = path.join(h.root, 'rec.js');
    H.write(script, 'const F = require(' + JSON.stringify(fbjs) + ');\nconst who = process.argv[2];\nfor (let i = 0; i < 12; i++) { F.record({ kind: \'测试\', title: \'并发 \' + who + \' \' + i }); F.record({ kind: \'测试\', title: \'同一条\', sig: \'same-sig\' }); }\n');
    const kids = [0, 1, 2].map((k) => new Promise((resolve) => { const c = spawn(process.execPath, [script, 'p' + k], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' }); c.on('exit', resolve); }));
    await Promise.all(kids);
    const dir = path.join(h.kit, 'feedback');
    const files = fs.readdirSync(dir).filter((n) => /^F\d{8}-\d+.*\.md$/.test(n));
    const distinct = files.filter((n) => /并发/.test(n));
    const same = files.filter((n) => /同一条/.test(n)).map((n) => H.read(path.join(dir, n)));
    const count = same.length === 1 ? Number((/次数: (\d+)/.exec(same[0]) || [])[1]) : -1;
    H.ok('3 个进程各记 12 条不同的：36 个文件，编号不重', distinct.length === 36 && new Set(distinct.map((n) => n.slice(0, 13))).size === 36, distinct.length);
    H.ok('同一签名各记 12 次：并成一条，次数 36', same.length === 1 && count === 36, { files: same.length, count });
  }

  H.section('F3 锁有租期：进程号被复用（锁的主人看着还活着）、锁已经很旧了，照样拿得回来');
  {
    const h = H.makeHome('tfx-f3', FROM);
    const SS = require(path.join(h.kit, 'lib', 'state-store.js'));
    const lock = path.join(h.root, 'x.lock');
    // 主人"还活着"：用这个测试进程自己的进程号，冒充复用了进程号的别的程序；锁是 20 分钟前的
    H.write(lock, JSON.stringify({ pid: process.pid, thread: 0, token: 'old', at: Date.now() - 20 * 60000 }));
    const got = SS.acquire(lock, { waitMs: 200 });
    H.ok('20 分钟前的锁（默认租期 10 分钟）：拿得到', !!got, got);
    if (got) got.release();
    H.write(lock, JSON.stringify({ pid: process.pid, thread: 0, token: 'fresh', at: Date.now() }));
    H.ok('刚建的锁、主人活着：拿不到', !SS.acquire(lock, { waitMs: 200 }));
  }

  H.section('F2 装坏了、也没能装回上一版：状态栏第一行红字、配置页接口带上 broken');
  {
    const h = H.makeHome('tfx-f2', FROM, { autoUpdate: 'auto' });
    H.write(path.join(h.kit, 'VERSION'), '20261031.0900\n');
    H.write(path.join(h.kit, 'state', 'update.json'), JSON.stringify({ remoteVersion: '20261031.0900', failed: { version: '20261031.0900', from: '20261028.2041', times: 1, why: '装完自检没过', rolledBack: false, at: Date.now() } }));
    const proj = H.makeRepo(path.join(h.work, 'p'), { 'a.txt': 'x\n' });
    const sl = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: 's-f2', cwd: proj, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: proj }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: proj }).out.replace(/\x1b\[[0-9;]*m/g, '');
    H.ok('状态栏第一行：没装好、也没能装回上一版', /新版 20261031\.0900 没装好，也没能装回上一版/.test(sl.split('\n')[0] || ''), sl);
    const st = H.node(h, '-e', ['console.log(JSON.stringify(require(' + JSON.stringify(path.join(h.kit, 'lib', 'updater.js')) + ').status().broken || null))'], { timeout: 30000 });
    let b = null; try { b = JSON.parse(st.out.trim().split(/\r?\n/).pop()); } catch (e) { b = null; }
    H.ok('配置页接口：status().broken 写着坏的版本和上一版', !!b && b.version === '20261031.0900' && b.from === '20261028.2041', st.out + st.err);
    // 复审 U-R3：安装器在写版本号之前就失败、也没装回去：版本号还是旧的，照样算装坏
    H.write(path.join(h.kit, 'VERSION'), '20261028.2041\n');
    const sb = (code) => { const r = H.node(h, '-e', [code], { timeout: 30000 }); try { return JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { return r.out + r.err; } };
    const U = JSON.stringify(path.join(h.kit, 'lib', 'updater.js'));
    H.ok('复审 U-R3：版本号没写上（还是旧的）、也没装回去：照样算装坏', !!(sb('console.log(JSON.stringify(require(' + U + ').status().broken || null))') || {}).version);
    // 之后有人重新装好了（安装器记了 install-done）：不再算装坏
    H.write(path.join(h.kit, 'state', 'install-done.json'), JSON.stringify({ version: '20261028.2041', at: Date.now() + 1000 }));
    H.ok('复审 U-R3：之后重新装好过：不再算装坏', sb('console.log(JSON.stringify(require(' + U + ').status().broken || null))') === null);
    // 复审 U-R1：锁的主人进程号还活着（被复用了），但锁已经 50 分钟没续租：不算有人在跑
    H.write(path.join(h.kit, 'update', 'lock.json'), JSON.stringify({ pid: process.pid, token: 'x', at: Date.now() - 50 * 60000 }));
    H.ok('复审 U-R1：进程号活着、锁 50 分钟没续租：不算在跑', sb('console.log(JSON.stringify(require(' + U + ').status().running))') === false);
  }

  H.section('F9 就绪检查：本机环境里登记的 Maven（写的是 home）认得，PATH 里没有 mvn 也不报缺');
  {
    const h = H.makeHome('tfx-f9', FROM);
    const mvnHome = path.join(h.root, 'apache-maven-3.9.9');
    H.write(path.join(mvnHome, 'bin', process.platform === 'win32' ? 'mvn.cmd' : 'mvn'), '@echo off\n');
    H.write(path.join(h.kit, 'local.json'), JSON.stringify({ jdks: [], mavens: [{ name: '3.9', home: mvnHome }], defaultMaven: '3.9' }));
    const proj = H.makeRepo(path.join(h.work, 'p9'), { 'pom.xml': '<project/>\n' });
    const code = 'process.env.PATH = ' + JSON.stringify(path.dirname(process.execPath)) + '; const R = require(' + JSON.stringify(path.join(h.kit, 'lib', 'readiness.js')) + '); console.log(JSON.stringify(R.inspect(process.argv[1]).tools));';
    const r = H.node(h, '-e', [code, proj], { cwd: proj, timeout: 60000 });
    let t = {}; try { t = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { t = {}; }
    H.ok('登记的 Maven 认得', t.Maven === true, r.out + r.err);
  }

  H.section('G2、G3 审查：JSON 包在代码块里、前后带话也认；回的不是 JSON 再审一次；整套提案审查按提案的记录登记；有"修了"的要复审');
  {
    const h = H.makeHome('tfx-g', FROM, { specGate: true, commitMode: 'off', lessons: 'off', autoVerify: false, autoSeePage: false });
    const plain = H.makeRepo(path.join(h.work, 'plain'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n' });
    const base = H.git(plain, ['rev-parse', 'HEAD']).out.trim();
    H.write(path.join(plain, 'a.js'), 'const a=2;\n');
    const q = H.makeRepo(path.join(h.work, 'spec'), { '.gitignore': '.vibe/\n', 'a.js': 'const a=1;\n',
      'openspec/changes/add-a/proposal.md': '# add-a\n\n## Why\n要加 a\n\n## What Changes\n- 加 a\n',
      'openspec/changes/add-a/tasks.md': '## 1. 实现\n- [ ] 1.1 加 a\n',
      'openspec/changes/add-a/specs/a/spec.md': '## ADDED Requirements\n### Requirement: A\n系统 SHALL 有 a。\n\n#### Scenario: 有 a\n- **WHEN** 调用\n- **THEN** 返回 a\n' });
    let mode = 'fenced'; let calls = 0;
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        calls++;
        const issues = mode === 'issue' ? [{ severity: 'P2', file: 'proposal.md', line: 3, problem: '为什么写得太短', evidence: 'proposal.md 第 3 行只有一句', fix: '补上' }] : [];
        const json = JSON.stringify({ issues, summary: '审完' });
        let text = json;
        if (mode === 'fenced') text = '审完了，结果如下：\n```json\n' + json + '\n```\n以上。';
        if (mode === 'garbage' && calls === 1) text = '好的，我先看一下这些文件，稍后给出结论。';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { output_tokens: 20 } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const oldPort = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
    try {
      const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
      const S = require(path.join(h.kit, 'lib', 'session.js'));
      const E = require(path.join(h.kit, 'lib', 'evidence.js'));
      const r1 = await R.run({ cwd: plain, mode: 'code', base });
      H.ok('G3 回的 JSON 包在 ```json 里、前后带话：照样认，审完', r1.status === 'completed', { status: r1.status, reason: r1.reason, diag: r1.diagnostics });
      mode = 'garbage'; calls = 0;
      const r2 = await R.run({ cwd: plain, mode: 'code', base });
      H.ok('G3 第一次回的不是 JSON：同一批再审一次，审完', r2.status === 'completed' && calls === 2, { status: r2.status, calls, reason: r2.reason });
      mode = 'issue';
      const dir = path.join(q, 'openspec', 'changes', 'add-a');
      const r3 = await R.run({ cwd: q, change: 'add-a', mode: 'proposal' });
      const dec = path.join(h.root, 'dec.json');
      H.write(dec, JSON.stringify({ findings: [{ id: 'r1', action: 'accepted', reason: '用户说这条不改：为什么已经写在 design 里了' }] }));
      let res = null; let err = '';
      try { res = R.resolve({ cwd: q, change: 'add-a', mode: 'proposal', decisions: dec }); } catch (e) { err = e.message; }
      const recA = S.reviewRecord('proposal', dir);
      H.ok('G2 整套提案审查的意见：按提案的记录登记，记成已处理', r3.status === 'completed' && !!res && res.status === 'resolved' && !!recA && recA.resolved === true, err || { r3: [r3.status, r3.reason, r3.skipped], res, recA });
      const r4 = await R.run({ cwd: q, change: 'add-a', mode: 'proposal' });
      E.recordTool({ session_id: 'g3', tool_use_id: 'g3-1', tool_name: 'Bash', cwd: q, tool_input: { command: 'npm test' }, tool_response: { stdout: '1 passing' } }, true);
      H.write(dec, JSON.stringify({ findings: [{ id: 'r1', action: 'fixed', reason: '补了为什么，见 proposal.md 第 3 行' }] }));
      res = null; err = '';
      try { res = R.resolve({ cwd: q, change: 'add-a', mode: 'proposal', decisions: dec }); } catch (e) { err = e.message; }
      const recF = S.reviewRecord('proposal', dir);
      H.ok('G3 有"修了"的：要复审，不记成已处理', r4.status === 'completed' && !!res && res.status === 'needs_review' && !!recF && recF.resolved === false, err || { r4: r4.status, res, recF });
    } finally { if (oldPort === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = oldPort; server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  }

  H.section('H4 openspec --version 只查版本：不在项目里建 openspec/');
  {
    const h = H.makeHome('tfx-h4', FROM, {}, { openspec: true });
    const p = H.makeRepo(path.join(h.work, 'p4'), { 'a.txt': 'x\n' });
    const call = (id, command) => H.hook(h, 'guard-commit', { session_id: 'h4', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, transcript_path: H.transcript(path.join(h.root, id + '.jsonl'), [H.tr.user('看看 openspec 的版本')]) });
    const out = call('h4-1', 'openspec --version');
    H.ok('openspec --version：不建 openspec/', !fs.existsSync(path.join(p, 'openspec')), out);
    const out2 = call('h4-2', 'openspec list');
    H.ok('对照：openspec list 照旧建（说明自带的 OpenSpec 在这台电脑上用得上）', fs.existsSync(path.join(p, 'openspec')), out2);
  }

  H.section('H5 没跟踪的大文件（8 MB 以上）按大小和修改时间算指纹，不读内容');
  {
    const h = H.makeHome('tfx-h5', FROM);
    const p = H.makeRepo(path.join(h.work, 'p5'), { 'a.js': 'x\n' });
    const big = path.join(p, 'dump.log');
    fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 97));
    const t = new Date(Date.now() - 3600000); fs.utimesSync(big, t, t);
    const W = require(path.join(h.kit, 'lib', 'workspace.js'));
    const a = W.fingerprint(p, 'code').hash;
    const fd = fs.openSync(big, 'r+'); fs.writeSync(fd, Buffer.from('b'), 0, 1, 100); fs.closeSync(fd); fs.utimesSync(big, t, t);
    const b = W.fingerprint(p, 'code').hash;
    H.ok('内容变了、大小和修改时间没变：指纹不变（没读内容）', a === b);
    fs.appendFileSync(big, 'more');
    H.ok('大小变了：指纹跟着变', W.fingerprint(p, 'code').hash !== b);
    H.write(path.join(p, 'b.js'), 'y\n');
    H.ok('小文件照旧按内容算', W.fingerprint(p, 'code').hash !== b);
  }

  H.section('I4 经验规则：几个会话同时记，候选一条不丢');
  {
    const h = H.makeHome('tfx-i4', FROM);
    const JAVA = 'src/main/java/com/x/OrderService.java';
    const p = H.makeRepo(path.join(h.work, 'p6'), { 'pom.xml': '<project/>\n', [JAVA]: 'class OrderService {}\n', 'openspec/changes/add-export/tasks.md': '- [x] 1.1 改 ' + JAVA + '\n' });
    const items = [
      ['调 OrderMapper.selectByIds 之前', '先判空列表，传空列表会拼出 in () 报错'],
      ['格式化日期时', '用 yyyy 不用 YYYY，跨年那一周会算成下一年'],
      ['金额相加时', '用 BigDecimal，double 会丢精度'],
      ['比较两个 Integer 时', '用 equals，超过 127 的用 == 不相等'],
      ['读文件流的时候', '用 try-with-resources，抛异常也能关掉'],
      ['拼 like 查询时', '转义用户输入里的百分号和下划线，不然会被当通配符'],
    ];
    const TOOL = path.join(h.kit, 'tools', 'lesson.js');
    await Promise.all(items.map(([when, d]) => new Promise((resolve) => {
      const c = spawn(process.execPath, [TOOL, 'add', '--file', JAVA, '--when', when, '--do', d, '--from', 'add-export 1.1'], { cwd: p, env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
      c.on('exit', resolve); c.on('error', resolve);
    })));
    let got = []; try { got = JSON.parse(H.read(path.join(p, '.vibe', 'lessons', 'candidates.json')) || '{}').items || []; } catch (e) { got = []; }
    H.ok('6 个进程同时记 6 条不同的：候选里 6 条都在', got.length === items.length, got.map((x) => x.when || x.text || x.id));
  }

  H.done('10-31 零散修复（E、F、G、H、I、J 批）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

'use strict';
/*
 * K1-8（2026-11-01，docs/feedback-20261101.md）：本机诊断指标 lib/diag.js。
 *   按天汇总：次数、总毫秒、最长；只留 14 天；缓冲的第一笔马上写，之后攒着
 *   钩子预算用完记停在哪个阶段；等锁 200 毫秒以上的记一笔（会话号不进键），不到的不记；审查每批的结果；路由首字节（真发一个请求）
 *   体检显示；不进上报：使用情况、问题反馈、议题的代码都不读这个文件
 * 用法：node dev/test-diag.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? path.resolve(process.argv[2]) : null;
const SRCV = FROM || H.SRC;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const fileOf = (h) => path.join(h.kit, 'state', 'diag.json');
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const js = (h, code) => { const r = H.node(h, '-e', [code], { cwd: h.root, timeout: 60000 }); return (r.out + r.err).trim(); };
const lib = (h, n) => JSON.stringify(path.join(h.kit, 'lib', n));

(async () => {
  H.section('按天汇总，只留 14 天；缓冲的第一笔马上写');
  {
    const h = H.makeHome('dg-note', FROM);
    js(h, 'const D = require(' + lib(h, 'diag.js') + "); D.note('类', 'A', 100); D.note('类', 'A', 300); D.note('类', 'B', 5);");
    const d = readJson(fileOf(h))[today()] || {};
    H.ok('次数、总毫秒、最长', d['类'] && d['类'].A && d['类'].A.n === 2 && d['类'].A.total === 400 && d['类'].A.max === 300 && d['类'].B.n === 1, d);
    const old = readJson(fileOf(h));
    for (let i = 1; i <= 20; i++) old['2026-01-' + String(i).padStart(2, '0')] = { x: { y: { n: 1, total: 1, max: 1 } } };
    fs.writeFileSync(fileOf(h), JSON.stringify(old));
    js(h, 'require(' + lib(h, 'diag.js') + ").note('类', 'A', 1);");
    H.ok('只留 14 天，今天的还在', Object.keys(readJson(fileOf(h))).length === 14 && !!readJson(fileOf(h))[today()], Object.keys(readJson(fileOf(h))));
    const h2 = H.makeHome('dg-buf', FROM);
    const out = js(h2, 'const fs = require("fs"); const D = require(' + lib(h2, 'diag.js') + "); D.note('路', 'gw', 1, { buffer: true }); const a = JSON.parse(fs.readFileSync(D.FILE, 'utf8')); D.note('路', 'gw', 2, { buffer: true }); const b = JSON.parse(fs.readFileSync(D.FILE, 'utf8')); D.flush(); const c = JSON.parse(fs.readFileSync(D.FILE, 'utf8')); const k = Object.keys(a)[0]; console.log([a[k]['路'].gw.n, b[k]['路'].gw.n, c[k]['路'].gw.n].join(','));");
    H.ok('缓冲：第一笔马上写，第二笔先攒着，flush 才写', out === '1,1,2', out);
    const bad = H.makeHome('dg-ro', FROM);
    fs.mkdirSync(fileOf(bad), { recursive: true });
    const r = js(bad, 'require(' + lib(bad, 'diag.js') + ").note('类', 'A', 1); console.log('没抛');");
    H.ok('写不了：不抛', /没抛/.test(r), r);
    const recent = js(h, 'console.log(JSON.stringify(require(' + lib(h, 'diag.js') + ').recent(7)))');
    H.ok('recent：合起来，不带太老的', /"类"/.test(recent) && !/"x"/.test(recent), recent);
  }

  H.section('钩子预算用完：记停在哪个阶段；没用完不记');
  {
    const h = H.makeHome('dg-budget', FROM);
    const I = lib(h, 'invocation.js');
    js(h, 'const I = require(' + I + "); I.run(() => { I.phase('读会话记录'); }, { budgetMs: 5000 });");
    H.ok('没用完：不记', !fs.existsSync(fileOf(h)) || !(readJson(fileOf(h))[today()] || {})['钩子预算']);
    const out = js(h, 'const I = require(' + I + "); const end = Date.now() + 30; try { I.run(() => { I.phase('读会话记录'); while (Date.now() < end); try { I.phase('查提案'); } catch (e) { /* 里面很多 catch 会吞掉 */ } I.phase('再查'); }, { budgetMs: 5 }); console.log('没抛'); } catch (e) { console.log(e.code); }");
    H.ok('用完了：照旧抛给放行入口', /VIBE_HOOK_BUDGET/.test(out), out);
    const d = (readJson(fileOf(h))[today()] || {})['钩子预算'] || {};
    H.ok('记下停在哪个阶段；一次调用只记一笔', !!d['读会话记录'] && d['读会话记录'].n === 1 && d['读会话记录'].max >= 5 && Object.keys(d).length === 1, d);
  }

  H.section('等锁 200 毫秒以上的记一笔，键里没有会话号；不到的不记；诊断自己的锁不记');
  {
    const h = H.makeHome('dg-lock', FROM);
    const St = lib(h, 'state-store.js');
    const dir = path.join(h.kit, 'state');
    const sid = '12345678-1234-1234-1234-123456789abc';
    const f = JSON.stringify(path.join(dir, sid + '-flow.json.lock'));
    js(h, 'const S = require(' + St + '); const a = S.acquire(' + f + '); a.release();');
    H.ok('一下就拿到：不记', !((readJson(fileOf(h))[today()] || {})['锁等待']), readJson(fileOf(h)));
    const out = js(h, 'const S = require(' + St + '); const a = S.acquire(' + f + '); const b = S.acquire(' + f + ', { waitMs: 300 }); console.log(b === null ? "没拿到" : "拿到了"); a.release();');
    H.ok('（别人占着，等了 300 毫秒没拿到）', /没拿到/.test(out), out);
    const d = (readJson(fileOf(h))[today()] || {})['锁等待'] || {};
    const keys = Object.keys(d);
    H.ok('记了一笔，键是状态名，没有会话号', keys.length === 1 && keys[0] === 'flow.json' && d[keys[0]].max >= 200, d);
    const own = JSON.stringify(path.join(dir, 'diag.json.lock'));
    js(h, 'const S = require(' + St + '); const a = S.acquire(' + own + '); S.acquire(' + own + ', { waitMs: 300 }); a.release();');
    H.ok('诊断自己的锁：不记', !/diag/.test(JSON.stringify(readJson(fileOf(h)))), readJson(fileOf(h)));
  }

  H.section('审查每批的结果');
  {
    const h = H.makeHome('dg-rev', FROM);
    js(h, 'require(' + lib(h, 'review-runner.js') + ").noteBatches([{ ms: 1000, attempts: [{ ok: true }] }, { ms: 2000, attempts: [{ ok: false }, { ok: true }] }, { ms: 3000, attempts: [{ ok: false }, { ok: false }] }, { ms: 0, attempts: [] }]);");
    const d = (readJson(fileOf(h))[today()] || {})['审查批次'] || {};
    H.ok('拿到结论、重试后拿到、没拿到各记一笔；没发出去的不算', d['拿到结论'] && d['拿到结论'].n === 1 && d['重试后拿到'].n === 1 && d['没拿到结论'].n === 1 && d['没拿到结论'].max === 3000 && Object.keys(d).length === 3, d);
  }

  H.section('路由首字节：真发一个请求');
  {
    const gw = spawn(process.execPath, ['-e', "require('http').createServer((q, s) => { q.resume(); q.on('end', () => setTimeout(() => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } })); }, 60)); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const gwPort = await new Promise((r) => { gw.stdout.once('data', (d) => r(Number(String(d).trim()))); });
    const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const h = H.makeHome('dg-route', FROM);
    H.copyDir(path.join(SRCV, 'router'), path.join(h.kit, 'router'));
    const cfg = path.join(h.root, 'router-data', 'config.json');
    H.write(cfg, JSON.stringify({ listen: { host: '127.0.0.1', port }, providers: [{ name: 'gw', base_url: 'http://127.0.0.1:' + gwPort, api_key: 'sk-test-diag-0123456789abcdef' }], routes: [], default: { provider: 'gw' }, failover: [], options: { firstByteTimeoutSec: 30, rateLimitWaitSec: 0 } }, null, 2));
    const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', cfg, '-p', String(port)], { env: H.envFor(h), windowsHide: true, stdio: 'ignore' });
    const send = (url, body) => new Promise((resolve) => { const data = Buffer.from(JSON.stringify(body)); const q = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', agent: false, timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (s) => { s.resume(); s.on('end', () => resolve(s.statusCode)); }); q.on('error', () => resolve(0)); q.on('timeout', () => q.destroy()); q.end(data); });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { await H.sleep(200); up = await new Promise((res) => { const c = http.get({ host: '127.0.0.1', port, path: '/version', agent: false, timeout: 1000 }, (x) => { x.resume(); res(x.statusCode === 200); }); c.on('error', () => res(false)); c.on('timeout', () => { c.destroy(); res(false); }); }); }
      H.ok('（临时路由起来了）', up);
      const st = await send('/v1/messages', { model: 'claude-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
      H.ok('（请求通了）', st === 200, st);
      await H.sleep(300);
      const d = (readJson(fileOf(h))[today()] || {})['路由首字节'] || {};
      H.ok('记了首字节，按模型，毫秒对得上', !!d.gw && d.gw.n === 1 && d.gw.max >= 50, readJson(fileOf(h)));
      H.ok('key 不进诊断', !H.read(fileOf(h)) || !(H.read(fileOf(h)) || '').includes('sk-test-diag'));
    } finally { try { router.kill(); } catch (e) { /* 已退 */ } try { gw.kill(); } catch (e) { /* 已退 */ } }
    await H.sleep(300);
  }

  H.section('体检显示；不进上报');
  {
    const h = H.makeHome('dg-doc', FROM);
    const item = () => { const r = H.node(h, path.join(h.kit, 'tools', 'doctor.js'), ['--json'], { cwd: h.root, timeout: 120000 }); try { return JSON.parse(r.out.trim().split(/\r?\n/).pop()).checks.find((c) => c.name === '本机诊断') || {}; } catch (e) { return { raw: r.out + r.err }; } };
    const none = item();
    H.ok('没有数据：好，说只记本机', none.level === '好' && /只记本机/.test(none.text), none);
    js(h, 'const D = require(' + lib(h, 'diag.js') + "); D.note('路由首字节', 'gw', 1000); D.note('路由首字节', 'gw', 3000); D.note('锁等待', 'flow.json', 400);");
    const fine = item();
    H.ok('有数：平均、最长、等锁次数', fine.level === '好' && /2 次请求，首字节平均 2 秒、最长 3 秒/.test(fine.text) && /等锁超过 0\.2 秒 1 次/.test(fine.text), fine);
    js(h, 'const D = require(' + lib(h, 'diag.js') + "); D.note('钩子预算', '读会话记录', 12000); D.note('审查批次', '没拿到结论', 1);");
    const warn = item();
    H.ok('预算用完、审查没拿到结论：注意，说停在哪', warn.level === '注意' && /钩子预算用完 1 次/.test(warn.text) && /读会话记录/.test(warn.text) && /1 批没拿到结论/.test(warn.text) && !!warn.fix, warn);
    const leak = ['usage.js', 'issues.js', 'report.js', 'feedback.js', 'gitlab.js'].filter((n) => /diag\.js|\.\/diag|diag\.json/.test(H.read(path.join(SRCV, 'kit', 'lib', n)) || ''));
    H.ok('使用情况、议题、问题反馈的代码都不读它', leak.length === 0, leak);
    const S = require(path.join(SRCV, 'kit', 'lib', 'session.js'));
    H.ok('跨会话的状态：不按文件时间清', S.GLOBAL_STATE.test('diag.json'));
  }

  H.done('本机诊断指标' + (FROM ? '，拿 ' + FROM + ' 跑' : ''));
})().catch((e) => { H.ok('测试脚本出错', false, e && e.stack); H.done('本机诊断指标'); });

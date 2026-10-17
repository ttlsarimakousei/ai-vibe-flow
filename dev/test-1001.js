'use strict';
/*
 * 2026-10-01 这一批：
 *   自动压缩    安装器按配置写 settings.json 的 autoCompactWindow；改开关跟着改；填 0、卸载收回，装之前自己设过的还回去
 *   状态栏      三行；"全自动 开 / 关"、这个会话在不在流程里；超过上限怎么办；到多少自动压缩；今天的用量；"被拦可自行放行"
 *   维护的电脑  写死在代码里：老版本写进 config.json 的那一项，装的时候去掉
 *   使用情况    钩子、状态栏数次数；要传的那一段不带路径；取回来的数和原来一样；几天几台电脑能汇总
 *   拉代码      2026-10-17 起不再自动拉（用户自己拉）：远端有新提交、提了需求也不拉
 *   问题反馈    列表上每条标上报了没有；没有本机导出了
 * 用法：node dev/test-1001.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (back) => { const d = new Date(Date.now() - (back || 0) * 86400000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

(async () => {
  const watch = await H.watchWindows('t1001-win');

  // ---------------------------------------------------------------------------------------------
  H.section('安装器：自动压缩的窗口');
  {
    const h = H.freshHome('t1001-inst');
    // 装之前自己设过一个窗口；老版本的开关文件里还有"维护套件的电脑"
    H.write(path.join(h.cfg, 'settings.json'), JSON.stringify({ autoCompactWindow: 400000 }, null, 2));
    H.write(path.join(h.kit, 'config.json'), JSON.stringify({ reviewLoop: true, maintainerHosts: ['32.1.4.4'] }, null, 2));
    const settings = () => readJson(path.join(h.cfg, 'settings.json'));
    const man = () => readJson(path.join(h.kit, 'installed.json'));
    const sync = () => H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
    H.ok('装的时候写了窗口：上限 100 万的 90% 加 3.3 万', inst.code === 0 && settings().autoCompactWindow === 933000 && man().autoCompactWindow === 933000 && man().autoCompactWindowOrig === 400000, [inst.out.slice(-1200), settings().autoCompactWindow, man()]);
    H.ok('说了在哪压缩、开着的会话怎么马上生效', /自动压缩：上下文用到约 900k token 时/.test(inst.out) && /\/autocompact 933000/.test(inst.out), inst.out);
    H.ok('状态栏没有新消息时也 30 秒刷新一次', settings().statusLine && settings().statusLine.refreshInterval === 30 && /statusline\.js/.test(settings().statusLine.command), settings().statusLine);
    const cfg = readJson(path.join(h.kit, 'config.json'));
    H.ok('开关文件里老的"维护套件的电脑"去掉了，别的开关还在', cfg.maintainerHosts === undefined && cfg.reviewLoop === true && !/32\.1\.4\.4/.test(H.read(path.join(h.kit, 'config.json'))), cfg);
    H.setConfig(h, { autoCompactPercent: 80 });
    const s1 = sync();
    H.ok('改成 80%：保存开关时跟着改', s1.code === 0 && settings().autoCompactWindow === 833000 && /自动压缩的窗口/.test(s1.out) && /\/autocompact 833000/.test(s1.out), s1.out);
    const s2 = sync();
    H.ok('再同步一次：不动 settings.json', s2.code === 0 && !/settings\.json 里的/.test(s2.out), s2.out);
    H.setConfig(h, { autoCompactPercent: 80, contextLimitTokens: 200000 });
    sync();
    H.ok('上限改成 20 万：窗口 19.3 万', settings().autoCompactWindow === 193000, settings().autoCompactWindow);
    H.setConfig(h, { autoCompactPercent: 90, contextLimitTokens: 100000 });
    sync();
    H.ok('上限太小：窗口不小于 10 万', settings().autoCompactWindow === 123000 || settings().autoCompactWindow === 100000 + 0 || settings().autoCompactWindow >= 100000, settings().autoCompactWindow);
    H.setConfig(h, { autoCompactPercent: 0, contextLimitTokens: 1000000 });
    const off = sync();
    H.ok('填 0：还回装之前自己设的', settings().autoCompactWindow === 400000 && man().autoCompactWindow === undefined && man().autoCompactWindowOrig === undefined && /换回了你装套件之前设的 400000/.test(off.out), [off.out, settings().autoCompactWindow, man()]);
    H.setConfig(h, { autoCompactPercent: 90 });
    sync();
    H.ok('又打开：写回 93.3 万，记着原来的', settings().autoCompactWindow === 933000 && man().autoCompactWindowOrig === 400000, man());
    // 在 Claude Code 里用 /autocompact 改过：下次保存开关时换回配置页算出来的
    const s = settings(); s.autoCompactWindow = 500000; H.write(path.join(h.cfg, 'settings.json'), JSON.stringify(s, null, 2));
    sync();
    H.ok('/autocompact 改过的：保存开关时换回配置页的', settings().autoCompactWindow === 933000 && man().autoCompactWindowOrig === 400000, settings().autoCompactWindow);
    const un = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root, timeout: 120000 });
    H.ok('卸载：还回装之前自己设的', un.code === 0 && settings().autoCompactWindow === 400000 && !settings().statusLine, [un.out.slice(-600), settings()]);
    // 没设过的：卸载后没有这一项
    const g = H.freshHome('t1001-inst2');
    H.node(g, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: g.root, timeout: 180000 });
    const gs = readJson(path.join(g.cfg, 'settings.json'));
    H.node(g, path.join(g.kit, 'install.js'), ['--uninstall'], { cwd: g.root, timeout: 120000 });
    H.ok('原来没设过：装上有，卸载后没有', gs.autoCompactWindow === 933000 && readJson(path.join(g.cfg, 'settings.json')).autoCompactWindow === undefined, readJson(path.join(g.cfg, 'settings.json')));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('状态栏：三行');
  const h = H.makeHome('t1001-sl');
  const proj = H.makeRepo(path.join(h.work, 'shop'), { 'README.md': '# shop\n' });
  const sl = (input) => { const r = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify(input), cwd: proj }); return { code: r.code, raw: r.out, lines: plain(r.out).replace(/\n$/, '').split('\n'), err: r.err }; };
  const base = (used, extra) => Object.assign({ session_id: 's-sl', cwd: proj, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: proj }, context_window: { context_window_size: 1000000, used_percentage: Math.min(100, Math.round(used / 10000)), current_usage: { input_tokens: used, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, extra || {});
  const usage = () => (readJson(path.join(h.kit, 'state', 'usage.json')).days || {})[dayOf(0)] || { n: {} };
  {
    const r = sl(base(300000));
    H.ok('没装路由：两行', r.code === 0 && r.lines.length === 2, r.raw + r.err);
    H.ok('第一行：模型、目录和分支、上下文', /^Qwen3 │ shop \(\S+\) │ 上下文 ███░░░░░░░ 30% 300k\/1M/.test(r.lines[0]), r.lines[0]);
    H.ok('第二行：全自动关着、到多少自动压缩', /^需求自动 关 · Apply 自动 关 │ 到 900k 自动压缩$/.test(r.lines[1]), r.lines[1]);
    H.setConfig(h, { autoMode: true });
    const on1 = sl(base(300000));
    H.ok('全自动开着、这个会话不在流程里：写明照常', /^需求自动 关 · Apply 自动 开/.test(on1.lines[1]), on1.lines[1]);
    H.inFlow(h, 's-sl', []);
    const on2 = sl(base(300000));
    H.ok('全自动开着、这个会话在流程里', /^需求自动 关 · Apply 自动 开 │ 实施，当前生效/.test(on2.lines[1]), on2.lines[1]);
    H.setConfig(h, { autoMode: false, kitBypass: 'auto', kitLock: false });
    const loose = sl(base(300000));
    H.ok('放松了的保护：说"被拦可自行放行"，不再说"放行：自动"', /被拦可自行放行/.test(loose.lines[1]) && /允许改套件/.test(loose.lines[1]) && !/放行：自动/.test(loose.raw), loose.lines[1]);
    H.setConfig(h, { kitBypass: 'ask', kitLock: true });
    const over = sl(base(1200000));
    H.ok('超过上限：百分比照实写，进度条满格，最前面说怎么办', /^⚠ 上下文超过上限了（1\.2M\/1M），Claude Code 没自动压缩：敲 \/compact 压缩，或者 \/ttls-handover 交接/.test(over.lines[0]) && /上下文 ██████████ 120% 1\.2M\/1M/.test(over.lines[0]), over.lines[0]);
    const u1 = usage();
    H.ok('使用情况：这个会话到 70%、90%、超过上限各数一次；记下 Claude Code 的版本', u1.n['ctx.70'] === 1 && u1.n['ctx.90'] === 1 && u1.n['ctx.100'] === 1 && (u1.cc || []).includes('2.1.259'), u1);
    sl(base(1300000));
    H.ok('同一个会话再刷新：不重复数', usage().n['ctx.100'] === 1, usage().n);
    H.setConfig(h, { autoCompactPercent: 0 });
    const noAc = sl(base(300000));
    H.ok('自动压缩线填 0：不说到多少压缩', !/自动压缩/.test(noAc.raw), noAc.lines);
    H.setConfig(h, { autoCompactPercent: 90, contextLimitTokens: 0 });
    const cc = sl(base(150000, { context_window: { context_window_size: 200000, used_percentage: 75, current_usage: { input_tokens: 150000 } } }));
    H.ok('上限跟着 Claude Code 的窗口（20 万）：到 16.7 万压缩', /到 167k 自动压缩/.test(cc.lines[1]), cc.lines[1]);
    H.setConfig(h, { contextLimitTokens: 1000000 });
  }
  {
    // 今天的用量（路由每 20 秒写一次 usage-today.json）
    const rd = path.join(h.kit, 'router-data');
    fs.mkdirSync(rd, { recursive: true });
    // 装路由时 key 放在 router-data/config.json：状态栏不读它（写一个认得出来的假 key，看它有没有出现在输出里）
    H.write(path.join(rd, 'config.json'), JSON.stringify({ providers: [{ name: 'A', api_key: 'sk-should-never-show-123' }] }));
    const by = { 'qwen3-coder': { requests: 3000, fail: 2, input: 900000000, cacheRead: 100000000, cacheWrite: 0, output: 5000000 }, glm: { requests: 150, input: 20000000, output: 100000 }, kimi: { requests: 40, input: 1000000, output: 1000 }, ds: { requests: 10, input: 10000, output: 100 } };
    H.write(path.join(rd, 'usage-today.json'), JSON.stringify({ day: dayOf(0), warnAt: 4000, requests: 3200, byProvider: by, at: Date.now() }));
    const r = sl(base(300000));
    H.ok('三行：第三行是今天的用量', r.lines.length === 3 && /^今天 3200 次（提醒线 4000） · 1026\.1M token/.test(r.lines[2]), r.lines);
    H.ok('用得最多的三个模型各自的次数和 token，其余的说还有几个', /qwen3-coder 3000 次 1005M（失败 2）/.test(r.lines[2]) && /glm 150 次 20\.1M/.test(r.lines[2]) && /kimi 40 次 1M/.test(r.lines[2]) && /还有 1 个模型$/.test(r.lines[2]), r.lines[2]);
    H.ok('到提醒线的 75%：次数变黄', /\x1b\[33m今天 3200 次/.test(r.raw), JSON.stringify(r.raw.split('\n')[2]));
    H.ok('没读模型的 key', !/sk-should-never-show/.test(r.raw));
    H.write(path.join(rd, 'usage-today.json'), JSON.stringify({ day: dayOf(1), warnAt: 4000, requests: 4100, byProvider: by, at: Date.now() - 86400000 }));
    const y = sl(base(300000));
    H.ok('文件还是昨天的（今天还没请求过）：今天 0 次', /^今天 0 次（提醒线 4000） · 0 token$/.test(y.lines[2]), y.lines[2]);
    fs.unlinkSync(path.join(rd, 'usage-today.json'));
    H.write(path.join(rd, 'usage-daily.json'), JSON.stringify({ [dayOf(0)]: { requests: 4200, byProvider: { 'qwen3-coder': { requests: 4200, input: 1000, output: 10 } } } }));
    const old = sl(base(300000));
    H.ok('老版本的路由没有 usage-today.json：从 usage-daily.json 里取今天的，过了提醒线变红', /^今天 4200 次（提醒线 4000）/.test(old.lines[2]) && /\x1b\[31m今天 4200 次/.test(old.raw), old.lines[2]);
    H.setConfig(h, { statusUsage: false });
    const noU = sl(base(300000));
    H.ok('开关关掉：不显示第三行', noU.lines.length === 2 && !/今天/.test(noU.raw), noU.lines);
    H.setConfig(h, { statusUsage: true });
    const bad = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: 'not json', cwd: proj });
    H.ok('输入不对也出一行，不报错', bad.code === 0 && plain(bad.out).trim().length > 0, bad.out + bad.err);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('使用情况：钩子数次数；要传的那一段不带路径；取回来和原来一样；能汇总');
  {
    const u = H.makeHome('t1001-us');
    const p = H.makeRepo(path.join(u.work, 'crm'), { 'pom.xml': '<project/>\n' });
    const tf = H.transcript(path.join(u.root, 't.jsonl'), [H.tr.user('开始')]);
    H.hook(u, 'session-start', { session_id: 's-us', cwd: p, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tf });
    H.hook(u, 'session-start', { session_id: 's-us', cwd: p, hook_event_name: 'SessionStart', source: 'compact', transcript_path: tf });
    H.hook(u, 'task-anchor', { session_id: 's-us', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '做一个导出客户名单的功能', transcript_path: tf });
    H.hook(u, 'task-anchor', { session_id: 's-us', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '继续', transcript_path: tf });
    H.hook(u, 'task-anchor', { session_id: 's-us', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '/ttls-handover', transcript_path: tf });
    const x = (readJson(path.join(u.kit, 'state', 'usage.json')).days || {})[dayOf(0)] || { n: {} };
    H.ok('会话怎么来的、开口几次、进流程几次、写交接几次', x.n['session.startup'] === 1 && x.n['session.compact'] === 1 && x.n.prompt === 3 && x.n['flow.enter'] === 1 && x.n['handover.write'] === 1, x);
    H.ok('记下今天用的套件版本', (x.kit || []).includes((H.read(path.join(u.kit, 'VERSION')) || '').trim()), x.kit);
    const U = path.join(u.kit, 'lib', 'usage.js');
    const run = (code) => { const r = H.node(u, '-e', ['const U = require(' + JSON.stringify(U) + ');' + code], { cwd: u.root }); try { return JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { return { error: r.out + r.err }; } };
    H.setConfig(u, { reviewLoop: true, reviewMaxRounds: 4, contextLimitTokens: 500000 });
    const s = run('const s = U.summary(); console.log(JSON.stringify({ text: s.text, back: U.parse(s.text), data: s.data }))');
    H.ok('今天的样子：一张表、给导出用的数', s.text && new RegExp('### ' + dayOf(0) + ' 的使用情况').test(s.text) && /\| 开口 \| 3 次；进 OpenSpec 流程 1 次/.test(s.text) && /<!-- vibe-kit-usage \{/.test(s.text), s.text || s.error);
    H.ok('和默认不一样的开关：只写名字和值', /reviewLoop=true，reviewMaxRounds=4，contextLimitTokens=500000/.test(s.text) || (/reviewLoop=true/.test(s.text) && /reviewMaxRounds=4/.test(s.text) && /contextLimitTokens=500000/.test(s.text)), s.text);
    H.ok('不带路径、项目名', !s.text.includes(u.root) && !/crm|vkt-t1001/.test(s.text), s.text);
    H.ok('取回来的数和原来一样', JSON.stringify(s.back) === JSON.stringify(s.data), [s.back, s.data]);
    const agg = run('const a = U.collect(); const b = JSON.parse(JSON.stringify(a)); b.host = "PC-2"; b.day = "2026-09-30"; b.n = { prompt: 7, "block.guard-spec": 2, "ctx.100": 1 }; b.hints = ["查库的命令平均每条 3.2 秒（共 40 条）"]; a.hints = ["查库的命令平均每条 3.2 秒（共 40 条）"]; console.log(JSON.stringify({ t: U.aggregate([a, b], "2026-09-30", "2026-10-01") }))');
    H.ok('几天几台电脑汇总：合计、每台电脑一行、能优化的地方数几台', /## 使用情况（2026-09-30 到 2026-10-01，2 台电脑，一共 2 个人天）/.test(agg.t) && /\| 开口 \| 10 次/.test(agg.t) && /\| PC-2 \| 1 \|/.test(agg.t) && /查库的命令平均每条 3\.2 秒（共 40 条）（2 台电脑）/.test(agg.t), agg.t || agg.error);
    const empty = run('console.log(JSON.stringify({ t: U.aggregate([], "a", "b") }))');
    H.ok('没有数：不出这一节', empty.t === '', empty);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('开工前不再拉代码（2026-10-17 起，用户自己拉）');
  {
    const w = H.makeHome('t1001-pull');
    const root = H.tempDir('t1001-remote');
    const bare = path.join(root, 'shop.git');
    H.git(root, ['init', '-q', '--bare', '--initial-branch=main', bare]);
    const mate = H.makeRepo(path.join(root, 'mate'), { 'src/A.java': 'class A {}\n' });
    H.git(mate, ['branch', '-M', 'main']);
    H.git(mate, ['remote', 'add', 'origin', bare]);
    H.git(mate, ['push', '-q', '-u', 'origin', 'main']);
    const me = path.join(w.work, 'shop');
    fs.mkdirSync(w.work, { recursive: true });
    H.git(w.work, ['clone', '-q', '-c', 'core.autocrlf=false', bare, me]);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['core.autocrlf', 'false']]) H.git(me, ['config', k, v]);
    H.write(path.join(mate, 'src/C.java'), 'class C {}\n'); H.git(mate, ['add', '-A']); H.git(mate, ['commit', '-q', '-m', 'feat: 同事加了 C']); H.git(mate, ['push', '-q', 'origin', 'main']);
    const head = (d) => H.git(d, ['rev-parse', 'HEAD']).out.trim();
    const tf = H.transcript(path.join(w.root, 'p.jsonl'), [H.tr.user('开始')]);
    const raw = (prompt) => { const o = H.hook(w, 'task-anchor', { session_id: 'sp-1', cwd: me, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    const t1 = raw('做一个导出订单的功能');
    H.ok('远端有新提交、提了需求：不拉代码，也不说拉代码', head(me) !== head(mate) && !fs.existsSync(path.join(me, 'src', 'C.java')) && !/拉了一次代码|拉到了/.test(t1), t1);
    H.ok('配置里留着旧开关 pullBeforeWork=true 也不拉', (H.setConfig(w, { pullBeforeWork: true }), raw('/opsx:apply export-orders'), head(me) !== head(mate)));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('问题反馈：列表上标上报了没有；没有本机导出了');
  {
    const f = H.makeHome('t1001-fb', null, { issueUpload: 'on' });
    const FB = path.join(f.kit, 'lib', 'feedback.js');
    const IS = path.join(f.kit, 'lib', 'issues.js');
    const code = 'const fb = require(' + JSON.stringify(FB) + '); const is = require(' + JSON.stringify(IS) + '); const fs = require("fs"); const path = require("path");'
      + 'const a = fb.record({ kind: "出错", hook: "pre-edit", title: "传了的", what: "x", sig: "s-a" });'
      + 'const b = fb.record({ kind: "出错", hook: "pre-edit", title: "等着的", what: "x", sig: "s-b" });'
      + 'const c = fb.record({ kind: "篡改", hook: "套件开关", title: "这台电脑自己的事", what: "x", sig: "s-c" });'
      + 'const recs = fb.listRecords(); const key = (r) => r.meta.id + "@" + r.meta["时间"]; const ra = recs.find((r) => r.meta.id === a.id);'
      + 'fs.mkdirSync(fb.DIR, { recursive: true }); fs.writeFileSync(path.join(fb.DIR, "issues.json"), JSON.stringify({ since: 1, map: { [key(ra)]: { iid: 7, url: "http://gl/7" } } }));'
      + 'const up = is.uploadState(); const st = {}; for (const r of fb.listRecords()) st[r.title] = up(r);'
      + 'fs.writeFileSync(path.join(fb.DIR, "issues.json"), JSON.stringify({ since: Date.now() + 60000, map: { [key(ra)]: { iid: 7, url: "http://gl/7" } } }));'
      + 'const up2 = is.uploadState(); st.old = up2(fb.listRecords().find((r) => r.meta.id === b.id)); console.log(JSON.stringify(st));';
    const r = H.node(f, '-e', [code], { cwd: f.root });
    let st = {};
    try { st = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { st = { error: r.out + r.err }; }
    H.ok('对上议题的标编号和链接，没传的"等着上报"，篡改的"不上报"，有上报功能之前的"不传"', st['传了的'] && st['传了的'].iid === 7 && st['传了的'].url === 'http://gl/7' && st['等着的'] === 'waiting' && st['这台电脑自己的事'] === 'skip' && st.old === 'old', st);
    H.setConfig(f, { issueUpload: 'off' });
    const r2 = H.node(f, '-e', ['const fb = require(' + JSON.stringify(FB) + '); const up = require(' + JSON.stringify(IS) + ').uploadState(); console.log(JSON.stringify(fb.listRecords().map((x) => up(x))))'], { cwd: f.root });
    H.ok('上报关着：没传的写"上报关着"', /"off"/.test(r2.out) && /"iid":7/.test(r2.out), r2.out);
    const ex = H.node(f, path.join(f.kit, 'tools', 'feedback.js'), ['export'], { cwd: f.root });
    const help = H.node(f, path.join(f.kit, 'tools', 'feedback.js'), ['help'], { cwd: f.root });
    H.ok('没有本机导出了：export 说清楚，帮助里不提', ex.code === 1 && /没有这个命令了/.test(ex.out) && !/ export /.test(help.out) && !fs.existsSync(path.join(f.kit, 'feedback', '导出')), ex.out + help.out);
    const F = require(FB);
    H.ok('库里没有导出、清空的函数了', !F.exportText && !F.exportToFile && !F.clearRecords, Object.keys(F));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('2026-10-01 这一批');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

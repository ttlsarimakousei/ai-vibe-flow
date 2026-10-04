'use strict';
/*
 * 问题上报：本机的问题反馈建成假 GitLab 上的议题。
 *   没有令牌、SSH 是通的 → 用 SSH 申请令牌；只传有了这个功能之后记的（以前攒下的不传，20260929 起去掉了存量推送）；
 *   新的照常传；别的电脑报过的不重复建；又出现了加一句；不算问题的记录（老版本自动记的"拦了 3 次"、配置页改开关）不传；
 *   关掉之后又出现新建一条；令牌失效自动换；老版本的 GitLab 申请不了令牌就停一阵；导出只出开放中的、本机不存，关掉是另一步。
 *   使用情况（2026-10-01）：一台电脑一条"[使用情况]"议题，一天一条补充，今天的不传；导出时不当问题、不关，汇总附在最后。
 * 用法：node dev/test-issues.js [端口，默认 18743]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18743;
const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  const watch = await H.watchWindows('iss-win');
  const gl = await H.fakeGitlab('iss-gl', PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  const live = Object.assign({}, gl.env, { VIBE_KIT_NO_UPDATE: undefined });
  const home = (name, cfg) => { const h = H.makeHome(name, null, Object.assign({ issueUpload: 'on', autoUpdate: 'off' }, cfg || {})); fs.writeFileSync(path.join(h.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url })); return h; };
  const up = (h, args, env) => { const r = H.node(h, path.join(h.kit, 'lib', 'updater.js'), args, { cwd: h.root, timeout: 180000, env: Object.assign({}, live, env || {}) }); return Object.assign(r, { json: json(r.out) }); };
  const rec = (h, r) => { const x = H.node(h, '-e', ['const fb = require(' + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + '); console.log(JSON.stringify(fb.record(' + JSON.stringify(r) + ')))'], { cwd: h.root }); return json(x.out) || { error: x.out + x.err }; };
  const store = (h) => readJson(path.join(h.kit, 'feedback', 'issues.json'));
  const setStore = (h, fn) => { const f = path.join(h.kit, 'feedback', 'issues.json'); const s = store(h); fn(s); fs.writeFileSync(f, JSON.stringify(s)); };
  const st = (h) => readJson(path.join(h.kit, 'state', 'issues.json'));
  const secrets = (h) => readJson(path.join(h.kit, 'secrets.json'));
  const pats = () => gl.sshCalls().filter((c) => /^personal_access_token/.test(c.command));

  // ---------- 头一回上报 ----------
  H.section('没有令牌，SSH 是通的：申请令牌；以前攒下的不传');
  const u = home('iss-u');
  rec(u, { kind: '其他', hook: 'guard-commit', title: '有这个功能之前记的第 1 条', what: '装上问题上报之前记的', sig: 'sig-old-0' });
  rec(u, { kind: '其他', hook: 'guard-commit', title: '有这个功能之前记的第 2 条', what: '装上问题上报之前记的', sig: 'sig-old-1' });
  await H.sleep(1200);
  {
    const d = up(u, ['diagnose']);
    H.ok('测试连接：拉仓库走 SSH，认出了是谁', d.json && d.json.git && d.json.git.ok && d.json.git.route === 'ssh' && d.json.ssh && d.json.ssh.ok && d.json.ssh.user === 'tester', d.out + d.err);
    H.ok('测试连接：没有令牌，说了可以用 SSH 申请；只看不动', d.json && d.json.api && d.json.api.noToken && d.json.api.canMint && !pats().length && !fs.existsSync(path.join(u.kit, 'secrets.json')), d.json && d.json.api);
    const first = up(u, ['issues-sync']);
    H.ok('头一回上报：以前攒下的两条不传，也不去申请令牌', first.code === 0 && first.json && first.json.created === 0 && first.json.left === 0 && gl.issues().length === 0 && !pats().length && store(u).since > 0, first.out + first.err);
  }
  await H.sleep(1200);
  rec(u, { kind: '拦错了', hook: 'guard-spec', title: '勾选任务时不认写明的验证脚本', what: '验证方式里写了 node .vibe/check.js，跑过了还是拦。网关 10.20.30.40 token=abcdef123456', sig: 'sig-aaaa', cwd: 'D:/work/sjytoa' });
  rec(u, { kind: '出错', hook: 'verify-gate', title: '收工检查报错', what: '读任务清单时出错', stack: 'TypeError: x is not a function', sig: 'sig-bbbb' });
  // 不算问题的三种：都不传
  rec(u, { kind: '开关变更', hook: '配置页', title: '配置页关掉了"禁止 Claude 自己改套件"', what: '老版本记的' });
  rec(u, { kind: '卡住', hook: 'guard-spec', source: '钩子自动记录', title: '同一个会话里被"x"拿同一条理由拦了 3 次', what: '老版本记的', sig: 'sig-stuck' });
  rec(u, { kind: '篡改', hook: '套件开关', source: '钩子自动记录', title: '套件开关文件被绕开配置页改了', what: '这台电脑自己的事', sig: 'sig-tamper' });
  for (let i = 0; i < 9; i++) rec(u, { kind: '其他', hook: 'guard-commit', title: '新记的第 ' + (i + 1) + ' 条', what: '有了这个功能之后记的', sig: 'sig-new-' + i });
  {
    const s0 = up(u, ['issues-summary']);
    H.ok('上报之前：11 条在等（以前攒下的、不算问题的都不算）', s0.json && s0.json.total === 13 && s0.json.uploaded === 0 && s0.json.waiting === 11 && s0.json.backlog === undefined, s0.out + s0.err);
    const r = up(u, ['issues-sync']);
    H.ok('上报：一次最多 8 条', r.code === 0 && r.json && r.json.created === 8 && r.json.left === 3 && !r.json.error && gl.issues().length === 8, r.out + r.err);
    const r2 = up(u, ['issues-sync']);
    H.ok('下一次把剩下的传完', r2.json && r2.json.created === 3 && r2.json.left === 0 && gl.issues().length === 11, r2.out + r2.err);
    const p = pats();
    H.ok('令牌是用 SSH 申请的：权限 api、30 天', p.length === 1 && /^personal_access_token vibe-kit-\S+ api/.test(p[0].command) && p[0].opts.includes('-o BatchMode=yes'), p);
    const sec = secrets(u);
    H.ok('令牌存在 secrets.json 里，记着来处和到期日', /^glpat-/.test(sec.gitlabToken || '') && sec.gitlabTokenSource === 'ssh' && /^\d{4}-\d{2}-\d{2}$/.test(sec.gitlabTokenExpires || ''), Object.keys(sec));
    const everything = r.out + r.err + r2.out + (H.read(path.join(u.kit, 'update', 'update.log')) || '') + JSON.stringify(st(u)) + JSON.stringify(store(u)) + (H.read(path.join(u.kit, 'gitlab.json')) || '');
    H.ok('令牌没出现在输出、日志、状态文件里', !everything.includes(sec.gitlabToken));
    const is = gl.issues();
    const a = is.find((i) => /勾选任务时不认写明的验证脚本/.test(i.title));
    H.ok('标题带类型和涉及的钩子', a && a.title === '[拦错了] guard-spec：勾选任务时不认写明的验证脚本', a && a.title);
    H.ok('正文里有一张表、原文、签名', a && /\| 套件版本 \|/.test(a.description) && /## 现象/.test(a.description) && a.description.includes('vibe-kit-sig:sig-aaaa') && !/存量/.test(a.description), a && a.description);
    H.ok('密码、内网地址在记录里就已经遮掉了', a && !/abcdef123456/.test(a.description) && !/10\.20\.30\.40/.test(a.description), a && a.description);
    H.ok('带了标签', a && a.labels.includes('vibe-kit反馈') && a.labels.includes('拦错了'), a && a.labels);
    H.ok('以前攒下的没传', !is.some((i) => /有这个功能之前记的/.test(i.title)), is.map((i) => i.title));
    H.ok('不算问题的三种都没传', !is.some((i) => /禁止 Claude 自己改套件|拦了 3 次|绕开配置页/.test(i.title)), is.map((i) => i.title));
    const s = store(u);
    H.ok('对照表和记录放在一起', Object.keys(s.map).length === 11 && s.since > 0 && s.backlogDone === undefined, s);
    const sum = up(u, ['issues-summary']);
    H.ok('现在：都传了，没有在等的', sum.json && sum.json.uploaded === 11 && sum.json.waiting === 0 && sum.json.tokenSource === 'ssh', sum.out);
  }

  H.section('平时：新的照常传，不重复建');
  {
    rec(u, { kind: '出错', hook: 'pre-edit', title: '改文件时钩子报错', what: '新记的', sig: 'sig-new1' });
    const r = up(u, ['issues-sync']);
    const n = gl.issues().find((i) => /改文件时钩子报错/.test(i.title));
    H.ok('新记的一条：建了议题', r.json && r.json.created === 1 && n && pats().length === 1, r.out + r.err);
    const again = up(u, ['issues-sync']);
    H.ok('没有新的：什么都不建', again.json && again.json.created === 0 && again.json.noted === 0 && gl.issues().length === 12, again.out);
    // 另一台电脑报同样的问题
    const v = home('iss-v');
    up(v, ['issues-sync']);
    rec(v, { kind: '出错', hook: 'pre-edit', title: '改文件时钩子报错', what: '另一台电脑上也有', sig: 'sig-new1', cwd: 'D:/work/other' });
    const r2 = up(v, ['issues-sync']);
    const n2 = gl.issues().find((i) => /改文件时钩子报错/.test(i.title));
    H.ok('别的电脑已经报过、还开着：在那条下面加一句', r2.json && r2.json.created === 0 && r2.json.noted === 1 && gl.issues().length === 12 && n2.notes.length === 1 && /这台电脑上也出现了/.test(n2.notes[0].body) && store(v).map && Object.values(store(v).map)[0].joined, r2.out + r2.err);
    // 又出现了
    rec(u, { kind: '出错', hook: 'pre-edit', title: '改文件时钩子报错', what: '又来了', sig: 'sig-new1', note: '改 OrderService.java 时' });
    const r3 = up(u, ['issues-sync']);
    H.ok('刚传过又出现：12 小时里不重复补充', r3.json && r3.json.noted === 0 && r3.json.created === 0, r3.out);
    setStore(u, (s) => { for (const k of Object.keys(s.map)) { s.map[k].at -= 13 * 3600000; s.map[k].noteAt -= 13 * 3600000; } });
    const r4 = up(u, ['issues-sync']);
    const n4 = gl.issues().find((i) => /改文件时钩子报错/.test(i.title));
    H.ok('过了 12 小时：补一句"又出现了"，带上到现在几次', r4.json && r4.json.noted === 1 && n4.notes.length === 2 && /又出现了/.test(n4.notes[1].body) && /\| 2 \|/.test(n4.notes[1].body), r4.out + JSON.stringify(n4.notes));
    for (let i = 0; i < 10; i++) rec(u, { kind: '其他', hook: 'guard-vibe', title: '一口气记了很多 ' + (i + 1), what: 'x', sig: 'sig-many-' + i });
    const r5 = up(u, ['issues-sync']);
    H.ok('一次最多传 8 条，剩下的下次传', r5.json && r5.json.created === 8 && r5.json.left === 2, r5.out);
    const r6 = up(u, ['issues-sync']);
    H.ok('下一次传完', r6.json && r6.json.created === 2 && r6.json.left === 0 && gl.issues().length === 22, r6.out);
    H.setConfig(u, { issueUpload: 'off' });
    rec(u, { kind: '其他', hook: 'guard-vibe', title: '关着上报时记的', what: 'x', sig: 'sig-off' });
    const off = up(u, ['issues-sync']);
    H.ok('上报关着：不传', off.json && /关着/.test(off.json.skipped || '') && gl.issues().length === 22, off.out);
    H.setConfig(u, { issueUpload: 'on' });
    up(u, ['issues-sync']);
  }

  H.section('导出：只出开放中的，交给页面下载（本机不存）；关掉是另一步');
  {
    const open = gl.issues().filter((i) => i.state === 'opened').length;
    gl.clearLogs();
    const e = up(u, ['issues-export']);
    H.ok('导出了全部开放中的，编号都在', e.json && e.json.ok && e.json.count === open && open === 23 && Array.isArray(e.json.iids) && e.json.iids.length === open, [e.json && e.json.count, open, e.err]);
    H.ok('导出只导出：不关、本机不存', gl.issues().filter((i) => i.state === 'opened').length === open && e.json.saved === undefined && !fs.existsSync(path.join(u.kit, 'issue-exports')), e.json && Object.keys(e.json));
    H.ok('汇总里有议题号、正文、后来的补充', /## #\d+ \[出错\] pre-edit：改文件时钩子报错/.test(e.json.text) && /### 后来的补充/.test(e.json.text) && /这台电脑上也出现了/.test(e.json.text) && /\| 类型 \| 条数 \|/.test(e.json.text), e.json.text.slice(0, 1500));
    H.ok('汇总里没有签名那一行、没有系统自动加的记录', !/vibe-kit-sig:/.test(e.json.text) && !/由 vibe-kit 自动上报/.test(e.json.text));
    const c = up(u, ['issues-close', e.json.iids.join(','), '--name', e.json.name]);
    H.ok('关掉这一批', c.json && c.json.ok && c.json.closed.length === open && !c.json.failed.length && gl.issues().every((i) => i.state === 'closed'), c.out + c.err);
    const one = gl.issues().find((i) => /改文件时钩子报错/.test(i.title));
    H.ok('每条下面留了一句"已导出"', one.notes.some((n) => /已导出/.test(n.body) && n.body.includes(e.json.name)), one.notes);
    const sum = up(u, ['issues-summary']);
    H.ok('记着上一次导出', sum.json && sum.json.lastExport && sum.json.lastExport.count === open && sum.json.lastExport.closed === open && sum.json.lastExport.saved === undefined, sum.out);
    const e2 = up(u, ['issues-export']);
    H.ok('再导一次：没有开放中的了', e2.json && e2.json.ok && e2.json.count === 0 && /现在没有开放中的问题议题/.test(e2.json.text), e2.out);
    const c0 = up(u, ['issues-close', '-', '--name', e2.json.name]);
    H.ok('没有要关的也能记"交出去了"', c0.json && c0.json.ok && c0.json.closed.length === 0, c0.out);
    // 关掉之后又出现
    rec(u, { kind: '出错', hook: 'pre-edit', title: '改文件时钩子报错', what: '关掉之后又来了', sig: 'sig-new1' });
    setStore(u, (s) => { for (const k of Object.keys(s.map)) { s.map[k].at -= 13 * 3600000; s.map[k].noteAt -= 13 * 3600000; } });
    const r = up(u, ['issues-sync']);
    const fresh = gl.issues().filter((i) => i.state === 'opened');
    H.ok('关掉之后又出现：新建一条，写明之前是哪条', r.json && r.json.created === 1 && fresh.length === 1 && new RegExp('之前的 #' + one.iid + ' 已经关闭').test(fresh[0].description), r.out + JSON.stringify(fresh.map((i) => i.description.slice(0, 80))));
    const keep = up(u, ['issues-export']);
    H.ok('页面上没勾"下载之后关掉"：只导出', keep.json && keep.json.count === 1 && gl.issues().filter((i) => i.state === 'opened').length === 1, keep.out);
    // 导出之后、关掉之前，别的电脑在这条下面又补了一句：新补充的不在导出的文件里，这一条不能关
    const OT = 'glpat-other-pc-token-000001';
    gl.addToken(OT, 'li');
    const openIid = gl.issues().find((i) => i.state === 'opened').iid;
    const noted = await new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify({ body: '别的电脑后来补的：这台电脑上也出现了，多了一种触发办法' }));
      const req = require('http').request({ host: '127.0.0.1', port: gl.port, path: '/api/v4/projects/77/issues/' + openIid + '/notes', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length, 'private-token': OT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.end(data);
    });
    const cl = up(u, ['issues-close', keep.json.iids.join(','), '--name', keep.json.name]);
    H.ok('导出之后又有人补充过的：不关，说了是哪条', noted === 201 && cl.json && cl.json.ok && cl.json.closed.length === 0 && Array.isArray(cl.json.later) && cl.json.later[0] === openIid && gl.issues().find((i) => i.iid === openIid).state === 'opened', [noted, cl.out]);
    const sum2 = up(u, ['issues-summary']);
    H.ok('上一次导出里记着有一条没关；每条的时间戳不交给页面', sum2.json && sum2.json.lastExport && sum2.json.lastExport.later === 1 && sum2.json.lastExport.stamps === undefined, sum2.out);
    const again = up(u, ['issues-export']);
    H.ok('下次导出整条带上，新补充的也在', again.json && again.json.count === 1 && /别的电脑后来补的/.test(again.json.text), again.out.slice(0, 600));
    const cl2 = up(u, ['issues-close', again.json.iids.join(','), '--name', again.json.name]);
    H.ok('这回没人再补充：关掉了', cl2.json && cl2.json.ok && cl2.json.closed.length === 1 && !cl2.json.later.length && gl.issues().every((i) => i.state === 'closed' || /使用情况/.test(i.title)), cl2.out);
  }

  H.section('使用情况：一台电脑一条议题，一天一条补充；今天的不传');
  {
    const z = home('iss-z');
    const pad = (n) => String(n).padStart(2, '0');
    const dayOf = (back) => { const d = new Date(Date.now() - back * 86400000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    const D2 = dayOf(2); const D1 = dayOf(1); const D0 = dayOf(0);
    fs.writeFileSync(path.join(z.kit, 'state', 'usage.json'), JSON.stringify({ days: {
      [D2]: { n: { prompt: 5, 'flow.enter': 1, 'block.guard-spec': 3, 'ctx.70': 1, 'session.startup': 2 }, cc: ['2.1.120'], kit: ['20260930.2248'] },
      [D1]: { n: { prompt: 9, 'block.guard-commit': 2, 'block.guard-spec': 1, 'ctx.70': 1, 'ctx.90': 1, 'ctx.100': 1, 'pull.updated': 1, 'bypass.auto': 1 }, cc: ['2.1.259'], kit: ['20261001.1200'] },
      [D0]: { n: { prompt: 1 }, cc: ['2.1.259'] },
    } }));
    fs.mkdirSync(path.join(z.kit, 'router-data'), { recursive: true });
    fs.writeFileSync(path.join(z.kit, 'router-data', 'usage-daily.json'), JSON.stringify({ [D1]: { requests: 12, byProvider: { 'qwen3-10.1.2.3': { requests: 12, fail: 1, failover: 1, input: 1000, cacheRead: 500, cacheWrite: 0, output: 200 } } } }));
    const r = up(z, ['usage-sync']);
    const ui = () => gl.issues().filter((i) => /^\[使用情况\] /.test(i.title));
    H.ok('建了这台电脑的"[使用情况]"议题，传了过完的两天，今天的不传', r.code === 0 && r.json && r.json.sent === 2 && r.json.left === 0 && ui().length === 1 && ui()[0].notes.length === 2 && ui()[0].state === 'opened', r.out + r.err);
    const body = ui()[0].notes.map((n) => n.body).join('\n');
    H.ok('补充里是一张表和给导出用的数', new RegExp('### ' + D2 + ' 的使用情况').test(body) && new RegExp('### ' + D1 + ' 的使用情况').test(body) && /\| 开口 \| 9 次/.test(body) && /<!-- vibe-kit-usage \{/.test(body) && /\| 拦下 \| 共 3 次：guard-commit 2，guard-spec 1 \|/.test(body), body.slice(0, 1500));
    H.ok('模型的名字里的内网地址遮掉了；不带路径、项目名', !/10\.1\.2\.3/.test(body) && /qwen3-内网IP/.test(body) && !body.includes(z.root) && !/vkt-iss/.test(body), body.slice(0, 1500));
    H.ok('议题的正文说清楚是什么、怎么关', /不是问题/.test(ui()[0].description) && /使用情况上报/.test(ui()[0].description) && /vibe-kit-usage-host:/.test(ui()[0].description), ui()[0].description);
    const r2 = up(z, ['usage-sync']);
    H.ok('再传一次：没有新的', r2.json && r2.json.sent === 0 && ui()[0].notes.length === 2, r2.out);
    setStore(z, (s) => { s.usage.days = [D2]; delete s.usage.iid; });
    const r3 = up(z, ['usage-sync']);
    H.ok('对照表丢了编号：按记号找回原来那一条，不另建', r3.json && r3.json.sent === 1 && ui().length === 1 && ui()[0].notes.length === 3, r3.out);
    const p = up(z, ['usage-preview']);
    H.ok('看看要传的内容：今天攒到的样子', p.json && p.json.ok && new RegExp('### ' + D0 + ' 的使用情况').test(p.json.today) && Array.isArray(p.json.pending) && p.json.pending.length === 0 && p.json.iid === ui()[0].iid, p.out);
    const sum = up(z, ['issues-summary']);
    H.ok('上报页上：传到了哪一天、哪一条', sum.json && sum.json.usage && sum.json.usage.lastDay === D1 && sum.json.usage.iid === ui()[0].iid && sum.json.usage.on, sum.out);
    H.setConfig(z, { usageReport: 'off' });
    const off = up(z, ['usage-sync']);
    H.ok('关着：不传', off.json && /关着/.test(off.json.skipped || ''), off.out);
    H.setConfig(z, { usageReport: 'on' });
    // 导出：使用情况不当问题列、不关，汇总附在最后
    rec(u, { kind: '出错', hook: 'verify-gate', title: '导出使用情况那一轮记的问题', what: 'x', sig: 'sig-usage-exp' });
    up(u, ['issues-sync']);
    const e = up(u, ['issues-export']);
    const usageIid = ui()[0].iid;
    H.ok('导出：使用情况的议题不当问题列', e.json && e.json.ok && !e.json.iids.includes(usageIid) && !/## #\d+ \[使用情况\]/.test(e.json.text) && e.json.count === 1, e.json && [e.json.iids, e.json.count]);
    H.ok('导出：最后附了各台电脑的使用情况', /## 使用情况（/.test(e.json.text) && /\| 开口 \| 14 次/.test(e.json.text) && /\| 电脑 \| 天数 \|/.test(e.json.text) && e.json.usageDays >= 2, e.json.text.slice(e.json.text.indexOf('## 使用情况')));
    const c = up(u, ['issues-close', e.json.iids.join(','), '--name', e.json.name]);
    H.ok('关掉这一批：使用情况的议题还开着', c.json && c.json.ok && ui()[0].state === 'opened' && gl.issues().filter((i) => i.state === 'opened').length === 1, c.out);
    const e3 = up(u, ['issues-export']);
    H.ok('下次导出：使用情况从上次导出之后算，之前的不再带', e3.json && e3.json.ok && !/## 使用情况（/.test(e3.json.text), e3.json && e3.json.text.slice(-500));
  }

  H.section('令牌失效、快到期：自动换一个');
  {
    const t1 = secrets(u).gitlabToken;
    const p0 = pats().length;
    gl.dropToken(t1);
    rec(u, { kind: '其他', hook: 'guard-vibe', title: '令牌被删之后记的', what: 'x', sig: 'sig-revoked' });
    const r = up(u, ['issues-sync']);
    H.ok('SSH 申请来的令牌不认了：重新申请一个，照常传', r.json && r.json.created === 1 && !r.json.error && pats().length === p0 + 1 && secrets(u).gitlabToken !== t1 && secrets(u).gitlabTokenSource === 'ssh', r.out + r.err);
    const t2 = secrets(u).gitlabToken;
    const soon = new Date(Date.now() + 86400000);
    fs.writeFileSync(path.join(u.kit, 'secrets.json'), JSON.stringify(Object.assign(secrets(u), { gitlabTokenExpires: soon.getFullYear() + '-' + String(soon.getMonth() + 1).padStart(2, '0') + '-' + String(soon.getDate()).padStart(2, '0') })));
    rec(u, { kind: '其他', hook: 'guard-vibe', title: '令牌快到期时记的', what: 'x', sig: 'sig-expiring' });
    const r2 = up(u, ['issues-sync']);
    H.ok('令牌还有一天到期：先换一个新的再传', r2.json && r2.json.created === 1 && pats().length === p0 + 2 && secrets(u).gitlabToken !== t2, r2.out + r2.err);
  }

  H.section('老版本的 GitLab（不能用 SSH 申请令牌）、开关关着、手填的令牌');
  {
    const w = home('iss-w');
    up(w, ['issues-sync']);
    await H.sleep(1200);
    fs.rmSync(path.join(w.kit, 'state', 'issues.json'), { force: true });
    rec(w, { kind: '其他', hook: 'guard-vibe', title: '老 GitLab 上记的', what: 'x', sig: 'sig-w1' });
    gl.ssh({ pat: 'unknown' });
    const before = gl.issues().length;
    const r = up(w, ['issues-sync']);
    H.ok('申请不了令牌：说清楚，问题照旧只存在本机', r.json && r.json.created === 0 && r.json.noToken && /不支持/.test(r.json.error) && /手填/.test(r.json.error) && gl.issues().length === before && !fs.existsSync(path.join(w.kit, 'secrets.json')), r.out + r.err);
    H.ok('停 6 小时再试，不一直去申请', st(w).blockedUntil - Date.now() > 5 * 3600000, st(w));
    const n = pats().length;
    const k = H.node(w, '-e', ['console.log(require(' + JSON.stringify(path.join(w.kit, 'lib', 'updater.js')) + ').kick("测试"))'], { env: Object.assign({}, live) });
    const r2 = up(w, ['run', '--print']);
    H.ok('停着的时候：钩子不甩后台进程，后台进程也不去申请', k.out.trim() === 'false' && r2.json && r2.json.issues && /先停一阵/.test(r2.json.issues.skipped || '') && pats().length === n, k.out + r2.out);
    gl.ssh({ pat: 'disabled' });
    const r3 = up(w, ['mint']);
    H.ok('在配置页点"用 SSH 申请令牌"：说管理员关掉了', r3.json && !r3.json.ok && r3.json.unsupported && /disabled/.test(r3.json.why), r3.out);
    gl.ssh({ pat: 'ok' });
    // 手填一个
    const MT = 'glpat-manual-token-000001';
    gl.addToken(MT, 'wang');
    const g = require(path.join(w.kit, 'lib', 'gitlab.js'));
    g.saveSettings({ token: MT });
    const r4 = up(w, ['issues-sync']);
    const mine = gl.issues().find((i) => /老 GitLab 上记的/.test(i.title));
    H.ok('手填了令牌：传上去了，用的是手填的那个', r4.json && r4.json.created === 1 && mine && mine.author.username === 'wang' && pats().length === n + 1, r4.out + r4.err);
    const d = up(w, ['diagnose']);
    H.ok('测试连接：接口通，说了在项目里是什么角色', d.json && d.json.api && d.json.api.ok && d.json.api.levelName === 'Reporter' && d.json.api.source === 'manual' && d.json.git.route === 'token', d.out);
    gl.dropToken(MT);
    rec(w, { kind: '其他', hook: 'guard-vibe', title: '手填的令牌失效之后记的', what: 'x', sig: 'sig-w2' });
    const p0 = pats().length;
    const r5 = up(w, ['issues-sync']);
    H.ok('手填的令牌失效：不擅自换，告诉他令牌不对', r5.json && r5.json.created === 0 && /令牌不对或者过期了/.test(r5.json.error) && pats().length === p0 && secrets(w).gitlabToken === MT, r5.out);
    g.saveSettings({ token: '' });
    H.setConfig(w, { sshToken: 'off' });
    const r6 = up(w, ['issues-sync']);
    H.ok('"用 SSH 自动申请令牌"关着：不申请', r6.json && r6.json.created === 0 && r6.json.noToken && /开关关着/.test(r6.json.error) && pats().length === p0, r6.out);
    H.setConfig(w, { sshToken: 'auto' });
    gl.behave({ labels403: true, encoded404: true });
    const r7 = up(w, ['issues-sync']);
    const last = gl.issues().find((i) => /手填的令牌失效之后记的/.test(i.title));
    H.ok('反向代理把转码的路径解开了（404）：按名字搜到项目，记下编号', r7.json && r7.json.created === 1 && readJson(path.join(w.kit, 'gitlab.json')).projectId === 77, r7.out + r7.err);
    H.ok('没有建标签的权限：不带标签照样建', last && last.labels.length === 0, last && last.labels);
    gl.behave({ labels403: false, encoded404: false });
  }

  H.section('只传有了这个功能之后记的');
  {
    // 上一版留下的对照表里带着 backlogDone：认得，不碍事
    const x = home('iss-x');
    rec(x, { kind: '其他', hook: 'guard-vibe', title: '很早以前记的', what: 'x', sig: 'sig-x-old' });
    await H.sleep(1200);
    fs.writeFileSync(path.join(x.kit, 'feedback', 'issues.json'), JSON.stringify({ since: Date.now(), backlogDone: true, map: {} }));
    await H.sleep(1200);
    rec(x, { kind: '其他', hook: 'guard-vibe', title: '之后记的', what: 'x', sig: 'sig-x-new' });
    const before = gl.issues().length;
    const r = up(x, ['issues-sync']);
    const mine = gl.issues().slice(before);
    H.ok('只传之后记的，老的不传', r.json && r.json.created === 1 && r.json.left === 0 && mine.length === 1 && /之后记的/.test(mine[0].title), r.out + JSON.stringify(mine.map((i) => i.title)));
    // 记录清空之后，对照表里对不上的也清掉
    for (const f of fs.readdirSync(path.join(x.kit, 'feedback'))) if (/^F\d{8}-/.test(f)) fs.unlinkSync(path.join(x.kit, 'feedback', f));
    rec(x, { kind: '其他', hook: 'guard-vibe', title: '清空之后记的', what: 'x', sig: 'sig-x-3' });
    const r2 = up(x, ['issues-sync']);
    H.ok('记录清空过：对照表里对不上的清掉了', r2.json && r2.json.created === 1 && Object.keys(store(x).map).length === 1, store(x));
  }

  H.section('安装器：装新版不再推以前攒下的（存量推送去掉了）');
  {
    const pkg = H.makePackage('iss-pkg', '20260911.0900');
    const y = H.freshHome('iss-y');
    const first = H.node(y, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: y.root, timeout: 180000 });
    fs.rmSync(path.join(y.kit, 'feedback', 'issues.json'), { force: true });
    fs.writeFileSync(path.join(y.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    H.setConfig(y, { autoUpdate: 'off' });
    rec(y, { kind: '出错', hook: 'verify-gate', title: '装新版之前攒下的一条', what: 'x', sig: 'sig-y-1' });
    rec(y, { kind: '出错', hook: 'verify-gate', title: '装新版之前攒下的另一条', what: 'x', sig: 'sig-y-2' });
    try { fs.unlinkSync(path.join(y.kit, 'state', 'issues-dirty.json')); } catch (e) { /* 没有 */ }
    await H.sleep(1200);
    const before = gl.issues().length;
    const inst = H.node(y, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: y.root, timeout: 180000, env: Object.assign({}, live) });
    H.ok('装新版：不说"正在后台上报"，也不记"有东西要传"', first.code === 0 && inst.code === 0 && !/正在后台上报/.test(inst.out) && !fs.existsSync(path.join(y.kit, 'state', 'issues-dirty.json')), inst.out + inst.err);
    H.ok('装的时候就记下了从什么时候算起', store(y).since > 0 && Date.now() - store(y).since < 60000, store(y));
    await H.sleep(1200);
    // 装好之后、第一次上报之前记的：要传得上去
    rec(y, { kind: '出错', hook: 'verify-gate', title: '装新版之后记的', what: 'x', sig: 'sig-y-3' });
    H.ok('记了新问题：记一笔"有东西要传"', fs.existsSync(path.join(y.kit, 'state', 'issues-dirty.json')));
    const k = H.node(y, '-e', ['const u = require(' + JSON.stringify(path.join(y.kit, 'lib', 'updater.js')) + '); console.log(u.kick("测试"))'], { env: Object.assign({}, live) });
    H.ok('之后的钩子会去传', k.out.trim() === 'true', k.out + k.err);
    let done = false;
    for (let i = 0; i < 120 && !done; i++) { await H.sleep(500); done = gl.issues().length === before + 1 && !fs.existsSync(path.join(y.kit, 'update', 'lock.json')); }
    H.ok('后台传完了：只有装新版之后记的那一条，以前攒下的两条没传', done && /装新版之后记的/.test(gl.issues()[gl.issues().length - 1].title) && !gl.issues().some((i) => /装新版之前攒下的/.test(i.title)), [gl.issues().length - before, store(y)]);
  }

  gl.stop();
  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('问题上报和导出');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

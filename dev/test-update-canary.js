'use strict';
/*
 * 发版保护（K2，仓库主人 2026-11-01 定的"尝鲜组 + 观察期"，docs/feedback-20261101.md 的 K2）：在假 GitLab 上走一遍。
 *   尝鲜组   勾了"先装新版"的电脑一发现新版就装；没勾的等这一版发布满 24 小时（按仓库里那个提交的时间）、尝鲜组没报问题才装；
 *            报了的不装，维护的人关掉那条以后照常装；查不到（接口不通）按没问题；仓库退回旧版不等；配置页点"立即更新"不等
 *   观察期   装完新版，路由记的每天用量（router-data/usage-daily.json，测试里直接写）里失败明显变多：钩子甩的后台进程装回上一版、
 *            记反馈；尝鲜组的电脑在仓库里报"[有问题的版本]"（只有版本号和次数），别的电脑查到了不装，又一台报的补在同一条下面，
 *            导出后"关掉这一批"不关它；没勾的电脑装回不报；失败没变多、一直没怎么用的观察期照常过；不到 8 次、装之前就常失败的不判
 *   固定     点了"固定在这一版"什么都不自动装（新版、退回的旧版、观察期装回、装坏后再试），"立即更新"也不装，没装好的不能固定，取消以后照常
 *   跳过     点了"跳过这一版"仓库里是这一版时不自动装；取消跳过、"立即更新"照样能装；出了别的版本照常
 *   配置页   开关两份默认值一样、乱填的不收；页面上有这一项，顶部说清楚现在是什么状态
 * 发布用真的 publish.js（维护的人走令牌），"发布满 24 小时"用 GIT_COMMITTER_DATE 把发布的提交拨到 25 小时前。
 * 同事的电脑没有令牌、走 SSH（假 ssh），查"这一版有没有问题"时用 SSH 申请令牌。全程盯着桌面，推送只推临时目录里的裸仓库。
 * 用法：node dev/test-update-canary.js [旧版的 vibe-kit 目录] [假 GitLab 的端口，默认 18755]
 *       给了旧版目录就拿旧版的安装包、配置页后端跑，看新加的项有几项不过
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/harness');

const args = process.argv.slice(2);
const FROM = args.find((a) => !/^\d+$/.test(a) && fs.existsSync(path.join(a, 'kit'))) ? path.resolve(args.find((a) => !/^\d+$/.test(a) && fs.existsSync(path.join(a, 'kit')))) : null;
const SRCV = FROM || H.SRC;
const PORT = Number(args.find((a) => /^\d+$/.test(a))) || 18755;
const V = { A: '20261101.0900', B: '20261102.0900', C: '20261103.0900', D: '20261104.0900', E: '20261105.0900', F: '20261106.0900', R: '20261104.1200', G: '20261107.0900', H: '20261108.0900', I: '20261109.0900' };

const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const version = (h) => (H.read(path.join(h.kit, 'VERSION')) || '').trim();
const state = (h) => readJson(path.join(h.kit, 'state', 'update.json'));
const setState = (h, patch) => { const f = path.join(h.kit, 'state', 'update.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.assign(state(h), patch))); };
const setCfg = (h, patch) => { const f = path.join(h.kit, 'config.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), patch), null, 2)); };
/** 发布时间拨到 hours 小时前（git 认 "<秒> +0000" 这种写法） */
const publishedAgo = (hours) => { const t = Math.floor((Date.now() - hours * 3600000) / 1000) + ' +0000'; return { GIT_COMMITTER_DATE: t, GIT_AUTHOR_DATE: t }; };
/** n 天前的本地日期，和路由记每天用量的写法一样 */
const dayKey = (n) => { const d = new Date(Date.now() - (n || 0) * 86400000); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
/** 装成路由记的每天用量（router-data/usage-daily.json）：昨天 200 次失败 3 次，今天按给的数（一个模型） */
const usage = (h, t) => H.write(path.join(h.kit, 'router-data', 'usage-daily.json'), JSON.stringify({ [dayKey(1)]: { requests: 200, byProvider: { gw: { requests: 200, fail: 3, input: 10, output: 1 } } }, [dayKey(0)]: { requests: t.requests, byProvider: { gw: Object.assign({ input: 10, output: 1 }, t) } } }));

/** 一份安装包：从 SRCV（这一版的源码，或者给的旧版目录）拷，版本号改成 version */
function makePkg(name, version) {
  const dir = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(SRCV, dir, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(dir);
  fs.writeFileSync(path.join(dir, 'kit', 'VERSION'), version + '\n');
  const f = path.join(dir, '更新说明.md');
  const t = fs.readFileSync(f, 'utf8');
  const at = t.search(/^## /m);
  fs.writeFileSync(f, (at < 0 ? t + '\n' : t.slice(0, at)) + '## ' + version + '（测试）\n\n- 测试用的版本\n\n' + (at < 0 ? '' : t.slice(at)));
  return dir;
}

(async () => {
  const watch = await H.watchWindows('ucn-win');
  H.ok('盯窗口的脚本起来了', watch.ready);
  const gl = await H.fakeGitlab('ucn-gl', PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  const live = Object.assign({}, gl.env, { VIBE_KIT_NO_UPDATE: undefined });
  const http = { VIBE_KIT_NO_UPDATE: undefined, FAKE_GITLAB_DATA: gl.data, FAKE_GITLAB_REPOS: gl.repos };
  const api = 'http://127.0.0.1:' + PORT + '/api/v4/projects/77';

  // 维护的人：走令牌发布
  const m = H.freshHome('ucn-m');
  const MT = 'glpat-maintainer-token-k2';
  gl.addToken(MT, 'maintainer');
  fs.mkdirSync(m.kit, { recursive: true });
  fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  const pkg = {};
  for (const k of Object.keys(V)) pkg[k] = makePkg('ucn-' + k.toLowerCase(), V[k]);
  const publish = (p, extraArgs, env) => H.node(m, path.join(p, 'publish.js'), ['--no-install'].concat(extraArgs || []), { cwd: p, timeout: 600000, env: Object.assign({}, http, env || {}) });
  const pa = H.node(m, path.join(pkg.A, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkg.A, timeout: 600000, env: Object.assign({}, http) });
  H.ok('（维护的人发布了 A）', pa.code === 0 && version(m) === V.A, pa.out + pa.err);
  const glLib = require(path.join(m.kit, 'lib', 'gitlab.js'));
  const glApi = (method, url, body) => glLib.request(method, api + url, { token: MT, body });

  /** 同事的一台电脑：装 A（不带路由），仓库地址指假 GitLab，没有令牌（走 SSH） */
  function machine(name, cfg) {
    const h = H.freshHome(name);
    const inst = H.node(h, path.join(pkg.A, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
    H.ok('（' + name + ' 装上了 A）', inst.code === 0 && version(h) === V.A, inst.out + inst.err);
    fs.writeFileSync(path.join(h.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    if (cfg) setCfg(h, cfg);
    h.run = (cmd, env) => { const r = H.node(h, path.join(h.kit, 'lib', 'updater.js'), cmd, { cwd: h.root, timeout: 600000, env: Object.assign({}, live, env || {}) }); return Object.assign(r, { json: json(r.out) }); };
    h.js = (code) => H.node(h, '-e', [code], { cwd: h.root, timeout: 60000, env: Object.assign({}, live) }).out.trim().split(/\r?\n/).pop();
    h.up = () => JSON.stringify(path.join(h.kit, 'lib', 'updater.js'));
    h.line = () => plain(H.node(h, path.join(h.kit, 'statusline.js'), [], { input: '{}', cwd: h.root }).out);
    h.status = () => { try { return JSON.parse(h.js('console.log(JSON.stringify(require(' + h.up() + ').status()))')); } catch (e) { return {}; } };
    return h;
  }
  const searched = (v) => gl.requests().filter((x) => x.kind === 'api' && x.method === 'GET' && decodeURIComponent(x.url).includes('vibe-kit-bad-version:' + v));

  // ---------------------------------------------------------------------------------------------
  H.section('没勾"先装新版"：新版发布不到 24 小时不装，状态栏、配置页说在等尝鲜组');
  const u = machine('ucn-u');
  {
    H.ok('默认不勾"先装新版"', readJson(path.join(u.kit, 'config.json')).updateEarly !== true);
    const p = publish(pkg.B);
    H.ok('（发布了 B）', p.code === 0, p.out + p.err);
    const r = u.run(['run', '--print']);
    H.ok('查到了 B，没装', r.code === 0 && r.json && r.json.check && r.json.check.remote === V.B && !r.json.apply && version(u) === V.A, r.out + r.err);
    const st = state(u);
    H.ok('记下了这一版什么时候发布的（就是刚才）', Math.abs(Number(st.remoteAt) - Date.now()) < 10 * 60000 && Number(st.remoteSeenAt) > 0, st);
    const s = u.status();
    H.ok('配置页的接口：在等尝鲜组，等到发布之后 24 小时', s.hold === 'wait' && Math.abs(Number(s.waitUntil) - (Number(st.remoteAt) + 24 * 3600000)) < 2000 && s.early === false && s.differs, s);
    H.ok('不算装不上（不说"装坏"）', !s.failed && s.behind, s);
    H.ok('状态栏：新版 B 等尝鲜组先试、什么时候以后装', /新版 20261102\.0900 等尝鲜组先试，(今天|明天) \d\d:\d\d 以后装/.test(u.line()), u.line());
    H.ok('钩子不甩后台进程去装', u.js('console.log(require(' + u.up() + ').kick("测试"))') === 'false');
    H.ok('needInstall：不装', u.js('console.log(require(' + u.up() + ').needInstall())') === 'false');
    H.ok('还在等的不去仓库查"有没有问题"', searched(V.B).length === 0, gl.requests().filter((x) => x.kind === 'api').map((x) => x.url));
  }

  H.section('勾了"先装新版"（尝鲜组）：一发现就装，和以前一样，不查"有没有问题"');
  {
    const e = machine('ucn-e', { updateEarly: true });
    const r = e.run(['run', '--print']);
    H.ok('发布才几分钟的 B：马上装上了', r.json && r.json.apply && r.json.apply.ok && version(e) === V.B, r.out + r.err);
    H.ok('尝鲜组不查"这一版有没有问题"', !state(e).flag && searched(V.B).length === 0, state(e).flag);
  }

  H.section('发布满 24 小时、尝鲜组没报问题：装上（装之前查了一次）');
  {
    const p = publish(pkg.C, [], publishedAgo(25));
    H.ok('（发布了 C，发布时间拨到 25 小时前）', p.code === 0, p.out + p.err);
    setState(u, { lastCheckAt: 0 });
    gl.clearLogs();
    const r = u.run(['run', '--print']);
    H.ok('装上了 C', r.json && r.json.apply && r.json.apply.ok && version(u) === V.C, r.out + r.err);
    const st = state(u);
    H.ok('发布时间按仓库里那个提交的（25 小时前）', Math.abs(Number(st.remoteAt) - (Date.now() - 25 * 3600000)) < 15 * 60000, st.remoteAt);
    H.ok('装之前去仓库查了"有没有问题"，记下了：没人报', searched(V.C).length >= 1 && st.flag && st.flag.version === V.C && st.flag.ok === true && st.flag.bad === false, [st.flag, gl.requests().filter((x) => x.kind === 'api').map((x) => x.method + ' ' + x.url)]);
  }

  H.section('尝鲜组报了这一版有问题：不装；维护的人把那条关掉以后照常装');
  {
    const made = await glApi('POST', '/issues', { title: '[有问题的版本] ' + V.D, description: '测试：尝鲜组报的。\nvibe-kit-bad-version:' + V.D + '\n', labels: 'vibe-kit有问题的版本' });
    H.ok('（仓库里有一条"[有问题的版本] D"）', made.status === 201, made.text);
    const p = publish(pkg.D, [], publishedAgo(25));
    H.ok('（发布了 D，25 小时前）', p.code === 0, p.out + p.err);
    setState(u, { lastCheckAt: 0 });
    const r = u.run(['run', '--print']);
    H.ok('查到了 D，没装', r.json && r.json.check && r.json.check.remote === V.D && !r.json.apply && version(u) === V.C, r.out + r.err);
    const st = state(u);
    H.ok('记下了：D 被报了有问题，是哪一条', st.flag && st.flag.version === V.D && st.flag.bad === true && st.flag.iid === (made.json && made.json.iid), st.flag);
    const s = u.status();
    H.ok('配置页的接口：hold 是 flag，带着那一条', s.hold === 'flag' && s.flag && s.flag.bad && s.flag.iid > 0, s);
    H.ok('状态栏：尝鲜组报了有问题，先不装', /新版 20261104\.0900 尝鲜组报了有问题，先不装/.test(u.line()), u.line());
    H.ok('钩子不甩后台进程去装', u.js('console.log(require(' + u.up() + ').kick("测试"))') === 'false');
    H.ok('日志里说了', /尝鲜组报了 20261104\.0900 有问题/.test(H.read(path.join(u.kit, 'update', 'update.log')) || ''));
    const closed = await glApi('PUT', '/issues/' + made.json.iid, { state_event: 'close' });
    const r2 = u.run(['run', '--print']);
    H.ok('关掉之后两小时内：还按查过的算，不去再查', closed.status === 200 && r2.json && !r2.json.apply && version(u) === V.C, r2.out + r2.err);
    setState(u, { flag: Object.assign({}, state(u).flag, { at: Date.now() - 3 * 3600000 }) });
    const r3 = u.run(['run', '--print']);
    H.ok('查过的过了两小时：再查，没有开着的了，装上 D', r3.json && r3.json.apply && r3.json.apply.ok && version(u) === V.D && state(u).flag.bad === false, r3.out + r3.err);
  }

  H.section('查不到有没有人报（接口不通）：按没问题，满 24 小时照装');
  {
    const p = publish(pkg.E, [], publishedAgo(25));
    H.ok('（发布了 E，25 小时前）', p.code === 0, p.out + p.err);
    gl.behave({ apiDown: true });
    setState(u, { lastCheckAt: 0 });
    const r = u.run(['run', '--print']);
    gl.behave({ apiDown: false });
    H.ok('接口回 500：照样装上了 E', r.json && r.json.apply && r.json.apply.ok && version(u) === V.E, r.out + r.err);
    const st = state(u);
    H.ok('记下了"没查成"，不算有问题', st.flag && st.flag.version === V.E && st.flag.ok === false && st.flag.bad === false && /500/.test(st.flag.why || ''), st.flag);
    H.ok('日志里说了按没问题算', /查不到尝鲜组有没有报 20261105\.0900 有问题.*按没问题算/.test(H.read(path.join(u.kit, 'update', 'update.log')) || ''));
  }

  H.section('仓库退回旧版（维护的人把大家退回去）：不等 24 小时，马上跟着退');
  {
    // 退回去的版本号比装着的 E 旧（同一个版本号不能再发一次：标签已经有了）
    const p = publish(pkg.R, ['--rollback']);
    H.ok('（维护的人发布了比 E 旧的 ' + V.R + '，刚刚发布的）', p.code === 0 && H.git(gl.bare, ['show', 'main:kit/VERSION']).out.trim() === V.R, p.out + p.err);
    setState(u, { lastCheckAt: 0 });
    const r = u.run(['run', '--print']);
    H.ok('马上退回了 ' + V.R, r.json && r.json.apply && r.json.apply.ok && version(u) === V.R, r.out + r.err);
  }

  H.section('配置页点"立即更新"：不等尝鲜组');
  {
    const p = publish(pkg.F);
    H.ok('（发布了 F，刚刚）', p.code === 0, p.out + p.err);
    setState(u, { lastCheckAt: 0 });
    const r = u.run(['run', '--print']);
    H.ok('自动的：在等，不装', r.json && !r.json.apply && version(u) === V.R && u.status().hold === 'wait', r.out + r.err);
    const a = u.run(['apply']);
    H.ok('点了"立即更新"：装上 F', a.json && a.json.apply && a.json.apply.ok && version(u) === V.F, a.out + a.err);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('观察期：尝鲜组的电脑装完新版，路由的请求失败率明显变高 → 钩子甩后台进程装回上一版、记反馈、在仓库里报这一版有问题');
  const c1 = machine('ucn-c1', { updateEarly: true });
  const ucn = (h) => JSON.stringify(path.join(h.kit, 'lib', 'issues.js'));
  {
    // 装之前：昨天 200 次失败 3 次；今天 120 次（4 次按 Esc 取消）失败 2 次
    usage(c1, { requests: 120, fail: 2, cancelled: 4 });
    const p = publish(pkg.G);
    H.ok('（发布了 G，刚刚）', p.code === 0, p.out + p.err);
    const r = c1.run(['run', '--print']);
    H.ok('尝鲜组马上装上了 G', r.json && r.json.apply && r.json.apply.ok && version(c1) === V.G, r.out + r.err);
    const ob = state(c1).observe;
    H.ok('装完开始观察：记下装的时候今天的数（不算取消的）、装之前几天的数', !!ob && ob.version === V.G && ob.from === V.A && ob.day === dayKey(0) && ob.snap && ob.snap.req === 116 && ob.snap.fail === 2 && ob.base && ob.base.req === 316 && ob.base.fail === 5, ob);
    const s = c1.status();
    H.ok('配置页的接口：观察到什么时候（装完 2 小时、最晚 24 小时）', s.observe && s.observe.version === V.G && Math.abs(s.observe.until - (ob.at + 2 * 3600000)) < 1000 && Math.abs(s.observe.last - (ob.at + 24 * 3600000)) < 1000, s.observe);
    H.ok('状态栏：已更新到 G，观察中', /已更新到 20261107\.0900，观察中/.test(c1.line()), c1.line());
    H.ok('刚装完：钩子还不甩后台进程去看', c1.js('console.log(require(' + c1.up() + ').kick("测试"))') === 'false');
    // 装之后：14 次请求（1 次取消）、失败 11 次
    usage(c1, { requests: 134, fail: 13, cancelled: 5 });
    setState(c1, { observe: Object.assign({}, state(c1).observe, { lastAt: Date.now() - 11 * 60000 }), lastKickAt: 0 });
    const k = c1.js('console.log(require(' + c1.up() + ').kick("测试"))');
    H.ok('过了 10 分钟：钩子甩后台进程去看', k === 'true', k);
    let done = false;
    for (let i = 0; i < 360 && k === 'true' && !done; i++) { await H.sleep(500); done = !!(state(c1).failed && state(c1).failed.version === V.G) && !fs.existsSync(path.join(c1.kit, 'update', 'lock.json')); }
    const st = state(c1);
    H.ok('后台装回了 A', done && version(c1) === V.A, [version(c1), st, H.read(path.join(c1.kit, 'update', 'update.log'))]);
    H.ok('记下 G 是装回的：不再自动装，带着装之后的数', st.failed && st.failed.version === V.G && st.failed.from === V.A && st.failed.times >= 2 && st.failed.rolledBack === true && st.failed.observed && st.failed.observed.req === 13 && st.failed.observed.fail === 11 && /失败/.test(st.failed.why || '') && !st.observe, st.failed);
    H.ok('更新记录里有这一笔', (st.history || []).some((x) => x.to === V.G && x.ok === false && x.observed && x.rolledBack), st.history);
    H.ok('从本机留的上一版装回（不用连仓库）', /已从本地恢复上一版/.test(H.read(path.join(c1.kit, 'update', 'update.log')) || ''));
    const fbDir = path.join(c1.kit, 'feedback');
    const recs = fs.existsSync(fbDir) ? fs.readdirSync(fbDir).filter((f) => /\.md$/.test(f)).map((f) => H.read(path.join(fbDir, f))) : [];
    H.ok('记了一条问题反馈', recs.some((t) => /20261107\.0900/.test(t) && /观察期/.test(t)), recs.map((t) => t.slice(0, 200)));
    const bad = gl.issues().filter((i) => i.title === '[有问题的版本] ' + V.G);
    const desc = bad.length ? bad[0].description : '';
    H.ok('在仓库里报了"[有问题的版本] G"，带标签', bad.length === 1 && bad[0].state === 'opened' && desc.includes('vibe-kit-bad-version:' + V.G) && (bad[0].labels || []).includes('vibe-kit有问题的版本'), gl.issues().map((i) => i.title));
    H.ok('报的只有版本号和次数：装之前、装之后各几次', /装之前/.test(desc) && /请求 316 次，失败 5 次/.test(desc) && /请求 13 次，失败 11 次/.test(desc) && desc.includes(V.A), desc);
    H.ok('不带电脑名、路径、模型名', !desc.includes(require('os').hostname()) && !desc.includes(c1.root) && !/vkt-|\\Users\\|gw/.test(desc), desc);
    H.ok('记下报过了（哪一条）', st.flagSent && st.flagSent.version === V.G && st.flagSent.ok === true && st.flagSent.iid === (bad[0] && bad[0].iid), st.flagSent);
    H.ok('状态栏：G 装完出错变多，已装回 A', /新版 20261107\.0900 装完出错变多，已装回 20261101\.0900，看配置页/.test(c1.line()), c1.line());
    setState(c1, { lastCheckAt: 0 });
    const again = c1.run(['run', '--print']);
    H.ok('再检查：G 不再自动装', again.json && again.json.check && again.json.check.remote === V.G && !again.json.apply && version(c1) === V.A, again.out + again.err);
  }

  H.section('别的电脑：尝鲜组报了 G 有问题，过了 24 小时也不装；又一台尝鲜组装回时在同一条下面补一句');
  {
    setState(u, { lastCheckAt: 0 });
    const r0 = u.run(['run', '--print']);
    H.ok('（u 查到了 G，在等）', r0.json && r0.json.check && r0.json.check.remote === V.G && !r0.json.apply && version(u) === V.F, r0.out + r0.err);
    setState(u, { remoteAt: Date.now() - 25 * 3600000 });
    const r = u.run(['run', '--print']);
    H.ok('过了 24 小时：查到尝鲜组报了 G 有问题，不装', r.json && !r.json.apply && version(u) === V.F && state(u).flag && state(u).flag.version === V.G && state(u).flag.bad === true, [r.out, state(u).flag]);
    const more = c1.js('require(' + ucn(c1) + ').flagVersion(' + JSON.stringify(V.G) + ', { from: ' + JSON.stringify(V.A) + ', base: { req: 50, fail: 1 }, after: { req: 9, fail: 9 }, minutes: 25 }).then((x) => console.log(JSON.stringify(x)))');
    const bad = gl.issues().filter((i) => i.title === '[有问题的版本] ' + V.G);
    H.ok('又一台报的：没另建，在那一条下面补了一句', bad.length === 1 && bad[0].notes.filter((n) => !n.system).length === 1 && /又一台尝鲜组的电脑/.test(bad[0].notes[0].body) && /请求 9 次，失败 9 次/.test(bad[0].notes[0].body), [more, bad.map((i) => i.notes)]);
    setState(u, { flag: Object.assign({}, state(u).flag, { at: Date.now() - 3 * 3600000 }) });
    u.run(['run', '--print']);
    H.ok('别的电脑再查：看得到报了两台', state(u).flag && state(u).flag.bad === true && state(u).flag.count === 2, state(u).flag);
    const closed = c1.js('require(' + ucn(c1) + ').closeExported([' + (bad[0] ? bad[0].iid : 0) + '], "").then((x) => console.log(JSON.stringify(x)))');
    H.ok('维护的人导出后"关掉这一批"：这一条不关（关了别的电脑就会去装）', bad[0] && gl.issues().find((i) => i.iid === bad[0].iid).state === 'opened', closed);
  }

  H.section('没勾"先装新版"的电脑观察期里装回：记反馈，不在仓库里报');
  {
    // u 装着 F（从 R 点"立即更新"装上的，本机留着 R）：装成正在观察 F，装之后 12 次失败 10 次
    usage(u, { requests: 12, fail: 10 });
    setState(u, { observe: { version: V.F, from: V.R, at: Date.now() - 30 * 60000, lastAt: 0, day: dayKey(0), snap: { req: 0, fail: 0 }, base: { req: 200, fail: 3 } } });
    const r = u.run(['run', '--print']);
    H.ok('装回了 R', version(u) === V.R && r.json && r.json.observe && r.json.observe.rolledBack === true, r.out + r.err);
    H.ok('这一次别的事都不做了（进程里还是新版的代码）', r.json && !r.json.check && !r.json.apply && r.json.issues === undefined, r.json);
    H.ok('没在仓库里报', !gl.issues().some((i) => i.title === '[有问题的版本] ' + V.F) && !state(u).flagSent, gl.issues().map((i) => i.title));
    H.ok('记下 F 是装回的', state(u).failed && state(u).failed.version === V.F && state(u).failed.observed, state(u).failed);
  }

  H.section('观察期过了：失败没变多（过了 2 小时、看够 20 次）、一直没怎么用（24 小时）；不到 8 次不判；装之前就常失败的不算变高');
  {
    const p = publish(pkg.H);
    H.ok('（发布了 H，刚刚）', p.code === 0, p.out + p.err);
    setState(c1, { lastCheckAt: 0 });
    const r = c1.run(['run', '--print']);
    H.ok('（尝鲜组装上了 H，开始观察）', r.json && r.json.apply && r.json.apply.ok && version(c1) === V.H && state(c1).observe && state(c1).observe.version === V.H, r.out + r.err);
    // 装的时候今天是 134 次（5 次取消）失败 13 次；之后 25 次请求失败 1 次
    usage(c1, { requests: 159, fail: 14, cancelled: 5 });
    setState(c1, { observe: Object.assign({}, state(c1).observe, { at: Date.now() - 3 * 3600000, lastAt: 0 }) });
    const r2 = c1.run(['run', '--print']);
    const st = state(c1);
    H.ok('过了 2 小时、看了 25 次、失败 1 次：观察期过了，不装回', version(c1) === V.H && !st.observe && st.observed && st.observed.version === V.H && st.observed.req === 25 && st.observed.fail === 1 && r2.json && r2.json.observe && r2.json.observe.passed, [r2.out, st.observed]);
    H.ok('日志里说了', /观察期过了/.test(H.read(path.join(c1.kit, 'update', 'update.log')) || ''));
    const fake = (at, snap, base) => setState(c1, { observe: { version: V.H, from: V.A, at: Date.now() - at, lastAt: 0, day: dayKey(0), snap, base } });
    fake(25 * 3600000, { req: 151, fail: 14 }, { req: 300, fail: 5 });
    c1.run(['run', '--print']);
    H.ok('装完 25 小时只有 3 次请求：不再看了，算过了', version(c1) === V.H && !state(c1).observe && state(c1).observed && state(c1).observed.req === 3, state(c1));
    fake(3600000, { req: 149, fail: 9 }, { req: 300, fail: 5 });
    c1.run(['run', '--print']);
    H.ok('装完 1 小时 5 次全失败：不到 8 次不判，接着看', version(c1) === V.H && state(c1).observe && state(c1).observe.seen && state(c1).observe.seen.req === 5 && state(c1).observe.seen.fail === 5, state(c1).observe);
    fake(3600000, { req: 144, fail: 7 }, { req: 100, fail: 50 });
    c1.run(['run', '--print']);
    H.ok('装之前就一半失败（网关本来就不稳）、装之后 10 次失败 7 次：不算变高，接着看', version(c1) === V.H && state(c1).observe && state(c1).observe.seen && state(c1).observe.seen.req === 10, state(c1).observe);
    setState(c1, { observe: null });
  }

  let api0 = null; let ses = null;
  try { api0 = require(path.join(SRCV, 'router', 'kit-api.js')); } catch (e) { api0 = null; }
  try { ses = require(path.join(SRCV, 'kit', 'lib', 'session.js')); } catch (e) { ses = null; }
  /** 配置页的接口：出错返回 { error } */
  const post = (h, url, body) => (api0 ? api0.handle('POST', '/api/kit/remote' + url, body, h.kit).catch((e) => ({ error: e.message })) : Promise.resolve({ error: '没有 kit-api' }));

  H.section('固定在这一版：什么版本都不自动装（新版、退回的旧版、观察期装回、装坏后再试），"立即更新"也不装；取消以后照常');
  {
    // 勾了"先装新版"：不固定的话一发现就装，看得最清楚
    const p = machine('ucn-p', { updateEarly: true });
    const off = p.run(['check']);
    H.ok('（查到仓库里是 H）', off.json && off.json.remote === V.H && off.json.differs, off.out + off.err);
    const d = await post(p, '/pin', { on: true });
    H.ok('点"固定在这一版"：配置里记下装着的版本，接口带着 pin', d.ok === true && d.update && d.update.pin === V.A && readJson(path.join(p.kit, 'config.json')).updatePin === V.A, d.error || (d.update && d.update.pin));
    setState(p, { lastCheckAt: 0 });
    const r = p.run(['run', '--print']);
    H.ok('照常检查，不装', r.json && r.json.check && r.json.check.remote === V.H && !r.json.apply && version(p) === V.A, r.out + r.err);
    const s = p.status();
    H.ok('配置页的接口：hold 是 pin', s.hold === 'pin' && s.pin === V.A && s.differs, [s.hold, s.pin]);
    H.ok('状态栏：固定在 A，不自动更新，仓库里是 H', /固定在 20261101\.0900，不自动更新（仓库里是 20261108\.0900）/.test(p.line()), p.line());
    H.ok('钩子不甩后台进程去装', p.js('console.log(require(' + p.up() + ').kick("测试"))') === 'false');
    const a = p.run(['apply']);
    H.ok('命令行 apply（"立即更新"走的这条）：不装，说要先取消固定', a.json && a.json.apply && a.json.apply.ok === false && a.json.apply.pinned === true && /取消固定/.test(a.json.apply.why) && version(p) === V.A, a.out + a.err);
    const ap = await post(p, '/apply', {});
    H.ok('配置页的"立即更新"接口：不开始，说要先取消固定', ap.started === false && /取消固定/.test(ap.why || ''), ap.error || ap.why);
    H.ok('仓库退回旧版也不跟', p.js('console.log(require(' + p.up() + ').gate({ updatePin: ' + JSON.stringify(V.A) + ' }, { remoteVersion: "20261001.0900" }, ' + JSON.stringify(V.A) + ', Date.now()).hold)') === 'pin');
    // 观察期：装之后 12 次失败 10 次，本来该装回
    usage(p, { requests: 12, fail: 10 });
    setState(p, { observe: { version: V.A, from: '20261001.0900', at: Date.now() - 30 * 60000, lastAt: 0, day: dayKey(0), snap: { req: 0, fail: 0 }, base: { req: 200, fail: 3 } } });
    const ob = p.run(['run', '--print']);
    H.ok('观察期不看了，失败变多也不装回', version(p) === V.A && !state(p).observe && ob.json && ob.json.observe && /固定/.test(ob.json.observe.dropped || ''), [ob.out, state(p).observe]);
    H.ok('接口不说在观察', !p.status().observe);
    // 装坏了也没装回去的状态：不固定的话过 6 小时再试着装回
    // at 要比安装器记的 install-done 晚（不然算"之后装好过"）；retriedAt 是上次试的时间
    setState(p, { failed: { version: V.A, from: '20261001.0900', times: 1, at: Date.now(), retriedAt: Date.now() - 7 * 3600000, rolledBack: false, why: '测试' } });
    H.ok('（接口认出装坏了）', !!p.status().broken, p.status().broken);
    p.run(['run', '--print']);
    H.ok('装坏后不再试着装回', version(p) === V.A && !/上次没装回去|还是没能装回上一版/.test(H.read(path.join(p.kit, 'update', 'update.log')) || ''), H.read(path.join(p.kit, 'update', 'update.log')));
    const un = await post(p, '/pin', { on: false });
    H.ok('点"取消固定"：配置里清空', un.ok === true && un.update && un.update.pin === '' && readJson(path.join(p.kit, 'config.json')).updatePin === '', un.error);
    const broken = await post(p, '/pin', { on: true });
    H.ok('没装好的版本不能固定', /不能固定/.test(broken.error || '') && readJson(path.join(p.kit, 'config.json')).updatePin === '', broken);
    setState(p, { failed: null, lastCheckAt: 0 });
    const again = p.run(['run', '--print']);
    H.ok('取消以后：照常装上 H', again.json && again.json.apply && again.json.apply.ok && version(p) === V.H, again.out + again.err);
  }

  H.section('跳过这一版：仓库里是这一版时不自动装；取消跳过、"立即更新"照样能装；出了别的版本照常');
  {
    const none = machine('ucn-s0', { updateEarly: true });
    const sn = await post(none, '/skip', { on: true });
    H.ok('还没查到别的版本：没有可跳过的', /没有可跳过的/.test(sn.error || ''), sn);
    const s = machine('ucn-s', { updateEarly: true });
    s.run(['check']);
    const d = await post(s, '/skip', { on: true });
    H.ok('点"跳过这一版"：配置里记下仓库里的版本', d.ok === true && d.update && d.update.skip === V.H && d.update.hold === 'skip' && readJson(path.join(s.kit, 'config.json')).updateSkip === V.H, d.error || (d.update && [d.update.skip, d.update.hold]));
    const r = s.run(['run', '--print']);
    H.ok('不装', r.json && !r.json.apply && version(s) === V.A, r.out + r.err);
    H.ok('状态栏：跳过了新版 H', /跳过了新版 20261108\.0900，出了别的版本照常/.test(s.line()), s.line());
    H.ok('钩子不甩后台进程去装', s.js('console.log(require(' + s.up() + ').kick("测试"))') === 'false');
    const un = await post(s, '/skip', { on: false });
    setState(s, { lastCheckAt: 0 });
    const r2 = s.run(['run', '--print']);
    H.ok('取消跳过：照常装上 H', un.ok === true && r2.json && r2.json.apply && r2.json.apply.ok && version(s) === V.H, un.error || r2.out + r2.err);
    const f = machine('ucn-s2', { updateEarly: true });
    f.run(['check']);
    await post(f, '/skip', { on: true });
    const a = f.run(['apply']);
    H.ok('跳过的版本点"立即更新"照样装上', a.json && a.json.apply && a.json.apply.ok && version(f) === V.H, a.out + a.err);
    const n = machine('ucn-s3', { updateEarly: true });
    n.run(['check']);
    await post(n, '/skip', { on: true });
    const pi = publish(pkg.I);
    H.ok('（发布了 I）', pi.code === 0, pi.out + pi.err);
    setState(n, { lastCheckAt: 0 });
    const r3 = n.run(['run', '--print']);
    H.ok('出了别的版本：不用取消，照常装上', r3.json && r3.json.apply && r3.json.apply.ok && version(n) === V.I, r3.out + r3.err);
  }

  H.section('配置页：开关的默认值、清洗；页面上有这一项、顶部说清楚状态');
  {
    const sorted = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
    H.ok('两份默认值一样，"先装新版"默认不勾', !!api0 && !!ses && api0.DEFAULT_CONFIG.updateEarly === false && ses.DEFAULT_CONFIG.updateEarly === false && sorted(api0.DEFAULT_CONFIG) === sorted(ses.DEFAULT_CONFIG));
    const c1 = api0 ? api0.cleanConfig({ updateEarly: true }) : {};
    const c2 = api0 ? api0.cleanConfig({ updateEarly: 'yes' }, { updateEarly: true }) : {};
    H.ok('保存时：真假收，乱填的保持原值', c1.updateEarly === true && c2.updateEarly === true, [c1.updateEarly, c2.updateEarly]);
    H.ok('固定、跳过默认都没有，两份默认值一样', !!api0 && !!ses && api0.DEFAULT_CONFIG.updatePin === '' && ses.DEFAULT_CONFIG.updatePin === '' && api0.DEFAULT_CONFIG.updateSkip === '' && ses.DEFAULT_CONFIG.updateSkip === '');
    const c3 = api0 ? api0.cleanConfig({ updatePin: V.A, updateSkip: V.B }) : {};
    const c4 = api0 ? api0.cleanConfig({ updatePin: '乱写的', updateSkip: 123 }, { updatePin: V.A, updateSkip: V.B }) : {};
    const c5 = api0 ? api0.cleanConfig({ updatePin: '' }, { updatePin: V.A }) : {};
    const c6 = api0 ? api0.cleanConfig({ autoUpdate: 'notify' }, { updatePin: V.A, updateSkip: V.B }) : {};
    H.ok('固定、跳过：收版本号和空串，乱填的保持原值，别的开关保存时不冲掉', c3.updatePin === V.A && c3.updateSkip === V.B && c4.updatePin === V.A && c4.updateSkip === V.B && c5.updatePin === '' && c6.updatePin === V.A && c6.updateSkip === V.B, [c3, c4, c5, c6].map((c) => [c.updatePin, c.updateSkip]));
    const view = api0 ? await api0.handle('GET', '/api/kit/remote/status', null, u.kit).catch((e) => ({ error: e.message })) : {};
    H.ok('"更新和上报"的接口：带着开关和发版保护的状态', view && view.config && view.config.updateEarly === false && view.update && typeof view.update.hold === 'string' && 'waitUntil' in view.update && 'flag' in view.update && 'observe' in view.update, view && [view.config, view.update && view.update.hold]);
    const page = H.read(path.join(SRCV, 'router', 'ui.html')) || '';
    const remoteTab = page.slice(page.indexOf('id="tab-remote"'));
    H.ok('"更新和上报"那一页有"先装新版（尝鲜）"，说了 24 小时、尝鲜组、查不到按没问题', /id="k_updateEarly"/.test(remoteTab) && /先装新版（尝鲜）/.test(remoteTab) && /发布满 24 小时/.test(remoteTab) && /查不到有没有人报.*按没问题算/.test(remoteTab) && /fBool\('updateEarly'/.test(page));
    H.ok('页面顶部有单独说更新状态的一块（不被路由的提示冲掉）', /<div id="updBanner"><\/div>/.test(page) && /function renderUpdBanner/.test(page) && /等尝鲜组先试/.test(page));
    H.ok('观察期：卡片上说了装完观察、细节里写了门槛；状态表、顶部说观察中、装回了', /装完再观察至少 2 小时/.test(remoteTab) && /至少 8 次请求、一半以上失败、比装之前高 30 个百分点/.test(remoteTab) && /装回的那一版/.test(page) && /套件刚更新到 ' \+ esc\(u\.observe\.version\) \+ '，在观察/.test(page) && /装完以后出错明显变多，已经自动装回/.test(page));
    H.ok('固定、跳过：卡片上有两个按钮和说明；状态表、顶部说清楚；固定着"立即更新"是灰的', /id="ruPin"/.test(remoteTab) && /id="ruSkip"/.test(remoteTab) && /什么版本都不自动装/.test(remoteTab) && /api\('POST', '\/api\/kit\/remote\/pin'/.test(page) && /api\('POST', '\/api\/kit\/remote\/skip'/.test(page) && /套件固定在 /.test(page) && /跳过了套件的新版 /.test(page) && /\$\('ruApply'\)\.disabled = [^;]*u\.pin/.test(page));
    // 页面的脚本没有语法错
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
    let syntax = '';
    for (const s of scripts) { try { new vm.Script(s); } catch (e) { syntax = String(e.message); } }
    H.ok('页面的脚本能编译', scripts.length > 0 && !syntax, syntax);
  }

  gl.stop();
  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('发版保护（尝鲜组、观察期、固定和跳过）' + (FROM ? '，拿 ' + FROM + ' 跑' : ''));
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

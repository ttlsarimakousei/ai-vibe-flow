'use strict';
/*
 * 发版保护（K2，仓库主人 2026-11-01 定的"尝鲜组 + 观察期"，docs/feedback-20261101.md 的 K2）：在假 GitLab 上走一遍。
 *   尝鲜组   勾了"先装新版"的电脑一发现新版就装；没勾的等这一版发布满 24 小时（按仓库里那个提交的时间）、尝鲜组没报问题才装；
 *            报了的不装，维护的人关掉那条以后照常装；查不到（接口不通）按没问题；仓库退回旧版不等；配置页点"立即更新"不等
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
const V = { A: '20261101.0900', B: '20261102.0900', C: '20261103.0900', D: '20261104.0900', E: '20261105.0900', F: '20261106.0900', R: '20261104.1200' };

const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
const version = (h) => (H.read(path.join(h.kit, 'VERSION')) || '').trim();
const state = (h) => readJson(path.join(h.kit, 'state', 'update.json'));
const setState = (h, patch) => { const f = path.join(h.kit, 'state', 'update.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.assign(state(h), patch))); };
const setCfg = (h, patch) => { const f = path.join(h.kit, 'config.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), patch), null, 2)); };
/** 发布时间拨到 hours 小时前（git 认 "<秒> +0000" 这种写法） */
const publishedAgo = (hours) => { const t = Math.floor((Date.now() - hours * 3600000) / 1000) + ' +0000'; return { GIT_COMMITTER_DATE: t, GIT_AUTHOR_DATE: t }; };

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

  H.section('配置页：开关的默认值、清洗；页面上有这一项、顶部说清楚状态');
  {
    let api0 = null; let ses = null;
    try { api0 = require(path.join(SRCV, 'router', 'kit-api.js')); } catch (e) { api0 = null; }
    try { ses = require(path.join(SRCV, 'kit', 'lib', 'session.js')); } catch (e) { ses = null; }
    const sorted = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
    H.ok('两份默认值一样，"先装新版"默认不勾', !!api0 && !!ses && api0.DEFAULT_CONFIG.updateEarly === false && ses.DEFAULT_CONFIG.updateEarly === false && sorted(api0.DEFAULT_CONFIG) === sorted(ses.DEFAULT_CONFIG));
    const c1 = api0 ? api0.cleanConfig({ updateEarly: true }) : {};
    const c2 = api0 ? api0.cleanConfig({ updateEarly: 'yes' }, { updateEarly: true }) : {};
    H.ok('保存时：真假收，乱填的保持原值', c1.updateEarly === true && c2.updateEarly === true, [c1.updateEarly, c2.updateEarly]);
    const view = api0 ? await api0.handle('GET', '/api/kit/remote/status', null, u.kit).catch((e) => ({ error: e.message })) : {};
    H.ok('"更新和上报"的接口：带着开关和发版保护的状态', view && view.config && view.config.updateEarly === false && view.update && view.update.hold === '' && 'waitUntil' in view.update && 'flag' in view.update, view && view.config);
    const page = H.read(path.join(SRCV, 'router', 'ui.html')) || '';
    const remoteTab = page.slice(page.indexOf('id="tab-remote"'));
    H.ok('"更新和上报"那一页有"先装新版（尝鲜）"，说了 24 小时、尝鲜组、查不到按没问题', /id="k_updateEarly"/.test(remoteTab) && /先装新版（尝鲜）/.test(remoteTab) && /发布满 24 小时/.test(remoteTab) && /查不到有没有人报.*按没问题算/.test(remoteTab) && /fBool\('updateEarly'/.test(page));
    H.ok('页面顶部有单独说更新状态的一块（不被路由的提示冲掉）', /<div id="updBanner"><\/div>/.test(page) && /function renderUpdBanner/.test(page) && /等尝鲜组先试/.test(page));
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

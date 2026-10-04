'use strict';
/*
 * 自动更新和发布：在假 GitLab 上走一遍"维护的人发布 → 同事的电脑自己发现、自己装上"。
 *   维护的人   用 publish.js 发布（先在自己电脑上装、自检，再推）；走令牌
 *   同事       没有令牌，走 SSH（假的 ssh）；自动装、只提醒、关掉；新版装坏了退回上一版；路由忙的时候等；钩子甩后台进程
 * 全程盯着桌面：不许冒出窗口。推送只推到临时目录里的裸仓库。
 * 用法：node dev/test-update.js [端口，默认 18741]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18741;
const A = '20260901.0900';
const B = '20260902.0900';
const C = '20260903.0900';
const X = '20260904.0900';
const Y = '20260905.0900';
const Z = '20260906.0900';
const W = '20260907.0900';
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
function filesOf(dir, rel, out) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) filesOf(dir, r, out); else if (e.isFile()) out[r] = sha(path.join(dir, r));
  }
  return out;
}
const sameTree = (a, b) => { const x = filesOf(a, '', {}); const y = filesOf(b, '', {}); const kx = Object.keys(x).sort(); const ky = Object.keys(y).sort(); const diff = kx.filter((k) => x[k] !== y[k]).concat(ky.filter((k) => !(k in x))); return { same: kx.length === ky.length && !diff.length, count: kx.length, diff: diff.slice(0, 8) }; };
const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const version = (h) => (H.read(path.join(h.kit, 'VERSION')) || '').trim();
const state = (h, name) => readJson(path.join(h.kit, 'state', (name || 'update') + '.json'));
const setState = (h, patch) => { const f = path.join(h.kit, 'state', 'update.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(Object.assign(state(h), patch))); };
const setCfg = (h, patch) => { const f = path.join(h.kit, 'config.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), patch), null, 2)); };
const bareGit = (gl, args) => H.git(gl.bare, args);

(async () => {
  const watch = await H.watchWindows('upd-win');
  H.ok('盯窗口的脚本起来了', watch.ready);
  const gl = await H.fakeGitlab('upd-gl', PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  const live = Object.assign({}, gl.env, { VIBE_KIT_NO_UPDATE: undefined });
  const http = { VIBE_KIT_NO_UPDATE: undefined, FAKE_GITLAB_DATA: gl.data, FAKE_GITLAB_REPOS: gl.repos };

  // ---------- 地址和几条路 ----------
  H.section('地址、几条路、保存设置');
  {
    const h = H.makeHome('upd-unit');
    const g = require(path.join(h.kit, 'lib', 'gitlab.js'));
    const d = g.settings();
    H.ok('没填过：用默认的仓库地址', d.isDefault && d.repo === g.DEFAULT_REPO && d.parsed.ok && d.parsed.origin === 'http://scm.skytech.io' && d.parsed.projectPath === 'nb-2026/p1/ai-engineering/90-personal/3139/vibe-kit', d.parsed);
    H.ok('SSH 地址从 http 地址推出来', d.ssh.ok && d.ssh.derived && d.ssh.url === 'git@scm.skytech.io:nb-2026/p1/ai-engineering/90-personal/3139/vibe-kit.git', d.ssh);
    H.ok('没有令牌：先 SSH，再本机登录', g.routes(d).map((r) => r.name).join() === 'ssh,login', g.routes(d));
    const p = g.parseRepo('http://10.1.2.3:8080/g/p.git');
    H.ok('带端口的 http 地址：SSH 不带那个端口', p.ok && p.hostname === '10.1.2.3' && g.sshTarget(p, '').url === 'git@10.1.2.3:g/p.git', p);
    const s1 = g.parseSsh('ssh://git@host.x:2222/g/sub/p.git');
    H.ok('ssh:// 带端口的写法', s1.ok && s1.port === 2222 && s1.host === 'host.x' && s1.projectPath === 'g/sub/p', s1);
    const s2 = g.parseSsh('git@host.x:g/p.git');
    H.ok('git@主机:路径 的写法', s2.ok && s2.port === 0 && s2.user === 'git' && s2.projectPath === 'g/p', s2);
    H.ok('不像 SSH 地址的不认', !g.parseSsh('host.x/g/p.git').ok && !g.parseSsh('http://host.x/g/p.git').ok);
    H.ok('仓库地址乱写的不认', !g.parseRepo('scm.skytech.io/a/b').ok && !g.parseRepo('http://scm.skytech.io/').ok && !g.parseRepo('').ok);
    let threw = '';
    try { g.saveSettings({ repo: 'ftp://x/y/z' }); } catch (e) { threw = e.message; }
    H.ok('保存乱写的仓库地址：报错，不存', /http/.test(threw) && !fs.existsSync(g.SETTINGS_FILE), threw);
    threw = '';
    try { g.saveSettings({ token: '令牌 带中文' }); } catch (e) { threw = e.message; }
    H.ok('令牌里有中文、空格：报错，不存', /不该有的字符/.test(threw) && !fs.existsSync(g.SECRETS_FILE), threw);
    const TOKEN = 'glpat-ABCDEFGHIJKLMNOPQRST';
    const pub = g.saveSettings({ repo: 'http://10.1.2.3:8080/g/p.git', branch: 'main', token: TOKEN, sshRepo: 'ssh://git@10.1.2.3:2222/g/p.git' });
    H.ok('给页面的设置里没有完整的令牌', !JSON.stringify(pub).includes(TOKEN) && pub.tokenSet && pub.tokenSource === 'manual' && /^glpat-…/.test(pub.tokenMasked.slice(0, 7)), pub);
    H.ok('令牌只在 secrets.json 里', readJson(g.SECRETS_FILE).gitlabToken === TOKEN && !JSON.stringify(readJson(g.SETTINGS_FILE)).includes(TOKEN));
    H.ok('手填的令牌排最前', g.routes(g.settings()).map((r) => r.name).join() === 'token,ssh,login' && g.routes(g.settings())[1].url === 'ssh://git@10.1.2.3:2222/g/p.git', g.routes(g.settings()));
    fs.writeFileSync(g.SECRETS_FILE, JSON.stringify({ gitlabToken: TOKEN, gitlabTokenSource: 'ssh', gitlabTokenExpires: '2099-01-01' }));
    H.ok('SSH 申请来的令牌：拉仓库还是先走 SSH', g.routes(g.settings()).map((r) => r.name).join() === 'ssh,token,login', g.routes(g.settings()));
    H.ok('同一个项目，http 和 ssh 的记号一样', g.repoKey(g.settings()) === '10.1.2.3/g/p' && g.repoKey({ parsed: g.parseRepo('git@10.1.2.3:g/p.git') }) === '10.1.2.3/g/p', g.repoKey(g.settings()));
    g.saveSettings({ repo: '', sshRepo: '', token: '' });
    H.ok('清空：回到默认地址，令牌删掉', g.settings().isDefault && !g.settings().token && !('gitlabToken' in readJson(g.SECRETS_FILE)), g.publicSettings());
    // 维护套件的电脑 2026-10-01 起写死在代码里，不再是开关；测试用环境变量装成它
    const was = process.env.VIBE_KIT_MAINTAINER_HOSTS;
    const as = (v) => { if (v === undefined) delete process.env.VIBE_KIT_MAINTAINER_HOSTS; else process.env.VIBE_KIT_MAINTAINER_HOSTS = v; return g.isMaintainer({ maintainerHosts: ['203.0.113.77'] }); };
    const mt = [as(os.hostname()), as('203.0.113.77'), as('203.0.113.77,127.0.0.1'), as(undefined)];
    if (was !== undefined) process.env.VIBE_KIT_MAINTAINER_HOSTS = was;
    const realOne = Object.values(os.networkInterfaces()).flat().some((x) => x && x.address === '32.1.4.4');
    H.ok('认维护的那台电脑：写死的那台，配置里写什么都不认', mt[0] && !mt[1] && mt[2] && mt[3] === realOne, mt);
  }

  // ---------- 维护的人发布 ----------
  H.section('维护的人发布（走令牌）');
  const m = H.freshHome('upd-m');
  const MT = 'glpat-maintainer-token-01';
  gl.addToken(MT, 'maintainer');
  fs.mkdirSync(m.kit, { recursive: true });
  fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  const pkgA = H.makePackage('pkg-a', A);
  const pkgB = H.makePackage('pkg-b', B, (d) => fs.appendFileSync(path.join(d, 'kit', 'statusline.js'), '\n// marker-B\n'), '- 修了 #1、#2：测试用\n');
  const publish = (pkg, args, env) => H.node(m, path.join(pkg, 'publish.js'), args || [], { cwd: pkg, timeout: 600000, env: Object.assign({}, http, env || {}) });
  {
    const r = publish(pkgA, ['--no-router', '--no-open']);
    H.ok('发布 A：成功', r.code === 0 && new RegExp('已发布 ' + A.replace('.', '\\.')).test(r.out), r.out + r.err);
    H.ok('先在自己电脑上装了、自检了', /这个安装包的版本：/.test(r.out) && /自检通过/.test(r.out) && version(m) === A, r.out);
    H.ok('说了走的是令牌', /走的是令牌/.test(r.out), r.out);
    H.ok('自己电脑的自动更新关掉了', readJson(path.join(m.kit, 'config.json')).autoUpdate === 'off' && /自动更新已关掉/.test(r.out), r.out);
    H.ok('仓库里有了：分支、标签、版本号', bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === A && bareGit(gl, ['rev-parse', 'refs/tags/v' + A]).code === 0, bareGit(gl, ['show-ref']).out);
    H.ok('提交信息按公司的格式', bareGit(gl, ['log', '-1', '--format=%s', 'main']).out.trim() === 'chore: 发布 vibe-kit ' + A, bareGit(gl, ['log', '-1', '--format=%s', 'main']).out);
    const reqs = gl.requests().filter((x) => x.kind === 'git');
    H.ok('每个请求都带着令牌，GitLab 都认', reqs.length >= 3 && reqs.every((x) => /^oauth2:/.test(x.auth) && x.ok), reqs);
    H.ok('令牌没写进任何输出', !(r.out + r.err).includes(MT));
    // 把仓库克隆出来（故意打开"自动转换换行"），和安装包逐个文件比
    const out = path.join(H.tempDir('upd-clone'), 'c');
    const c = H.git(gl.root, ['-c', 'core.autocrlf=true', 'clone', '-q', gl.bare, out]);
    const t = sameTree(pkgA, out);
    H.ok('仓库里的文件和安装包一字不差（开着换行转换也一样）', c.code === 0 && t.same && t.count > 50, [c.err, t]);
    H.ok('安装包目录没被动过（没有多出 .git）', !fs.existsSync(path.join(pkgA, '.git')));
    const again = publish(pkgA, ['--no-router', '--no-open']);
    H.ok('同一个包再发一次：说不用发，仓库不变', again.code === 0 && /不用再发/.test(again.out) && bareGit(gl, ['rev-list', '--count', 'main']).out.trim() === '1', again.out + again.err);
    const pkgA2 = H.makePackage('pkg-a2', A, (d) => fs.writeFileSync(path.join(d, 'kit', 'tools', 'extra.js'), '// 多了一个文件\n'));
    const bad = publish(pkgA2, ['--no-install']);
    H.ok('同一个版本号、内容不一样：不发', bad.code === 1 && /内容和这个包不一样/.test(bad.out) && bareGit(gl, ['rev-list', '--count', 'main']).out.trim() === '1', bad.out + bad.err);
  }
  {
    // 先建两个议题，B 的更新说明里写了"修了 #1、#2"
    const g = require(path.join(m.kit, 'lib', 'gitlab.js'));
    const api = 'http://127.0.0.1:' + PORT + '/api/v4/projects/77';
    for (const t of ['第一个问题', '第二个问题', '第三个问题']) await g.request('POST', api + '/issues', { token: MT, body: { title: t, description: '测试' } });
    const dry = publish(pkgB, ['--no-install', '--dry-run']);
    H.ok('只看不推：说了会做什么，仓库不变', dry.code === 0 && /只看不推/.test(dry.out) && /#1、#2/.test(dry.out) && bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === A, dry.out + dry.err);
    const r = publish(pkgB, ['--no-router', '--no-open']);
    H.ok('发布 B：成功', r.code === 0 && version(m) === B && bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === B && bareGit(gl, ['rev-list', '--count', 'main']).out.trim() === '2', r.out + r.err);
    H.ok('上一版的标签还在（退回上一版要用）', bareGit(gl, ['rev-parse', 'refs/tags/v' + A]).code === 0 && bareGit(gl, ['rev-parse', 'refs/tags/v' + B]).code === 0);
    const is = gl.issues();
    H.ok('更新说明里写了修了的议题：关掉了，留了一句', is.length === 3 && is[0].state === 'closed' && is[1].state === 'closed' && is[2].state === 'opened' && is[0].notes.some((n) => n.body.includes(B)), [is.map((i) => [i.iid, i.state]), r.out, gl.requests().filter((x) => x.kind === 'api').map((x) => x.method + ' ' + x.url + ' ' + x.ok)]);
    const old = publish(pkgA, ['--no-install']);
    H.ok('拿旧版去发（仓库里的更新）：要确认，没确认就不发', old.code === 2 && /退回/.test(old.out) && bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === B, old.out + old.err);
  }
  {
    // 仓库里放着别的东西
    const other = path.join(gl.repos, 'nb-2026', 'p1', 'other.git');
    fs.mkdirSync(other, { recursive: true });
    H.git(other, ['init', '-q', '--bare', '--initial-branch=main']);
    const w = H.makeRepo(path.join(H.tempDir('upd-other'), 'w'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    H.git(w, ['push', '-q', other, 'HEAD:refs/heads/main']);
    fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: 'http://127.0.0.1:' + PORT + '/nb-2026/p1/other.git' }));
    const r = publish(pkgB, ['--no-install']);
    H.ok('仓库里不是套件的安装包：不发', r.code === 1 && /不是 vibe-kit 的安装包/.test(r.out) && /pom\.xml/.test(r.out) && H.git(other, ['rev-list', '--count', 'main']).out.trim() === '1', r.out + r.err);
    const readme = path.join(gl.repos, 'nb-2026', 'p1', 'fresh.git');
    fs.mkdirSync(readme, { recursive: true });
    H.git(readme, ['init', '-q', '--bare', '--initial-branch=main']);
    const w2 = H.makeRepo(path.join(H.tempDir('upd-readme'), 'w'), { 'README.md': '# vibe-kit\n' });
    H.git(w2, ['push', '-q', readme, 'HEAD:refs/heads/main']);
    fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: 'http://127.0.0.1:' + PORT + '/nb-2026/p1/fresh.git' }));
    const r2 = publish(pkgB, ['--no-install']);
    H.ok('仓库里只有建项目时带的 README：照常发布', r2.code === 0 && /只有建项目时带的说明文件/.test(r2.out) && H.git(readme, ['show', 'main:kit/VERSION']).out.trim() === B && H.git(readme, ['cat-file', '-e', 'main:README.md']).code === 0, r2.out + r2.err);
    fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    const wrong = H.node(m, path.join(pkgB, 'publish.js'), ['--no-install'], { cwd: pkgB, timeout: 120000, env: Object.assign({}, http) });
    H.ok('（地址改回来）', wrong.code === 0 && /不用再发/.test(wrong.out), wrong.out + wrong.err);
    fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: 'glpat-wrong-token-000000', gitlabTokenSource: 'manual' }));
    const t0 = Date.now();
    const denied = publish(H.makePackage('pkg-c0', C), ['--no-install']);
    H.ok('令牌不对、别的路也不通：说清楚，不卡住', denied.code === 1 && /令牌不对|没登录/.test(denied.out) && Date.now() - t0 < 60000, denied.out + denied.err);
    fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  }

  // ---------- 同事的电脑 ----------
  H.section('同事的电脑：没有令牌，走 SSH');
  const u = H.freshHome('upd-u');
  const updater = path.join(u.kit, 'lib', 'updater.js');
  const run = (args, env, timeout) => { const r = H.node(u, updater, args, { cwd: u.root, timeout: timeout || 600000, env: Object.assign({}, live, env || {}) }); return Object.assign(r, { json: json(r.out) }); };
  {
    const inst = H.node(u, path.join(pkgA, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 180000 });
    H.ok('同事装着 A', inst.code === 0 && version(u) === A && /这台电脑还没装过/.test(inst.out), inst.out + inst.err);
    const c0 = readJson(path.join(u.kit, 'config.json'));
    H.ok('新装的默认：自动更新、问题上报都开着', c0.autoUpdate === 'auto' && c0.updateCheckHours === 2 && c0.issueUpload === 'on' && c0.sshToken === 'auto', c0);
    fs.writeFileSync(path.join(u.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    setCfg(u, { reviewMaxRounds: 4 });
    gl.clearLogs();
    const c = run(['check']);
    H.ok('检查：发现仓库里是 B', c.code === 0 && c.json && c.json.remote === B && c.json.installed === A && c.json.differs && c.json.behind && c.json.lastCheckOk, c.out + c.err);
    H.ok('走的是 SSH', c.json && c.json.route === 'ssh' && readJson(path.join(u.kit, 'gitlab.json')).route === 'ssh', c.json);
    const calls = gl.sshCalls();
    H.ok('ssh 不许交互（要输口令、要确认指纹的直接失败）', calls.length >= 2 && calls.every((x) => x.opts.includes('-o BatchMode=yes') && x.opts.includes('-o ConnectTimeout=10')) && calls.some((x) => /^git-upload-pack 'nb-2026\/p1\/vibe-kit\.git'$/.test(x.command)), calls);
    H.ok('没去碰 http（没有令牌就不试）', gl.requests().filter((x) => x.kind === 'git').length === 0, gl.requests());
    const t = sameTree(pkgB, path.join(u.kit, 'update', 'repo'));
    H.ok('暂存处里的文件和安装包一字不差', t.same && t.count > 50, t);
    H.ok('只是下载，还没装', version(u) === A);
    const r = run(['run', '--print']);
    H.ok('后台进程：装上了 B', r.code === 0 && version(u) === B && r.json && r.json.apply && r.json.apply.ok && r.json.apply.from === A, r.out + r.err);
    H.ok('装上的就是 B 的代码', /marker-B/.test(H.read(path.join(u.kit, 'statusline.js')) || ''));
    const st = state(u);
    H.ok('记了一笔', st.lastApplied && st.lastApplied.to === B && st.history.length === 1 && st.history[0].ok, st);
    H.ok('日志里说了', /已更新到/.test(H.read(path.join(u.kit, 'update', 'update.log')) || '') && fs.existsSync(path.join(u.kit, 'update', 'last-install.log')));
    H.ok('自己的开关、仓库地址都还在', readJson(path.join(u.kit, 'config.json')).reviewMaxRounds === 4 && readJson(path.join(u.kit, 'gitlab.json')).repo === gl.url);
    const line = H.node(u, path.join(u.kit, 'statusline.js'), [], { input: '{}' });
    H.ok('状态栏说"已更新到 B"', line.out.includes('已更新到 ' + B), line.out);
    const r2 = run(['run', '--print']);
    H.ok('再跑一次：没到时间不检查，也没什么要装', r2.code === 0 && r2.json && !r2.json.check && !r2.json.apply, r2.out + r2.err);
    H.ok('跑完把锁放了', !fs.existsSync(path.join(u.kit, 'update', 'lock.json')));
  }
  {
    gl.ssh({ mode: 'denied' });
    const t0 = Date.now();
    const c = run(['check']);
    H.ok('SSH 密钥不认、http 也没登录：说清楚两条路各为什么不行', c.json && !c.json.lastCheckOk && /SSH 密钥 GitLab 不认/.test(c.json.lastError) && /没登录/.test(c.json.lastError) && Date.now() - t0 < 60000, c.out + c.err);
    H.ok('已经装着的不受影响', version(u) === B && c.json.remote === B);
    gl.ssh({ mode: 'hostkey' });
    const c2 = run(['check']);
    H.ok('没用 SSH 连过 GitLab：告诉他先手动连一次', c2.json && /还没用 SSH 连过/.test(c2.json.lastError), c2.out);
    gl.behave({ anonymousGit: true });
    const c3 = run(['check']);
    H.ok('SSH 不通、这台电脑上 git 能直接拉：走这条路', c3.json && c3.json.lastCheckOk && c3.json.route === 'login', c3.out);
    gl.behave({ anonymousGit: false });
    gl.ssh({ mode: 'ok' });
    const c4 = run(['check']);
    H.ok('SSH 恢复了：又走回 SSH', c4.json && c4.json.lastCheckOk && c4.json.route === 'ssh', c4.out);
  }

  H.section('只提醒、关掉');
  const pkgC = H.makePackage('pkg-c', C);
  {
    const p = publish(pkgC, ['--no-router', '--no-open']);
    H.ok('发布 C', p.code === 0 && bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === C, p.out + p.err);
    setCfg(u, { autoUpdate: 'notify' });
    setState(u, { lastCheckAt: 0 });
    const r = run(['run', '--print']);
    H.ok('只提醒：查到了 C，不装', r.json && r.json.check && r.json.check.remote === C && !r.json.apply && version(u) === B, r.out + r.err);
    const line = H.node(u, path.join(u.kit, 'statusline.js'), [], { input: '{}' });
    H.ok('状态栏挂着"有新版"', line.out.includes('有新版 ' + C), line.out);
    const k = H.node(u, '-e', ['console.log(require(' + JSON.stringify(updater) + ').kick("测试"))'], { env: Object.assign({}, live) });
    H.ok('只提醒、已经查过：钩子不甩后台进程', k.out.trim() === 'false', k.out + k.err);
    const a = run(['apply']);
    H.ok('在配置页点了更新：装上 C', a.json && a.json.apply && a.json.apply.ok && version(u) === C, a.out + a.err);
    setCfg(u, { autoUpdate: 'off' });
    setState(u, { lastCheckAt: 0, lastKickAt: 0 });
    gl.clearLogs();
    const off = run(['run', '--print']);
    const k2 = H.node(u, '-e', ['console.log(require(' + JSON.stringify(updater) + ').kick("测试"))'], { env: Object.assign({}, live) });
    H.ok('关掉：不检查，钩子也不甩后台进程', off.json && !off.json.check && !off.json.apply && k2.out.trim() === 'false' && gl.sshCalls().length === 0, off.out + k2.out);
    const env = H.node(u, '-e', ['console.log(require(' + JSON.stringify(updater) + ').kick("测试"))'], { env: Object.assign({}, live, { VIBE_KIT_NO_UPDATE: '1' }) });
    H.ok('环境变量 VIBE_KIT_NO_UPDATE=1：不甩后台进程', env.out.trim() === 'false');
    setCfg(u, { autoUpdate: 'auto' });
  }

  H.section('新版装坏了：退回上一版');
  {
    const pkgX = H.makePackage('pkg-x', X, (d) => fs.appendFileSync(path.join(d, 'kit', 'hooks', 'verify-gate.js'), '\nfunction ( {{ 这一版坏了\n'));
    const p = publish(pkgX, ['--no-install']);
    H.ok('（坏的一版发出去了）', p.code === 0 && bareGit(gl, ['show', 'main:kit/VERSION']).out.trim() === X, p.out + p.err);
    const guard = publish(pkgX, ['--no-router', '--no-open']);
    H.ok('正常发布的话：自检不过，发布会停', guard.code === 1 && /自检没过/.test(guard.out), guard.out + guard.err);
    const back = H.node(m, path.join(pkgC, 'install.js'), ['--no-router', '--no-open'], { cwd: m.root, timeout: 180000 });
    H.ok('（维护的电脑装回 C）', back.code === 0 && version(m) === C, back.out);
    setState(u, { lastCheckAt: 0 });
    const r = run(['run', '--print']);
    H.ok('装了 X，自检没过', r.json && r.json.apply && !r.json.apply.ok && /自检没过/.test(r.json.apply.why) && /verify-gate/.test(r.json.apply.why), r.out + r.err);
    H.ok('自动装回了 C', r.json.apply.rolledBack && version(u) === C && !/这一版坏了/.test(H.read(path.join(u.kit, 'hooks', 'verify-gate.js')) || ''), r.json);
    const hook = H.node(u, path.join(u.kit, 'hooks', 'guard-commit.js'), [], { input: JSON.stringify({ session_id: 's1', cwd: u.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } }) });
    H.ok('退回之后钩子照常能跑', hook.code === 0, hook.out + hook.err);
    const st = state(u);
    H.ok('记下这一版装坏过', st.failed && st.failed.version === X && st.failed.times === 1 && st.failed.rolledBack && st.history.some((x) => !x.ok && x.to === X), st);
    const fbDir = path.join(u.kit, 'feedback');
    const recs = fs.existsSync(fbDir) ? fs.readdirSync(fbDir).filter((f) => /\.md$/.test(f)).map((f) => H.read(path.join(fbDir, f))) : [];
    H.ok('记了一条问题反馈', recs.some((t) => t.includes('自动更新到 ' + X + ' 没装成')), recs.map((t) => t.slice(0, 200)));
    const line = H.node(u, path.join(u.kit, 'statusline.js'), [], { input: '{}' });
    H.ok('状态栏说新版没装上', line.out.includes('新版 ' + X + ' 没装上'), line.out);
    setState(u, { lastCheckAt: 0 });
    const r2 = run(['run', '--print']);
    H.ok('再试一次，还是不行', r2.json && r2.json.apply && !r2.json.apply.ok && state(u).failed.times === 2 && version(u) === C, r2.out);
    setState(u, { lastCheckAt: 0 });
    const r3 = run(['run', '--print']);
    H.ok('坏了两次：这一版不再装', r3.json && r3.json.check && !r3.json.apply && version(u) === C && !r3.json.check.behind && r3.json.check.differs, r3.out);
    const pkgY = H.makePackage('pkg-y', Y);
    const p2 = publish(pkgY, ['--no-router', '--no-open']);
    setState(u, { lastCheckAt: 0 });
    const r4 = run(['run', '--print']);
    H.ok('仓库里出了修好的 Y：装上了', p2.code === 0 && r4.json && r4.json.apply && r4.json.apply.ok && version(u) === Y && !state(u).failed, p2.out + r4.out + r4.err);
  }

  H.section('路由在忙就等');
  {
    const busyFile = path.join(H.tempDir('upd-busy'), 'busy.json');
    fs.writeFileSync(busyFile, JSON.stringify({ inflight: 1, idleMs: 0, upMs: 100000 }));
    const bp = PORT + 1;
    const busy = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-busy.js'), String(bp), busyFile], { windowsHide: true, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await H.sleep(150); up = (await H.httpGet('http://127.0.0.1:' + bp + '/__ping')).status === 200; }
    H.ok('（装成路由的进程起来了）', up);
    H.write(path.join(u.kit, 'router', 'service.js'), "'use strict';\nmodule.exports = { portOf: () => " + bp + " };\n");
    const p = publish(H.makePackage('pkg-z', Z), ['--no-router', '--no-open']);
    setState(u, { lastCheckAt: 0 });
    const t0 = Date.now();
    const r = run(['run', '--print', '--wait-ms', '4000', '--quiet-ms', '1000']);
    H.ok('路由有请求在跑：等着，等不到就先不装', p.code === 0 && r.json && r.json.apply && !r.json.apply.ok && /忙/.test(r.json.apply.why) && version(u) === Y && Date.now() - t0 >= 3500, r.out + r.err);
    H.ok('等不到不算装坏', !state(u).failed);
    // 没装成（只是没等到空闲）：问题、使用情况照常上报。以前这种时候一并跳过，全自动挂着跑、请求不断的那段时间一直传不上去
    H.ok('没等到空闲：这一次照常上报，不跳过', r.json && r.json.issues !== undefined && r.json.usage !== undefined, r.out);
    const k = H.node(u, '-e', ['const up = require(' + JSON.stringify(updater) + '); console.log(up.needInstall())'], { env: Object.assign({}, live) });
    H.ok('下载好了、还没装上的，下次接着装', k.out.trim() === 'true', k.out + k.err);
    fs.writeFileSync(busyFile, JSON.stringify({ inflight: 0, idleMs: 60000, upMs: 100000 }));
    const r2 = run(['run', '--print', '--wait-ms', '4000', '--quiet-ms', '1000']);
    H.ok('路由闲下来了：装上 Z', r2.json && r2.json.apply && r2.json.apply.ok && version(u) === Z, r2.out + r2.err);
    H.ok('真装了新版的那一次：上报留给下一次（这个进程里还是旧代码）', r2.json && r2.json.issues === undefined && r2.json.usage === undefined, r2.out);
    try { busy.kill(); } catch (e) { /* 已经退了 */ }
    // 装成路由的那个文件删掉，安装清单里"装了路由"也改回去：不然下一次自动更新会把真的路由装上、启动起来
    fs.rmSync(path.join(u.kit, 'router'), { recursive: true, force: true });
    const mf = path.join(u.kit, 'installed.json');
    fs.writeFileSync(mf, JSON.stringify(Object.assign(readJson(mf), { router: false }), null, 2));
  }

  H.section('同时只跑一个；钩子甩后台进程');
  {
    fs.mkdirSync(path.join(u.kit, 'update'), { recursive: true });
    fs.writeFileSync(path.join(u.kit, 'update', 'lock.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    setState(u, { lastCheckAt: 0 });
    const r = run(['run', '--print']);
    H.ok('已经有一个在跑：这个直接退', r.json && /已经有一个在跑/.test(r.json.skipped || ''), r.out + r.err);
    fs.writeFileSync(path.join(u.kit, 'update', 'lock.json'), JSON.stringify({ pid: 999999, at: Date.now() }));
    const p = publish(H.makePackage('pkg-w', W), ['--no-router', '--no-open']);
    H.ok('（发布 W）', p.code === 0, p.out + p.err);
    setState(u, { lastCheckAt: 0, lastKickAt: 0 });
    const t0 = Date.now();
    const hk = H.node(u, path.join(u.kit, 'hooks', 'session-start.js'), [], { cwd: u.root, env: Object.assign({}, live), input: JSON.stringify({ session_id: 's-kick', cwd: u.root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(u.root, 'none.jsonl') }) });
    const took = Date.now() - t0;
    H.ok('会话开始的钩子：甩出后台进程就返回，不等它', hk.code === 0 && took < 5000 && state(u).lastKickWhy === '会话开始', [took, hk.out.slice(0, 200), hk.err]);
    let done = false;
    for (let i = 0; i < 240 && !done; i++) { await H.sleep(500); done = version(u) === W && !fs.existsSync(path.join(u.kit, 'update', 'lock.json')); }
    H.ok('后台进程自己查到 W、装上了（上一个进程留下的死锁不碍事）', done && state(u).lastApplied && state(u).lastApplied.to === W, [version(u), state(u), H.read(path.join(u.kit, 'update', 'update.log'))]);
    const k = H.node(u, '-e', ['console.log(require(' + JSON.stringify(updater) + ').kick("测试"))'], { env: Object.assign({}, live) });
    H.ok('刚查过：钩子不再甩', k.out.trim() === 'false', k.out + k.err);
    H.ok('没装过路由的电脑，自动更新不会给它装上路由', !fs.existsSync(path.join(u.kit, 'router')) && readJson(path.join(u.kit, 'installed.json')).router === false, readJson(path.join(u.kit, 'installed.json')));
  }

  H.section('用户目录带中文和空格');
  {
    const root = H.tempDir('upd-cn');
    const home = path.join(root, '张 三');
    const c = { root, home, cfg: path.join(home, '.claude'), kit: path.join(home, '.claude', 'vibe-kit') };
    fs.mkdirSync(c.cfg, { recursive: true });
    const pkgOld = H.makePackage('pkg-cn', '20260908.0900');
    const inst = H.node(c, path.join(pkgOld, 'install.js'), ['--no-router', '--no-open'], { cwd: c.root, timeout: 180000 });
    fs.writeFileSync(path.join(c.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    const r = H.node(c, path.join(c.kit, 'lib', 'updater.js'), ['run', '--print'], { cwd: c.root, timeout: 600000, env: Object.assign({}, live) });
    const j = json(r.out);
    H.ok('装着旧版，仓库里是 W：查到了、装上了', inst.code === 0 && j && j.apply && j.apply.ok && version(c) === W, inst.out.slice(-300) + r.out + r.err);
    const hk = H.node(c, path.join(c.kit, 'hooks', 'guard-commit.js'), [], { input: JSON.stringify({ session_id: 's-cn', cwd: c.root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat "' + c.kit.replace(/\\/g, '/') + '/secrets.json"' } }) });
    H.ok('装好的钩子在带中文的路径里照常工作', hk.code === 0 && /令牌/.test(hk.out), hk.out + hk.err);
    H.ok('记了一笔', state(c).lastApplied && state(c).lastApplied.to === W, state(c));
  }

  gl.stop();
  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('自动更新和发布');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

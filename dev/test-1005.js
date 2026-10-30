'use strict';
/*
 * 2026-10-05 这一批：
 *   Claude Code 自带的自动模式   安装器默认把它关掉（settings.json 的 permissions.disableAutoMode）；配置页改成"不管它"就去掉；
 *                               你自己写的、自己把 defaultMode 设成 auto 的不动；卸载只收回自己加的；从上一版升上来也加上
 *   全局约定                     带上了官方那句 "Please remove all mannered prose."
 *   开关                         ccAutoMode 存得进去，乱填的不收
 *   路由                         配置页的接口不收别的网站的页面发来的请求（<img> 这类不带 Origin 的也挡）
 *   使用情况                     模型名字里的内网地址（网址、域名、IPv6）遮掉
 * 用法：node dev/test-1005.js [路由端口，默认 18787] [上一版解压出来的 vibe-kit 目录]   给了目录就多测一遍"从上一版升级"
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18787;
const OLD = process.argv[3] && fs.existsSync(path.join(process.argv[3], 'install.js')) ? process.argv[3] : '';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const install = (h, src, args) => H.node(h, path.join(src, 'install.js'), (args || []).concat(['--no-router', '--no-open']), { cwd: h.root, timeout: 180000 });
const settings = (h) => readJson(path.join(h.cfg, 'settings.json'));
const man = (h) => readJson(path.join(h.kit, 'installed.json'));
const sync = (h) => H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
const perm = (h) => settings(h).permissions || {};
const p2 = (n) => String(n).padStart(2, '0');
const now0 = new Date();
// 今天（本机日期）：使用情况按天数
const today = now0.getFullYear() + '-' + p2(now0.getMonth() + 1) + '-' + p2(now0.getDate());

(async () => {
  const watch = await H.watchWindows('t1005-win');

  // ---------------------------------------------------------------------------------------------
  H.section('安装器：默认关掉 Claude Code 自带的自动模式');
  {
    const h = H.freshHome('t1005-a');
    const r = install(h, H.SRC);
    H.ok('装的时候写了 permissions.disableAutoMode，记成自己加的', r.code === 0 && perm(h).disableAutoMode === 'disable' && man(h).disableAutoMode === 'disable', [r.out.slice(-800), perm(h), man(h).disableAutoMode]);
    H.ok('没有替用户定 defaultMode', perm(h).defaultMode === undefined, perm(h));
    H.ok('说了关掉的是什么、在哪改回来', /Claude Code 自带的"自动模式"已关掉/.test(r.out) && /配置页"保护"/.test(r.out), r.out.slice(-1200));
    // 20261030 起 push 只留钩子这一道确认（用户定的），套件不再装 Bash(git push:*) 的确认规则
    H.ok('套件装的那几条权限还在（push 的确认规则 20261030 起不装了）', (perm(h).allow || []).includes('Bash') && !(perm(h).ask || []).some((x) => /git push/.test(x)), perm(h));
    const again = install(h, H.SRC);
    H.ok('再装一次：不重复说，设置不变', again.code === 0 && !/自动模式"已关掉/.test(again.out) && perm(h).disableAutoMode === 'disable', again.out.slice(-600));
    H.setConfig(h, { ccAutoMode: 'on' });
    const s1 = sync(h);
    H.ok('配置页改成"不管它"：去掉自己写的那一项', s1.code === 0 && perm(h).disableAutoMode === undefined && man(h).disableAutoMode === undefined && /不再关着 Claude Code 自带的"自动模式"/.test(s1.out), [s1.out, perm(h)]);
    const s2 = sync(h);
    H.ok('再同步一次：settings.json 不变', s2.code === 0 && !/settings\.json 里的/.test(s2.out), s2.out);
    H.setConfig(h, { ccAutoMode: 'off' });
    const s3 = sync(h);
    H.ok('改回"关掉"：又加上', perm(h).disableAutoMode === 'disable' && man(h).disableAutoMode === 'disable' && /自动模式"已关掉/.test(s3.out), s3.out);
    const un = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root, timeout: 120000 });
    H.ok('卸载：收回自己加的', un.code === 0 && (settings(h).permissions || {}).disableAutoMode === undefined, [un.out.slice(-400), settings(h)]);
  }
  {
    // 你自己写的不动
    const u = H.freshHome('t1005-b');
    H.write(path.join(u.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Read'] } }, null, 2));
    const r = install(u, H.SRC);
    H.ok('自己写过这一项：不记成套件加的，也不重复说', r.code === 0 && perm(u).disableAutoMode === 'disable' && man(u).disableAutoMode === undefined && !/自动模式"已关掉/.test(r.out), [perm(u), man(u).disableAutoMode]);
    H.setConfig(u, { ccAutoMode: 'on' });
    sync(u);
    H.ok('配置页改成"不管它"：你自己写的还在', perm(u).disableAutoMode === 'disable', perm(u));
    const un = H.node(u, path.join(u.kit, 'install.js'), ['--uninstall'], { cwd: u.root, timeout: 120000 });
    H.ok('卸载后你自己写的还在', un.code === 0 && (settings(u).permissions || {}).disableAutoMode === 'disable' && (settings(u).permissions.allow || []).includes('Read'), settings(u));
  }
  {
    // 你自己选了自动模式：不加，提醒一句
    const a = H.freshHome('t1005-c');
    H.write(path.join(a.cfg, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }, null, 2));
    const r = install(a, H.SRC);
    H.ok('自己把 defaultMode 设成 auto 的：不加，提醒经网关用的代价', r.code === 0 && perm(a).disableAutoMode === undefined && perm(a).defaultMode === 'auto' && /你自己把 permissions\.defaultMode 设成了 auto，没动它/.test(r.out), [r.out.slice(-900), perm(a)]);
    // 别的 defaultMode（跳过权限、接受编辑）不碍事：照样关掉自动模式，defaultMode 不动
    const b = H.freshHome('t1005-d');
    H.write(path.join(b.cfg, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }, null, 2));
    const r2 = install(b, H.SRC);
    H.ok('自己配了别的 defaultMode：不动它，自动模式照样关', r2.code === 0 && perm(b).defaultMode === 'bypassPermissions' && perm(b).disableAutoMode === 'disable', perm(b));
    // 装好之后才把 defaultMode 改成 auto：下次同步把自己加的那一项收回
    const s = settings(b); s.permissions.defaultMode = 'auto'; H.write(path.join(b.cfg, 'settings.json'), JSON.stringify(s, null, 2));
    sync(b);
    H.ok('装好之后你把 defaultMode 改成了 auto：同步时把套件加的那一项收回', perm(b).disableAutoMode === undefined && perm(b).defaultMode === 'auto' && man(b).disableAutoMode === undefined, [perm(b), man(b).disableAutoMode]);
  }
  if (OLD) {
    const g = H.freshHome('t1005-up');
    const oldPkg = path.join(g.root, 'old-pkg');
    H.copyDir(OLD, oldPkg);
    for (const d of ['pixelmatch', 'pngjs', 'playwright', 'playwright-core']) fs.mkdirSync(path.join(oldPkg, 'kit', 'page', 'node_modules', d), { recursive: true });
    const r0 = install(g, oldPkg);
    H.ok('上一版装上了，没有这一项', r0.code === 0 && perm(g).disableAutoMode === undefined, [r0.out.slice(-300), perm(g)]);
    const r = install(g, H.SRC);
    H.ok('从上一版升上来：加上了', r.code === 0 && perm(g).disableAutoMode === 'disable' && man(g).disableAutoMode === 'disable' && readJson(path.join(g.kit, 'config.json')).ccAutoMode === undefined, [r.out.slice(-500), perm(g)]);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('全局约定：官方那句写进去了');
  {
    const h = H.freshHome('t1005-md');
    install(h, H.SRC);
    const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
    H.ok('约定里有 "Please remove all mannered prose."，只出现一次', (md.match(/Please remove all mannered prose\./g) || []).length === 1, md.slice(0, 300));
    // 1008 那一批加了归档、提交要点头和小改动直接改的规矩，涨到 7,000 出头
    H.ok('约定总长没有失控（默认开关不超过 7200 字符）', md.length > 3000 && md.length <= 7200, md.length);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('开关：ccAutoMode');
  {
    const api = require(path.join(H.SRC, 'router', 'kit-api.js'));
    const ses = require(path.join(H.SRC, 'kit', 'lib', 'session.js'));
    H.ok('默认是关掉，两处默认值一样', api.DEFAULT_CONFIG.ccAutoMode === 'off' && ses.DEFAULT_CONFIG.ccAutoMode === 'off' && JSON.stringify(Object.keys(api.DEFAULT_CONFIG).sort()) === JSON.stringify(Object.keys(ses.DEFAULT_CONFIG).sort()));
    H.ok('存得进去', api.cleanConfig({ ccAutoMode: 'on' }).ccAutoMode === 'on' && api.cleanConfig({ ccAutoMode: 'off' }).ccAutoMode === 'off');
    H.ok('乱填的不收', api.cleanConfig({ ccAutoMode: 'auto' }).ccAutoMode === 'off' && api.cleanConfig({ ccAutoMode: true }).ccAutoMode === 'off');
    const ui = H.read(path.join(H.SRC, 'router', 'ui.html')) || '';
    H.ok('配置页"保护"那一节有这个开关', /id="sec-guard"[\s\S]*id="k_ccAutoMode"[\s\S]*最近的开关改动/.test(ui) && /fSel\('ccAutoMode'/.test(ui));
  }

  // 2026-10-17 起开工前不再拉代码；合并推送照样用 lib/pull.js 的 envFor 设 git 的环境，这里只查它
  H.section('合并推送的 git 环境：登不上的远端不拿提示语当口令去试');
  {
    const w = H.makeHome('t1005-ask');
    const gl = await H.fakeGitlab('t1005-gl', PORT + 1);
    H.ok('假 GitLab 起来了', gl.up, gl.log());
    const TK = 'glpat-t1005-token-0000001';
    gl.addToken(TK, 'me');
    // 这几条 git 用假用户目录的环境跑，不读系统的 git 配置：不碰这台电脑真的凭据管理器
    const gitx = (dir, args) => H.run(w, 'git', ['-C', dir].concat(args), { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    const url = gl.url;
    const authUrl = url.replace('http://', 'http://oauth2:' + TK + '@');
    const seed = H.makeRepo(path.join(w.root, 'seed'), { 'a.txt': 'a\n' });
    H.git(seed, ['branch', '-M', 'main']);
    const p0 = gitx(seed, ['push', '-q', authUrl, 'main']);
    fs.mkdirSync(w.work, { recursive: true });
    const hp = path.join(w.work, 'hp');
    const c0 = gitx(w.work, ['clone', '-q', authUrl, hp]);
    gitx(hp, ['remote', 'set-url', 'origin', url]);
    H.ok('（带令牌克隆下来了，远端地址换成不带令牌的）', p0.code === 0 && c0.code === 0 && fs.existsSync(path.join(hp, 'a.txt')), p0.err + c0.err);
    // 老一点的 git 会去问口令：
    // 问口令的程序以前指的是 echo，它把提示语吐回来，git 就拿提示语当用户名、口令发给服务器。所以直接查指到了哪
    const ev = H.node(w, '-e', ['const P = require(' + JSON.stringify(path.join(w.kit, 'lib', 'pull.js')) + '); const e = P.envFor ? P.envFor(' + JSON.stringify(hp) + ', false) : {}; console.log(JSON.stringify([e.GIT_ASKPASS, e.SSH_ASKPASS, e.GIT_TERMINAL_PROMPT]))'], { cwd: w.root });
    H.ok('问口令的程序指到一个不存在的名字，不是 echo', ev.out.trim() === '["vibe-kit-no-askpass","vibe-kit-no-askpass","0"]', ev.out + ev.err);
    gl.stop();
    await H.sleep(300);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('开口："不要停"不算停；让它停的话要整句是停');
  {
    const h = H.makeHome('t1005-flow', null, { autoMode: true });
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'openspec/changes/add-export/tasks.md': '- [ ] 1.1 改 A.java；验：mvn -q compile\n' });
    const tf = H.transcript(path.join(h.root, 'f.jsonl'), [H.tr.user('开始')]);
    const say = (sid, prompt) => { const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    const flow = (sid) => readJson(path.join(h.kit, 'state', sid + '-flow.json'));
    say('f1', '/opsx:apply add-export');
    H.ok('（敲了 /opsx:apply：在流程里）', flow('f1').on === true, flow('f1'));
    for (const p of ['不要停，把剩下的做完', '不用问我，按你的判断做完', '别等我，做完就归档', '别停']) { say('f1', p); H.ok('在流程里说"' + p + '"：还在流程里', flow('f1').on === true, flow('f1')); }
    const ask = H.hook(h, 'guard-ask', { session_id: 'f1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '接着做哪个？', options: [{ label: 'A' }, { label: 'B' }] }] } });
  H.ok('自动阶段允许提问澄清', ask === null);
    for (const p of ['停', '等等，先别提交', '不用了', '别做了', '先停一下，我看看日志', '暂停']) { say('f1', '/opsx:apply add-export'); say('f1', p); H.ok('说"' + p + '"：出了流程', flow('f1').on === false, flow('f1')); }
    say('f1', '继续');
    H.ok('停了之后说"继续"：不能恢复已撤回的 apply 许可', flow('f1').on === false, flow('f1'));
    say('f1', '/opsx:apply add-export');
    H.ok('重新明确 apply 才能恢复实施流程', flow('f1').on === true && flow('f1').stage === 'apply', flow('f1'));
    say('f2', '不要停');
    H.ok('本来就不在流程里的会话说"不要停"：不算进流程', flow('f2').on === false, flow('f2'));
    const r1 = say('f3', '停车场管理加一个导出功能');
    H.ok('"停车场管理加一个导出功能"是需求，不是让它停', flow('f3').on === true && /这像一条需求/.test(r1), [flow('f3'), r1]);
    const r2 = say('f4', '不用写提案，直接在 OrderService 加导出接口');
    H.ok('"不用写提案，直接在…加导出接口"是需求', flow('f4').on === true && /这像一条需求/.test(r2), [flow('f4'), r2]);
    const r3 = say('f5', '好友列表页面加一个搜索功能');
    H.ok('"好友列表页面加一个搜索功能"：开头的"好"不算应一声', /这像一条需求/.test(r3), r3);
    const r4 = say('f6', '好的，谢谢');
    H.ok('"好的，谢谢"还是闲话', !/这像一条需求/.test(r4) && flow('f6').on === false, r4);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('自动压缩窗口最大写到 96 万；用户开口的钩子写明等多久');
  {
    const h = H.freshHome('t1005-ac');
    const r = install(h, H.SRC);
    H.ok('默认（上限 100 万、压缩线 70%，2026-10-17 起）：73.3 万，没变', r.code === 0 && settings(h).autoCompactWindow === 733000, settings(h).autoCompactWindow);
    H.setConfig(h, { autoCompactPercent: 95 });
    sync(h);
    H.ok('压缩线填 95：窗口 96 万（以前是 98.3 万，Claude Code 还没压缩就先报 Prompt is too long）', settings(h).autoCompactWindow === 960000, settings(h).autoCompactWindow);
    H.setConfig(h, { autoCompactPercent: 90, contextLimitTokens: 2000000 });
    sync(h);
    H.ok('上限填 200 万：窗口也是 96 万（以前是 100 万）', settings(h).autoCompactWindow === 960000, settings(h).autoCompactWindow);
    const s = H.node(h, '-e', ['const S = require(' + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + '); const c = { autoCompactPercent: 95, contextLimitTokens: 1000000 }; console.log(JSON.stringify([S.autoCompactWindowOf(c), S.autoCompactAt(c, 1000000)]))'], { cwd: h.root });
    H.ok('钩子、状态栏算的和安装器写的一样', s.out.trim() === '[960000,927000]', s.out + s.err);
    const ups = ((settings(h).hooks || {}).UserPromptSubmit || [])[0];
    H.ok('用户开口那个钩子写明等 300 秒（Claude Code 默认只等 30 秒，合并做到一半不能被它结束）', !!ups && ups.hooks[0].timeout === 300 && /task-anchor\.js/.test(ups.hooks[0].command), ups);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('使用情况：不能放行的拦截也数；模型自己调交接的技能也数');
  {
    const h = H.makeHome('t1005-cnt');
    const proj = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    const base = { session_id: 'c1', cwd: proj, hook_event_name: 'PreToolUse' };
    const blocked = (o) => !!o && (o.decision === 'block' || (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
    const cd = H.hook(h, 'guard-commit', Object.assign({}, base, { tool_name: 'Bash', tool_input: { command: 'cd src && ls -la' } }));
    const kit = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: path.join(h.kit, 'hooks', 'pre-edit.js'), old_string: 'a', new_string: 'b' } }));
    const tok = H.hook(h, 'guard-commit', Object.assign({}, base, { tool_name: 'Bash', tool_input: { command: 'cat ~/.claude/vibe-kit/secrets.json' } }));
    const handover = H.transcript(path.join(h.root, 'handover.jsonl'), [H.tr.user('写一份交接文档')]);
    H.hook(h, 'guard-ask', Object.assign({}, base, { transcript_path: handover, tool_name: 'Skill', tool_input: { skill: 'ttls-handover' } }));
    const n = ((readJson(path.join(h.kit, 'state', 'usage.json')).days || {})[today] || { n: {} }).n;
    const sum = Object.keys(n).filter((k) => /^block\./.test(k)).reduce((a, k) => a + n[k], 0);
    H.ok('串着 cd 的命令、改套件、读令牌：三次都拦下了', blocked(cd) && blocked(kit) && blocked(tok), [cd, kit, tok]);
    H.ok('都数进了"拦下"（以前这三样都是 0）', n['block.cd'] === 1 && n['block.guard-kit'] === 1 && sum === 3, n);
    H.ok('用户要求后调用交接技能：数进"写交接记录"', n['handover.write'] === 1, n);
    const stats = readJson(path.join(h.kit, 'state', 'block-stats.json'));
    H.ok('"拦得最多的规矩"里也有', Object.values(stats).some((x) => x && x.hook === 'cd') && Object.values(stats).some((x) => x && x.hook === 'guard-kit'), Object.values(stats).map((x) => x && x.hook));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('使用情况：模型名字里的内网地址遮掉，遮完重名的加在一起');
  {
    const u = H.makeHome('t1005-us');
    const p2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const day = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
    const by = { 'qwen3.5-coder': { requests: 5 }, 'gpt-4.1-mini': { requests: 1 }, 'kimi-k2.thinking': { requests: 1 }, 'glm-4.5.flash': { requests: 1 }, 'http://10.2.3.4:8000/v1': { requests: 2 }, 'llm.corp.intranet-qwen': { requests: 3 }, 'gw.local': { requests: 4 }, 'fe80::1ff:fe23:4567:890a': { requests: 6 }, '10.1.1.1-a': { requests: 7, input: 10 }, '10.1.1.2-a': { requests: 8, input: 5 } };
    H.write(path.join(u.kit, 'router-data', 'usage-daily.json'), JSON.stringify({ [day]: { requests: 38, byProvider: by } }));
    const r = H.node(u, '-e', ['const U = require(' + JSON.stringify(path.join(u.kit, 'lib', 'usage.js')) + '); const c = U.collect(); console.log(JSON.stringify({ by: c.models && c.models.by, text: U.summary().text }))'], { cwd: u.root });
    let o = {};
    try { o = JSON.parse(r.out.trim().split('\n').pop()); } catch (e) { o = { error: r.out + r.err }; }
    const names = Object.keys(o.by || {});
    H.ok('版本号那样的名字不动', ['qwen3.5-coder', 'gpt-4.1-mini', 'kimi-k2.thinking', 'glm-4.5.flash'].every((n) => names.includes(n)), o.error || names);
    H.ok('网址、域名、IPv6 都换掉了，要传的那一段里也没有', names.includes('内网地址') && names.includes('内网域名') && names.includes('内网IP') && !/10\.2\.3\.4|corp|intranet|gw\.local|fe80/.test(JSON.stringify(o)), o.error || o);
    H.ok('遮完重名的加在一起，不是后一个盖掉前一个', !!o.by && !!o.by['内网IP-a'] && o.by['内网IP-a'].requests === 15 && o.by['内网IP-a'].input === 15 && !!o.by['内网域名'] && o.by['内网域名'].requests === 7, o.error || o.by);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('路由：配置页的接口不收别的网站的页面发来的请求');
  {
    const h = H.makeHome('t1005-rt');
    H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
    H.write(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
    H.write(path.join(h.cfg, 'settings.json'), '{}\n');
    const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    router.stdout.on('data', (d) => { log += d; });
    router.stderr.on('data', (d) => { log += d; });
    process.on('exit', () => { try { router.kill(); } catch (e) { /* 已经退了 */ } });
    const call = (method, url, headers, body) => new Promise((resolve) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, agent: false, headers: Object.assign({}, headers || {}, data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', (e) => resolve({ status: 0, text: String(e) }));
      if (data) req.write(data);
      req.end();
    });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await H.sleep(250); up = (await call('GET', '/version')).status === 200; }
    H.ok('临时路由起来了', up, log);
    if (up) {
      // 别的页面里的 <img src="http://127.0.0.1:端口/api/..."> ：浏览器不带 Origin，带 Sec-Fetch-Site
      const img = (v) => ({ 'sec-fetch-site': v, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });
      const prog = await call('GET', '/api/state');
      const page = await call('GET', '/api/state', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'x-vibe-router': '1' });
      const bar = await call('GET', '/api/state', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
      H.ok('程序发的、配置页自己发的、地址栏里直接打开的：照常', prog.status === 200 && page.status === 200 && bar.status === 200, [prog.status, page.status, bar.status]);
      const x1 = await call('GET', '/api/state', img('cross-site'));
      const x2 = await call('GET', '/api/kit/remote/usage/preview', img('cross-site'));
      H.ok('别的网站的页面里的 <img>（不带 Origin）：不收，不会被它拿来起进程', x1.status === 403 && x2.status === 403, [x1.status, x2.status, x2.text.slice(0, 200)]);
      const x3 = await call('GET', '/api/kit', img('same-site'));
      H.ok('本机别的端口上的页面（same-site）：也不收', x3.status === 403, x3.status);
      const ro = [];
      for (const u of ['/health', '/version', '/busy', '/stats']) ro.push([(await call('GET', u)).status, (await call('GET', u, img('cross-site'))).status]);
      H.ok('/health、/version、/busy、/stats：程序照常问，别的网站的页面不给', ro.every((x) => x[0] === 200 && x[1] === 403), ro);
      const save = await call('POST', '/api/kit/config', { 'x-vibe-router': '1', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:' + PORT }, { reviewMaxRounds: 4 });
      const forged = await call('POST', '/api/kit/config', { 'x-vibe-router': '1', 'sec-fetch-site': 'cross-site' }, { reviewMaxRounds: 5 });
      H.ok('配置页自己保存开关照常；别的网站的页面发的不收', save.status === 200 && forged.status === 403 && readJson(path.join(h.kit, 'config.json')).reviewMaxRounds === 4, [save.status, save.text.slice(0, 200), forged.status]);
    }
    try { router.kill(); } catch (e) { /* 已经退了 */ }
    await H.sleep(600);
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('2026-10-05 这一批');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

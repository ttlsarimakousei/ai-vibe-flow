'use strict';
/*
 * push 只留钩子这一道确认（用户 2026-10-30 定的，docs/feedback-20261030.md 的 B 批）：去掉 Claude Code 的确认框以后，
 * 钩子是唯一一道，各种写法都要认得出来，路由坏着、钩子出错也不能放行。
 *   B1 识别：引号里的 $(…)、反引号、bash -c / sh -c / cmd /c / powershell -Command 里的 git push（审核 P08）；提交信息里写的"git push"不算
 * 用法：node dev/test-push-gate.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const stopped = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && ['deny', 'ask'].includes(o.hookSpecificOutput.permissionDecision)));

H.section('B1 识别：各种写法里的 git push，用户没说推送就不放行');
{
  const h = H.makeHome('tpg-b1', FROM, { autoApply: false });
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'a.txt': 'a\n' });
  let n = 0;
  const run = (tool, command) => H.hook(h, 'guard-commit', { session_id: 's-b1-' + (++n), cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'toolu_b1_' + n, transcript_path: H.transcript(path.join(h.root, 'b1-' + n + '.jsonl'), [H.tr.user('看看状态')]) });
  const must = [
    ['Bash', 'git push'],
    ['Bash', 'git -C sub push origin main'],
    ['Bash', 'echo "r $(git push)"'],
    ['Bash', 'x=`git push`; echo $x'],
    ['Bash', 'echo "r `git push`"'],
    ['Bash', 'bash -c "git push"'],
    ['Bash', "sh -c 'git push origin main'"],
    ['Bash', 'cmd /c "git push"'],
    ['PowerShell', 'git push'],
    ['PowerShell', 'Write-Host "$(git push)"'],
    ['PowerShell', 'powershell -Command "git push"'],
  ];
  for (const [tool, c] of must) { const r = run(tool, c); H.ok(tool + ' 认出 push：' + c, stopped(r), r); }
  const fine = [
    ['Bash', 'git log --oneline --grep "git push"'],
    ['Bash', 'echo "git push 要先确认"'],
    ['Bash', 'git status'],
  ];
  for (const [tool, c] of fine) { const r = run(tool, c); H.ok(tool + ' 不是 push，不拦：' + c, !stopped(r), r); }
}

const { spawn, spawnSync } = require('child_process');
const json = (t) => { try { return JSON.parse(String(t || '').trim() || 'null'); } catch (e) { return null; } };
const freePort = () => Number(String(spawnSync(process.execPath, ['-e', 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'], { encoding: 'utf8', windowsHide: true }).stdout).trim());
/** 起一个后台小服务（单独的进程，测试进程里的 spawnSync 不会卡住它）：answer 为真时 /version 回 200，否则只收连接不回话 */
const server = (port, answer) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['-e', 'require("http").createServer((q,s)=>{' + (answer ? 's.writeHead(200);s.end("vk-test")' : '') + '}).listen(' + port + ',"127.0.0.1",()=>console.log("up"))'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  p.stdout.once('data', () => resolve(p));
});
const stop = (p) => new Promise((r) => { if (!p || p.exitCode !== null) return r(); p.once('exit', r); p.kill(); });

(async () => {
  H.section('B3 guard-push：路由不在就自己查 push；路由在什么都不说；自己出错就问');
  {
    const h = H.makeHome('tpg-b3', FROM);
    const gp = path.join(h.kit, 'hooks', 'guard-push.js');
    H.ok('有 guard-push 钩子', fs.existsSync(gp));
    if (fs.existsSync(gp)) {
      const proj = H.makeRepo(path.join(h.work, 'proj'), { 'a.txt': 'a\n' });
      // 远端是临时目录里的裸仓库（测试里的 push 只推这种），当前分支跟踪它：普通的 git push 就是"推到跟踪的那个分支"
      const bare = path.join(h.root, 'remote.git');
      spawnSync('git', ['init', '-q', '--bare', bare], { windowsHide: true });
      H.git(proj, ['remote', 'add', 'origin', bare]);
      H.git(proj, ['push', '-q', '-u', 'origin', 'HEAD']);
      let n = 0;
      const input = (said) => { n++; return JSON.stringify({ session_id: 's-b3-' + n, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_b3_' + n, transcript_path: H.transcript(path.join(h.root, 'b3-' + n + '.jsonl'), [H.tr.user(said)]) }); };
      const call = (port, inp) => { const r = H.node(h, gp, [String(port)], { input: inp, timeout: 60000 }); return { o: json(r.out), raw: r.out + r.err }; };
      const down = freePort();
      const a = call(down, input('看看状态'));
      H.ok('路由不在、用户没说推送：不放行', stopped(a.o), a.raw);
      const b = call(down, input('推送'));
      H.ok('路由不在、用户说了推送：放行', !stopped(b.o), b.raw);
      const up = freePort();
      const srv = await server(up, true);
      const c = call(up, input('看看状态'));
      H.ok('路由在（/version 回 200）：guard-push 什么都不说，交给路由里的检查', c.o === null && !c.raw.trim(), c.raw);
      await stop(srv);
      const mute = freePort();
      const deaf = await server(mute, false);
      const d = call(mute, input('看看状态'));
      H.ok('端口连得上、路由不答话：当路由不在，自己查', stopped(d.o), d.raw);
      await stop(deaf);
      H.write(path.join(h.kit, 'hooks', 'guard-commit.js'), "module.exports = { handle() { throw new Error('测试：检查出错'); } };\n");
      const e = call(down, input('看看状态'));
      H.ok('自己出错：要确认，不放行（push 是出错放行的例外）', !!e.o && e.o.hookSpecificOutput && e.o.hookSpecificOutput.permissionDecision === 'ask' && /推送的检查这次没跑成/.test(e.o.hookSpecificOutput.permissionDecisionReason || ''), e.raw);
    }
  }

  H.section('B3 路由里的检查没跑成：带 push 的命令要确认，别的照旧放行；都记问题反馈');
  {
    const h = H.makeHome('tpg-host', FROM);
    const child = path.join(h.root, 'host.js');
    H.write(child, [
      "'use strict';",
      'const { createHost } = require(' + JSON.stringify(path.join(h.kit, 'lib', 'hook-host.js')) + ');',
      '(async () => {',
      '  const host = createHost({ kitDir: ' + JSON.stringify(h.kit) + ' });',
      '  const run = (command) => host.run("guard-commit", { session_id: "", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: ' + JSON.stringify(h.work) + ' });',
      '  const push = await run("git push");',
      '  const plain = await run("echo hi");',
      '  if (host.close) host.close();',
      '  console.log(JSON.stringify({ push: push.out, plain: plain.out }));',
      '  setTimeout(() => process.exit(0), 200);',
      '})();',
    ].join('\n'));
    const feedbackCount = () => { try { return fs.readdirSync(path.join(h.kit, 'feedback')).filter((f) => /^F\d{8}-\d+.*\.md$/.test(f)).length; } catch (e) { return 0; } };
    for (const [label, body] of [['钩子抛错', "module.exports = { handle() { throw new Error('测试：检查出错'); } };\n"], ['工作线程崩了', 'module.exports = { handle() { process.exit(1); } };\n']]) {
      H.write(path.join(h.kit, 'hooks', 'guard-commit.js'), body);
      const before = feedbackCount();
      const r = H.node(h, child, [], { timeout: 90000 });
      const o = json(r.out.trim().split(/\r?\n/).pop()) || {};
      H.ok(label + '：带 push 的命令回"要确认"', !!o.push && o.push.hookSpecificOutput && o.push.hookSpecificOutput.permissionDecision === 'ask', r.out + r.err);
      H.ok(label + '：别的命令照旧放行', o.plain === null || o.plain === undefined, r.out);
      H.ok(label + '：记了问题反馈', feedbackCount() > before, feedbackCount());
    }
  }

  H.section('B2 安装：钩子走路由时另登记 guard-push（带 if）、HTTP 钩子写明超时；拒绝和路由起不来用不同的退出码');
  {
    const pkg = (() => { if (!FROM) return H.makePackage('tpg-pkg', '20261030.1300'); const d = path.join(H.tempDir('tpg-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; })();
    const u = H.freshHome('tpg-inst');
    const inst = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
    H.ok('装好了（不带路由）', inst.code === 0, inst.out.slice(-400));
    H.copyDir(path.join(pkg, 'router'), path.join(u.kit, 'router'));
    H.write(path.join(u.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: 18791 }, providers: [], routes: [], default: { provider: '' }, failover: [] }));
    const sync = H.node(u, path.join(u.kit, 'install.js'), ['--sync'], { cwd: u.root, timeout: 120000 });
    const st = json(H.read(path.join(u.cfg, 'settings.json'))) || {};
    const pre = ((st.hooks || {}).PreToolUse || []).flatMap((g) => (g && g.hooks) || []);
    const guards = pre.filter((x) => /guard-push\.js/.test(String(x.command || '')));
    H.ok('登记了 guard-push：命令方式、带端口、if 是 Bash(*push*) 这类', sync.code === 0 && guards.length > 0 && guards.every((x) => x.type === 'command' && /guard-push\.js" 18791$/.test(x.command) && /\*push\*|\*publish\*|\*发布到\*/.test(x.if || '')) && guards.some((x) => x.if === 'Bash(*push*)'), guards);
    H.ok('HTTP 钩子写明了 30 秒超时', pre.filter((x) => x.type === 'http').length > 0 && pre.filter((x) => x.type === 'http').every((x) => x.timeout === 30), pre.filter((x) => x.type === 'http'));
    const hh = H.node(u, '-e', ['console.log(require(' + JSON.stringify(path.join(u.kit, 'lib', 'hook-health.js')) + ').registeredTransport())']);
    H.ok('自检认的登记方式还是 http（guard-push 不算混着两种）', hh.out.trim() === 'http', hh.out + hh.err);
    // settings.json 读不懂：什么都没动，退出码 4（自动更新看到 4 不回退、不算装坏）
    const v = H.freshHome('tpg-refuse');
    H.write(path.join(v.cfg, 'settings.json'), '{ 坏了');
    const bad = H.node(v, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: v.root, timeout: 120000 });
    H.ok('settings.json 读不懂：退出码 4', bad.code === 4, [bad.code, bad.out.slice(-300)]);
    // 路由的端口被一个不是路由的程序占着：文件都装好了、路由起不来，退出码 3（自动更新看到它装回上一版）
    const w = H.freshHome('tpg-busy');
    const busy = freePort();
    H.write(path.join(w.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: busy }, providers: [], routes: [], default: { provider: '' }, failover: [] }));
    const other = await server(busy, false);
    const r3 = H.node(w, path.join(pkg, 'install.js'), ['--no-open'], { cwd: w.root, timeout: 240000 });
    await stop(other);
    H.ok('路由起不来：退出码 3，说了没启动', r3.code === 3 && /模型路由没启动|路由没装好/.test(r3.out), [r3.code, r3.out.slice(-500)]);
  }

  H.section('B2 路由冒烟：新装的路由真发一次请求；转发不带模型名的版本（20261028.1834 那种）过不了');
  {
    const h = H.makeHome('tpg-smoke', FROM);
    H.copyDir(path.join(FROM || H.SRC, 'router'), path.join(h.kit, 'router'));
    const smoke = path.join(h.kit, 'lib', 'router-smoke.js');
    H.ok('有路由冒烟', fs.existsSync(smoke));
    if (fs.existsSync(smoke)) {
      const ok = H.node(h, smoke, [], { timeout: 90000 });
      H.ok('正常的路由：冒烟过了', ok.code === 0 && /^ok$/m.test(ok.out), ok.out + ok.err);
      const rj = path.join(h.kit, 'router', 'router.js');
      const t = H.read(rj);
      H.write(rj, t.replace('let sendBody = body;', "let sendBody = parsed ? Buffer.from(JSON.stringify(Object.assign({}, parsed, { model: undefined })), 'utf8') : body;"));
      const bad = H.node(h, smoke, [], { timeout: 90000 });
      H.ok('转发去掉模型名的路由：冒烟没过，说清楚是没带模型名', t.includes('let sendBody = body;') && bad.code === 1 && /没带模型名/.test(bad.out), bad.out + bad.err);
    }
  }

  H.section('B4 去掉 Claude Code 的 push 确认规则：套件以前加的收回，你自己加的不动');
  {
    const BASE = process.env.VKT_BASE_2041;
    const newPkg = (() => { if (!FROM) return H.makePackage('tpg-b4-new', '20261030.1400'); const d = path.join(H.tempDir('tpg-b4-new'), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; })();
    const frag = json(H.read(path.join(newPkg, 'settings.fragment.json'))) || {};
    H.ok('新包的权限片段里没有 push 的确认规则', !(((frag.permissions || {}).ask) || []).includes('Bash(git push:*)'), frag.permissions);
    if (BASE && fs.existsSync(path.join(BASE, 'install.js'))) {
      const oldPkg = path.join(H.tempDir('tpg-b4-old'), 'vibe-kit');
      H.copyDir(BASE, oldPkg, (n) => n === 'node_modules' || n === '.git');
      H.stubDeps(oldPkg);
      const ask = (u) => (((json(H.read(path.join(u.cfg, 'settings.json'))) || {}).permissions || {}).ask) || [];
      // 1. 2041 装的（套件加了这条，清单里记着）→ 升到新版：收回
      const u = H.freshHome('tpg-b4-up');
      const i1 = H.node(u, path.join(oldPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
      H.ok('2041 装上了，带着 push 的确认规则', i1.code === 0 && ask(u).includes('Bash(git push:*)'), ask(u));
      const i2 = H.node(u, path.join(newPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
      H.ok('升到新版：套件加的 push 确认规则收回了，说清楚了', i2.code === 0 && !ask(u).includes('Bash(git push:*)') && /收回了套件以前加的权限规则：Bash\(git push:\*\)/.test(i2.out), [ask(u), i2.out.slice(-500)]);
      const i3 = H.node(u, path.join(newPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
      H.ok('再装一次：不会又加回来', i3.code === 0 && !ask(u).includes('Bash(git push:*)'), ask(u));
      // 2. 你自己在装套件之前就写着这条：不是套件加的，不动
      const v = H.freshHome('tpg-b4-own');
      H.write(path.join(v.cfg, 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } }, null, 2));
      H.node(v, path.join(oldPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: v.root, timeout: 240000 });
      const j2 = H.node(v, path.join(newPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: v.root, timeout: 240000 });
      H.ok('你自己写的 push 确认规则：升级后照旧留着', j2.code === 0 && ask(v).includes('Bash(git push:*)'), ask(v));
    } else console.log('  （没给 VKT_BASE_2041=<20261028.2041 的 vibe-kit 目录>，跳过从 2041 升级的两项）');
  }

  H.done('push 只留钩子一道（B 批）');
})();

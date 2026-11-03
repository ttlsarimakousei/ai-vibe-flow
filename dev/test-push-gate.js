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
  // 复审 S2：命令替换里再套引号
  const nested = run('Bash', 'echo "$(git -C "sub" push)"');
  H.ok('Bash 认出 push：echo "$(git -C "sub" push)"（替换里再套引号）', stopped(nested), nested);
  // 复审 S1：用户说过推送，可 push 写在命令替换里、拆不出是哪条：查不了是不是强推、推到哪，照样要确认
  const saidRun = (command) => { n++; return H.hook(h, 'guard-commit', { session_id: 's-b1-' + n, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_b1_' + n, transcript_path: H.transcript(path.join(h.root, 'b1-' + n + '.jsonl'), [H.tr.user('推送')]) }); };
  for (const c of ['echo "$(git push --force origin main)"', 'x=`git push --force`; echo $x']) { const r = saidRun(c); H.ok('说了推送，强推藏在命令替换里：要确认，不直接放', stopped(r), [c, r]); }
}

H.section('复审 S3、S7：检查没跑成时，像推送的不放行；人工要确认，全自动拦下');
{
  const h = H.makeHome('tpg-s3', FROM, { autoApply: false });
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  H.ok('有 pushFailOut', typeof S.pushFailOut === 'function');
  if (typeof S.pushFailOut === 'function') {
    const proj = H.makeRepo(path.join(h.work, 'proj'), { 'a.txt': 'a\n' });
    const j = (sid, command) => ({ session_id: sid, cwd: proj, tool_name: 'Bash', tool_input: { command } });
    const m = S.pushFailOut(j('s-m', 'git push'), '测试');
    H.ok('人工：要确认', !!m && m.hookSpecificOutput && m.hookSpecificOutput.permissionDecision === 'ask', m);
    H.ok('不像推送的：照旧放行', S.pushFailOut(j('s-m', 'echo hi'), '测试') === null);
    // 全自动生效：Apply 自动开着、会话在做任务那一段
    H.setConfig(h, { autoApply: true });
    const chg = path.join(proj, 'openspec', 'changes', 'c1');
    H.write(path.join(chg, 'tasks.md'), '- [ ] 1.1 做一件事\n');
    H.inFlow(h, 's-auto', [chg], true, 'apply');
    const a = S.pushFailOut(j('s-auto', 'git push'), '测试');
    H.ok('全自动：拦下、留给用户，不弹确认框等人', !!a && a.decision === 'block' && /全自动模式：推送留给用户/.test(a.reason || ''), a);
  }
  // guard-commit 出错时走 cli 的 onError
  const gc = H.read(path.join(h.kit, 'hooks', 'guard-commit.js')) || '';
  H.ok('命令方式的 guard-commit 出错时回 pushFailOut', /cli\(handle, \{ onError:[^\n]*pushFailOut/.test(gc));
  const probe = path.join(h.root, 'cli-fail.js');
  H.write(probe, "const S = require(" + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + "); S.cli(() => { throw new Error('测试：检查出错'); }, { onError: (j, e) => S.pushFailOut(j, e.message) });\n");
  const r = H.node(h, probe, [], { input: JSON.stringify({ session_id: 's-cli', cwd: h.work, tool_name: 'Bash', tool_input: { command: 'git push' } }) });
  const o = (() => { try { return JSON.parse(String(r.out || '').trim() || 'null'); } catch (e) { return null; } })();
  H.ok('cli 出错：像推送的回 pushFailOut 的结果（人工是要确认，全自动是拦下）', !!o && ((o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'ask') || o.decision === 'block'), r.out + r.err);
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
  H.section('guard-push 是空壳（路由 2026-11-03 删了）：老的 settings 还调它也放行，什么都不说');
  {
    const h = H.makeHome('tpg-shell', FROM);
    const r = H.node(h, path.join(h.kit, 'hooks', 'guard-push.js'), ['15730'], { cwd: h.root, input: JSON.stringify({ session_id: 's', cwd: h.root, tool_name: 'Bash', tool_input: { command: 'git push' } }) });
    H.ok('放行', r.code === 0 && !r.out.trim(), r.out + r.err);
  }

  H.section('B2 安装：钩子全走命令，不登记 guard-push；settings.json 读不懂什么都不动');
  {
    const pkg = (() => { if (!FROM) return H.makePackage('tpg-pkg', '20261030.1300'); const d = path.join(H.tempDir('tpg-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; })();
    const u = H.freshHome('tpg-inst');
    const inst = H.node(u, path.join(pkg, 'install.js'), ['--no-open'], { cwd: u.root, timeout: 240000 });
    H.ok('装好了', inst.code === 0, inst.out.slice(-400));
    const st = json(H.read(path.join(u.cfg, 'settings.json'))) || {};
    const all = Object.values(st.hooks || {}).flat().flatMap((g) => (g && g.hooks) || []);
    H.ok('没有 HTTP 钩子，全走命令', all.length > 0 && all.every((x) => x.type === 'command'), all.filter((x) => x.type !== 'command'));
    H.ok('不登记 guard-push', !all.some((x) => /guard-push\.js/.test(String(x.command || ''))));
    // settings.json 读不懂：什么都没动，退出码 4（自动更新看到 4 不回退、不算装坏）
    const v = H.freshHome('tpg-refuse');
    H.write(path.join(v.cfg, 'settings.json'), '{ 坏了');
    const bad = H.node(v, path.join(pkg, 'install.js'), ['--no-open'], { cwd: v.root, timeout: 120000 });
    H.ok('settings.json 读不懂：退出码 4', bad.code === 4, [bad.code, bad.out.slice(-300)]);
  }

  H.section('B4 去掉 Claude Code 的 push 确认规则：套件以前加的收回，你自己加的不动');
  {
    // 从 20261028.2041 升级的两项：默认用 dev/baseline 里存的那一版（复审 S8：以前要设环境变量，没设就跳过还算过）
    const BASE = process.env.VKT_BASE_2041 || H.baselineDir('20261028.2041');
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
      // 3. 新版收回之后又装回 2041（新版路由起不来、自动更新回退时就是这样）：老版本没有 guard-push，它那条确认规则要能加回来（复审 S6）
      const i4 = H.node(u, path.join(oldPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
      H.ok('装回 2041：它的 push 确认规则加回来了', i4.code === 0 && ask(u).includes('Bash(git push:*)'), ask(u));
    } else H.ok('有 20261028.2041 的旧版目录（dev/baseline 里，或者 VKT_BASE_2041 指过去）', false, BASE);
  }

  H.done('push 只留钩子一道（B 批）');
})();

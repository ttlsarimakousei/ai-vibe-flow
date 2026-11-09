'use strict';
/*
 * 20261109 这批的钩子改动（docs/feedback-20261109.md）：
 *   第 71 条第 1 点：cd 串着 git、cd 到当前目录的命令钩子直接改写（不拦下让模型重发）；需求文档写齐了钩子自己跑 openspec validate --strict
 * 参数：[旧套件目录]（拿上一版跑看多少项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const from = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const fwd = (p) => p.split(path.sep).join('/');
const up = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.updatedInput;
const decision = (o) => o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision;

(async () => {
  H.section('cd 自动改写');
  {
    const h = H.makeHome('fb1109-cd', from, { autoUpdate: 'off' }, { openspec: true });
    const proj = H.makeRepo(path.join(h.root, 'w', 'shell'), { 'a.txt': 'a\n', 'api/pom.xml': '<project/>\n', 'web/package.json': '{}\n' });
    const t = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('看一下改了什么')]);
    const run = (command, said) => H.hook(h, 'guard-commit', { session_id: 'cd1', cwd: proj, transcript_path: said ? H.transcript(path.join(h.root, 't2.jsonl'), [H.tr.user(said)]) : t, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
    let o = run('cd "' + fwd(proj) + '" && git status --short | head -50');
    H.ok('cd 到当前目录：去掉 cd，不拦', up(o) && up(o).command === 'git status --short | head -50' && decision(o) !== 'deny', o);
    o = run('cd api && git diff --stat && echo "---" && git log --oneline -5');
    H.ok('cd 子目录再跑 git：改成 git -C，不拦', up(o) && up(o).command === 'git -C "api" diff --stat && echo "---" && git -C "api" log --oneline -5', o);
    H.ok('改写时别的字段原样带着', up(o) && up(o).description === 'x', o);
    o = run('cd ' + fwd(path.join(proj, 'web')) + ' 2>/dev/null; git status 2>&1 | tail -5');
    H.ok('绝对路径、丢掉输出的重定向也认', up(o) && up(o).command === 'git -C "web" status 2>&1 | tail -5', o);
    o = run('cd api && mvn -q -o compile');
    H.ok('cd 之后跑 mvn：照旧拦下给写法', decision(o) === 'deny' && /mvn -f/.test(H.reasonOf(o)) && !up(o), o);
    o = run('cd api && git log > out.txt');
    H.ok('重定向到文件：照旧拦', decision(o) === 'deny' && !up(o), o);
    o = run('cd api && git log | grep x');
    H.ok('管道给 grep：照旧拦', decision(o) === 'deny' && !up(o), o);
    o = run('cd no-such-dir && git status');
    H.ok('目录不在：照旧拦', decision(o) === 'deny' && !up(o), o);
    o = run('cd api && git push');
    H.ok('改写后的命令照样过别的检查：没说推送的 push 照拦', decision(o) === 'deny' && /推送/.test(H.reasonOf(o)) && !up(o), o);
    o = run('cd api && cat ' + fwd(path.join(h.kit, 'secrets.json')));
    H.ok('读令牌照拦', decision(o) === 'deny' && !up(o), o);
    o = run('cd "' + fwd(proj) + '" && openspec list');
    H.ok('cd 到当前目录再跑 openspec：两种改写都做', up(o) && /openspec\.js"? list/.test(up(o).command) && !/^cd /.test(up(o).command), o);
    const log = H.read(path.join(h.kit, 'state', 'hooks.log')) || '';
    H.ok('钩子流水账记了改写', /改写了串着 cd 的命令/.test(log));
    const usage = JSON.stringify(require(path.join(h.kit, 'lib', 'session.js')).readState('usage'));
    H.ok('使用情况数了改写次数', /rewrite\.cd/.test(usage), usage.slice(0, 300));
  }

  H.section('钩子自己跑 openspec validate');
  {
    const h = H.makeHome('fb1109-val', from, { autoUpdate: 'off' }, { openspec: true });
    const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'openspec/config.yaml': 'schema: spec-driven\n', 'a.txt': 'a\n' });
    const dir = path.join(proj, 'openspec', 'changes', 'c1');
    H.write(path.join(dir, 'proposal.md'), '# 提案\n## Why\n要加年份占位符。\n## What Changes\n- 标题换年份\n');
    H.write(path.join(dir, 'specs', 'x', 'spec.md'), '## ADDED Requirements\n### Requirement: 年份\n系统 SHALL 替换年份。\n');
    const post = (file) => H.hook(h, 'after-tool', { session_id: 'val1', cwd: proj, transcript_path: H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('写需求')]), hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { filePath: file, success: true } });
    let o = post(path.join(dir, 'specs', 'x', 'spec.md'));
    H.ok('tasks 还没写：不跑', !/openspec validate/.test(H.reasonOf(o)), o);
    H.write(path.join(dir, 'tasks.md'), '# 任务\n## 1. 后端\n- [ ] 1.1 改替换逻辑\n');
    o = post(path.join(dir, 'tasks.md'));
    H.ok('写齐了：钩子跑了，规格少场景，说没过、逐条列出来', /钩子跑了 openspec validate c1 --strict，没过/.test(H.reasonOf(o)) && /scenario/i.test(H.reasonOf(o)) && /不用自己跑 validate/.test(H.reasonOf(o)), o);
    H.write(path.join(dir, 'specs', 'x', 'spec.md'), '## ADDED Requirements\n### Requirement: 年份\n系统 SHALL 替换年份。\n#### Scenario: 替换\n- **WHEN** 标题里有占位符\n- **THEN** 换成当年\n');
    o = post(path.join(dir, 'specs', 'x', 'spec.md'));
    H.ok('改好了：说过了，不用再跑', /钩子跑过 openspec validate c1 --strict：过了/.test(H.reasonOf(o)), o);
    o = post(path.join(dir, 'specs', 'x', 'spec.md'));
    H.ok('内容没变：不再跑、不再说', !/openspec validate/.test(H.reasonOf(o)), o);
    o = post(path.join(proj, 'a.txt'));
    H.ok('改的不是需求文档：不跑', !/openspec validate/.test(H.reasonOf(o)), o);
  }
  H.section('#413 "你直接执行代码吧"算开工');
  {
    const h = H.makeHome('fb1109-413', from, { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, autoMode: false, autoApply: false, autoRequirements: false, autoUpdate: 'off' });
    const S = require(path.join(h.kit, 'lib/session'));
    const p = H.makeRepo(path.join(h.work, 'one'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
      'openspec/changes/feat-1/proposal.md': '## Why\n\n要做。\n\n## What Changes\n\n- 改 src/A.java\n',
      'openspec/changes/feat-1/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 做\n\n系统 SHALL 做。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
      'openspec/changes/feat-1/design.md': '## Context\n\n- 读过 src/A.java\n\n## Decisions\n\n- 放在 A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 返回 200 | 人工 | 1 |\n',
      'openspec/changes/feat-1/tasks.md': '- [ ] 1.1 改 src/A.java：加功能\n' });
    let seq = 0;
    const tf = (es) => H.transcript(path.join(h.root, 'a' + (++seq) + '.jsonl'), es);
    const prompt = (sid, text, es) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: tf(es) });
    for (const said of ['不发了，你直接执行代码吧', '直接写代码吧', '直接改代码吧']) {
      const sid = 's413-' + (++seq);
      let es = [H.tr.user('/opsx:explore 做一个导出功能，写需求')];
      prompt(sid, '/opsx:explore 做一个导出功能，写需求', es);
      es = es.concat([H.tr.say('feat-1 的提案、规格、设计、任务都写完了，要先发给同事看看再开工吗？')], [H.tr.user(said)]);
      prompt(sid, said, es);
      H.ok('说"' + said + '"：进了实施阶段', S.flowState({ session_id: sid }).stage === 'apply', S.flowState({ session_id: sid }));
      const o = H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src/A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, transcript_path: tf(es) });
      H.ok('说"' + said + '"：改源码不再拦"没开工"', !/没开工|还没开工|说开工/.test(H.reasonOf(o)), H.reasonOf(o));
    }
  }
  H.section('#429 用户点名的目录说在很久以前');
  {
    const h = H.makeHome('fb1109-429', from, { autoUpdate: 'off', autoOnboard: false });
    const p = H.makeRepo(path.join(h.work, 'shell'), { 'a.txt': 'a\n', 'docs/2026年11月9日漏洞扫描/扫描结果.html': '<html>原始报告</html>\n' });
    const target = path.join(p, 'docs', '2026年11月9日漏洞扫描', '漏洞汇总.md');
    const big = 'x'.repeat(200000);
    const es = [H.tr.user('@docs/2026年11月9日漏洞扫描/ 把里面的扫描结果总结成md文档落到这个文件夹中')];
    for (let i = 0; i < 5; i++) es.push(H.tr.ran('Read', { file_path: path.join(p, 'docs/2026年11月9日漏洞扫描/扫描结果.html') }, big));
    const j = { session_id: 's429', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: '# 漏洞汇总\n' }, transcript_path: H.transcript(path.join(h.root, 't429.jsonl'), es) };
    const o = H.hook(h, 'pre-edit', j);
    H.ok('用户那句话在 600 KB 之前：照样认，不拦产出位置', !/产出位置/.test(H.reasonOf(o)), H.reasonOf(o));
    const j2 = Object.assign({}, j, { session_id: 's429b', transcript_path: H.transcript(path.join(h.root, 't429b.jsonl'), [H.tr.user('总结一下扫描结果')].concat(es.slice(1))) });
    H.ok('用户没说放哪：照旧拦', /产出位置/.test(H.reasonOf(H.hook(h, 'pre-edit', j2))));
  }
  H.section('壳子里两个子项目有同名 change（复审 20261104 第 49、50 条）');
  {
    const h = H.makeHome('fb1109-same', from, { autoUpdate: 'off', autoOnboard: false });
    const shell = path.join(h.work, 'shell'); fs.mkdirSync(shell, { recursive: true });
    H.write(path.join(shell, 'CLAUDE.md'), '# 壳子\n');
    const sub = (name, task, ticked) => {
      const p = H.makeRepo(path.join(shell, name), { 'pom.xml': '<project/>\n' });
      H.write(path.join(p, 'openspec', 'changes', 'add-x', 'proposal.md'), '## Why\n\n要做。\n');
      H.write(path.join(p, 'openspec', 'changes', 'add-x', 'tasks.md'), '- [' + (ticked ? 'x' : ' ') + '] 1.1 改 A.java\n');
      H.write(path.join(p, 'openspec', 'plan.md'), '# 计划\n\n## ' + task + '\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| 后端 | add-x | 进行中 | |\n');
      return p;
    };
    const a = sub('sub-a', '任务A', false); const b = sub('sub-b', '任务B', true);
    const B = require(path.join(h.kit, 'lib', 'big-task.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const dirB = path.join(b, 'openspec', 'changes', 'add-x');
    const t1 = B.ofChange(shell, dirB);
    H.ok('给变更目录：认 sub-b 的大任务', !!t1 && t1.name === '任务B', t1 && t1.name);
    const t2 = B.ofChange(b, 'add-x');
    H.ok('只给名字、在 sub-b 里：认 sub-b 的', !!t2 && t2.name === '任务B', t2 && t2.name);
    H.ok('给的目录不在哪个表里：不认成别的子项目里同名的', B.ofChange(shell, path.join(shell, 'sub-c', 'openspec', 'changes', 'add-x')) === null);
    S.updateState('same1-flow', (s) => { s.on = true; s.current = 'add-x'; s.currentDir = dirB; });
    H.ok('当前 change 记了目录：sub-b 的任务都勾完了，不算还在做（不是 sub-a 那个）', B.currentAlive({ session_id: 'same1', cwd: shell }) === false);
    S.updateState('same2-flow', (s) => { s.on = true; s.current = 'add-x'; s.currentDir = path.join(a, 'openspec', 'changes', 'add-x'); });
    H.ok('记的是 sub-a 的：还在做', B.currentAlive({ session_id: 'same2', cwd: shell }) === true);
  }

  H.section('#421 等：git 的结果跨钩子缓存');
  {
    const cp = require('child_process');
    const h = H.makeHome('fb1109-gitc', from, { autoUpdate: 'off' });
    const repo = H.makeRepo(path.join(h.work, 'r'), { 'a.txt': 'a\n' });
    const plain = path.join(h.work, 'plain'); fs.mkdirSync(plain, { recursive: true });
    // 数这个进程里起了几次 git（workspace.js 载入之前换掉）
    const keep = process.env.VIBE_KIT_NO_GIT_CACHE; delete process.env.VIBE_KIT_NO_GIT_CACHE;
    let n = 0; const orig = cp.execFileSync;
    cp.execFileSync = function (file, args, ...rest) { if (file === 'git') n++; return orig.call(cp, file, args, ...rest); };
    const W = require(path.join(h.kit, 'lib', 'workspace.js'));
    const I = require(path.join(h.kit, 'lib', 'invocation.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const inHook = (fn) => I.run(fn, { budgetMs: 12000 });
    const count = (fn) => { const before = n; fn(); return n - before; };
    if (!W.bumpGitEpoch) H.ok('有跨钩子的缓存', false);
    else {
      H.ok('第一次：现查', count(() => inHook(() => W.git(repo, ['diff', '--name-only', 'HEAD']))) === 1);
      H.ok('另一个钩子、没改过文件：用缓存', count(() => inHook(() => W.git(repo, ['diff', '--name-only', 'HEAD']))) === 0);
      W.bumpGitEpoch();
      H.ok('换了一代（改过文件）：现查', count(() => inHook(() => W.git(repo, ['diff', '--name-only', 'HEAD']))) === 1);
      S.updateState('git-cache', (o) => { for (const k of Object.keys(o)) o[k].at -= 21000; });
      H.ok('过了 20 秒：现查', count(() => inHook(() => W.git(repo, ['diff', '--name-only', 'HEAD']))) === 1);
      H.ok('顶层目录：换代也用缓存', count(() => inHook(() => W.rootOf(repo))) === 1 && (W.bumpGitEpoch(), count(() => inHook(() => W.rootOf(repo)))) === 0);
      H.ok('不是仓库的目录：失败也记着', count(() => inHook(() => W.rootOf(plain))) === 1 && count(() => inHook(() => W.rootOf(plain))) === 0);
      H.git(plain, ['init', '-q']);
      H.ok('后来 git init 了：不再用"不是仓库"的缓存', count(() => inHook(() => W.rootOf(plain))) === 1 && S.normKey(inHook(() => W.rootOf(plain))) === S.normKey(plain));
      H.ok('不在钩子里（review.js 这些工具）：每次现查', count(() => W.git(repo, ['diff', '--name-only', 'HEAD'])) === 1 && count(() => W.git(repo, ['diff', '--name-only', 'HEAD'])) === 1);
    }
    cp.execFileSync = orig;
    if (keep !== undefined) process.env.VIBE_KIT_NO_GIT_CACHE = keep;
    // 钩子入口换代：改文件、跑命令的工具做完换，读文件的不换；同一个工具调用的几个钩子只换一次
    const epoch = () => Number(S.readState('git-epoch').n) || 0;
    const post = (tool, id) => H.node(h, path.join(h.kit, 'hooks', 'after-tool.js'), [], { input: JSON.stringify({ session_id: 'ge', cwd: repo, hook_event_name: 'PostToolUse', tool_name: tool, tool_use_id: id, tool_input: { file_path: path.join(repo, 'a.txt') }, tool_response: { success: true } }), cwd: repo, env: { VIBE_KIT_NO_GIT_CACHE: undefined } });
    const e0 = epoch(); post('Read', 'r1');
    H.ok('Read 做完：不换代', epoch() === e0, [e0, epoch()]);
    post('Edit', 'e1'); const e1 = epoch();
    H.ok('Edit 做完：换代', e1 === e0 + 1, [e0, e1]);
    post('Edit', 'e1');
    H.ok('同一个工具调用的另一个钩子：不再换', epoch() === e1, [e1, epoch()]);
  }
  H.done('20261109 钩子');
})().catch((e) => { H.ok('异常', false, e.stack); H.done('20261109 钩子'); });

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
  H.done('20261109 钩子');
})().catch((e) => { H.ok('异常', false, e.stack); H.done('20261109 钩子'); });

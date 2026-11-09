'use strict';
/*
 * 量一下（#421、#339、#349、#358，2026-11-09）：壳子里几个子仓库时，每个钩子起了多少次 git、各是哪几条。
 * 内网那台（2.1.316）一条 git 要一两秒，钩子 12 秒预算用完，一周钩子出错 909 次。
 * 在假用户目录里搭一个壳子（不是 git 仓库）带 N 个子仓库、一个大任务三个 change、正在做第一个（有开工基线），
 * 在这个进程里直接调钩子（替换 child_process 数 git），不起 Claude Code。
 * 用法：node dev/probes/hook-git-count.js [子仓库数，默认 4] [旧套件目录，比较用]
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('../lib/harness');

const N = Number(process.argv[2]) || 4;
const from = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const calls = [];
let current = '';
const wrap = (name) => { const orig = cp[name]; cp[name] = function (file, args, ...rest) { if (file === 'git' && Array.isArray(args)) { const t0 = Date.now(); try { return orig.call(cp, file, args, ...rest); } finally { const i = args.indexOf('-C'); calls.push({ hook: current, repo: i >= 0 ? path.basename(String(args[i + 1])) : '', args: args.filter((a, k) => !(k === i || k === i + 1) && a !== '--no-optional-locks').slice(0, 3).join(' '), ms: Date.now() - t0 }); } } return orig.call(cp, file, args, ...rest); }; };
for (const n of ['execFileSync', 'spawnSync', 'execFile', 'spawn']) wrap(n);

const h = H.makeHome('git-count', from, { autoUpdate: 'off', autoOnboard: false, lessons: 'off', autoVerify: false, autoSeePage: false });
const shell = path.join(h.work, 'shell'); fs.mkdirSync(shell, { recursive: true });
const repos = [];
for (let i = 0; i < N; i++) {
  const files = { 'pom.xml': '<project/>\n' };
  for (let k = 0; k < 200; k++) files['src/main/java/p' + (k % 10) + '/C' + k + '.java'] = 'class C' + k + ' {}\n';
  repos.push(H.makeRepo(path.join(shell, 'sub' + i), files));
}
const ch = (name) => path.join(shell, 'openspec', 'changes', name);
for (const name of ['a-first', 'a-second', 'a-third']) {
  H.write(path.join(ch(name), 'proposal.md'), '## Why\n\n要做。\n\n## What Changes\n\n- 改 sub0/src/main/java/p0/C0.java\n');
  H.write(path.join(ch(name), 'specs', 'x', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 做\n\n系统 SHALL 做。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n');
  H.write(path.join(ch(name), 'design.md'), '## Context\n\n- 读过 sub0/src/main/java/p0/C0.java\n\n## Decisions\n\n- 放这里\n');
  H.write(path.join(ch(name), 'tasks.md'), '## 1. 后端\n\n- [ ] 1.1 改 sub0/src/main/java/p0/C0.java（验：mvn test）\n- [ ] 1.2 改 sub1/src/main/java/p1/C1.java（验：mvn test）\n');
}
H.write(path.join(shell, 'openspec', 'plan.md'), '# 计划\n\n## 大任务：做一件事\n\n探索记录：（无）\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| 后端 | a-first | 进行中 | |\n| 后端 | a-second | 未开始 | |\n| 后端 | a-third | 未开始 | |\n');
const S = require(path.join(h.kit, 'lib', 'session.js'));
S.updateState('work-baselines', (o) => { o[S.normKey(ch('a-first'))] = { at: Date.now() - 60000, born: S.changeBorn(ch('a-first')), session: 'gc', repos: repos.map((r) => ({ root: r, ref: H.git(r, ['rev-parse', 'HEAD']).out.trim(), dirtyFiles: [] })) }; });
// 第一个 change 任务全勾完（等审整个 change），第二个也开工了：钩子要算 change 的指纹
for (const name of ['a-first', 'a-second']) {
  if (name === 'a-first') H.write(path.join(ch(name), 'tasks.md'), '## 1. 后端\n\n- [x] 1.1 改 sub0/src/main/java/p0/C0.java（验：mvn test）\n- [x] 1.2 改 sub1/src/main/java/p1/C1.java（验：mvn test）\n');
  S.updateState('work-baselines', (o) => { o[S.normKey(ch(name))] = { at: Date.now() - 60000, born: S.changeBorn(ch(name)), session: 'gc', repos: repos.map((r) => ({ root: r, ref: H.git(r, ['rev-parse', 'HEAD']).out.trim(), dirtyFiles: [] })) }; });
}
for (const r of repos) fs.appendFileSync(path.join(r, 'src/main/java/p1/C1.java'), '// 改了\n');
H.inFlow(h, 'gc', [ch('a-first'), ch('a-second')], true, 'apply');
// 内网那台开着 /vk-auto
if (!process.env.MANUAL) S.setSessionAuto({ session_id: 'gc' }, true, '测试');
fs.appendFileSync(path.join(repos[0], 'src/main/java/p0/C0.java'), '// 改了\n');
const tpath = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('开工 a-first'), H.tr.say('好'), H.tr.ran('Edit', { file_path: path.join(repos[0], 'src/main/java/p0/C0.java') }, 'ok')]);
const base = { session_id: 'gc', cwd: shell, transcript_path: tpath };
const I = require(path.join(h.kit, 'lib', 'invocation.js'));
const runs = [
  ['task-anchor（用户开口）', 'task-anchor', Object.assign({}, base, { hook_event_name: 'UserPromptSubmit', prompt: '接着做' })],
  ['guard-commit（git status）', 'guard-commit', Object.assign({}, base, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git -C sub0 status --short' } })],
  ['pre-edit（改代码）', 'pre-edit', Object.assign({}, base, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repos[1], 'src/main/java/p1/C1.java'), old_string: 'class C1 {}', new_string: 'class C1 { int x; }' } })],
  ['after-tool（改完代码）', 'after-tool', Object.assign({}, base, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repos[1], 'src/main/java/p1/C1.java') }, tool_response: { filePath: path.join(repos[1], 'src/main/java/p1/C1.java'), success: true } })],
  ['verify-gate（收工）', 'verify-gate', Object.assign({}, base, { hook_event_name: 'Stop', stop_hook_active: false })],
];
(async () => {
  // 再跑一遍（中间没改文件）：看跨钩子的缓存省了多少（VIBE_KIT_NO_GIT_CACHE=1 时不缓存，比较用）
  for (const [label, name, j] of runs.concat(runs.map(([l, n, x]) => [l + '·第二遍', n, x]))) {
    current = label;
    const mod = require(path.join(h.kit, 'hooks', name + '.js'));
    const t0 = Date.now(); let err = '';
    let out = null; try { out = await I.run(() => mod.handle(j), { budgetMs: 120000 }); } catch (e) { err = e.message; }
    if (process.env.SHOW) console.log('  输出：' + JSON.stringify(out).slice(0, 300));
    const mine = calls.filter((c) => c.hook === label);
    const by = {}; for (const c of mine) { const k = c.args.split(' ')[0]; by[k] = (by[k] || 0) + 1; }
    console.log(label + '：git ' + mine.length + ' 次（' + Object.entries(by).map(([k, v]) => k + ' ' + v).join('，') + '），共 ' + (Date.now() - t0) + ' 毫秒' + (err ? '，出错 ' + err.slice(0, 100) : ''));
    const dup = {}; for (const c of mine) { const k = c.repo + ' ' + c.args; dup[k] = (dup[k] || 0) + 1; }
    const rep = Object.entries(dup).filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (rep.length) console.log('  重复的：' + rep.map(([k, v]) => k + ' ×' + v).join('；'));
  }
  H.cleanup();
})();

'use strict';
/*
 * 问题表第 90 条（2026-11-13，docs/feedback-20261113-2.md）：自动实施时提问框、权限确认框发出后没人回，等够时间替用户收掉（hooks/ask-timeout.js）。
 *   提问框：到点按"不允许"收掉，带一句话让模型自己定，记进全自动报告"它想问你、没问成的"
 *   别的确认框：到点按"允许"，记进"放行的检查"；像推送、发布的按"不允许"，记进"留给你做的"
 *   框有了结果、用户另说了话：马上退出，什么都不说；没开自动、等待设成 0、ExitPlanMode：马上退出，什么都不说
 *   安装器登记 PermissionRequest，写明的超时比能配的最长等待长；配置页有这个开关
 * 查库、redis 少问（第 91 条）在 test-dbcrud.js、test-redis.js 里。
 * 框真的显示以后钩子能不能收掉，是 dev/probes/cc-ask-timeout.js 在真的 Claude Code 上测的，这里不起 Claude Code。
 * 用法：node dev/test-feedback1113-2.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCDIR = FROM || H.SRC;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off' };
const WAIT = 1500;

(async () => {
  const watch = await H.watchWindows('f11132-win');
  const h = H.makeHome('f11132', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  const p = H.makeRepo(path.join(h.work, 'p'), {
    'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
    'openspec/changes/c1/proposal.md': '## Why\n\n要导出。\n\n## What Changes\n\n- 改 src/A.java\n',
    'openspec/changes/c1/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
    'openspec/changes/c1/design.md': '## Context\n\n- 读过 src/A.java\n',
    'openspec/changes/c1/tasks.md': '## 1. 导出\n\n- [x] 1.1 改 src/A.java：加导出\n- [ ] 1.2 改 src/A.java：加校验\n',
  });
  const d = path.join(p, 'openspec', 'changes', 'c1');
  const sid = 's-ask'; const j = { session_id: sid, cwd: p };
  H.inFlow(h, sid, [d], true, 'apply'); A.grant(j, 'c1', '');
  S.setSessionAuto(j, true, '提问框选了自动');
  let seq = 0;
  const tp = (entries) => H.transcript(path.join(h.root, 'tr-' + (++seq) + '.jsonl'), entries);
  const hookFile = path.join(h.kit, 'hooks', 'ask-timeout.js');
  /** 起钩子进程，等它退出。env 给了就再加这些环境变量；onStart(子进程) 起来之后调 */
  const run = (input, env, onStart) => new Promise((resolve) => {
    const t0 = Date.now();
    if (!fs.existsSync(hookFile)) return resolve({ out: null, ms: 0, missing: true });
    const c = spawn(process.execPath, [hookFile], { cwd: p, env: H.envFor(h, Object.assign({ VIBE_KIT_ASK_TIMEOUT_MS: String(WAIT), VIBE_KIT_ASK_POLL_MS: '150' }, env || {})), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (x) => { out += x; });
    c.stderr.on('data', (x) => { err += x; });
    const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 已经退了 */ } }, 30000);
    c.on('close', () => { clearTimeout(timer); let o = null; try { o = out.trim() ? JSON.parse(out) : null; } catch (e) { o = { raw: out }; } resolve({ out: o, ms: Date.now() - t0, err }); });
    c.stdin.end(JSON.stringify(Object.assign({ session_id: sid, cwd: p, hook_event_name: 'PermissionRequest', permission_mode: 'default' }, input)));
    if (onStart) onStart(c);
  });
  const decision = (r) => (r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.decision) || null;
  const R = require(path.join(h.kit, 'lib', 'report.js'));
  const items = (kind) => R.stateOf(j).items.filter((x) => x.kind === kind);
  const Q = { questions: [{ question: '导出按钮放在哪', header: '位置', multiSelect: false, options: [{ label: '工具栏', description: '' }, { label: '表格上方', description: '' }] }] };

  H.section('自动实施在生效');
  H.ok('夹具：这个会话的自动实施在生效', S.readConfigFor(j).autoMode === true, S.readConfigFor(j));

  H.section('提问框没人答：到点收掉，让模型自己定，记进报告');
  const id1 = 'toolu_ask1';
  const r1 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, id1)]) });
  const d1 = decision(r1) || {};
  H.ok('新钩子在（ask-timeout.js）', !r1.missing);
  H.ok('到点按不允许收掉（不替用户选选项）', d1.behavior === 'deny' && !d1.updatedInput, r1.out);
  H.ok('说了让它自己定、记进 revisions.md、要用户点头的不能定', /自己定/.test(d1.message || '') && /revisions\.md/.test(d1.message || '') && /推送、归档/.test(d1.message || '') && /不要再问一遍/.test(d1.message || ''), d1.message);
  H.ok('等够了才收（不早于设的时间）', r1.ms >= WAIT, r1.ms);
  H.ok('记进全自动报告"它想问你、没问成的"', items('ask').some((x) => /导出按钮放在哪/.test(x.title) && /工具栏 \/ 表格上方/.test(x.detail) && /没人答/.test(x.detail)), R.stateOf(j).items);

  H.section('权限确认框没人点：到点按允许；推送、发布按不允许');
  const cmd = { command: 'mvn -q -o test', description: '跑测试' };
  const r2 = await run({ tool_name: 'Bash', tool_input: cmd, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', cmd, 'toolu_b1')]) });
  H.ok('普通命令：到点按允许', (decision(r2) || {}).behavior === 'allow', r2.out);
  H.ok('记进"放行的检查"', items('bypass').some((x) => /权限确认框没人点/.test(x.title) && /mvn -q -o test/.test(x.title)), R.stateOf(j).items);
  const push = { command: 'git push origin main', description: '推送' };
  const r3 = await run({ tool_name: 'Bash', tool_input: push, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', push, 'toolu_b2')]) });
  H.ok('推送：到点按不允许，留给用户', (decision(r3) || {}).behavior === 'deny' && /留给用户/.test((decision(r3) || {}).message || ''), r3.out);
  H.ok('推送记进"留给你做的"', items('hand').some((x) => /git push origin main/.test(x.title)), R.stateOf(j).items);
  const dbc = { command: 'python "$HOME/.claude/skills/vk-db-crud/scripts/db.py" --conn dev exec --sql "DELETE FROM T" --ack DELETE-T-rows-unknown-1234abcd', description: '删' };
  const rdb = await run({ tool_name: 'Bash', tool_input: dbc, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Bash', dbc, 'toolu_db1')]) });
  H.ok('查库、redis 的命令（复审 R1）：到点按不允许，不替用户放行', (decision(rdb) || {}).behavior === 'deny' && /不替用户放行/.test((decision(rdb) || {}).message || ''), rdb.out);
  H.ok('查库的命令记进"留给你做的"', items('hand').some((x) => /查库、redis 的命令/.test(x.title) && /db\.py/.test(x.title)), R.stateOf(j).items);
  const ed = { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' };
  const r4 = await run({ tool_name: 'Edit', tool_input: ed, transcript_path: tp([H.tr.user('做导出'), H.tr.call('Edit', ed, 'toolu_e1')]) });
  H.ok('改文件的确认框：到点按允许', (decision(r4) || {}).behavior === 'allow', r4.out);

  H.section('框有了结果、用户另说了话：马上退出，什么都不说');
  const r5 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.ran('AskUserQuestion', Q, 'Your questions have been answered: "导出按钮放在哪"="工具栏".')]) });
  H.ok('用户已经答了：不出决定、没等到点', !r5.out && r5.ms < WAIT, [r5.out, r5.ms]);
  const r6 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, 'toolu_ask6'), H.tr.user('先别问了，放工具栏')]) });
  H.ok('用户没点框、另说了一句：不出决定', !r6.out && r6.ms < WAIT, [r6.out, r6.ms]);
  // 钩子起来的时候框还没结果，等的中途用户答了
  const trLate = tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, 'toolu_ask7')]);
  const r7 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: trLate }, { VIBE_KIT_ASK_TIMEOUT_MS: '6000' }, () => setTimeout(() => fs.appendFileSync(trLate, JSON.stringify(H.tr.result('toolu_ask7', 'Your questions have been answered: "导出按钮放在哪"="工具栏".')) + '\n'), 600));
  H.ok('等的中途用户答了：几百毫秒内退出，不留一个等到点的进程', !r7.out && r7.ms < 4000, [r7.out, r7.ms]);
  // 同一个问题前面问过一次、有结果，这一次还没结果：认最后一次
  const r8 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.ran('AskUserQuestion', Q, '答过'), H.tr.say('再问一次'), H.tr.call('AskUserQuestion', Q, 'toolu_ask8')]) });
  H.ok('同一个问题前面答过、这一次没答：照样到点收掉', (decision(r8) || {}).behavior === 'deny', r8.out);
  // 会话记录里找不到这次调用（复审 R3）
  const trNone = tp([H.tr.user('做导出'), H.tr.say('我先看看')]);
  const r8b = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: trNone }, { VIBE_KIT_ASK_TIMEOUT_MS: '6000' }, () => setTimeout(() => fs.appendFileSync(trNone, JSON.stringify(Object.assign(H.tr.user('不用问了'), { timestamp: new Date().toISOString() })) + '\n'), 1500));
  H.ok('找不到这次调用、用户另说了一句：退出，不出决定', !r8b.out && r8b.ms < 5000, [r8b.out, r8b.ms]);
  const before = items('ask').length;
  const r8c = await run({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '找不到的那一问', options: [{ label: 'A' }] }] }, transcript_path: tp([H.tr.user('做导出'), H.tr.say('我先看看')]) });
  H.ok('找不到这次调用、也没有新的话：到点照样收掉，报告里写明可能已经处理过', (decision(r8c) || {}).behavior === 'deny' && items('ask').length === before + 1 && /会话记录里没找到这一问/.test(items('ask').slice(-1)[0].detail), [r8c.out, items('ask').slice(-1)]);

  H.section('不管的：没开自动、等待设成 0、ExitPlanMode');
  const r9 = await run({ tool_name: 'ExitPlanMode', tool_input: { plan: 'x' }, transcript_path: tp([H.tr.user('做导出'), H.tr.call('ExitPlanMode', { plan: 'x' }, 'toolu_p1')]) });
  H.ok('ExitPlanMode：不管', !r9.out && r9.ms < WAIT, [r9.out, r9.ms]);
  H.setConfig(h, { askTimeoutMin: 0 });
  const r10 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, 'toolu_ask10')]) }, { VIBE_KIT_ASK_TIMEOUT_MS: '' });
  H.ok('配置页填了 0（一直等）：不管', !r10.out && r10.ms < WAIT, [r10.out, r10.ms]);
  H.setConfig(h, { askTimeoutMin: 10 });
  S.setSessionAuto(j, false, '测试：人工');
  const r11 = await run({ tool_name: 'AskUserQuestion', tool_input: Q, transcript_path: tp([H.tr.user('做导出'), H.tr.call('AskUserQuestion', Q, 'toolu_ask11')]) });
  H.ok('没开自动：不管，框一直等人', !r11.out && r11.ms < WAIT, [r11.out, r11.ms]);
  S.setSessionAuto(j, true, '提问框选了自动');
  let T = null;
  try { T = require(hookFile); } catch (e) { T = null; }
  H.ok('等多久按配置算：10 分钟是 60 万毫秒，0 和没填是不等', !!T && T.waitOf({ askTimeoutMin: 10 }) === 600000 && T.waitOf({ askTimeoutMin: 0 }) === 0 && T.waitOf({}) === 0, T && [T.waitOf({ askTimeoutMin: 10 }), T.waitOf({ askTimeoutMin: 0 })]);

  H.section('配置：默认 10 分钟，0 是一直等，配置页有这一项');
  const F = require(path.join(h.kit, 'lib', 'config-fields.js'));
  const f = F.FIELDS.find((x) => x.name === 'askTimeoutMin');
  H.ok('字段表里有 askTimeoutMin，默认 10，0 到 120', !!f && f.def === 10 && f.zero === true && f.max === 120 && f.page === 'kit', f);
  const ui = H.read(path.join(SRCDIR, 'kit', 'ui', 'ui.html')) || '';
  H.ok('配置页有这一项，说明写了只在自动实施时、要点头的不算', /id="k_askTimeoutMin"/.test(ui) && /fNum\('askTimeoutMin'/.test(ui) && /推送、归档、发布/.test(ui), '');

  H.section('安装器登记 PermissionRequest');
  const fh = H.freshHome('f11132-inst');
  const inst = H.node(fh, path.join(SRCDIR, 'install.js'), ['--no-router', '--no-open'], { cwd: fh.root, timeout: 180000 });
  let st = {};
  try { st = JSON.parse(H.read(path.join(fh.cfg, 'settings.json')) || '{}'); } catch (e) { st = {}; }
  const pr = ((st.hooks || {}).PermissionRequest || []).flatMap((g) => g.hooks || []).find((x) => /ask-timeout\.js/.test(String(x.command || '')));
  H.ok('装完 settings.json 里登记了 ask-timeout，超时比最长等待（120 分钟）长', inst.code === 0 && !!pr && Number(pr.timeout) > 120 * 60, [inst.code, (st.hooks || {}).PermissionRequest, inst.out.slice(-400)]);
  const un = H.node(fh, path.join(fh.kit, 'install.js'), ['--uninstall'], { cwd: fh.root, timeout: 180000 });
  let st2 = {};
  try { st2 = JSON.parse(H.read(path.join(fh.cfg, 'settings.json')) || '{}'); } catch (e) { st2 = {}; }
  H.ok('卸载收回了这个钩子', un.code === 0 && !JSON.stringify(st2.hooks || {}).includes('ask-timeout'), [un.code, st2.hooks, un.out.slice(-300)]);

  const wins = await watch.stop();
  H.ok('桌面上没有冒出窗口', !wins.length, wins);
  H.done('问题表第 90 条：询问没人回替用户收掉');
})().catch((e) => { H.ok('出错', false, e.stack); H.done('问题表第 90 条'); });

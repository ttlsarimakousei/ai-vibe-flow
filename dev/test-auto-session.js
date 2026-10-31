'use strict';
/*
 * 问题表第 24—28 条（2026-10-31，docs/feedback-20261030.md"第 24—28 条"）：
 *   28 自动模式按会话开：/vk-auto 开、/vk-auto off 关，只对这个会话有效
 *   24 会话开着自动时：任务做完等验收照样算自动；用户改了需求按改后的重定范围，不退回人工
 *   25 提交方式"自动"：任务都勾完以后，改完用户报的问题也算做完一件事，能提交
 *   26 审查轮数在问题处理完以后不清零；到上限的点不挡提交、不挡往下走
 *   27 "服务都起着吗，我要看看系统"算让它起服务
 * 用法：node dev/test-auto-session.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
const textOf = (r) => (typeof r === 'string' ? r : JSON.stringify(r || ''));
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', autoOnboard: false };
const CHANGE = (ticked) => ({
  'openspec/changes/feat-028/proposal.md': '## Why\n\n要导出。\n\n## What Changes\n\n- 改 src/A.java\n',
  'openspec/changes/feat-028/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n',
  'openspec/changes/feat-028/design.md': '## Context\n\n- 读过 src/A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 200 | 人工 | 1 |\n',
  'openspec/changes/feat-028/tasks.md': '## 1. 导出\n\n- [' + (ticked ? 'x' : ' ') + '] 1.1 改 src/A.java：加导出\n',
});

H.section('第 27 条："服务都起着吗，我要看看系统"算让它起服务');
{
  const h = H.makeHome('tas-27', FROM, QUIET);
  const I = require(path.join(h.kit, 'lib', 'intent.js'));
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  for (const t of ['服务都起着吗我要看看系统', '服务起着吗？我要看看系统', '我想看一下页面', '给我打开系统']) H.ok('"' + t + '"：算让它起服务', I.explicit(t, 'test'), t);
  for (const t of ['服务起了吗', '我要看看系统设计文档', '别起服务，我要看看系统设计文档', '你看看系统哪里慢']) H.ok('"' + t + '"：不算', !I.explicit(t, 'test'), t);
  const es = S.tailEntries(H.transcript(path.join(h.root, 't27.jsonl'), [H.tr.user('服务都起着吗，我要看看系统')]), 3000000);
  H.ok('会话记录里这句话：自测许可有效（起服务不用再问）', S.userSaid(es, 'test').ok);
}

H.section('第 28 条：自动模式按会话开，/vk-auto 开、/vk-auto off 关，只对这个会话有效');
{
  const h = H.makeHome('tas-28', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const said = (t) => (S.autoSwitchSaid ? S.autoSwitchSaid(t) : 'none');
  const sa = (sid) => (S.sessionAuto ? S.sessionAuto({ session_id: sid }) : null);
  for (const [t, want] of [['/vk-auto', 'on'], ['/vk-auto 做一个订单导出', 'on'], ['/vk-auto off', 'off'], ['这个需求自动做', 'on'], ['开自动', 'on'], ['别自动了', 'off'], ['关掉自动模式', 'off'], ['能自动做吗？', ''], ['自动提交打开', ''], ['这个能不能自动完成', '']]) H.ok('"' + t + '" → ' + (want || '不算'), said(t) === want, said(t));
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE(false)));
  let n = 0;
  const say = (sid, prompt) => { n++; return H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'a28-' + n + '.jsonl'), [H.tr.user(prompt)]) }); };
  const r1 = say('s-on', '/vk-auto');
  H.ok('敲 /vk-auto：这个会话开了，模型拿到怎么做', sa('s-on') === true && /这个会话的自动模式开了/.test(textOf(r1)) && /不自己加需求/.test(textOf(r1)), textOf(r1).slice(0, 400));
  H.ok('这个会话按开着算（需求、实施两段都开）', S.readConfigFor({ session_id: 's-on', cwd: p }).autoApply === true && S.readConfigFor({ session_id: 's-on', cwd: p }).autoRequirements === true);
  say('s-off', '改一下 A');
  H.ok('别的会话不受影响', S.readConfigFor({ session_id: 's-off', cwd: p }).autoApply === false);
  const sl = (sid) => H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: sid, cwd: p, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: p }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: p }).out.replace(/\x1b\[[0-9;]*m/g, '');
  H.ok('状态栏：开着的会话写"自动 开（本会话"，别的会话写"自动 关（/vk-auto 开）"', /自动 开（本会话/.test(sl('s-on')) && /自动 关（\/vk-auto 开）/.test(sl('s-off')), sl('s-on') + '\n' + sl('s-off'));
  const r2 = say('s-on', '/vk-auto off');
  H.ok('/vk-auto off：关了', sa('s-on') === false && /自动模式关了/.test(textOf(r2)));
  say('s-words', '这个需求自动做');
  H.ok('说"这个需求自动做"也算开', sa('s-words') === true);
  const r3 = say('s-req', '/vk-auto 做一个订单导出的功能，导出成 xlsx');
  H.ok('/vk-auto 带着需求：开了，后面的话照需求认（进了写需求那一段）', sa('s-req') === true && /这像一条需求|写需求这一段的规矩/.test(textOf(r3)) && S.flowState({ session_id: 's-req' }).on === true, textOf(r3).slice(0, 500));
  // 安装器：配置里旧的两个开关清掉，正在流程里的会话补一个会话开关
  const pkg = (() => { if (!FROM) return H.makePackage('tas-pkg', '20261031.1200'); const d = path.join(H.tempDir('tas-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (x) => x === 'node_modules' || x === '.git'); H.stubDeps(d); return d; })();
  const u = H.freshHome('tas-inst');
  const i1 = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
  const cfgFile = path.join(u.kit, 'config.json');
  const cfg = JSON.parse(H.read(cfgFile) || '{}'); cfg.autoApply = true; cfg.autoRequirements = true; H.write(cfgFile, JSON.stringify(cfg));
  H.write(path.join(u.kit, 'state', 'busy-flow.json'), JSON.stringify({ on: true, at: Date.now(), stage: 'apply', changes: [] }));
  try { fs.unlinkSync(path.join(u.kit, 'state', 'auto-session-migration.json')); } catch (e) { /* 第一次装还没有 */ }
  const i2 = H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
  const after = JSON.parse(H.read(cfgFile) || '{}');
  H.ok('升级：配置里旧的两个开关清掉了', i1.code === 0 && i2.code === 0 && !('autoApply' in after) && !('autoRequirements' in after), i2.out.slice(-500));
  H.ok('升级：正在流程里的会话补了会话开关（不打断正在自动干活的）', JSON.parse(H.read(path.join(u.kit, 'state', 'busy-auto-switch.json')) || '{}').on === true && /正在自动干活的 1 个会话照旧开着/.test(i2.out), i2.out.slice(-500));
}

H.section('复审 V1—V4：/vk-auto 关 是关；需求原文里的"自动关闭""自动完成"不动开关；开着的开关不会 3 天后被清掉');
{
  const h = H.makeHome('tas-v', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const said = (t) => (S.autoSwitchSaid ? S.autoSwitchSaid(t) : 'none');
  for (const [t, want] of [['/vk-auto 关', 'off'], ['/vk-auto 关闭', 'off'], ['/vk-auto 实现订单超时自动关闭', 'on'], ['<command-name>/vk-auto</command-name>\n<command-args>关</command-args>', 'off'],
    ['那就全自动做吧', 'on'], ['你别自动了，我自己来', 'off'], ['把自动关了', 'off'],
    ['这个功能别自动提交，我来点', ''], ['先别自动推送', ''], ['做一个功能：订单超时自动关闭。', ''], ['账号自动停用', ''],
    ['支付成功后，自动完成订单状态流转', ''], ['每天零点，自动推进到下一个状态', ''], ['开自动提交', ''], ['开一下自动保存', '']]) H.ok('"' + t.replace(/\n/g, ' ') + '" → ' + (want || '不算'), said(t) === want, said(t));
  const p = H.makeRepo(path.join(h.work, 'proj'), { 'a.txt': 'x\n', '.gitignore': '.vibe/\n' });
  const say = (sid, prompt, n) => H.hook(h, 'task-anchor', { session_id: sid, cwd: p, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: H.transcript(path.join(h.root, 'v-' + n + '.jsonl'), [H.tr.user(prompt)]) });
  say('s-v4', '/vk-auto', 1);
  const f = path.join(h.kit, 'state', 's-v4-auto-switch.json');
  const old = new Date(Date.now() - 4 * 86400000); fs.utimesSync(f, old, old);
  say('s-v4', '接着做', 2);
  S.cleanState(3);
  H.ok('开着自动的会话用户还在说话：开关文件时间拨到现在，3 天的清理不删', fs.existsSync(f) && S.sessionAuto({ session_id: 's-v4' }) === true);
}

H.section('第 24 条：会话开着自动，任务做完等验收照样算自动；用户改了需求按改后的重定范围，不退回人工');
{
  const h = H.makeHome('tas-24', FROM, Object.assign({}, QUIET, { autoApply: true, autoRequirements: true }));
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE(true)));
  const dir = path.join(p, 'openspec', 'changes', 'feat-028');
  H.reviewPoints(h, dir, 'code');
  const scope = () => ({ at: Date.now(), dirs: { [S.normKey(dir)]: { hash: A.planHash(dir), req: A.requirementHash ? A.requirementHash(dir) : '' } }, roots: [S.normKey(p)] });
  const flow = (sid) => { H.inFlow(h, sid, [dir], true, 'apply'); S.updateState(sid + '-flow', (s) => { s.applyScope = scope(); }); };
  flow('s24-cfg'); flow('s24-ses');
  if (S.setSessionAuto) S.setSessionAuto({ session_id: 's24-ses' }, true, '测试');
  const vc = S.flowView({ session_id: 's24-cfg', cwd: p });
  const vs = S.flowView({ session_id: 's24-ses', cwd: p });
  H.ok('配置开关（兼容老配置）：任务做完等验收，自动不再生效', !vc.effective && /等用户自测验收/.test(vc.waiting), vc);
  H.ok('会话开关：任务做完等验收，照样算自动（用户报的问题自动改、审、测）', vs.effective === true && !vs.waiting, vs);
  // 用户测试时改了需求：proposal 里加一条
  H.write(path.join(dir, 'proposal.md'), H.read(path.join(dir, 'proposal.md')) + '- 导出时带上合计行（用户 10-31 测试时提的）\n');
  const rc = A.valid({ session_id: 's24-cfg', cwd: p });
  const rs = A.valid({ session_id: 's24-ses', cwd: p });
  H.ok('配置开关：改了需求，退回人工等重新开工（照旧）', rc.ok === false, rc);
  H.ok('会话开关：改了需求，按改后的重定范围接着自动', rs.ok === true && S.flowState({ session_id: 's24-ses' }).applyScope.dirs[S.normKey(dir)].req === A.requirementHash(dir), rs);
  H.ok('会话开关：改了需求这件事记进收工报告', JSON.stringify(require(path.join(h.kit, 'lib', 'report.js')).stateOf({ session_id: 's24-ses' }).items || []).includes('需求文档'), require(path.join(h.kit, 'lib', 'report.js')).stateOf({ session_id: 's24-ses' }).items);
}

H.section('第 25 条：提交方式"自动"，任务都勾完以后改完用户报的问题，能提交');
{
  const h = H.makeHome('tas-25', FROM, Object.assign({}, QUIET, { commitMode: 'auto', autoApply: true }));
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE(true)));
  const dir = path.join(p, 'openspec', 'changes', 'feat-028');
  H.reviewPoints(h, dir, 'code');
  H.inFlow(h, 's25', [dir], true, 'apply');
  H.write(path.join(p, 'src', 'A.java'), 'class A { void export() { /* 修用户报的空指针 */ } }\n');
  const r = H.hook(h, 'guard-commit', { session_id: 's25', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add src/A.java && git commit -m "fix: 导出空数据时不再报空指针"' }, transcript_path: H.transcript(path.join(h.root, 't25.jsonl'), [H.tr.user('导出空数据时报空指针了'), H.tr.say('改好了')]) });
  H.ok('任务都勾完、改完一处用户报的问题：提交放行（以前"还没做完一件事"一直挡着）', !blocked(r), H.reasonOf(r));
}

H.section('第 26 条：问题处理完再审，轮数接着数；到上限不再自动审、不挡提交');
{
  const h = H.makeHome('tas-26', FROM, Object.assign({}, QUIET, { commitMode: 'auto', autoApply: true, applyReviewMaxRounds: 3 }));
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  const p = H.makeRepo(path.join(h.work, 'proj'), Object.assign({ 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' }, CHANGE(true)));
  const dir = path.join(p, 'openspec', 'changes', 'feat-028');
  const k = S.normKey(dir) + '|group-1';
  // 审出问题 → 处理完（resolved）→ 改了代码再审：三遍
  for (let i = 1; i <= 3; i++) {
    H.write(path.join(p, 'src', 'A.java'), 'class A { int v' + i + '; }\n');
    P.begin(dir, 'group-1', 'r' + i, P.fingerprint(dir, 'group-1'));
    P.noteResult(dir, 'group-1', { id: 'r' + i, status: 'completed', issues: [{ id: 'x' }], file: '', materialInputs: [] }, P.fingerprint(dir, 'group-1'));
    S.updateState('review-points', (o) => { o[k].status = 'resolved'; o[k].resolvedFingerprint = 'old'; });
  }
  H.write(path.join(p, 'src', 'A.java'), 'class A { int v9; }\n');
  H.ok('处理完问题后再审，轮数接着数（以前每次清零，一天能审 23 轮）', P.record(dir, 'group-1').rounds === 3, P.record(dir, 'group-1'));
  H.ok('到 3 轮上限、没通过：不再算待审（不再自动审）', !!P.exhausted && P.exhausted(dir, 'group-1') && P.pending(dir, 'code') === '', { pending: P.pending(dir, 'code') });
  H.inFlow(h, 's26', [dir], true, 'apply');
  const r = H.hook(h, 'guard-commit', { session_id: 's26', cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add src/A.java && git commit -m "fix: 处理审查意见"' }, transcript_path: H.transcript(path.join(h.root, 't26.jsonl'), [H.tr.user('接着做'), H.tr.say('改好了')]) });
  H.ok('到上限的点不挡提交（以前一直"审查还没收尾"）', !blocked(r), H.reasonOf(r));
}

H.done('自动模式按会话开、第 24—27 条');

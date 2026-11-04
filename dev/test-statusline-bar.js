'use strict';
/*
 * 状态栏（第 46、47 条）：没进流程不显示 change，只有一行；流程里三行：第一行目录、上下文、自动，第二行步骤条，第三行下一项或等待。
 * 模型名、自动压缩、"当前生效"、用量都没了。折叠、截断、缓存。
 * 用法：node dev/test-statusline-bar.js [旧版套件目录]（拿 2248 跑要不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2];
const h = H.makeHome('statusline-bar', FROM);
const S = require(path.join(h.kit, 'lib', 'session.js'));
const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
let seq = 0;
function project(changes, tasks) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), { 'README.md': '# x\n', '.gitignore': '.vibe/\n' });
  const os_ = path.join(proj, 'openspec');
  H.write(path.join(os_, 'plan.md'), '# 计划\n\n## 导出\n\n探索记录：explore/导出.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + changes.map((c) => '| | ' + c + ' | | |\n').join(''));
  H.write(path.join(os_, 'explore', '导出.md'), '# 探索\n\n## 定了的\n\n导出 xlsx\n\n## 还没定的\n\n## 范围\n\n只做导出\n\n## 跨 change 约定\n\n无\n\n' + changes.map((c) => '## change: ' + c + '\n\n目标\n\n').join(''));
  const docs = (c, list) => {
    const d = path.join(os_, 'changes', c);
    H.write(path.join(d, 'proposal.md'), '## Why\n要导出。\n');
    H.write(path.join(d, 'specs', 'a', 'spec.md'), '## ADDED Requirements\n### Requirement: A\n系统 SHALL 导出。\n');
    H.write(path.join(d, 'design.md'), '## Context\n现状。\n## 验收用例\n- AC-01\n');
    H.write(path.join(d, 'tasks.md'), list);
    return d;
  };
  return { proj, docs };
}
function run(j, proj, sid) {
  const r = spawnSync(process.execPath, [path.join(h.kit, 'statusline.js')], { input: JSON.stringify(Object.assign({ session_id: sid, workspace: { current_dir: proj }, model: { display_name: 'Opus 测试' }, context_window: { used_percentage: 32, context_window_size: 1000000, current_usage: { input_tokens: 320000 } } }, j)), env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return plain(r.stdout).trim().split(/\r?\n/);
}

H.section('没进流程：只有第一行，不显示 change');
{
  const p = project(['c1']);
  p.docs('c1', '## 1. 实现\n\n- [ ] 1.1 改 a\n');
  const ls = run({}, p.proj, 's-none');
  H.ok('只有一行', ls.length === 1, ls);
  H.ok('有目录、上下文、自动关', /上下文 .*32% 320k\/1M/.test(ls[0]) && /自动 关/.test(ls[0]), ls[0]);
  H.ok('目录里有没勾的 change 也不显示（第 46 条）', !/c1/.test(ls[0]) && !/opsx/.test(ls[0]), ls[0]);
  H.ok('不显示模型名、自动压缩、用量', !/Opus/.test(ls[0]) && !/自动压缩/.test(ls[0]) && !/今天/.test(ls[0]), ls[0]);
}

H.section('流程里：步骤条和下一项');
{
  const p = project(['c1', 'c2-api', 'c3']);
  const d1 = p.docs('c1', '## 1. 实现\n\n- [x] 1.1 改 a\n');
  const d2 = p.docs('c2-api', '## 1. 甲\n\n- [x] 1.1 改 a\n\n## 2. 乙\n\n- [x] 2.1 改 b\n- [ ] 2.2 改 c\n- [ ] 2.3 订单查询为空时返回空列表\n\n## 3. 丙\n\n- [ ] 3.1 改 d\n');
  const j = { session_id: 's-flow', cwd: p.proj };
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d2);
  for (const pt of ['proposal', 'specs', 'design', 'tasks', 'group-1']) P.noteResult(d2, pt, { id: 'x' + pt, status: 'completed', issues: [] }, P.fingerprint(d2, pt));
  P.begin(d2, 'group-2', 'y', 'f');
  void d1;
  const ls = run({}, p.proj, 's-flow');
  H.ok('三行', ls.length === 3, ls);
  H.ok('第二行一字不差（change 名后面不带第几个/共几个，2026-11-04）', ls[1] === '探索✓ │ c2-api 提案✓◆ 规格✓◆ 设计✓◆ 任务✓◆ 1组✓◆ 2组●◇ 3组○ │ 自测○ 核验○ 归档○', ls[1]);
  H.ok('第三行是下一项', /^下一项 2\.2/.test(ls[2]), ls[2]);
  H.ok('第一行不写"当前生效"', !/当前生效/.test(ls.join('\n')), ls);
  P.noteResult(d2, 'group-1', { id: 'z', status: 'completed', issues: [{ severity: 'P1' }, { severity: 'P2' }, { severity: 'P3' }] }, P.fingerprint(d2, 'group-1'));
  S.writeState('changes-cache', {});
  const l2 = run({}, p.proj, 's-flow');
  H.ok('有 P1、P2 待修：✗N，P3 不算', /1组✓✗2 /.test(l2[1]), l2[1]);
}

H.section('折叠、截断');
{
  const p = project(['a-very-long-change-name-over-16']);
  const list = Array.from({ length: 8 }, (_, i) => '## ' + (i + 1) + '. 组\n\n- [' + (i < 2 ? 'x' : ' ') + '] ' + (i + 1) + '.1 改 f' + i + '\n').join('\n');
  const d = p.docs('a-very-long-change-name-over-16', list);
  const j = { session_id: 's-many', cwd: p.proj };
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d);
  const ls = run({}, p.proj, 's-many');
  H.ok('组太多折叠成一个', /组 3\/8●/.test(ls[1]) && !/4组/.test(ls[1]), ls[1]);
  H.ok('变更名过长截断，后面不带序号', /a-very-long-cha… /.test(ls[1]) && !/\(\d+\/\d+\)/.test(ls[1]), ls[1]);
}

H.section('等用户');
{
  const p = project(['c1']);
  const d = p.docs('c1', '## 1. 实现\n\n- [x] 1.1 改 a\n');
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  const j = { session_id: 's-verify', cwd: p.proj };
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d);
  B.setTaskState(B.named(p.proj, '导出'), { selfTest: { at: Date.now() } });
  const ls = run({}, p.proj, 's-verify');
  H.ok('核验：第二行自测做完、核验在做', /自测✓ 核验● 归档○/.test(ls[1]), ls[1]);
  H.ok('第三行写等你做什么', /等你核验：看完说归档或 \/vk-archive/.test(ls[2]), ls[2]);
}

H.section('有才出现的一行');
{
  const p = project(['c1']);
  H.setConfig(h, { kitLock: false });
  const ls = run({}, p.proj, 's-extra');
  H.ok('放松的保护：单独一行', ls.length === 2 && /允许改套件/.test(ls[1]), ls);
  H.setConfig(h, { kitLock: true });
}

H.section('流程状态读不了：照样出一行（复审 R14）');
{
  const p = project(['c1']);
  const bad = path.join(h.kit, 'state', 'session', 's-bad');
  require('fs').mkdirSync(bad, { recursive: true });
  require('fs').writeFileSync(path.join(bad, 'flow.json'), '{坏了');
  const ls = run({}, p.proj, 's-bad');
  H.ok('有第一行', /上下文/.test(ls[0]), ls);
}

H.section('缓存：5 秒内不读文件');
{
  const list = Array.from({ length: 200 }, (_, i) => '- [ ] 1.' + (i + 1) + ' 改 f' + i).join('\n') + '\n';
  const p = project(['c1']);
  const d = p.docs('c1', '## 1. 实现\n\n' + list);
  const j = { session_id: 's-cache', cwd: p.proj };
  S.setFlow(j, true, '测试', 'apply');
  S.flowTouch(j, d);
  const a = run({}, p.proj, 's-cache');
  fs.rmSync(path.join(d, 'tasks.md'));
  const b = run({}, p.proj, 's-cache');
  H.ok('缓存命中：删了 tasks.md 显示没变', a[1] === b[1], [a[1], b[1]]);
}

H.done('状态栏步骤条');

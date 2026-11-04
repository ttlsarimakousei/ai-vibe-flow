'use strict';
/*
 * 审查全部用子代理（问题表第 45 条、第 43 条审查部分，用户 2026-11-03 定的）：脚本只备材料、算修改点、记账。
 *   第一轮 2～3 个角度，交齐才入账；后面只审修改点；文件 50 个不截断；坏 JSON 回 block，拦 2 次算没交；同一角度不算两次；
 *   裸开子代理拦下；范围外建议不算问题；没有次数上限、不收敛不停；子代理连续 3 次没交就不再催，不算通过；提交永远能靠用户说。
 * 用法：node dev/test-review-subagent.js [旧版套件目录]（拿 2248 跑要不过）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('review-subagent', FROM, { reviewLenses: 3, commitMode: 'auto' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
const R = require(path.join(h.kit, 'lib', 'review-runner.js'));

let seq = 0;
function project() {
  const proj = path.join(H.tempDir('rs'), 'p' + (++seq));
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  H.write(path.join(proj, 'src', 'a.js'), 'const a = 1;\n');
  const dir = path.join(proj, 'openspec', 'changes', 'c1');
  H.write(path.join(dir, 'proposal.md'), '## Why\n要导出。\n## What Changes\n- 导出\n');
  H.write(path.join(dir, 'specs', 'order', 'spec.md'), '## ADDED Requirements\n### Requirement: 导出订单\n系统 SHALL 导出。\n#### Scenario: 导出\n- **WHEN** 点导出\n- **THEN** 下载文件\n');
  H.write(path.join(dir, 'design.md'), '## Context\n现状。\n## 验收用例\n- AC-01：点导出下载文件\n');
  H.write(path.join(dir, 'tasks.md'), '## 1. 实现\n\n- [x] 1.1 改 src/a.js\n- [x] 1.2 改 src/b.js\n');
  H.git(proj, ['init', '-q']); H.git(proj, ['add', '.']); H.git(proj, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  const base = H.git(proj, ['rev-parse', 'HEAD']).out.trim();
  H.write(path.join(proj, 'src', 'a.js'), 'const a = 2;\n');
  return { proj, dir, base };
}
const issue = (over) => Object.assign({ severity: 'P2', file: 'src/a.js', line: 1, problem: '值写错了', evidence: '传 1 得到 2', fix: '改回', kind: '边界', avoid: '无', scope: 'in' }, over);
const opts = (p, over) => Object.assign({ cwd: p.proj, change: 'c1', mode: 'code', point: 'group-1', base: p.base }, over);
const tell = (p, a) => '审查任务：' + p.id + '/' + a + '\n```json\n' + JSON.stringify({ issues: [], summary: '看完了' }) + '\n```';

H.section('第一轮几个角度，交齐才入账');
{
  const p = project();
  const r = R.prepare(opts(p));
  H.ok('prepare 不发请求，给 3 个角度的提示', r.status === 'prepared' && r.agents.length === 3, r);
  H.ok('提示第三行是审查任务，第四行是范围文件', /^模式：代码\n变更：c1\n审查任务：[0-9a-f]{24}\/.+\n范围文件：/.test(r.agents[0].prompt), r.agents[0].prompt);
  const scope = H.read(/范围文件：(.+)/.exec(r.agents[0].prompt)[1].trim());
  H.ok('范围文件写了要审的文件、基线、怎么交', /src\/a\.js/.test(scope) && /基线/.test(scope) && /审查任务：/.test(scope), scope);
  H.ok('要求里写了不自己加', /scope 写 out/.test(scope));
  const again = R.prepare(opts(p));
  H.ok('输入没变再 prepare：同一个任务，不加轮数', again.id === r.id && P.record(p.dir, 'group-1').rounds === 1, again);
  H.ok('还没交：这个点没过', !P.settled(p.dir, 'group-1'));
  R.submit(r.id, r.agents[0].lens, tell(r, r.agents[0].lens));
  R.submit(r.id, r.agents[1].lens, tell(r, r.agents[1].lens));
  H.ok('少一个角度：不算', !P.settled(p.dir, 'group-1') && R.status(opts(p)).status === 'running');
  const re = R.submit(r.id, r.agents[0].lens, tell(r, r.agents[0].lens));
  H.ok('同一角度交两次只算一次', re.repeat === true && !P.settled(p.dir, 'group-1'), re);
  const third = R.prepare(opts(p));
  H.ok('再 prepare：已交的不重开，只给没交的', third.id === r.id && third.agents.length === 1 && third.agents[0].lens === r.agents[2].lens, third);
  const done = R.submit(r.id, r.agents[2].lens, tell(r, r.agents[2].lens));
  H.ok('交齐：completed，这个点过了', done.status === 'completed' && P.settled(p.dir, 'group-1'), done);
  H.ok('写了结果文件和审查记录，任务目录清掉', fs.existsSync(done.file) && /第 1 轮/.test(H.read(path.join(p.proj, '.vibe/reviews/c1/审查记录.md'))) && !fs.existsSync(path.join(p.proj, '.vibe/reviews/c1/job-' + r.id)));
}

H.section('文件多不截断，二进制不卡');
{
  const p = project();
  for (let i = 0; i < 50; i++) H.write(path.join(p.proj, 'src', 'f' + i + '.js'), 'const x = ' + i + ';\n');
  fs.writeFileSync(path.join(p.proj, 'src', 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  const r = R.prepare(opts(p, { point: undefined, change: undefined }));
  const scope = H.read(/范围文件：(.+)/.exec(r.agents[0].prompt)[1].trim());
  H.ok('50 个文件都在范围文件里', [...Array(50).keys()].every((i) => scope.includes('src/f' + i + '.js')), scope.slice(0, 300));
  let last; for (const a of r.agents) last = R.submit(r.id, a.lens, tell(r, a.lens));
  H.ok('二进制记 uncovered，状态仍 completed', last.status === 'completed' && (last.uncovered || []).some((x) => /bin\.dat/.test(x.file)), last);
}

H.section('结论入账走 SubagentStop');
{
  const p = project();
  const r = R.prepare(opts(p));
  const stop = (lens, text, agent) => H.hook(h, 'review-stop', { session_id: 's-stop', cwd: p.proj, hook_event_name: 'SubagentStop', agent_type: 'vk-reviewer', agent_id: agent || 'a1', last_assistant_message: text });
  H.ok('别的子代理不管', H.hook(h, 'review-stop', { session_id: 's-stop', cwd: p.proj, hook_event_name: 'SubagentStop', agent_type: 'general-purpose', agent_id: 'x', last_assistant_message: '做完了' }) === null);
  const lens = r.agents[0].lens;
  const bad = stop(lens, '审查任务：' + r.id + '/' + lens + '\n没有 JSON');
  H.ok('坏 JSON：拦下，说怎么写', /"?block/.test(JSON.stringify(bad)) && /JSON/.test(H.reasonOf(bad)), bad);
  const bad2 = stop(lens, '审查任务：' + r.id + '/' + lens + '\n{"issues":[{"file":"a"}]}');
  H.ok('字段不全：拦第二次', /file、problem、evidence/.test(H.reasonOf(bad2)), bad2);
  const bad3 = stop(lens, '审查任务：' + r.id + '/' + lens + '\n还是没有');
  H.ok('拦了 2 次还不对：放行，算没交', bad3 === null && R.status(opts(p)).state[lens].status === 'failed', R.status(opts(p)).state);
  H.ok('记了一次没交', P.record(p.dir, 'group-1').failStreak === 1, P.record(p.dir, 'group-1'));
  const b1 = stop('', '审完了，没问题', 'a2'); const b2 = stop('', '审完了，没问题', 'a2'); const b3 = stop('', '审完了，没问题', 'a2');
  H.ok('没写审查任务：拦 2 次后放行', /没认出/.test(H.reasonOf(b1)) && /没认出/.test(H.reasonOf(b2)) && b3 === null);
  const next = R.prepare(opts(p));
  H.ok('下一次 prepare 只重开没交的', next.agents.some((a) => a.lens === lens));
  for (const a of next.agents) H.ok('好的回复放行：' + a.lens, stop(a.lens, tell(next, a.lens), a.lens) === null);
  H.ok('交齐入账，清零', P.settled(p.dir, 'group-1') && !P.record(p.dir, 'group-1').failStreak, P.record(p.dir, 'group-1'));
}

H.section('放行：裸开子代理拦下，带任务的放行并记发出去了');
{
  const p = project();
  const j = { session_id: 's-agent', cwd: p.proj, transcript_path: H.transcript(path.join(H.tempDir('rs-t'), 't.jsonl'), [H.tr.user('开工')]), hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu1' };
  S.setFlow(j, true, '测试', 'apply');
  S.setSessionAuto(j, true, '测试');
  H.setConfig(h, { autoRequirements: true, autoApply: true });
  const call = (prompt) => H.hook(h, 'guard-ask', Object.assign({}, j, { tool_input: { subagent_type: 'vk-reviewer', prompt } }));
  H.ok('裸开：拦下，说先 prepare', /review\.js prepare/.test(H.reasonOf(call('模式：代码\n变更：c1'))), call('模式：代码\n变更：c1'));
  const r = R.prepare(opts(p));
  H.ok('带任务：放行', !H.reasonOf(call(r.agents[0].prompt)), call(r.agents[0].prompt));
  H.ok('记了发出去了', R.status(opts(p)).state[r.agents[0].lens].status === 'sent', R.status(opts(p)).state);
  const again = R.prepare(opts(p));
  H.ok('正在跑的不重开', !again.agents.some((a) => a.lens === r.agents[0].lens) && again.running.includes(r.agents[0].lens), again);
  H.ok('在跑：inFlight', R.inFlight(p.dir, 'code'));
  H.setConfig(h, { autoRequirements: false, autoApply: false });
  // Esc 打断：前台子代理的结果回来了还没交
  const turn = (id, text) => [H.tr.user('开工'), { type: 'assistant', uuid: id + 'c', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] } }, { type: 'user', uuid: id + 'r', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }];
  const es = turn('tu1', '[Request interrupted by user for tool use]');
  R.sweep(es, p.proj);
  H.ok('Esc 打断、没交：算没交，下次重开', R.status(opts(p)).state[r.agents[0].lens].status === 'failed', R.status(opts(p)).state);
  // 2.1.259 起在后台：工具结果只说已启动，不算结束
  const r2 = R.prepare(opts(p));
  const lens2 = r2.agents[0].lens;
  R.dispatch(r2.id, lens2, 'bg-1');
  const bg = turn('bg-1', 'Async agent launched successfully. agentId: x');
  R.sweep(bg, p.proj);
  H.ok('后台在跑：不算没交', R.status(opts(p)).state[lens2].status === 'sent', R.status(opts(p)).state);
}

H.section('同时在跑的审查子代理最多 3 个（第 52 条，2026-11-04）');
{
  // 同一个项目里两个 change 各 prepare 一次：以前一条回复里能开 6 个
  const p = project();
  const c2 = path.join(p.proj, 'openspec', 'changes', 'c2');
  for (const f of ['proposal.md', 'design.md', 'tasks.md', path.join('specs', 'order', 'spec.md')]) H.write(path.join(c2, f), H.read(path.join(p.dir, f)));
  const j = { session_id: 's-cap', cwd: p.proj, transcript_path: H.transcript(path.join(H.tempDir('rs-cap'), 't.jsonl'), [H.tr.user('开工')]), hook_event_name: 'PreToolUse', tool_name: 'Agent' };
  S.setFlow(j, true, '测试', 'apply');
  S.setSessionAuto(j, true, '测试');
  H.setConfig(h, { autoRequirements: true, autoApply: true });
  let n = 0;
  const call = (prompt) => H.hook(h, 'guard-ask', Object.assign({}, j, { tool_use_id: 'cap' + (++n), tool_input: { subagent_type: 'vk-reviewer', prompt } }));
  const a = R.prepare(opts(p));
  const b = R.prepare(opts(p, { change: 'c2' }));
  H.ok('（两个任务各 3 个角度）', a.agents.length === 3 && b.agents.length === 3, [a.agents.length, b.agents.length]);
  const first = a.agents.map((x) => call(x.prompt));
  H.ok('前 3 个放行', first.every((o) => !H.reasonOf(o)), first.map(H.reasonOf));
  const fourth = call(b.agents[0].prompt);
  H.ok('第 4 个拦下：说已经有 3 个在跑、等前面的交了再开', /已经有 3 个审查子代理在跑/.test(H.reasonOf(fourth)) && /同时最多 3 个/.test(H.reasonOf(fourth)), H.reasonOf(fourth));
  H.ok('拦下的没记成发出去了', R.status(opts(p, { change: 'c2' })).state[b.agents[0].lens].status !== 'sent', R.status(opts(p, { change: 'c2' })).state);
  H.ok('已经发出去的那个再开一次（重试）：不算多一个', !H.reasonOf(call(a.agents[0].prompt)));
  R.submit(a.id, a.agents[0].lens, tell(a, a.agents[0].lens));
  H.ok('交了一个：第 4 个能开了', !H.reasonOf(call(b.agents[0].prompt)));
  H.ok('又满了：第 5 个照拦', /同时最多 3 个/.test(H.reasonOf(call(b.agents[1].prompt))));
  // 前台子代理的结果已经回来、没交结论（崩了、被打断）：满了的时候先清掉它们，让出位子（复审第 6 条）
  const done = [H.tr.user('开工')];
  for (let i = 1; i <= n; i++) done.push({ type: 'assistant', uuid: 'c' + i, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'cap' + i, name: 'Agent', input: {} }] } }, { type: 'user', uuid: 'r' + i, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cap' + i, content: '子代理出错退出了' }] } });
  H.transcript(j.transcript_path, done);
  H.ok('前面的都已经结束（没交）：第 5 个能开了', !H.reasonOf(call(b.agents[1].prompt)), H.reasonOf(call(b.agents[1].prompt)));
  H.setConfig(h, { autoRequirements: false, autoApply: false });
}

(async () => {
  H.section('复审只送修改点');
  {
    const p = project();
    let first = '';
    const a = await H.fakeReview(R, opts(p), (lens, scope) => { first = scope; return { issues: [issue()] }; });
    H.ok('第一轮：报了问题，没过', a.status === 'completed' && a.blocking > 0 && !P.settled(p.dir, 'group-1'), a);
    H.ok('第一轮带角度', /这一次你只看一个角度/.test(first), first.slice(0, 200));
    H.write(path.join(p.proj, 'src', 'a.js'), 'const a = 3;\n');
    let second = '';
    const r2 = await H.fakeReview(R, opts(p), (lens, scope) => { second = scope; return { issues: [] }; });
    H.ok('第二轮：一个子代理，只审改过的地方', r2.lenses === 1 && /这是复审/.test(second) && /const a = 3/.test(second) && /上一轮的问题/.test(second), second.slice(0, 500));
    const r3 = R.prepare(opts(p));
    H.ok('文件没变再审：不开子代理', r3.noChange === true && /不用开子代理/.test(r3.next), r3);
  }

  H.section('范围外建议不算问题');
  {
    const p = project();
    const plan = path.join(p.proj, 'openspec', 'plan.md');
    H.write(plan, '# 计划\n\n## 导出\n\n探索记录：explore/导出.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | c1 | | |\n');
    H.write(path.join(p.proj, 'openspec', 'explore', '导出.md'), '# 导出\n\n## 范围\n只做导出\n\n## 定了的\n导出 xlsx\n');
    const r = await H.fakeReview(R, opts(p), () => ({ issues: [issue({ scope: 'out', severity: 'P1', problem: '可以加个进度条' })] }));
    H.ok('out 的不挡通过、不进 issues', r.status === 'completed' && r.blocking === 0 && r.issues.length === 0 && P.settled(p.dir, 'group-1'), r);
    H.ok('结果里列着', (r.suggestions || []).some((x) => /进度条/.test(x.problem)));
    const B = require(path.join(h.kit, 'lib', 'big-task.js'));
    H.ok('进范围外建议，核验时列给用户', B.suggestions(B.named(p.proj, '导出')).some((l) => /进度条/.test(l)), B.suggestions(B.named(p.proj, '导出')));
  }

  H.section('不设次数上限，只对没审成的断路');
  {
    const p = project();
    let last = null;
    for (let i = 0; i < 20; i++) {
      H.write(path.join(p.proj, 'src', 'a.js'), 'const a = ' + (i + 10) + ';\n');
      last = await H.fakeReview(R, opts(p, { full: true }), () => ({ issues: [issue({ severity: 'P1', problem: '第 ' + i + ' 轮的问题' })] }));
    }
    H.ok('20 轮 P1 不减：记录照记，不停', P.record(p.dir, 'group-1').rounds >= 20 && !P.halted(p.dir, 'group-1') && P.pending(p.dir, 'code') === 'group-1', P.record(p.dir, 'group-1'));
    H.ok('没收尾：提交等它', P.fixPending(p.dir, 'group-1', {}) === true);
    void last;

    const q = project();
    for (let i = 0; i < 3; i++) { const r = R.prepare(opts(q)); R.failLens(r.id, r.agents[0].lens, '子代理结束了，没交结论'); }
    H.ok('连续 3 次没交：不再催，不算通过', P.halted(q.dir, 'group-1') && !P.settled(q.dir, 'group-1') && P.pending(q.dir, 'code') === '', P.record(q.dir, 'group-1'));
    H.ok('不挡往下走', P.allDone(q.dir, 'code') && !P.fixPending(q.dir, 'group-1', {}));
    H.ok('说法：不再催', /不再催/.test(P.instruction(q.dir, 'group-1')), P.instruction(q.dir, 'group-1'));
    const w = project();
    const r0 = R.prepare(opts(w));
    for (const a of r0.agents) R.failLens(r0.id, a.lens, '子代理结束了，没交结论');
    H.ok('一轮 3 个角度都被打断：只算一次，不断路（复审 R2）', r0.agents.length >= 2 && P.record(w.dir, 'group-1').failStreak === 1 && !P.halted(w.dir, 'group-1'), P.record(w.dir, 'group-1'));
    const r = await H.fakeReview(R, opts(q), () => ({ issues: [] }));
    H.ok('用户说审，审成了清零、过了', r.status === 'completed' && !P.record(q.dir, 'group-1').failStreak && P.settled(q.dir, 'group-1'), P.record(q.dir, 'group-1'));
  }

  H.section('第 6 条：超预期用时、没交结论记反馈，不带原文');
  {
    const p = project();
    const r = R.prepare(opts(p, { budgetSeconds: 10 }));
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === r.id) o[k].started = Date.now() - 60000; });
    let last; for (const a of r.agents) last = R.submit(r.id, a.lens, '审查任务：' + r.id + '/' + a.lens + '\n```json\n' + JSON.stringify({ issues: [issue({ problem: '机密内容XYZ' })] }) + '\n```');
    H.ok('超了：记了一条', !!last.reported, last);
    const fbDir = path.join(h.kit, 'feedback');
    const body = fs.existsSync(fbDir) ? fs.readdirSync(fbDir).map((f) => H.read(path.join(fbDir, f)) || '').join('\n') : '';
    H.ok('记的是用时、角度、文件数，不带审查意见', /总用时/.test(body) && /每个角度/.test(body) && !/机密内容XYZ/.test(body), body.slice(0, 500));
  }

  H.section('跨 change：revisions 列出的 change 审修改点');
  {
    const proj = path.join(H.tempDir('rs'), 'cross');
    const mk = (c) => { const d = path.join(proj, 'openspec', 'changes', c); H.write(path.join(d, 'proposal.md'), '## Why\n要导出。\n'); H.write(path.join(d, 'design.md'), '## Context\n现状。\n## 验收用例\n- AC-01：导出\n'); H.write(path.join(d, 'tasks.md'), '## 1. 实现\n\n- [x] 1.1 改 src/' + c + '.js\n'); H.write(path.join(proj, 'src', c + '.js'), 'const x = 1;\n'); return d; };
    const [d1, d2, d3] = ['c1', 'c2', 'c3'].map(mk);
    H.write(path.join(proj, 'openspec', 'plan.md'), '# 计划\n\n## 导出\n\n探索记录：explore/导出.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | c1 | | |\n| | c2 | | |\n| | c3 | | |\n');
    H.write(path.join(proj, 'openspec', 'explore', '导出.md'), '# 导出\n\n## 范围\n只做导出\n');
    H.git(proj, ['init', '-q']); H.git(proj, ['add', '.']); H.git(proj, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    const base = H.git(proj, ['rev-parse', 'HEAD']).out.trim();
    H.write(path.join(proj, 'src', 'c2.js'), 'const x = 2;\n');
    H.write(path.join(d1, 'revisions.md'), '# 修订记录\n\n## 2026-11-03 10:00 · 改字段\n- 起因：用户说字段改名\n- 影响 change：c2\n');
    const pt = P.points(d2, 'code').find((x) => /^cross-c1-/.test(x));
    H.ok('c1 改了，列了 c2：c2 多一个审查点', !!pt, P.points(d2, 'code'));
    H.ok('没列 c3：不审', !P.points(d3, 'code').some((x) => /^cross-/.test(x)), P.points(d3, 'code'));
    H.ok('来源自己不算', !P.points(d1, 'code').some((x) => /^cross-/.test(x)), P.points(d1, 'code'));
    H.ok('待审', P.pending(d2, 'code') !== '' && P.instruction(d2, pt).includes('--mode code --point ' + pt), P.instruction(d2, pt));
    const r = R.prepare({ cwd: proj, change: 'c2', mode: 'code', point: pt, base });
    H.ok('一个子代理，范围文件写了来源的修改点', r.agents.length === 1 && r.agents[0].lens === '修改点' && /来源的修改点[\s\S]*字段改名/.test(H.read(/范围文件：(.+)/.exec(r.agents[0].prompt)[1].trim())), r);
    const done = R.submit(r.id, '修改点', '审查任务：' + r.id + '/修改点\n{"issues":[],"summary":"看完了"}');
    H.ok('审完这个点过了', done.status === 'completed' && P.settled(d2, pt), done);
    H.write(path.join(proj, 'src', 'c2.js'), 'const x = 3;\n');
    H.ok('改代码不把审过的点又打开', P.settled(d2, pt));
  }

  H.section('交齐了但入账没走完（钩子预算用完）：status、prepare 补上');
  {
    const p = project();
    const r = R.prepare(opts(p));
    for (const a of r.agents) R.submit(r.id, a.lens, tell(r, a.lens));
    H.ok('正常入账', R.status(opts(p)).status === 'completed');
    H.write(path.join(p.proj, 'src', 'a.js'), 'const a = 5;\n');
    const r2 = R.prepare(opts(p));
    fs.writeFileSync(path.join(r2.agents[0].prompt.match(/范围文件：(.+)/)[1].trim(), '..', 'result-' + r2.agents[0].lens + '.json'), JSON.stringify({ issues: [], summary: '' }));
    S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) if (o[k].id === r2.id) { o[k].state[r2.agents[0].lens] = { status: 'submitted', doneAt: Date.now() }; o[k].finishing = true; } });
    const st = R.status(opts(p));
    H.ok('status 补上了入账', st.status === 'completed' && P.settled(p.dir, 'group-1'), st);
  }

  H.section('命令行');
  {
    const p = project();
    const run = (...a) => spawnSync(process.execPath, [path.join(h.kit, 'tools', 'review.js')].concat(a), { cwd: p.proj, env: H.envFor(h), encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const r = run('prepare', '--change', 'c1', '--mode', 'code', '--point', 'group-1', '--project', p.proj, '--base', p.base);
    H.ok('prepare 输出 agents', r.status === 0 && Array.isArray(JSON.parse(r.stdout).agents), r.stdout + r.stderr);
    const old = run('run', '--change', 'c1', '--mode', 'code', '--point', 'group-1', '--project', p.proj, '--base', p.base);
    H.ok('run 是别名，拿到同一个任务', JSON.parse(old.stdout).id === JSON.parse(r.stdout).id, old.stdout);
    H.ok('waive、sync 没了', run('waive', '--change', 'c1').status !== 0 && run('sync').status !== 0);
    H.ok('帮助里没有路由', !/路由/.test(run('--help').stdout));
  }

  H.done('审查全部用子代理');
})();

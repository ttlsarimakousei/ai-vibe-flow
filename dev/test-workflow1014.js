'use strict';
/* 两阶段模式的可观察行为：人工 Ask、整组审查、修订失效、安装迁移和提交分组。旧版运行应出现反例。 */
const fs = require('fs'); const path = require('path'); const http = require('http'); const H = require('./lib/harness');
(async () => {
  const h = H.makeHome('workflow1014', process.argv[2], { autoMode: false, autoApply: false, autoRequirements: false, autoCommit: 'off', lessons: 'off', autoOnboard: false, pullBeforeWork: false, outputGate: false });
  const S = require(path.join(h.kit, 'lib/session')); const W = require(path.join(h.kit, 'lib/workspace')); const R = require(path.join(h.kit, 'lib/review-runner'));
  const cfg = patch => { const c = Object.assign(JSON.parse(H.read(path.join(h.kit, 'config.json'))), patch); H.write(path.join(h.kit, 'config.json'), JSON.stringify(c)); S.sealConfig(h.kit, c); };
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n', 'openspec/changes/add-a/proposal.md': '# 目标\n实现订单查询功能。\n', 'openspec/changes/add-a/specs/order/spec.md': '## ADDED Requirements\n### Requirement: 查询\n#### Scenario: 空列表\n- **WHEN** 没有订单\n- **THEN** 返回空列表\n', 'openspec/changes/add-a/design.md': '# 设计\n## Context\n读取 a.js。\n', 'openspec/changes/add-a/tasks.md': '## 1. 查询\n- [ ] 1.1 修改 a.js；验：node --check a.js\n- [ ] 1.2 修改 b.js；验：node --check b.js\n## 2. 交付\n- [ ] 2.1 更新 a.js；验：node --check a.js\n' });
  const d = path.join(p, 'openspec/changes/add-a'); let seq = 0;
  const tf = entries => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), entries);
  const j = { cwd: p, session_id: 'manual', transcript_path: tf([H.tr.user('修改 a.js')]), tool_use_id: 'r1', tool_name: 'Bash', tool_input: { command: 'node test-order.js' } };
  const runHook = (name, patch) => H.hook(h, name, Object.assign({}, j, patch));
  H.ok('人工自测先 Ask', /人工模式.*Ask/.test(H.reasonOf(runHook('guard-commit'))));
  const review = { tool_input: { command: 'node "' + path.join(h.kit, 'tools/review.js') + '" run --change add-a --mode proposal --point proposal' } };
  H.ok('人工审查先 Ask', /人工模式.*Ask/.test(H.reasonOf(runHook('guard-commit', review))));
  H.ok('明确自测要求直接执行', !/人工模式.*Ask/.test(H.reasonOf(runHook('guard-commit', { transcript_path: tf([H.tr.user('运行测试')]) }))));
  H.ok('明确主动审查不拒绝', !/人工模式.*Ask/.test(H.reasonOf(runHook('guard-commit', Object.assign({}, review, { transcript_path: tf([H.tr.user('审核一下')]) })))));
  H.ok('引号内构建文字不误当自测', runHook('guard-commit', { tool_input: { command: 'echo "npm test"' } }) === null);
  H.ok('IDEA 文件自检人工先 Ask', /人工模式.*Ask/.test(H.reasonOf(runHook('guard-commit', { tool_name: 'mcp__ide__get_file_problems', tool_input: { filePath: 'a.js', projectPath: p } }))));
  const beforeTasks = H.read(path.join(d, 'tasks.md'));
  const waiver = R.waive({ cwd: p, change: 'add-a', mode: 'code', reason: '用户已经明确决定这次不再审查' });
  H.ok('放弃不写任务或未审查状态', waiver.status === 'dismissed' && H.read(path.join(d, 'tasks.md')) === beforeTasks && !Object.keys(S.readState('review-waivers')).length && !S.reviewAllowed('code', d));
  const template = require(path.join(h.kit, 'lib/workflow')).taskTemplate();
  H.ok('任务模板没有套件执行安排', !/代码审查|用户验收|联合验证|测试准备/.test(template));
  const spec = H.read(path.join(d, 'specs/order/spec.md')) + '\n' + '这是业务规则的详细说明。\n'.repeat(260);
  const specOut = runHook('guard-spec', { tool_name: 'Write', tool_input: { file_path: path.join(d, 'specs/order/spec.md'), content: spec } });
  H.ok('复杂产物可超过 250 行', !/250/.test(H.reasonOf(specOut)), specOut);
  const after = runHook('after-tool', { hook_event_name: 'PostToolUseFailure', tool_input: { command: 'openspec instructions proposal --change add-a' }, tool_response: { stderr: 'error: unknown command instructions', exit_code: 1 } });
  H.ok('低版指令不支持时提示自行升级', /自行升级 OpenSpec/.test(H.reasonOf(after)), after);
  const M = require(path.join(h.kit, 'lib/merge-push'));
  const c = (id, title, files = ['a.js']) => ({ id, title, files });
  H.ok('不同任务不能按整个变更合并', M.groupsOf([c('1', 'feat: 查询（源自 add-a 1.1）'), c('2', 'feat: 分页（源自 add-a 1.2）')]).length === 2);
  H.ok('同一任务的修复可合并', M.groupsOf([c('1', 'feat: 查询（源自 add-a 1.1）'), c('2', 'fix: 查询空值（源自 add-a 1.1）')]).length === 1);
  H.ok('验收节点隔开同任务历史', M.groupsOf([c('1', 'feat: 查询（源自 add-a 1.1）'), c('2', 'docs: 验收 add-a', ['docs/accept.md']), c('3', 'fix: 查询空值（源自 add-a 1.1）')]).length === 3);
  const pf = path.join(h.kit, 'lib/flow-policy.js');
  if (!fs.existsSync(pf)) H.ok('独立需求产物与任务组审查策略存在', false);
  else {
    const P = require(pf); const A = require(path.join(h.kit, 'lib/apply-scope'));
    H.ok('两自动默认分别关闭', S.DEFAULT_CONFIG.autoRequirements === false && S.DEFAULT_CONFIG.autoApply === false);
    H.write(path.join(d, 'tasks.md'), beforeTasks.replace('1.1 修改', '1.1 修改').replace('- [ ] 1.1', '- [x] 1.1'));
    H.ok('半组任务不能进入代码审查点', P.points(d, 'code').length === 0);
    H.write(path.join(d, 'tasks.md'), H.read(path.join(d, 'tasks.md')).replace('- [ ] 1.2', '- [x] 1.2'));
    H.ok('整组 1.x 完成只产生一个审查点', P.points(d, 'code').join() === 'group-1');
    cfg({ autoApply: true, autoRequirements: true, requirementsReviewMaxRounds: 2, applyReviewMaxRounds: 4 });
    S.setFlow(j, true, '需求', 'plan'); S.flowTouch(j, d);
    H.ok('需求开关开启但未探索不自动', !S.readConfigFor(j).autoMode);
    const assessment = { description: '查询订单空列表行为', scope: '只修改查询对应实现', acceptance: '订单为空返回空列表', unresolved: ['是否分页'] };
    let denied = false; try { P.qualify(j, assessment); } catch (e) { denied = true; }
    H.ok('没有探索记录不能自动资格登记', denied);
    j.transcript_path = tf([H.tr.user('实现订单查询'), H.tr.ran('Read', { file_path: path.join(p, 'a.js') }, 'let a=1;')]);
    H.ok('未决需求继续沟通', !P.qualify(j, assessment).ready && !S.readConfigFor(j).autoMode);
    H.ok('探索且没有疑问后需求自动生效', P.qualify(j, { ...assessment, unresolved: [] }).ready && S.readConfigFor(j).autoMode);
    for (const [req, apply] of [[false, false], [false, true], [true, false], [true, true]]) {
      cfg({ autoRequirements: req, autoApply: apply });
      H.ok('需求阶段只看需求开关：' + req + '/' + apply, S.readConfigFor(j).autoMode === req);
    }
    cfg({ autoRequirements: true, autoApply: true });
    P.begin(d, 'proposal', 'interrupted', P.fingerprint(d, 'proposal'));
    H.ok('启动即消耗该点轮次，中断不归零', P.record(d, 'proposal').rounds === 1 && !P.passed(d, 'proposal'));
    P.noteResult(d, 'proposal', { id: 'interrupted', status: 'failed', issues: [] }, P.fingerprint(d, 'proposal'));
    H.ok('完成同一轮不重复计数', P.record(d, 'proposal').rounds === 1);
    S.updateState('review-points', o => { delete o[S.normKey(d) + '|proposal']; });
    const good = { id: 'ok', status: 'completed', issues: [] };
    for (const point of ['proposal', 'specs', 'design', 'tasks', 'group-1']) P.noteResult(d, point, good, P.fingerprint(d, point));
    H.ok('需求与 Apply 点次数不共享', P.record(d, 'proposal').rounds === 1 && P.record(d, 'group-1').rounds === 1 && P.limit(S.readConfig(), 'proposal') === 2 && P.limit(S.readConfig(), 'code') === 4);
    H.write(path.join(p, 'b.js'), 'let b=2;\n');
    H.ok('修改组内文件使该组结果失效', !P.passed(d, 'group-1') && P.passed(d, 'design'));
    P.noteResult(d, 'group-1', good, P.fingerprint(d, 'group-1'));
    H.write(path.join(d, 'design.md'), H.read(path.join(d, 'design.md')) + '\n修订：空列表要包含总数。\n');
    H.ok('设计修订使关联任务组结果失效', !P.passed(d, 'group-1') && !P.passed(d, 'tasks') && P.passed(d, 'proposal'));
    for (const point of ['design', 'tasks']) P.noteResult(d, point, good, P.fingerprint(d, point));
    H.ok('定稿未提交不自动 apply', !P.automaticApply(j));
    H.git(p, ['add', 'openspec/changes/add-a/design.md', 'openspec/changes/add-a/tasks.md']); H.git(p, ['commit', '-qm', 'docs: 提案 add-a']);
    S.updateState(j.session_id + '-flow', o => { o.planAssessment.onlyPlan = true; });
    H.ok('仅要求需求文档，即使双自动也不开工', !P.automaticApply(j));
    S.updateState(j.session_id + '-flow', o => { o.planAssessment.onlyPlan = false; });
    H.ok('双自动在文档定稿提交后衔接 Apply', P.automaticApply(j) && S.flowState(j).stage === 'apply', { flow: S.flowState(j), dirs: S.flowChanges(j), points: P.points(d, 'proposal').map(p => [p, P.passed(d, p)]), status: H.git(p, ['status', '--porcelain', '--', 'openspec/changes/add-a']), cfg: [S.readConfig().autoApply, S.readConfig().autoRequirements] });
    for (const [req, apply] of [[false, false], [false, true], [true, false], [true, true]]) {
      cfg({ autoRequirements: req, autoApply: apply });
      H.ok('Apply 阶段只看 Apply 开关：' + req + '/' + apply, S.readConfigFor(j).autoMode === apply);
    }
    const limitKey = 'code|' + S.normKey(d);
    S.writeState('review-rounds', { [limitKey]: { rounds: 4, issues: 1, pendingFix: true, done: false } });
    H.ok('旧兼容循环到上限仍不登记通过', /停止自动循环/.test(S.reviewLoopIssue('code', d, { reviewLoop: true, reviewMaxRounds: 4, autoMode: true })) && !S.readState('review-rounds')[limitKey].done);
    cfg({ autoApply: false, autoRequirements: false });
    const first = P.stop(j, [d], true), second = P.stop(j, [d], true);
    H.ok('人工只提示一次，放弃不被同输入反复催', first.some(x => /Ask/.test(x)) && second.length === 0);
    // 真实执行器与本机假路由：一次 run 的多个批次只计一次独立点。
    let calls = 0; const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { calls++; res.end(JSON.stringify({ content: [{ type: 'text', text: '{"issues":[],"summary":"完成"}' }] })); }); });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); const prev = process.env.VIBE_KIT_REVIEW_PORT; process.env.VIBE_KIT_REVIEW_PORT = String(server.address().port);
    try { const rounds = P.record(d, 'proposal').rounds; const r = await R.run({ cwd: p, change: 'add-a', mode: 'proposal', point: 'proposal' }); H.ok('审查执行器登记当前点与独立报告', r.status === 'completed' && calls > 0 && P.record(d, 'proposal').rounds === rounds + 1 && /proposal-proposal.json$/.test(r.file)); }
    finally { if (prev === undefined) delete process.env.VIBE_KIT_REVIEW_PORT; else process.env.VIBE_KIT_REVIEW_PORT = prev; server.closeAllConnections(); await new Promise(r => server.close(r)); }
  }
  // 旧 autoMode=true 的安装迁移；显式的低保护封条不能在迁移中意外放松。
  cfg({ autoMode: true, autoApply: true, autoRequirements: true });
  const migration = path.join(h.kit, 'state/workflow-v2-migration.json'); if (fs.existsSync(migration)) fs.unlinkSync(migration);
  const installer = path.resolve(process.argv[2] || H.SRC, 'install.js');
  const installed = H.node(h, installer, ['--no-router', '--no-open'], { timeout: 180000 });
  const migrated = JSON.parse(H.read(path.join(h.kit, 'config.json')));
  H.ok('安装升级关闭两模式并保存一次迁移标记', installed.code === 0 && migrated.autoApply === false && migrated.autoRequirements === false && fs.existsSync(migration), installed.err);
  const freshS = require(path.join(h.kit, 'lib/session')); migrated.autoApply = true; H.write(path.join(h.kit, 'config.json'), JSON.stringify(migrated)); freshS.sealConfig(h.kit, migrated);
  H.node(h, installer, ['--no-router', '--no-open'], { timeout: 180000 });
  H.ok('后续再次安装不覆盖用户重新开启的选择', JSON.parse(H.read(path.join(h.kit, 'config.json'))).autoApply === true);
  H.done('1014 两阶段工作流');
})().catch(e => { console.error(e); H.ok('测试正常执行', false); H.done('1014 两阶段工作流'); });

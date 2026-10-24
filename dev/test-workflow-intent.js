'use strict';
/* 话题、引用、否定不是许可。用真实公共判断与钩子核对，旧版参数应检出误授权。 */
const path = require('path');
const H = require('./lib/harness');
const h = H.makeHome('workflow-intent', process.argv[2], { autoMode: true });
const S = require(path.join(h.kit, 'lib/session.js'));
for (const text of ['不要执行 apply', 'apply 先缓缓', '不要开工', '先别开始实现', '取消开工', 'apply 机制有问题', 'apply 的时候是不是全自动', '怎么执行 apply？', '讨论 apply 命令', '之前说过开工，现在先别做', '> 开工', '```\napply\n```']) H.ok('不开工：' + text, !S.applyIntent(text));
for (const text of ['开工', '执行 apply', '按提案做', '照任务做', '开始实现', '把 1.1 做了', '/opsx:apply add-x']) H.ok('明确开工：' + text, S.applyIntent(text));
// 说法表放在 dev/fixtures/intent-phrases.json：11 类许可各有该算、不该算的原话（2026-10-17 起，见 docs/guide-20261017-intent-phrases.md）
const cases = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'intent-phrases.json'), 'utf8'));
for (const [topic, group] of Object.entries(cases)) if (!topic.startsWith('_')) for (const [expect, texts] of Object.entries(group)) for (const text of texts) H.ok(topic + ' ' + expect + '：' + text, S.userSaid([H.tr.user(text)], topic).ok === (expect === 'yes'));
// 提问框的回答：问题里说了是哪件事，回答"好""可以"算；"先不用"不算。两种回答格式都认
const answer = (q, a, prefix) => H.tr.ran('AskUserQuestion', { questions: [{ question: q }] }, (prefix || 'Your questions have been answered:') + ' "' + q + '"="' + a + '"');
for (const prefix of ['Your questions have been answered:', 'User has answered your questions:']) {
  H.ok('提问框回答"好"算审查（' + prefix.slice(0, 4) + '）', S.userSaid([H.tr.user('改完了'), ...answer('要不要审一下？', '好', prefix)], 'review').ok);
  H.ok('提问框回答"先不用"不算审查（' + prefix.slice(0, 4) + '）', !S.userSaid([H.tr.user('改完了'), ...answer('要不要审一下？', '先不用', prefix)], 'review').ok);
  H.ok('提问框回答"可以"算自测（' + prefix.slice(0, 4) + '）', S.userSaid([H.tr.user('改完了'), ...answer('要不要跑一下测试？', '可以', prefix)], 'test').ok);
}
// 提问框的答案单独判断（用户 2026-10-21 定的；#179、#182、#187、#199、#207、#210、#212、#213、#215 的原话）：
// 选项含动作词、不含否定就算，不要求动作词在句首；"（推荐）"先去掉；问题里点了这件事，答"跑""重试""提"也算
const ask = (q, a, prefix) => [H.tr.user('改完了'), ...answer(q, a, prefix)];
for (const [q, a, topic, want] of [
  ['是否要我先自测？范围选哪个？', '全量自测（推荐）', 'test', true],
  ['人工模式下是否执行这些自测？', '按 tasks.md 自测（推荐）', 'test', true],
  ['自测范围？', '后端 + 页面自测', 'test', true],
  ['要不要复验？范围按下面列的两个场景。', '就按这个范围跑', 'test', true],
  ['要不要跑一遍安装验证？', '跑', 'test', true],
  ['要不要跑测试？', '不跑', 'test', false],
  ['要不要跑测试？', '以后再跑', 'test', false],
  ['specs 改完后复验吗？', '复验 specs', 'review', true],
  ['specs 改完后复验吗？', '复验 specs', 'test', false],
  ['proposal 怎么审？', '用 ttls-reviewer 审一次', 'review', true],
  ['独立审查怎么做？', '用 ttls-cross-review', 'review', true],
  ['独立审查用哪种方式？', '兼容代理方式', 'review', true],
  ['审查没拿到正文，怎么办？', '缩范围重试（推荐）', 'review', true],
  ['tasks 写完了，审一下还是就这样定稿？', '就这样定稿', 'review', false],
  ['proposal 写完了，审一下？', '直接写下一份', 'review', false],
  ['要不要审查？', '先不用审查', 'review', false],
  ['gwjh 的 .gitignore 要提交吗？', '提（推荐）', 'commit', true],
  ['三条提交计划怎么提？', '合成一条提交', 'commit', true],
  ['要不要提交？', '可以（推荐）', 'commit', true],
  ['要不要提交？', '先不提交', 'commit', false],
  ['要不要提交？', '提交前我再看看', 'commit', false],
  ['要不要提交？', '还要改', 'commit', false],
]) H.ok('提问框"' + q + '"答"' + a + '"' + (want ? '' : '不') + '算' + topic, S.userSaid(ask(q, a), topic).ok === want);
// 自己打字回答的提问框（2.1.299 实测）：结果文字是 The user answered:，要靠结构化的 answers 认，也要被当成回答过
{
  const id = 'toolu_typed';
  const typed = [H.tr.user('做个导出'), H.tr.call('AskUserQuestion', { questions: [{ question: '要不要自测？' }] }, id), Object.assign(H.tr.result(id, 'The user answered: "要不要自测？"="自测". Read the answers carefully'), { toolUseResult: { questions: [{ question: '要不要自测？' }], answers: { '要不要自测？': '自测' } } })];
  H.ok('自己打字回答的提问框：答"自测"算自测', S.userSaid(typed, 'test').ok);
  H.ok('自己打字回答的提问框：算回答过（The user answered:）', S.ANSWERED.test('The user answered: "要不要自测？"="自测"'));
}
// 审查、自测往回看本轮（用户 2026-10-21 定的）；提交、归档、推送仍只看最后一句
H.ok('本轮：原话说自测、之后提问框选审查、再答别的：审查、自测都算', S.userSaid([H.tr.user('改一下导出，改完自测'), ...answer('审查？', '审查（推荐）'), ...answer('发布方式？', 'A 方案')], 'review').ok && S.userSaid([H.tr.user('改一下导出，改完自测'), ...answer('审查？', '审查（推荐）'), ...answer('发布方式？', 'A 方案')], 'test').ok);
H.ok('本轮：后面的提问框说先不用审查：前面的审查许可不算', !S.userSaid([H.tr.user('审一下代码'), ...answer('要审查吗？', '先不用审查')], 'review').ok);
H.ok('本轮：提问框选了自测和审查，用户又打一句"自测"（新一轮）：审查不算', !S.userSaid([H.tr.user('改一下'), ...answer('接下来？', '自测（推荐）, 审查（推荐）'), H.tr.user('自测')], 'review').ok);
H.ok('上一轮的审查许可不带到这一轮', !S.userSaid([H.tr.user('审一下代码'), H.tr.say('审完了'), H.tr.user('继续')], 'review').ok);
H.ok('提交只看最后一句：原话"改完提交"、后面答了别的提问框，不算', !S.userSaid([H.tr.user('改完提交'), ...answer('发布方式？', 'A 方案')], 'commit').ok);
const p = H.makeRepo(path.join(h.work, 'project'), { 'pom.xml': '<project/>', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 修改 src/A.java；验：mvn compile\n' });
S.setFlow({ session_id: 'negative' }, true, '提案', 'plan');
const tf = H.transcript(path.join(h.root, 'a.jsonl'), [H.tr.user('不要执行 apply')]);
H.hook(h, 'task-anchor', { session_id: 'negative', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '不要执行 apply', transcript_path: tf });
H.ok('用户开口钩子不会把否定改成 apply', S.flowState({ session_id: 'negative' }).stage !== 'apply');
H.done('用户意图与许可');

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
const p = H.makeRepo(path.join(h.work, 'project'), { 'pom.xml': '<project/>', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 修改 src/A.java；验：mvn compile\n' });
S.setFlow({ session_id: 'negative' }, true, '提案', 'plan');
const tf = H.transcript(path.join(h.root, 'a.jsonl'), [H.tr.user('不要执行 apply')]);
H.hook(h, 'task-anchor', { session_id: 'negative', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '不要执行 apply', transcript_path: tf });
H.ok('用户开口钩子不会把否定改成 apply', S.flowState({ session_id: 'negative' }).stage !== 'apply');
H.done('用户意图与许可');

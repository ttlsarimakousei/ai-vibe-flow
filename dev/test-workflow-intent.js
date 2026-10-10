'use strict';
/* 话题、引用、否定不是许可。用真实公共判断与钩子核对，旧版参数应检出误授权。 */
const path = require('path');
const H = require('./lib/harness');
const h = H.makeHome('workflow-intent', process.argv[2], { autoMode: true });
const S = require(path.join(h.kit, 'lib/session.js'));
for (const text of ['不要执行 apply', 'apply 先缓缓', '不要开工', '先别开始实现', '取消开工', 'apply 机制有问题', 'apply 的时候是不是全自动', '怎么执行 apply？', '讨论 apply 命令', '之前说过开工，现在先别做', '> 开工', '```\napply\n```']) H.ok('不开工：' + text, !S.applyIntent(text));
for (const text of ['开工', '执行 apply', '按提案做', '照任务做', '开始实现', '把 1.1 做了', '/opsx:apply add-x']) H.ok('明确开工：' + text, S.applyIntent(text));
const cases = {
  commit: { no: ['提交机制有点乱，先分析一下', '之前的提交太频繁', '提交策略改一下', '提交之前给我看', '先别提交', '怎么提交？', '> 提交', '```\n提交\n```', '他说提交'], yes: ['提交', '改好了，提交', '提交提案', '可以提交', '把改动提交吧'] },
  archive: { no: ['归档逻辑有问题，先分析一下', '归档之后怎么看记录', '先别归档', '归档之前我还要自测', '归档了吗？', '讨论 archive'], yes: ['归档', '自测没问题，归档吧', '把日志那行去掉，然后再归档'] },
  push: { no: ['push 机制要优化', '先别推送', '怎么 push？', '推送我自己来', '> push'], yes: ['push', '推送', '提交和push', '及时提交并push'] },
};
for (const [topic, group] of Object.entries(cases)) for (const [expect, texts] of Object.entries(group)) for (const text of texts) H.ok(topic + ' ' + expect + '：' + text, S.userSaid([H.tr.user(text)], topic).ok === (expect === 'yes'));
const p = H.makeRepo(path.join(h.work, 'project'), { 'pom.xml': '<project/>', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 修改 src/A.java；验：mvn compile\n' });
S.setFlow({ session_id: 'negative' }, true, '提案', 'plan');
const tf = H.transcript(path.join(h.root, 'a.jsonl'), [H.tr.user('不要执行 apply')]);
H.hook(h, 'task-anchor', { session_id: 'negative', cwd: p, hook_event_name: 'UserPromptSubmit', prompt: '不要执行 apply', transcript_path: tf });
H.ok('用户开口钩子不会把否定改成 apply', S.flowState({ session_id: 'negative' }).stage !== 'apply');
H.done('用户意图与许可');

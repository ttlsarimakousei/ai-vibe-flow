'use strict';
/*
 * 认用户说法的语料测试（2026-10-30，docs/feedback-20261030.md 的 A6，审核 R5、M12）：一条说法该不该算"让它做这件事"。
 * 加一个新说法，先在这里加一行"应认"或"不应认"，再改 kit/lib/intent.js。认错（把问句、抱怨、否定当许可）比认漏更糟：
 * 认漏只是多问一次，认错就替用户做了决定。
 * 用法：node dev/test-intent-corpus.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const I = require(path.join(FROM || H.SRC, 'kit', 'lib', 'intent.js'));

const YES = {
  commit: ['提交', '提交吧', '帮我提交', '提交一下', '改完提交', '改完提交并推送', '修好再提交', '先提交', '可以提交了', '自测没问题，提交', 'git commit 一下'],
  push: ['推送', 'push', '推吧', '可以推送了', '提交并推送', '改完提交并推送', '修好再推送', '把这几笔推上去'],
  archive: ['归档', '归档吧', '可以归档了', '测完归档', '自测没问题，归档吧'],
  review: ['审一下', '审查', '全量审查', '用 ttls-reviewer 审一次', '修完审一下'],
  test: ['自测', '测一下', '全量自测', '把服务起起来', '跑一下测试', '看看页面'],
};
const NO = {
  commit: ['提交前我再看看', '先别提交', '提交策略是什么？', '要不要提交？', '提交有问题', '我自己提交', '不要提交', '提交了吗？', '审查报告里说提交信息不规范'],
  push: ['push 到哪个分支？', '先别推送', '推送失败了', '不要 push', '推送策略讲一下', '你推送了吗？', '推送前先让我看一眼'],
  archive: ['归档前先自测', '不要归档', '归档了吗？', '归档要怎么做？'],
  review: ['审查报告在哪', '不用审查', '审查有问题吗？'],
  test: ['测试用例写在哪', '不用测了', '测试失败了'],
};
H.section('应认：这些说法算让它做');
for (const [action, list] of Object.entries(YES)) for (const s of list) H.ok(action + ' 应认：' + s, I.explicit(s, action) === true);
H.section('不应认：问句、否定、延后、在说那件事本身');
for (const [action, list] of Object.entries(NO)) for (const s of list) H.ok(action + ' 不应认：' + s, I.explicit(s, action) === false);
H.done('认用户说法的语料');

'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 6 类：命令文字里引用了 review.js run 就当成要审查（旧第 5 类，#187 第 6 点）
 * 用法：node dev/test-feedback1024-review-command.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');

(async () => {
  const h = H.makeHome('feedback1024-review-command', process.argv[2], { reviewBudgetSeconds: 60 });
  const S = require(path.join(h.kit, 'lib/session'));
  const R = require(path.join(h.kit, 'lib/review-runner'));
  const F = require(path.join(h.kit, 'lib/flow-policy'));
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
  const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();

  H.section('旧第 5 类：命令文字里引用了 review.js run 不算要审查');
  const tf = H.transcript(path.join(h.root, 'a.jsonl'), [H.tr.user('把刚才被拦的情况记一条问题反馈')]);
  const j = (command) => ({ session_id: 's1', cwd: p, transcript_path: tf, tool_name: 'Bash', tool_input: { command }, tool_use_id: 't1' });
  const kit = (f) => path.join(h.kit, f).replace(/\\/g, '/');
  for (const c of ['node "' + kit('tools/feedback.js') + '" add --kind 误拦 --what "跑 node review.js run --change x 被人工模式拦下"', 'git commit -m "fix: 修 review.js run 的参数"', 'echo "node review.js run" > .vibe/tmp/x/note.txt'])
    H.ok('不拦：' + c.slice(0, 60), !F.actionIssue(j(c)), F.actionIssue(j(c)));
  for (const c of ['node "' + kit('tools/review.js') + '" run --mode code --project "' + p.replace(/\\/g, '/') + '" --base ' + base, 'node "$HOME/.claude/vibe-kit/tools/review.js" run --mode code --base ' + base])
    H.ok('真跑 review.js run：人工模式要许可', /先用 Ask 询问是否审查/.test(F.actionIssue(j(c))), F.actionIssue(j(c)));
  H.done('1024 反馈：审查命令');
})().catch((e) => { console.error(e); process.exit(1); });

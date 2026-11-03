'use strict';
/*
 * 审查子代理的结论在这里入账（SubagentStop，用户 2026-11-03 定的审查全部用子代理）。
 * 实测（docs/claude-code-facts.md）：2.1.120、2.1.259、2.1.289 的 last_assistant_message 都是全文，前台后台一样；
 * 回 decision: block 加 reason，子代理看到 reason 接着写。不用子代理多跑一次 Bash，每个角度省一次请求。
 * 只管 agent_type 是 ttls-reviewer 的。没写任务、JSON 不对就拦，同一个最多拦 2 次，再不对算没交（不算通过，下一次 prepare 只重开它）。
 * 出错放行（cli 记问题反馈）：放行等于这个角度没交，不会被记成通过。
 */
const { blockOut, cli, updateState } = require('../lib/session');

const FORMAT = '最后一条回复只写这两样：第一行 审查任务：<提示第三行的 id/角度>；后面一个 JSON 代码块，例：{"issues":[{"severity":"P2","file":"src/A.java","line":45,"problem":"批量查询前没判断空列表","evidence":"传空列表时拼出 in ()，数据库报语法错","fix":"空列表直接返回","kind":"边界","avoid":"按一批 id 查询之前：先判断列表是不是空的","scope":"in"}],"summary":"看了什么、没看什么"}。没问题 issues 写 []。';

function handle(j) {
  if (!/(^|:)ttls-reviewer$/.test(String(j.agent_type || ''))) return null;
  const R = require('../lib/review-runner');
  const text = String(j.last_assistant_message || '');
  const m = /审查任务\s*[:：]\s*([0-9a-f]{24})\/([^\s`"，。]+)/.exec(text);
  if (!m) {
    let n = 0;
    if (j.session_id) updateState(String(j.session_id) + '-review-bare', (o) => { const k = String(j.agent_id || 'x'); o[k] = (o[k] || 0) + 1; n = o[k]; });
    return n <= 2 ? blockOut('SubagentStop', '[vibe-kit 审查] 没认出这是哪个审查任务。' + FORMAT) : null;
  }
  const r = R.submit(m[1], m[2], text);
  if (r.ok) return null;
  if (R.noteReject(m[1], m[2]) <= 2) return blockOut('SubagentStop', '[vibe-kit 审查] ' + r.error + '。' + FORMAT);
  R.failLens(m[1], m[2], r.error);
  return null;
}

module.exports = { handle };
if (require.main === module) cli(handle);

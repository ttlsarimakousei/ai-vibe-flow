'use strict';
/*
 * PreToolUse 钩子（AskUserQuestion、Skill、SlashCommand）。
 *   AskUserQuestion：全自动模式开着、这个会话又正走着 OpenSpec 流程时，不许用提问框问用户。
 *     提问框会一直等人回答，这时 Stop 钩子管不到，全自动挂一夜就停在那里。
 *     不在流程里（另开的窗口做检索、答问题）照常能问：那时候人在。开关每次现读，配置页里一改就生效。
 *   Skill / SlashCommand：模型自己调了 OpenSpec 的技能（用户用大白话让它出提案、接着做）——全自动模式开着的话，
 *     这个会话从这时起算进了 OpenSpec 流程。只记一笔，不拦。
 */
const { readConfigFor, setFlow, FLOW_SKILL, blockOut, hookLog, cli } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

function handle(j) {
  if (/^(Skill|SlashCommand)$/.test(String((j && j.tool_name) || ''))) {
    try {
      const inp = j.tool_input || {};
      const name = String(inp.skill || inp.command || inp.name || '');
      const cfg = readConfigFor(j);
      if (cfg.autoSwitch && !cfg.autoMode && FLOW_SKILL.test(name)) { setFlow(j, true, '调了 ' + name.trim().split(/\s+/)[0]); hookLog('全自动模式 这个会话进了 OpenSpec 流程：调了 ' + name.trim().slice(0, 40)); }
    } catch (e) { /* 记不了不影响调技能 */ }
    return null;
  }
  if (!readConfigFor(j).autoMode) return null;
  hookLog('guard-ask block AskUserQuestion (autoMode)');
  // 它想问什么记下来：进全自动报告，用户回来能看到
  try {
    const qs = (j && j.tool_input && j.tool_input.questions) || [];
    if (report) for (const q of Array.isArray(qs) ? qs : []) {
      const opts = Array.isArray(q && q.options) ? q.options.map((o) => String((o && (o.label || o.description)) || o || '')).filter(Boolean) : [];
      report.note(j, { kind: 'ask', title: String((q && (q.question || q.header)) || '（没写问题）'), detail: opts.join(' / ') });
    }
  } catch (e) { /* 记不了不影响 */ }
  return blockOut('PreToolUse', '[vibe-kit] 全自动模式：我不在，提问框没人答，活会停在这里。你想问的已经记进全自动报告，我回来会看到。现在自己定，然后接着做：能查的先查（代码、库、接口、日志、文档）；查不到的选推荐的、影响面最小的那个，记进 revisions.md（起因：自动模式决定）。要我动手的事（查库的工具不肯执行的改库操作、改 redis 里的数据、改公共配置、动 git 历史、push、要账号密码）：不做也不等，在那项任务后面加上"（留给用户：原因）"，不打勾，接着做不依赖它的。');
}

module.exports = { handle };
if (require.main === module) cli(handle);

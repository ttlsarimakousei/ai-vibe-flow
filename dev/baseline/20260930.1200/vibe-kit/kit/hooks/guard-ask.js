'use strict';
/*
 * PreToolUse 钩子（AskUserQuestion）：全自动模式开着时，不许用提问框问用户。
 * 提问框会一直等人回答，这时 Stop 钩子管不到，全自动挂一夜就停在那里。
 * 开关就是全自动模式本身（config.json 的 autoMode），每次现读：配置页里一打开就生效，不用重开会话、不用 /clear。
 */
const { readConfig, blockOut, hookLog, cli } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

function handle(j) {
  if (!readConfig().autoMode) return null;
  hookLog('guard-ask block AskUserQuestion (autoMode)');
  // 它想问什么记下来：进全自动报告，用户回来能看到
  try {
    const qs = (j && j.tool_input && j.tool_input.questions) || [];
    if (report) for (const q of Array.isArray(qs) ? qs : []) {
      const opts = Array.isArray(q && q.options) ? q.options.map((o) => String((o && (o.label || o.description)) || o || '')).filter(Boolean) : [];
      report.note(j, { kind: 'ask', title: String((q && (q.question || q.header)) || '（没写问题）'), detail: opts.join(' / ') });
    }
  } catch (e) { /* 记不了不影响 */ }
  return blockOut('PreToolUse', '[vibe-kit] 全自动模式：我不在，提问框没人答，活会停在这里。你想问的已经记进全自动报告，我回来会看到。现在自己定，然后接着做：能查的先查（代码、库、接口、日志、文档）；查不到的选推荐的、影响面最小的那个，记进 revisions.md（起因：自动模式决定）。要我动手的事（改数据库里的数据、删数据、改公共配置、动 git 历史、push、要账号密码）：不做也不等，在那项任务后面加上"（留给用户：原因）"，不打勾，接着做不依赖它的。');
}

module.exports = { handle };
if (require.main === module) cli(handle);

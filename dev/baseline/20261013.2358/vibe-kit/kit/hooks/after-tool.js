'use strict';
/* 工具完成后的本机记账入口。只记可核对的结果；失败、取消和未知结果不消费用户许可，也不算通过验证。 */
const S = require('../lib/session');
function successful(j) {
  if (j.hook_event_name !== 'PostToolUse') return false;
  const r = j.tool_response;
  if (!r || typeof r !== 'object' || r.isError || r.is_error || r.interrupted || r.error || r.isRunning || r.is_running || r.background_task_id || r.task_id || r.session_id) return false;
  const code = r.exit_code !== undefined ? r.exit_code : r.exitCode;
  if (code !== undefined && Number(code) !== 0) return false;
  const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
  return !/^(?:Exit code|Process exited with code):?\s*[1-9]\d*\s*$/im.test(out);
}
function handle(j) {
  try {
    require('../lib/invocation').phase('登记操作许可');
    require('../lib/permissions').consume(j, successful(j));
    if (successful(j)) {
      if (/^(Agent|Task|SendMessage|TaskOutput|TaskResult)$/.test(j.tool_name)) require('../lib/review-runner').syncAgent(j);
      const merge = require('../lib/merge-push');
      merge.consumePreview(j);
      const preview = merge.recordPreview(j);
      if (preview) return preview;
    }
    // 验证证据与 IDEA 完成结果共用此入口；模块升级不同步时保持原工具结果。
    try { require('../lib/invocation').phase('登记验证证据'); require('../lib/evidence').recordTool(j, successful(j)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool 验证证据', j, e); }
    if (j.hook_event_name === 'PostToolUse' && require('../lib/idea-tools').isIdea(j.tool_name)) {
      const safe = require('../lib/redact').tree(j.tool_response);
      if (JSON.stringify(safe) !== JSON.stringify(j.tool_response)) return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: safe, updatedMCPToolOutput: safe } };
    }
    return null;
  } catch (e) { try { require('../lib/feedback').recordHookError('after-tool', j, e); } catch (ignored) { /* 记不了也放行 */ } return null; }
}
if (require.main === module) S.cli(handle);
module.exports = { handle, successful };

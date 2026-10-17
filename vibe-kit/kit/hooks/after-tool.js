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
/** OpenSpec 不认识这条指令时的提示：用的是套件自带的那份，还是 Node 不够、退回了项目自己装的那份 */
function openspecHint() {
  let bundled = false; let kit = null;
  try { const O = require('../lib/openspec'); bundled = O.usable(); kit = O.info(); } catch (e) { bundled = false; kit = null; }
  const check = '先运行 openspec --version 和 openspec --help 核对版本与可用命令，按 help 里有的指令改写。不要重复执行不支持的指令。';
  if (bundled) return '当前 OpenSpec（套件自带的 ' + kit.version + '）不支持这条指令。' + check;
  if (kit) return '当前用的是项目自己装的 OpenSpec：这台电脑的 Node 是 ' + process.versions.node + '，套件自带的 OpenSpec ' + kit.version + ' 要 Node ' + kit.node + '，用不了。它不支持这条指令。' + check + '向用户说明：把 Node 升到 ' + kit.node.replace(/^>=\s*/, '') + ' 以上就会自动用套件自带的；不升 Node 就按原来的安装方式升级项目里的 OpenSpec。';
  return '当前用的是项目自己装的 OpenSpec（套件自带的那份不在，安装可能不完整），它不支持这条指令。' + check + '向用户说明：重装 vibe-kit 就会用套件自带的；或者按原来的安装方式升级项目里的 OpenSpec。';
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
    const cmd = String(j.tool_input && j.tool_input.command || '');
    // 失败的命令走 PostToolUseFailure，顶层是 error、没有 tool_response（docs/claude-code-facts.md 三版实测；2026-10-17 审核问题 11）
    const output = String(j.tool_response && (j.tool_response.stderr || j.tool_response.stdout || j.tool_response.error) || j.error || '');
    if (/\bopenspec\b/i.test(cmd) && /unknown command|unknown option|不支持.*(?:指令|命令)|未知.*(?:指令|命令)/i.test(output)) return { hookSpecificOutput: { hookEventName: j.hook_event_name || 'PostToolUse', additionalContext: openspecHint() } };
    return null;
  } catch (e) { try { require('../lib/feedback').recordHookError('after-tool', j, e); } catch (ignored) { /* 记不了也放行 */ } return null; }
}
if (require.main === module) S.cli(handle);
module.exports = { handle, successful, openspecHint };

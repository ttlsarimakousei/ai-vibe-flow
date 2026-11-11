'use strict';
/*
 * 工具完成后的本机记账入口。只记可核对的结果；失败、取消和未知结果不消费用户许可，也不算通过验证。
 * 2026-11-01 起（K3）还给模型送几句话（additionalContext），都只在有话说时才送：
 *   编译、测试命令失败：第一个错误、文件:行、前后 5 行源码（lib/fail-summary.js）
 *   改了 .sql、Mapper XML：和查库技能存的表结构对不上的表名、列名（lib/sql-check.js，只提醒）
 *   开始走 OpenSpec 了还没拿到规范：送规范（lib/stage-rules.js）
 * 还记一笔"命令失败 → 改了文件 → 同一条命令再跑通过"，够条件的成经验规则候选（lib/fix-pass.js），不送话。
 */
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
    // 验证证据；模块升级不同步时保持原工具结果。
    try { require('../lib/invocation').phase('登记验证证据'); require('../lib/evidence').recordTool(j, successful(j)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool 验证证据', j, e); }
    // 做任务时需求文档改了：落盘之后马上比指纹、按规矩重定范围（第 76 条：以前要到下一次改文档才发现，中间状态栏和拦截对不上）
    // 只在这次可能动到需求文档时比（复审 P3-13）：改的文件在 openspec/changes 下，或者命令里提到 openspec；失败的不比
    let scopeNote = '';
    try {
      const st = S.flowState(j);
      if (st.on && st.applyScope && successful(j)) {
        const A = require('../lib/apply-scope');
        const touched = /^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || '')) ? /[\\/]openspec[\\/]changes[\\/]/i.test(String(j.tool_input && j.tool_input.file_path || '')) : /^(Bash|PowerShell)$/.test(String(j.tool_name || '')) && /openspec/i.test(String(j.tool_input && j.tool_input.command || ''));
        if (touched) A.settle(j);
        // 开工不是用户打字说的（提问框选开工、自动开工）：没经过开口钩子，这里补说一次
        const d = A.dirtyNote(j); if (d) scopeNote = '[vibe-kit 提醒] ' + d.model;
      }
    } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'VIBE_HOOK_BUDGET') require('../lib/feedback').recordHookError('after-tool 开工范围', j, e); }
    // 编辑工具改成功的文件记到现在在做的 change 上：代码审查只收这个 change 的文件（第 77 条，lib/flow-policy.js 的 changeScope）
    try {
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(String(j.tool_name || '')) && successful(j) && S.flowState(j).on) require('../lib/flow-policy').noteEdit(j, (j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || '');
    } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'VIBE_HOOK_BUDGET') require('../lib/feedback').recordHookError('after-tool 记改过的文件', j, e); }
    // 改了 tasks.md：这个大任务里全勾完的 change 记成做完过（第 81、84 条：之后再补任务就是回改，不抢当前 change）
    try {
      const tf = String((j.tool_input && j.tool_input.file_path) || '');
      if (/^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || '')) && successful(j) && /[\\/]openspec[\\/]changes[\\/][^\\/]+[\\/]tasks\.md$/i.test(tf)) { const B = require('../lib/big-task'); const a = S.artifactOf(tf); const t = a ? B.ofChange(j.cwd || a.root, a.dir) : null; if (t) B.finishedMap(t); }
    } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'VIBE_HOOK_BUDGET') require('../lib/feedback').recordHookError('after-tool 记做完过的 change', j, e); }
    const cmd = String(j.tool_input && j.tool_input.command || '');
    // 失败的命令走 PostToolUseFailure，顶层是 error、没有 tool_response（docs/claude-code-facts.md 三版实测；2026-10-17 审核问题 11）
    const output = String(j.tool_response && (j.tool_response.stderr || j.tool_response.stdout || j.tool_response.error) || j.error || '');
    if (/\bopenspec\b/i.test(cmd) && /unknown command|unknown option|不支持.*(?:指令|命令)|未知.*(?:指令|命令)/i.test(output)) return { hookSpecificOutput: { hookEventName: j.hook_event_name || 'PostToolUse', additionalContext: openspecHint() } };
    // 命令失败 → 改了文件 → 同一条命令再跑通过：记一条经验规则候选（K3 M11，lib/fix-pass.js）。只记账，不影响工具结果
    try {
      const FP = require('../lib/fix-pass');
      if (/^(Bash|PowerShell)$/.test(String(j.tool_name || ''))) { if (successful(j)) FP.passed(j); else FP.failed(j); }
      else if (/^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || '')) && successful(j)) FP.edited(j);
    } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool 经验候选', j, e); }
    // 编译、测试命令失败：第一个错误、文件:行、前后 5 行源码作为摘要送给模型（K3 M08，lib/fail-summary.js）。成功的什么都不加
    const notes = [];
    if (scopeNote) notes.push(scopeNote);
    if (/^(Bash|PowerShell)$/.test(String(j.tool_name || '')) && !successful(j)) { try { const s = require('../lib/fail-summary').summarize(j); if (s) notes.push(s); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool 失败摘要', j, e); } }
    // 改了 .sql、Mapper XML：拿查库技能存的表结构缓存核对表名、列名，对不上提醒一句，不拦（K3 M10，lib/sql-check.js）
    if (/^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || '')) && successful(j)) { try { const s = require('../lib/sql-check').hintFor(j); if (s) notes.push(s); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool 表结构核对', j, e); } }
    // 需求文档写齐了：钩子自己跑 openspec validate --strict，没过把报错送给模型，过了说一句不用再跑（第 71 条第 1 点，lib/spec-validate.js）
    if (/^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || '')) && successful(j)) { try { const s = require('../lib/spec-validate').check(j); if (s) notes.push(s); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'VIBE_HOOK_BUDGET') require('../lib/feedback').recordHookError('after-tool openspec validate', j, e); } }
    // 模型没经过提需求、/opsx 这些入口就开始走 OpenSpec：规范这时候送（J4，lib/stage-rules.js，一个会话一次）
    try { const SR = require('../lib/stage-rules'); if (SR.touchesOpenspec(j)) { const s = SR.openspecOnce(j); if (s) notes.push('[vibe-kit 提醒] ' + s); } } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') require('../lib/feedback').recordHookError('after-tool OpenSpec 规范', j, e); }
    if (notes.length) return { hookSpecificOutput: { hookEventName: j.hook_event_name || 'PostToolUse', additionalContext: notes.join('\n\n') } };
    return null;
  } catch (e) { try { require('../lib/feedback').recordHookError('after-tool', j, e); } catch (ignored) { /* 记不了也放行 */ } return null; }
}
if (require.main === module) S.cli(handle);
module.exports = { handle, successful, openspecHint };

'use strict';
/* IDEA MCP 的入口适配：终端沿用 guard-commit，读文件和搜索沿用令牌保护，
 * 能还原成单文件编辑的操作沿用 pre-edit。批量补丁、脚本和数据库入口不替代既有保护。
 * 只识别已登记的 IDEA 和惯用的 jetbrains 名字，不把其它 MCP 的同名工具当成 IDEA。
 * 工具路由的命令必须明确，解析不了的请换正式工具或普通工具，不把原始参数写日志。
 */
const path = require('path');
const { fileURLToPath } = require('url');
const S = require('./session');
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
function route(command) {
  const raw = String(command || '').trim();
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/g) || [];
  if (tokens.join(' ').replace(/\s+/g, '') !== raw.replace(/\s+/g, '')) return null;
  const decode = t => t.startsWith('"') ? JSON.parse(t) : t.startsWith("'") ? t.slice(1, -1) : t;
  try {
    const name = tokens.shift(); if (!/^[a-z][a-z_0-9]*$/.test(name || '')) return null;
    const input = {};
    while (tokens.length) {
      const flag = tokens.shift(), match = /^--([a-zA-Z_]\w*)$/.exec(flag);
      if (!match || !tokens.length || Object.prototype.hasOwnProperty.call(input, match[1])) return null;
      input[match[1]] = decode(tokens.shift());
    }
    return { name, input };
  } catch (e) { return null; }
}
function denied(msg, j) {
  try { require('./feedback').countBlock('guard-commit', '[vibe-kit IDEA MCP] ' + msg, String(j.session_id || '')); } catch (e) { /* 计数不影响检查 */ }
  return S.blockOut('PreToolUse', '[vibe-kit IDEA MCP] ' + msg);
}
function isIdea(tool) {
  const m = /^mcp__(.+)__([a-zA-Z_0-9]+)$/.exec(String(tool || '')); if (!m) return false;
  const st = S.readState('idea-mcp'); const names = ['jetbrains', ...Object.keys(obj(st.owned) ? st.owned : {}), ...(Array.isArray(st.connections) ? st.connections : []).filter(obj).map(c => c.name)];
  return /^vibe[-_]idea[-_]\d+$/.test(m[1]) || names.some(n => n === m[1] || String(n).replace(/-/g, '_') === m[1]);
}
function capabilities() { return { supported: ['execute_terminal_command', 'get_file_problems', 'get_file_text_by_path', 'replace_text_in_file', 'execute_run_configuration'], connection: require('./idea-mcp').status().status, limitations: '只使用已明确的 projectPath 和现有运行配置；不接管 IDEA 用户自己启动的进程，不执行脚本、数据库入口或运行参数覆盖。索引就绪需工具真实结果核对。' }; }
function handle(j) {
  const m = /^mcp__(.+)__([a-zA-Z_0-9]+)$/.exec(String(j.tool_name || ''));
  if (!m) return null;
  const st = S.readState('idea-mcp');
  const names = ['jetbrains', ...Object.keys(obj(st.owned) ? st.owned : {}), ...(Array.isArray(st.connections) ? st.connections : []).filter(obj).map(c => c.name)];
  if (!/^vibe[-_]idea[-_]\d+$/.test(m[1]) && !names.some(n => n === m[1] || String(n).replace(/-/g, '_') === m[1])) return null;
  let name = m[2], input = obj(j.tool_input) ? j.tool_input : {};
  if (name === 'execute_tool') {
    const r = route(input.command);
    if (!r) return denied('工具路由参数没有解析清楚。写成 工具名 --参数 "值"；路径用正斜杠，不把复杂脚本塞进路由参数。', j);
    if (r.input.projectPath && input.projectPath && path.resolve(r.input.projectPath) !== path.resolve(input.projectPath)) return denied('路由内外的 projectPath 不一致，请只指定同一个项目。', j);
    name = r.name; input = Object.assign({}, r.input, input.projectPath ? { projectPath: input.projectPath } : {});
  }
  if (typeof input.projectPath !== 'string' || !path.isAbsolute(input.projectPath)) return denied('请在 MCP 参数里明确 projectPath，填要操作的项目完整路径，避免用到 IDEA 当前打开的另一个项目。', j);
  const cwd = input.projectPath;
  const next = (tool, args) => Object.assign({}, j, { cwd, tool_name: tool, tool_input: args });
  const G = require('../hooks/guard-commit');
  if (name === 'execute_terminal_command') {
    // IDEA 的终端可能是 Bash 或 PowerShell，两种解析都检查，任意一种拦下就停止。
    const args = { command: String(input.command || '') };
    return G.handle(next('Bash', args)) || G.handle(next('PowerShell', args));
  }
  // IDEA 查库不带套件的开发环境筛选、确认串和改前快照，写操作和连接配置继续走查库技能。
  if (/(?:sql|database|query)/i.test(name)) return denied('数据库操作继续用 /ttls-db-crud，保留开发环境筛选、写入确认和改前快照，不用 IDEA MCP 直接执行。', j);
  if (name === 'get_run_configurations' && !input.filePath) return denied('运行配置的完整返回可能含环境变量口令。先由用户提供配置名，再用 execute_run_configuration；不要把整份配置读进会话。', j);
  if (['run_inspection_kts', 'apply_patch', 'xdebug_evaluate_expression', 'xdebug_set_variable'].includes(name)) return denied('这个脚本、批量修改或表达式入口尚未适配套件检查。文件修改用 Edit / Write，命令用 Bash / PowerShell，调试先用断点、变量和调用栈查询。', j);
  const fileArgs = ['file_path', 'pathInProject', 'filePath', 'path'].filter(k => input[k] !== undefined && input[k] !== null && input[k] !== '');
  // 不让一个伪造的路径字段盖过实际工具使用的另一个字段。
  if (new Set(fileArgs.map(k => String(input[k]))).size > 1) return denied('文件路径参数不一致，请只使用这个工具的正式路径参数。', j);
  const rawFile = fileArgs.length ? input[fileArgs[0]] : '';
  let file = String(rawFile);
  if (/^file:/i.test(file)) { try { file = fileURLToPath(file); } catch (e) { return denied('文件地址没有解析清楚，请用项目相对路径或完整文件路径。', j); } }
  else if (/^[a-z][a-z0-9+.-]+:/i.test(file)) return denied('这个文件地址协议尚未适配检查，请用项目相对路径或完整文件路径。', j);
  if (file) file = path.resolve(cwd, S.expandHome(file));
  const checkRead = file => {
    // 用户级配置可能带其它 MCP 的认证信息；不要经 IDEA 读入会话。
    const base = S.normKey(S.realish(file));
    const configs = [path.join(S.CFG_DIR, '.claude.json'), path.join(path.dirname(S.CFG_DIR), '.claude.json')];
    if (configs.some(f => { const key = S.normKey(S.realish(f)); return key === base || key.startsWith(base + '/'); })) return denied('Claude Code 用户配置可能带认证信息，连接状态请看配置页或 /mcp，不读取配置原文。', j);
    return require('../hooks/guard-read').handle(next('Grep', { path: file, output_mode: 'content' }));
  };
  if (['xdebug_set_breakpoint', 'xdebug_update_breakpoint'].includes(name)) {
    if (input.condition || input.logExpression || input.logMessage) return denied('带表达式的断点尚未适配检查，请先用普通断点。', j);
    return checkRead(file || cwd);
  }
  if (name === 'get_run_configurations' && input.filePath) return checkRead(file || cwd);
  if (['read_file', 'get_file_text_by_path'].includes(name)) return checkRead(file || cwd);
  if (/^(search_|find_|skill_search|get_symbol_info|analyze_calls|get_file_problems|lint_files|build_project|xdebug_get_|xdebug_list_|xdebug_control_session)/.test(name)) {
    const scope = checkRead(cwd); if (scope) return scope;
    if (file) { const r = checkRead(file); if (r) return r; }
    // 编译、检查的文件列表也可能是项目外的绝对路径。
    for (const key of ['paths', 'files', 'filesToRebuild']) {
      let list = input[key];
      if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { return denied('文件列表没有解析清楚，请用 JSON 数组或直接调用正式工具。', j); } }
      if (Array.isArray(list)) for (const p of list) { const r = checkRead(path.resolve(cwd, String(p))); if (r) return r; }
    }
    return null;
  }
  if (['create_new_file', 'replace_text_in_file', 'rename_refactoring', 'reformat_file'].includes(name)) {
    if (!file) return denied('编辑没有明确文件路径，请改用 Edit / Write。', j);
    const noRead = checkRead(file); if (noRead) return noRead;
    if (name === 'rename_refactoring' || name === 'reformat_file') {
      const scope = checkRead(cwd); if (scope) return scope;
      // 这些操作没有修改后的完整文本，不能用来绕过任务打勾和提案检查。
      if (/(^|[\\/])(openspec|\.vibe|\.claude)([\\/]|$)|(^|[\\/])(CLAUDE|AGENTS)\.md$/i.test(file)) return denied('提案、任务和套件约定的修改需要检查修改后的文字，请改用 Edit / Write。', j);
    }
    return require('../hooks/pre-edit').handle(next(name === 'create_new_file' ? 'Write' : 'Edit', { file_path: file, content: input.text, old_string: input.oldText, new_string: input.newText || input.newName || '' }));
  }
  if (['execute_run_configuration', 'xdebug_start_debugger_session'].includes(name)) {
    if (['programArguments', 'workingDirectory', 'envs'].some(k => input[k] !== undefined && input[k] !== null && input[k] !== '')) return denied('运行参数覆盖尚未适配提交、口令和命令检查。这版先沿用 IDEA 已有运行配置的参数；临时命令继续用 Bash / PowerShell。', j);
    const scope = checkRead(cwd); return scope || (file ? checkRead(file) : null);
  }
  if (['get_project_modules', 'get_project_dependencies', 'get_repositories', 'git_status', 'get_all_open_file_paths', 'open_file_in_editor', 'list_directory_tree'].includes(name)) return checkRead(cwd) || (file ? checkRead(file) : null);
  return denied('这个 IDEA 工具尚未适配套件检查，请用已有的普通工具完成同一步。', j);
}
module.exports = { handle, route, isIdea, capabilities };

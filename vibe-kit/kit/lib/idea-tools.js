'use strict';
/*
 * IDEA MCP 的入口：只留和普通工具一样的检查（用户 2026-10-25 定的，问题反馈表第 1、3、4 条）。
 * 2026-10-28 起套件不再登记 IDEA 的 MCP、不再用它起服务（用户定的）；用户自己登记的（名字 jetbrains，或者老版本留下的 vibe-idea-<端口>）照下面查。
 *   终端命令按 Bash / PowerShell 查（push 要确认、结束路由、整仓 add 这类，guard-commit）；
 *   改文件按 Edit / Write 查（改套件、编码、提案门槛、产出位置，pre-edit）；
 *   读套件的令牌文件、Claude Code 的用户配置（.claude.json，带别的 MCP 的认证信息）照拦（硬规矩第 6 条）。
 *   别的都不拦：没写 projectPath 的按会话目录算；查库工具、整份运行配置、运行参数覆盖、脚本、批量补丁、带表达式的断点、
 *   名单外的工具都放行（以前一律"这个 IDEA 工具尚未适配套件检查"）。IDEA 工具的返回也不再遮口令（after-tool）。
 *   跑运行配置照旧算自测，人工模式先问（lib/flow-policy.js，和 Bash 跑测试一样）。
 * 只认惯用的 jetbrains 名字和老版本的 vibe-idea-<端口>，不把其它 MCP 的同名工具当成 IDEA。
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
// IDEA 内置 MCP 特有的工具名：用户自己登记、名字不叫 jetbrains 的也认得（套件不再记登记名，令牌保护只能收紧，硬规矩第 6 条）
const IDEA_TOOLS = new Set(['execute_terminal_command', 'get_file_text_by_path', 'replace_text_in_file', 'create_new_file', 'rename_refactoring', 'reformat_file', 'get_file_problems', 'execute_run_configuration', 'get_run_configurations', 'xdebug_start_debugger_session', 'get_project_modules', 'build_project']);
function isIdea(tool) {
  const m = /^mcp__(.+)__([a-zA-Z_0-9]+)$/.exec(String(tool || '')); if (!m) return false;
  return /^vibe[-_]idea[-_]\d+$/.test(m[1]) || m[1] === 'jetbrains' || IDEA_TOOLS.has(m[2]);
}
// 套件令牌、模型配置、Claude Code 用户配置的路径：解析不了参数时，看原文里有没有点到它们
const SECRET_MSG = '读的范围里有套件的令牌、模型的 key 或 Claude Code 的用户配置（带别的 MCP 的认证信息），内容不能读进会话。缩小到要看的那个文件或目录；令牌、模型、连接配没配好让用户看配置页或 /mcp。';
function secretMention(text) { return /secrets\.json|router-data|\.claude\.json/i.test(String(text || '')); }
const FILE_KEYS = ['file_path', 'pathInProject', 'filePath', 'path'];
function handle(j) {
  const m = /^mcp__(.+)__([a-zA-Z_0-9]+)$/.exec(String(j.tool_name || ''));
  if (!m) return null;
  // 认不出是 IDEA 的 MCP：只查写明的路径参数读不读套件令牌（以前靠套件的登记名认 IDEA，登记去掉后用户自己起的名字认不出，令牌保护不能因此放松）
  const ide = isIdea(j.tool_name);
  let name = m[2], input = obj(j.tool_input) ? j.tool_input : {};
  const outer = input.projectPath;
  if (ide && name === 'execute_tool') {
    const r = route(input.command);
    // 路由参数解析不了：不拦，只看原文里有没有套件令牌、用户配置的路径
    if (!r) return secretMention(input.command) ? denied(SECRET_MSG, j) : null;
    name = r.name; input = Object.assign({}, r.input, input.projectPath && !r.input.projectPath ? { projectPath: input.projectPath } : {});
  }
  // 没写 projectPath 的按会话目录算；路由内外写的不一样，两个都查
  const resolve = (p) => path.isAbsolute(p) ? p : path.resolve(j.cwd || process.cwd(), p);
  const projects = [...new Set([input.projectPath, outer].filter(p => typeof p === 'string' && p.trim()).map(resolve))];
  const cwd = projects[0] || path.resolve(j.cwd || process.cwd());
  const next = (tool, args, dir) => Object.assign({}, j, { cwd: dir || cwd, tool_name: tool, tool_input: args });
  const G = require('../hooks/guard-commit');
  if (ide && name === 'execute_terminal_command') {
    // IDEA 的终端可能是 Bash 或 PowerShell，两种解析都检查，任意一种拦下就停止（和普通命令一样的检查）
    const args = { command: String(input.command || '') };
    return G.handle(next('Bash', args)) || G.handle(next('PowerShell', args));
  }
  const checkRead = (file) => {
    // Claude Code 用户配置可能带其它 MCP 的认证信息；不要经 IDEA 读入会话
    const base = S.normKey(S.realish(file));
    const configs = [path.join(S.CFG_DIR, '.claude.json'), path.join(path.dirname(S.CFG_DIR), '.claude.json')];
    if (configs.some(f => { const key = S.normKey(S.realish(f)); return key === base || key.startsWith(base + '/'); })) return denied(SECRET_MSG, j);
    const r = require('../hooks/guard-read').handle(next('Grep', { path: file, output_mode: 'content' }));
    return r ? denied(SECRET_MSG, j) : null;
  };
  // 每个路径字段、每个文件列表里的路径都查读令牌；不认识的协议（不是本机文件）不查
  const files = [];
  const addFile = (v) => {
    let f = String(v);
    if (/^file:/i.test(f)) { try { f = fileURLToPath(f); } catch (e) { return; } }
    else if (/^[a-z][a-z0-9+.-]+:/i.test(f) && !/^[a-z]:[\\/]/i.test(f)) return;
    files.push(path.resolve(cwd, S.expandHome(f)));
  };
  for (const k of FILE_KEYS) if (input[k] !== undefined && input[k] !== null && input[k] !== '') addFile(input[k]);
  for (const key of ['paths', 'files', 'filesToRebuild']) {
    let list = input[key];
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = [list]; } }
    if (Array.isArray(list)) for (const p of list) addFile(p);
  }
  for (const p of projects.length ? projects : ide ? [cwd] : []) { const r = checkRead(p); if (r) return r; }
  for (const f of files) { const r = checkRead(f); if (r) return r; }
  if (!ide) return null;
  // 改文件：和 Edit / Write 一样查（改套件、编码、提案门槛、产出位置）。几个路径字段写得不一样的，每个都查
  if (['create_new_file', 'replace_text_in_file', 'rename_refactoring', 'reformat_file'].includes(name)) {
    for (const f of [...new Set(files)]) {
      const out = require('../hooks/pre-edit').handle(next(name === 'create_new_file' ? 'Write' : 'Edit', { file_path: f, content: input.text, old_string: input.oldText || '', new_string: input.newText || input.newName || '' }));
      if (out) return out;
    }
    return null;
  }
  // 批量补丁：补丁里点到的文件，和 Edit 一样查改套件、提案产物（改提案产物要看改完的文字，用 Edit / Write）
  if (name === 'apply_patch') {
    const text = String(input.input || input.patch || input.text || '');
    const touched = [...text.matchAll(/^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?|--- (?:a\/)?)(.+)$/gm)].map(x => x[1].trim()).filter(x => x && x !== '/dev/null');
    for (const t of touched) {
      const f = path.resolve(cwd, t);
      const kit = require('../hooks/guard-kit').handle(next('Edit', { file_path: f, old_string: '', new_string: '' }));
      if (kit) return kit;
      if (S.artifactOf(f)) return denied('补丁改到了 OpenSpec 产物（' + t + '）：提案、任务清单的修改要看改完的文字，改用 Edit / Write。', j);
    }
    return null;
  }
  return null;
}
module.exports = { handle, route, isIdea };

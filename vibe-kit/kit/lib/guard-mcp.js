'use strict';
/*
 * MCP 工具的令牌保护（硬规矩第 6 条，只能收紧）。套件不接任何 MCP，这里不认工具名，所有 mcp__ 工具四层：
 *   1. 所有字段里像路径的值（不看字段名，含 file: 网址，相对路径按 cwd 和同一次调用的 projectPath 都算一遍）：范围里有套件令牌、模型 key、Claude Code 用户配置的拦（和 guard-read 同一套判断）；
 *   2. tool_input 原文点到 secrets.json、router-data、.claude.json 的拦；
 *   3. command、script 这类字段按 Bash、PowerShell 各查一遍安全检查：目录级 grep -r x ~/.claude/vibe-kit 不带文件名，第 2 层认不出；
 *   4. 落在套件目录里的一律拦（改套件）。读也拦：套件目录里的东西不是工作对象，要看用 Read。
 * 别的都放行：终端命令不按 Bash 的规矩查（push 确认、整仓 add 这些），改文件不按 Edit 的规矩查，运行配置不算自测（用户 2026-11-03 定的，第 48 条）。
 */
const path = require('path');
const { fileURLToPath } = require('url');
const S = require('./session');

const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const SECRET_MSG = '范围里有套件的令牌、模型的 key 或 Claude Code 的用户配置（带别的 MCP 的认证信息），内容不能读进会话。缩小到要看的那个文件或目录；令牌、连接配置没问题的话，这些文件也不用看。';
const KIT_MSG = '路径在套件目录里（~/.claude/vibe-kit）：这是用户的东西，不是工作对象，不能经 MCP 工具读写。';
// 字段名看着是路径的，值是 . 这种也算；别的字段值里有斜杠、~、盘符才算（字段名列不全：directoryToSearch、folder 这些，复审 20261104 R3）
const PATH_KEYS = /path|dir|folder|file|root|cwd|uri|url|target|source/i;
const looksPath = (k, v) => { const s = String(v).trim(); if (!s || s.length > 2000 || /[\r\n]/.test(s)) return false; return PATH_KEYS.test(k) || /[\\/]/.test(s) || /^~/.test(s) || /^[a-z]:/i.test(s); };
const COMMAND_KEYS = /^(?:command|cmd|script|shell)$/i;
function denied(msg, j) {
  try { require('./feedback').countBlock('guard-commit', '[vibe-kit MCP] ' + msg, String(j.session_id || '')); } catch (e) { /* 计数不影响检查 */ }
  return S.blockOut('PreToolUse', '[vibe-kit MCP] ' + msg);
}
/** 把 tool_input 里所有字段摊开：[键, 字符串值]。值是 JSON 数组字符串的也拆开（有的工具把文件列表写成字符串） */
function flatten(input, out, key) {
  if (typeof input === 'string') {
    out.push([key, input]);
    if (/^\s*\[/.test(input)) { try { const a = JSON.parse(input); if (Array.isArray(a)) flatten(a, out, key); } catch (e) { /* 不是 JSON */ } }
  } else if (Array.isArray(input)) for (const v of input) flatten(v, out, key);
  else if (obj(input)) for (const k of Object.keys(input)) flatten(input[k], out, k);
  return out;
}
/** 字段值换成本机路径。不是本机文件的协议（http: 这些）不算 */
function toFile(v, cwd) {
  let f = String(v).trim();
  if (!f) return '';
  if (/^file:/i.test(f)) { try { f = fileURLToPath(f); } catch (e) { return ''; } }
  else if (/^[a-z][a-z0-9+.-]+:/i.test(f) && !/^[a-z]:[\\/]/i.test(f)) return '';
  return path.resolve(cwd, S.expandHome(f));
}
function handle(j) {
  if (!/^mcp__/.test(String(j.tool_name || ''))) return null;
  const input = obj(j.tool_input) ? j.tool_input : {};
  const cwd = path.resolve(j.cwd || process.cwd());
  if (/secrets\.json|router-data|\.claude\.json/i.test(JSON.stringify(input))) return denied(SECRET_MSG, j);
  const rows = flatten(input, [], '');
  const G = require('../hooks/guard-commit');
  for (const [k, v] of rows) {
    if (!COMMAND_KEYS.test(k) || !v.trim()) continue;
    for (const tool of ['Bash', 'PowerShell']) { const out = G.securityFirst(Object.assign({}, j, { cwd, tool_name: tool, tool_input: { command: v } }), v); if (out) return out; }
  }
  const configs = [path.join(S.CFG_DIR, '.claude.json'), path.join(path.dirname(S.CFG_DIR), '.claude.json')].map((f) => S.normKey(S.realish(f)));
  const Read = require('../hooks/guard-read');
  const bases = [cwd];
  for (const [k, v] of rows) if (/^projectPath$/i.test(k) && path.isAbsolute(String(v))) bases.push(path.resolve(String(v)));
  for (const [k, v] of rows) {
    if (!looksPath(k, v)) continue;
    for (const base of bases) {
      const f = toFile(v, base); if (!f) continue;
      const key = S.normKey(S.realish(f));
      if (configs.some((c) => c === key || c.startsWith(key + '/'))) return denied(SECRET_MSG, j);
      if (Read.handle(Object.assign({}, j, { cwd, tool_name: 'Grep', tool_input: { path: f, output_mode: 'content' } }))) return denied(SECRET_MSG, j);
      if (S.underDir(f, S.KIT)) return denied(KIT_MSG, j);
    }
  }
  return null;
}
module.exports = { handle };

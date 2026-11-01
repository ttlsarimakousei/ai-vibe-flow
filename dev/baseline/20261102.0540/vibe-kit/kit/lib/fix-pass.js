'use strict';
/*
 * "命令失败 → 改了文件 → 同一条命令再跑通过"自动记成经验规则候选（K3 M11，2026-11-01）。
 * after-tool 一路记着（<会话>-fixpass.json：{ open: { <命令>: { at, kind, error, files } } }）：
 *   编译、测试命令失败（lib/fail-summary.js 认得的命令）：记下命令和第一个错误（只留错误那一句，不留路径、行号）
 *   之后 Edit、Write 改成功的文件：记到还开着的每条失败命令下
 *   同一条命令跑通了：中间改过文件的，交给 lessons.autoFix 记一条候选（照现有候选的规矩：先进候选、不进上下文，
 *     在别的变更、别的会话里再出现到门槛才变成规则；开关"经验规则"关了、"自动收"关了不记）；没改文件就过了的（偶发、环境好了）不记
 * 两个小时还没跑通的作废，最多同时记 10 条。出错放行，不影响工具结果。
 */
const path = require('path');
const S = require('./session');
const F = require('./fail-summary');

const KEY = (sid) => String(sid) + '-fixpass';
const TTL = 2 * 3600000;
const sidOf = (j) => { const s = String((j && j.session_id) || ''); return s && s !== 'unknown' ? s : ''; };
/** 同一条命令：空白合并、去掉首尾空白 */
const norm = (cmd) => String(cmd || '').replace(/\s+/g, ' ').trim();
const live = (open) => { const out = {}; for (const [k, v] of Object.entries(open || {})) if (v && Date.now() - (v.at || 0) < TTL) out[k] = v; return out; };

/** 编译、测试命令失败了 */
function failed(j) {
  const sid = sidOf(j);
  const cmd = norm(j && j.tool_input && j.tool_input.command);
  if (!sid || !cmd || j.is_interrupt) return false;
  const kind = F.kindOf(cmd);
  if (!kind) return false;
  const r = j.tool_response || {};
  const e = F.firstError(String(j.error || '') + '\n' + String(r.stdout || '') + '\n' + String(r.stderr || ''), kind);
  if (!e || !e.message) return false;
  S.updateState(KEY(sid), (o) => {
    const open = live(o.open);
    const old = open[cmd];
    // 同一条命令又失败：错误换成最新的，改过的文件留着（改了几次才过，几次的文件都算）
    open[cmd] = { at: Date.now(), kind, error: String(e.message).slice(0, 200), files: old ? old.files : [] };
    const keys = Object.keys(open).sort((a, b) => open[b].at - open[a].at);
    for (const k of keys.slice(10)) delete open[k];
    return { open };
  });
  return true;
}
/** 改成功了一个文件：记到开着的每条失败命令下 */
function edited(j) {
  const sid = sidOf(j);
  const f = String((j && j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || '');
  if (!sid || !f) return false;
  const st = S.readState(KEY(sid));
  if (!st.open || !Object.keys(st.open).length) return false;
  const abs = path.resolve(j.cwd || process.cwd(), f);
  S.updateState(KEY(sid), (o) => {
    const open = live(o.open);
    for (const v of Object.values(open)) if (!v.files.includes(abs)) v.files = v.files.concat(abs).slice(-20);
    return { open };
  });
  return true;
}
/**
 * 同一条命令跑通了：中间改过文件的记一条候选。返回 lessons.autoFix 的结果（{ status, id }），没记返回 null
 */
function passed(j) {
  const sid = sidOf(j);
  const cmd = norm(j && j.tool_input && j.tool_input.command);
  if (!sid || !cmd) return null;
  const st = S.readState(KEY(sid));
  const hit = st.open && st.open[cmd];
  if (!hit) return null;
  S.updateState(KEY(sid), (o) => { const open = live(o.open); delete open[cmd]; return { open }; });
  if (Date.now() - (hit.at || 0) >= TTL || !hit.files || !hit.files.length) return null;
  // 出处：这个会话在流程里做的那个变更（只有一个时），不然用会话号——同一条在不同的变更、会话里出现才会变成规则
  let from = '会话-' + sid.slice(0, 8);
  try { const ch = S.flowChanges(j); if (ch.length === 1) from = path.basename(ch[0]); } catch (e) { /* 认不出变更就用会话号 */ }
  return require('./lessons').autoFix({ cmd, kind: hit.kind, error: hit.error, files: hit.files, from, cwd: j.cwd || process.cwd() });
}

module.exports = { failed, edited, passed, norm };

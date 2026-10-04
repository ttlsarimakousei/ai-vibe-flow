'use strict';
/*
 * PreToolUse 钩子（Edit / Write / MultiEdit）的统一入口：一次调用里依次跑五个检查，谁先拦就用谁的话。
 *   1. guard-kit：套件自己的文件不许改；不许往 .claude/settings*.json 里写 disableAllHooks
 *   2. guard-vibe：.vibe 里只放套件的东西，临时脚本放 .vibe/tmp/<事由>/
 *   3. guard-output：代码之外的产出（DDL、说明文档、分析报告）放哪要先跟用户定好
 *   4. guard-encoding：会把中文写坏的编辑
 *   5. guard-spec：OpenSpec 产物的门槛
 * 都放行之后，要往 .vibe/ 里写东西的，确保 .vibe/ 已经在那个仓库的 .gitignore 里（写入被拦时不改 .gitignore）。
 * 合成一个入口：命令方式下一次编辑只起一个进程；HTTP 方式下只发一次请求。
 * 兜底放行（lib/feedback.js）：流程类的检查（guard-vibe、guard-output、guard-spec）拦下时带〔拦截编号〕；申请过放行的，
 * 只跳过申请了的那道检查，别的检查（尤其改套件、编码）照样跑。通行证按"同一个文件"认：申请之后对这个文件的编辑
 * 内容变了（比如中间改过一次验法）照样用得上。某道检查抛了异常：照旧当放行，但记进问题反馈。
 */
const path = require('path');
const crypto = require('crypto');
const { ensureVibeIgnored, readConfig, normKey, cli } = require('../lib/session');
const checks = [require('./guard-kit.js'), require('./guard-vibe.js'), require('./guard-output.js'), require('./guard-encoding.js'), require('./guard-spec.js')];
// 和上面一一对应：拦下时记的是哪道检查（兜底放行按这个名字认）
const NAMES = ['guard-kit', 'guard-vibe', 'guard-output', 'guard-encoding', 'guard-spec'];
let outputs = null;
try { outputs = require('../lib/outputs.js'); } catch (e) { /* 老版本没有 */ }
let feedback = null;
try { feedback = require('../lib/feedback.js'); } catch (e) { /* 老版本没有 */ }
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }
// 全自动模式下，不能放行的拦截（改套件、非 UTF-8 文件）：提示里原来写的是"停下来告诉用户"，用户不在，停下就是一直挂着
const AUTO_HARD = '\n全自动模式：我不在，不要停下等我。这个文件先不动：换一个不碰它的做法；换不了，就把这项任务留给我（任务后面加上"（留给用户：原因）"，不打勾），接着做别的。已经记进全自动报告。';

/** 这一步是哪个操作：工具、文件、写的内容。原样再做一次时算出来一样 */
function actionSig(j, f) {
  const inp = j.tool_input || {};
  const body = crypto.createHash('sha1').update(JSON.stringify([inp.content, inp.old_string, inp.new_string, inp.replace_all, inp.edits])).digest('hex');
  return feedback.sigOf([j.tool_name, normKey(f), body]);
}

function handle(j) {
  const inp = j.tool_input || {};
  let f = String(inp.file_path || '');
  if (f && !path.isAbsolute(f) && j.cwd) f = path.resolve(j.cwd, f);
  // 要改项目说明、项目的 CLAUDE.md：先把里面现有的"产出位置"记下来。之后模型自己加的条目，没问过用户不算确认过
  try { if (outputs && j.session_id && /[\\/](\.vibe[\\/]project\.md|CLAUDE\.md)$/i.test(f)) outputs.snapshot(j.session_id, f); } catch (e) { /* 记不了不影响改文件 */ }
  let sig = '';
  let passes = {};
  const cfg = readConfig();
  const target = f ? 'file:' + normKey(f) : '';
  const action = String(j.tool_name || '') + '：' + f;
  try { if (feedback) { sig = actionSig(j, f); passes = feedback.passesFor(sig, cfg, j, target); } } catch (e) { passes = {}; }
  const used = [];
  const blocked = {};
  for (let i = 0; i < checks.length; i++) {
    let out = null;
    try { out = checks[i].handle(j); } catch (e) { out = null; if (feedback) feedback.recordHookError(NAMES[i], j, e); }
    if (!out) continue;
    // 通行证只管申请时说的那条规矩：这一次拦下的是别的规矩，照拦
    if (out.decision === 'block' && passes[NAMES[i]] && feedback.pickPass([passes[NAMES[i]]], NAMES[i], sig, target, out.reason)) {
      used.push(passes[NAMES[i]]);
      blocked[NAMES[i]] = out.reason;
      // 打勾这一步放行了：打勾的时间照样要记（"代码审过了吗"要用）
      if (NAMES[i] === 'guard-spec' && typeof checks[i].afterBypass === 'function') { try { checks[i].afterBypass(j); } catch (e) { /* 记不了不影响放行 */ } }
      continue;
    }
    if (out.decision === 'block' && feedback && sig) {
      let tail = '';
      try { tail = feedback.registerBlock(j, NAMES[i], sig, out.reason, action, target); } catch (e) { tail = ''; /* 记不了编号也照样拦 */ }
      if (!tail && cfg.autoMode) {
        tail = AUTO_HARD;
        try { if (report) report.note(j, { kind: 'hand', title: '没让它改：' + f, detail: String(out.reason || '').split(/\r?\n/)[0].replace(/^\[vibe-kit[^\]]*\]\s*/, '') }); } catch (e) { /* 记不了不影响 */ }
      }
      if (tail) { out.reason += tail; if (out.hookSpecificOutput) out.hookSpecificOutput.permissionDecisionReason = out.reason; }
    }
    return out;
  }
  try { if (/(^|[\\/])\.vibe([\\/]|$)/.test(f)) ensureVibeIgnored(f); } catch (e) { /* 加不上不影响写文件 */ }
  if (used.length) return feedback.bypassOutcome(used, cfg, j, blocked, action);
  return null;
}

module.exports = { handle };
if (require.main === module) cli(handle);

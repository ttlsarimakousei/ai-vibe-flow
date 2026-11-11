'use strict';
/*
 * PreToolUse 钩子（Edit / Write / MultiEdit）的统一入口：一次调用里依次跑下面几个检查，谁先拦就用谁的话。
 *   1. guard-vibe：.vibe 里只放套件的东西，临时脚本放 .vibe/tmp/<事由>/
 *   2. guard-output：代码之外的产出（DDL、说明文档、分析报告）放哪要先跟用户定好
 *   3. guard-encoding：会把中文写坏的编辑
 *   4. guard-spec：OpenSpec 产物的门槛
 *   5. 流程里没开工不改源码、探索记录和计划表只在用户开口那一轮改
 *   6. 写进代码的文字里不带套件专属的字眼（审查编号、第几轮审查、套件的名字；问题表第 82 条）
 * 以前第一道是 guard-kit（不许改套件），2026-11-04 去掉了（仓库主人定的：套件可以改）。
 * 都放行之后，要往 .vibe/ 里写东西的，确保 .vibe/ 已经在那个仓库的 .gitignore 里（写入被拦时不改 .gitignore）。
 * 合成一个入口：一次编辑只起一个进程。
 * 兜底放行（lib/feedback.js）：流程类的检查（guard-vibe、guard-output、guard-spec）拦下时带〔拦截编号〕；申请过放行的，
 * 只跳过申请了的那道检查，别的检查（尤其编码）照样跑。通行证按"同一个文件"认：申请之后对这个文件的编辑
 * 内容变了（比如中间改过一次验法）照样用得上。某道检查抛了异常：照旧当放行，但记进问题反馈。
 */
const path = require('path');
const crypto = require('crypto');
const { ensureVibeIgnored, readConfig, readConfigFor, normKey, cli } = require('../lib/session');
// 流程里没开工不改源码（第 44 条）。2026-11-10 起不能申请放行；同一个大任务里前面的 change 开过工的放行（lib/apply-scope.js 的 startedInScope）
const startedCheck = { handle(j) {
  let f = String((j.tool_input || {}).file_path || '');
  if (f && !path.isAbsolute(f) && j.cwd) f = path.resolve(j.cwd, f);
  if (!f) return null;
  const S = require('../lib/session'); const A = require('../lib/apply-scope');
  const no = A.notStarted(j, f);
  if (!no || S.confirmApply(j, { hint: f }) || require('../lib/flow-policy').automaticApply(j)) return null;
  const out = S.blockOut('PreToolUse', '[vibe-kit 范围] ' + no);
  // 用户 2026-11-10 定的："写需求的任何情况下都不能动代码"：不给拦截编号、不认通行证
  Object.defineProperty(out, 'noBypass', { value: true });
  return out;
} };
// 探索完之后范围和计划表只有用户开口那一轮能改（第 43 条）
const exploreCheck = { handle(j) {
  let f = String((j.tool_input || {}).file_path || '');
  if (f && !path.isAbsolute(f) && j.cwd) f = path.resolve(j.cwd, f);
  if (!f || !/[\\/]openspec[\\/](?:explore[\\/][^\\/]+\.md|plan\.md)$/i.test(f)) return null;
  const no = require('../lib/guard-explore').issue(j, f);
  return no ? require('../lib/session').blockOut('PreToolUse', '[vibe-kit 探索记录] ' + no) : null;
} };
/*
 * 写进代码的文字里不带套件专属的字眼（问题表第 82 条，2026-11-11：注释里出现"（审核r3）"，同事不用这套工具，看不懂）。
 * 认的是：审查的问题编号（"审核 r3""修复 r2"）、第几轮审查、套件和技能的名字、拦截编号。
 * 只看这次新写进去的（文件里本来就有的不管），只管代码文件；需求文档、.vibe、套件自己的文件不管。
 * 同一个文件同一处只拦一次，原样再写一次就放行（确实要这么写的）。不给拦截编号，也不记进全自动报告。
 */
const KIT_WORDS = [
  [/(?:审查|审核|复审|评审|code\s*review|review)\s*(?:意见|问题|结论|发现)?\s*[（(#＃:：]?\s*r\d{1,3}(?![\w.])/i, '审查的问题编号'],
  [/(?:修复|修正|解决|fix(?:es|ed)?)\s*(?:了)?\s*[（(]?\s*r\d{1,3}(?![\w.(])\s*[）)]?\s*(?:[:：，,。]|$)/im, '审查的问题编号'],
  [/第\s*[一二三四五六七八九十\d]+\s*轮\s*(?:审查|审核|复审)/, '第几轮审查'],
  [/vibe-kit|\bvk-(?:cross-review|see-page|db-crud|redis|onboard|handover)\b|〔拦截编号/i, '套件的名字'],
];
const CODE_FILE = /\.(java|kt|groovy|js|mjs|cjs|ts|py|go|cs|xml|sql|vue|jsx|tsx|html?|css|scss|sass|less|styl|jsp|jspx|tag|ftl|vm|properties|ya?ml)$/i;
const NOT_CODE = /(^|[\\/])(\.vibe|openspec|\.claude|node_modules)[\\/]/;
/** 这次要写进去的新文字（[新, 旧] 成对）：Edit 是 new_string 对 old_string，MultiEdit 逐条，Write 是整份对文件现在的内容 */
function writtenParts(j, f) {
  const inp = j.tool_input || {};
  if (Array.isArray(inp.edits)) return inp.edits.map((e) => [String((e && e.new_string) || ''), String((e && e.old_string) || '')]);
  if (inp.content !== undefined) { let old = ''; try { old = require('fs').readFileSync(f, 'utf8'); } catch (e) { old = ''; } return [[String(inp.content), old]]; }
  return [[String(inp.new_string || ''), String(inp.old_string || '')]];
}
const wordsCheck = { handle(j) {
  let f = String((j.tool_input || {}).file_path || '');
  if (f && !path.isAbsolute(f) && j.cwd) f = path.resolve(j.cwd, f);
  if (!f || !CODE_FILE.test(f) || NOT_CODE.test(f)) return null;
  const S = require('../lib/session');
  if (S.isKitPath && S.isKitPath(f, j.cwd)) return null;
  for (const [next, old] of writtenParts(j, f)) {
    for (const [re, what] of KIT_WORDS) {
      const m = re.exec(next);
      if (!m) continue;
      const hit = m[0].trim().replace(/\s+/g, ' ').slice(0, 30);
      // 改之前这一处就有的（原样带过来的）不管
      if (old.includes(m[0])) continue;
      let first = true;
      try { first = require('../lib/tidy.js').blockOnce(j.session_id, f + '#words#' + hit); } catch (e) { first = true; }
      if (!first) continue;
      const out = S.blockOut('PreToolUse', '[vibe-kit 注释] 要写进 ' + path.basename(f) + ' 的文字里有「' + hit + '」（' + what + '）：这是这套工具里的叫法，同事看代码时看不懂。注释、日志、提示语只写业务上的原因，不写审查编号、第几轮审查、工具的名字。例：把"// 修复审核 r3：空列表"写成"// 列表为空时直接返回，不然会拼出 in ()"。改掉再写；确实要这么写的，原样再执行一次就行。');
      Object.defineProperty(out, 'noBypass', { value: true });
      return out;
    }
  }
  return null;
} };
const checks = [require('./guard-vibe.js'), require('./guard-output.js'), require('./guard-encoding.js'), require('./guard-spec.js'), startedCheck, exploreCheck, wordsCheck];
// 和上面一一对应：拦下时记的是哪道检查（兜底放行按这个名字认）
const NAMES = ['guard-vibe', 'guard-output', 'guard-encoding', 'guard-spec', 'guard-started', 'guard-explore', 'guard-words'];
let outputs = null;
try { outputs = require('../lib/outputs.js'); } catch (e) { /* 老版本没有 */ }
let feedback = null;
try { feedback = require('../lib/feedback.js'); } catch (e) { /* 老版本没有 */ }
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }
// 全自动模式下，不能放行的拦截（非 UTF-8 文件）：提示里原来写的是"停下来告诉用户"，用户不在，停下就是一直挂着
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
  const cfg = readConfigFor(j);
  if (/(^|[\\/])\.vibe[\\/]handover\.md$/i.test(f) && !require('../lib/session').canWriteHandover(j, cfg)) return require('../lib/session').blockOut('PreToolUse', '[vibe-kit] 没有当前用户的手动交接要求，不写交接记录。连续工作依靠自动压缩，接着处理当前任务。');
  if (f) {
    try {
      const scope = require('../lib/apply-scope'); scope.prepareEdit(j, f);
      let no = scope.check(j, f);
      // 提问框的开工答案不触发用户开口钩子：拦之前先补读（以前只有调 apply 技能、打勾才补读，提问框选了开工、改代码还是拦）
      if (no && require('../lib/session').confirmApply(j, { hint: f })) no = scope.check(j, f);
      if (no) { const why = scope.refusal(j); return require('../lib/session').blockOut('PreToolUse', '[vibe-kit 范围] ' + no + (why ? '。用户说了开工，但' + why + '。' : '')); }
    } catch (e) { if (feedback) feedback.recordHookError('pre-edit 范围', j, e); }
  }
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
    // noBypass：这道拦截不能放行（guard-spec 的"我还没说开工"），不认通行证、不给拦截编号
    if (out.decision === 'block' && !out.noBypass && passes[NAMES[i]] && feedback.pickPass([passes[NAMES[i]]], NAMES[i], sig, target, out.reason)) {
      used.push(passes[NAMES[i]]);
      blocked[NAMES[i]] = out.reason;
      // 打勾这一步放行了：打勾的时间照样要记（"代码审过了吗"要用）
      if (NAMES[i] === 'guard-spec' && typeof checks[i].afterBypass === 'function') { try { checks[i].afterBypass(j); } catch (e) { /* 记不了不影响放行 */ } }
      continue;
    }
    if (out.decision === 'block' && feedback && sig && !out.noBypass) {
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

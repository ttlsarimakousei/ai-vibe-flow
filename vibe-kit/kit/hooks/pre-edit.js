'use strict';
/*
 * PreToolUse 钩子（Edit / Write / MultiEdit）的统一入口：一次调用里依次跑下面几个检查，谁先拦就用谁的话。
 *   1. guard-vibe：.vibe 里只放套件的东西，临时脚本放 .vibe/tmp/<事由>/
 *   2. guard-output：代码之外的产出（DDL、说明文档、分析报告）放哪要先跟用户定好
 *   3. guard-encoding：会把中文写坏的编辑
 *   4. guard-spec：OpenSpec 产物的门槛
 *   5. 流程里没开工不改源码、探索记录和计划表只在用户开口那一轮改
 *   6. 用户这一轮只让起服务、没让改代码：改代码前拦一次，先问（#463）
 *   7. 写进代码的文字里不带套件专属的字眼（审查编号、第几轮审查、套件的名字；问题表第 82 条）
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
  if (!no || S.confirmApply(j, { hint: f })) {
    // 用户让开工、接着做了，自动还没问过（第 86 条，仓库主人 2026-11-12 定的）：改代码前先问一次自动还是人工
    if (CODE_FILE.test(f) && !NOT_CODE.test(f)) { const ask = require('../lib/auto-run').askPending(j); if (ask) return S.blockOut('PreToolUse', '[vibe-kit] ' + ask); }
    return null;
  }
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
  // 英文词前面不能紧挨着字母（preview r2、prefix r1 不算）
  // 空白都限了长度（复审 R3：不限的话 review 后面跟上千个空白要回溯几十秒）
  [/(?:审查|审核|复审|评审|(?<![A-Za-z])code[ \t]{0,3}review|(?<![A-Za-z])review)[ \t]{0,3}(?:意见|问题|结论|发现)?[ \t]{0,3}[（(#＃:：]?[ \t]{0,3}r\d{1,3}(?![\w.])/i, '审查的问题编号'],
  [/(?:修复|修正|解决|(?<![A-Za-z])fix(?:es|ed)?)[ \t]{0,3}(?:了)?[ \t]{0,3}[（(]?[ \t]{0,3}r\d{1,3}(?![\w.(])[ \t]{0,3}[）)]?[ \t]{0,3}(?:[:：，,。]|$)/im, '审查的问题编号'],
  // 只认说的是审查过程的（复审 R4：审批类业务代码里"第二轮审核"是业务词）
  [/第[ \t]{0,3}[一二三四五六七八九十\d]{1,3}[ \t]{0,3}轮[ \t]{0,3}(?:审查|复审|code review)[ \t]{0,3}(?:发现|提出|指出|报|要求|意见|问题|结论|的问题)/i, '第几轮审查'],
  [/vibe-kit|\bvk-(?:cross-review|see-page|db-crud|redis|onboard|handover)\b|〔拦截编号/i, '套件的名字'],
];
const CODE_FILE = /\.(java|kt|groovy|js|mjs|cjs|ts|py|go|cs|xml|sql|vue|jsx|tsx|html?|css|scss|sass|less|styl|jsp|jspx|tag|ftl|vm|properties|ya?ml)$/i;
const NOT_CODE = /(^|[\\/])(\.vibe|openspec|\.claude|node_modules)[\\/]/;
/*
 * 用户这一轮只让起服务（"启动项目""重启后端"），没让改代码（#463，仓库主人 2026-11-12 定的"钩子拦一次"）。
 * 起因：同事只说"启动项目"，构建不过，模型为了把服务起起来连着改了 pom、依赖、框架配置 6 个文件，用户还得一个个回退。
 * 这一轮第一次改代码、配置文件时拦一次：先把原因和要改哪些文件告诉用户，用提问框问；问过之后这一轮再改就放行（拦的是"没问就改"）。
 * 自动实施生效的那一轮不管（用户不在）；.vibe、openspec 里的文件不管。不给拦截编号。
 */
const startOnlyCheck = { handle(j) {
  let f = String((j.tool_input || {}).file_path || '');
  if (f && !path.isAbsolute(f) && j.cwd) f = path.resolve(j.cwd, f);
  if (!f || !CODE_FILE.test(f) || NOT_CODE.test(f)) return null;
  if (!j.session_id || j.session_id === 'unknown' || !j.transcript_path) return null;
  const S = require('../lib/session');
  const voices = S.turnVoices(S.tailEntries(j.transcript_path, 3000000)); const first = voices[0];
  if (!first || first.kind !== 'prompt' || !require('../lib/intent').startOnly(first.text)) return null;
  // 它已经先问过用户了（这一轮有提问框的答案）：不拦，改不改照用户选的
  if (voices.some((v) => v.kind === 'answer')) return null;
  if (readConfigFor(j).autoMode) return null;
  let once = false;
  try { once = require('../lib/tidy.js').blockOnce(j.session_id, 'start-only#' + S.voiceKey(first)); } catch (e) { once = false; /* 记不了"拦过这一轮"：放行（出错放行） */ }
  if (!once) return null;
  const out = S.blockOut('PreToolUse', '[vibe-kit] 用户这一轮只说了"' + String(first.text).replace(/\s+/g, ' ').slice(0, 30) + '"，没让改代码。起不来先停下：把原因（报错原样给）、要改哪些文件、为什么告诉用户，用提问框问要不要改（选项写"改（这几个文件）""不改，我自己处理"）。用户选了改再改，这句话这一轮只说一次。');
  Object.defineProperty(out, 'noBypass', { value: true });
  return out;
} };
/** 这个文件在套件自己的源码仓库里（往上有 vibe-kit/kit/hooks/pre-edit.js）：维护套件的人写套件的名字是正常的 */
function kitSource(f) {
  let d = path.dirname(path.resolve(f));
  for (let i = 0; i < 12; i++) { try { if (require('fs').existsSync(path.join(d, 'vibe-kit', 'kit', 'hooks', 'pre-edit.js')) || require('fs').existsSync(path.join(d, 'kit', 'hooks', 'pre-edit.js'))) return true; } catch (e) { return false; } const up = path.dirname(d); if (up === d) break; d = up; }
  return false;
}
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
  // 没有会话号："原样再写一次放行"做不到，不查（复审 R4：以前一直拦）。套件自己的源码仓库不查
  if (!j.session_id || j.session_id === 'unknown' || kitSource(f)) return null;
  for (const [next0, old] of writtenParts(j, f)) {
    const next = next0.slice(0, 200000);
    for (const [re, what] of KIT_WORDS) {
      const m = re.exec(next);
      if (!m) continue;
      const hit = m[0].trim().replace(/\s+/g, ' ').slice(0, 30);
      // 改之前这一处就有的（原样带过来的）不管
      if (old.includes(m[0])) continue;
      let first = true;
      try { first = require('../lib/tidy.js').blockOnce(j.session_id, f + '#words#' + hit); } catch (e) { first = false; /* 记不了"拦过这一处"：放行（出错放行） */ }
      if (!first) continue;
      const out = S.blockOut('PreToolUse', '[vibe-kit 注释] 要写进 ' + path.basename(f) + ' 的文字里有「' + hit + '」（' + what + '）：这是这套工具里的叫法，同事看代码时看不懂。注释、日志、提示语只写业务上的原因，不写审查编号、第几轮审查、工具的名字。例：把"// 修复审核 r3：空列表"写成"// 列表为空时直接返回，不然会拼出 in ()"。改掉再写；确实要这么写的，原样再执行一次就行。');
      Object.defineProperty(out, 'noBypass', { value: true });
      return out;
    }
  }
  return null;
} };
const checks = [require('./guard-vibe.js'), require('./guard-output.js'), require('./guard-encoding.js'), require('./guard-spec.js'), startedCheck, exploreCheck, startOnlyCheck, wordsCheck];
// 和上面一一对应：拦下时记的是哪道检查（兜底放行按这个名字认）
const NAMES = ['guard-vibe', 'guard-output', 'guard-encoding', 'guard-spec', 'guard-started', 'guard-explore', 'guard-start-only', 'guard-words'];
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

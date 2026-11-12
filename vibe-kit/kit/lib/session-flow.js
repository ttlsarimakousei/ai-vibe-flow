'use strict';
/*
 * OpenSpec 流程状态：在不在流程里、写提案（plan）还是做任务（apply）、开工的说法、按流程算的配置（readConfigFor）、本会话碰过的变更。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const intent = require('./intent');
const { readConfig } = require('./session-config');
const { textOf, isUserTurn, toolResults, isTaskNote, toolCalls } = require('./session-transcript');
const { readState, writeState, updateState, hookLog, normKey, underDir } = require('./session-state');
const { mentionsChange } = require('./session-proposal');
const { allChanges } = require('./session-projects');

// ===================== 全自动模式只在走 OpenSpec 流程时算开着 =====================
/*
 * 用户 2026-09-30 定的。起因：全自动开着，另开一个窗口做检索，那个窗口收工时自己去接着做没做完的变更，差点和正在做这个变更的窗口打架；
 * 只敲了 /vk-onboard，收工检查却催着"直接开始 /opsx:apply"（议题 #9）。
 * 每个会话记一份"现在是不是在走 OpenSpec 流程"（state/<会话>-flow.json）。用户 2026-11-03 定的：进流程只有三种：
 *   用户敲 /opsx:…（hooks/task-anchor.js）；话里明确有 openspec，模型去调；模型判断改动较大、提问框问了、用户选了探索（hooks/guard-ask.js、guard-spec.js 核对）
 * 不按句子猜需求，不因为话里点了变更的名字就进（接回用 /vk-resume）。进了之后中途怎么说都不退出：
 *   问句、插话、别的斜杠命令、"继续"       → 不动
 *   "停""等等"                             → 不动，记 paused：这一轮收工不催，下一句话接着做
 *   "先别开工""只写需求"                   → 回到写需求那一段，清开工范围，不自动开工
 *   让它出一份代码之外的东西               → 不动，记 aside：这一轮放哪照常问用户，全自动不作数（会话开着 /vk-auto 的照样算自动，第 68 条：需求里带"导出""表格"就被判成插话，整轮退回人工）
 *   变更都归档了、"退出流程"               → 退出
 * 流程又分两段（stage，见下面"流程分两段"）：写提案那一段 plan，做任务那一段 apply。全自动只在 apply 那一段算开着。
 * 不在流程里时，钩子拿到的 cfg.autoMode 是 false：照有人在的样子来（能问、不催着往下做、不出全自动报告）。cfg.autoSwitch 是开关本身。
 * 开关关着的时候也照样定、照样记：这一轮做到一半才在配置页打开全自动的，照这一轮开头定的算。
 * changes 是这个会话在流程里动手做过的变更（写过它的产物、打过勾、命令里点了名）：收工时只催这几个往下走，
 * 只是读过、话里提到过的不催。
 */
const FLOW_SLASH = /^\s*\/(opsx:|openspec[-:])/i;

const FLOW_TAG = /<command-name>\s*\/?(opsx:|openspec[-:])/i;

const FLOW_SKILL = /^\s*\/?(opsx:|openspec[-:])/i;

const flowKey = (j) => (j && j.session_id && j.session_id !== 'unknown' ? String(j.session_id) + '-flow' : '');

function flowState(j) { const k = flowKey(j); return k ? readState(k) : {}; }

// 这两个都是读-改-写，走 updateState：文件正好读不出来（别的钩子在写、杀毒软件占着）时放弃这一次。
// 以前用 readState，读不出来拿到的是空对象，写回去就把"在不在流程里""动过哪些变更"冲掉了
function setFlow(j, on, why, stage) {
  const k = flowKey(j);
  if (!k) return false;
  // 上一件事的变更都归档了、现在重新进流程（#436）：旧的变更名单清掉。不清的话新变更的目录还没建，下一句话又按旧名单判成"流程走完了"，
  // 建变更被拦"用户没说要走 OpenSpec"
  let stale = false;
  try { stale = !!on && !flowState(j).on && flowDone(j); } catch (e) { stale = false; }
  updateState(k, (st) => { if (stale) { st.changes = []; for (const k of ['touchedAt', 'applyScope', 'reqEdited', 'planReady', 'applySource', 'lastApplyAt', 'applyVoice', 'applyVoiceSchema', 'applyRefused', 'dirtyTold', 'waiting']) delete st[k]; } st.on = !!on; st.why = String(why || ''); st.at = Date.now(); if (on) st.was = st.at; else delete st.current; if (stage === 'plan' || stage === 'apply') st.stage = stage; return st; });
  if (stale) { try { const ck = String(j.session_id) + '-changes'; const left = (readState(ck).dirs || []).filter((d) => fs.existsSync(d)); writeState(ck, { dirs: left, at: Date.now() }); } catch (e) { /* 清不了：下一句话可能又判成走完，照旧 */ } }
  return !!on;
}

/** 这个会话在流程里动手做了这个变更 */
function flowTouch(j, dir, at) {
  const k = flowKey(j);
  if (!k || !dir) return;
  try {
    const d = normKey(dir);
    const cur = flowState(j).changes;
    if (Array.isArray(cur) && cur.includes(d)) return;
    updateState(k, (st) => { const list = Array.isArray(st.changes) ? st.changes : []; if (!list.includes(d)) { st.changes = list.concat(d).slice(-50); if (at !== false) st.touchedAt = Object.assign({}, st.touchedAt, { [d]: Number(at) || Date.now() }); } return st; });
  } catch (e) { /* 记不了：收工时不催这个变更，不影响干活 */ }
}

function flowChanges(j) { const c = flowState(j).changes; return Array.isArray(c) ? c : []; }

/** 这个会话在流程的哪一段：plan / apply；没记的（装这一版之前就开着的会话）按 apply 算 */
function flowStage(j) { const s = flowState(j).stage; return s === 'apply' ? 'apply' : 'plan'; }

/**
 * 这个会话的流程走完了：它动过的变更（流程记录里的；没记的看会话碰过的）一个都不在了（归档了、删了）。
 * 用户 2026-10-07 反馈：变更归档之后状态栏还写着"在流程里，在做任务"。收工时据此把流程记成不在（hooks/verify-gate.js），
 * 用户开口时也不再凭"上一轮在流程里"接回去（hooks/task-anchor.js），状态栏写"变更归档了，照常"
 */
function flowDone(j) {
  try {
    let dirs = flowChanges(j);
    if (!dirs.length && j && j.session_id && j.session_id !== 'unknown') dirs = readState(String(j.session_id) + '-changes').dirs || [];
    return dirs.length > 0 && dirs.every((d) => !fs.existsSync(d));
  } catch (e) { return false; }
}

// ===================== 流程分两段：写提案（plan）和做任务（apply） =====================
/*
 * 用户 2026-10-07 定的：全自动只管 apply 之后（做任务、审代码、修审出的问题、收工交报告）。探索、提案、规格、设计、任务清单
 * 这些阶段他要看、要改（他发现初版需求里没提的操作被写进了提案），他说了开工才开始做任务；任务全部完成、代码审过之后停下等他自测，
 * 他说了归档才归档。所以每个会话的流程记录里多一项 stage。怎么定（hooks/task-anchor.js 的 decideFlow）：
 *   敲 /opsx:apply、/opsx:archive、/opsx:verify                                   → apply
 *   敲 /opsx:propose、/opsx:explore、/opsx:new、/opsx:ff；提了需求                   → plan
 *   "开工""开始做""把 1.1 做了""按提案做"；点名让它接着做一个已经打过勾的变更          → apply
 *   "提案里 X 不对，改一下""tasks 第 3 项的验法改成…"；点名一个还没开工的变更          → plan
 *   "继续""好"、别的话                                                               → 跟上一轮一样
 *   接着交接记录做                                                                   → 记录里提到的变更开过工就是 apply，不然 plan
 * 模型自己调 /opsx:apply 的技能、在 plan 那一段打勾：拦下，让它先把提案交代给用户、问能不能开工（hooks/guard-ask.js、guard-spec.js）。
 * 没记 stage 的（装这一版之前就开着的会话）按 apply 算：全自动正跑着的会话不能因为升级突然变成有人在的样子，会停在提问框上。
 */
// /vk-go 是套件的开工命令（用户 2026-10-30 定的斜杠命令，和说"开工"并存）
const APPLY_SLASH = /^\s*\/(?:(opsx:|openspec[-:])apply\b|vk-go\b)/i;

const APPLY_TAG = /<command-name>\s*\/?(?:(opsx:|openspec[-:])apply\b|vk-go\b)/i;

// 明说开工的话。HARD 怎么都算；SOFT、WEAK 在同一句里说的是提案那一段的事（"开始做提案""接着做 a1 的提案"）时不算
const APPLY_HARD = /开工|开干|开搞|\bapply\b|(按|照|依)(提案|任务|tasks|清单)(做|实现|开发)|按照现在的方案修改|可以(做|开工|实现|开始做)了/i;

const APPLY_SOFT = /动手|开始(做|实现|开发|写代码|执行|干)/;

const APPLY_WEAK = /做吧|干吧|做起来|去做|实现吧|执行吧|继续做|接着做|做完|做掉|实现掉|写完|开始吧|可以开始了/;

// 做某一项任务："把 1.1 做了""第 3 项做完""任务 2 打上勾"
const TASK_NUM = /(^|[^\d.])\d+\.\d+(?![\d.])|第\s*\d+\s*[项条步]|任务\s*\d/;

const TASK_DO = /(做|实现|开发|完成|搞定|写代码|执行|动手|打勾|打上勾|开始)/;

// 在说提案那一段的事：改提案、补规格、看设计、调任务清单和验法
const PLAN_EDIT = /(改|调整|修改|补|加|看|审|重写|更新|完善|细化|拆|做|写|出|重新|讨论|核对|确认)[^，,。！!？?\n]{0,8}(提案|proposal|需求|规格|specs?\b|设计|design|任务清单|tasks|验法|方案)|(提案|proposal|需求|规格|specs?\b|设计|design|任务清单|tasks|验法|方案)[^，,。！!？?\n]{0,8}(改|调整|不对|有问题|要加|少了|多了|去掉|换成|补|重写|不行|不够)/i;

/** 这句话是不是让它开始做任务（开工） */
function applyIntent(p) {
  const s = String(p || '');
  if (APPLY_SLASH.test(s) || APPLY_TAG.test(s)) return true;
  return intent.explicit(s, 'apply') && !PLAN_EDIT.test(s.replace(/按(?:照)?(?:提案|方案)(?:做|实现|开发)/g, ''));
}

/** 这句话是不是在说提案那一段的事 */

/** 这个变更开工了没有：tasks.md 里有打过勾的任务 */
function changeStarted(dir) { try { return /^\s*[-*]\s*\[[xX]\]/m.test(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8')); } catch (e) { return false; } }


// ===================== 做完的功能上发现的问题：先查清原因，改动小直接改 =====================
/*
 * 用户 2026-10-07 定的：自测、测试、用户反馈发现的问题（两个弹窗顺序反了这种，改两三个前端文件就好），不要起一整条 OpenSpec 流程。
 * 先查清原因（归档过的用 tools/trace.js 溯源），改动小——三个文件以内、不改接口和表结构、不改需求——就直接改、验证、按代码模式简单审一下改动点。
 * 改动大、要改需求或规格、接口、表结构的，先告诉用户要改什么，用户说了走提案再 /opsx:propose。
 * 怎么认"在报问题"：BUG_REPORT（用户开口时提醒，hooks/task-anchor.js；要新建提案时拦一次，hooks/guard-spec.js）。用户明说要走提案、开变更的（WANTS_PROPOSAL）不算。
 */
const BUG_REPORT = /(测试|自测|验收|用户|客户|现场|联调|试了|点了|跑了|看了)[^。！？\n]{0,12}(发现|反馈|报|说|看到)|bug|缺陷|报错|有问题|出问题|反了|没生效|不显示|显示不|不出来|没反应|点不了|打不开|进不去|不能用|用不了|失效|异常|乱码|错位|闪退|卡住了/i;

const WANTS_PROPOSAL = /提案|变更|propose|opsx:|走流程|走 ?openspec/i;

const SMALL_FIX_TEXT = '先查清原因，改动小（三个文件以内、不改接口和表结构、不改需求）就直接改；人工模式审查和自测前先 Ask，放弃直接继续，不记录未审查或未测试；按用户选择完成后交代，不要新开变更；改的是没归档的变更做出来的东西，在它的 revisions.md 记一条（起因：用户要求）。改动大、要改需求或规格、接口、表结构的，先告诉我要改什么、为什么，我说走提案再 /opsx:propose。';

/**
 * 这个会话从来没定过在不在流程里：它是装这一版之前就开着的，之后还没开过口（全自动挂着跑的会话，半夜自动更新到了这一版）。
 * 照以前的算法接过来，不然它一下子成了"不在流程里"，做到一半就停在那里没人催：它动过变更的算在流程里，动过的那几个算它在做的。
 * 它下一次开口就照新的规矩定了
 */
function flowAdopt(j) {
  const k = flowKey(j);
  if (!k) return {};
  let dirs = [];
  try { dirs = (readState(String(j.session_id) + '-changes').dirs || []).filter((d) => fs.existsSync(d)); } catch (e) { dirs = []; }
  const on = dirs.length > 0;
  const next = { on, why: on ? '装这一版之前就在做变更' : '', at: Date.now(), changes: dirs.slice(-50) };
  if (on) { next.was = next.at; next.stage = 'plan'; }
  writeState(k, next);
  if (on) hookLog('全自动模式 这个会话装这一版之前就在做变更，算在 OpenSpec 流程里：' + dirs.map((d) => path.basename(d)).join('、'));
  return next;
}

/**
 * 这一轮提问框里选的自动、人工（第 86 条）：选了"自动实施""自动接着做"开这个会话的自动，选了"实施（每步问我）""人工接着做""先不实施"关。
 * 同一个答案只认一次（st.autoAnswer 记着）：全部通过后套件关了自动，同一轮后面的钩子不能又按这个答案打开。
 * 用户开口让开工、套件等着问（st.autoAsk）时认得宽一点（问题里说到自动、答"自动"也算），认下来就不等了。返回 'on'、'off'、''
 */
function syncAutoAnswer(j) {
  const sid = j && j.session_id;
  if (!sid || sid === 'unknown' || !j.transcript_path) return '';
  return require('./invocation').memo('auto-answer|' + sid, () => {
    try {
      const st = flowState(j);
      const V = require('./session-voice'); const { tailEntries } = require('./session-transcript');
      const { autoAnswerOf, setSessionAuto } = require('./session-config');
      let pick = null;
      for (const v of V.turnVoices(tailEntries(j.transcript_path, 3000000))) {
        if (v.kind !== 'answer') continue;
        for (const x of v.answers || []) { const w = autoAnswerOf(x.a, x.q, !!st.autoAsk); if (w) pick = { v, w }; }
      }
      if (!pick) return '';
      const k = V.voiceKey(pick.v) + ':' + pick.w;
      if (st.autoAnswer === k) return '';
      updateState(flowKey(j), (s) => { s.autoAnswer = k; delete s.autoAsk; delete s.autoStopped; return s; });
      setSessionAuto(j, pick.w === 'on', pick.w === 'on' ? '提问框选了自动' : '提问框选了人工或先不实施');
      hookLog('自动模式 会话 ' + sid + (pick.w === 'on' ? ' 提问框选了自动' : ' 提问框选了人工或先不实施'));
      return pick.w;
    } catch (e) { return ''; }
  });
}

/** 给钩子用的开关：全自动模式开着、这个会话又不在 OpenSpec 流程里（或者还在写提案那一段），autoMode 按关着算 */
function readConfigFor(j) {
  syncAutoAnswer(j);
  const c = readConfig(j); c.autoSwitch = c.autoApply || c.autoRequirements;
  // 算流程状态要读任务、算指纹、调 git，出错不能让调用的钩子整道放行（2026-10-17 审核问题 14）：按人工模式算，更严
  let view; try { view = flowView(j); } catch (e) { hookLog('readConfigFor 算流程状态出错，按人工模式算：' + ((e && e.message) || e)); view = { effective: false, phase: '普通任务' }; }
  c.autoMode = !!view.effective;
  return c;
}

/** 展示和执行共用结果，需求改变、等待验收或归档后不能显示为自动实施。 */
function flowView(j) {
  const cfg = readConfig(j); const st = flowState(j); const over = st.on && flowDone(j);
  const scope = st.on && st.stage === 'apply' ? require('./apply-scope').valid(j) : { ok: true };
  const typed = require('./task-types'); const dirs = flowChanges(j).filter((d) => fs.existsSync(d));
  // 用户验收不靠打勾（用户 2026-10-17 定的）：任务全打勾、代码审查都过了，就是等用户按验收用例自测。老变更里没勾的 [用户验收] 不算自动能做的，结果一样
  const userWait = st.stage === 'apply' && dirs.length > 0 && dirs.every((d) => typed.automatedLeft(d).length === 0 && require('./flow-policy').allPassed(d, 'code'));
  // 会话里开了自动（问题表第 24 条，2026-10-31）：任务做完、等用户验收时照样算自动，用户报的问题自动改、审、测，归档照旧等用户说。
  // 用户改了需求（范围变化）在 apply-scope.valid 里按用户的话重定范围，不退回人工
  let verifying = false;
  if (st.on && st.stage === 'apply') { try { const B = require('./big-task'); const t = B.forSession(j); verifying = !!t && !t.legacy && B.phaseOf(t).phase === 'verify'; } catch (e) { verifying = false; } }
  // st.waiting 里的 scope 是内部值（模型自己改了需求、等用户重新说开工），不能原样给人看（第 76 条：状态栏写着"等你：scope"）
  const waiting = (st.waiting === 'scope' ? '需求文档被改过，说"开工"或 /vk-go 接着做' : st.waiting) || (st.paused ? '你说了停，说句话接着做' : !scope.ok ? '范围变化，等用户确认' : verifying ? '等你核验' : userWait && !cfg.autoSession ? '等用户自测验收' : '');
  // 需求阶段没有自动模式（第 85 条，仓库主人 2026-11-12 定的）：写需求那一段两种模式一样，一次写到 tasks、写完强制审修，有疑问就问。自动只在做任务那一段算
  // awaitingUser：Apply 能自动做的都做完、审过，只剩用户验收。配置开关开着时自动不再生效，但收工还要交这一轮的报告；会话开关开着时照样自动
  return { session: cfg.autoSession === true, switchOn: !!cfg.autoApply, effective: !!(st.on === true && !over && !waiting && !(st.aside && cfg.autoSession !== true) && st.stage === 'apply' && cfg.autoApply), phase: over || !st.on ? '普通任务' : st.stage === 'apply' ? '实施' : '需求与提案', waiting, archived: !!over, awaitingUser: !!(userWait && cfg.autoApply && st.on === true && !over && scope.ok && !st.waiting) };
}

/**
 * 这个会话碰过的变更：改过它目录里的文件、读过它的 tasks.md、用户的话（含斜杠命令的参数）或 openspec 命令里点了它的名。
 * 壳子里 git pull 下来的同事的变更，这个会话没碰过，不当成"进行中"（不带进度行，全自动也不推进它）。
 * 碰过的记在 state/<会话>-changes.json 里（会话记录很长时，早先碰过的不在末尾那一段里）。extra 是还没进会话记录的话（用户刚说的这句）
 */
function sessionChanges(sid, entries, changes, extra) {
  if (!changes.length) return [];
  // 没有会话号（不是 Claude Code 调的）：只看会话记录，不读写记录——不然几个没有会话号的调用会共用一份"碰过的变更"
  const key = sid && sid !== 'unknown' ? String(sid) + '-changes' : '';
  const known = new Set((key && readState(key).dirs) || []);
  const hit = new Set();
  const texts = [].concat(extra || []).map(String);
  for (const e of entries) if (isUserTurn(e) && !isTaskNote(e)) texts.push(textOf(e).split('\n').filter((l) => !/^\s*\[vibe-kit/.test(l)).join('\n'));
  const res = toolResults(entries);
  for (const c of toolCalls(entries, 0)) {
    const r = res.get(c.id);
    if (r && r.error) continue;
    const f = String(c.input.file_path || c.input.notebook_path || '');
    if (f) for (const ch of changes) if (underDir(f, ch.dir) && (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) || (c.name === 'Read' && /tasks\.md$/i.test(f)))) hit.add(normKey(ch.dir));
    if (/^(Bash|PowerShell)$/.test(c.name) && /\bopenspec\b/i.test(String(c.input.command || ''))) texts.push(String(c.input.command || ''));
    if (c.name === 'Skill' || c.name === 'SlashCommand') texts.push(JSON.stringify(c.input || {}));
  }
  for (const ch of changes) if (!hit.has(normKey(ch.dir)) && texts.some((t) => mentionsChange(t, ch.name))) hit.add(normKey(ch.dir));
  const fresh = [...hit].filter((d) => !known.has(d));
  if (key && fresh.length) writeState(key, { dirs: [...known, ...fresh].slice(-50), at: Date.now() });
  return changes.filter((ch) => hit.has(normKey(ch.dir)) || known.has(normKey(ch.dir)));
}

/** 把一个变更记到这个会话名下（归档命令点到的：会话里可能只审查、归档，没改过它目录里的文件） */
function touchChange(sid, dir) {
  if (!sid || sid === 'unknown' || !dir) return;
  try {
    const key = String(sid) + '-changes';
    const known = (readState(key).dirs) || [];
    const k = normKey(dir);
    if (!known.includes(k)) writeState(key, { dirs: [...known, k].slice(-50), at: Date.now() });
  } catch (e) { /* 记不了不影响归档 */ }
}

module.exports = { FLOW_SLASH, FLOW_TAG, FLOW_SKILL, syncAutoAnswer, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, APPLY_SLASH, APPLY_TAG, applyIntent, changeStarted, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, flowAdopt, readConfigFor, flowView, sessionChanges, touchChange };

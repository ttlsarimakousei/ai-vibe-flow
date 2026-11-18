'use strict';
/*
 * 自动实施这一趟（第 85—87 条，仓库主人 2026-11-12 定的）：自动只管实施，开只认提问框，关有三种，全部通过后自己关。
 *   开    需求审过后问"自动实施 / 实施（每步问我）/ 先不实施"，选了自动（每个 change 的需求审完都问，开着也问）；
 *         说了停、选了不实施、没问就让开工的，用户再让开工、接着做时问一次（flow 记 autoAsk，pre-edit 等它问完再改代码）。
 *         答案由 session-flow.js 的 syncAutoAnswer 认，选项的字样在 session-config.js 的 autoAnswerOf
 *   关    用户说"停""别自动了"（stopByUser：记 autoStopped，下次让接着做时问）；提问框选了人工、先不实施；
 *         全部通过（最后一个 change 的代码审过、全面自测登记过）套件自己关（finish，verify-gate 调）；
 *         任务都做完了、审查或自测催过没动、收工时已经没什么可催的，套件也自己关并让模型把情况告诉用户（giveUp，第 88 条：以前催一次就不管了，自动一直开着）
 *   核验  套件自己关了以后（记 autoFix），用户每报一次问题，改代码前问一次"自动实施 / 实施（每步问我）"（第 88 条，仓库主人 2026-11-12 定的"每次先问"，
 *         替代同一天早些时候的"照旧自动修"：一改代码就悄悄重开）。选了自动：改→审→自测，全部通过再关；下一次报问题再问，流程重复。
 *         一个用户回合只问一次（fixAskTurn 记着问过的那一轮）；套件关自动的那一轮不问。用户说了停、别自动了的不问（照旧等他说接着做时问）
 * autoFix 记在哪：大任务记在 state/big-task.json（跨会话，/vk-resume 接回也认），表外的 change 记在会话的流程记录里。
 * 表外的 change（不归哪个大任务）也有全面自测：跑它 design 的验收用例，workflow.js selftest --change 登记，记在 state/change-selftest.json
 */
const fs = require('fs');
const path = require('path');
const S = require('./session');

const SELFTEST = 'change-selftest';
const flowKey = (j) => String(j.session_id) + '-flow';

/** 表外的 change 自测登记过、之后代码没变 */
function changeTested(dir) {
  const r = S.readState(SELFTEST)[S.normKey(dir)];
  if (!r || (r.born && r.born !== S.changeBorn(dir))) return false;
  try { return r.code === require('./workspace').fingerprint(path.resolve(dir, '../../..'), 'code').hash; } catch (e) { return false; }
}
function noteChangeTest(dir, code, manual) { S.updateState(SELFTEST, (o) => { o[S.normKey(dir)] = { at: Date.now(), born: S.changeBorn(dir), code, manual: manual || [] }; }); }
function dropChangeTest(dirs) { S.updateState(SELFTEST, (o) => { for (const d of dirs) delete o[S.normKey(d)]; }); }

/** 这个会话在流程里动过的、目录还在的 change */
function plainDirs(j) { return S.flowChanges(j).filter((d) => fs.existsSync(d)); }

/** 这一轮是用户哪句话起的（那句话的指纹）；会话记录里找不到这一轮的开头给 '' */
function turnKey(j) {
  try {
    if (!j || !j.transcript_path) return '';
    const first = S.turnVoices(S.tailEntries(j.transcript_path, 3000000))[0];
    return first && first.kind !== 'answer' ? S.voiceKey(first) : '';
  } catch (e) { return ''; }
}

/** 套件自己关自动：记下之后用户再让改时先问（autoFix），关的这一轮不问 */
function closeByKit(j, task, why) {
  S.setSessionAuto(j, false, why);
  if (task) require('./big-task').setTaskState(task, { auto: false, autoFix: true });
  const turn = turnKey(j);
  S.updateState(flowKey(j), (s) => { if (!task) s.autoFix = true; if (turn) s.fixAskTurn = turn; delete s.autoAsk; return s; });
}

/** 全部通过，套件自己关自动（verify-gate 调）。task 是大任务，没有就是表外的 change */
function finish(j, task) {
  closeByKit(j, task, '全部通过，自动关了');
  S.hookLog('自动模式 会话 ' + j.session_id + ' 全部通过，套件关了自动');
}

/** 任务都做完了、what（代码审查没收尾、全面自测没登记）催过没动，收工时已经没什么可催的：关自动（verify-gate 调），不让它一直开着 */
function giveUp(j, task, what) {
  closeByKit(j, task, what + '，催过没动，自动关了');
  S.hookLog('自动模式 会话 ' + j.session_id + ' ' + what + '，催过没动，套件关了自动');
  try { require('./report').note(j, { kind: 'hand', title: '自动实施没走完就停了：' + what, detail: '收工时催过没有动，自动关了' }); } catch (e) { /* 记不了不影响 */ }
}

/** 用户说停、别自动了：关自动，记下来（再让接着做时问一次自动还是人工），核验期也不再问。返回关掉了什么（开着的自动、核验期的那一问） */
function stopByUser(j, why) {
  if (!j || !j.session_id || j.session_id === 'unknown') return false;
  const was = S.sessionAuto(j) === true;
  if (was) S.setSessionAuto(j, false, why);
  let fix = false;
  try {
    const B = require('./big-task'); const t = B.forSession(j);
    if (t) { const ts = B.taskState(t); fix = !!ts.autoFix; if (ts.autoFix || ts.auto) B.setTaskState(t, { autoFix: false, auto: false }); }
  } catch (e) { /* 记不了：核验时改代码可能还会问一次 */ }
  let flowFix = false;
  S.updateState(flowKey(j), (s) => { flowFix = !!s.autoFix; if (was || fix || s.autoFix) s.autoStopped = true; delete s.autoFix; delete s.autoAsk; return s; });
  return was || fix || flowFix;
}

/** 套件自己关过自动、还没被用户说停：这个会话的流程记录或它在做的大任务上记着 autoFix */
function fixRecorded(j, st) {
  if (st.autoFix) return true;
  try {
    // 每次改代码都会问到这里：哪个大任务都没记的直接走，不读计划表
    if (!Object.values(S.readState('big-task')).some((x) => x && x.autoFix)) return false;
    const B = require('./big-task'); const t = B.forSession(j);
    return !!(t && B.taskState(t).autoFix);
  } catch (e) { return false; }
}
/** 任务都做完了（大任务到了全面自测、等核验；表外的 change 任务都勾完）：这时提问框里答的自动还是人工，说的是怎么改用户报的问题 */
function allDone(j) {
  try {
    const B = require('./big-task'); const t = B.forSession(j);
    if (t) return ['selftest', 'verify'].includes(B.phaseFor(j, t).phase);
    const T = require('./task-types'); const dirs = plainDirs(j).filter((d) => T.tasks(d).length > 0);
    return dirs.length > 0 && dirs.every((d) => T.automatedLeft(d).length === 0);
  } catch (e) { return false; }
}
/**
 * 提问框里答了自动还是人工之后（session-flow.js syncAutoAnswer 调）：答的不是核验期那一问（是开工、接着做、下一个 change 的需求审完那一问），
 * 新的一趟实施开始了，autoFix 清掉——这一趟选了人工的，中间每一轮改代码不再问；选了自动的，全部通过时会重新记上。
 * 核验期那一问怎么认：钩子拦下让它问的（wasFix），或者任务都做完了（模型照规范自己先问的，钩子还没来得及拦）
 */
function answered(j, wasFix) {
  if (wasFix || allDone(j)) return;
  try { S.updateState(flowKey(j), (s) => { delete s.autoFix; return s; }); } catch (e) { /* 清不了：多问一次 */ }
  try { const B = require('./big-task'); const t = B.forSession(j); if (t && B.taskState(t).autoFix) B.setTaskState(t, { autoFix: false }); } catch (e) { /* 清不了：多问一次 */ }
}

// 用户让开工、接着做，自动关着：问一次（第 86 条）。选项的字样 session-config.js 的 autoAnswerOf 认，改了两边一起改
const ASK_START = '用户让开工了：先用提问框问一次怎么实施，选项写"自动实施""实施（每步问我）"（自动实施的说明写"做完任务→审查→改→复审……最后一个 change 还有全面自测→改→再测再审，全部通过后自动关；中途你说停就停"），用户选了再改代码。';
const ASK_RESUME = '用户让接着做，自动是用户说停关掉的：先用提问框问一次，选项写"自动接着做""人工接着做"，用户选了再改代码。';
const ASK_FIX = '自动已经关了（全部通过后关的，或者催了几次没动关的），用户又让改：改代码前先用提问框问一次怎么改，选项写"自动实施""实施（每步问我）"（自动实施的说明写"改→审查→自测，全部通过后自动关；中途你说停就停"），用户选了再改代码。只问这一次，不要连着问别的。';
function askLine(kind) { return kind === 'resume' ? ASK_RESUME : kind === 'fix' ? ASK_FIX : ASK_START; }
function markAsk(j, kind) { S.updateState(flowKey(j), (s) => { s.autoAsk = kind || 'start'; if (kind === 'resume') delete s.autoStopped; return s; }); }
/**
 * 改代码前要不要先问自动还是人工（pre-edit 调）。返回要说的话，不用等的给 ''。
 *   用户让开工、接着做，还没问过（flow 记着 autoAsk）
 *   套件自己关了自动之后，用户又让改（核验时报问题）：每个用户回合问一次（第 88 条）
 */
function askPending(j) {
  if (!j || !j.session_id || j.session_id === 'unknown') return '';
  S.syncAutoAnswer(j);
  let st = S.flowState(j);
  if (!st.on || S.sessionAuto(j) === true) return '';
  if (!st.autoAsk && !st.autoStopped && !st.paused && fixRecorded(j, st)) {
    const turn = turnKey(j);
    // 找不到这一轮的开头（会话记录太长）：分不清是不是新的一轮，不问
    if (turn && st.fixAskTurn !== turn) { S.updateState(flowKey(j), (s) => { s.autoAsk = 'fix'; s.fixAskTurn = turn; return s; }); st = S.flowState(j); }
  } else if (st.autoAsk === 'fix') {
    // 上一轮拦下让它问、用户没答就说了别的（复审 20261113 R4）：还等着的这一问算这一轮的，不然答完又按"新的一轮"再问一次
    const turn = turnKey(j);
    if (turn && st.fixAskTurn !== turn) S.updateState(flowKey(j), (s) => { s.fixAskTurn = turn; return s; });
  }
  return st.autoAsk ? askLine(st.autoAsk) : '';
}

module.exports = { finish, giveUp, stopByUser, answered, askLine, markAsk, askPending, changeTested, noteChangeTest, dropChangeTest, plainDirs, SELFTEST };

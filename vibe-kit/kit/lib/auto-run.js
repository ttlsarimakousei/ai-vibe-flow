'use strict';
/*
 * 自动实施这一趟（第 85—87 条，仓库主人 2026-11-12 定的；2026-11-18 改成"实施一律自动"，不再问自动还是人工）：全部通过后自己关。
 *   开    需求审过后问"开始实施 / 先不实施"，选了开始实施（或者到点没人答，hooks/ask-timeout.js）就开（每个 change 的需求审完都问）；
 *         没问就让开工的、说过停又说继续的，直接开（autoOn，task-anchor 调；以前问一次自动还是人工）。
 *         答案由 session-flow.js 的 syncAutoAnswer 认，选项的字样在 session-config.js 的 autoAnswerOf
 *   关    用户说"停""别自动了"（stopByUser：记 autoStopped，他说继续、开工时直接接着自动做）；提问框选了先不实施；
 *         全部通过（最后一个 change 的代码审过、全面自测登记过）套件自己关（finish，verify-gate 调）；
 *         任务都做完了、审查或自测催过没动、收工时已经没什么可催的，套件也自己关并让模型把情况告诉用户（giveUp，第 88 条：以前催一次就不管了，自动一直开着）
 *   核验  套件自己关了以后（记 autoFix），用户报问题、改代码时直接重开自动：改→审→自测，全部通过再关，下一次报问题照样（2026-11-18，
 *         替代 11-12 第 88 条的"每次先问"）。套件关自动的那一轮不重开（fixAskTurn 记着那一轮）。用户说了停、别自动了的不重开（等他说继续）。
 *         老版本留下的 autoAsk（等着问）也按直接开处理
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

/** 用户说停、别自动了：关自动，记下来（他说继续、开工时直接接着自动做），核验期改代码也不再自己重开。返回关掉了什么（开着的自动、核验期的自动修） */
function stopByUser(j, why) {
  if (!j || !j.session_id || j.session_id === 'unknown') return false;
  const was = S.sessionAuto(j) === true;
  if (was) S.setSessionAuto(j, false, why);
  let fix = false;
  try {
    const B = require('./big-task'); const t = B.forSession(j);
    // stopped：死机后 /vk-resume 接回也不自己开（复审 R9），等用户说继续、开工
    if (t) { const ts = B.taskState(t); fix = !!ts.autoFix; if (ts.autoFix || ts.auto || was) B.setTaskState(t, { autoFix: false, auto: false, stopped: true }); }
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
/** 任务都做完了（大任务到了全面自测、等核验；表外的 change 任务都勾完）：这时提问框里答的自动还是人工（老版本的选项），说的是怎么改用户报的问题 */
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

/**
 * 直接开自动（2026-11-18 仓库主人定的"实施一律自动"，替代第 86、88 条的"先问自动还是人工"）：用户说开工、说过停又说继续、核验时报问题改代码。
 * 清掉等着问的（autoAsk）、说过停的（autoStopped）、核验期的（autoFix）记号；大任务上记成开着，死机后 /vk-resume 接回照样开
 */
function autoOn(j, why) {
  if (!j || !j.session_id || j.session_id === 'unknown') return false;
  S.setSessionAuto(j, true, why);
  S.updateState(flowKey(j), (s) => { delete s.autoAsk; delete s.autoStopped; delete s.autoFix; return s; });
  try { const B = require('./big-task'); const t = B.forSession(j); if (t) B.setTaskState(t, { autoFix: false, auto: true, stopped: false }); } catch (e) { /* 记不了：接回时不恢复自动 */ }
  S.hookLog('自动模式 会话 ' + j.session_id + ' ' + why + '，开了自动');
  return true;
}
/**
 * 改代码前（pre-edit 调）：做任务那一段、自动关着，下面两种直接开自动，不拦、不问。返回开了没有。
 *   老版本留下的"等着问"（autoAsk）
 *   套件自己关了自动之后，用户在新的一轮里又让改（核验时报问题）：重开，改→审→自测，全部通过再关。套件关自动的那一轮不重开
 * 用户说过停（autoStopped、paused）的不开：等他说继续、开工（task-anchor 直接开）
 */
function autoOnEdit(j) {
  if (!j || !j.session_id || j.session_id === 'unknown') return false;
  S.syncAutoAnswer(j);
  const st = S.flowState(j);
  if (!st.on || st.stage !== 'apply' || S.sessionAuto(j) === true) return false;
  if (st.autoAsk) return autoOn(j, st.autoAsk === 'resume' ? '用户让接着做' : st.autoAsk === 'fix' ? '核验时报了问题' : '用户让开工');
  if (st.autoStopped || st.paused || !fixRecorded(j, st)) return false;
  const turn = turnKey(j);
  // 找不到这一轮的开头（会话记录太长）分不清是不是新的一轮、还是套件关自动的那一轮：不重开
  if (!turn || st.fixAskTurn === turn) return false;
  S.updateState(flowKey(j), (s) => { s.fixAskTurn = turn; return s; });
  return autoOn(j, '核验时报了问题');
}

module.exports = { finish, giveUp, stopByUser, answered, autoOn, autoOnEdit, changeTested, noteChangeTest, dropChangeTest, plainDirs, SELFTEST };

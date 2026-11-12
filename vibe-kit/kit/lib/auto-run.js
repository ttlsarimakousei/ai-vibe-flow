'use strict';
/*
 * 自动实施这一趟（第 85—87 条，仓库主人 2026-11-12 定的）：自动只管实施，开只认提问框，关有三种，全部通过后自己关。
 *   开    需求审过后问"自动实施 / 实施（每步问我）/ 先不实施"，选了自动（每个 change 的需求审完都问，开着也问）；
 *         说了停、选了不实施、没问就让开工的，用户再让开工、接着做时问一次（flow 记 autoAsk，pre-edit 等它问完再改代码）。
 *         答案由 session-flow.js 的 syncAutoAnswer 认，选项的字样在 session-config.js 的 autoAnswerOf
 *   关    用户说"停""别自动了"（stopByUser：记 autoStopped，下次让接着做时问）；提问框选了人工、先不实施；
 *         全部通过（最后一个 change 的代码审过、全面自测登记过）套件自己关（finish，verify-gate 调）
 *   核验  自己关之后用户核验时报的问题照旧自动修（仓库主人选的"照旧自动修"）：关的时候记 autoFix，核验时改了代码就重新打开（fixResume），
 *         自测结果作废，改→审→测，全部通过再关。用户说了停、别自动了的不再开
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

/** 全部通过，套件自己关自动（verify-gate 调）。task 是大任务，没有就是表外的 change */
function finish(j, task) {
  S.setSessionAuto(j, false, '全部通过，自动关了');
  if (task) require('./big-task').setTaskState(task, { auto: false, autoFix: true });
  else S.updateState(flowKey(j), (s) => { s.autoFix = true; return s; });
  S.hookLog('自动模式 会话 ' + j.session_id + ' 全部通过，套件关了自动');
}

/** 用户说停、别自动了：关自动，记下来（再让接着做时问一次自动还是人工），核验期的自动修也不再开。返回关掉了什么（开着的自动、核验期的自动修） */
function stopByUser(j, why) {
  if (!j || !j.session_id || j.session_id === 'unknown') return false;
  const was = S.sessionAuto(j) === true;
  if (was) S.setSessionAuto(j, false, why);
  let fix = false;
  try {
    const B = require('./big-task'); const t = B.forSession(j);
    if (t) { const ts = B.taskState(t); fix = !!ts.autoFix; if (ts.autoFix || ts.auto) B.setTaskState(t, { autoFix: false, auto: false }); }
  } catch (e) { /* 记不了：核验时改代码可能又自动修 */ }
  let flowFix = false;
  S.updateState(flowKey(j), (s) => { flowFix = !!s.autoFix; if (was || fix || s.autoFix) s.autoStopped = true; delete s.autoFix; delete s.autoAsk; return s; });
  return was || fix || flowFix;
}

/**
 * 核验时改了代码：重新打开自动，自测结果作废（回到全面自测）。
 * checkCode：没看到编辑工具改文件（跑审查、自测命令前调），比一下代码和自测时一不一样
 */
function fixResume(j, checkCode) {
  if (!j || !j.session_id || j.session_id === 'unknown' || S.sessionAuto(j) === true) return false;
  const st = S.flowState(j);
  if (!st.on || st.autoStopped || st.paused) return false;
  // 每次改文件都会调：哪儿都没记 autoFix 的直接走，不读计划表
  if (!st.autoFix && !Object.values(S.readState('big-task')).some((x) => x && x.autoFix)) return false;
  const B = require('./big-task');
  const t = B.forSession(j);
  if (t) {
    const ts = B.taskState(t);
    if (!ts.autoFix || !ts.selfTest || B.phaseOf(t).phase !== 'verify') return false;
    if (checkCode) { let now = ''; try { now = require('./workspace').fingerprint(path.dirname(t.osDir), 'code').hash; } catch (e) { return false; } if (!now || now === ts.selfTest.code) return false; }
    B.setTaskState(t, { selfTest: null, auto: true });
  } else {
    if (!st.autoFix) return false;
    const dirs = plainDirs(j); const rec = S.readState(SELFTEST);
    if (!dirs.length || !dirs.every((d) => rec[S.normKey(d)])) return false;
    if (checkCode && dirs.every(changeTested)) return false;
    dropChangeTest(dirs);
  }
  S.setSessionAuto(j, true, '核验时改了代码，照旧自动修');
  S.hookLog('自动模式 会话 ' + j.session_id + ' 核验时改了代码，重新打开自动');
  return true;
}

// 用户让开工、接着做，自动关着：问一次（第 86 条）。选项的字样 session-config.js 的 autoAnswerOf 认，改了两边一起改
const ASK_START = '用户让开工了：先用提问框问一次怎么实施，选项写"自动实施""实施（每步问我）"（自动实施的说明写"做完任务→审查→改→复审……最后一个 change 还有全面自测→改→再测再审，全部通过后自动关；中途你说停就停"），用户选了再改代码。';
const ASK_RESUME = '用户让接着做，自动是用户说停关掉的：先用提问框问一次，选项写"自动接着做""人工接着做"，用户选了再改代码。';
function askLine(kind) { return kind === 'resume' ? ASK_RESUME : ASK_START; }
function markAsk(j, kind) { S.updateState(flowKey(j), (s) => { s.autoAsk = kind || 'start'; if (kind === 'resume') delete s.autoStopped; return s; }); }
/** 用户让开工了、还没问自动还是人工：改代码前先问（pre-edit 调）。返回要说的话，不用等的给 '' */
function askPending(j) {
  if (!j || !j.session_id || j.session_id === 'unknown') return '';
  S.syncAutoAnswer(j);
  const st = S.flowState(j);
  if (!st.on || !st.autoAsk || S.sessionAuto(j) === true) return '';
  return askLine(st.autoAsk);
}

module.exports = { finish, stopByUser, fixResume, askLine, markAsk, askPending, changeTested, noteChangeTest, dropChangeTest, plainDirs, SELFTEST };

'use strict';
// 2026-11-01 起（K 批）这个文件只是出口：代码拆在 session-state、session-transcript、session-config、session-flow、session-voice、session-out、
// session-projects、session-proposal、session-plan、session-review、session-kitfiles 这几个文件里，导出的名字和以前一样，别的文件照旧 require('./session')。
/* 状态栏和各个钩子共用：读 OpenSpec 的任务进度、读会话记录的末尾、读套件开关。只用 Node 自带模块，任何异常都返回空，不能拖垮调用方。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const stateStore = require('./state-store');
const intent = require('./intent');
const { execFileSync } = require('child_process');
// 拆出去的检查（2026-11-01，K 批：guard-commit 只留调度）
const { KIT, sleepMs, readState, writeState, updateState, hookLog, GLOBAL_STATE, DISPOSABLE_STATE, cleanState, normKey, underDir, stateKindOf, sessionFileOf } = require('./session-state');
const { DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, autoAnswerOf, readConfig, sealConfig, commitModeOf } = require('./session-config');
const { FLOW_SLASH, FLOW_TAG, FLOW_SKILL, syncAutoAnswer, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, APPLY_SLASH, APPLY_TAG, applyIntent, changeStarted, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, flowAdopt, readConfigFor, flowView, sessionChanges, touchChange } = require('./session-flow');
const { ANSWERED, lastUserVoice, turnVoices, voiceKey, userSaid, userDeclined, commitDeclined, canWriteHandover, saidBefore, confirmApply, entryVoice, sessionHome, noteSessionHome, atHome } = require('./session-voice');
const { kitCodeHashes, kitCodeDrift, blockOut, askOut, pushFailOut, cli } = require('./session-out');
const { subdirs, looksLikeProject, nestedRepos, isShell, changeRoots, isDeferredTask, listChanges, activeChanges, ensureVibeIgnored, changeBorn, allChanges, archivedNames, archivedSince } = require('./session-projects');
const { uniquifyToolIds, tailEntries, textOf, lastUsageTokens, contextPercent, isUserTurn, turnStart, toolResults, isTaskNote, isTaskNotePrompt, toolCalls, projectReads } = require('./session-transcript');
const { findHedges, artifactOf, STAGE, pathTokens, pathExists, sectionOf, normTicks, addedLines, checkTasks, checkSpec, NEW_FILE, declaredNew, missingPathIssue, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, VERIFY_CMD, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, verifyPlan, verifyRan, mentionsChange, handoverStale, readTextFileRaw } = require('./session-proposal');
const { reviewRecord, recordReview, proposalReviewed, reviewAllowed, syncTicks, projectRootsOf, codeReviewed, codeReviewIssue, handoverReadIn, handoverWrittenIn } = require('./session-review');
const { readPlan, planStatusOf, refreshPlan, planSummary, planMissingInfo, planInit, planAddTask, planUnlisted, planAddUnlisted, planLink, artifactHash, snapshotArtifacts } = require('./session-plan');
const { CFG_DIR, realish, expandHome, isKitPath, isKitSkillScript, sessionStartMs, recordConvBaseline, convUpdateNotice } = require('./session-kitfiles');

module.exports = { ANSWERED, commitModeOf, DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, autoAnswerOf, syncAutoAnswer, FLOW_SLASH, FLOW_TAG, FLOW_SKILL, APPLY_SLASH, APPLY_TAG, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, flowAdopt, applyIntent, changeStarted, lastUserVoice, turnVoices, saidBefore, voiceKey, userSaid, userDeclined, commitDeclined, canWriteHandover, confirmApply, entryVoice, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, readConfigFor, sessionHome, noteSessionHome, atHome, blockOut, askOut, pushFailOut, cli, sleepMs, ensureVibeIgnored, hookLog, looksLikeProject, isShell, KIT, readConfig, sealConfig, kitCodeHashes, kitCodeDrift, subdirs, nestedRepos, changeRoots, listChanges, activeChanges, tailEntries, textOf, lastUsageTokens, contextPercent, readState, writeState, updateState, cleanState, GLOBAL_STATE, DISPOSABLE_STATE,
  STAGE, findHedges, artifactOf, pathTokens, pathExists, sectionOf, addedLines, checkTasks, checkSpec, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, artifactHash, normKey, snapshotArtifacts,
  VERIFY_CMD, isUserTurn, turnStart, toolCalls, toolResults, projectReads, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, verifyRan, verifyPlan, NEW_FILE, declaredNew, missingPathIssue,
  changeBorn, allChanges, archivedNames, archivedSince, reviewRecord, recordReview, proposalReviewed, codeReviewed,
  reviewAllowed, codeReviewIssue, touchChange, syncTicks, projectRootsOf, isDeferredTask, uniquifyToolIds,
  underDir, sessionChanges, handoverReadIn, handoverWrittenIn, normTicks,
  isTaskNote, isTaskNotePrompt,
  CFG_DIR, realish, expandHome, isKitPath, isKitSkillScript,
  mentionsChange, handoverStale, readPlan, planStatusOf, refreshPlan, planSummary, planMissingInfo, planInit, planAddTask, planUnlisted, planAddUnlisted, planLink,
  sessionStartMs, recordConvBaseline, convUpdateNotice, flowView, stateKindOf };

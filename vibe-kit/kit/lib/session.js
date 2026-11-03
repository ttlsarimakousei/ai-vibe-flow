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
const { KIT, sleepMs, readState, writeState, updateState, hookLog, GLOBAL_STATE, DISPOSABLE_STATE, cleanState, normKey, underDir, STATE_KINDS, stateKindOf, sessionFileOf } = require('./session-state');
const { DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, readConfig, sealConfig, commitModeOf } = require('./session-config');
const { FLOW_SLASH, FLOW_TAG, FLOW_SKILL, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, APPLY_SLASH, APPLY_TAG, applyIntent, planIntent, changeStarted, handoverStage, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, flowAdopt, readConfigFor, flowView, sessionChanges, touchChange } = require('./session-flow');
const { ANSWERED, lastUserVoice, turnVoices, voiceKey, userSaid, userDeclined, commitDeclined, canWriteHandover, saidBefore, confirmApply, entryVoice, sessionHome, noteSessionHome, atHome } = require('./session-voice');
const { kitCodeHashes, kitCodeDrift, blockOut, askOut, pushFailOut, cli } = require('./session-out');
const { subdirs, looksLikeProject, nestedRepos, isShell, changeRoots, TASK_DEFER, isDeferredTask, listChanges, activeChanges, ensureVibeIgnored, changeNames, archivedChanges, changeBorn, allChanges, archivedNames, archivedSince } = require('./session-projects');
const { uniquifyToolIds, tailEntries, textOf, lastUsageTokens, contextPercent, autoCompactWindowOf, autoCompactAt, gatewayLimit, nearGatewayLimit, isUserTurn, turnStart, toolResults, isTaskNote, isTaskNotePrompt, toolCalls, projectReads } = require('./session-transcript');
const { HEDGE_WORDS, hedgeHit, findHedges, artifactOf, STAGE, pathTokens, pathExists, sectionOf, normTicks, addedLines, checkTasks, checkSpec, NEW_FILE, declaredNew, missingPathIssue, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, VERIFY_CMD, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, toolAtCommandPos, verifyPlan, verifyRan, mentionsChange, handoverStale, readTextFileRaw } = require('./session-proposal');
const { taskNotes, reviewModeOf, isRecheck, reviewTargetOf, reviewIssues, reviewsIn, pendingReviewsIn, reviewRecord, recordReview, syncReviews, reviewDiagnostics, proposalReviewed, reviewAllowed, syncTicks, taskCodeFiles, projectRootsOf, unreviewedAfter, codeReviewed, codeReviewIssue, reviewMax, syncReviewRounds, reviewExhaustedText, reviewLoopIssue, handoverReadIn, handoverWrittenIn } = require('./session-review');
const { readPlan, planStatusOf, refreshPlan, planSummary, planMissingInfo, planInit, planAddTask, planUnlisted, artifactHash, snapshotArtifacts } = require('./session-plan');
const { CFG_DIR, realish, protectedKitPaths, expandHome, isKitPath, isKitSkillScript, isClaudeSettingsFile, mdSections, conventionDiff, skillIndex, sessionStartMs, recordConvBaseline, convUpdateNotice } = require('./session-kitfiles');

module.exports = { ANSWERED, commitModeOf, DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, FLOW_SLASH, FLOW_TAG, FLOW_SKILL, APPLY_SLASH, APPLY_TAG, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, flowAdopt, applyIntent, planIntent, changeStarted, handoverStage, lastUserVoice, turnVoices, saidBefore, voiceKey, userSaid, userDeclined, commitDeclined, canWriteHandover, confirmApply, entryVoice, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, readConfigFor, sessionHome, noteSessionHome, atHome, blockOut, askOut, pushFailOut, cli, sleepMs, ensureVibeIgnored, hookLog, looksLikeProject, isShell, KIT, readConfig, sealConfig, kitCodeHashes, kitCodeDrift, subdirs, nestedRepos, changeRoots, listChanges, activeChanges, tailEntries, textOf, lastUsageTokens, contextPercent, autoCompactWindowOf, autoCompactAt, gatewayLimit, nearGatewayLimit, readState, writeState, updateState, cleanState, GLOBAL_STATE, DISPOSABLE_STATE,
  HEDGE_WORDS, STAGE, findHedges, hedgeHit, artifactOf, pathTokens, pathExists, sectionOf, addedLines, checkTasks, checkSpec, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, artifactHash, normKey, snapshotArtifacts,
  VERIFY_CMD, isUserTurn, turnStart, toolCalls, toolResults, projectReads, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, verifyRan, verifyPlan, toolAtCommandPos, NEW_FILE, declaredNew, missingPathIssue,
  changeBorn, reviewModeOf, isRecheck, allChanges, archivedNames, archivedSince, reviewTargetOf, reviewIssues, reviewsIn, pendingReviewsIn, syncReviews, reviewDiagnostics, reviewRecord, recordReview, proposalReviewed, codeReviewed,
  reviewAllowed, codeReviewIssue, unreviewedAfter, touchChange, syncTicks, taskCodeFiles, projectRootsOf, isDeferredTask, TASK_DEFER, uniquifyToolIds,
  underDir, reviewMax, syncReviewRounds, reviewExhaustedText, reviewLoopIssue, sessionChanges, handoverReadIn, handoverWrittenIn, normTicks,
  taskNotes, isTaskNote, isTaskNotePrompt,
  CFG_DIR, realish, protectedKitPaths, expandHome, isKitPath, isKitSkillScript, isClaudeSettingsFile,
  mentionsChange, handoverStale, readTextFileRaw, readPlan, planStatusOf, refreshPlan, planSummary, changeNames, archivedChanges, planMissingInfo, planInit, planAddTask, planUnlisted,
  mdSections, conventionDiff, skillIndex, sessionStartMs, recordConvBaseline, convUpdateNotice, flowView, STATE_KINDS, stateKindOf, sessionFileOf };

'use strict';
/*
 * 配置：默认开关 DEFAULT_CONFIG、读配置（封条、会话自动开关覆盖）、会话自动开关的认法、提交方式。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const intent = require('./intent');
const { KIT, stateFile, readState, writeState } = require('./session-state');

const DEFAULT_CONFIG = { autoVerify: true, autoSeePage: true, autoCrossReview: true, commitCheck: true, specGate: true, tmpKeepDays: 7, reviewLoop: false, reviewMaxRounds: 3, autoMode: false, autoRequirements: false, autoApply: false, requirementsReviewMaxRounds: 3, applyReviewMaxRounds: 3, autoHandover: true, kitLock: true, kitBypass: 'ask', hookTransport: 'auto', handoverPercent: 70, contextLimitTokens: 1000000, handoverAsk: 'off', commitMode: 'off', lessons: 'on', lessonThreshold: 2, lessonMaxPerGroup: 10, lessonMaxChars: 120, lessonPromote: 'ask', autoMemory: 'off', autoUpdate: 'auto', updateCheckHours: 2, issueUpload: 'on', sshToken: 'auto', autoOnboard: true, lessonAuto: true, dbcrudDaemon: false, dbcrudDaemonIdleMinutes: 5, autoCompactPercent: 70, statusUsage: true, usageReport: 'on', perfReport: 'on', ccAutoMode: 'off', contextStrategy: 'compact', reviewExecutor: 'direct', reviewBudgetSeconds: 300, reviewMaxFiles: 20 };

/**
 * 套件开关（~/.claude/vibe-kit/config.json），可以在路由的配置页里改，也可以手改。
 * 三个"放松保护"的（kitLock 关掉、kitBypass 改成 auto、autoMode 打开）只认配置页、安装器改的：它们写配置时顺手记一份封条（state/config-seal.json）。
 * 文件里是放松的、封条里不是（多半是被程序绕开配置页直接改的），按安全的值算，并在 _tampered 里写明是哪几个
 * （状态栏、用户开口时提醒，记进问题反馈）。收紧（打开禁改、不许放行、关掉全自动）怎么改都认。
 * 全自动模式从 20260929 这一版起算放松保护的（它开着时放行不等用户）：老版本的封条里没有这一项，没有就认文件里的
 */
/*
 * 自动模式按会话开（问题表第 28 条，用户 2026-10-31 定的，替代 10-14、10-17 的"需求自动、Apply 自动两个配置开关"）：
 * 用户自己敲 /vk-auto（或者说"这个需求自动做""开自动"）打开，/vk-auto off（"别自动了""关掉自动"）关，只对这个会话有效，
 * 记在 state/<会话>-auto-switch.json，由开口钩子（task-anchor）按用户的原话写，模型写不了（~/.claude 禁改）。
 * 打开时需求、实施两段都算开（cfg.autoRequirements、cfg.autoApply 都为真），照旧要先探索、范围确认（qualify）才自动写需求。
 * 配置文件里旧的 autoApply、autoRequirements 不再出现在配置页，升级时清掉；还在的（测试、没升级的老配置）当作所有会话的默认值，会话里开过、关过的以会话为准
 */
const AUTO_SWITCH = (sid) => String(sid) + '-auto-switch';

/** 这个会话的自动开关：true 开、false 关、null 没动过（按配置的默认值） */
function sessionAuto(j) {
  const sid = j && j.session_id;
  if (!sid || sid === 'unknown') return null;
  const s = readState(AUTO_SWITCH(sid));
  return typeof s.on === 'boolean' ? s.on : null;
}

function setSessionAuto(j, on, by) {
  const sid = j && j.session_id;
  if (!sid || sid === 'unknown') return false;
  writeState(AUTO_SWITCH(sid), { on: !!on, at: Date.now(), by: String(by || '').slice(0, 200) });
  return true;
}

/** 用户每开口一次，把这个会话的开关文件时间拨到现在：它只在切换时写一次，不拨的话 3 天后被当成会话文件清掉，开着的自动悄悄变回人工（复审 V4） */
function touchSessionAuto(j) {
  const sid = j && j.session_id;
  if (!sid || sid === 'unknown') return false;
  try { const now = new Date(); fs.utimesSync(stateFile(AUTO_SWITCH(sid)), now, now); return true; } catch (e) { return false; }
}

/**
 * 用户这句话是不是在开、关这个会话的自动模式：'on'、'off'、''。只认用户自己的话，问句不算（"能自动做吗？"）。
 * 只认明说"自动模式"、或者整个分句就是"这个需求自动做""别自动了"的（复审 V2、V3：以前需求里的"超时自动关闭订单"会关、
 * "，自动完成登录"会开）；"自动提交""别自动推送"说的是别的事，不算
 */
const CLAUSE_END = '(?=\\s*(?:吧|啊|呀|哈)?\\s*(?:[，,。.；;！!\\n]|$))';

const CLAUSE_START = '(?:^|[，,。；;！!\\n])\\s*(?:请|那就|那你|那|就|你就|你先|先|帮我|你)?\\s*';

const AUTO_ON = new RegExp(CLAUSE_START + '(?:(?:开(?:启|一下)?|打开)\\s*自动模式|开(?:启|一下)?\\s*自动' + CLAUSE_END + '|自动模式\\s*(?:打开|开启|开起来|开一下)'
  + '|(?:这个|这些|下面的?|接下来的?|剩下的?)\\s*(?:需求|变更|任务)?\\s*(?:你)?\\s*(?:就|都)?\\s*(?:全)?自动(?:地)?\\s*(?:做|跑完|搞定|做完|完成|推进)(?:掉|完)?' + CLAUSE_END
  + '|全?自动(?:地)?\\s*(?:做|搞定|做完|跑完)(?:掉|完)?' + CLAUSE_END + ')');

const AUTO_OFF = new RegExp(CLAUSE_START + '(?:(?:关(?:掉|闭|一下)?|退出|停止|停掉)\\s*自动模式|(?:关(?:掉|闭)?|退出|停止)\\s*自动' + CLAUSE_END
  + '|自动模式\\s*(?:关(?:掉|闭|了)?|停(?:掉|了|下)?)|把\\s*自动(?:模式)?\\s*(?:关(?:掉|闭|了)?|停(?:掉|了)?)'
  + '|(?:别|不要|不用)(?:再)?\\s*自动(?:模式)?(?:了|做了?|搞了?)?' + CLAUSE_END + ')');

function autoSwitchSaid(text) {
  let raw = String(text || '');
  // 斜杠命令：/vk-auto 后面第一个词是 off、关、关闭、关掉就是关，别的（没有、on、开、需求原文）都是开（复审 V1：以前"关"后面跟 \b 认不出，/vk-auto 关 成了开）。
  // 钩子里拿到的也可能是带标签的样子
  const tag = /<command-name>\s*\/?vk-auto\s*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/i.exec(raw);
  if (tag) raw = '/vk-auto ' + (tag[1] || '');
  const sl = /^\s*\/vk-auto(?=\s|$)\s*(\S*)/i.exec(raw);
  if (sl) return /^(?:off|关|关闭|关掉)$/i.test(sl[1]) ? 'off' : 'on';
  const s = intent.plain(raw);
  if (!s) return '';
  if (AUTO_OFF.test(s)) return 'off';
  if (/[？?]|[吗么]\s*$/.test(s)) return '';
  return AUTO_ON.test(s) ? 'on' : '';
}

/** 一次钩子调用里同一个会话的配置只算一次（2026-11-01，K 批 M13），给出去的是副本；会话自动开关、配置封条写了就作废（session-state.js forgetState） */
function readConfig(j) {
  const sid = j && j.session_id ? String(j.session_id) : '';
  return JSON.parse(JSON.stringify(require('./invocation').memo('config|' + sid, () => readConfigRaw(j))));
}
function readConfigRaw(j) {
  let raw = {};
  try { let t = fs.readFileSync(path.join(KIT, 'config.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); raw = JSON.parse(t) || {}; } catch (e) { raw = {}; }
  const c = Object.assign({}, DEFAULT_CONFIG, raw);
  c.autoApply = Object.prototype.hasOwnProperty.call(raw, 'autoApply') ? raw.autoApply === true : raw.autoMode === true;
  c.autoMode = c.autoApply;
  const loose = [];
  if (c.kitLock === false) loose.push('kitLock');
  if (c.kitBypass === 'auto') loose.push('kitBypass');
  if (c.autoMode === true) loose.push('autoMode');
  for (const k of ['autoRequirements', 'autoApply']) if (c[k]) loose.push(k);
  if (loose.length) {
    const seal = readState('config-seal');
    const bad = loose.filter((k) => (['autoMode', 'autoRequirements', 'autoApply'].includes(k) ? seal[k] === false : seal[k] !== c[k]));
    if (bad.includes('kitLock')) c.kitLock = true;
    if (bad.includes('kitBypass')) c.kitBypass = 'ask';
    if (bad.includes('autoMode') || bad.includes('autoApply')) { c.autoMode = false; c.autoApply = false; }
    if (bad.includes('autoRequirements')) c.autoRequirements = false;
    if (bad.length) c._tampered = bad;
  }
  // 会话里开过、关过自动的，以会话为准（两段一起开、一起关）
  const sa = j ? sessionAuto(j) : null;
  if (sa !== null) { c.autoApply = sa; c.autoRequirements = sa; c.autoMode = sa; c.autoSession = sa; }
  return c;
}

/** 配置页、安装器写完配置后调：记下三个放松保护的开关现在的值（封条） */
function sealConfig(kitDir, cfg) {
  try {
    const d = path.join(kitDir || KIT, 'state');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config-seal.json'), JSON.stringify({ kitLock: cfg.kitLock !== false, kitBypass: ['ask', 'auto', 'off'].includes(cfg.kitBypass) ? cfg.kitBypass : 'ask', autoMode: cfg.autoApply === true, autoApply: cfg.autoApply === true, autoRequirements: cfg.autoRequirements === true, at: Date.now() }));
  } catch (e) { /* 记不了就按安全的值算 */ }
}

/**
 * 提交方式（用户 2026-10-17 定的，人工和自动都用）：off 关（不问、不自动提交）、ask 询问（到了提交时机问一次，默认）、auto 自动（到了时机直接提交）。
 * 以前的 autoCommit（只管 Apply 自动）、plainCommit（不走 OpenSpec 的改动）并进来了，不再认它们；没设过的按"询问"
 */
function commitModeOf(cfg) { return ['off', 'ask', 'auto'].includes(cfg && cfg.commitMode) ? cfg.commitMode : 'off'; }

module.exports = { DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, readConfig, sealConfig, commitModeOf };

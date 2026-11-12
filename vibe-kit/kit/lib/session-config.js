'use strict';
/*
 * 配置：默认开关 DEFAULT_CONFIG、读配置（封条、会话自动开关覆盖）、会话自动开关的认法、提交方式。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const intent = require('./intent');
const { KIT, stateFile, readState, writeState } = require('./session-state');

// 默认值只在字段表里定义一次（K1-4，lib/config-fields.js）
const { DEFAULT_CONFIG } = require('./config-fields');

/**
 * 套件开关（~/.claude/vibe-kit/config.json），可以在配置页里改，也可以手改。
 * 放松保护的全自动（autoMode、autoApply、autoRequirements 打开）只认配置页、安装器改的：它们写配置时顺手记一份封条（state/config-seal.json）。
 * 以前还管"禁止改套件""被检查拦住时能不能放行"两个开关，2026-11-04 去掉了（仓库主人定的：套件可以改，拦了可以自己放行）。
 * 文件里是放松的、封条里不是（多半是被程序绕开配置页直接改的），按安全的值算，并在 _tampered 里写明是哪几个
 * （状态栏、用户开口时提醒，记进问题反馈）。收紧（关掉全自动）怎么改都认。
 * 全自动模式从 20260929 这一版起算放松保护的（它开着时放行不等用户）：老版本的封条里没有这一项，没有就认文件里的
 */
/*
 * 自动模式按会话记（问题表第 28 条，用户 2026-10-31 定的），只管实施（第 85—87 条，仓库主人 2026-11-12 定的，替代 10-31 的"/vk-auto 开，需求、实施两段都管"）：
 *   开：只认提问框里选的"自动实施""自动接着做"（需求审过后问"自动实施 / 实施（每步问我）/ 先不实施"，说了停之后再开工时问"自动接着做 / 人工接着做"）。
 *       /vk-auto 命令删了，对话里说"开自动""这个需求自动做"不算（仓库主人选的"只认关"）。
 *   关：提问框选了"实施（每步问我）""人工接着做""先不实施"；用户说"别自动了""关掉自动"、说"停"（task-anchor）；全部通过后套件自己关（verify-gate）。
 * 记在 state/<会话>-auto-switch.json。需求阶段没有自动模式：写需求、审需求两种模式一样（一次写到 tasks，写完强制审修）。
 * cfg.autoRequirements 跟着开关走，只是给老代码留的名字，需求阶段不再看它。
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
 * 用户这句话是不是在关这个会话的自动模式：'off' 或 ''。开只认提问框（第 87 条，仓库主人选的"只认关"），这里不再返回 'on'。
 * 只认明说"自动模式"、或者整个分句就是"别自动了"的（复审 V2、V3：以前需求里的"超时自动关闭订单"会关）；"别自动推送"说的是别的事，不算。
 * "停"也关自动（第 86 条，仓库主人选的"插话不关，说停才关"），在 task-anchor 按 isStop 认
 */
const CLAUSE_END = '(?=\\s*(?:吧|啊|呀|哈)?\\s*(?:[，,。.；;！!\\n]|$))';

const CLAUSE_START = '(?:^|[，,。；;！!\\n])\\s*(?:请|那就|那你|那|就|你就|你先|先|帮我|你)?\\s*';

const AUTO_OFF = new RegExp(CLAUSE_START + '(?:(?:关(?:掉|闭|一下)?|退出|停止|停掉)\\s*自动模式|(?:关(?:掉|闭)?|退出|停止)\\s*自动' + CLAUSE_END
  + '|自动模式\\s*(?:关(?:掉|闭|了)?|停(?:掉|了|下)?)|把\\s*自动(?:模式)?\\s*(?:关(?:掉|闭|了)?|停(?:掉|了)?)'
  + '|(?:别|不要|不用)(?:再)?\\s*自动(?:模式)?(?:了|做了?|搞了?)?' + CLAUSE_END + ')');

function autoSwitchSaid(text) {
  const s = intent.plain(String(text || ''));
  if (!s) return '';
  return AUTO_OFF.test(s) ? 'off' : '';
}

/**
 * 提问框里的一个答案是不是在选自动：'on'、'off'、''（第 86 条）。套件让模型问的选项：
 *   需求审过：自动实施 / 实施（每步问我）/ 先不实施；说了停、选了不实施之后再开工：自动接着做 / 人工接着做（开工时是 自动实施 / 实施（每步问我））
 * 别的提问框里恰好以"实施"开头的选项（"实施方案 A"）不算：关的那几个要带"每步问我""人工""先不"。
 * loose：套件正等着这一问（用户开口让开工、还没问过）时，问题里说到自动、答案说"自动""auto"也算开，说"人工""手动""每步""先不"算关
 */
const ANSWER_ON = /^\s*(?:自动(?:实施|接着做|修)|auto\s*(?:实施|接着做)?)(?![^，,。；;]*(?:不要|别))/i;
const ANSWER_OFF = /^\s*(?:实施\s*[（(]\s*每步问我|人工(?:实施|接着做|修)|先不(?:实施|做|开工))/;
function autoAnswerOf(a, q, loose) {
  const s = String(a || '').replace(/[（(]推荐[)）]/g, '').trim();
  if (ANSWER_ON.test(s)) return 'on';
  if (ANSWER_OFF.test(s)) return 'off';
  // 问题本身要问的是自动、怎么做（"导出用哪种格式"答"自动识别"不算）
  if (loose && /自动|auto/i.test(String(q || '')) && /实施|开工|接着|怎么做/.test(String(q || ''))) {
    if (/人工|手动|每步|先不|不实施|不用自动|别自动|不要自动/.test(s)) return 'off';
    if (/自动|auto/i.test(s)) return 'on';
  }
  return '';
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
  if (c.autoMode === true) loose.push('autoMode');
  for (const k of ['autoRequirements', 'autoApply']) if (c[k]) loose.push(k);
  if (loose.length) {
    const seal = readState('config-seal');
    const bad = loose.filter((k) => (['autoMode', 'autoRequirements', 'autoApply'].includes(k) ? seal[k] === false : seal[k] !== c[k]));
    if (bad.includes('autoMode') || bad.includes('autoApply')) { c.autoMode = false; c.autoApply = false; }
    if (bad.includes('autoRequirements')) c.autoRequirements = false;
    if (bad.length) c._tampered = bad;
  }
  // 会话里开过、关过自动的，以会话为准（两段一起开、一起关）
  const sa = j ? sessionAuto(j) : null;
  if (sa !== null) { c.autoApply = sa; c.autoRequirements = sa; c.autoMode = sa; c.autoSession = sa; }
  return c;
}

/** 配置页、安装器写完配置后调：记下全自动这几个开关现在的值（封条） */
function sealConfig(kitDir, cfg) {
  try {
    const d = path.join(kitDir || KIT, 'state');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config-seal.json'), JSON.stringify({ autoMode: cfg.autoApply === true, autoApply: cfg.autoApply === true, autoRequirements: cfg.autoRequirements === true, at: Date.now() }));
  } catch (e) { /* 记不了就按安全的值算 */ }
}

/**
 * 提交方式（用户 2026-10-17 定的，人工和自动都用）：off 关（不问、不自动提交）、ask 询问（到了提交时机问一次，默认）、auto 自动（到了时机直接提交）。
 * 以前的 autoCommit（只管 Apply 自动）、plainCommit（不走 OpenSpec 的改动）并进来了，不再认它们；没设过的按"询问"
 */
function commitModeOf(cfg) { return ['off', 'ask', 'auto'].includes(cfg && cfg.commitMode) ? cfg.commitMode : 'off'; }

module.exports = { DEFAULT_CONFIG, sessionAuto, setSessionAuto, touchSessionAuto, autoSwitchSaid, autoAnswerOf, readConfig, sealConfig, commitModeOf };

'use strict';
/*
 * 用户说了什么：最后一句话、本轮的表态、提问框的答案、许可（审查、自测、提交、推送、归档）、开工确认、会话在哪个目录。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const intent = require('./intent');
const { flowState, setFlow, applyIntent, readConfigFor } = require('./session-flow');
const { tailEntries, textOf, isUserTurn, isTaskNote } = require('./session-transcript');
const { readState, writeState, updateState, normKey } = require('./session-state');

// ===================== 用户最后说的那句话：归档、提交要他点头 =====================
/*
 * 用户 2026-10-07 定的：归档要他自测过、说了才归档；不走 OpenSpec 的改动提交之前要问他、他说了才提交。
 * 认的是会话记录里他最后一次开口：自己打的字，或者提问框里选的答案（tool_result 里 "User has answered your questions: "问题"="答案""）。
 * 钩子附在消息里的提醒（[vibe-kit 开头的行）、后台任务的通知、打断标记、别的系统消息不算他说的话；斜杠命令认 <command-name>。
 * 只看最后一句：他说过"归档"之后又说"等等，还有个问题"，就得改完再问一次。
 */
// 自己打字回答的提问框，2.1.299 起结果文字是"The user answered: …"（docs/claude-code-facts.md）
const ANSWERED = /^\s*(?:User has answered your questions?|Your questions? have been answered|The user answered)\s*:/i;

/** 提问框答案里的 "问题"="答案" 一对一对 */
function answersOf(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ q: m[1], a: m[2] });
  return out;
}

/** 第 i 条记录是不是用户开口：{ kind: prompt | answer | command, text, id, at, pos }，不是返回 null。位置只用于查记录，不能标识许可。 */
function voiceAt(list, i) {
  const e = list[i];
  if (!e || e.type !== 'user' || e.isSidechain) return null;
  const at = Date.parse(e.timestamp || '') || 0;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : '';
      const structured = e.toolUseResult && e.toolUseResult.answers;
      if (ANSWERED.test(t) || (structured && typeof structured === 'object' && !Array.isArray(structured))) {
        // 只认真正提问框的结果；脚本输出里引用同样的文字不算人工确认。
        // 提问后用户又发了新指令，旧提问迟到的答案也不能盖过新指令。
        let fromAsk = false;
        for (let k = i - 1; k >= 0; k--) {
          const prev = list[k];
          if (isUserTurn(prev) && !isTaskNote(prev)) break;
          const blocks = prev && !prev.isSidechain && prev.type === 'assistant' && prev.message && prev.message.content;
          const call = Array.isArray(blocks) && blocks.find((x) => x && x.type === 'tool_use' && x.id === b.tool_use_id);
          if (call) { fromAsk = call.name === 'AskUserQuestion'; break; }
        }
        if (fromAsk) {
          // 先认结构化的那份（问题 → 答案）：结果文字里问题原样带着，问题里有英文引号时按文字拆会从最后一个引号截断
          // （第 89 条，2026-11-12：问"是否走 "/opsx:explore 探索"？"拆出来的问题只剩"？"）。没有结构化的（老版本、测试）照旧按文字拆
          const answers = [];
          if (structured && typeof structured === 'object' && !Array.isArray(structured)) for (const [q, a] of Object.entries(structured)) if (typeof a === 'string' && a) answers.push({ q, a });
          if (!answers.length) answers.push(...answersOf(t));
          if (answers.length) return { kind: 'answer', text: t, answers, id: String(e.uuid || b.tool_use_id || ''), at, pos: i };
        }
      }
    }
    return null;
  }
  if (!isUserTurn(e) || isTaskNote(e)) return null;
  const raw = textOf(e);
  if (/\[Request interrupted by user/.test(raw)) return null;
  const cmd = raw.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  if (cmd) { const a = raw.match(/<command-args>([\s\S]*?)<\/command-args>/); return { kind: 'command', command: cmd[1], text: '/' + cmd[1] + (a && a[1].trim() ? ' ' + a[1].trim() : ''), id: String(e.uuid || ''), at, pos: i }; }
  if (/^\s*</.test(raw)) return null;
  const text = raw.split('\n').filter((l) => !/^\s*\[vibe-kit/.test(l)).join('\n').trim();
  if (!text) return null;
  return { kind: 'prompt', text, id: String(e.uuid || ''), at, pos: i };
}

/** 用户最后一次开口：{ kind: prompt | answer | command, text, id, at, pos } */
function lastUserVoice(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) { const v = voiceAt(list, i); if (v) return v; }
  return null;
}

/** 这一轮里用户的每次开口，按先后：最后一句原话（或斜杠命令）起，加上之后每个提问框的答案 */
function turnVoices(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) { const v = voiceAt(list, i); if (!v) continue; out.unshift(v); if (v.kind !== 'answer') break; }
  return out;
}

/** 截取尾部或前面增加记录时，同一真人消息仍是同一次许可。缺少 UUID 的旧记录退回时间与正文。 */
function voiceKey(v) { return crypto.createHash('sha256').update(JSON.stringify(v ? [v.kind, v.id || v.at, v.text] : null)).digest('hex'); }

const YES_SHORT = /^(可以|好|是|行|同意|确认|没问题|对|嗯|ok|okay|yes|y)(的|吧|了|啊|呀)?[\s。！!]*$/i;

const NO_BEFORE = '(先别|别|不要|不用|不能|不准|不必|无需|先不|暂不|暂时不|不急着|不着急|等等再|晚点再|过会再|还不能|还不要|不可以|不让|没法)[^，,。！!？?\n]{0,6}';

const SAID = {
  reviewSkip: { yes: /审查|复审/, command: /^$/ },
  reviewAccept: { yes: /审查|风险|意见/, command: /^$/ },
  review: { yes: /审查|审核|复审|审一下|审审|再审/, command: /^(?:(?:vk-|ttls-)?cross-review|vk-review)$/i },
  // 编译、构建、快检不算要求自测（用户 2026-10-16 定的；10-17 审核问题 8：说"编译一下"曾被当成许可跑测试、起服务）
  test: { yes: /自测|测试|验证|复验|看页面|起服务|启动(?:服务|项目|应用)|跑起来/, command: /^(?:(?:vk-|ttls-)?see-page|vk-test)$/i },
  reviewBudget: { yes: /审查预算|重新审查/, command: /^$/ },
  handover: { yes: /交接|handover/i, command: /^(?:vk-|ttls-)?handover$/i },
  accept: { yes: /自测|验收/, command: /^$/ },
  push: { yes: /(?:^|[，,。；;\n])\s*(?:\d+[.、]\s*)?(?:(?:请|帮我|现在|直接|立即|及时|继续|顺便|可以|同意|确认|执行)\s*)*(?:提交(?:并|和|后)?\s*)?(?:git\s+(?:-C\s+\S+\s+)?push\b|push\b|推送|推到远端)(?!\s*(?:策略|规则|规范|检查|权限|功能|提示|失败|报错|问题|日志|脚本|命令|配置|结果|状态|记录|成功|完成|被|测试|的|的时候|时|过|了))/i, no: new RegExp(NO_BEFORE + '(推送|push|推到远端)|(推送|push)(之前|前|以后再说|稍后|晚点|等等|先等)|(推送|push)[^。！!\n]{0,40}([吗么？?]|怎么|怎样|如何|什么|为什么|是否|会不会)|(能不能|可不可以|要不要|是否)(推送|push)|推不推|(?:push|推送)[^。！!\n]{0,8}(我自己|我来|留给我)|(?:解释|讲解|示例|举例)[^。！!\n]{0,16}(push|推送)', 'i'), command: /^vk-push$/i },
  archive: { yes: /归档|archive|验收(通过|过了|没问题|ok)/i, no: new RegExp(NO_BEFORE + '(归档|archive)|(归档|archive)(之前|前|以后再说|稍后|晚点|等等|先等)|(归档|archive)[^。！!\n]{0,12}[吗么？?]|(能不能|可不可以|要不要|是否)归档', 'i'), command: /^(?:(opsx:|openspec[-:])(archive|bulk-archive)|vk-archive)$/i },
  commit: { yes: /提交|commit/i, no: new RegExp(NO_BEFORE + '(提交|commit)|(提交|commit)(之前|前|以后再说|稍后|晚点|等等|先等)|(提交|commit)[^。！!\n]{0,12}[吗么？?]|(能不能|可不可以|要不要|是否)提交|提不提交', 'i'), command: /^vk-commit$/i },
};

/*
 * 提问框的答案怎么算（用户 2026-10-21 定的，#179、#182、#187、#207、#210、#212、#213）：
 *   选项是用户点的，不要求动作词在句首。答案里有这件事的动作词、不含否定就算（"全量自测（推荐）""合成一条提交""复验 specs"）；
 *   问题里点了这件事、答案没重复动作词时，短肯定（"好""可以"）或执行的说法（自测"跑""就按这个范围跑"，审查"重试""兼容代理方式"，
 *   提交"提"，推送"推"）也算。"就这样定稿""直接写下一份"不是审查许可。模型给推荐项加的"（推荐）"先去掉再判断。
 */
const bareAnswer = (a) => String(a || '').replace(/\s*[（(]\s*(?:推荐|建议|recommended)\s*[）)]\s*/gi, ' ').trim();

const ANSWER_NO = /不|别|跳过|放弃|取消|算了|以后|稍后|晚点|回头|免了|省了|暂缓|先缓|改天/;

const ANSWER_DO = {
  test: /跑|执行|运行|重试|再试|开始|起来|^起/,
  review: /审|重试|再试|兼容|代理|reviewer|cross-review|独立模型|限时|^开始|^执行/i,
  commit: /^提(?:交)?(?:吧|了|上)?[。！!\s]*$/,
  push: /^(?:推(?:送|上去)?|(?:上)?传(?:上去)?)吧?[。！!\s]*$/,
};

// 往回看本轮时，后面的提问框选了这些就是不要了：前面给过的审查、自测许可作废
// "定稿并开工""只定稿"：写完 tasks 时定稿和开工合成的那一问（用户 2026-10-30 定的），选了也是不审
const ANSWER_DECLINE = { review: /就这样定稿|定稿并开工|只定稿|直接写下一份|写下一份|不审|跳过审查/, test: /不测|不跑|跳过自测|跳过测试/ };

const WIDE = ['review', 'test', 'commit', 'push', 'archive'];

/** 一个提问框答案对这件事是 'yes'（许可）、'no'（不要）还是 ''（没说） */
function answerSays(x, topic, g) {
  const a = bareAnswer(x.a);
  const asked = topic === 'push' ? /推送|\bpush\b/i.test(x.q) : g.yes.test(x.q) || intent.has(x.q, topic);
  if (intent.explicit(a, topic)) return 'yes';
  if (WIDE.includes(topic)) {
    // 审查意见那一问（"第 1 条意见改不改？"）：答"不改"是这条意见不改，不是不审——以前把审查许可作废了（审核第四节第 3 条）；
    // 答"改"就算准了这一点改完的自测、复验，不再另问（第 4 条，用户 2026-10-30 定的）
    // 认意见那一问只看"意见""第 N 条""这条"（复审 V11：以前带"问题"二字的都算，"这个问题怎么处理？"答"改用方案 B"成了自测许可）；
    // 答"不改"对审查、自测都不算表态（以前意见里提到"测试"，答"不改"就把自测许可作废了）
    const finding = /(?:意见|第\s*\d+\s*条|这一?条)/.test(x.q);
    if (finding && (topic === 'review' || topic === 'test') && /^不改/.test(a.trim())) return '';
    if (finding && topic === 'test' && /^改(?!天|日|成|为)/.test(a.trim())) return 'yes';
    if (intent.mentions(a, topic) && !intent.denied(a, topic) && !(g.no && g.no.test(a))) return 'yes';
    if (asked && !ANSWER_NO.test(a) && (YES_SHORT.test(a) || (ANSWER_DO[topic] && ANSWER_DO[topic].test(a)))) return 'yes';
    if (asked && (ANSWER_NO.test(a) || (ANSWER_DECLINE[topic] && ANSWER_DECLINE[topic].test(a)))) return 'no';
    // 问题问的是别的事、答案里明说了不要这件事（"先别提交""不推"）：也算否定（20261030 起提交、推送、归档往回看本轮，靠它收回前面的许可）
    if (intent.mentions(a, topic) && intent.denied(a, topic)) return 'no';
    // 写需求文档时套件给的固定选项（"就这样定稿""定稿并开工""只定稿""写下一份"，老提示是"直接写下一份"）：问题里没写"审查"也算不审
    if (topic === 'review' && /^(?:就这样定稿|定稿并开工|只定稿|直接写下一份|写下一份)/.test(a.trim())) return 'no';
    return '';
  }
  // 其它几类照旧：问题里说了是哪件事、答案是"好""可以"
  if (asked && !intent.denied(a, topic) && (YES_SHORT.test(a) || (topic === 'reviewAccept' && /^不改[。！!\s]*$/.test(a)))) return 'yes';
  return '';
}

/** 一次开口对这件事是 'yes'、'no' 还是 ''。返回 { say, text, target } */
function voiceSays(v, topic, g) {
  if (v.kind === 'answer') {
    const says = v.answers.map((x) => answerSays(x, topic, g));
    const matching = v.answers.filter((x, i) => says[i] === 'yes');
    return { say: matching.length ? 'yes' : says.includes('no') ? 'no' : '', text: v.answers.map((x) => x.a).join('；'), target: matching.map((x) => x.q + '\n' + x.a).join('\n') };
  }
  if (v.kind === 'command') { const name = v.command.replace(/^\//, ''); return { say: g.command.test(name) || name.toLowerCase() === topic ? 'yes' : '', text: v.text }; }
  if (intent.explicit(v.text, topic)) return { say: 'yes', text: v.text };
  // 对话里回的短话"就这样定稿""直接写下一份""不测了"，和提问框里选的一样算不要（#220）
  const short = intent.plain(v.text);
  const no = (intent.has(v.text, topic) && intent.denied(v.text, topic)) || (topic === 'review' && intent.explicit(v.text, 'reviewSkip')) || (short.length <= 30 && !!ANSWER_DECLINE[topic] && ANSWER_DECLINE[topic].test(short));
  return { say: no ? 'no' : '', text: v.text };
}

/**
 * 用户是不是让它做这件事。返回 { ok, voice, text, targetText }。
 * 审查、自测（用户 2026-10-21 定的）和提交、推送、归档（用户 2026-10-30 定的，替代 10-07、10-21 的"只看最后一句"）往回看本轮：
 *   本轮的原话和之后每个提问框答案里，最后一次明确表态算数——有一处给了许可、后面没有一处否定就算。
 *   以前提交、推送、归档只看最后一句：用户说了"改完提交并推送"，中间答了一个"要不要审查"，许可就作废，要再说一遍（审核 R1，问题表第 19 条）。
 *   用户下一次自己开口就是新的一轮，从头算。别的几类（接受、跳过……）照旧只看最后一句。
 * voice 是给许可的那一次开口，许可在 permissions.allow() 里按它绑定；推送、归档用过一次就消费，提交、审查这一轮能用好几次
 */
const TURN_TOPICS = new Set(['review', 'test', 'commit', 'push', 'archive']);

function userSaid(entries, topic) {
  const g = SAID[topic];
  const v = lastUserVoice(entries);
  if (!g || !v) return { ok: false, voice: v, text: '' };
  if (TURN_TOPICS.has(topic)) {
    let grant = null;
    for (const x of turnVoices(entries)) { const d = voiceSays(x, topic, g); if (d.say === 'yes') grant = { voice: x, d }; else if (d.say === 'no') grant = null; }
    if (grant) return { ok: true, voice: grant.voice, text: grant.d.text, targetText: grant.d.target };
    const d = voiceSays(v, topic, g);
    return { ok: false, voice: v, text: d.text, targetText: d.target };
  }
  const d = voiceSays(v, topic, g);
  return { ok: d.say === 'yes', voice: v, text: d.text, targetText: d.target };
}

/**
 * 这一轮里用户最后对这件事的表态是"不要"：返回那一次开口（原话或提问框），没有返回 null。
 * 收工检查用它别再问刚被拒的那一份（#220：提问框选了"就这样定稿"又问一遍；用户 2026-10-16 定的"说不用之后不再问"）
 */
function userDeclined(entries, topic) {
  const g = SAID[topic];
  if (!g) return null;
  let last = null;
  for (const x of turnVoices(entries)) { const d = voiceSays(x, topic, g); if (d.say) last = d.say === 'no' ? x : null; }
  return last;
}

/** 用户选择本次不提交后，同一份改动可正常收工；后来新增改动再按现有规则确认。 */
function commitDeclined(j, entries) {
  const v = lastUserVoice(entries); if (!v || !j.session_id) return false;
  const text = v.kind === 'answer' ? v.answers.map((a) => a.a).join('；') : v.text;
  if (!/(?:先不|先别|不要|不用|暂不|取消)提交|^(?:不提交|提交我自己来)[\s。！!]*$/.test(text) || /[？?]/.test(text)) return false;
  const W = require('./workspace'); const voice = voiceKey(v); const fingerprint = W.fingerprint(j.cwd, 'all').hash;
  let same = false;
  updateState(j.session_id + '-commit-declined', (s) => {
    const legacySame = s.voice && s.voiceSchema !== 2 && (!v.at || !s.at || v.at <= s.at);
    if (s.voice !== voice && !legacySame) { s.fingerprint = fingerprint; s.at = Date.now(); }
    s.voice = voice; s.voiceSchema = 2; same = s.fingerprint === fingerprint;
  });
  return same;
}

/** 自动压缩策略只允许明确手动交接；旧策略只在有效全自动实施且用户开着自动交接时自动写。 */
function canWriteHandover(j, cfg) {
  const c = cfg || readConfigFor(j);
  if (c.contextStrategy === 'handover' && c.autoMode && c.autoHandover !== false) return true;
  return userSaid(j && j.transcript_path ? tailEntries(j.transcript_path, 3000000) : [], 'handover').ok;
}

/** 模型在第 pos 条之前最后说的那段话（开工没点名时，用它认是哪个变更） */
function saidBefore(entries, pos) {
  for (let i = Math.min(pos, entries.length) - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    if (isUserTurn(e) && !isTaskNote(e)) break;
    if (e.type === 'assistant') { const t = textOf(e).trim(); if (t) return t.slice(-3000); }
  }
  return '';
}

const ENTRY_WORD = /openspec|opsx/i;
const ENTRY_NOT = /(?:不走|不用|别用|别走|不要|不需要|跳过|先不)\s*(?:走\s*)?(?:openspec|opsx)/i;
const EXPLORE_WORD = /探索|explore/i;
const VK_FLOW = /vk\s*流程/i;
const ENTRY_ANSWER_NO = /^(?:不|别|先不|直接改|跳过|算了|取消)|(?:不走|不用|别用|别走|不要|不需要|跳过|先不)\s*(?:走\s*)?(?:探索|explore|openspec|opsx|流程)/i;
/**
 * 提问框的一个答案是不是选了进流程（第 89 条、#467，2026-11-12）。以前要问题和答案里都有"探索"：模型自己写的问题不带这两个字
 * （"这个需求改动较大，怎么推进？"），用户选了"走 /opsx:explore 探索"也认不出，被拦下再问一遍。选项是用户点的，现在主要看答案：
 *   答案里点了 /opsx:…、openspec、vk 流程                                    → 算
 *   问题里点了这些，答案是"探索""好""可以""走流程"                            → 算
 *   答案里只有"探索"两个字（"先探索一下代码"）                                → 模型正要进流程（调技能、建变更、写提案）时算；
 *                                                                              strict（没人调、钩子自己记成在流程里）时不算，免得普通问答被带进流程
 *   "不探索""直接改""不走 openspec"                                           → 不算
 */
function entryAnswer(x, strict) {
  const a = bareAnswer(x && x.a).trim(); const q = String((x && x.q) || '');
  if (!a || ENTRY_ANSWER_NO.test(a)) return false;
  if (ENTRY_WORD.test(a) || VK_FLOW.test(a)) return true;
  const yes = EXPLORE_WORD.test(a) || YES_SHORT.test(a) || /^走(?:流程)?[\s。！!]*$/.test(a);
  if ((ENTRY_WORD.test(q) || VK_FLOW.test(q)) && yes) return true;
  if (strict) return false;
  return EXPLORE_WORD.test(a) || (EXPLORE_WORD.test(q) && yes);
}
/** 这一轮提问框里选了进流程的那个答案（没有返回 null）。strict 见 entryAnswer */
function entryPick(j, strict) {
  if (!j || !j.transcript_path) return null;
  for (const v of turnVoices(tailEntries(j.transcript_path, 3000000))) if (v.kind === 'answer' && v.answers.some((a) => entryAnswer(a, strict))) return v;
  return null;
}
/** 这一轮用户明确要进流程：话里有 openspec（"不走 openspec"不算），或者提问框里选了探索（用户 2026-11-03 定的，不按模糊的话猜） */
function entryVoice(j) {
  if (!j || !j.transcript_path) return false;
  for (const v of turnVoices(tailEntries(j.transcript_path, 3000000))) {
    if (v.kind === 'prompt' && ENTRY_WORD.test(v.text) && !ENTRY_NOT.test(v.text)) return true;
    if (v.kind === 'answer' && v.answers.some((a) => entryAnswer(a, false))) return true;
  }
  return false;
}
/**
 * 模型要进流程（调 OpenSpec 的技能、建变更、写提案）：已经在流程里，或者这一轮用户明确要进，就记成在流程里（写需求那一段）并放行。
 * 以前只有调技能那条路会记（第 89 条）：选了探索、模型没调技能、自己读代码探索的，下一轮建变更、写提案又被拦"用户没说要走 OpenSpec"
 */
function enterByVoice(j, why) {
  if (flowState(j).on) return true;
  if (!entryVoice(j)) return false;
  setFlow(j, true, why || '用户明确要走 OpenSpec', 'plan');
  return true;
}

/**
 * 提问框不触发用户开口钩子：用技能、打勾、改代码前补读最新的真实开工答案（旧第 2 类：pre-edit 以前没补读，提问框选了开工、改代码还是拦）。
 * more.hint：这一步要改的文件；more.args：/opsx:apply 技能的参数（用户只说"开工"、有几个变更时，用它们认是哪个，#214）
 */
function confirmApply(j, more) {
  const { hint, args } = more || {};
  const st = flowState(j);
  if (!st.on || !j.transcript_path) return false;
  // 做任务那一段里改了需求、旧开工范围已经失效的，也要能凭新的开工答案重新开工（提问框选开工，旧第 2 类）
  if (st.stage !== 'plan' && !(st.applyScope && !require('./apply-scope').valid(j).ok)) return false;
  const entries = tailEntries(j.transcript_path, 3000000);
  // 往回看本轮（和提交、推送一样，用户 2026-10-30 定的）：选了"定稿并开工"之后又答了"提交定稿"，开工照旧算；后面说了"先不开工""只定稿"的收回
  let v = null;
  for (const x of turnVoices(entries)) { if (startsApply(x)) v = x; else if (stopsApply(x)) v = null; }
  if (!v) return false;
  const text = v.kind === 'answer' ? v.answers.map((a) => a.a).join('；') : v.text;
  const voice = voiceKey(v);
  if (st.applyVoice === voice) return false; // 同一次开工答案不能在提案修订后重新授权。
  const grantedAt = st.lastApplyAt || st.applySource && st.applySource.at || st.applyScope && st.applyScope.at || 0;
  if (st.applyVoice && st.applyVoiceSchema !== 2 && (!v.at || !grantedAt || v.at <= grantedAt)) return false;
  const context = v.kind === 'answer' ? v.answers.filter(answerStartsApply).map((a) => a.q).join('\n') : '';
  if (!require('./apply-scope').grant(j, text, context, { said: saidBefore(entries, v.pos), hint, args }).ok) return false;
  setFlow(j, true, '用户确认开工', 'apply');
  return true;
}

/**
 * 提问框的一个答案算不算开工：答案里有开工说法（"定稿并开工""开工"），或者问的就是开工（"能开工吗？""要执行 apply 吗？"）、
 * 答的是"可以""好"这类短话（审核 P40：以前只看答案，问"开工吗"、答"可以"不算开工，要用户再说一遍）
 */
function answerStartsApply(x) {
  if (applyIntent(x.a)) return true;
  // 需求审过那一问选"自动实施""自动接着做"也是开工（复审 20261112 R1：它不是开工说法，选了自动却改不了代码）
  if (require('./session-config').autoAnswerOf(x.a, x.q) === 'on') return true;
  const a = bareAnswer(x.a);
  return YES_SHORT.test(a) && intent.has(x.q, 'apply') && !/(?:先不|暂不|不要|别)[^，,。；;！!\n]{0,6}(?:开工|apply|执行|实施)/i.test(x.q);
}

function startsApply(v) { return !!v && (v.kind === 'answer' ? v.answers.some(answerStartsApply) : applyIntent(v.text)); }

/** 一次开口收回开工："先不开工""暂不执行""继续修改""只定稿"，或者问开工、答了不 */
function stopsApply(v) {
  if (!v) return false;
  const parts = v.kind === 'answer' ? v.answers.map((x) => ({ q: x.q, a: bareAnswer(x.a) })) : [{ q: '', a: String(v.text || '') }];
  return parts.some((x) => (intent.has(x.a, 'apply') && intent.denied(x.a, 'apply')) || /^(?:暂不执行|暂不开工|先不开工|继续修改|只定稿)/.test(x.a.trim()) || (!!x.q && intent.has(x.q, 'apply') && ANSWER_NO.test(x.a) && !applyIntent(x.a)));
}

/**
 * 这个会话是在哪个目录启动的。钩子收到的 cwd 是"现在所在的目录"：模型单独跑过一条 cd，它就跟着变了。
 * 议题 #8：会话在壳子里启动，后来 cwd 成了 子项目/ui——套件把 ui 当成一个项目去探索、把全自动报告写进 ui/.vibe、
 * 在 ui 往上找不到壳子里定过的产出位置。项目级的事（探索、报告、找变更、找项目说明）都按启动目录算，只有算命令里的相对路径才用现在的目录。
 * 认法：会话开始时记下的（state/<会话>-home.json）；没记的，看会话记录所在的目录名——那是启动目录按 Claude Code 的规矩编出来的
 * （字母数字以外的字符都换成 -），从现在的目录往上找编出来一样的那一层；都认不出就用现在的目录
 */
/** 会话记录所在的目录名对得上的那一层（从现在的目录往上找）；对不上返回 '' */
function homeByTranscript(j) {
  try {
    const tp = j && j.transcript_path;
    if (!tp) return '';
    const enc = path.basename(path.dirname(String(tp))).toLowerCase();
    const code = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
    let d = path.resolve((j && j.cwd) || process.cwd());
    for (let i = 0; i < 12 && enc.length > 3; i++) { if (code(d) === enc) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  } catch (e) { /* 认不出 */ }
  return '';
}

function sessionHome(j) {
  const cwd = path.resolve((j && j.cwd) || process.cwd());
  try {
    const sid = j && j.session_id;
    if (sid && sid !== 'unknown') { const h = readState(String(sid) + '-home').dir; if (h && fs.existsSync(h)) return path.resolve(h); }
    const h = homeByTranscript(j);
    if (h) return h;
  } catch (e) { /* 认不出就用现在的目录 */ }
  return cwd;
}

/** 会话开始（不是压缩之后）：记下启动目录。/clear 出来的新会话收到的也是"现在所在的目录"，先按会话记录的目录名认 */
function noteSessionHome(j) {
  try { if (j && j.session_id && j.session_id !== 'unknown' && j.cwd) writeState(String(j.session_id) + '-home', { dir: homeByTranscript(j) || path.resolve(j.cwd), ownerPid: process.ppid, at: Date.now() }); } catch (e) { /* 记不了就靠会话记录的目录名认 */ }
}

/** 同一份输入，cwd 换成会话的启动目录（原来的留在 realCwd） */
function atHome(j) {
  const home = sessionHome(j);
  const cur = path.resolve((j && j.cwd) || process.cwd());
  return normKey(home) === normKey(cur) ? j : Object.assign({}, j, { cwd: home, realCwd: cur });
}

module.exports = { ANSWERED, lastUserVoice, turnVoices, voiceKey, userSaid, userDeclined, commitDeclined, canWriteHandover, saidBefore, confirmApply, entryVoice, entryPick, enterByVoice, sessionHome, noteSessionHome, atHome };

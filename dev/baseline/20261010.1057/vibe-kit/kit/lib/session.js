'use strict';
/* 状态栏和各个钩子共用：读 OpenSpec 的任务进度、读会话记录的末尾、读套件开关。只用 Node 自带模块，任何异常都返回空，不能拖垮调用方。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const DEFAULT_CONFIG = { autoVerify: true, autoSeePage: true, autoCrossReview: true, commitCheck: true, specGate: true, outputGate: true, vibeTidy: true, tmpKeepDays: 7, serverGuard: true, autoResume: false, reviewLoop: false, reviewMaxRounds: 3, autoMode: false, autoHandover: true, kitLock: true, kitBypass: 'ask', hookTransport: 'auto', handoverPercent: 70, contextLimitTokens: 1000000, handoverAsk: 'ask', autoCommit: 'task', lessons: 'on', lessonThreshold: 2, lessonMaxPerGroup: 10, lessonMaxChars: 120, lessonPromote: 'ask', autoMemory: 'off', autoUpdate: 'auto', updateCheckHours: 2, issueUpload: 'on', sshToken: 'auto', autoOnboard: true, lessonAuto: true, dbcrudDaemon: false, dbcrudDaemonIdleMinutes: 5, autoCompactPercent: 90, statusUsage: true, pullBeforeWork: true, usageReport: 'on', ccAutoMode: 'off', plainCommit: 'ask' };
/**
 * 套件开关（~/.claude/vibe-kit/config.json），可以在路由的配置页里改，也可以手改。
 * 三个"放松保护"的（kitLock 关掉、kitBypass 改成 auto、autoMode 打开）只认配置页、安装器改的：它们写配置时顺手记一份封条（state/config-seal.json）。
 * 文件里是放松的、封条里不是（多半是被程序绕开配置页直接改的），按安全的值算，并在 _tampered 里写明是哪几个
 * （状态栏、用户开口时提醒，记进问题反馈）。收紧（打开禁改、不许放行、关掉全自动）怎么改都认。
 * 全自动模式从 20260929 这一版起算放松保护的（它开着时放行不等用户）：老版本的封条里没有这一项，没有就认文件里的
 */
function readConfig() {
  let raw = {};
  try { let t = fs.readFileSync(path.join(KIT, 'config.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); raw = JSON.parse(t) || {}; } catch (e) { raw = {}; }
  const c = Object.assign({}, DEFAULT_CONFIG, raw);
  const loose = [];
  if (c.kitLock === false) loose.push('kitLock');
  if (c.kitBypass === 'auto') loose.push('kitBypass');
  if (c.autoMode === true) loose.push('autoMode');
  if (loose.length) {
    const seal = readState('config-seal');
    const bad = loose.filter((k) => (k === 'autoMode' ? seal.autoMode === false : seal[k] !== c[k]));
    if (bad.includes('kitLock')) c.kitLock = true;
    if (bad.includes('kitBypass')) c.kitBypass = 'ask';
    if (bad.includes('autoMode')) c.autoMode = false;
    if (bad.length) c._tampered = bad;
  }
  return c;
}
/** 配置页、安装器写完配置后调：记下三个放松保护的开关现在的值（封条） */
function sealConfig(kitDir, cfg) {
  try {
    const d = path.join(kitDir || KIT, 'state');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'config-seal.json'), JSON.stringify({ kitLock: cfg.kitLock !== false, kitBypass: ['ask', 'auto', 'off'].includes(cfg.kitBypass) ? cfg.kitBypass : 'ask', autoMode: cfg.autoMode === true, at: Date.now() }));
  } catch (e) { /* 记不了就按安全的值算 */ }
}
// ===================== 全自动模式只在走 OpenSpec 流程时算开着 =====================
/*
 * 用户 2026-09-30 定的。起因：全自动开着，另开一个窗口做检索，那个窗口收工时自己去接着做没做完的变更，差点和正在做这个变更的窗口打架；
 * 只敲了 /ttls-onboard，收工检查却催着"直接开始 /opsx:apply"（议题 #9）。
 * 每个会话记一份"现在是不是在走 OpenSpec 流程"（state/<会话>-flow.json），用户开口时定（hooks/task-anchor.js）：
 *   敲了 /opsx:…、/openspec-…；提了要走提案的需求；接着交接记录做；点了没归档的变更的名字让它做  → 在流程里
 *   "继续""好"这类话，"不要停""别等我，做完再说"                                               → 跟上一轮一样（上一轮是插进来的一句问话，就跟再上一轮）
 *   已经在流程里，又说了一句不是问句的话（"3.3 我执行过了，接着归档"）                           → 还在流程里
 *   自己敲 /ttls-cross-review、/ttls-see-page、/ttls-handover                                   → 跟上一轮一样
 *   问句、别的斜杠命令（/ttls-onboard…）、让它停的话（"停""等等，先别提交""不用了"）            → 不在流程里
 *   让它出一份代码之外的东西（说明、报告、清单，"生成一个文件记一下"）                        → 不在流程里（放哪照常问，全自动不作数）
 * 这一轮里模型自己调了 OpenSpec 的技能、建了变更（用户用大白话让它出提案），也算进了流程（hooks/guard-ask.js、guard-commit.js）。
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
  updateState(k, (st) => { st.on = !!on; st.why = String(why || ''); st.at = Date.now(); if (on) st.was = st.at; if (stage === 'plan' || stage === 'apply') st.stage = stage; return st; });
  return !!on;
}
/** 这个会话在流程里动手做了这个变更 */
function flowTouch(j, dir) {
  const k = flowKey(j);
  if (!k || !dir) return;
  try {
    const d = normKey(dir);
    const cur = flowState(j).changes;
    if (Array.isArray(cur) && cur.includes(d)) return;
    updateState(k, (st) => { const list = Array.isArray(st.changes) ? st.changes : []; if (!list.includes(d)) st.changes = list.concat(d).slice(-50); return st; });
  } catch (e) { /* 记不了：收工时不催这个变更，不影响干活 */ }
}
function flowChanges(j) { const c = flowState(j).changes; return Array.isArray(c) ? c : []; }
/** 这个会话在流程的哪一段：plan / apply；没记的（装这一版之前就开着的会话）按 apply 算 */
function flowStage(j) { const s = flowState(j).stage; return s === 'plan' ? 'plan' : 'apply'; }
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
const APPLY_SLASH = /^\s*\/(opsx:|openspec[-:])(apply|archive|bulk-archive|verify|sync)\b/i;
const APPLY_TAG = /<command-name>\s*\/?(opsx:|openspec[-:])(apply|archive|bulk-archive|verify|sync)\b/i;
// 明说开工的话。HARD 怎么都算；SOFT、WEAK 在同一句里说的是提案那一段的事（"开始做提案""接着做 a1 的提案"）时不算
const APPLY_HARD = /开工|开干|开搞|\bapply\b|(按|照|依)(提案|任务|tasks|清单)(做|实现|开发)|可以(做|开工|实现|开始做)了/i;
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
  if (APPLY_SLASH.test(s) || APPLY_TAG.test(s) || APPLY_HARD.test(s)) return true;
  if (TASK_NUM.test(s) && TASK_DO.test(s)) return true;
  return (APPLY_SOFT.test(s) || APPLY_WEAK.test(s)) && !PLAN_EDIT.test(s);
}
/** 这句话是不是在说提案那一段的事 */
const planIntent = (p) => PLAN_EDIT.test(String(p || ''));
/** 这个变更开工了没有：tasks.md 里有打过勾的任务 */
function changeStarted(dir) { try { return /^\s*[-*]\s*\[[xX]\]/m.test(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8')); } catch (e) { return false; } }
/** 接着交接记录做：记录里提到的变更开过工就是 apply；没提变更的，看记录里有没有在说任务 */
function handoverStage(cwd) {
  try {
    let d = path.resolve(cwd || process.cwd());
    let text = '';
    for (let i = 0; i < 2; i++) { const f = path.join(d, '.vibe', 'handover.md'); if (fs.existsSync(f)) { text = fs.readFileSync(f, 'utf8'); break; } const up = path.dirname(d); if (up === d) break; d = up; }
    if (!text) return 'apply';
    const named = allChanges(cwd || process.cwd()).filter((c) => mentionsChange(text, c.name));
    if (named.length) return named.some((c) => changeStarted(c.dir)) ? 'apply' : 'plan';
    return /apply|打勾|任务\s*\d|(^|[^\d.])\d+\.\d+(?![\d.])/i.test(text) ? 'apply' : 'plan';
  } catch (e) { return 'apply'; }
}

// ===================== 做完的功能上发现的问题：先查清原因，改动小直接改 =====================
/*
 * 用户 2026-10-07 定的：自测、测试、用户反馈发现的问题（两个弹窗顺序反了这种，改两三个前端文件就好），不要起一整条 OpenSpec 流程。
 * 先查清原因（归档过的用 tools/trace.js 溯源），改动小——三个文件以内、不改接口和表结构、不改需求——就直接改、验证、按代码模式简单审一下改动点。
 * 改动大、要改需求或规格、接口、表结构的，先告诉用户要改什么，用户说了走提案再 /opsx:propose。
 * 怎么认"在报问题"：BUG_REPORT（用户开口时提醒，hooks/task-anchor.js；要新建提案时拦一次，hooks/guard-spec.js）。用户明说要走提案、开变更的（WANTS_PROPOSAL）不算。
 */
const BUG_REPORT = /(测试|自测|验收|用户|客户|现场|联调|试了|点了|跑了|看了)[^。！？\n]{0,12}(发现|反馈|报|说|看到)|bug|缺陷|报错|有问题|出问题|反了|没生效|不显示|显示不|不出来|没反应|点不了|打不开|进不去|不能用|用不了|失效|异常|乱码|错位|闪退|卡住了/i;
const WANTS_PROPOSAL = /提案|变更|propose|opsx:|走流程|走 ?openspec/i;
const SMALL_FIX_TEXT = '先查清原因，改动小（三个文件以内、不改接口和表结构、不改需求）就直接改、验证过，按 /ttls-cross-review 的代码模式只给改动点简单审一下，再交代，不要新开变更；改的是没归档的变更做出来的东西，在它的 revisions.md 记一条（起因：用户要求）。改动大、要改需求或规格、接口、表结构的，先告诉我要改什么、为什么，我说走提案再 /opsx:propose。';

// ===================== 用户最后说的那句话：归档、提交要他点头 =====================
/*
 * 用户 2026-10-07 定的：归档要他自测过、说了才归档；不走 OpenSpec 的改动提交之前要问他、他说了才提交。
 * 认的是会话记录里他最后一次开口：自己打的字，或者提问框里选的答案（tool_result 里 "User has answered your questions: "问题"="答案""）。
 * 钩子附在消息里的提醒（[vibe-kit 开头的行）、后台任务的通知、打断标记、别的系统消息不算他说的话；斜杠命令认 <command-name>。
 * 只看最后一句：他说过"归档"之后又说"等等，还有个问题"，就得改完再问一次。
 */
const ANSWERED = /^\s*User has answered your questions?:/;
/** 提问框答案里的 "问题"="答案" 一对一对 */
function answersOf(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ q: m[1], a: m[2] });
  return out;
}
/** 用户最后一次开口：{ kind: prompt | answer | command, text, at, pos }；没有返回 null */
function lastUserVoice(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || e.type !== 'user' || e.isSidechain) continue;
    const at = Date.parse(e.timestamp || '') || 0;
    const c = e.message && e.message.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
      for (const b of c) {
        if (!b || b.type !== 'tool_result') continue;
        const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : '';
        if (ANSWERED.test(t)) {
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
          if (fromAsk) return { kind: 'answer', text: t, answers: answersOf(t), at, pos: i };
        }
      }
      continue;
    }
    if (!isUserTurn(e) || isTaskNote(e)) continue;
    const raw = textOf(e);
    if (/\[Request interrupted by user/.test(raw)) continue;
    const cmd = raw.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
    if (cmd) { const a = raw.match(/<command-args>([\s\S]*?)<\/command-args>/); return { kind: 'command', command: cmd[1], text: '/' + cmd[1] + (a && a[1].trim() ? ' ' + a[1].trim() : ''), at, pos: i }; }
    if (/^\s*</.test(raw)) continue;
    const text = raw.split('\n').filter((l) => !/^\s*\[vibe-kit/.test(l)).join('\n').trim();
    if (!text) continue;
    return { kind: 'prompt', text, at, pos: i };
  }
  return null;
}
const YES_SHORT = /^(可以|好|是|行|同意|确认|没问题|对|嗯|ok|okay|yes|y)(的|吧|了|啊|呀)?[\s。！!]*$/i;
const NO_BEFORE = '(先别|别|不要|不用|不能|不准|不必|无需|先不|暂不|暂时不|不急着|不着急|等等再|晚点再|过会再|还不能|还不要|不可以|不让|没法)[^，,。！!？?\n]{0,6}';
const SAID = {
  push: { yes: /(?:^|[，,。；;\n])\s*(?:\d+[.、]\s*)?(?:(?:请|帮我|现在|直接|立即|及时|继续|顺便|可以|同意|确认|执行)\s*)*(?:提交(?:并|和|后)?\s*)?(?:git\s+(?:-C\s+\S+\s+)?push\b|push\b|推送|推到远端)(?!\s*(?:策略|规则|规范|检查|权限|功能|提示|失败|报错|问题|日志|脚本|命令|配置|结果|状态|记录|成功|完成|被|测试|的|的时候|时|过|了))/i, no: new RegExp(NO_BEFORE + '(推送|push|推到远端)|(推送|push)(之前|前|以后再说|稍后|晚点|等等|先等)|(推送|push)[^。！!\n]{0,40}([吗么？?]|怎么|怎样|如何|什么|为什么|是否|会不会)|(能不能|可不可以|要不要|是否)(推送|push)|推不推|(?:push|推送)[^。！!\n]{0,8}(我自己|我来|留给我)|(?:解释|讲解|示例|举例)[^。！!\n]{0,16}(push|推送)', 'i'), command: /^$/ },
  archive: { yes: /归档|archive|验收(通过|过了|没问题|ok)/i, no: new RegExp(NO_BEFORE + '(归档|archive)|(归档|archive)(之前|前|以后再说|稍后|晚点|等等|先等)|(归档|archive)[^。！!\n]{0,12}[吗么？?]|(能不能|可不可以|要不要|是否)归档', 'i'), command: /^(opsx:|openspec[-:])(archive|bulk-archive)$/i },
  commit: { yes: /提交|commit/i, no: new RegExp(NO_BEFORE + '(提交|commit)|(提交|commit)(之前|前|以后再说|稍后|晚点|等等|先等)|(提交|commit)[^。！!\n]{0,12}[吗么？?]|(能不能|可不可以|要不要|是否)提交|提不提交', 'i'), command: /^$/ },
};
/** 用户最后一句是不是让它做这件事（topic：archive 归档 / commit 提交 / push 推送）。返回 { ok, voice, text } */
function userSaid(entries, topic) {
  const g = SAID[topic];
  const v = lastUserVoice(entries);
  if (!g || !v) return { ok: false, voice: v, text: '' };
  if (v.kind === 'answer') {
    const hit = v.answers.some((x) => (g.yes.test(x.a) && !g.no.test(x.a)) || (g.yes.test(x.q) && !g.no.test(x.a) && YES_SHORT.test(x.a.trim())));
    return { ok: hit, voice: v, text: v.answers.map((x) => x.a).join('；') };
  }
  if (v.kind === 'command') return { ok: g.command.test(v.command.replace(/^\//, '')) || (g.yes.test(v.text) && !g.no.test(v.text)), voice: v, text: v.text };
  const text = topic === 'push' ? v.text.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => !/^\s*>/.test(l)).join('\n') : v.text;
  return { ok: g.yes.test(text) && !g.no.test(text), voice: v, text: v.text };
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
  try { if (j && j.session_id && j.session_id !== 'unknown' && j.cwd) writeState(String(j.session_id) + '-home', { dir: homeByTranscript(j) || path.resolve(j.cwd), at: Date.now() }); } catch (e) { /* 记不了就靠会话记录的目录名认 */ }
}
/** 同一份输入，cwd 换成会话的启动目录（原来的留在 realCwd） */
function atHome(j) {
  const home = sessionHome(j);
  const cur = path.resolve((j && j.cwd) || process.cwd());
  return normKey(home) === normKey(cur) ? j : Object.assign({}, j, { cwd: home, realCwd: cur });
}
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
  if (on) { next.was = next.at; next.stage = 'apply'; }
  writeState(k, next);
  if (on) hookLog('全自动模式 这个会话装这一版之前就在做变更，算在 OpenSpec 流程里：' + dirs.map((d) => path.basename(d)).join('、'));
  return next;
}
/** 给钩子用的开关：全自动模式开着、这个会话又不在 OpenSpec 流程里（或者还在写提案那一段），autoMode 按关着算 */
function readConfigFor(j) {
  const c = readConfig();
  c.autoSwitch = c.autoMode === true;
  if (!c.autoSwitch) return c;
  let st = flowState(j);
  if (st.at === undefined) st = flowAdopt(j);
  if (!st.on || st.stage === 'plan') c.autoMode = false;
  return c;
}

/**
 * 套件自己的代码的指纹：安装器装完记下 hooks、lib、tools、page 下的 .js 和 statusline.js 每个文件的 sha1（state/kit-hash.json，
 * install.js 里有一份同样算法的）；会话开始时再算一遍比。禁改拦的是写入的那一下，路径藏在变量里的拦不住——改了能发现才是兜底
 */
const KIT_CODE_DIRS = ['hooks', 'lib', 'tools', 'page'];
function kitCodeHashes(kitDir) {
  const base = kitDir || KIT;
  const files = {};
  const add = (rel) => { try { files[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(base, rel))).digest('hex'); } catch (e) { /* 读不了 */ } };
  for (const d of KIT_CODE_DIRS) { let es = []; try { es = fs.readdirSync(path.join(base, d), { withFileTypes: true }); } catch (e) { continue; } for (const e of es) if (e.isFile() && /\.js$/i.test(e.name)) add(d + '/' + e.name); }
  if (fs.existsSync(path.join(base, 'statusline.js'))) add('statusline.js');
  return files;
}
/** 和安装时记下的比：返回 [{ rel, how: 改过 / 没了 / 多出来的 }]；安装时没记过（老版本装的）返回 null */
function kitCodeDrift() {
  const rec = readState('kit-hash');
  if (!rec.files) return null;
  const now = kitCodeHashes();
  const out = [];
  for (const [rel, h] of Object.entries(rec.files)) { if (!(rel in now)) out.push({ rel, how: '没了' }); else if (now[rel] !== h) out.push({ rel, how: '改过' }); }
  for (const rel of Object.keys(now)) if (!(rel in rec.files)) out.push({ rel, how: '多出来的' });
  return out;
}
/** 同步地等一小会儿（重试写文件用）；主线程和工作线程里都能用 */
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 等不了就不等 */ } }

// ===================== 钩子的输出 =====================
// 每个钩子文件都导出 handle(输入) → 返回对象（打印成 JSON）、字符串（原样打印）或 null（什么都不说，放行）。
// 同一个 handle 既能作为命令跑（cli：读标准输入、打印、退出码 0），也能在路由进程的工作线程里跑（HTTP 钩子，不用每次起进程）。
// 拦截一律用 JSON（decision: block），不用退出码 2：Windows 上经 PowerShell 执行钩子时退出码 2 会变成 1，拦不住。
function blockOut(event, reason) {
  const out = { decision: 'block', reason };
  if (event === 'PreToolUse') out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
  return out;
}
/** PreToolUse：不拦，但要用户点头（权限规则里放行了也照样问） */
function askOut(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
}
/** 作为命令运行：读标准输入 → handle → 打印结果 → 退出码 0。任何异常都放行，但记进问题反馈（放行了用户看不到，只有那里有） */
function cli(handle) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch (e) { process.exit(0); }
    Promise.resolve().then(() => handle(j)).then((out) => {
      if (out == null || out === '') return;
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      try { fs.writeSync(1, text); } catch (e) { process.stdout.write(text); }
    }).catch((e) => {
      // 判断不了就放行
      try { require('./feedback').recordHookError(path.basename(process.argv[1] || 'hook', '.js'), j, e); } catch (err) { /* 记不了就算了 */ }
    }).then(() => process.exit(0));
  });
}

// 找子目录时跳过的：构建产物、依赖。docs、templates 这类名字不跳过：子项目恰好叫这个名字时也要认得出来
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', 'logs']);
/** 不以点开头、也不是构建产物的子目录 */
function subdirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name[0] !== '.' && !SKIP_DIRS.has(e.name)).map((e) => path.join(d, e.name)); } catch (e) { return []; }
}
/** 这个目录自己就是一个装代码的项目：有构建文件、源码目录或 IDE 工程文件 */
const PROJECT_MARKS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'composer.json', 'Gemfile', 'CMakeLists.txt', '.classpath', '.project', 'src', 'web/WEB-INF', 'WebRoot/WEB-INF', 'WebContent/WEB-INF'];
function looksLikeProject(dir) {
  try {
    if (PROJECT_MARKS.some((m) => fs.existsSync(path.join(dir, m)))) return true;
    return fs.readdirSync(dir).some((n) => /\.(iml|sln|csproj)$/i.test(n));
  } catch (e) { return false; }
}
/** .gitmodules 里登记的子模块：那是 git 自己管的嵌套，git add -A 处理得了，不算"套着的子项目" */
function submodulePaths(root) {
  try { return (fs.readFileSync(path.join(root, '.gitmodules'), 'utf8').match(/^\s*path\s*=\s*(.+)$/gm) || []).map((l) => path.resolve(root, l.replace(/^\s*path\s*=\s*/, '').trim()).toLowerCase()); } catch (e) { return []; }
}
/**
 * 公司的项目结构：外面一层给 AI 用的壳子（放 openspec、文档、.claude），里面是项目的各个子项目，子项目各是独立的 git 仓库、装代码。
 * 返回 dir 下面套着的子项目目录（直接子目录里带 .git 的，登记为子模块的不算）。壳子外面还可以再套一层（有 workspace.yaml 的），那种情况多看一层。
 * 判断看的是实际结构，不依赖某个标志文件：没有 workspace.yaml 的壳子一样认得出来。
 */
function nestedRepos(dir) {
  const out = [];
  try {
    const start = path.resolve(dir || process.cwd());
    const deep = fs.existsSync(path.join(start, 'workspace.yaml'));
    const subs = submodulePaths(start);
    let budget = 200;
    for (const a of subdirs(start)) {
      if (--budget < 0) break;
      if (fs.existsSync(path.join(a, '.git')) && !subs.includes(a.toLowerCase())) out.push(a);
      if (deep) for (const b of subdirs(a)) { if (--budget < 0) break; if (fs.existsSync(path.join(b, '.git')) && !subs.includes(b.toLowerCase())) out.push(b); }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}
/**
 * 是不是壳子：外面再套了一层（有 workspace.yaml）；或者下面套着子项目、自己不是装代码的项目、而且自己有点东西（是 git 仓库，或放着 openspec / .claude / CLAUDE.md）。
 * 普通的单个项目（有 pom.xml、package.json、src 这些）就算下面有别的 git 仓库也不是壳子。
 */
function isShell(dir) {
  try {
    const d = path.resolve(dir || process.cwd());
    if (fs.existsSync(path.join(d, 'workspace.yaml'))) return true;
    if (looksLikeProject(d)) return false;
    const hasOwn = ['.git', 'openspec', '.claude', 'CLAUDE.md'].some((n) => fs.existsSync(path.join(d, n)));
    return hasOwn && nestedRepos(d).length > 0;
  } catch (e) { return false; }
}

/**
 * 找 openspec/changes 目录。
 *   当前目录自己有 openspec：就用它，不往上找（普通的单个项目 openspec 就在自己目录里，上级目录里的不是它的）；
 *     它要是壳子，再看直接子目录（外面再套了一层的多看一层），子项目自己有 openspec 的也算上
 *   当前目录没有 openspec：往上找，但只认两种上级——套着自己的壳子，或者自己所在仓库的根（openspec 一般放在仓库根）；
 *     碰到别的目录就停，不把上级目录里不相干的 openspec 算进来
 */
function changeRoots(dir) {
  const out = [];
  const add = (d) => { const c = path.join(d, 'openspec', 'changes'); if (!out.includes(c) && fs.existsSync(c)) out.push(c); };
  try {
    const start = path.resolve(dir || process.cwd());
    const deep = fs.existsSync(path.join(start, 'workspace.yaml'));
    const own = fs.existsSync(path.join(start, 'openspec'));
    if (own) add(start);
    if (own || isShell(start)) {
      let budget = 300;
      for (const a of subdirs(start)) { if (--budget < 0) break; add(a); if (deep) for (const b of subdirs(a)) { if (--budget < 0) break; add(b); } }
    }
    if (!own) {
      let d = start;
      let leftRepo = fs.existsSync(path.join(start, '.git'));
      for (let i = 0; i < 4 && !out.length; i++) {
        const up = path.dirname(d);
        if (up === d) break;
        const shellOfMine = fs.existsSync(path.join(up, 'workspace.yaml')) || nestedRepos(up).some((r) => r.toLowerCase() === d.toLowerCase());
        if (!shellOfMine && leftRepo) break;
        add(up);
        if (fs.existsSync(path.join(up, '.git'))) leftRepo = true;
        d = up;
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/**
 * 这项任务留给用户做（要改库、要账号密码、要 push）：任务行里写了"（留给用户：原因）"。全自动模式下它不做也不等，
 * 接着做别的；剩下的全是这种，就算能做的都做完了
 */
const TASK_DEFER = /[（(]\s*(?:留给用户|等用户|待用户|需用户|要用户)[^（）()]*[）)]/;
const isDeferredTask = (line) => TASK_DEFER.test(String(line || ''));
/** 所有没归档的变更（含任务已全部打勾的），最近动过的排前面。waiting 是没打勾的里面留给用户的那几项，next 是下一项能做的 */
function listChanges(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) {
    try {
      for (const name of fs.readdirSync(changes)) {
        if (name === 'archive') continue;
        const tasks = path.join(changes, name, 'tasks.md');
        if (!fs.existsSync(tasks)) continue;
        const text = fs.readFileSync(tasks, 'utf8');
        const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
        const open = (text.match(/^\s*[-*]\s*\[ \]\s*.*$/gm) || []).map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, '').trim());
        const waiting = open.filter(isDeferredTask);
        const next = open.find((l) => !isDeferredTask(l)) || '';
        out.push({ name, dir: path.join(changes, name), done, todo: open.length, waiting: waiting.length, waitingList: waiting.map((l) => l.slice(0, 80)), total: done + open.length, next: next.slice(0, 60), mtime: fs.statSync(tasks).mtimeMs });
      }
    } catch (e) { /* 这个目录读不了就跳过 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
/** 还有没打勾任务的变更 */
const activeChanges = (dir) => listChanges(dir).filter((c) => c.todo > 0);

/**
 * 工具调用的 id 会重复：内网的模型网关给的 id（chatcmpl-tool-xxxx）在同一个会话里能出现好几次（问题反馈 F20260929-006：
 * 两次审查用了同一个 id，后一次的结论记到了前一次的变更头上）。按 id 配对调用和结果就会串，所以读进来的时候按出现的先后配好对，
 * 重复的 id 改成唯一的（第 2 次出现的加 ~2），结果跟着它配上的那次调用改。原来的 id 留在 _raw 里。
 * 配不上调用的结果（调用在会话记录更前面、没读进来）改成 ~orphan，免得被后面同 id 的调用认走。主会话和子代理各配各的
 */
function uniquifyToolIds(entries) {
  const count = new Map();
  const open = new Map();
  for (const e of entries) {
    const c = e && e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    const chain = e.isSidechain ? 'side:' + String(e.agentId || '') : 'main';
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (e.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && b.id) {
        const k = chain + '|' + b.id;
        const n = (count.get(k) || 0) + 1;
        count.set(k, n);
        if (n > 1) { b._raw = b.id; b.id = b._raw + '~' + n; }
        if (!open.has(k)) open.set(k, []);
        open.get(k).push(b.id);
      } else if (e.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id) {
        const raw = b.tool_use_id;
        const list = open.get(chain + '|' + raw);
        // 配给最近一次还没等到结果的调用；更早的没等到结果的（被打断了）不会再有结果了
        const uid = list && list.length ? list.pop() : raw + '~orphan';
        if (list) list.length = 0;
        if (uid !== raw) { b._raw = raw; b.tool_use_id = uid; }
      }
    }
  }
  return entries;
}
/** 读会话记录最后 maxBytes 字节，解析成条目数组（第一行可能是半截，丢掉）。工具调用的 id 已经改成唯一的（uniquifyToolIds） */
function tailEntries(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, maxBytes || 400000);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (st.size > size) lines.shift();
    const out = [];
    for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (e) { /* 半截行 */ } }
    return uniquifyToolIds(out);
  } catch (e) { return []; }
}

function textOf(entry) {
  const c = entry && entry.message && entry.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n');
  return '';
}

/** 最后一次助手回复里的用量：输入 + 缓存读 + 缓存写，就是当前上下文大小 */
function lastUsageTokens(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const u = e && e.type === 'assistant' && !e.isSidechain && e.message && e.message.usage;
    if (u) {
      const n = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (n > 0) return n;
    }
  }
  return 0;
}

/**
 * 上下文用了百分之几。分母是配置里的"上下文上限"（contextLimitTokens，默认 100 万，在路由配置页里改）和 Claude Code 自己报的窗口里较小的那个：
 * Claude Code 对不认识的模型名按 20 万算，到 19 万它自己就报 Prompt is too long，这时按 100 万显示 19% 会让会话直接撞墙。
 * 上限填 0 表示只跟着 Claude Code 报的窗口走。交接线（handoverPercent）就是按这个分母算的。
 * 每次都现读配置，所以在配置页里改了之后，下一次状态栏刷新、下一条消息就按新值算，不用重开会话。
 */
function contextPercent(used, windowSize, cfg) {
  const limit = Number(cfg && cfg.contextLimitTokens);
  const win = Number(windowSize) || 0;
  let size = limit > 0 ? limit : (win || 200000);
  if (limit > 0 && win > 0 && win < limit) size = win;
  return { size, pct: size ? used * 100 / size : 0 };
}

/**
 * 自动压缩的窗口（写进 settings.json 的 autoCompactWindow，Claude Code 自己的设置，2.1.120、2.1.259 都认）。0 = 不设，照 Claude Code 自己的。
 * 为什么要设：2.1.259 这类新版本，没设这个窗口时不按用量自己压缩，要等接口报"请求太长"才补救；内网网关、内网模型的报错它认不出，
 * 上下文就一直涨，过了 100% 也不压缩（2026-10-01 用户遇到的，真的 Claude Code 加假模型实测过）。设了之后它在"窗口 − 2 万（留给输出）− 1.3 万"处压缩。
 * 所以窗口 = 上下文上限 × 自动压缩线（autoCompactPercent，默认 90%）+ 3.3 万：用到上限的 90% 左右压缩。
 * 上限填 0（跟着 Claude Code 报的窗口走）的按 100 万算：Claude Code 取它和模型窗口里小的那个。Claude Code 只认 10 万到 100 万。
 * 窗口最大只写到 96 万（用到 92.7 万压缩）：2.1.259 上实测窗口设到 97.7 万以上，还没压缩就先报 Prompt is too long 了，
 * 正是这个功能要防的事；压缩线和那条线之间还要留出一轮对话涨的量。压缩线填 95%、上限填得比 100 万大的，都落在这个数上
 */
const COMPACT_RESERVE = 33000;
const COMPACT_WINDOW_MAX = 960000;
function autoCompactWindowOf(cfg) {
  const p = Number(cfg && cfg.autoCompactPercent);
  if (!(p > 0)) return 0;
  const limit = Number(cfg && cfg.contextLimitTokens) > 0 ? Number(cfg.contextLimitTokens) : 1000000;
  return Math.max(100000, Math.min(COMPACT_WINDOW_MAX, Math.round(limit * Math.min(p, 95) / 100) + COMPACT_RESERVE));
}
/** 这个会话用到多少 token 时 Claude Code 会自己压缩：自动压缩窗口和 Claude Code 报的窗口里小的那个，减去它留的余量。没设窗口返回 0 */
function autoCompactAt(cfg, windowSize) {
  const w = autoCompactWindowOf(cfg);
  if (!w) return 0;
  const win = Number(windowSize) > 0 ? Math.min(w, Number(windowSize)) : w;
  return Math.max(0, win - COMPACT_RESERVE);
}

/**
 * 路由实测到的网关限制（state/gateway.json，由路由写）。
 * 内网网关对单次请求的大小有上限，超了直接拒绝（413），和模型的上下文长度无关。这个上限不写死、不猜：
 * 路由真的被拒过一次，才记下当时的请求大小；平时顺手统计"每个 token 大约多少字节"，两者一除就是上限大约合多少 token。
 * 没被拒过就返回 null，什么都不提。
 */
function gatewayLimit() {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(KIT, 'state', 'gateway.json'), 'utf8'));
    if (!(g.limitBytes > 0) || !(g.bytesPerToken > 0)) return null;
    return { limitBytes: g.limitBytes, bytesPerToken: g.bytesPerToken, limitTokens: Math.round(g.limitBytes / g.bytesPerToken), at: g.limitAt || '' };
  } catch (e) { return null; }
}
/** 离网关实测上限还有多远：到 85% 就该走了（被拒是硬墙，撞上了这个会话就发不出去了） */
function nearGatewayLimit(used) {
  const g = gatewayLimit();
  return g && used >= g.limitTokens * 0.85 ? g : null;
}

// 小状态：~/.claude/vibe-kit/state/<名字>.json。按会话的（<会话>.json、<会话>-xxx.json）过几天就清；全局的（审查记录、网关实测这些）不按时间清。
// 写一律先写临时文件再改名（原子写）：好几个钩子进程、路由的工作线程会同时读写同一个文件，直接覆盖写会让别人读到半截、再把空对象写回去冲掉记录。
const safeId = (id) => String(id || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 80);
const stateFile = (name) => path.join(KIT, 'state', safeId(name) + '.json');
/** 读状态。文件不存在返回 {}；存在但读不懂（别人正在写）重试几次，还不行也返回 {}（只读的地方够用；要写回的用 updateState） */
function readState(name) {
  const f = stateFile(name);
  for (let i = 0; i < 3; i++) {
    let t;
    try { t = fs.readFileSync(f, 'utf8'); } catch (e) { return {}; }
    try { return JSON.parse(t); } catch (e) { sleepMs(15); }
  }
  return {};
}
function writeState(name, obj) {
  try {
    const d = path.join(KIT, 'state');
    fs.mkdirSync(d, { recursive: true });
    const f = stateFile(name);
    const tmp = f + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    for (let i = 0; i < 6; i++) { try { fs.renameSync(tmp, f); return true; } catch (e) { sleepMs(20); } }
    try { fs.unlinkSync(tmp); } catch (e) { /* 已经没了 */ }
  } catch (e) { /* 写不了不影响使用 */ }
  return false;
}
/**
 * 读-改-写：fn 收到当前内容（对象），改完返回（或者直接改传进去的对象）。
 * 文件存在但读不懂：刚写完不久（别人可能正在写）就放弃这次写，免得把别人的记录冲掉；
 * 已经好一会儿没人动过、还是读不懂的，是坏掉了（杀毒软件、磁盘满、手改）：改名留一份（<名字>.bad），从空的重新记。
 * 不然全局的记录（审查过没有）一坏就再也写不进去，归档、打勾一直被拦成"还没审过"。
 * 返回写进去的对象；放弃了、写不进去（杀毒软件占着文件）时返回 null
 */
function updateState(name, fn) {
  const f = stateFile(name);
  let obj = {};
  if (fs.existsSync(f)) {
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) { try { const t = fs.readFileSync(f, 'utf8'); obj = t.trim() ? JSON.parse(t) : {}; ok = true; } catch (e) { sleepMs(20); } }
    if (!ok) {
      let age = 0;
      try { age = Date.now() - fs.statSync(f).mtimeMs; } catch (e) { age = 0; }
      if (age < 5000) return null;
      try { fs.renameSync(f, f + '.bad'); } catch (e) { return null; }
      hookLog('状态文件 ' + path.basename(f) + ' 坏了（读不懂），改名留成 .bad，从空的重新记');
      obj = {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const r = fn(obj);
  const next = r === undefined ? obj : r;
  return writeState(name, next) ? next : null;
}
/** 钩子的流水账（state/hooks.log）：什么时候跑的、看到了什么、做了什么。出问题时看这个，不用猜 */
function hookLog(line) {
  try {
    const d = path.join(KIT, 'state'); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'hooks.log');
    try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.1'); } catch (e) { /* 还没有 */ }
    fs.appendFileSync(f, new Date().toLocaleString('zh-CN', { hour12: false }) + ' ' + line + '\n');
  } catch (e) { /* 记不了就算了 */ }
}
/** 全局记录：跨会话要用的，不按文件时间删（条目自己 60 天后清） */
const GLOBAL_STATE = /^(reviewed|reviewed-proposal|review-rounds|review-nudged|task-ticks|block-stats|config-audit|tool-stats|tool-usage-pos|old-skills|onboard-fail|plan-hint|plan-unlisted|gateway|handover-consumed|artifact-cache|hook-stats|changes-cache|anchor-scan|tidy-hint|config-seal|kit-hash|kit-drift|lesson-commit|update|issues|issues-dirty|issues-exported|archived-seen|usage|usage-sync|pull)\.json$|^hooks\.log/;
/** 全局记录里的一条是什么时候记的：数字就是时间，对象看 at */
const entryAt = (v) => (typeof v === 'number' ? v : (v && typeof v === 'object' && Number(v.at)) || 0);
function cleanState(days) {
  try {
    const d = path.join(KIT, 'state');
    const dead = Date.now() - days * 86400000;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (/\.tmp$/.test(f)) { if (st.mtimeMs < Date.now() - 3600000) try { fs.unlinkSync(p); } catch (e) { /* 别人在用 */ } continue; }
      if (GLOBAL_STATE.test(f)) continue;
      if (st.mtimeMs < dead) try { fs.unlinkSync(p); } catch (e) { /* 别人在用 */ }
    }
    // 全局记录里 60 天前的条目清掉（审查记录、催过、计划提醒）
    const old = Date.now() - 60 * 86400000;
    for (const name of ['reviewed', 'reviewed-proposal', 'review-rounds', 'review-nudged', 'task-ticks', 'plan-hint', 'plan-unlisted']) {
      if (!fs.existsSync(stateFile(name))) continue;
      updateState(name, (o) => { for (const k of Object.keys(o)) { const t = entryAt(o[k]); if (t && t < old) delete o[k]; } });
    }
  } catch (e) { /* 忽略 */ }
}

/**
 * .vibe 一出现就进 .gitignore：找到它所在的 git 仓库的根，.gitignore 里没有就追加。不是 git 仓库就不管。
 * 追加的内容只用英文：.gitignore 可能是 GBK 的，掺进 UTF-8 的中文会把它弄成两种编码混着。换行符跟着原文件走。
 * 传进来的是 .vibe 里面（或者就是 .vibe）的任意一个路径。
 */
function ensureVibeIgnored(p) {
  try {
    const parts = path.resolve(p).split(path.sep);
    const i = parts.lastIndexOf('.vibe');
    if (i < 1) return false;
    let d = parts.slice(0, i).join(path.sep) || path.sep;
    let root = '';
    for (let n = 0; n < 12; n++) { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } const up = path.dirname(d); if (up === d) break; d = up; }
    if (!root) return false;
    const file = path.join(root, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(file, 'latin1'); } catch (e) { /* 还没有这个文件 */ }
    // 已经有了就不再加：.vibe、.vibe/、/.vibe/、.vibe/*、.vibe/**、**/.vibe/ 都算；文件开头可能带 BOM（按 latin1 读是 ï»¿）
    if (/^[ \t]*\/?(?:\*\*\/)?\.vibe(?:\/(?:\*\*?)?)?[ \t]*\r?$/m.test(text.replace(/^\xEF\xBB\xBF/, ''))) return false;
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    fs.appendFileSync(file, (text && !/\n$/.test(text) ? eol : '') + '# vibe-kit local files (project notes, page scenarios, handover notes) - do not commit' + eol + '.vibe/' + eol, 'latin1');
    return true;
  } catch (e) { return false; }
}

// ===================== OpenSpec 提案的门槛 =====================
// 提案、规格、设计、任务写得含糊，模型到了写代码的时候就只能猜，猜出来的东西藏在代码里比写在文档里更难发现。
// 这里是确定性的检查（脚本做，不花 token），供 guard-spec（写产物时）和 verify-gate（收工时）用。
// 原则：只判这次新加、改过的行，老变更里以前写的不追究，打勾（[ ] → [x]）不算改。

/**
 * 含糊词：出现在产物里就是"留到以后再说"。按整句短语认，不按单字（"之后再次打开"不算）。
 * 同一行里已经写了默认怎么做的（决策项）不算；引号里的不算（那是在引用这个词，或者是业务上的状态名）。
 * "待确认""待确定""待补充"常常是业务状态名：前面是"变为 / 改为 / 状态为"、后面跟"状态 / 的客户"这类的，也不算。
 */
const HEDGE_WORDS = ['待定', '待商榷', '待讨论', '待完善', '后续完善', '后续补充', '后续再说', '后续再定', '后续再议', '后续再补', '后续再看', '后面再说', '后面再定', '后面再补', '后面再看', '以后再说', '以后再定', '以后再补', '以后再做', '以后再看', '之后再说', '之后再定', '之后再补', '之后再做', '之后再看', '开发阶段再', '开发阶段确定', '开发阶段补充', '开发阶段完善', '开发时再', '实现时再', '编码时再', '视情况', '看情况', '暂不考虑', '暂不确定', '暂不处理', '另行讨论', '另行确定', '另行处理', '细节略', 'tbd', 'tbc', 'to be determined', 'to be decided', 'to be defined', 'decide later', 'figure out later'];
const HEDGE_SOFT = ['待确定', '待确认', '待补充'];
const DECIDED = /默认(按|用|取|为|走|是|值|[:：])|先按|暂按|按(?![钮键])[^，。；]{1,24}(做|处理|实现|来)/;
/** 第 i 个字符在不在引号里："" '' `` “” ‘’ 「」 『』 */
function quotedAt(line, i) {
  const pairs = { '“': '”', '‘': '’', '「': '」', '『': '』' };
  const stack = [];
  for (let k = 0; k < i; k++) {
    const ch = line[k];
    if (stack.length && ch === stack[stack.length - 1]) { stack.pop(); continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === '"' || ch === '`' || (ch === "'" && !/\w/.test(line[k - 1] || ''))) stack.push(ch);
  }
  return stack.length > 0;
}
const SOFT_BEFORE = /(变为|改为|置为|设为|变成|改成|转为|状态为|状态是|状态：|状态:)\s*$/;
const SOFT_AFTER = /^\s*(状态|态|的(客户|订单|数据|记录|单据|申请|用户|资料|列表))/;
function hedgeHit(line) {
  const low = line.toLowerCase();
  for (const w of HEDGE_WORDS) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) if (!quotedAt(line, i)) return w;
  }
  for (const w of HEDGE_SOFT) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
      if (quotedAt(line, i) || SOFT_BEFORE.test(line.slice(Math.max(0, i - 6), i)) || SOFT_AFTER.test(line.slice(i + w.length))) continue;
      return w;
    }
  }
  return '';
}
function findHedges(text, isAdded) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    const hit = hedgeHit(l);
    if (hit && !DECIDED.test(l)) out.push({ line: i + 1, word: hit, text: l.trim().slice(0, 70) });
  });
  return out;
}

/** openspec/changes/<名字>/ 下的产物：proposal / design / tasks / spec（specs/**.md）/ revisions；archive 里的不算 */
function artifactOf(file) {
  try {
    if (!file) return null;
    const abs = path.resolve(String(file)).split(path.sep).join('/');
    const m = abs.match(/^(.*)\/openspec\/changes\/([^/]+)\/(.+)$/i);
    if (!m || m[2].toLowerCase() === 'archive') return null;
    const rel = m[3];
    const kind = /^proposal\.md$/i.test(rel) ? 'proposal' : /^design\.md$/i.test(rel) ? 'design' : /^tasks\.md$/i.test(rel) ? 'tasks' : /^revisions\.md$/i.test(rel) ? 'revisions' : /^specs\/.+\.md$/i.test(rel) ? 'spec' : '';
    if (!kind) return null;
    return { kind, name: m[2], root: m[1], dir: m[1] + '/openspec/changes/' + m[2], rel };
  } catch (e) { return null; }
}
/** 产物在链路上的位置：需求 → 规格 → 设计 → 任务。改了前面的，后面的要跟着看 */
const STAGE = { proposal: 1, spec: 2, design: 3, tasks: 4 };

const CODE_EXT = /\.(?:java|kt|groovy|scala|xml|vue|jsx?|tsx?|mjs|cjs|sql|ya?ml|json|properties|html?|css|scss|less|py|go|cs|rs|php|rb|md|sh|bat|ps1|cmd|gradle|txt|csv|ftl|jsp|xlsx?)$/i;
const SRC_ROOTS = /^(?:\.{1,2}[\\/])?(?:src|web|app|apps|lib|libs|config|conf|resources|static|public|pages|views|components|api|server|client|frontend|backend|db|sql|scripts?|tests?|docs?|WebRoot|WebContent|main|java|mapper|service|controller|dao|entity|model|utils?)\b/i;
// 路径里允许中文（sql/v2_订单.sql、docs/说明.md）
const PC = String.raw`[\w.\-一-龥]`;
const PATH_LIKE = new RegExp(String.raw`(?:[A-Za-z]:)?(?:\.{1,2}[\\/])?(?:${PC}+[\\/])+${PC}+[\\/]?|[\w\-一-龥]+\.(?:java|kt|vue|jsx?|tsx?|sql|xml|ya?ml|json|properties|py|go|cs|html?|css|scss|less|md|sh|bat|ps1|ftl|jsp)(?![\w])`, 'g');
/**
 * 一行里像文件路径的词：带扩展名的文件名，或者 src/… 这类源码路径。URL、纯数字（3/7）、WHEN/THEN 这类不算。
 * 前端的 @/views/x.vue 按 src/views/x.vue 算；以 / 开头的源码路径（/src/views/x.vue）也认，/api/v2/orders 这种接口地址不算
 */
function pathTokens(line) {
  const s = String(line || '').replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/(^|[\s(（'"“:：])@\//g, '$1src/').replace(/[<>{}$*`]/g, ' ');
  const out = [];
  const re = new RegExp(PATH_LIKE.source, 'g');
  let m;
  while ((m = re.exec(s))) {
    const t = m[0].replace(/[.,;:，。；：)]+$/, '');
    if (!/[A-Za-z一-龥]/.test(t)) continue;
    const slash = /[\\/]/.test(t);
    if (s[m.index - 1] === '/' && !(slash && CODE_EXT.test(t) && SRC_ROOTS.test(t))) continue;
    if (slash ? (CODE_EXT.test(t.replace(/[\\/]+$/, '')) || SRC_ROOTS.test(t) || /^[A-Za-z]:/.test(t)) : CODE_EXT.test(t)) out.push(t);
  }
  return out;
}
const WALK_SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'out', 'logs', '.vibe', '.idea']);
/** 在 root 下找叫 name 的文件：不限深度（最多 30 层），每个根目录单独一份预算。返回 'found' | 'none' | 'unknown'（预算用完了还没找到） */
function findFile(root, name, depth, budget) {
  let es = [];
  try { es = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return 'none'; }
  const want = name.toLowerCase();
  for (const e of es) {
    if (budget.n-- <= 0) return 'unknown';
    if (e.isFile() && e.name.toLowerCase() === want) return 'found';
  }
  if (depth <= 0) return 'none';
  let res = 'none';
  for (const e of es) {
    if (!e.isDirectory() || WALK_SKIP.has(e.name) || e.name[0] === '.') continue;
    const r = findFile(path.join(root, e.name), name, depth - 1, budget);
    if (r === 'found') return 'found';
    if (r === 'unknown') res = 'unknown';
    if (budget.n <= 0) return 'unknown';
  }
  return res;
}
/**
 * 这几个根目录（壳子根、各子项目、当前目录）底下所有文件的文件名（小写）：同一次检查只建一次（按传进来的 roots 数组记，
 * 每次调用的数组是新的，HTTP 方式下不会拿到上一次的）。git 仓库用 git ls-files（已跟踪 + 没忽略的新文件），很快；
 * 不是仓库的目录才走一遍（有预算和 3 秒时限），走到里面的子仓库也改用 ls-files，不重复走。建不全的 complete = false
 */
const INDEX_CACHE = new WeakMap();
function nameIndex(roots) {
  if (INDEX_CACHE.has(roots)) return INDEX_CACHE.get(roots);
  const names = new Set();
  let complete = true;
  const deadline = Date.now() + 3000;
  const done = new Set();
  const lsFiles = (r) => {
    try {
      for (const args of [['ls-files', '-z'], ['ls-files', '-o', '--exclude-standard', '-z']]) {
        const out = execFileSync('git', ['--no-optional-locks', '-C', r].concat(args), { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const f of out.split('\0')) if (f) names.add(f.split('/').pop().toLowerCase());
      }
      return true;
    } catch (e) { return false; }
  };
  let budget = 20000;
  const walk = (d, depth) => {
    if (budget <= 0 || Date.now() > deadline) { complete = false; return; }
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (--budget <= 0) { complete = false; return; }
      if (e.isFile()) { names.add(e.name.toLowerCase()); continue; }
      if (!e.isDirectory() || WALK_SKIP.has(e.name) || e.name[0] === '.' || depth <= 0) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, '.git'))) { const k = normKey(sub); if (!done.has(k)) { done.add(k); if (!lsFiles(sub)) walk(sub, depth - 1); } continue; }
      walk(sub, depth - 1);
    }
  };
  for (const r0 of roots) {
    const r = path.resolve(r0);
    const k = normKey(r);
    if (done.has(k)) continue;
    done.add(k);
    if (fs.existsSync(path.join(r, '.git')) && lsFiles(r)) {
      // 仓库里套着的子仓库（壳子），ls-files 看不到：一层层找出来单独 ls-files
      for (const sub of nestedRepos(r)) { const ks = normKey(sub); if (!done.has(ks)) { done.add(ks); if (!lsFiles(sub)) walk(sub, 30); } }
      continue;
    }
    walk(r, 30);
  }
  // .vibe 里的文件（场景、放哪还没定的产出 pending、临时脚本）不进 git，上面都看不到：每个根目录的 .vibe 单独走一遍（小预算）
  let vibeBudget = 3000;
  const walkVibe = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (--vibeBudget <= 0) return;
      if (e.isFile()) names.add(e.name.toLowerCase());
      else if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') walkVibe(path.join(d, e.name), depth - 1);
    }
  };
  const vibeDirs = new Map();
  for (const r0 of roots) {
    const r = path.resolve(r0);
    vibeDirs.set(normKey(r), path.join(r, '.vibe'));
    try { if (fs.existsSync(path.join(r, '.git'))) for (const sub of nestedRepos(r)) vibeDirs.set(normKey(sub), path.join(sub, '.vibe')); } catch (e) { /* 找不了子项目就只看根目录的 */ }
  }
  for (const d of vibeDirs.values()) walkVibe(d, 5);
  const idx = { names, complete };
  INDEX_CACHE.set(roots, idx);
  return idx;
}
/**
 * 路径在这几个根目录（壳子根、各子项目、当前目录）之下存在吗；只有文件名的就查文件名索引。
 * 找不全（项目太大、超时）的当成存在：宁可漏拦也不误拦
 */
function pathExists(token, roots) {
  const t = String(token).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:/.test(t)) return fs.existsSync(t);
  if (/[\\/]/.test(t)) return roots.some((r) => fs.existsSync(path.join(r, t)));
  const idx = nameIndex(roots);
  return idx.names.has(t.toLowerCase()) || !idx.complete;
}
/** 一节的内容行（从标题到下一个同级或更高级标题） */
function sectionOf(text, headingRe) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const l of lines) {
    if (/^#{1,3}\s/.test(l)) { if (inside) break; inside = headingRe.test(l); continue; }
    if (inside) out.push(l);
  }
  return out;
}
/** 只看这次新加、改过的行：老内容不追究；打勾不算改。返回 isAdded(行号从 0) */
const normTicks = (t) => String(t || '').replace(/^(\s*[-*]\s*)\[[xX]\]/gm, '$1[ ]');
function addedLines(oldText, newText) {
  const pool = new Map();
  for (const l of normTicks(oldText).split(/\r?\n/)) pool.set(l, (pool.get(l) || 0) + 1);
  const added = new Set();
  normTicks(newText).split(/\r?\n/).forEach((l, i) => { const n = pool.get(l) || 0; if (n > 0) pool.set(l, n - 1); else added.add(i); });
  return (i) => added.has(i);
}

const VAGUE_TASK = /^(联调|完善|优化|收尾|善后|补充|调整|其他|其它|测试|自测|验证|检查|确认|沟通|对接|处理|整理|清理|重构|修改|更新|实现|开发|编码|写代码|完成|部署|上线)(相关)?(细节|逻辑|功能|代码|问题|一下|工作|页面|接口)?$/;
/** tasks.md：每项任务要写清改哪个文件、怎么验；不许"联调、完善"这种 */
function checkTasks(text, isAdded) {
  const issues = [];
  // 验法的写法跟着"看页面"开关走：关着时页面上的结果不自己起服务看，验法写"人工看页面"
  const verifyHint = readConfig().autoSeePage === false ? '加"验：<命令>"，页面上的写"验：人工看页面"' : '加"验：<命令或 /ttls-see-page 场景>"';
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    const m = l.match(/^\s*[-*]\s*\[[ xX]\]\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(.+)$/);
    if (!m) return;
    const body = m[1].trim();
    const n = i + 1;
    if (VAGUE_TASK.test(body.replace(/[\s，,。.：:；;、]/g, ''))) issues.push('第 ' + n + ' 行"' + body.slice(0, 40) + '"太笼统：写清楚改哪个文件、做什么');
    if (!pathTokens(body).length) issues.push('第 ' + n + ' 行没写改哪个文件（路径或文件名）："' + body.slice(0, 50) + '"');
    if (!/(验|验证|验收|检验|核对)\s*[:：]/.test(body)) issues.push('第 ' + n + ' 行没写怎么验（' + verifyHint + '）："' + body.slice(0, 50) + '"');
  });
  return issues;
}
/**
 * 规格：每条 Requirement 至少一个四井号的 Scenario，场景里要有 WHEN 和 THEN；需求要放在 OpenSpec 认得的增量标题下面
 * （## ADDED / MODIFIED / REMOVED / RENAMED Requirements），不然归档时它认不出来，报 no deltas found（问题反馈 F20260929-014）
 */
const DELTA_HEAD = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;
function checkSpec(text, isAdded) {
  const issues = [];
  const lines = String(text || '').split(/\r?\n/);
  let req = null;
  let section = '';
  let loose = 0;
  lines.forEach((l, i) => {
    if (/^##\s/.test(l)) { section = DELTA_HEAD.test(l.trim()) ? 'delta' : 'other'; return; }
    if (/^###\s+Requirement:/i.test(l) && section !== 'delta' && (!isAdded || isAdded(i)) && !loose) loose = i + 1;
  });
  if (loose) issues.push('第 ' + loose + ' 行的需求没放在增量标题下面：变更里的规格是增量，需求要写在 "## ADDED Requirements"（新加的）、"## MODIFIED Requirements"（改现有的，整条需求连场景重写一遍）、"## REMOVED Requirements"（删掉的）下面，标题照这个英文写。不然归档时 OpenSpec 认不出来（no deltas found），主规格不会更新');
  const flush = () => { if (req && req.added && req.scenarios === 0) issues.push('第 ' + req.line + ' 行的需求"' + req.name + '"没有场景：下面至少要有一个 #### Scenario:，带 WHEN / THEN'); req = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mine = !isAdded || isAdded(i);
    const r = l.match(/^###\s+Requirement:\s*(.+)$/i);
    if (r) { flush(); req = { name: r[1].trim(), line: i + 1, scenarios: 0, added: mine }; continue; }
    if (/^##\s/.test(l)) { flush(); continue; }
    if (/^###\s+Scenario:/i.test(l) && mine) issues.push('第 ' + (i + 1) + ' 行：Scenario 要用四个井号（####），三个井号 openspec 不认');
    const sc = l.match(/^####\s+Scenario:\s*(.*)$/i);
    if (!sc) continue;
    if (req) req.scenarios++;
    if (!mine) continue;
    let hasWhen = false, hasThen = false;
    for (let k = i + 1; k < lines.length && !/^#{2,4}\s/.test(lines[k]); k++) { if (/\bWHEN\b/i.test(lines[k])) hasWhen = true; if (/\bTHEN\b/i.test(lines[k])) hasThen = true; }
    if (!hasWhen || !hasThen) issues.push('第 ' + (i + 1) + ' 行的场景"' + sc[1].trim() + '"缺 ' + [!hasWhen ? 'WHEN' : '', !hasThen ? 'THEN' : ''].filter(Boolean).join(' 和 '));
  }
  flush();
  return issues;
}
// 这一行是在说"要新建文件"。"编写、产出"这类说法也算：弱一些的模型被拦下之后常常换个词重写，却不写"新建"两个字
const NEW_FILE = /(新建|新增|新写|新加|创建|生成|编写|撰写|起草|产出|落盘|建立|新文件|待建|new\s+file|create)/i;
const tokenKey = (t) => String(t || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
/**
 * 这个变更里声明过要新建的路径：同一个变更的产物（proposal、design、tasks、specs）里说过一次"新建 x"就够了，
 * 别处再提到 x（写全路径或者只写文件名）不用每一行都写"新建"。extraText 是这次正要写进去的内容。返回判断函数
 */
function declaredNew(changeDir, extraText) {
  const set = new Set();
  const add = (text) => {
    for (const l of String(text || '').split(/\r?\n/)) {
      if (!NEW_FILE.test(l)) continue;
      for (const t of pathTokens(l)) { const k = tokenKey(t); if (k) { set.add(k); set.add(k.split('/').pop()); } }
    }
  };
  add(extraText);
  if (changeDir) for (const f of artifactFiles(changeDir)) { if (/(^|[\\/])revisions\.md$/i.test(f)) continue; try { add(fs.readFileSync(f, 'utf8')); } catch (e) { /* 读不了就不算 */ } }
  return (token) => { const k = tokenKey(token); return set.has(k) || set.has(k.split('/').pop()); };
}
/** 一行里提到、又找不到的路径合成一句话（同一行好几个文件不再各说一遍） */
function missingPathIssue(lineNo, tokens) {
  return '第 ' + lineNo + ' 行提到的 ' + tokens.join('、') + ' 在项目里找不到。是这次要新建的：在这一行里写上"新建"两个字（例：新建 ' + tokens[0] + '）；是项目里已有的：写全相对路径（从项目根目录算），读过的才能写';
}
/** 设计：提到的路径要真实存在（新建的写明"新建"，或者这个变更里别处声明过新建）；新写的设计 Context（现状）一节不能空 */
function checkDesign(text, isAdded, roots, isNew, isDeclared) {
  const issues = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    if (NEW_FILE.test(l)) return;
    const missing = [...new Set(pathTokens(l).filter((t) => !(isDeclared && isDeclared(t)) && !pathExists(t, roots)))];
    if (missing.length) issues.push(missingPathIssue(i + 1, missing));
  });
  if (isNew) {
    const ctx = sectionOf(text, /^##\s*(Context|背景|现状)/i).filter((l) => l.trim() && !/^\s*<!--/.test(l));
    if (ctx.length < 2) issues.push('Context（现状）一节太空：列出探索时读过的文件、表、接口和发现，这是设计的依据');
  }
  return issues;
}
/** 模板里的占位注释还留着 */
function leftoverPlaceholders(text, isAdded) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => { if ((!isAdded || isAdded(i)) && /<!--/.test(l)) out.push(i + 1); });
  return out;
}
/** 提案里列的能力（New / Modified Capabilities 下的 `名字`） */
function proposalCapabilities(text) {
  const out = [];
  let inside = false;
  for (const l of String(text || '').split(/\r?\n/)) {
    if (/^##\s/.test(l)) { inside = /^##\s*Capabilities/i.test(l); continue; }
    if (!inside) continue;
    const m = l.match(/^\s*[-*]\s*`([^`<>]+)`/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
/** 一个变更目录下的所有产物文件 */
function artifactFiles(changeDir) {
  const out = [];
  for (const n of ['proposal.md', 'design.md', 'tasks.md', 'revisions.md']) { const f = path.join(changeDir, n); if (fs.existsSync(f)) out.push(f); }
  const walk = (d, depth) => { if (depth > 3) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (/\.md$/i.test(e.name)) out.push(p); } };
  walk(path.join(changeDir, 'specs'), 0);
  return out;
}
/**
 * 像验证的命令：构建、编译、测试、脚本这些工具出现在"命令的位置"上，或者跑了 .vibe/ 里的脚本。
 * 只看命令位置，是为了不把 git diff src/main/java/… 里的 java 当成跑过 java。
 * 命令前面可以有：临时环境变量（JAVA_HOME="…" mvn，选 JDK 的惯用写法）、PowerShell 的调用符 &、cmd /c、timeout N、env、call 这类包装，以及带引号的路径。
 */
const VERIFY_TOOLS = 'mvn|mvnw|gradle|gradlew|javac|java|npm|pnpm|yarn|npx|node|vue-tsc|tsc|eslint|pytest|python3?|py|go|dotnet|curl|make|ant|openspec';
const VERIFY_ASSIGN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+`;
const VERIFY_WRAP = String.raw`(?:cmd(?:\.exe)?\s+\/c\s+"?|timeout\s+\S+\s+|time\s+|env\s+|call\s+|winpty\s+|&\s*)`;
const VERIFY_RE = new RegExp(
  String.raw`(?:^|&&|\|\||[;|(\n])\s*(?:(?:${VERIFY_ASSIGN}|${VERIFY_WRAP})\s*)*(?:"[^"\n]*[\\/]|[^\s"]*[\\/])?(?:${VERIFY_TOOLS})(?:\.cmd|\.bat|\.exe|\.sh)?"?(?:\s|$)`
  + '|' + String.raw`\.vibe[\\/]\S*\.(?:bat|cmd|sh|ps1|js)`, 'i');
// 不算验证的：openspec 自己的命令（status、list、show…）、套件自己的工具（devserver、feedback…）。看页面的 scenario-run 算
const NOT_VERIFY_SEG = /^\s*(?:openspec(?:\.cmd)?\s|openspec$|node(?:\.exe)?\s+["']?[^"'\s]*vibe-kit[\\/]+(?:tools|lib|hooks)[\\/])/i;
/** 这条命令算不算跑过验证：去掉 openspec、套件自己的工具那几段，剩下的里有构建、编译、测试、脚本 */
const VERIFY_CMD = {
  test(cmd) {
    const rest = String(cmd || '').split(/&&|\|\||[;\n]/).filter((s) => !NOT_VERIFY_SEG.test(s)).join('\n');
    return VERIFY_RE.test(rest);
  },
};

/** 这条是不是用户真说的话：不是自动附带的（isMeta，Stop 钩子的反馈也是这种）、不是压缩摘要、不是工具结果 */
function isUserTurn(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  return true;
}
/** 会话记录里"这一轮"从哪条开始：最后一条用户发来的、不是工具结果的条目之后。返回 { start, turnId, prompt } */
function turnStart(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!isUserTurn(e)) continue;
    return { start: i + 1, turnId: String(e.uuid || e.timestamp || ''), prompt: textOf(e) };
  }
  return { start: 0, turnId: '', prompt: '' };
}
/** 工具调用 id → { error: 是否报错, text: 结果文本, at: 结果送到的时间, pos: 在会话记录里的位置 } */
function toolResults(entries) {
  const out = new Map();
  entries.forEach((e, pos) => {
    const c = e && e.type === 'user' && e.message && e.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || '').join('\n') : JSON.stringify(b.content || ''));
      out.set(b.tool_use_id, { error: !!b.is_error, text, at: Date.parse(e.timestamp || '') || 0, pos });
    }
  });
  return out;
}
/**
 * 后台任务做完的通知（<task-notification>）。2.1.259 起 Agent 默认在后台跑：当场的 tool_result 只是"Async agent launched…"，
 * 子代理最后说的话（审查结论在里面）后来才作为通知送回来。会话记录里先有一条 queue-operation（enqueue，content 是通知原文），
 * 轮到它时再有一条 user（origin.kind = task-notification，内容是通知原文），两处都认。
 * 返回 工具调用 id → { status, text（<result> 里的原文）, at, pos }；同一个调用通知了几次（子代理被续上又停下）的，以最后一次为准
 */
const unXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function taskNotes(entries) {
  const out = new Map();
  // 通知里写的是原来的 id；id 重复过的（uniquifyToolIds 改过名），认通知之前最近的那次调用
  const renamed = [];
  entries.forEach((e, pos) => {
    const c = e && e.type === 'assistant' && !e.isSidechain && e.message && e.message.content;
    if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_use' && b._raw) renamed.push({ pos, raw: b._raw, id: b.id, name: String(b.name || '') });
  });
  // 只在能在后台跑的调用（Agent、Task）里认：别的调用（Bash）碰巧用了同一个 id 的，通知不是它的
  const idAt = (raw, pos) => { let id = raw; for (const r of renamed) if (r.raw === raw && r.pos < pos && /^(Agent|Task)$/.test(r.name)) id = r.id; return id; };
  entries.forEach((e, pos) => {
    if (!e) return;
    let text = '';
    if (e.type === 'queue-operation' && typeof e.content === 'string') text = e.content;
    else if (e.type === 'user') { const c = e.message && e.message.content; text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' && b.text) || '').join('\n') : ''; }
    if (!text.includes('<task-notification>')) return;
    for (const block of text.split('<task-notification>').slice(1)) {
      const body = block.split('</task-notification>')[0];
      const rawId = (body.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/) || [])[1];
      if (!rawId) continue;
      const id = renamed.length ? idAt(rawId, pos) : rawId;
      const s = body.indexOf('<result>');
      const t = body.lastIndexOf('</result>');
      out.set(id, { status: ((body.match(/<status>\s*([^<]+?)\s*<\/status>/) || [])[1] || '').toLowerCase(), text: s >= 0 && t > s ? unXml(body.slice(s + 8, t)) : '', at: Date.parse(e.timestamp || '') || 0, pos });
    }
  });
  return out;
}
/** 这条"用户消息"其实是后台任务做完的通知（不是用户说的话） */
const isTaskNote = (e) => !!(e && e.type === 'user' && ((e.origin && e.origin.kind === 'task-notification') || /^\s*<task-notification>/.test(textOf(e))));
const isTaskNotePrompt = (prompt) => /^\s*<task-notification>/.test(String(prompt || ''));
/**
 * 会话记录里的工具调用（不含子代理的），按顺序：{ i, name, input, id, raw, key, at }。
 * id 在这份会话记录里是唯一的（配对结果用）；key 是要记进状态文件的（"这次审查计过了"）：用条目的 uuid，
 * 读多读少、换个时候再读都不变——id 会重复，不能拿来记
 */
function toolCalls(entries, from, to) {
  const out = [];
  const end = to == null ? entries.length : to;
  for (let i = from || 0; i < end; i++) {
    const e = entries[i];
    if (!e || e.isSidechain || e.type !== 'assistant') continue;
    const c = e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      const raw = b._raw || b.id;
      out.push({ i, name: b.name, input: b.input || {}, id: b.id, raw, key: String(e.uuid || e.timestamp || '') + ':' + raw, at: Date.parse(e.timestamp || '') || 0 });
    }
  }
  return out;
}
const NOT_PROJECT_READ = /(^|[\\/])(openspec|\.vibe|\.claude|node_modules)([\\/]|$)|handover\.md$|CLAUDE\.md$/i;
const READ_CMD = /(?:^|[;&|(\n]\s*|\bcd\s+\S+\s*[;&]+\s*)(cat|type|head|tail|less|more|Get-Content|gc|grep|rg|findstr|Select-String|sls|sed\s+-n)\b/im;
/**
 * 探索过项目吗：读过项目里的文件（Read）、搜过（Grep / Glob）、或者用命令看过文件内容。
 * 返回读过的东西：Read 记路径；Grep/Glob 记 "grep:模式@路径"；命令记 "cmd:命令"（cd 之后再 Get-Content 也算）
 */
function projectReads(calls) {
  const out = [];
  for (const c of calls) {
    if (c.name === 'Read' && c.input.file_path && !NOT_PROJECT_READ.test(String(c.input.file_path))) out.push(String(c.input.file_path));
    else if ((c.name === 'Grep' || c.name === 'Glob') && !NOT_PROJECT_READ.test(String(c.input.path || ''))) out.push(c.name.toLowerCase() + ':' + String(c.input.pattern || '') + '@' + String(c.input.path || ''));
    else if (/^(Bash|PowerShell)$/.test(c.name) && READ_CMD.test(String(c.input.command || ''))) out.push('cmd:' + String(c.input.command || '').slice(0, 200));
  }
  return out;
}
/** 任务行：- [ ] 1.2 做什么；按任务编号认（行尾加了"（已完成）"也认得），没有编号的按去掉行尾括号后的文字认 */
const TASK_LINE = /^(\s*[-*]\s*)\[([ xX])\]\s*(.*)$/;
function taskKey(body) {
  const m = String(body).match(/^(\d+(?:\.\d+)*)[.)、]?(?=\s|$)/);
  if (m) return 'id:' + m[1];
  return 'tx:' + String(body).replace(/\s*[（(][^（）()]*[）)]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
/** 这次编辑把哪些任务从 [ ] 打成了 [x]：返回打勾后的那些行 */
function tickedLines(oldText, newText) {
  const wasOpen = new Set();
  for (const l of String(oldText || '').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] === ' ') wasOpen.add(taskKey(m[3].trim())); }
  const out = [];
  for (const l of String(newText || '').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] !== ' ' && wasOpen.has(taskKey(m[3].trim()))) out.push(m[3].trim()); }
  return out;
}
/** 任务行里写的验法（"验：…"），没有返回 '' */
function verifyPartOf(taskLine) {
  const m = String(taskLine || '').match(/(?:验|验证|验收|检验|核对)\s*[:：]\s*(.+)$/);
  return m ? m[1].trim() : '';
}
/**
 * 验法写的是"同 3.1 命令 PASS""见 2.1""同上"：指的是另一项任务的验法，换成那一项写的（议题 #4：照字面查，
 * 只能认成"跑过任何一条验证命令"，模型不知道到底要它跑哪条）。tasksText 是 tasks.md 的全文。
 * 返回 { text: 要查的验法, ref: 指向的任务编号（没有指向别的任务就是 ''）}；指向的那一项找不到、没写验法的，照原样查。
 * 自己已经写明了命令的不换
 */
const VERIFY_REF = /(?:^|[\s，,；;（(])(?:同|见|参见|参照|沿用|复用|按|与|和)\s*(?:任务|第)?\s*(\d+(?:\.\d+)+)/;
const VERIFY_ABOVE = /^\s*(?:同上|同前|同上一项|同上一条|同上条)/;
function resolveVerify(taskLine, tasksText) {
  const own = verifyPartOf(taskLine);
  const lines = String(tasksText || '').split(/\r?\n/).map((l) => l.match(TASK_LINE)).filter(Boolean).map((m) => m[3].trim());
  let text = own;
  let ref = '';
  let cur = taskKey(String(taskLine || '').trim());
  for (let depth = 0; depth < 4; depth++) {
    // 自己写明了命令的（反引号里一条带空格的命令）照自己的查：后面顺带提一句"环境同 3.1"不算指向别的任务
    if (/`[^`\n]*\S\s+\S[^`\n]*`/.test(text)) break;
    const m = text.match(VERIFY_REF);
    const above = !m && VERIFY_ABOVE.test(text);
    if (!m && !above) break;
    const at = lines.findIndex((b) => taskKey(b) === cur);
    const hit = m ? lines.find((b) => taskKey(b) === 'id:' + m[1]) : (at > 0 ? lines[at - 1] : '');
    const v = hit ? verifyPartOf(hit) : '';
    if (!hit || !v || taskKey(hit) === cur) break;
    ref = (taskKey(hit).match(/^id:(.+)$/) || [])[1] || '上一项';
    text = v;
    cur = taskKey(hit);
  }
  return { text, ref };
}
/**
 * 这条验法跑过了吗：在这些命令里找。/ttls-see-page 的场景要跑过 scenario-run 且带场景名；其他的看验法里提到的工具（mvn、node、curl…）有没有出现在命令里。
 * 验法写成一句话（"按项目说明的快检"）、没提到任何工具的：跑过任何像验证的命令就算。写的是"人工…""用户…"的不查（那是要人看的），返回 true。
 */
// 验法里提到的工具：路径、文件名里的不算（src/main/java/…、OrderService.java 里的 java）
const TOOL_WORDS = /(?<![\\/.\w-])(mvn|mvnw|gradle|gradlew|javac|java|npm|pnpm|yarn|npx|node|vue-tsc|tsc|eslint|pytest|python3?|py|go|dotnet|curl|make|ant|openspec)(?![\\/.\w-])/ig;
/** 这些工具有没有出现在命令的位置上（不是出现在参数、文件名里：Copy-Item 里的 py、Constant.java 里的 ant 都不算） */
function toolAtCommandPos(cmd, tools) {
  const alt = tools.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
  const re = new RegExp(String.raw`(?:^|&&|\|\||[;|(\n])\s*(?:(?:${VERIFY_ASSIGN}|${VERIFY_WRAP})\s*)*(?:"[^"\n]*[\\/]|[^\s"]*[\\/])?(?:${alt})(?:\.cmd|\.bat|\.exe|\.sh)?"?(?:\s|$)`, 'i');
  return re.test(cmd);
}
// 验法里写明要跑的脚本、场景文件（带不带路径都算）
const FILE_IN_CMD = /[^\s"'`，。；、（）()=]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py|json)(?![\w.])/ig;
// 跑出来的结果文件（.vibe/out/…/result.json、out/report.json）：那是验证的产物，不是要跑的东西。验法里提到它是在说"结果看这里"，
// 不能要求命令里出现它——脚本自己往那里写，命令行上没有这个名字，跑了几十遍也打不上勾（议题 #3）
const OUTPUT_JSON = /(?:^|[\\/])(?:out|output|outputs|results?|reports?)[\\/][^\s]*\.json$|(?:^|[\\/])(?:result|results|report|output|summary)(?:[-_.][\w-]+)?\.json$/i;
const isOutputJson = (p) => OUTPUT_JSON.test(String(p || '').replace(/["'`]/g, ''));
// 没加反引号、但前面带着"用什么跑"的脚本：node x.js、bash x.sh、./x.sh
const RUN_SCRIPT = /(?:^|[\s"'(（])(?:(?:node|bash|sh|python3?|py|powershell|pwsh|call)\s+|\.[\\/])"?([^\s"'`，。；、（）()]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py))(?![\w.])/ig;
// .vibe 里的脚本（探针、自己包的验证脚本）。结尾要卡住：checklist.json 不能认成 checklist.js（问题反馈 F20260929-015）
const VIBE_SCRIPT = /\.vibe[\\/][^\s"'`，。；、（）()]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)(?![\w.])/ig;
const SCRIPT_NAME = /\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)$/i;
// 这一句说的是"不做"：这一句里写的东西不查，打勾时记下来（全自动模式写进报告）
const SKIP_CLAUSE = /(不做|不跑|不验|不测|不执行|不用跑|不用验|不用做|跳过|不适用|无需|不需要|不涉及|做不了|跑不了|验不了|没法验|无法验|留给用户|等用户|待用户|需用户|要用户)/;
const HUMAN_CLAUSE = /^\s*(人工|用户|你|我)/;
// 不带 ttls- 前缀的 see-page 也认：改名之前写的 tasks.md 里，验法写的是旧名字
const SCENE_WORD = /(?:ttls-)?see-page|scenario-run|场景/i;
// 只说了"场景"、没说哪一个：这些都算真去验了——场景执行器、.vibe 里的脚本、探针、直接调接口
const SCENE_LIKE = /scenario-run|\.vibe[\\/]\S*\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)\b|playwright|(?:^|[\s;&|(])curl(?:\.exe)?\s/i;
/**
 * 这条验法要看到什么才算跑过：返回 { need: 给模型看的一句（要看到什么）, skipped: 验法里明说不做的那几句, test(跑过的命令) }。
 * 验法按 ；。，和换行 分成几句，一句一句看（反引号里的命令、括号里的说明不拆）：
 *   写的是"人工…""用户…"的：要人看，不查。
 *   说了"不做、跳过、不适用、等用户"的（括号里说的也算）：这一句里写的东西不查，记在 skipped 里。
 *   写明了的（必须都跑过）：反引号里的命令（里面的脚本、场景文件都在跑过的命令里出现，或者里面的工具出现在命令的位置上）；
 *     反引号里单独一个脚本名；"node x.js"".vibe/x.bat"这种脚本；写了 xxx.json 的场景、或者叫得出名字而且真有这个场景文件的。
 *     反引号里单独一个 .json 只有是场景文件（路径里带 scenario、前面说了"场景"）才算；.vibe/login.json 这种数据文件、接口地址、类名不算。
 *   没写明的（没有写明的那种时，跑过其中一样就行）：只说了 /ttls-see-page、场景（场景执行器、.vibe 里的脚本、探针、curl 都算）；
 *     提到的工具（mvn、javac、node…）出现在命令的位置上。
 *   什么都认不出来（"按项目说明的快检"）：跑过任何像验证的命令就算。
 * opts.scenarioExists(名字)：项目里有没有叫这个名字的场景文件。"场景 admin 打开用户管理页"里的 admin 是账号不是场景名，
 * 以前拿"场景"后面那个词当场景名去对，跑过了也打不上勾（问题反馈 F20260928-010）
 */
function verifyPlan(verifyText, opts) {
  const v = String(verifyText || '').trim();
  const o = opts || {};
  if (HUMAN_CLAUSE.test(v)) return { need: '', skipped: [], test: () => true };
  const low = (x) => String(x).replace(/\\/g, '/').toLowerCase();
  const names = (x) => [...new Set((String(x).match(FILE_IN_CMD) || []).filter((t) => !isOutputJson(t)).map((t) => path.basename(low(t))))];
  const hasAll = (list) => (cs) => list.every((n) => cs.some((c) => low(c).includes(n)));
  // 反引号里的、括号里的先拿出来，换成记号，再分句
  const quoted = [];
  const notes = [];
  let masked = v.replace(/`([^`\n]+)`/g, (m, q) => { quoted.push(q.trim()); return '\u0001' + (quoted.length - 1) + '\u0002'; });
  masked = masked.replace(/（[^（）]*）|\([^()]*\)/g, (m) => { notes.push(m); return '\u0003' + (notes.length - 1) + '\u0004'; });
  const strong = [];
  const weak = [];
  const skipped = [];
  let human = 0;
  for (const part of masked.split(/[；;。，,\n]/)) {
    if (!part.trim()) continue;
    const own = part.replace(/\u0003\d+\u0004/g, ' ');
    const plain = own.replace(/\u0001\d+\u0002/g, ' ');
    const note = (part.match(/\u0003(\d+)\u0004/g) || []).map((x) => notes[Number(x.slice(1, -1))]).join(' ').replace(/\u0001(\d+)\u0002/g, (m, i) => quoted[Number(i)]);
    const mine = (own.match(/\u0001(\d+)\u0002/g) || []).map((x) => quoted[Number(x.slice(1, -1))]);
    const text = own.replace(/\u0001(\d+)\u0002/g, (m, i) => '`' + quoted[Number(i)] + '`').trim();
    if (HUMAN_CLAUSE.test(plain)) { human++; continue; }
    if (SKIP_CLAUSE.test(plain) || SKIP_CLAUSE.test(note)) { skipped.push((text + note).slice(0, 80)); continue; }
    const before = strong.length;
    for (const q of mine) {
      if (!/\s/.test(q)) {
        // 单独一个词：脚本名要跑过；.json 是场景文件才要跑过；别的（类名、接口地址、数据文件）不是命令
        const base = path.basename(low(q));
        if (SCRIPT_NAME.test(base)) { if (!/^scenario-run\./.test(base)) strong.push({ show: '`' + q + '`', test: hasAll([base]) }); continue; }
        if (/\.json$/i.test(base) && !isOutputJson(q) && (/scenario/i.test(low(q)) || SCENE_WORD.test(plain) || (o.scenarioExists && o.scenarioExists(base.replace(/\.json$/i, ''))))) strong.push({ show: '场景 ' + base, test: hasAll([base]) });
        continue;
      }
      const files = names(q);
      if (files.length) { strong.push({ show: '`' + q + '`', test: hasAll(files) }); continue; }
      const tools = [...new Set((q.match(TOOL_WORDS) || []).map((t) => t.toLowerCase()))].filter((t) => toolAtCommandPos(q, [t]));
      if (tools.length) strong.push({ show: '`' + q + '`', test: (cs) => cs.some((c) => toolAtCommandPos(c, tools)) });
    }
    const scripts = [];
    let m;
    const re = new RegExp(RUN_SCRIPT.source, 'ig');
    while ((m = re.exec(plain))) scripts.push(path.basename(low(m[1])));
    for (const x of plain.match(VIBE_SCRIPT) || []) scripts.push(path.basename(low(x)));
    const own2 = [...new Set(scripts)].filter((n) => !/^scenario-run\./.test(n));
    if (own2.length) strong.push({ show: '脚本 ' + own2.join('、'), test: hasAll(own2) });
    if (strong.length > before) continue;
    if (SCENE_WORD.test(plain)) {
      const byFile = ((plain.match(/[^\s"'`，。；、（）()=]*\.json(?![\w.])/g) || []).filter((t) => !isOutputJson(t)).map((t) => (t.match(/([\w.\-]+)\.json$/) || [])[1] || '').filter(Boolean))[0] || '';
      const byWord = (plain.match(/场景\s*[:：]?\s*([\w.\-]+)/) || [])[1] || '';
      const name = byFile || (byWord && o.scenarioExists && o.scenarioExists(byWord.replace(/\.json$/i, '')) ? byWord : '');
      if (name) strong.push({ show: '场景 ' + name, test: (cs) => cs.some((c) => low(c).includes(name.toLowerCase())) });
      else weak.push({ show: '/ttls-see-page 的场景（scenario-run.js），或者 .vibe 里你自己的验证脚本、探针', test: (cs) => cs.some((c) => SCENE_LIKE.test(c)), scene: true });
      continue;
    }
    // 技能工程的快检（tools/skills-check.js）
    if (/skills-check/i.test(plain)) { strong.push({ show: 'skills-check.js', test: (cs) => cs.some((c) => /skills-check/i.test(c)) }); continue; }
    const tools = [...new Set((plain.match(TOOL_WORDS) || []).map((t) => t.toLowerCase()))];
    if (tools.length) weak.push({ show: tools.join(' 或 ') + ' 的命令', test: (cs) => cs.some((c) => toolAtCommandPos(c, tools)) });
  }
  if (strong.length) return { need: '跑过 ' + strong.map((w) => w.show).join('、'), skipped, test: (cs) => strong.every((w) => w.test(cs)) };
  if (weak.length) {
    const hint = weak.some((w) => w.scene) ? '；验法其实是你自己包的脚本的，把那条命令用反引号写进验法里' : '';
    return { need: '跑过 ' + weak.map((w) => w.show).join('，或者 ') + hint, skipped, test: (cs) => weak.some((w) => w.test(cs)) };
  }
  // 整条验法都是"人工看""不做"：没有要查的
  if (human || skipped.length) return { need: '', skipped, test: () => true };
  return { need: '跑过任何一条验证命令（编译、测试、快检脚本、场景）', skipped, test: (cs) => cs.some((c) => VERIFY_CMD.test(c)) };
}
function verifyRan(verifyText, commands, opts) { return verifyPlan(verifyText, opts).test(commands || []); }

/**
 * 交接记录过期了：写完它之后，有变更归档了、或者有变更的任务全部打勾了——说明那件事后来做完了（比如全自动模式挂了一夜），
 * 第二天照它"下一步"接着做会重做。返回过期原因，没过期返回 null。
 */
/** 交接记录里提到了这个变更名吗（整词：add-order 不算提到了 add-order-v2） */
function mentionsChange(text, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w-])' + esc + '($|[^\\w-])').test(String(text || ''));
}
/**
 * 只看交接记录里提到的变更：别人的变更被 git pull 下来归档了，不算这份交接过期。交接记录里一个变更名都没提的，判断不了，当没过期。
 */
function handoverStale(file, dir) {
  try {
    const m = fs.statSync(file).mtimeMs;
    const text = readTextFileRaw(file);
    for (const changes of changeRoots(dir)) {
      const arch = path.join(changes, 'archive');
      let names = [];
      try { names = fs.readdirSync(arch); } catch (e) { continue; }
      for (const n of names.sort().reverse()) {
        let t = 0; try { t = fs.statSync(path.join(arch, n)).mtimeMs; } catch (e) { continue; }
        const name = n.replace(/^\d{4}-\d{2}-\d{2}-/, '');
        if (t > m && mentionsChange(text, name)) return '变更 ' + name + ' 已归档';
      }
    }
    for (const c of listChanges(dir)) if (c.todo === 0 && c.done > 0 && c.mtime > m && mentionsChange(text, c.name)) return '变更 ' + c.name + ' 的任务已全部完成';
  } catch (e) { /* 读不了就当没过期 */ }
  return null;
}
function readTextFileRaw(f) { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; } catch (e) { return ''; } }

// ===================== 大需求的计划：openspec/plan.md =====================
// 一个大需求拆成几个变更做，做完一个归档一个，模型下次怎么知道哪些做完了？靠 plan.md 这张表：模块 | 变更名 | 状态 | 说明。
// 状态列不靠人记，钩子按 changes/ 和 changes/archive/ 的实际情况刷新；会话开头带上。
function readPlan(openspecDir) {
  const file = path.join(openspecDir, 'plan.md');
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const rows = [];
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) { cols = null; continue; }
    const cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim());
    if (!cols) { const c = cells.findIndex((x) => /变更|change/i.test(x)); const s = cells.findIndex((x) => /状态|status/i.test(x)); if (c >= 0 && s >= 0) cols = { change: c, status: s }; continue; }
    if (cells.every((x) => /^:?-*:?$/.test(x))) continue;
    const name = (cells[cols.change] || '').replace(/`/g, '').trim();
    if (!name) continue;
    rows.push({ line: i, name, status: cells[cols.status] || '', cells, cols });
  }
  return { file, eol, lines, rows };
}
/** 一个变更现在的状态：未开始 / 提案中 / 已提案 0/n / 进行中 x/n / 已完成 n/n，待归档 / 已归档 日期 */
function planStatusOf(name, changesDir) {
  const dir = path.join(changesDir, name);
  try {
    const t = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
    const done = (t.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
    const todo = (t.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
    if (done + todo === 0) return '提案中';
    if (todo === 0) return '已完成 ' + done + '/' + done + '，待归档';
    return (done ? '进行中 ' : '已提案 ') + done + '/' + (done + todo);
  } catch (e) { /* 没有 tasks.md */ }
  if (fs.existsSync(dir)) return '提案中';
  try {
    const hit = fs.readdirSync(path.join(changesDir, 'archive')).filter((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name).sort().pop();
    if (hit) return '已归档 ' + ((hit.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0]);
  } catch (e) { /* 没有 archive */ }
  return '未开始';
}
/** 按实际情况刷新 plan.md 的状态列，变了就写回。返回汇总，没有 plan.md 返回 null */
function refreshPlan(openspecDir) {
  const p = readPlan(openspecDir);
  if (!p || !p.rows.length) return null;
  const changesDir = path.join(openspecDir, 'changes');
  let changed = false; let archived = 0; const active = []; let next = '';
  for (const r of p.rows) {
    const s = planStatusOf(r.name, changesDir);
    if (/^已归档/.test(s)) archived++;
    else if (/^(进行中|已完成|已提案|提案中)/.test(s)) active.push(r.name + '（' + s + '）');
    else if (!next) next = r.name;
    if (s !== r.status) { r.cells[r.cols.status] = s; p.lines[r.line] = '| ' + r.cells.join(' | ') + ' |'; changed = true; }
  }
  if (changed) { try { fs.writeFileSync(p.file, p.lines.join(p.eol)); } catch (e) { /* 写不了就只汇总 */ } }
  return { file: p.file, total: p.rows.length, archived, active, next, changed };
}
function planSummary(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) { const s = refreshPlan(path.dirname(changes)); if (s) out.push(s); }
  return out;
}
/** changes/ 下进行中的变更名（不含 archive） */
function changeNames(changesDir) {
  try { return fs.readdirSync(changesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && e.name[0] !== '.').map((e) => e.name); } catch (e) { return []; }
}
/** archive/ 下最近 days 天归档的变更（按日期从早到晚）；days 为 0 表示全部 */
function archivedChanges(changesDir, days) {
  const dead = days > 0 ? Date.now() - days * 86400000 : 0;
  const out = [];
  try { for (const n of fs.readdirSync(path.join(changesDir, 'archive'))) { const m = n.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/); if (m && Date.parse(m[1]) >= dead) out.push({ name: m[2], date: m[1] }); } } catch (e) { /* 没有 archive */ }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
/** 没有 plan.md，却有好几个变更（进行中的 + 最近归档的）：可能是一个大需求拆出来的，该建计划了 */
function planMissingInfo(openspecDir, days) {
  if (fs.existsSync(path.join(openspecDir, 'plan.md'))) return null;
  const changesDir = path.join(openspecDir, 'changes');
  const active = changeNames(changesDir);
  const archived = archivedChanges(changesDir, days).map((a) => a.name);
  if (!active.length || active.length + archived.length < 2) return null;
  return { active, archived };
}
/** 按现有的变更生成 plan.md 骨架：已归档的按日期排前面，进行中的在后面，状态填好；模块、说明留给模型补。已经有了就不动 */
function planInit(openspecDir, days) {
  const file = path.join(openspecDir, 'plan.md');
  if (fs.existsSync(file)) return { file, created: false, rows: [] };
  const changesDir = path.join(openspecDir, 'changes');
  const rows = archivedChanges(changesDir, days).map((a) => a.name);
  for (const n of changeNames(changesDir)) if (!rows.includes(n)) rows.push(n);
  const lines = ['# 计划：<大需求的名字>', '', '<一两句话：这个大需求要做什么，PRD 在哪。>', '', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(rows.map((n) => '| <模块> | ' + n + ' | | |'), ['']);
  fs.writeFileSync(file, lines.join('\n'));
  refreshPlan(openspecDir);
  return { file, created: true, rows };
}
/** 有 plan.md 时：进行中却不在表里的变更（中途加的新功能最容易漏记）。没有 plan.md 返回 null */
function planUnlisted(openspecDir) {
  const p = readPlan(openspecDir);
  if (!p) return null;
  const listed = new Set(p.rows.map((r) => r.name));
  return changeNames(path.join(openspecDir, 'changes')).filter((n) => !listed.has(n));
}

/** 产物内容的指纹：打勾不算改 */
function artifactHash(file) { try { return crypto.createHash('sha1').update(normTicks(fs.readFileSync(file, 'utf8'))).digest('hex'); } catch (e) { return ''; } }
const normKey = (f) => path.resolve(f).split(path.sep).join('/').toLowerCase();
/**
 * 当前目录能看到的所有变更的产物指纹（用户开口时记一份，收工时比对：改了产物没记录就拦）。
 * 按修改时间和大小缓存（state/artifact-cache.json）：没变的文件不重算哈希，壳子里几十个子项目时也不慢
 */
function snapshotArtifacts(dir) {
  const files = {};
  const cache = readState('artifact-cache');
  let dirty = false;
  try {
    for (const c of listChanges(dir)) for (const f of artifactFiles(c.dir)) {
      const k = normKey(f);
      let st; try { st = fs.statSync(f); } catch (e) { continue; }
      const sig = st.size + ':' + Math.round(st.mtimeMs);
      const hit = cache[k];
      if (hit && hit.sig === sig) { files[k] = hit.hash; continue; }
      const h = artifactHash(f);
      files[k] = h;
      cache[k] = { sig, hash: h, at: Date.now() };
      dirty = true;
    }
  } catch (e) { /* 忽略 */ }
  if (dirty) {
    const keys = Object.keys(cache);
    if (keys.length > 5000) keys.sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0)).slice(0, keys.length - 5000).forEach((k) => delete cache[k]);
    writeState('artifact-cache', cache);
  }
  return files;
}

// ===================== 审查记录 =====================
// 只记"真审了"：ttls-reviewer 的调用有结果、不是报错、结果里有"结论：问题 N 条"。
// 模式按审查提示的第一行"模式：提案 / 代码 / 复审提案 / 复审代码"认（老写法第一句"审提案"也认）；变更按提示里点名的认，没点名的不记到任何变更头上。
// 提案审过记在 reviewed-proposal，代码审过记在 reviewed。记录里带变更目录的创建时间：同名变更归档后重建，不继承以前的"审过"。
function changeBorn(dir) { try { const st = fs.statSync(dir); return Math.round(st.birthtimeMs || st.ctimeMs || 0); } catch (e) { return 0; } }
/**
 * 这次审查审的是提案还是代码：'proposal' / 'code' / ''（认不出，不记到任何一边）。
 * 先认约定的第一行"模式：…"；没照约定写的（"复审模式：你上一轮报的 5 条已经改过""独立审一遍 OpenSpec 提案（不是审代码）"），看前几行里的说法；
 * 还认不出就看事实：这个变更一项任务都没打勾，不可能做过代码审查；全打了勾，审的是代码。
 * 以前认不出的一律当成代码审查：提案审了六轮都记到了代码那边，打勾时说"提案没审过"，收工时又催"代码复审"，
 * 报的条数也是上一次认得出的那次的（议题 #1、#6）
 */
function reviewModeOf(prompt, change) {
  const lines = String(prompt || '').trim().split(/\r?\n/);
  const first = lines[0] || '';
  let m = first.match(/^\s*模式\s*[:：]\s*(复审提案|复审代码|提案|代码)/);
  if (m) return /提案/.test(m[1]) ? 'proposal' : 'code';
  if (/^\s*审提案/.test(first)) return 'proposal';
  const head = lines.slice(0, 6).join('\n').slice(0, 600);
  m = head.match(/模式\s*[:：]\s*(?:复审)?\s*(提案|代码)/);
  if (m) return m[1] === '提案' ? 'proposal' : 'code';
  const notCode = /不是审代码|不审代码/.test(head);
  const notProposal = /不是审提案|不审提案/.test(head);
  const saysProposal = notCode || (!notProposal && /(审|复审|审查|review)[^。\n]{0,14}(提案|proposal)|提案(模式|审查|复审)/i.test(head));
  const saysCode = notProposal || (!notCode && /(审|复审|审查|review)[^。\n]{0,14}(代码|改动|diff)|代码(模式|审查|复审)/i.test(head));
  if (saysProposal && !saysCode) return 'proposal';
  if (saysCode && !saysProposal) return 'code';
  if (change && change.dir) {
    let text = '';
    try { text = fs.readFileSync(path.join(change.dir, 'tasks.md'), 'utf8'); } catch (e) { text = ''; }
    const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
    const open = (text.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
    if (done === 0 && (open > 0 || !text)) return 'proposal';
    if (done > 0 && open === 0) return 'code';
  }
  return '';
}
/** 是不是复审：约定的第一行写"模式：复审…"；没照约定写的，前几行里说了复审、上一轮 */
const isRecheck = (prompt) => { const ls = String(prompt || '').trim().split(/\r?\n/); return /^\s*模式\s*[:：]\s*复审/.test(ls[0] || '') || /复审|上一轮|上轮/.test(ls.slice(0, 3).join('\n')); };
/** 当前目录能看到的所有变更（含还没有 tasks.md 的），给"提示里点名的是哪个变更"用 */
function allChanges(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) for (const name of changeNames(changes)) out.push({ name, dir: path.join(changes, name) });
  return out;
}
/**
 * 审查提示里点名的变更：先认约定的"变更：…"那一行（相对路径、绝对路径、名字都认；写"无"的不算任何变更），
 * 再认提示里出现的完整目录，最后认变更名（整词，只点了一个才算——材料里顺带提到别的变更名的，靠"变更："那一行认）
 */
const changeLineOf = (prompt) => { const m = String(prompt || '').split(/\r?\n/).slice(0, 5).map((l) => l.match(/^\s*变更\s*[:：]\s*(.+?)\s*$/)).find(Boolean); return m ? m[1] : ''; };
function reviewTargetOf(prompt, changes) {
  const p = String(prompt || '');
  const line = changeLineOf(p);
  if (line) {
    const v = line.replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '').replace(/\/+$/, '').toLowerCase();
    if (/^(无|没有|none)$/.test(v)) return null;
    const name = v.split('/').pop();
    for (const c of changes) { const d = normKey(c.dir); if (v === d || d.endsWith('/' + v) || c.name.toLowerCase() === name) return c; }
    // 那一行后面还带着别的话（"add-x（第二轮）"）：行里只点了一个变更的名字就认
    const named = changes.filter((c) => mentionsChange(line, c.name));
    // 写了"变更："、却对不上现有的变更（已经归档了、名字写错了）：不往下猜。
    // 往下猜的话，提示里顺带提到的另一个变更会被当成审过了
    return named.length === 1 ? named[0] : null;
  }
  const low = p.toLowerCase().replace(/\\/g, '/');
  for (const c of changes) if (low.includes(normKey(c.dir))) return c;
  const hits = changes.filter((c) => mentionsChange(p, c.name));
  return hits.length === 1 ? hits[0] : null;
}
/**
 * 这次审查报的问题记在谁头上（自动收经验用的出处）。和"算哪个变更审过了"分开认：
 *   认得出变更的就是那个变更；"变更："那一行写的变更已经归档了的（收工之前就归档了）照样认那个名字；
 *   写"变更：无"的小改动，用"日期 小改动"当出处（和 lesson.js 对小改动的写法一样）。都认不出返回 ''
 */
function lessonSourceOf(prompt, change, archived) {
  if (change) return change.name;
  const line = changeLineOf(prompt).replace(/\\/g, '/').replace(/^["'`]+|["'`]+$/g, '').replace(/\/+$/, '');
  if (!line) return '';
  if (/^(无|没有|none)$/i.test(line)) { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' 小改动'; }
  const name = line.split('/').pop().toLowerCase().replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const hit = (archived || []).find((a) => a.toLowerCase() === name) || (archived || []).filter((a) => mentionsChange(line, a));
  return typeof hit === 'string' ? hit : (hit.length === 1 ? hit[0] : '');
}
/** 当前目录能看到的、已经归档的变更的名字（不带日期） */
function archivedNames(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) for (const a of archivedChanges(changes, 0)) if (!out.includes(a.name)) out.push(a.name);
  return out;
}
/**
 * 已归档的变更各是什么时候归档的：{ 名字（小写）: 时间 }。OpenSpec 的归档目录名只带日期，目录自己的时间又是归档之前的（挪目录不改它的时间），
 * 所以由钩子记"第一次看到它归档了"的时间（state/archived-seen.json）。清过程文件时拿它比：归档之后又动过的目录是后来的事
 * （归档后修问题，事由还写这个变更名），不清。同名的归档过几次，取最近的一次
 */
function archivedSince(dir) {
  const out = {};
  try {
    const found = [];
    for (const changes of changeRoots(dir)) for (const a of archivedChanges(changes, 0)) found.push({ key: normKey(path.join(changes, 'archive', a.date + '-' + a.name)), name: a.name.toLowerCase() });
    if (!found.length) return out;
    const now = Date.now();
    let st = readState('archived-seen');
    if (found.some((f) => !st[f.key])) {
      st = updateState('archived-seen', (o) => {
        for (const f of found) if (!o[f.key]) o[f.key] = now;
        const keys = Object.keys(o);
        if (keys.length > 3000) for (const k of keys.sort((a, b) => o[a] - o[b]).slice(0, keys.length - 2000)) delete o[k];
      }) || st;
    }
    for (const f of found) { const t = Number(st[f.key]) || now; if (!out[f.name] || t > out[f.name]) out[f.name] = t; }
  } catch (e) { /* 记不了：当成刚归档的 */ }
  return out;
}
// 结论取最后一个：复审的时候审查者会引上一轮的结论（"上一轮结论：问题 3 条"），这一轮的在最后
const reviewIssues = (text) => { let n = null; for (const m of String(text || '').matchAll(/结论\s*[:：]\s*问题\s*(\d+)\s*条/g)) n = Number(m[1]); return n; };
// 审查代理改名之前叫 vibe-reviewer：会话记录里的旧调用照样算
const isReviewCall = (c) => /^(Agent|Task)$/.test(c.name) && /(ttls|vibe)-reviewer/.test(String(c.input.subagent_type || ''));
/**
 * 一段调用里真的做完了的审查：[{ id, key, raw, mode, recheck, change, issues, idx, at, pos }]。
 * 结论在哪：前台跑的在 tool_result 里；后台跑的（2.1.259 起默认）在后来的通知里（notes = taskNotes(entries)，通知状态要是 completed）。
 * at / pos 是结论送到的时间和在会话记录里的位置。key 是记进状态文件用的（见 toolCalls）：调用的 id 会重复，拿它记"计过了"会把
 * 后一次审查当成前一次（问题反馈 F20260929-006、-016）
 */
function reviewsIn(calls, results, changes, notes, archived) {
  const out = [];
  calls.forEach((c, idx) => {
    if (!isReviewCall(c)) return;
    const r = results.get(c.id);
    if (r && r.error) return;
    let issues = r ? reviewIssues(r.text) : null;
    let at = r ? r.at : 0;
    let pos = r ? r.pos : -1;
    let text = r ? r.text : '';
    const n = notes && notes.get(c.id);
    if (issues === null && n && n.status === 'completed') { issues = reviewIssues(n.text); at = n.at; pos = n.pos; text = n.text; }
    if (issues === null) return;
    const prompt = String(c.input.prompt || '');
    // text 是审查者的原话、source 是出处：自动收审查报的问题时要用（lib/lessons.js 的 autoCollect）
    const change = reviewTargetOf(prompt, changes);
    let mode = reviewModeOf(prompt, change);
    const recheck = isRecheck(prompt);
    // 复审、又认不出审的是哪一样：跟这个变更上一次审查一样（这份会话记录里的；没有就看还没审完的那一边）
    if (!mode && change && recheck) {
      const prev = out.filter((r) => r.change && r.mode && normKey(r.change.dir) === normKey(change.dir)).pop();
      if (prev) mode = prev.mode;
      else { const st = readState('review-rounds'); const k = normKey(change.dir); const open = ['proposal', 'code'].filter((m) => st[m + '|' + k] && !st[m + '|' + k].done); if (open.length === 1) mode = open[0]; }
    }
    out.push({ id: c.id, key: c.key || c.id, raw: c.raw || c.id, i: c.i, mode, recheck, change, source: lessonSourceOf(prompt, change, archived), issues, idx, at, pos, text: String(text || '') });
  });
  return out;
}
/**
 * 在后台跑着、还没送回结论的审查（刚发出去，通知还没到）：[{ id, mode, change }]。这时候不要再催它审一遍。
 * 发出去超过 30 分钟还没回来的不算（多半是 Claude Code 退出过，子代理跟着没了，通知永远不会来）
 */
function pendingReviewsIn(calls, results, changes, notes) {
  const out = [];
  for (const c of calls) {
    if (!isReviewCall(c)) continue;
    const r = results.get(c.id);
    if (!r || r.error || !/Async agent launched|working in the background/i.test(r.text)) continue;
    if (notes && notes.has(c.id)) continue;
    if (r.at && Date.now() - r.at > 30 * 60000) continue;
    const prompt = String(c.input.prompt || '');
    const change = reviewTargetOf(prompt, changes);
    out.push({ id: c.id, mode: reviewModeOf(prompt, change), change });
  }
  return out;
}
/** 读一条审查记录（键做了大小写归一化；兼容老版本直接用原样路径当键、值是时间数字的写法）；同名变更重建过的当没有 */
function reviewRecord(kind, dir) {
  const st = readState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed');
  const key = normKey(dir);
  let rec = st[key];
  if (rec === undefined) for (const k of Object.keys(st)) if (normKey(k) === key) { rec = st[k]; break; }
  if (rec === undefined || rec === null) return null;
  if (typeof rec === 'number') rec = { at: rec, done: true, legacy: true };
  if (rec.born && changeBorn(dir) && Math.abs(rec.born - changeBorn(dir)) > 2000) return null;
  return rec;
}
/**
 * 记一次审查。at 是结论送到的时间（不用记的这一刻：要拿它和任务打勾的时间比）。
 * 同一次审查（记账键一样）只记一次；比已经记着的那次更早的不覆盖（后台审查的结论可能晚到）
 */
function recordReview(kind, dir, issues, reviewKey, at) {
  const key = normKey(dir);
  const born = changeBorn(dir);
  const when = at || Date.now();
  let fresh = false;
  updateState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => {
    const prev = o[key] && typeof o[key] === 'object' ? o[key] : {};
    if (prev.done && prev.born === born && ((reviewKey && prev.key === reviewKey) || (prev.at && when < prev.at))) return o;
    o[key] = Object.assign({}, prev, { done: true, at: when, born, issues, key: reviewKey });
    delete o[key].id;
    fresh = true;
    return o;
  });
  // 使用情况：新记上的一次审查（提案、代码，报"问题 0 条"的另数）
  if (fresh) { try { const U = require('./usage.js'); U.bump('review.' + (kind === 'proposal' ? 'proposal' : 'code')); if (Number(issues) === 0) U.bump('review.clean'); } catch (e) { /* 数不了就算了 */ } }
  return fresh;
}
/**
 * 把会话记录里做完了的审查都记上（前台的看 tool_result，后台的看通知）。收工检查、打勾检查、用户开口时都先调一下，
 * 免得后台审查的结论已经送到了、记录还没跟上，打勾被拦。返回找到的审查（带 pos，给多轮审查用）
 */
function syncReviews(entries, cwd) {
  const found = reviewsIn(toolCalls(entries, 0), toolResults(entries), allChanges(cwd), taskNotes(entries), archivedNames(cwd));
  found.sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const r of found) {
    if (!r.change) continue;
    // 认不出审的是提案还是代码：不记到任何一边（记错了比不记更糟），流水账里留一句，每次审查只留一次
    if (!r.mode) { noteUnknownReview(r); continue; }
    const fresh = recordReview(r.mode, r.change.dir, r.issues, r.key, r.at);
    // 使用情况：这次审查从调用到结论花了多久（审查慢的时候看它；两小时以上的不算，多半是会话断过）
    if (fresh) { try { const t0 = Date.parse(((entries || [])[r.i] || {}).timestamp || '') || 0; const ms = t0 && r.at > t0 ? r.at - t0 : 0; if (ms > 0 && ms < 7200000) require('./usage.js').bump('review.ms', ms); } catch (e) { /* 数不了就算了 */ } }
  }
  return found;
}
function noteUnknownReview(r) {
  try {
    const st = readState('review-unknown');
    const seen = Array.isArray(st.keys) ? st.keys : [];
    if (seen.includes(r.key)) return;
    writeState('review-unknown', { keys: seen.concat(r.key).slice(-100), at: Date.now() });
    hookLog('审查记账 认不出审的是提案还是代码，没记：变更 ' + r.change.name + '，报了 ' + r.issues + ' 条（审查提示第一行要写"模式：提案 / 代码 / 复审提案 / 复审代码"）');
  } catch (e) { /* 记不了不影响 */ }
}
/** 提案审过了吗 */
function proposalReviewed(dir) { const r = reviewRecord('proposal', dir); return !!(r && r.done); }
/**
 * 每项任务是什么时候打的勾（state/task-ticks.json，按变更目录记）。"代码审过了吗"要用：审查之后才打勾的任务，它的代码审到了没有。
 * 每次调用拿 tasks.md 对一遍：打了勾、还没记时间的，记成现在——头一回见到这个变更的记成 0（不知道什么时候打的，当作早就打了）；
 * 勾去掉了的，记录删掉。justTicked 是这次编辑正要打勾的任务（编辑还没落盘，先记上）。返回 { 任务键: 时间 }
 */
function syncTicks(changeDir, justTicked) {
  const k = normKey(changeDir);
  const born = changeBorn(changeDir);
  const now = Date.now();
  const ticked = new Set();
  try { for (const l of fs.readFileSync(path.join(changeDir, 'tasks.md'), 'utf8').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] !== ' ') ticked.add(taskKey(m[3].trim())); } } catch (e) { /* 还没有 tasks.md */ }
  const fresh = new Set((justTicked || []).map((t) => taskKey(String(t).trim())));
  let out = {};
  const prev = readState('task-ticks')[k];
  const same = prev && (!prev.born || !born || Math.abs(prev.born - born) <= 2000);
  const known = same ? (prev.tasks || {}) : {};
  const next = {};
  for (const t of ticked) next[t] = known[t] !== undefined ? known[t] : (same ? now : 0);
  // 正要打勾的：编辑落盘之前先记上；一分钟内记的、盘上还没勾的先留着（编辑可能正在路上）
  for (const t of fresh) if (next[t] === undefined) next[t] = known[t] !== undefined ? known[t] : now;
  for (const t of Object.keys(known)) if (next[t] === undefined && now - known[t] < 60000) next[t] = known[t];
  out = next;
  const changed = !same || Object.keys(next).length !== Object.keys(known).length || Object.keys(next).some((t) => known[t] !== next[t]);
  if (changed) updateState('task-ticks', (st) => { st[k] = { born, tasks: next, at: now }; });
  return out;
}
/** 任务行里写的要改的文件（"验：…"之前的部分），在这几个根目录下找得到的：返回绝对路径。.vibe、openspec 里的不算代码 */
function taskCodeFiles(taskLine, roots) {
  const body = String(taskLine || '').split(/(?:验|验证|验收|检验|核对)\s*[:：]/)[0];
  const out = [];
  for (const t of pathTokens(body)) {
    const p = String(t).replace(/[\\/]+$/, '');
    if (!/[\\/]/.test(p) || /(^|[\\/])(\.vibe|\.claude|openspec)([\\/]|$)/i.test(p)) continue;
    const hits = /^[A-Za-z]:/.test(p) ? [p] : roots.map((r) => path.join(r, p));
    for (const f of hits) { try { if (fs.statSync(f).isFile()) { out.push(f); break; } } catch (e) { /* 不在这个根目录下 */ } }
  }
  return out;
}
/** 变更目录（…/openspec/changes/<名字>）所在的项目根，和它下面的各个子项目 */
function projectRootsOf(changeDir) {
  const root = path.resolve(changeDir, '..', '..', '..');
  let nested = [];
  try { nested = nestedRepos(root); } catch (e) { nested = []; }
  return [root].concat(nested);
}
/**
 * 这次审查没审到的任务：审查之后才打的勾，而且任务行里写的文件在审查之后改过。返回 [{ task, files }]。
 * 审查之后只是补打了勾（代码早就写好了、当时打勾被拦）、或者打勾的是不改代码的任务（执行脚本、改库），审查照样算数——
 * 以前拿 tasks.md 的修改时间比，打个勾、改一句验法，审过的就变成"没审过"（问题反馈 F20260928-014、F20260929-003）
 */
function unreviewedAfter(dir, rec) {
  const at = (rec && rec.at) || 0;
  const ticks = syncTicks(dir);
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  let roots = null;
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(TASK_LINE);
    if (!m || m[2] === ' ') continue;
    const body = m[3].trim();
    if (!((ticks[taskKey(body)] || 0) > at + 1000)) continue;
    roots = roots || projectRootsOf(dir);
    const late = taskCodeFiles(body, roots).filter((f) => { try { return fs.statSync(f).mtimeMs > at + 1000; } catch (e) { return false; } });
    if (late.length) out.push({ task: body.slice(0, 60), files: late });
  }
  return out;
}
/**
 * 代码审过了吗：要有一次真的代码审查，而且审查之后没有再做新的代码任务（见 unreviewedAfter）。老版本留下的记录（只有时间）照认。
 */
function codeReviewed(dir) {
  const r = reviewRecord('code', dir);
  if (!r) return false;
  if (r.legacy) return true;
  return unreviewedAfter(dir, r).length === 0;
}
/** 归档、催审查时说的话：没审过，还是审过之后又做了任务。审过了返回空串 */
function codeReviewIssue(dir) {
  const r = reviewRecord('code', dir);
  if (!r) return '还没做过代码审查（/ttls-cross-review 的代码模式，前端后端都在内；审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
  if (r.legacy) return '';
  const late = unreviewedAfter(dir, r);
  if (!late.length) return '';
  const rel = (f) => path.basename(f);
  return '代码审查之后又做了 ' + late.length + ' 项任务，这部分代码没审到：' + late.slice(0, 3).map((x) => '"' + x.task.slice(0, 30) + '"（' + x.files.slice(0, 2).map(rel).join('、') + '）').join('；') + '。再按 /ttls-cross-review 的代码模式审一遍这几项的改动（审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
}

// ===================== 多轮审查（开关 reviewLoop） =====================
// 一轮审查报了问题：改了东西就复审改动点，报"问题 0 条"才算审完；审查意见都不成立、之后只在这个变更的 revisions.md 里记了理由的，算处理完；
// 轮数用完还有问题：问用户一次（全自动按原则自己定），也算完。状态在 state/review-rounds.json，按"模式|变更目录"计。
const underDir = (file, dir) => { const f = normKey(file); const d = normKey(dir); return f === d || f.startsWith(d + '/'); };
const reviewMax = (cfg) => Math.min(5, Math.max(1, Number(cfg.reviewMaxRounds) || 3));
/**
 * 把这份会话记录里做完的审查计进轮数（每次审查只计一次），再看每个还没审完的，这次审查之后改了什么。
 * reviews 是 syncReviews 的返回（pos 是结论在 entries 里的位置）。只看这份会话记录里出现过的审查：别的项目、别的会话的不管。
 * 返回 [{ key, rec, change, fixed }]：fixed = 审查之后改了东西（.vibe、.claude 里的和 revisions.md 不算）
 */
function syncReviewRounds(entries, reviews) {
  const last = new Map();
  for (const r of reviews || []) if (r.change && r.mode) last.set(r.mode + '|' + normKey(r.change.dir), r);
  if (!last.size) return [];
  const calls = toolCalls(entries, 0);
  const res = toolResults(entries);
  const out = [];
  updateState('review-rounds', (st) => {
    for (const r of reviews) {
      if (!r.change || !r.mode) continue;
      const k = r.mode + '|' + normKey(r.change.dir);
      const born = changeBorn(r.change.dir);
      let rec = Object.assign({ rounds: 0, seen: [], done: false }, st[k] || {});
      // 同名变更归档后重建过：以前的轮数不算
      if (rec.born && born && Math.abs(rec.born - born) > 2000) rec = { rounds: 0, seen: [], done: false };
      const seen = rec.seen || [];
      if (seen.includes(r.key)) continue;
      // 老版本记的是调用的 id（会重复）：id 对得上、又不比记着的最后一次审查新，才当成计过的；更新的是另一次审查
      if (r.raw && seen.includes(r.raw) && (r.at || 0) <= (rec.at || 0)) continue;
      // 这次审查已经计在别的变更头上了：不再计到这个头上（一次审查只归一个变更）
      const owners = st._owner && typeof st._owner === 'object' ? st._owner : (st._owner = {});
      if (owners[r.key] && owners[r.key] !== k) continue;
      owners[r.key] = k;
      const ok = Object.keys(owners);
      if (ok.length > 400) for (const x of ok.slice(0, ok.length - 400)) delete owners[x];
      if (rec.done) { rec.rounds = 0; rec.done = false; rec.exhausted = false; rec.dismissed = false; }
      rec.rounds += 1;
      rec.seen = seen.concat(r.key).slice(-50);
      rec.issues = r.issues;
      rec.at = r.at || Date.now();
      rec.born = born;
      rec.name = r.change.name;
      rec.pendingFix = r.issues > 0;
      if (r.issues === 0) rec.done = true;
      st[k] = rec;
    }
    for (const [k, r] of last) {
      const rec = st[k];
      if (!rec) continue;
      let fixed = false;
      let noted = false;
      if (!rec.done && rec.pendingFix) {
        for (const c of calls) {
          if (c.i <= r.pos || !/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) continue;
          const x = res.get(c.id);
          if (!x || x.error) continue;
          const f = String(c.input.file_path || c.input.notebook_path || '');
          if (!f) continue;
          if (/(^|[\\/])revisions\.md$/i.test(f)) { if (underDir(f, r.change.dir)) noted = true; continue; }
          if (/(^|[\\/])\.(vibe|claude)[\\/]/.test(f)) continue;
          fixed = true;
        }
        // 审查意见都不成立：之后只在这个变更的 revisions.md 里记了理由（起因：审查），别的没动——算处理完
        if (noted && !fixed) { rec.done = true; rec.dismissed = true; rec.pendingFix = false; }
      }
      out.push({ key: k, rec, change: r.change, fixed });
    }
  });
  return out;
}
/** 轮数用完还有问题时说的话：有人在就停下来问，全自动按原则自己定 */
function reviewExhaustedText(rec, kind, cfg, changeName) {
  const name = kind === 'proposal' ? '提案' : '代码';
  const who = '变更 ' + (changeName || rec.name || '') + ' 的' + name + '已经审了 ' + rec.rounds + ' 轮，仍有问题。';
  return cfg.autoMode
    ? who + '全自动模式：不问我，按约定里"全自动模式"一节的原则自己定——优先选影响面最小的方案，宁可少做一个边角功能也不能破坏现有功能；不用 hack 绕过验证；定了的方案验证过再提交；结论和理由写进 revisions.md（起因：自动模式决定），最后的交代里单独列"等你回来定的事"。'
    : who + '现在停下来问我：先用一两句话说清剩下的问题是什么，然后调用 AskUserQuestion，问题"' + name + '审了 ' + rec.rounds + ' 轮还有问题，怎么办？"，header "审查"，选项：1. 再修再审一轮  2. 就这样，剩下的问题记进 revisions.md 先提交  3. 我自己来看。不要自己决定。';
}
/**
 * 打勾（开工）、归档之前：这个变更的多轮审查审完了吗。先调 syncReviewRounds 把会话记录里的审查计上。
 * 没开多轮审查、审完了返回空串；轮数已经用完的，这一次就按"问用户 / 全自动自己定"说，并记成审完（问过了再来就放行）
 */
function reviewLoopIssue(kind, dir, cfg) {
  if (!cfg.reviewLoop) return '';
  const k = kind + '|' + normKey(dir);
  const rec = readState('review-rounds')[k];
  if (!rec || rec.done) return '';
  if (rec.born && changeBorn(dir) && Math.abs(rec.born - changeBorn(dir)) > 2000) return '';
  if (rec.rounds >= reviewMax(cfg)) {
    updateState('review-rounds', (st) => { if (st[k]) { st[k].done = true; st[k].exhausted = true; } });
    try { require('./usage.js').bump('review.exhausted'); } catch (e) { /* 数不了就算了 */ }
    return reviewExhaustedText(rec, kind, cfg, path.basename(dir));
  }
  const name = kind === 'proposal' ? '提案' : '代码';
  return name + '的多轮审查还没审完：第 ' + rec.rounds + ' 轮报了 ' + (rec.issues || 0) + ' 条问题。成立的改掉，再让 ttls-reviewer 复审改动点（提示第一行写"模式：复审' + name + '"，第二行写"变更：' + path.basename(dir) + '"），复审到"问题 0 条"；都不成立的，在这个变更的 revisions.md 里逐条记下理由（起因：审查），就算处理完';
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
/** 会话记录里有没有接着交接记录干：读过 .vibe/handover.md，或者用户说了"接着上一个会话的交接记录继续" */
function handoverReadIn(entries) {
  for (const e of entries) if (isUserTurn(e) && /接着上一个会话的交接记录继续/.test(textOf(e))) return true;
  return toolCalls(entries, 0).some((c) => (c.name === 'Read' && /(^|[\\/])\.vibe[\\/]handover\.md$/i.test(String(c.input.file_path || ''))) || (/^(Bash|PowerShell)$/.test(c.name) && /(?:^|[\s"'\\/])handover\.md/i.test(String(c.input.command || '')) && READ_CMD.test(String(c.input.command || ''))));
}
/** 这一段调用里写过交接记录吗：用户敲了 /ttls-handover（改名之前叫 /handover）、用 Skill 调了它、写了 .vibe/handover.md */
function handoverWrittenIn(calls, prompt, failed) {
  if (/<command-name>\s*\/?(ttls-)?handover\s*<\/command-name>/.test(String(prompt || ''))) return true;
  return calls.some((c) => !(failed && failed(c)) && ((c.name === 'Skill' && /^\/?(ttls-)?handover$/i.test(String(c.input.skill || c.input.command || ''))) || (/^(Write|Edit|MultiEdit)$/.test(c.name) && /(^|[\\/])\.vibe[\\/]handover\.md$/i.test(String(c.input.file_path || '')))));
}

// ===================== 套件自己的文件（用户级）不许模型改 =====================
// 实际发生过：模型嫌钩子碍事，自己去改 ~/.claude/vibe-kit 里的钩子。套件是用户的，模型只能用不能改（开关 kitLock，默认开）。
const CFG_DIR = path.dirname(KIT);
/** 路径解析成真实路径（跟着目录联接、符号链接走）；路径还不存在时解析它最近一级存在的上级，再把剩下的拼回去 */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 60; i++) {
    try { const r = fs.realpathSync.native(cur); return rest.length ? path.join(r, ...rest.reverse()) : r; } catch (e) { /* 往上一级 */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.push(path.basename(cur));
    cur = up;
  }
  return path.resolve(p);
}
/**
 * 套件装在用户目录里的东西：vibe-kit 目录本身、settings.json、全局 CLAUDE.md、装进去的技能和代理（按 pristine 里的清单）。
 * 同时认两种写法：用户看到的路径（CLAUDE_CONFIG_DIR 或 ~/.claude）和真实路径（.claude 挪到别的盘再建目录联接时，两者不一样）。
 * 每个进程只算一次。
 */
let protectedCache = null;
function protectedKitPaths() {
  if (protectedCache) return protectedCache;
  const bases = [...new Set([CFG_DIR, process.env.CLAUDE_CONFIG_DIR || '', path.join(os.homedir(), '.claude')].filter(Boolean).map((b) => path.resolve(b)))]
    .filter((b) => { try { return normKey(realish(b)) === normKey(realish(CFG_DIR)); } catch (e) { return false; } });
  const names = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
  const skills = names(path.join(KIT, 'pristine', 'skills'));
  const agents = names(path.join(KIT, 'pristine', 'agents'));
  const out = new Set();
  for (const base of bases) {
    const list = [path.join(base, 'vibe-kit'), path.join(base, 'settings.json'), path.join(base, 'CLAUDE.md')];
    for (const n of (skills.length ? skills : ['ttls-onboard', 'ttls-see-page', 'ttls-cross-review', 'ttls-handover', 'ttls-db-crud', 'ttls-redis'])) list.push(path.join(base, 'skills', n));
    for (const n of (agents.length ? agents : ['ttls-reviewer.md'])) list.push(path.join(base, 'agents', n));
    for (const p of list) { out.add(normKey(p)); out.add(normKey(realish(p))); }
  }
  out.add(normKey(KIT));
  protectedCache = [...out];
  return protectedCache;
}
/** 把 ~、$HOME（大小写都认）、$env:USERPROFILE、%USERPROFILE%、$CLAUDE_CONFIG_DIR 这些换成真实路径 */
function expandHome(word) {
  const home = os.homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR || CFG_DIR;
  return String(word || '')
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/\$\{?home\}?(?![\w])/gi, home).replace(/\$\{?env:(?:USERPROFILE|HOME)\}?/gi, home).replace(/%USERPROFILE%/gi, home).replace(/%HOMEDRIVE%%HOMEPATH%/gi, home)
    .replace(/\$\{?env:CLAUDE_CONFIG_DIR\}?/gi, cfg).replace(/%CLAUDE_CONFIG_DIR%/gi, cfg).replace(/\$\{?CLAUDE_CONFIG_DIR\}?/gi, cfg);
}
/** 这个路径（绝对的、相对 baseDir 的、带 ~ 或环境变量的）是不是套件的东西 */
function isKitPath(p, baseDir) {
  try {
    let s = expandHome(String(p || '').replace(/^["']|["']$/g, ''));
    if (!s) return false;
    if (process.platform === 'win32') s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir || process.cwd(), s);
    const keys = [normKey(abs), normKey(realish(abs))];
    return protectedKitPaths().some((x) => keys.some((k) => k === x || k.startsWith(x + '/')));
  } catch (e) { return false; }
}
/**
 * 套件装的技能自带的脚本：<技能目录>/scripts/ 下面那一层的 .py、.js（查库的 db.py、查 redis 的 redis.js）。
 * 跑它们是技能的正常用法；更深的目录（执行器的 class）、别的扩展名不算
 */
function isKitSkillScript(p, baseDir) {
  try {
    let s = expandHome(String(p || '').replace(/^["']|["']$/g, ''));
    if (!s) return false;
    if (process.platform === 'win32') s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir || process.cwd(), s);
    const keys = [normKey(abs), normKey(realish(abs))];
    return protectedKitPaths().some((x) => /\/skills\/[^/]+$/.test(x) && keys.some((k) => k.startsWith(x + '/scripts/') && /^[^/]+\.(py|js)$/.test(k.slice(x.length + 9))));
  } catch (e) { return false; }
}
/** .claude 目录下的 settings.json / settings.local.json（项目级、用户级都算）：往里写 disableAllHooks 会让所有钩子失效 */
const isClaudeSettingsFile = (p) => /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i.test(String(p || '')) || /(^|[\\/])settings(\.local)?\.json$/i.test(String(p || '')) && isKitPath(p);

// ===================== 会话中途约定、技能变了：不用 /clear 也能让模型知道 =====================
// 实测（2.1.259）：会话进行中，钩子脚本和钩子登记改了立刻生效；全局 CLAUDE.md 改了、新装了技能，模型看不到，/clear 之后才重新读。
// 所以由钩子来送：会话开始时记下模型拿到的版本，用户每次开口时比一下，变了就把变了的那几段带给它，只送一次。
const globalMdFile = () => path.join(CFG_DIR, 'CLAUDE.md');
function readTextFile(f) { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; } catch (e) { return null; } }
/** 按标题（# 到 ####）切段，代码块里的 # 不算标题。key 是标题路径（重名的加序号），body 是这一段自己的内容 */
function mdSections(text) {
  const out = [];
  const stack = [];
  let cur = { key: '（开头）', heading: '', lines: [] };
  const flush = () => { const body = cur.lines.join('\n').trim(); if (cur.heading || body) out.push({ key: cur.key, heading: cur.heading, body }); };
  let fence = false;
  for (const l of String(text || '').split(/\r?\n/)) {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = fence ? null : l.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (!m) { cur.lines.push(l); continue; }
    flush();
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: m[2] });
    cur = { key: stack.map((s) => s.title).join(' > '), heading: l.trim(), lines: [] };
  }
  flush();
  const seen = {};
  for (const s of out) { const n = (seen[s.key] = (seen[s.key] || 0) + 1); if (n > 1) s.key += ' #' + n; }
  return out;
}
/** 两版约定按段比：新加的、内容变了的段，和删掉的段 */
function conventionDiff(oldText, newText) {
  const a = mdSections(oldText);
  const b = mdSections(newText);
  const oldMap = new Map(a.map((s) => [s.key, s.body]));
  const newKeys = new Set(b.map((s) => s.key));
  return { changed: b.filter((s) => oldMap.get(s.key) !== s.body), removed: a.filter((s) => !newKeys.has(s.key)) };
}
const CONV_MAX = 6000;
function conventionNotice(diff, file) {
  const removed = diff.removed.map((s) => (s.heading || '（开头）').replace(/^#+\s*/, ''));
  const text = diff.changed.map((s) => (s.heading ? s.heading + '\n' : '') + s.body).join('\n\n').trim();
  if (text.length > CONV_MAX) return '全局约定（' + file + '）在这个会话里改了好几处（装了新版套件，或者配置页改了开关），不用重开会话，但改动太多不在这里贴：现在先用 Read 读一遍这个文件，以它为准；会话开头给你的旧版本作废。';
  let t = '全局约定刚改了（装了新版套件，或者配置页改了开关），不用重开会话。' + (text ? '下面这几段以新的为准，会话开头给你的旧版本里对应的部分作废：\n\n' + text : '');
  if (removed.length) t += (text ? '\n\n' : '') + '这几段已经删掉，不再适用：' + removed.join('、') + '。';
  return t;
}
/** 模型能看到的技能（用户级、从 cwd 往上各层的 .claude/skills）：名字 → 文件、内容指纹 */
function skillIndex(cwd) {
  const out = {};
  const dirs = [path.join(CFG_DIR, 'skills')];
  let d = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 6; i++) { if (normKey(path.join(d, '.claude')) !== normKey(CFG_DIR)) dirs.push(path.join(d, '.claude', 'skills')); const up = path.dirname(d); if (up === d) break; d = up; }
  for (const dir of dirs) {
    let names = []; try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      if (out[n]) continue;
      const f = path.join(dir, n, 'SKILL.md');
      let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
      let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch (e) { /* 读得到就有 */ }
      out[n] = { file: f, sig: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16), mtime };
    }
  }
  return out;
}
function skillDescOf(file) {
  try { const fm = require(path.join(KIT, 'tools', 'skills-check.js')).frontmatter(fs.readFileSync(file, 'utf8')); return String(fm.description || '').slice(0, 160); } catch (e) { return ''; }
}
function skillNotice(changed, gone) {
  const lines = changed.slice(0, 12).map((s) => { const desc = skillDescOf(s.file); return '- ' + s.name + (s.isNew ? '（新装的）' : '（改过）') + (desc ? '：' + desc : '') + '；文件：' + s.file; });
  let t = '';
  if (lines.length) t = '技能有变化，这个会话开头给你的技能列表还没反映出来：\n' + lines.join('\n') + '\n新装的技能不在这个会话的技能列表里，调不出来：要用就直接读它的文件照着做。改过的技能，用它的时候以文件的最新内容为准。';
  if (gone.length) t += (t ? '\n' : '') + '这些技能已经删掉，别再用：' + gone.join('、') + '。';
  // 审查代理是会话开始时载入的：会话中途装的新代理（ttls-reviewer，和 ttls-cross-review 一起装的）这个会话里可能调不到
  if (changed.some((s) => s.isNew && String(s.name).endsWith('cross-review'))) t += (t ? '\n' : '') + '审查代理也换了名字（ttls-reviewer）。这个会话里调它报"找不到这个代理"的话，改用旧名字 vibe-reviewer；还不行就告诉用户重开一个会话再审。';
  return t;
}
/** 会话是什么时候开始的：会话记录第一条带时间的条目，读不到就看文件的创建时间 */
function sessionStartMs(file) {
  if (!file) return 0;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8', 0, n).split('\n')) { try { const e = JSON.parse(l); const t = e && e.timestamp && Date.parse(e.timestamp); if (t) return t; } catch (e) { /* 半截行 */ } }
  } catch (e) { /* 读不了 */ }
  try { return fs.statSync(file).birthtimeMs || 0; } catch (e) { return 0; }
}
const convCurrent = (cwd) => ({ md: readTextFile(globalMdFile()) || '', skills: skillIndex(cwd) });
/**
 * 会话开始时记下模型拿到的版本。startup、clear、resume：就是现在的文件（实测 /clear 会重新读）。
 * compact（压缩之后）：送过的更新可能随着压缩丢了，退回到会话开始时的版本，下次开口再把改了的送一遍；重复送一遍无害。
 */
function recordConvBaseline(sessionId, cwd, source) {
  if (!sessionId) return;
  const key = sessionId + '-conv';
  if (source === 'compact') { const st = readState(key); if (st.start) writeState(key, Object.assign({}, st, { delivered: st.start, at: Date.now() })); return; }
  const cur = convCurrent(cwd);
  writeState(key, { cwd: path.resolve(cwd || process.cwd()), start: cur, delivered: cur, at: Date.now() });
}
/** 用户开口时调：约定、技能和模型手上的不一样，就返回要带给它的话（只送一次，送完记成已送） */
function convUpdateNotice(j) {
  const sid = j && j.session_id;
  if (!sid) return '';
  const key = sid + '-conv';
  const st = readState(key);
  const cwd = st.cwd || path.resolve(j.cwd || process.cwd());
  const cur = convCurrent(cwd);
  const out = [];
  if (!st.delivered) {
    // 这个会话开始时还没有这个功能（比如会话开着的时候装了新版）：按会话开始的时间判断，之后改过的让它重新读
    const since = sessionStartMs(j.transcript_path);
    let mdStale = false;
    if (since) {
      try { mdStale = fs.statSync(globalMdFile()).mtimeMs > since + 2000; } catch (e) { /* 没有这个文件 */ }
      if (mdStale) out.push('全局约定（' + globalMdFile() + '）在这个会话开始之后改过（装了新版套件，或者配置页改了开关），不用重开会话：现在先用 Read 读一遍这个文件，以它为准；会话开头给你的旧版本作废。');
      const fresh = Object.entries(cur.skills).filter(([, s]) => s.mtime > since + 2000).map(([name, s]) => ({ name, file: s.file, isNew: false }));
      if (fresh.length) out.push(skillNotice(fresh, []));
    }
    // 会话开始时模型拿到的约定不知道是哪一版：按"空的"记，压缩之后会再提醒它读一遍全文
    writeState(key, { cwd, start: { md: mdStale ? '' : cur.md, skills: cur.skills }, delivered: cur, at: Date.now() });
    if (out.length) hookLog('conv-notice fallback session=' + sid + ' md=' + mdStale);
    return out.join('\n\n');
  }
  const diff = conventionDiff(st.delivered.md || '', cur.md);
  if (diff.changed.length || diff.removed.length) out.push(conventionNotice(diff, globalMdFile()));
  const old = st.delivered.skills || {};
  const changed = [];
  for (const [name, s] of Object.entries(cur.skills)) { if (!old[name]) changed.push({ name, file: s.file, isNew: true }); else if (old[name].sig !== s.sig) changed.push({ name, file: s.file, isNew: false }); }
  const gone = Object.keys(old).filter((n) => !cur.skills[n]);
  if (changed.length || gone.length) out.push(skillNotice(changed, gone));
  if (out.length || Date.now() - (st.at || 0) > 86400000) writeState(key, Object.assign({}, st, { delivered: cur, at: Date.now() }));
  if (out.length) hookLog('conv-notice session=' + sid + ' sections=' + diff.changed.length + '/' + diff.removed.length + ' skills=' + changed.length + '/' + gone.length);
  return out.join('\n\n');
}

module.exports = { DEFAULT_CONFIG, FLOW_SLASH, FLOW_TAG, FLOW_SKILL, APPLY_SLASH, APPLY_TAG, flowState, setFlow, flowTouch, flowChanges, flowStage, flowDone, flowAdopt, applyIntent, planIntent, changeStarted, handoverStage, lastUserVoice, userSaid, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, readConfigFor, sessionHome, noteSessionHome, atHome, blockOut, askOut, cli, sleepMs, ensureVibeIgnored, hookLog, looksLikeProject, isShell, KIT, readConfig, sealConfig, kitCodeHashes, kitCodeDrift, subdirs, nestedRepos, changeRoots, listChanges, activeChanges, tailEntries, textOf, lastUsageTokens, contextPercent, autoCompactWindowOf, autoCompactAt, gatewayLimit, nearGatewayLimit, readState, writeState, updateState, cleanState, GLOBAL_STATE,
  HEDGE_WORDS, STAGE, findHedges, hedgeHit, artifactOf, pathTokens, pathExists, sectionOf, addedLines, checkTasks, checkSpec, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, artifactHash, normKey, snapshotArtifacts,
  VERIFY_CMD, isUserTurn, turnStart, toolCalls, toolResults, projectReads, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, verifyRan, verifyPlan, toolAtCommandPos, NEW_FILE, declaredNew, missingPathIssue,
  changeBorn, reviewModeOf, isRecheck, allChanges, archivedNames, archivedSince, reviewTargetOf, reviewIssues, reviewsIn, pendingReviewsIn, syncReviews, reviewRecord, recordReview, proposalReviewed, codeReviewed,
  codeReviewIssue, unreviewedAfter, touchChange, syncTicks, taskCodeFiles, projectRootsOf, isDeferredTask, TASK_DEFER, uniquifyToolIds,
  underDir, reviewMax, syncReviewRounds, reviewExhaustedText, reviewLoopIssue, sessionChanges, handoverReadIn, handoverWrittenIn, normTicks,
  taskNotes, isTaskNote, isTaskNotePrompt,
  CFG_DIR, realish, protectedKitPaths, expandHome, isKitPath, isKitSkillScript, isClaudeSettingsFile,
  mentionsChange, handoverStale, readTextFileRaw, readPlan, planStatusOf, refreshPlan, planSummary, changeNames, archivedChanges, planMissingInfo, planInit, planUnlisted,
  mdSections, conventionDiff, skillIndex, sessionStartMs, recordConvBaseline, convUpdateNotice };

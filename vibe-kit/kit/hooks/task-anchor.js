'use strict';
/*
 * UserPromptSubmit 钩子：防止"被打断后忘了自己在干什么"。
 * 现象：模型正在执行某条 OpenSpec 指令（比如 /opsx:apply），用户中途打断聊了几句，
 * 之后它就忘了原来在执行什么，不再按那条指令的步骤走，开始凭印象做。
 * 做法：用户发消息时，从会话记录里确定性地取出两件事，用一两行带给模型：
 *   1. 刚才有没有打断过，被打断的是哪条流程指令
 *   2. 这个会话在做的 OpenSpec 变更做到第几项，下一项是什么（这个会话没碰过的变更不提，比如壳子里 git pull 下来的同事的）
 * 提醒得不准比不提醒更糟，所以口气分档：
 *   指令发出后紧接着就被打断   → 肯定句：回应完回到这条指令的步骤
 *   中间隔了一两句对话         → 条件句：没做完就接着做，做完了就别回头重跑
 *   隔了三句以上、或任务已全部打勾 → 不提
 * 打断之后用户已经又说了三句以上，也不再提。stdout 的内容会作为上下文交给模型。
 * 顺带的几件事：
 *   连续工作默认自动压缩；仅用户选择旧交接策略时提醒交接线。用量取状态栏或会话记录，不借旧文档恢复许可。
 *   全自动模式开着时，这句话算不算在走 OpenSpec 流程、在流程的哪一段（写提案 plan / 做任务 apply），在这里定（decideFlow）：
 *   不在流程里、或者还在写提案那一段，这一轮照有人在的样子来（全自动只管 apply 之后，用户 2026-10-07 定的）。
 *   这句话开工了（敲了 /opsx:apply、说了"开工""把 1.1 做了"）：告诉用户这次全自动开没开（systemMessage，不进模型的上下文，不打断干活）。
 *   开工前不自动拉代码（2026-10-17 起，用户自己拉）。
 */
const fs = require('fs');
const path = require('path');
const intent = require('../lib/intent');
const { atHome, FLOW_SLASH, FLOW_TAG, APPLY_SLASH, APPLY_TAG, applyIntent, planIntent, changeStarted, handoverStage, BUG_REPORT, WANTS_PROPOSAL, SMALL_FIX_TEXT, flowState, flowDone, flowAdopt, setFlow, flowTouch, mentionsChange, activeChanges, allChanges, tailEntries, textOf, lastUsageTokens, readConfig, contextPercent, nearGatewayLimit, readState, writeState, hookLog, snapshotArtifacts, normKey, handoverStale, convUpdateNotice, proposalReviewed, changeRoots, isTaskNotePrompt, syncReviews, sessionChanges, KIT, cli } = require('../lib/session');
let hookHealth = () => '';
try { hookHealth = require('../lib/hook-health.js').check; } catch (e) { /* 老版本没有 */ }

/**
 * 用户提了一条需求（不是问句、不是斜杠命令）：提醒它先探索再提案，别凭印象直接写提案或改代码。
 * 判断只看用词，宁可多提醒一句也不漏：提醒的话里已经说明了不用提案的小改动直接改。开关 specGate。
 */
const NEED = /(需求|功能|想要|想做|要做|做一个|做个|加一个|加个|新增|新建|新做|实现|支持|改成|改为|改造|重做|优化|重构|增加|开发|页面|接口|导出|导入|报表|统计|集成|对接)/;
const QUESTION = /(为什么|为啥|是什么|什么意思|怎么看|怎么理解|吗[？?]?$|[？?]$|解释|说明一下|看看|看一下|查一下|查查|检查|核对|对比)/;
// 闲话：整句就是应一声（"好的""行，就这样"）。开头碰巧是这几个字的不算（"好友列表加个搜索""行程管理做个导出"）；"继续…"后面跟什么都是接着做，不是新需求
const SMALL_TALK = /^继续|^(好|好的|嗯|行|可以|ok|okay|谢谢)(的|吧|啊|呀|了|哦)*([\s，,。.！!？?~～…、]|$)/i;
// "不要停""别等我，做完再说""不用问我"：开头是"不 / 别"，意思却是接着做
const KEEP_GOING = /^(不要|不用|别|甭|不必|无需)再?(停|等|问|管我|确认|请示|汇报|担心)/;
// 让它停的话，只认两种。以前只看开头是不是"不用 / 不要 / 别 / 停"："不要停，把剩下的做完"也被当成停，全自动这一轮就按没开算，提问框不拦，活停在那里等人
//   开头就是"停 / 暂停 / 等等 / 等一下 / stop"，后面是标点、语气词或者没了（"停车场加个导出"不算）
//   整句很短（去掉标点不超过 8 个字），开头是"不用 / 不要 / 别做 / 先别 / 算了 / 取消 / 等等"这类
const HALT = /^(请?先?停|暂停|等等|等一下|等会儿?|stop)(了|下|一下|住|吧|啊)*([\s，,。.！!~～…、；;:：]|$)/i;
const SHORT_NO = /^(不用|不要|别[做弄改动写提继管搞跑执推再了急]|先别|算了|取消|先停|暂停|等等|等一下|等会)/;
function isStop(p) {
  if (KEEP_GOING.test(p)) return false;
  return HALT.test(p) || (SHORT_NO.test(p) && p.replace(/[\s，,。.！!？?~～…、；;:：]/g, '').length <= 8);
}
/** 这句话像不像一条需求（不是问句、不是闲话、不是让它停、不是让它出一份文档、不是斜杠命令） */
function looksLikeRequirement(p) {
  if (!p || p.length < 6 || p.length > 3000 || /^\s*\//.test(p) || SMALL_TALK.test(p) || isStop(p) || looksLikeOutputRequest(p) || QUESTION.test(p) || !NEED.test(p)) return false;
  return !/接着上一个会话的交接记录继续/.test(p);
}
/**
 * 全自动模式开着时，这句话算不算在走 OpenSpec 流程（规矩见 lib/session.js"全自动模式只在走 OpenSpec 流程时算开着"）。
 * 定下来记进 state/<会话>-flow.json，别的钩子照着它算 autoMode。resumed：这句话接上了一份刚写的交接记录
 */
const CONTINUE_WORDS = /^(继续|接着|接着做|继续做|往下做|下一步|好|好的|嗯|行|可以|ok|okay|go on|continue|next|做吧|开始吧)[\s。！!，,.~～]*$/i;
// 流程里会用到的那几个技能（审查、看页面、交接）：用户自己敲它们，不算进流程也不算出流程，跟上一轮一样
// 套件的许可命令（/vk-commit、/vk-push、/vk-archive、/vk-review、/vk-test，用户 2026-10-30 定的）也跟上一轮一样：在流程里就还在
const SAME_SLASH = /^\s*\/(?:(ttls-)?(cross-review|see-page|handover)|vk-(?:commit|push|archive|review|test|auto))(\s|$)/i;
// 敲的是 /opsx:apply（不是 archive、verify 这些）；或者在说归档的事（点了名让它归档，不算开工）
const APPLY_CMD = /^\s*\/(opsx:|openspec[-:])apply\b|<command-name>\s*\/?(opsx:|openspec[-:])apply\b/i;
const ARCHIVE_TALK = /^\s*\/(opsx:|openspec[-:])(archive|bulk-archive|verify|sync)\b|<command-name>\s*\/?(opsx:|openspec[-:])(archive|bulk-archive|verify|sync)\b|归档|archive/i;
/**
 * 返回 { on: 这一轮在不在流程里, cont: 是不是"继续"这类话接回去的（不算新开工：不拉代码、不数"进流程"）,
 *   stage: 在流程的哪一段（plan 写提案 / apply 做任务，规矩见 lib/session.js"流程分两段"）, applyStart: 这句话开工了（要告诉用户全自动开没开） }
 */
function decideFlow(j, cfg, note, resumed) {
  let prev = flowState(j);
  // 装这一版之前就开着的会话头一回开口：先照以前的算法接过来（它动过变更就算在流程里），"继续"才接得上
  if (prev.at === undefined && cfg.autoSwitch) prev = flowAdopt(j);
  // 它动过的变更都归档了：流程走完了，"继续""好"不再接回去（点名新的变更、敲 /opsx:… 照样进；收工时已经记成不在流程里的，这里把"上一轮在流程里"的时间也抹掉）
  if (flowDone(j)) { if (prev.on) setFlow(j, false, '变更归档了'); prev = Object.assign({}, prev, { on: false, was: 0 }); }
  const prevStage = prev.stage === 'apply' ? 'apply' : 'plan';
  // 后台任务做完的通知不是用户说的话：跟原来一样
  if (note) return { on: !!prev.on, cont: true, stage: prevStage, applyStart: false };
  const p = String(j.prompt || '').trim();
  let named = [];
  // 点了名的变更：没归档的都算。任务全打了勾、等着复审和归档的也是流程里的事（"接着做：复审 a1 的代码，没问题就归档"）
  try { named = allChanges(j.cwd || process.cwd()).filter((c) => mentionsChange(p, c.name)); } catch (e) { named = []; }
  let on = false;
  let why = '';
  let cont = false;
  // 在流程的哪一段：默认跟上一轮一样（没记过的还是没记，按 apply 算）
  let stage = prevStage;
  // 这句话是让它做任务（开工）还是在说提案那一段的事：开工算 apply，改提案算 plan，都不是就用给定的那个
  const stageOf = (fallback) => (applyIntent(p) ? 'apply' : planIntent(p) ? 'plan' : fallback);
  // 上一轮在流程里；或者上一轮只是插进来问了一句、再上一轮在流程里（一天之内）
  const going = !!prev.on || (!!prev.was && Date.now() - prev.was < 86400000);
  if (FLOW_SLASH.test(p) || FLOW_TAG.test(p) || APPLY_SLASH.test(p) || APPLY_TAG.test(p)) { on = true; why = '敲了 OpenSpec 的命令'; stage = APPLY_SLASH.test(p) || APPLY_TAG.test(p) ? 'apply' : 'plan'; }
  else if (SAME_SLASH.test(p)) { on = !!prev.on; why = on ? '接着上一轮' : ''; }
  // 别的斜杠命令（/ttls-onboard、自己的命令）：这一轮做的是那件事，不在流程里（议题 #9）
  else if (/^\s*\//.test(p)) { on = false; }
  else if (resumed) { on = true; why = '用户明确选择手动交接'; stage = 'plan'; }
  // "不要停，把剩下的做完""别等我"：接着做。原来不在流程里的不算，照下面的规矩看这句话本身
  else if (KEEP_GOING.test(p) && going) { on = true; why = '接着上一轮'; cont = true; }
  else if (isStop(p) || intent.denied(p, 'apply')) { on = false; stage = 'plan'; }
  // "继续"：上一轮在流程里就接着；上一轮只是插进来问了一句的，跟再上一轮（一天之内）
  else if (CONTINUE_WORDS.test(p)) { on = going; why = on ? '接着上一轮' : ''; cont = true; }
  // 问句只回答：这一轮不在流程里（说"继续"就接回去）
  else if (QUESTION.test(p)) { on = false; }
  // 让它出一份代码之外的东西（说明、报告、清单，或者"生成一个文件记一下"）：也是插进来的一句，不在流程里——放哪照常问用户，全自动不作数。
  // 以前"正在流程里，又说了一句不是问句的话"把这种也算在流程里，全自动开着时就不问、自己挑地方放了（用户 2026-10-07 反馈）
  else if (looksLikeOutputRequest(p)) { on = false; }
  // 正在流程里，又说了一句不是问句的话（"3.3 我执行过了，接着归档""字段名不对，应该是 X"）：还在流程里。说了开工就进 apply，说的是提案的事就回到 plan
  else if (prev.on) { on = true; why = '接着上一轮'; stage = stageOf(prev.stage); }
  else if (looksLikeRequirement(p)) { on = true; why = '提了需求'; stage = 'plan'; }
  // 点了名的变更：让它开工、或者这个变更已经打过勾的算 apply；还没开工的、说的是提案的事算 plan
  else if (named.length && p.length <= 3000) { on = true; why = '点了变更 ' + named[0].name; stage = stageOf('plan'); }
  setFlow(j, on, why, on ? stage : undefined);
  if (on && stage === 'apply' && applyIntent(p)) {
    // 用户只说"开工"、有几个变更时，看模型刚才那段话点的是哪个（#214）
    let said = '';
    try { const es = j.transcript_path ? tailEntries(j.transcript_path, 3000000) : []; const v = require('../lib/session').lastUserVoice(es); said = require('../lib/session').saidBefore(es, v && v.kind === 'prompt' && v.text === p ? v.pos : es.length); } catch (e) { said = ''; }
    const permit = require('../lib/apply-scope').grant(j, p, '', { said });
    if (!permit.ok) { stage = 'plan'; setFlow(j, true, permit.reason, 'plan'); }
  }
  if (isStop(p) || intent.denied(p, 'apply')) require('../lib/session').updateState(String(j.session_id) + '-flow', (s) => { s.was = 0; s.stage = 'plan'; delete s.applyScope; });
  if (on) for (const c of named) flowTouch(j, c.dir);
  const nowStage = stage === 'apply' ? 'apply' : 'plan';
  // 这句话开工了：敲了 /opsx:apply，或者上一轮还不在做任务那一段。点名让它归档的不算
  const applyStart = on && nowStage === 'apply' && applyIntent(p);
  if (cfg.autoSwitch && (!!prev.on !== on || (on && prevStage !== nowStage))) hookLog('全自动模式 ' + (on ? '这个会话' + (prev.on ? '' : '进了 OpenSpec 流程：' + why + '，') + (nowStage === 'apply' ? '在做任务那一段（全自动算数）' : '在写提案那一段（照有人在的样子来）') : '这一轮不在 OpenSpec 流程里，照有人在的样子来'));
  return { on, cont, stage: nowStage, applyStart };
}
/**
 * 开工（apply 开始）的那一句：用户 2026-10-07 要的——不管是他敲的 /opsx:apply 还是让它开工，都告诉他这次全自动开没开，不打断干活。
 * 给用户看的走 systemMessage（Claude Code 显示在对话里，不进模型的上下文）；给模型的那一行让它照着做
 */
function applyNotice(cfg) {
  const auto = !!(cfg.autoSwitch && cfg.autoMode);
  return {
    user: '[vibe-kit] 开始 apply：全自动模式' + (auto ? '开着。每整组任务完成后自动审修、自测；做法上的事它自己定、记进报告，需求本身有疑问才问你。' : '关着。审查、自测和复验先 Ask。'),
    // 用户 2026-10-30 定的（问题表第 22 条）：自动模式下做法上的取舍自己定，不停下来问；改 design、tasks 不退出自动
    model: '现在开始 apply（做任务）：全自动模式' + (auto ? '开着，按当前范围逐整组任务审修、自测。做法上的取舍（怎么写、用哪种实现）自己定，记进 revisions.md（起因：自动模式决定），收工报告会列出来，不停下来问；只有需求本身矛盾或缺关键信息才 Ask。补 design、改 tasks 措辞不退出自动；改 proposal.md、specs 里的要求会退回人工，等用户重新说开工。交付验收用例与实际结果，归档仍等用户决定。' : '关着，审查、自测、复验先 Ask，放弃后直接继续，不记录未审查或未测试。')
      + '提案提交许可和 apply 开工许可分别判断；没有明确提交许可时不在开工节点补提案提交。',
  };
}
/**
 * 会被拦的规矩提前说（用户 2026-10-30 定的，审核 R4、M02）：以前这些都是拦下以后才告诉模型，模型总要先被拦一次。
 * 进写需求、做任务这两段时各送一次（每个会话每段一次，记在 <会话>-stage-rules.json），不写进每个请求都带的全局约定（硬规矩 8）
 */
function stageRules(j, stage) {
  const sid = String((j && j.session_id) || '');
  if (!sid || sid === 'unknown') return '';
  const k = sid + '-stage-rules';
  if (readState(k)[stage]) return '';
  writeState(k, Object.assign({}, readState(k), { [stage]: Date.now() }));
  const tool = (n) => 'node "' + path.join(require('../lib/session').KIT, 'tools', n).split(path.sep).join('/') + '"';
  if (stage === 'plan') return '写需求这一段的规矩（照做就不会被拦）：需求文档一份一份写，写完一份停下给用户看，用户说了再写下一份（/opsx:continue）；design.md 要有"## 验收用例"一节；tasks.md 只写实现任务，不写测试、审查、验收任务；审查带审查点：' + tool('review.js') + ' run --change <变更名> --mode proposal --point <proposal|specs|design|tasks>。';
  return '做任务这一段的规矩（照做就不会被拦）：起服务自测走 ' + tool('devserver.js') + ' start --name <名字> --port auto -- <原来的命令>，不直接跑 mvn spring-boot:run、npm run dev、catalina；新建的文件提交前要 git add，只 add 这次改的（不用 git add -A、git add .）；命令里不串 cd，用 git -C <目录>、mvn -f <目录>/pom.xml、npm --prefix <目录>；审查带审查点：' + tool('review.js') + ' run --change <变更名> --mode code --point group-<组号>。';
}
function requirementHint(j, cfg) {
  const p = String(j.prompt || '').trim();
  if (!looksLikeRequirement(p)) return '';
  // 全自动只管 apply 之后：提需求、探索、写提案这一段用户在，照有人在的说法（这时 cfg.autoMode 本来就是 false）
  return '这像一条需求。要走提案的（新功能、改行为、改接口、改表结构）先探索再提案：用 /opsx:explore 的方式在项目里读会碰到的代码、表结构（有查库的技能就用它）、接口、配置，把现状写下来（读了什么、发现什么、和需求对不上的地方、还不知道什么）给我看，明确范围后按当前需求自动条件逐产物生成；不要凭印象直接写提案或改代码。不用提案的小改动直接改。'
    + (cfg && cfg.autoSwitch ? '这个会话开着自动：先探索并和用户确认范围、疑问（qualify 过了）才开始自动，之后整套文档审修定稿提交后自动开工；只写需求的不开工。' : '');
}

/**
 * 这句话要的东西里像是有代码之外的产出（DDL、说明文档、分析报告、表格）：开工前先定好放哪。
 * 写文件那一刻钩子（guard-output）还会查一次，这里是让它在动手之前就想到，别写完了才被拦。开关 outputGate
 */
const OUTPUT_NOUN = /(ddl|建表|sql\s*脚本|报告|说明文档|功能说明|设计文档|接口文档|操作手册|使用手册|手册|纪要|清单|excel|xlsx|word|docx|表格|文档|笔记|备忘|markdown|\.md\b|\.txt\b)/i;
const OUTPUT_VERB = /(写|出|生成|整理|做|输出|导出|给我|弄|起草|编|记)/;
// "生成一个文件记录一下""建个 md 记一下"：没点明是哪种文档，但就是要一个文件来记东西
const NEW_FILE = /(生成|新建|建|创建|写|做|弄|开)(一个|个|一份|份|一张|张)?(新的?)?(文件|md|markdown|txt|记录)/i;
// 这些是代码的活（功能、接口、页面……），不算"让它出一份东西"。"接口文档""功能说明"是文档，不算代码的活
const CODE_WORK = /(功能(?!说明)|模块|页面|接口(?!文档|说明)|代码|实现|开发|改造|重构|优化|集成|对接|bug|报错|组件|服务|字段)/i;
/** 这句话是不是让它出一份代码之外的东西（文档、报告、清单、一个记东西的文件），而不是做代码的活 */
function looksLikeOutputRequest(p) {
  if (!p || p.length > 3000 || /^\s*\//.test(p) || CODE_WORK.test(p)) return false;
  return (OUTPUT_NOUN.test(p) && OUTPUT_VERB.test(p)) || NEW_FILE.test(p);
}
function outputHint(j, cfg) {
  if (!cfg) return '';
  const p = String(j.prompt || '').trim();
  if (!p || p.length > 3000 || !((OUTPUT_NOUN.test(p) && OUTPUT_VERB.test(p)) || NEW_FILE.test(p))) return '';
  if (cfg.autoMode) return '这次要是会产出代码之外的文件（DDL 脚本、说明文档、分析报告、表格……）：项目说明的"产出位置"里有的照着放；没有的先放 .vibe/pending/，最后交代时列进"等你回来定的事"，不要自己挑地方。';
  return '这次要是会产出代码之外的文件（DDL 脚本、说明文档、分析报告、表格……），开工前先定好放哪：项目说明的"产出位置"里有的照着放；没有的现在就用提问框问我，选项写实际目录，定了记进项目说明，别等写完了才问。';
}

/**
 * 这句话像是在报已有功能的问题（自测、测试发现、用户反馈、报错）：项目里有归档过的变更就提醒先溯源；有没归档的变更也提醒。
 * 都是一句：先查清原因，改动小就直接改、简单审一下，不要新开变更（用户 2026-10-07 定的，规矩见 lib/session.js"做完的功能上发现的问题"）。开关 specGate
 */
function traceHint(j, cfg) {
  if (!cfg || cfg.specGate === false) return '';
  const p = String(j.prompt || '');
  if (!p || p.length > 3000 || !BUG_REPORT.test(p) || WANTS_PROPOSAL.test(p)) return '';
  const cwd = j.cwd || process.cwd();
  const archived = changeRoots(cwd).some((c) => { try { return fs.readdirSync(path.join(c, 'archive')).length > 0; } catch (e) { return false; } });
  let active = false;
  try { active = allChanges(cwd).length > 0; } catch (e) { active = false; }
  if (!archived && !active) return '';
  const trace = archived ? '先溯源——node "' + path.join(KIT, 'tools', 'trace.js') + '" <出问题的文件>[:行号]，找到当初的变更和任务，读它的 design、revisions 和现在的 openspec/specs/；' : '';
  return '这像是在做完的功能上发现的问题' + (archived ? '' : '（变更还没归档）') + '：' + trace + SMALL_FIX_TEXT;
}

// 技能改名（加了 ttls- 前缀）之前的名字也认：会话记录里可能还是旧的
const FLOW = /^(opsx:|openspec-|(ttls-)?onboard$|(ttls-)?see-page$|(ttls-)?cross-review$)/i;
const INTERRUPT = /\[Request interrupted by user/;
const isUser = (e) => e && e.type === 'user' && !e.isSidechain;
/** 用户真的说了一句话：不是自动附带的条目、不是工具结果、不是斜杠命令、不是打断标记 */
const isRealMsg = (e) => { if (!isUser(e) || e.isMeta) return false; const t = textOf(e).trim(); return !!t && t[0] !== '<' && !INTERRUPT.test(t); };

function commandOf(e) {
  if (!isUser(e)) return '';
  const t = textOf(e);
  const m = t.match(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/);
  if (!m || !FLOW.test(m[1])) return '';
  const a = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
  return '/' + m[1] + (a && a[1].trim() ? ' ' + a[1].trim().slice(0, 80) : '');
}

/** 末尾窗口里没找到流程指令时，回退到整份记录里从后往前找（只在刚被打断时才走这条路）。结果按文件大小缓存：打断后的几条消息不重复扫 */
function findCommandInWholeFile(file) {
  try {
    const size = fs.statSync(file).size;
    if (size > 50 * 1024 * 1024) return null;
    const cache = readState('anchor-scan');
    if (cache.file === file && cache.size === size) return cache.result || null;
    const result = scanWholeFile(file);
    writeState('anchor-scan', { file, size, result, at: Date.now() });
    return result;
  } catch (e) { return null; }
}
function scanWholeFile(file) {
  try {
    const buf = fs.readFileSync(file);
    let pos = buf.length;
    for (let guard = 0; guard < 200; guard++) {
      pos = buf.lastIndexOf('<command-name>', pos - 1);
      if (pos < 0) return null;
      const s = buf.lastIndexOf(0x0a, pos) + 1;
      let e = buf.indexOf(0x0a, pos); if (e < 0) e = buf.length;
      let entry; try { entry = JSON.parse(buf.toString('utf8', s, e)); } catch (err) { continue; }
      const cmd = commandOf(entry);
      if (!cmd) continue;
      // 这条指令之后用户说过几句话
      const rest = buf.toString('utf8', e).split('\n');
      let real = 0;
      for (const l of rest) { if (!l.trim()) continue; try { if (isRealMsg(JSON.parse(l))) real++; } catch (err) { /* 半截行 */ } }
      return { cmd, realAfter: real };
    }
  } catch (e) { /* 读不了就算了 */ }
  return null;
}

/**
 * 交接之后的新会话：刚写好的交接记录（一小时内、还没接过），用户点名要读（"按交接记录继续""读取 .vibe/handover.md"）时接上；
 *   一句"继续"不算，说别的不打扰。以前的 autoResume 开关（第一句话不管说什么都接上）2026-10-17 删掉了。
 * 这条路什么版本都通。写交接记录的那个老会话里用户再说话不算：会话里跑过 /ttls-handover（改名之前叫 /handover）、用 Skill 工具调过它、
 * 或者自己写过这份 handover.md 的都跳过。只接一次。
 */
const RESUME_WORDS = /继续|接着|接上|交接|上次|恢复|continue|resume/i;
function wroteHandover(entries, file) {
  const key = normKey(file);
  return entries.some((e) => {
    if (/<command-name>\s*\/?(ttls-)?handover\s*<\/command-name>/.test(textOf(e))) return true;
    const c = e && e.type === 'assistant' && e.message && e.message.content;
    if (!Array.isArray(c)) return false;
    return c.some((b) => b && b.type === 'tool_use' && ((b.name === 'Skill' && /^(ttls-)?handover$/i.test(String((b.input || {}).skill || (b.input || {}).command || '').replace(/^\//, ''))) || (/^(Write|Edit|MultiEdit)$/.test(b.name) && (b.input || {}).file_path && normKey(b.input.file_path) === key)));
  });
}
function handoverContinuation(j, cfg) {
  // 历史交接只在用户点名选择时读取；一句"继续"不借用旧记录。
  if (!/(?:读取|接着|恢复|使用|按)[^。！？\n]{0,36}(?:\.vibe[\\/]handover\.md|交接记录)|(?:交接记录|handover\.md)[^。！？\n]{0,20}(?:继续|接着|恢复)/i.test(intent.plain(j.prompt))) return '';
  try {
    let d = path.resolve(j.cwd || process.cwd());
    let file = '';
    for (let i = 0; i < 2; i++) { const f = path.join(d, '.vibe', 'handover.md'); if (fs.existsSync(f)) { file = f; break; } const up = path.dirname(d); if (up === d) break; d = up; }
    if (!file) return '';
    const m = fs.statSync(file).mtimeMs;
    const handoverKey = String(j.session_id || 'unknown') + '-manual-handover';
    const used = readState(handoverKey);
    if (used.file === file && used.mtime === m) return '';
    const stale = handoverStale(file, j.cwd || process.cwd());
    if (stale) hookLog('task-anchor 明确选择的交接记录已过时，需要核对当前事实');
    const entries = j.transcript_path ? tailEntries(j.transcript_path, 600000) : [];
    const auto = /接着上一个会话的交接记录继续/.test(String(j.prompt || ''));
    const resumeOn = false;
    // 关着"自动接着干"：用户没说要接着做，就不接、也不记成接过（一小时内他说"继续"照样接得上）
    if (intent.denied(j.prompt, 'apply')) return '';
    writeState(handoverKey, { file, mtime: m, at: Date.now() });
    hookLog('task-anchor handover ' + (auto ? 'auto message arrived' : 'continuation injected') + ' file=' + file);
    if (auto) return '';
    return '用户明确选择手动交接记录：' + file + (stale ? '。记录已过时：' + stale : '') + '。读取后核对 git status、tasks.md 与当前代码，先交代差异和待确认范围；旧记录不能授予 apply、提交、归档或 push。';
  } catch (e) { return ''; }
}

/**
 * 打断之后的锚点、进行中的变更、交接线。
 * 后台任务做完的通知（note）那一轮：不出打断提醒（用户按 Esc 叫停了，通知一到不能叫它回去接着 apply）、不带进度行、
 * 不重复交接线（收工检查会管），只在快到网关上限时说一次
 */
function anchorLines(j, cfg, note) {
    const lines = [];
    const entries = j.transcript_path ? tailEntries(j.transcript_path, 600000) : [];
    const users = entries.filter(isUser);
    const sid = String(j.session_id || 'unknown');

    if (!note) {
      // 从末尾往回看：在用户最近的三句话之内有没有打断标记
      let interruptIdx = -1;
      let realSince = 0;
      for (let i = users.length - 1; i >= 0 && realSince < 3; i--) {
        if (INTERRUPT.test(textOf(users[i]))) { interruptIdx = i; break; }
        if (isRealMsg(users[i])) realSince++;
        if (commandOf(users[i])) break;
      }

      let cmd = '';
      let between = -1;
      if (interruptIdx >= 0) {
        for (let i = interruptIdx - 1; i >= 0; i--) {
          const c = commandOf(users[i]);
          if (c) { cmd = c; between = users.slice(i + 1, interruptIdx).filter(isRealMsg).length; break; }
        }
        if (!cmd) {
          const f = findCommandInWholeFile(j.transcript_path);
          if (f) { cmd = f.cmd; between = Math.max(0, f.realAfter - realSince); }
        }
      }

      // 只看这个会话碰过的变更（改过、读过它的 tasks.md、话里点过名的）：壳子里 git pull 下来的同事的变更不算"进行中"
      const mine = sessionChanges(j.session_id, entries, activeChanges(j.cwd || process.cwd()), [String(j.prompt || '')]);
      const applyDone = /^\/(opsx:apply|openspec-apply)/i.test(cmd) && mine.length === 0;
      if (cmd && !applyDone && between >= 0 && between <= 2) {
        const name = cmd.split(' ')[0];
        if (between === 0) lines.push('你刚才在执行 ' + cmd + '，中途被我打断了。先回应我这条消息；除非我明确说要换任务或者停下，回应完就回到 ' + name + ' 的步骤接着做，严格按它的流程来。做到哪一步拿不准，就重新查（openspec status、读 tasks.md、看 git status），不要凭印象。');
        else lines.push('最近一条流程指令是 ' + cmd + '，之后我打断过你。刚才被打断时如果它还没做完，回应完接着按 ' + name + ' 的步骤做，拿不准做到哪就重新查，不要凭印象；如果它已经做完，就只管我现在说的事，不要回头重跑。');
      }

      if (mine.length) {
        const c = mine[0];
        let s = '进行中的 OpenSpec 变更：' + c.name + '，任务 ' + c.done + '/' + c.total + (c.next ? '，下一项：' + c.next : '');
        if (mine.length > 1) s += '（另有 ' + (mine.length - 1) + ' 个没做完：' + mine.slice(1, 4).map((x) => x.name).join('、') + '）';
        // 还没开工的变更，提案没审过：每条消息带一句，直到审了
        if (cfg.autoMode && cfg.specGate !== false && c.done === 0 && !require('../lib/session').reviewAllowed('proposal', c.dir)) s += '。这个提案还没审过：apply 之前先按 /ttls-cross-review 的提案模式审一遍（审查提示第一行写"模式：提案"，写上变更名）';
        lines.push(s);
      }
    }
    // 交接线
    // 用了多少取状态栏刚记下的数（没有就自己从会话记录里算）；百分比按**现在的**配置重算，
    // 这样在配置页里改了上下文上限、交接线，下一条消息就按新值来，不用等状态栏刷新，更不用重开会话
    const st = readState(j.session_id);
    const fresh = !!st.at && Date.now() - st.at < 6 * 3600000;
    const used = (fresh && st.used) || lastUsageTokens(entries);
    let overLine = false;
    if (used && cfg.contextStrategy === 'handover') {
      const pct = Math.round(contextPercent(used, fresh ? st.windowSize : 0, cfg).pct);
      const line = Number(cfg.handoverPercent) || 70;
      const gw = nearGatewayLimit(used);
      const hk = sid + '-handover';
      const asked = readState(hk);
      const declined = asked.askedAtPct != null && pct < asked.askedAtPct + 10;
      if (gw) {
        if (!note || !asked.gwNoted) {
          overLine = true;
          lines.push('这个会话的请求快到内网网关能接受的大小了：上次大约 ' + Math.round(gw.limitTokens / 10000) + ' 万 token 时被网关直接拒绝，那是硬限制，撞上了这个会话就发不出去了。现在就执行 /ttls-handover 写交接记录，然后' + (cfg.autoMode ? '停下（全自动模式也得停：这个会话发不出去了）' : '提醒我开新会话') + '。');
          if (note) writeState(hk, Object.assign({}, asked, { gwNoted: true, at: Date.now() }));
        }
      } else if (pct >= line && !note) {
        overLine = !declined;
        if (cfg.autoMode) {
          // 全自动：每涨 10 个百分点说一次（收工检查也按这个记录，写过交接记录的不再催）
          if (asked.autoAtPct == null || pct >= asked.autoAtPct + 10) {
            lines.push(cfg.autoHandover !== false
              ? '上下文已经用了 ' + pct + '%，过了交接线。全自动模式：先执行 /ttls-handover 写一份交接记录（万一会话断了能接上），写完继续做，不要停下等我。'
              : '上下文已经用了 ' + pct + '%，过了交接线。全自动模式：继续做，不用写交接记录（靠 Claude Code 自己的压缩），不要停下等我。');
            writeState(hk, Object.assign({}, asked, { autoAtPct: pct, at: Date.now() }));
          }
        }
        else if (declined) lines.push('上下文已经用了 ' + pct + '%，过了交接线。我说过再做一会儿：接着做我说的事，到 ' + (asked.askedAtPct + 10) + '% 会再问我要不要交接。');
        // 和收工检查说法一致：开着"到线问一句"的，收工时会让它用提问框问我，不叫它自己先交接
        else if ((cfg.handoverAsk || 'off') !== 'off') lines.push('上下文已经用了 ' + pct + '%，过了公司规定的交接线。做完手头这一小步就收工，收工时会让你用提问框问我要不要交接（我选交接就执行 /ttls-handover）；新的大任务留到新会话里做。');
        // 开关选了"不问，只提醒"：只说一句，不让它自己写交接记录（用户 2026-10-07：没让交接就不要交接）
        else lines.push('上下文已经用了 ' + pct + '%，过了公司规定的交接线。我没让你交接就不要交接，接着做我说的事；要交接我会说（/ttls-handover）。新的大任务留到新会话里做。');
      }
    }
    lines.overLine = overLine && !cfg.autoMode;
    return lines;
}

/** 会话自动模式开了：送一次怎么做（问题表第 28 条，用户 2026-10-31 定的）。不写进每个请求都带的全局约定（硬规矩 8） */
const AUTO_ON_TEXT = '这个会话的自动模式开了（用户刚打开的，只对这个会话）。先把探索做完：读相关代码和现状，和用户确认目标、范围、验收标准和疑问，写评估并用 workflow.js qualify 过了才开始自动；'
  + '之后自动逐份写需求文档、审修、定稿、开工，每整组任务做完先审查、按验收用例自测、修改、复验，再做下一组，按提交方式提交，收工交报告。'
  + '只做用户的描述和材料里有的，不自己加需求（"这里加个按钮更好"这种不加）；做法上的取舍自己定，记进 revisions.md（起因：自动模式决定），不停下来问；'
  + '用户中途报的问题、改的需求照改，记进 revisions.md，接着自动做。只有用户的描述或材料让你完全走不下去时，先自己探索，还不行再问。归档、push 照旧要用户点头；改库、写 redis 照技能里全自动的规矩（留得下备份的工具会说不用等人，别的留给用户）。';
const AUTO_OFF_TEXT = '这个会话的自动模式关了（用户刚说的）：照人工来，审查、自测、复验先问用户。';
async function handle(j) {
  // 用户开、关这个会话的自动模式（/vk-auto、"这个需求自动做"、"别自动了"）：先记下，下面按新的开关算。后台任务的通知不算用户的话
  let autoSaid = '';
  if (!isTaskNotePrompt(j.prompt)) {
    try { const S0 = require('../lib/session'); autoSaid = S0.autoSwitchSaid(j.prompt); if (autoSaid) { S0.setSessionAuto(j, autoSaid === 'on', String(j.prompt || '').slice(0, 120)); S0.hookLog('自动模式 会话 ' + j.session_id + (autoSaid === 'on' ? ' 用户打开了' : ' 用户关了')); } else if (S0.touchSessionAuto) S0.touchSessionAuto(j); } catch (e) { autoSaid = ''; }
    // /vk-auto 后面带着的话（"/vk-auto 做一个订单导出"）当成这一句话本身：照它认需求、定流程。开关词和 autoSwitchSaid 一个口径
    const m = /^\s*\/vk-auto(?:\s+(?:on|off|开启|关闭|关掉|开|关)(?=\s|$))?\s*([\s\S]*)$/i.exec(String(j.prompt || ''));
    if (m && m[1].trim()) j = Object.assign({}, j, { prompt: m[1].trim() });
  }
  const cfg = readConfig(j);
  // 记下这个会话在哪个目录、会话记录在哪：记问题反馈的工具（tools/feedback.js）拿不到会话号，靠这个找
  try { require('../lib/feedback.js').noteSession(j); } catch (e) { /* 记不了不影响对话 */ }
  // 下面都是项目级的事（探索、进行中的变更、交接记录）：照会话的启动目录来，不照现在所在的目录（模型单独 cd 过就变了）
  j = atHome(j);
  // 该检查更新了、或者有还没上报的问题：甩一个后台进程去做（只看一眼状态文件，不等它）
  try { require('../lib/updater.js').kick('用户开口'); } catch (e) { /* 老版本没有，或者甩不出去：不影响对话 */ }
  // 后台任务做完的通知（审查结论这类，2.1.259 起 Agent 默认在后台跑）也会走到这里，但它不是用户说的话：
  // 不当需求、不当"接着交接"、不按消息里的词给提醒、不重记产物指纹；先把它带来的审查结论记上，下面"提案还没审过"才不会说错
  const note = isTaskNotePrompt(j.prompt);
  if (!note) { try { require('../lib/permissions').capture(j); } catch (e) { /* 记录失败由执行入口重新核对 */ } }
  // 接上刚写的交接记录（新会话里说"继续"、或者自动发来的那句）：放在定流程之前，接上了就算在流程里
  const ho = note ? '' : handoverContinuation(j, cfg);
  const resumed = !!ho;
  // 全自动模式只在走 OpenSpec 流程时算开着：这句话算不算，在这里定。不算的话下面都照有人在的样子来。
  // 开关关着也定、也记：这一轮做到一半才在配置页打开全自动的，别的钩子照这一轮开头定的算
  cfg.autoSwitch = cfg.autoApply || cfg.autoRequirements;
  // 上一轮在不在流程里（装这一版之前就开着的会话先照以前的算法接过来，和 decideFlow 里一样）：数"进流程"、定要不要拉代码用
  let prevOn = false;
  try { let st = flowState(j); if (st.at === undefined && cfg.autoSwitch) st = flowAdopt(j); prevOn = !!st.on; } catch (e) { prevOn = false; }
  let on = false;
  // cont：这句话是"继续""不要停"这类，接回原来的流程（中间插过一句问话的也算）——不是新开工
  let cont = false;
  let stage = 'plan';
  let applyStart = false;
  try { const d = decideFlow(j, cfg, note, resumed); on = d.on; cont = d.cont; stage = d.stage; applyStart = d.applyStart; } catch (e) { on = false; }
  // 全自动只在做任务那一段（apply）算开着；写提案那一段用户在
  cfg.autoMode = require('../lib/session').flowView(j).effective;
  // 用户开口了：全自动报告新开一轮（后台任务的通知不算用户开口）
  // 只剩用户验收时自动已不生效，但这一轮的报告也要从头记（2026-10-17：任务全做完、审过就算等用户验收）
  if (!note && (cfg.autoMode || require('../lib/session').flowView(j).awaitingUser)) { try { require('../lib/report.js').begin(j); } catch (e) { /* 老版本没有，或者记不了：不影响对话 */ } }
  if (applyStart) {
    try { const named = allChanges(j.cwd).filter((c) => mentionsChange(j.prompt, c.name)); const targets = named.length ? named : allChanges(j.cwd); if (targets.length === 1 || named.length) require('../lib/review-runner').baseline(j, targets.map((c) => c.dir)); } catch (e) { /* 基线未知时审查明确要求 --base */ }
  }
  const said = String(j.prompt || '').trim();
  if (!note && planIntent(said)) { require('../lib/session').updateState(String(j.session_id) + '-flow', s => { s.planReady = false; s.waiting = ''; s.explorationAt = Date.now(); }); cfg.autoMode = false; }
  // 使用情况：开口、进流程、接着交接记录做、写交接记录各几次（只数次数）
  if (!note) {
    try {
      const U = require('../lib/usage.js');
      U.bump('prompt');
      if (on && !prevOn && !cont) U.bump('flow.enter');
      if (applyStart) U.bump('flow.apply');
      if (resumed) U.bump('handover.resume');
      if (/^\s*\/(ttls-)?handover(\s|$)/i.test(said)) U.bump('handover.write');
    } catch (e) { /* 数不了不影响对话 */ }
  }
  // 开工前不再自动拉代码（用户 2026-10-17 定的：交给用户自己拉）
  if (note && j.transcript_path) { try { syncReviews(tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain), j.cwd || process.cwd()); } catch (e) { /* 记不了不影响对话 */ } }
  // 用户自己在发新指令（斜杠命令）：不提打断和进度
  const slash = /^\s*\//.test(String(j.prompt || ''));
  const anchored = slash ? [] : anchorLines(j, cfg, note);
  const lines = [...anchored];
  if (autoSaid === 'on') lines.unshift(AUTO_ON_TEXT);
  else if (autoSaid === 'off') lines.unshift(AUTO_OFF_TEXT);
  if (!note && on && stage === 'plan' && cfg.autoRequirements && !flowState(j).planReady) lines.push('自动模式开着，但先探索并沟通目标、范围、验收与疑问；条件明确后把 description、scope、acceptance、unresolved（未解问题数组）、onlyPlan 写入本机 .vibe/tmp/<事由>/评估.json，再运行 workflow.js qualify --session ' + j.session_id + ' --transcript <当前会话记录> --assessment <评估文件>。有疑问必须 Ask，不能因为开关开启而猜需求。');
  if (!note) { try { const conflicts = require('../lib/work-sessions').touch(j); if (conflicts.length) lines.push('同一变更还有活跃实施会话：' + conflicts.join('、') + '。先核对各自负责的文件，避免覆盖；检索照常。共享工作区未被隔离。'); } catch (e) { /* 冲突记录失败不阻断工作 */ } }
  // 放松保护的开关被绕开配置页改了：没按它来，告诉它；每个会话记一次问题反馈
  if (cfg._tampered) {
    lines.unshift('套件开关文件被程序直接改过（' + cfg._tampered.join('、') + '），没按它来：这几项只认用户在配置页里改的。');
    const tk = String(j.session_id || 'unknown') + '-tamper';
    if (!readState(tk).at) {
      writeState(tk, { at: Date.now() });
      try { const fb = require('../lib/feedback.js'); fb.record({ kind: '篡改', hook: '套件开关', source: '钩子自动记录', title: '套件开关文件被绕开配置页改了：' + cfg._tampered.join('、'), what: 'config.json 里放松了保护（' + cfg._tampered.join('、') + '），封条里没有：不是配置页、安装器改的。钩子按安全的值算了。', sig: fb.sigOf(['tamper', cfg._tampered.join(',')]), sid: j.session_id, cwd: j.cwd, transcript: j.transcript_path }); } catch (e) { /* 记不了不影响对话 */ }
    }
  }
  if (ho) lines.unshift(ho);
  // 会话开着的时候装了新版、配置页改了开关：把变了的约定和技能带给它，不用 /clear（斜杠命令也带）
  const cn = convUpdateNotice(j);
  if (cn) lines.unshift(cn);
  // 查库、查 redis 的工具自己报的毛病（脚本崩了、找不到驱动）：读进来记成问题反馈；用量累计起来
  try { require('../lib/toolstats.js').ingest(j); } catch (e) { /* 读不了不影响对话 */ }
  // 后台自动探索：依据的文件改了就再探索一次；探索好了、更新了的，带给它（每条只说一次）
  if (!note) {
    try { const ob = require('../lib/onboard.js'); ob.kick(j.cwd || process.cwd(), '用户开口'); ob.waitFresh(j.cwd || process.cwd(), 1500); const on = ob.noticeFor(j); if (on) lines.unshift(on); } catch (e) { /* 探索的事不影响对话 */ }
  }
  // 钩子走 HTTP 时的自检：上一轮改过文件、跑过命令，路由却没收到钩子调用 → 拉起路由，或者切回命令方式
  try { const hh = await hookHealth(j, cfg); if (hh) lines.unshift(hh); } catch (e) { /* 自检失败不影响对话 */ }
  // 报的是做完的功能上的问题：先溯源再修（这时就不提"先探索再提案"，修 bug 不用提案）
  const th = note ? '' : traceHint(j, cfg);
  let rhSent = false;
  if (cfg.specGate !== false && !note) {
    // 用户开口这一刻，把各个变更产物的指纹记下来：收工时比对，改了产物没在 revisions.md 记录就拦
    writeState(String(j.session_id || 'unknown') + '-artifacts', { at: Date.now(), files: snapshotArtifacts(j.cwd || process.cwd()) });
    // 过了交接线还提新需求：不再提"先探索再提案"，新需求留给新会话
    const rh = slash || anchored.overLine || th ? '' : requirementHint(j, cfg);
    rhSent = !!rh;
    if (rh) {
      lines.push(rh);
      // 提需求的时刻：写提案时"先探索再提案"只认这之后的探索（会话里更早读过的不相干的文件不算）
      writeState(String(j.session_id || 'unknown') + '-requirement', { at: Date.now() });
    }
  }
  if (th) lines.push(th);
  if (!note && intent.explicit(j.prompt, 'push')) {
    // 推送怎么做（用户 2026-10-25 定的，问题反馈表第 5 条）：说了推送就直接推。套件的合并推送工具 2026-10-28 去掉了（用户定的）；
    // 用户自己说要合并的，照他说的用 git 合并没推的提交再推，不拦（用户 2026-10-28 补充）
    if (intent.mergeIntent(j.prompt)) lines.push('[vibe-kit 推送] 用户要把没推的提交合并了再推：照他说的用 git 自己合（例：git -C <仓库> reset --soft <远端分支>，再 git commit 写一条概括的说明；或者 git rebase），合完直接 git push，不用推送计划、不再问确认。只动还没推上去的提交，不 force、不删远端分支、不推到别的分支；套件不再有合并推送的工具。');
    // 20261030 起 push 只留套件这一道确认（用户定的），settings 里不再有 Bash(git push:*) 的确认规则：写 git push 就行，不用为了躲确认框改写成 git -C
    else lines.push('[vibe-kit 推送] 用户说了推送：直接 git push，几笔提交都一样，不用推送计划、不再问确认；壳子里几个子项目有没推的提交，用 git -C <子项目> push 各推一次。不 force、不删远端分支、不推到别的分支。');
  }
  const oh = note || anchored.overLine ? '' : outputHint(j, cfg);
  if (oh) lines.push(oh);
  // 开工了：告诉用户这次全自动开没开（systemMessage 给人看，additionalContext 给模型）
  const notice = applyStart ? applyNotice(cfg) : null;
  // 规矩提前说：开工时送做任务这一段的；提需求、敲 /opsx:propose、explore、new、continue 时送写需求这一段的
  try {
    const sr = applyStart ? stageRules(j, 'apply') : (rhSent || /^\s*\/(?:opsx:|openspec-)(?:propose|explore|new|continue)\b/i.test(String(j.prompt || ''))) ? stageRules(j, 'plan') : '';
    if (sr) lines.push(sr);
  } catch (e) { /* 送不了不影响开口 */ }
  if (notice) lines.unshift(notice.model);
  const text = lines.length ? '[vibe-kit 提醒] ' + lines.join('\n') + '\n' : null;
  if (notice) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text }, systemMessage: notice.user };
  return text;
}

module.exports = { handle };
if (require.main === module) cli(handle);

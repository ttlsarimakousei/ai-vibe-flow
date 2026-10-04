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
 *   上下文用量过了交接线（公司规定 70%），每条消息带一句"该交接了"。用量取状态栏刚记下的数，没有就自己从会话记录里算。
 *   全自动模式开着时，这句话算不算在走 OpenSpec 流程，在这里定（decideFlow）：不算的话这一轮照有人在的样子来。
 *   这句话让会话进了流程（要开始分析需求、写代码了）：先拉一次代码（lib/pull.js，开关 pullBeforeWork）。
 */
const fs = require('fs');
const path = require('path');
const { atHome, FLOW_SLASH, FLOW_TAG, flowState, flowAdopt, setFlow, flowTouch, mentionsChange, activeChanges, allChanges, tailEntries, textOf, lastUsageTokens, readConfig, contextPercent, nearGatewayLimit, readState, writeState, hookLog, snapshotArtifacts, normKey, handoverStale, convUpdateNotice, proposalReviewed, changeRoots, isTaskNotePrompt, syncReviews, sessionChanges, KIT, cli } = require('../lib/session');
let hookHealth = () => '';
try { hookHealth = require('../lib/hook-health.js').check; } catch (e) { /* 老版本没有 */ }

/**
 * 用户提了一条需求（不是问句、不是斜杠命令）：提醒它先探索再提案，别凭印象直接写提案或改代码。
 * 判断只看用词，宁可多提醒一句也不漏：提醒的话里已经说明了不用提案的小改动直接改。开关 specGate。
 */
const NEED = /(需求|功能|想要|想做|要做|做一个|做个|加一个|加个|新增|新建|新做|实现|支持|改成|改为|改造|重做|优化|重构|增加|开发|页面|接口|导出|导入|报表|统计|集成|对接)/;
const QUESTION = /(为什么|为啥|是什么|什么意思|怎么看|怎么理解|吗[？?]?$|[？?]$|解释|说明一下|看看|看一下|查一下|查查|检查|核对|对比)/;
const SMALL_TALK = /^(继续|好|好的|嗯|行|可以|ok|okay|不用|不要|停|等等|谢谢)/i;
/** 这句话像不像一条需求（不是问句、不是闲话、不是斜杠命令） */
function looksLikeRequirement(p) {
  if (!p || p.length < 6 || p.length > 3000 || /^\s*\//.test(p) || SMALL_TALK.test(p) || QUESTION.test(p) || !NEED.test(p)) return false;
  return !/接着上一个会话的交接记录继续/.test(p);
}
/**
 * 全自动模式开着时，这句话算不算在走 OpenSpec 流程（规矩见 lib/session.js"全自动模式只在走 OpenSpec 流程时算开着"）。
 * 定下来记进 state/<会话>-flow.json，别的钩子照着它算 autoMode。resumed：这句话接上了一份刚写的交接记录
 */
const CONTINUE_WORDS = /^(继续|接着|接着做|继续做|往下做|下一步|好|好的|嗯|行|可以|ok|okay|go on|continue|next|做吧|开始吧)[\s。！!，,.~～]*$/i;
const STOP_WORDS = /^(停|先停|暂停|等等|等一下|不用|不要|别|stop)/i;
// 流程里会用到的那几个技能（审查、看页面、交接）：用户自己敲它们，不算进流程也不算出流程，跟上一轮一样
const SAME_SLASH = /^\s*\/(ttls-)?(cross-review|see-page|handover)(\s|$)/i;
function decideFlow(j, cfg, note, resumed) {
  let prev = flowState(j);
  // 装这一版之前就开着的会话头一回开口：先照以前的算法接过来（它动过变更就算在流程里），"继续"才接得上
  if (prev.at === undefined && cfg.autoSwitch) prev = flowAdopt(j);
  // 后台任务做完的通知不是用户说的话：跟原来一样
  if (note) return !!prev.on;
  const p = String(j.prompt || '').trim();
  let named = [];
  // 点了名的变更：没归档的都算。任务全打了勾、等着复审和归档的也是流程里的事（"接着做：复审 a1 的代码，没问题就归档"）
  try { named = allChanges(j.cwd || process.cwd()).filter((c) => mentionsChange(p, c.name)); } catch (e) { named = []; }
  let on = false;
  let why = '';
  if (FLOW_SLASH.test(p) || FLOW_TAG.test(p)) { on = true; why = '敲了 OpenSpec 的命令'; }
  else if (SAME_SLASH.test(p)) { on = !!prev.on; why = on ? '接着上一轮' : ''; }
  // 别的斜杠命令（/ttls-onboard、自己的命令）：这一轮做的是那件事，不在流程里（议题 #9）
  else if (/^\s*\//.test(p)) { on = false; }
  else if (resumed || /接着上一个会话的交接记录继续/.test(p)) { on = true; why = '接着交接记录做'; }
  else if (STOP_WORDS.test(p)) { on = false; }
  // "继续"：上一轮在流程里就接着；上一轮只是插进来问了一句的，跟再上一轮（一天之内）
  else if (CONTINUE_WORDS.test(p)) { on = !!prev.on || (!!prev.was && Date.now() - prev.was < 86400000); why = on ? '接着上一轮' : ''; }
  // 问句只回答：这一轮不在流程里（说"继续"就接回去）
  else if (QUESTION.test(p)) { on = false; }
  // 正在流程里，又说了一句不是问句的话（"3.3 我执行过了，接着归档""字段名不对，应该是 X"）：还在流程里
  else if (prev.on) { on = true; why = '接着上一轮'; }
  else if (looksLikeRequirement(p)) { on = true; why = '提了需求'; }
  else if (named.length && p.length <= 3000) { on = true; why = '点了变更 ' + named[0].name; }
  setFlow(j, on, why);
  if (on) for (const c of named) flowTouch(j, c.dir);
  if (cfg.autoSwitch && !!prev.on !== on) hookLog('全自动模式 ' + (on ? '这个会话进了 OpenSpec 流程：' + why : '这一轮不在 OpenSpec 流程里，照有人在的样子来'));
  return on;
}
function requirementHint(j, cfg) {
  const p = String(j.prompt || '').trim();
  if (!looksLikeRequirement(p)) return '';
  if (cfg && cfg.autoMode) return '这像一条需求。全自动模式：要走提案的（新功能、改行为、改接口、改表结构）先探索再提案——用 /opsx:explore 的方式读会碰到的代码、表结构、接口、配置，把现状写进设计的 Context，然后不用等我确认，直接 /opsx:propose → 审提案 → apply → 审代码 → 归档，一路做完再交代。不用提案的小改动直接改。';
  return '这像一条需求。要走提案的（新功能、改行为、改接口、改表结构）先探索再提案：用 /opsx:explore 的方式在项目里读会碰到的代码、表结构（有查库的技能就用它）、接口、配置，把现状写下来（读了什么、发现什么、和需求对不上的地方、还不知道什么）给我看，我确认了范围再 /opsx:propose；不要凭印象直接写提案或改代码。不用提案的小改动直接改。';
}

/**
 * 这句话要的东西里像是有代码之外的产出（DDL、说明文档、分析报告、表格）：开工前先定好放哪。
 * 写文件那一刻钩子（guard-output）还会查一次，这里是让它在动手之前就想到，别写完了才被拦。开关 outputGate
 */
const OUTPUT_NOUN = /(ddl|建表|sql\s*脚本|报告|说明文档|功能说明|设计文档|接口文档|操作手册|使用手册|手册|纪要|清单|excel|xlsx|word|docx|表格|文档)/i;
const OUTPUT_VERB = /(写|出|生成|整理|做|输出|导出|给我|弄|起草|编)/;
function outputHint(j, cfg) {
  if (!cfg || cfg.outputGate === false) return '';
  const p = String(j.prompt || '').trim();
  if (!p || p.length > 3000 || !OUTPUT_NOUN.test(p) || !OUTPUT_VERB.test(p)) return '';
  if (cfg.autoMode) return '这次要是会产出代码之外的文件（DDL 脚本、说明文档、分析报告、表格……）：项目说明的"产出位置"里有的照着放；没有的先放 .vibe/pending/，最后交代时列进"等你回来定的事"，不要自己挑地方。';
  return '这次要是会产出代码之外的文件（DDL 脚本、说明文档、分析报告、表格……），开工前先定好放哪：项目说明的"产出位置"里有的照着放；没有的现在就用提问框问我，选项写实际目录，定了记进项目说明，别等写完了才问。';
}

/**
 * 这句话像是在报已有功能的问题（测试发现、用户反馈、报错）：而项目里有归档过的变更，就提醒先溯源再修。开关 specGate
 */
const BUG_REPORT = /(测试|验收|用户|客户|现场|联调)[^。！？\n]{0,12}(发现|反馈|报|说)|bug|缺陷|报错|有问题|出问题/i;
function traceHint(j, cfg) {
  if (!cfg || cfg.specGate === false) return '';
  const p = String(j.prompt || '');
  if (!p || p.length > 3000 || !BUG_REPORT.test(p)) return '';
  const archived = changeRoots(j.cwd || process.cwd()).some((c) => { try { return fs.readdirSync(path.join(c, 'archive')).length > 0; } catch (e) { return false; } });
  if (!archived) return '';
  return '这像是在做完的功能上发现的问题：先溯源再修——node "' + path.join(KIT, 'tools', 'trace.js') + '" <出问题的文件>[:行号]，找到当初的变更和任务，读它的 design、revisions 和现在的 openspec/specs/，再按它最后一行说的分类处理（代码没做到规格就直接修，规格本身漏了就新开变更）。';
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
 * 交接之后的新会话：刚写好的交接记录（一小时内、还没接过），用户在新会话里开口时把交接记录接上。
 *   开关 autoResume 开着：第一句话不管说什么都接上（SessionStart 那句 initialUserMessage 有没有真的发出去都行）；
 *   关着（默认，老版本的 Claude Code 不认 initialUserMessage）：用户说"继续""接着做""按交接记录"这类话才接上，说别的不打扰，一小时内说都算。
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
  try {
    let d = path.resolve(j.cwd || process.cwd());
    let file = '';
    for (let i = 0; i < 2; i++) { const f = path.join(d, '.vibe', 'handover.md'); if (fs.existsSync(f)) { file = f; break; } const up = path.dirname(d); if (up === d) break; d = up; }
    if (!file) return '';
    const m = fs.statSync(file).mtimeMs;
    if (Date.now() - m > 60 * 60000) return '';
    const used = readState('handover-consumed');
    if (used.file === file && used.mtime === m) return '';
    const stale = handoverStale(file, j.cwd || process.cwd());
    if (stale) { writeState('handover-consumed', { file, mtime: m, at: Date.now(), stale }); hookLog('task-anchor handover stale: ' + stale); return ''; }
    const entries = j.transcript_path ? tailEntries(j.transcript_path, 600000) : [];
    if (wroteHandover(entries, file)) return '';
    const auto = /接着上一个会话的交接记录继续/.test(String(j.prompt || ''));
    const resumeOn = !!(cfg && cfg.autoResume === true);
    // 关着"自动接着干"：用户没说要接着做，就不接、也不记成接过（一小时内他说"继续"照样接得上）
    if (!auto && !resumeOn && !RESUME_WORDS.test(String(j.prompt || ''))) return '';
    writeState('handover-consumed', { file, mtime: m, at: Date.now() });
    hookLog('task-anchor handover ' + (auto ? 'auto message arrived' : 'continuation injected') + ' file=' + file);
    if (auto) return '';
    return '上一个会话刚写了交接记录：' + file + '。先读它，用 git status、tasks.md 核对实际状态，然后按里面的"下一步"接着做。' + (resumeOn ? '我这句话如果是另一件事，就先做我说的，做完再回到交接记录。' : '');
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
        if (cfg.specGate !== false && c.done === 0 && !proposalReviewed(c.dir)) s += '。这个提案还没审过：apply 之前先按 /ttls-cross-review 的提案模式审一遍（审查提示第一行写"模式：提案"，写上变更名）';
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
    if (used) {
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
        else if ((cfg.handoverAsk || 'ask') !== 'off') lines.push('上下文已经用了 ' + pct + '%，过了公司规定的交接线。做完手头这一小步就收工，收工时会让你用提问框问我要不要交接（我选交接就执行 /ttls-handover）；新的大任务留到新会话里做。');
        else lines.push('上下文已经用了 ' + pct + '%，过了公司规定的交接线。做完手头这一小步就执行 /ttls-handover 写交接记录，然后提醒我开新会话；新的大任务留到新会话里做。');
      }
    }
    lines.overLine = overLine && !cfg.autoMode;
    return lines;
}

async function handle(j) {
  const cfg = readConfig();
  // 记下这个会话在哪个目录、会话记录在哪：记问题反馈的工具（tools/feedback.js）拿不到会话号，靠这个找
  try { require('../lib/feedback.js').noteSession(j); } catch (e) { /* 记不了不影响对话 */ }
  // 下面都是项目级的事（探索、进行中的变更、交接记录）：照会话的启动目录来，不照现在所在的目录（模型单独 cd 过就变了）
  j = atHome(j);
  // 该检查更新了、或者有还没上报的问题：甩一个后台进程去做（只看一眼状态文件，不等它）
  try { require('../lib/updater.js').kick('用户开口'); } catch (e) { /* 老版本没有，或者甩不出去：不影响对话 */ }
  // 后台任务做完的通知（审查结论这类，2.1.259 起 Agent 默认在后台跑）也会走到这里，但它不是用户说的话：
  // 不当需求、不当"接着交接"、不按消息里的词给提醒、不重记产物指纹；先把它带来的审查结论记上，下面"提案还没审过"才不会说错
  const note = isTaskNotePrompt(j.prompt);
  // 接上刚写的交接记录（新会话里说"继续"、或者自动发来的那句）：放在定流程之前，接上了就算在流程里
  const ho = note ? '' : handoverContinuation(j, cfg);
  const resumed = !!ho || (!note && /接着上一个会话的交接记录继续/.test(String(j.prompt || '')));
  // 全自动模式只在走 OpenSpec 流程时算开着：这句话算不算，在这里定。不算的话下面都照有人在的样子来。
  // 开关关着也定、也记：这一轮做到一半才在配置页打开全自动的，别的钩子照这一轮开头定的算
  cfg.autoSwitch = cfg.autoMode === true;
  // 上一轮在不在流程里（装这一版之前就开着的会话先照以前的算法接过来，和 decideFlow 里一样）：数"进流程"、定要不要拉代码用
  let prevOn = false;
  try { let st = flowState(j); if (st.at === undefined && cfg.autoSwitch) st = flowAdopt(j); prevOn = !!st.on; } catch (e) { prevOn = false; }
  let on = false;
  try { on = decideFlow(j, cfg, note, resumed); } catch (e) { on = false; }
  cfg.autoMode = cfg.autoSwitch && on;
  // 用户开口了：全自动报告新开一轮（后台任务的通知不算用户开口）
  if (!note && cfg.autoMode) { try { require('../lib/report.js').begin(j); } catch (e) { /* 老版本没有，或者记不了：不影响对话 */ } }
  const said = String(j.prompt || '').trim();
  // 使用情况：开口、进流程、接着交接记录做、写交接记录各几次（只数次数）
  if (!note) {
    try {
      const U = require('../lib/usage.js');
      U.bump('prompt');
      if (on && !prevOn) U.bump('flow.enter');
      if (resumed) U.bump('handover.resume');
      if (/^\s*\/(ttls-)?handover(\s|$)/i.test(said)) U.bump('handover.write');
    } catch (e) { /* 数不了不影响对话 */ }
  }
  // 写代码之前先拉代码：这句话让会话进了流程（提了需求、敲了 /opsx:…、接着交接记录做）才拉；已经在流程里说"继续"不拉。
  // 同一个仓库 2 小时里只拉一次（lib/pull.js）
  let pulled = '';
  if (!note && on && cfg.pullBeforeWork !== false && (!prevOn || FLOW_SLASH.test(said) || FLOW_TAG.test(said) || resumed || looksLikeRequirement(said))) {
    try { const r = await require('../lib/pull.js').beforeWork(j, cfg); if (r && r.text) pulled = r.text; } catch (e) { /* 拉不了不影响对话 */ }
  }
  if (note && j.transcript_path) { try { syncReviews(tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain), j.cwd || process.cwd()); } catch (e) { /* 记不了不影响对话 */ } }
  // 用户自己在发新指令（斜杠命令）：不提打断和进度
  const slash = /^\s*\//.test(String(j.prompt || ''));
  const anchored = slash ? [] : anchorLines(j, cfg, note);
  const lines = [...anchored];
  if (pulled) lines.push(pulled);
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
  if (cfg.specGate !== false && !note) {
    // 用户开口这一刻，把各个变更产物的指纹记下来：收工时比对，改了产物没在 revisions.md 记录就拦
    writeState(String(j.session_id || 'unknown') + '-artifacts', { at: Date.now(), files: snapshotArtifacts(j.cwd || process.cwd()) });
    // 过了交接线还提新需求：不再提"先探索再提案"，新需求留给新会话
    const rh = slash || anchored.overLine || th ? '' : requirementHint(j, cfg);
    if (rh) {
      lines.push(rh);
      // 提需求的时刻：写提案时"先探索再提案"只认这之后的探索（会话里更早读过的不相干的文件不算）
      writeState(String(j.session_id || 'unknown') + '-requirement', { at: Date.now() });
    }
  }
  if (th) lines.push(th);
  const oh = note || anchored.overLine ? '' : outputHint(j, cfg);
  if (oh) lines.push(oh);
  return lines.length ? '[vibe-kit 提醒] ' + lines.join('\n') + '\n' : null;
}

module.exports = { handle };
if (require.main === module) cli(handle);

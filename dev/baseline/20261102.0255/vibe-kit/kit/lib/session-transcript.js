'use strict';
/*
 * 读会话记录：最后一段（找不到用户开口往前再读）、正文、工具调用和结果、用户开口、上下文用量和自动压缩线、网关上限。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const { KIT, readState, updateState, normKey } = require('./session-state');

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
  return require('./invocation').memo('transcript|' + file + '|' + (maxBytes || 400000), () => tailEntriesRaw(file, maxBytes));
}

/**
 * 读到的这一段里一句用户开口都没有（这一轮工具输出很大，用户那句话在更前面）、文件还有更早的：往前再读，翻倍，最多 32 MB（审核 P14）。
 * 以前读不到就当用户没说，提交、推送、审查都拦下要再说一遍
 */
const TAIL_MAX = 32 * 1024 * 1024;

function tailEntriesRaw(file, maxBytes) {
  require('./invocation').phase('读取会话记录');
  try {
    const st = fs.statSync(file);
    const base = maxBytes || 400000;
    let want = base;
    const wide = base >= 1000000;
    // 上次往前找到用户那句话的位置（复审 V13）：记着它，下次直接从那一行读，不用每次钩子都翻倍重读到 32 MB
    const vkey = normKey(file);
    let known = null;
    if (wide && st.size > want) { try { const v = readState('voice-pos')[vkey]; if (v && v.offset >= 0 && v.size <= st.size && st.size - v.offset > want && st.size - v.offset <= TAIL_MAX) known = v; } catch (e) { known = null; } }
    if (known) want = st.size - known.offset;
    for (;;) {
      const size = Math.min(st.size, want);
      const start = st.size - size;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size);
      try { fs.readSync(fd, buf, 0, size, start); } finally { fs.closeSync(fd); }
      // 按字节切行，才知道每行在文件里的位置；从中间开始读的第一行是半截，不要（从记着的行首读的除外）
      const out = []; let voicePos = -1; let i0 = 0; let first = true;
      const skipFirst = start > 0 && !(known && start === known.offset);
      while (i0 <= buf.length) {
        let nl = buf.indexOf(10, i0); if (nl < 0) nl = buf.length;
        const skip = first && skipFirst; first = false;
        if (!skip && nl > i0) { const l = buf.toString('utf8', i0, nl); if (l.trim()) { try { const e = JSON.parse(l); out.push(e); if (isUserTurn(e) && !isTaskNote(e)) voicePos = start + i0; } catch (e) { /* 半截行 */ } } }
        i0 = nl + 1;
      }
      const hasVoice = voicePos >= 0;
      if (hasVoice && wide && st.size - voicePos > base && !(known && known.offset === voicePos)) {
        try { updateState('voice-pos', (o) => { o[vkey] = { offset: voicePos, size: st.size, at: Date.now() }; const ks = Object.keys(o); if (ks.length > 50) for (const k of ks.sort((a, b) => (o[a].at || 0) - (o[b].at || 0)).slice(0, ks.length - 50)) delete o[k]; }); } catch (e) { /* 记不了下次再找 */ }
      }
      if (hasVoice || size >= st.size || want >= TAIL_MAX || !wide) return uniquifyToolIds(out);
      known = null;
      want = Math.min(TAIL_MAX, want * 2);
    }
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
 * 所以窗口 = 上下文上限 × 自动压缩线（autoCompactPercent，默认 70%）+ 3.3 万：用到上限的 70% 左右压缩。
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
  return require('./invocation').object(entries, 'results', () => toolResultsRaw(entries));
}

function toolResultsRaw(entries) {
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

/** 这条"用户消息"其实是后台任务做完的通知（不是用户说的话） */
const isTaskNote = (e) => !!(e && e.type === 'user' && ((e.origin && e.origin.kind === 'task-notification') || /^\s*<task-notification>/.test(textOf(e))));

const isTaskNotePrompt = (prompt) => /^\s*<task-notification>/.test(String(prompt || ''));

/**
 * 会话记录里的工具调用（不含子代理的），按顺序：{ i, name, input, id, raw, key, at }。
 * id 在这份会话记录里是唯一的（配对结果用）；key 是要记进状态文件的（"这次审查计过了"）：用条目的 uuid，
 * 读多读少、换个时候再读都不变——id 会重复，不能拿来记
 */
function toolCalls(entries, from, to) {
  return require('./invocation').object(entries, 'calls|' + (from || 0) + '|' + (to == null ? '' : to), () => toolCallsRaw(entries, from, to));
}

function toolCallsRaw(entries, from, to) {
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

module.exports = { uniquifyToolIds, tailEntries, textOf, lastUsageTokens, contextPercent, autoCompactWindowOf, autoCompactAt, gatewayLimit, nearGatewayLimit, isUserTurn, turnStart, toolResults, isTaskNote, isTaskNotePrompt, toolCalls, READ_CMD, projectReads };

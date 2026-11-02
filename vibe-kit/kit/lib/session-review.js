'use strict';
/*
 * 审查记录：认会话记录里的审查调用和结论、登记、复审轮数、代码审过没有、本会话碰过的变更、交接文件读写。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nestedRepos, changeBorn, allChanges, archivedNames } = require('./session-projects');
const { uniquifyToolIds, textOf, isUserTurn, toolResults, toolCalls, READ_CMD } = require('./session-transcript');
const { readState, writeState, updateState, hookLog, normKey, underDir } = require('./session-state');
const { pathTokens, TASK_LINE, taskKey, mentionsChange } = require('./session-proposal');

/**
 * 后台任务做完的通知（<task-notification>）。2.1.259 起 Agent 默认在后台跑：当场的 tool_result 只是"Async agent launched…"，
 * 子代理最后说的话（审查结论在里面）后来才作为通知送回来。会话记录里先有一条 queue-operation（enqueue，content 是通知原文），
 * 轮到它时再有一条 user（origin.kind = task-notification，内容是通知原文），两处都认。
 * 返回 工具调用 id → { status, text（<result> 里的原文）, at, pos }；同一个调用通知了几次（子代理被续上又停下）的，以最后一次为准
 */
const unXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function taskNotes(entries) {
  const out = new Map();
  out.history = [];
  const calls = toolCalls(entries, 0);
  const results = toolResults(entries);
  const agents = new Map();
  const reviewList = reviewCalls(calls, results);
  for (const c of reviewList) {
    const r = results.get(c.id);
    const a = r && /(?:agentId|agent_id)\s*[:=]\s*["']?([\w-]+)/i.exec(r.text);
    const agent = a ? a[1] : String(c.input.recipient || c.input.agent_id || c.input.resume || '');
    if (agent) { const list = agents.get(agent) || []; list.push(c); agents.set(agent, list); }
  }
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
      const taskId = (body.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/) || [])[1];
      if (!rawId && !agents.has(taskId)) continue;
      const candidates = agents.get(taskId) || [];
      const nearest = candidates.filter((c) => c.i < pos).pop();
      if (!rawId && !nearest) continue;
      const id = rawId ? (renamed.length ? idAt(rawId, pos) : rawId) : nearest.id;
      const s = body.indexOf('<result>');
      const t = body.lastIndexOf('</result>');
      const status = ((body.match(/<status>\s*([^<]+?)\s*<\/status>/) || [])[1] || '').toLowerCase();
      let result = s >= 0 && t > s ? unXml(body.slice(s + 8, t)) : '';
      // 没有内嵌 result：只读真正启动审查时返回的输出文件，不照通知里任意的路径读文件。
      if (!result && status === 'completed') {
        const c = reviewList.find((x) => x.id === id);
        const r = c && results.get(c.id);
        const origin = c && results.get(c._reviewOrigin);
        const fileOf = (v) => v && /(?:output[_ -]?file|fullOutputPath)\s*[:=]\s*["']?([^\r\n"']+\.output)/i.exec(v.text);
        const f = fileOf(r) || fileOf(origin);
        try { if (f && /[/\\](?:tasks|subagents)[/\\]/i.test(f[1]) && fs.statSync(f[1]).size <= 2000000) result = fs.readFileSync(f[1], 'utf8'); } catch (err) { /* 文件读不到，等明确的结论 */ }
      }
      const note = { status, text: result, at: Date.parse(e.timestamp || '') || 0, pos };
      // queue 与送达的 user 会重复同一通知：相同结论且相同任务，只留送达时的一份。
      const prev = out.history.findIndex((n) => n.id === id && n.text === result && n.status === status);
      if (prev >= 0) out.history.splice(prev, 1);
      out.history.push(Object.assign({ id }, note));
      out.set(id, note);
    }
  });
  return out;
}

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

// 结论取最后一个：复审的时候审查者会引上一轮的结论（"上一轮结论：问题 3 条"），这一轮的在最后
const reviewIssues = (text) => { let n = null; for (const m of String(text || '').matchAll(/结论\s*[:：]\s*问题\s*(\d+)\s*条/g)) n = Number(m[1]); const last = String(text || '').trim().split(/\r?\n/).pop() || ''; const bare = last.match(/^\s*(?:\*\*)?问题\s*(\d+)\s*条(?:\*\*)?[。\s]*$/); return bare ? Number(bare[1]) : n; };

// 审查代理改名之前叫 vibe-reviewer：会话记录里的旧调用照样算
const isReviewCall = (c) => /^(Agent|Task)$/.test(c.name) && /(ttls|vibe)-reviewer/.test(String(c.input.subagent_type || ''));

/** 复审续同一个代理时，只认前面真正启动过的审查代理，不把任意消息当审查。 */
function reviewCalls(calls, results) {
  const known = new Map();
  const out = [];
  for (const c of calls) {
    if (isReviewCall(c)) {
      out.push(c);
      const r = results.get(c.id);
      const id = r && /(?:agentId|agent_id)\s*[:=]\s*["']?([\w-]+)/i.exec(r.text);
      if (id) known.set(id[1], c);
      continue;
    }
    const to = String(c.input.recipient || c.input.agent_id || c.input.resume || '');
    const base = known.get(to);
    if (!base || !/^(SendMessage|Agent|Task)$/.test(c.name)) continue;
    const prompt = String(c.input.content || c.input.message || c.input.prompt || '');
    if (!isRecheck(prompt)) continue;
    const mode = reviewModeOf(prompt);
    const inheritedMode = reviewModeOf(base.input.prompt);
    const head = (mode ? '' : '模式：复审' + (inheritedMode === 'proposal' ? '提案' : '代码') + '\n') + (changeLineOf(prompt) ? '' : '变更：' + (changeLineOf(base.input.prompt) || '无') + '\n');
    const next = Object.assign({}, c, { name: 'Agent', _reviewOrigin: base._reviewOrigin || base.id, input: Object.assign({}, c.input, { subagent_type: 'ttls-reviewer', prompt: head + prompt }) });
    out.push(next);
    known.set(to, next);
  }
  return out;
}

/**
 * 一段调用里真的做完了的审查：[{ id, key, raw, mode, recheck, change, issues, idx, at, pos }]。
 * 结论在哪：前台跑的在 tool_result 里；后台跑的（2.1.259 起默认）在后来的通知里（notes = taskNotes(entries)，通知状态要是 completed）。
 * at / pos 是结论送到的时间和在会话记录里的位置。key 是记进状态文件用的（见 toolCalls）：调用的 id 会重复，拿它记"计过了"会把
 * 后一次审查当成前一次（问题反馈 F20260929-006、-016）
 */
function reviewsIn(calls, results, changes, notes, archived) {
  const out = [];
  const expanded = [];
  for (const c of reviewCalls(calls, results)) {
    const done = notes && notes.history && notes.history.filter((n) => n.id === c.id && n.status === 'completed' && reviewIssues(n.text) !== null);
    if (done && done.length) {
      for (const n of done) expanded.push(Object.assign({}, c, { _note: n, key: (c.key || c.id) + ':note:' + shaReview(n.text) }));
    } else expanded.push(c);
  }
  expanded.forEach((c, idx) => {
    if (!isReviewCall(c)) return;
    const r = results.get(c.id);
    if (r && r.error) return;
    let issues = r ? reviewIssues(r.text) : null;
    let at = r ? r.at : 0;
    let pos = r ? r.pos : -1;
    let text = r ? r.text : '';
    const n = c._note || (notes && notes.get(c.id));
    if (n && n.status === 'completed') { issues = reviewIssues(n.text); at = n.at; pos = n.pos; text = n.text; }
    if (issues === null) return;
    // 审查总预算 2026-10-28 取消（用户定的）：兼容代理的结论晚到也照收；输入变了的照旧由指纹判失效
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

const shaReview = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * 在后台跑着、还没送回结论的审查（刚发出去，通知还没到）：[{ id, mode, change }]。这时候不要再催它审一遍。
 * 发出去超过 30 分钟还没回来的不算（多半是 Claude Code 退出过，子代理跟着没了，通知永远不会来）
 */
function pendingReviewsIn(calls, results, changes, notes) {
  const out = [];
  for (const c of reviewCalls(calls, results)) {
    const r = results.get(c.id);
    if (!r || r.error || !/Async agent launched|working in the background/i.test(r.text)) continue;
    if (notes && notes.has(c.id)) continue;
    // 发出去 30 分钟还没回来的不再等（多半是 Claude Code 退出过，子代理跟着没了）。不是审查预算（2026-10-28 取消）
    const budget = 30 * 60000;
    const prompt = String(c.input.prompt || '');
    const change = reviewTargetOf(prompt, changes);
    const started = c.at || r.at || 0;
    out.push({ id: c.id, mode: reviewModeOf(prompt, change), change, expired: !!started && Date.now() - started > budget, deadline: started + budget });
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
function recordReview(kind, dir, issues, reviewKey, at, counted) {
  const key = normKey(dir);
  const born = changeBorn(dir);
  const when = at || Date.now();
  let fresh = false;
  updateState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => {
    const prev = o[key] && typeof o[key] === 'object' ? o[key] : {};
    if (prev.done && prev.born === born && ((reviewKey && prev.key === reviewKey) || (prev.at && when < prev.at))) return o;
    o[key] = Object.assign({}, prev, { done: true, at: when, born, issues, key: reviewKey });
    for (const field of ['id', 'resolved', 'resolvedAt', 'resolvedFingerprint', 'decisions', 'fingerprint', 'proposalHash', 'materialInputs', 'reportFile', 'executor', 'covered', 'partial']) delete o[key][field];
    fresh = true;
    return o;
  });
  // 使用情况：新记上的一次审查（提案、代码，报"问题 0 条"的另数）
  if (fresh && !counted) { try { const U = require('./usage.js'); U.bump('review.' + (kind === 'proposal' ? 'proposal' : 'code')); if (Number(issues) === 0) U.bump('review.clean'); } catch (e) { /* 数不了就算了 */ } }
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
    // 代码审查刚审完就登记的（收工、工具完成钩子里）：绑上这一刻的代码指纹，之后代码改了就不算审过（Codex C06）；登记得晚的认不出当时审的是哪一版，照旧。
    // 审查代理调起之后又改过文件的（后台审查期间接着改代码）不绑：这一刻的代码不是它审的那一版（复审 U-R9）。指纹在锁外面算，算得慢不耽误别的进程写记录（复审 U-R10）
    let fp = '';
    if (fresh && r.mode !== 'proposal' && Date.now() - (Number(r.at) || 0) < 120000 && !editedAfter(entries, r.i)) { try { fp = require('./workspace').fingerprint(r.change.dir, 'code').hash; } catch (e) { fp = ''; } }
    if (fresh) updateState(r.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const rec = o[normKey(r.change.dir)]; if (rec && rec.key === r.key) { rec.executor = 'agent'; if (r.mode === 'proposal') rec.proposalHash = require('./apply-scope').planHash(r.change.dir); else if (fp) rec.fingerprint = fp; } });
    // 使用情况：这次审查从调用到结论花了多久（审查慢的时候看它；两小时以上的不算，多半是会话断过）
    if (fresh) { try { const t0 = Date.parse(((entries || [])[r.i] || {}).timestamp || '') || 0; const ms = t0 && r.at > t0 ? r.at - t0 : 0; if (ms > 0 && ms < 7200000) updateState('review-local-metrics', (s) => { s.n = (s.n || 0) + 1; s.totalMs = (s.totalMs || 0) + ms; s.at = Date.now(); }); } catch (e) { /* 本机耗时记不了不影响审查 */ } }
  }
  return found;
}

/** 会话记录里第 i 条（审查代理的调用）之后，有没有直接改文件的工具调用 */
function editedAfter(entries, i) {
  if (!Number.isInteger(i)) return true;
  return (entries || []).slice(i + 1).some((e) => { const c = e && e.message && e.message.content; return Array.isArray(c) && c.some((b) => b && b.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name || '')); });
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

/** 只读核对兼容代理的记账；不输出提示词、审查原文或文件内容，也不把缺失证据补成通过。 */
function reviewDiagnostics(entries, cwd) {
  const calls = toolCalls(entries, 0);
  const results = toolResults(entries);
  const changes = allChanges(cwd);
  const notes = taskNotes(entries);
  const found = reviewsIn(calls, results, changes, notes);
  const pending = pendingReviewsIn(calls, results, changes, notes);
  return reviewCalls(calls, results).map((c) => {
    const r = found.find((x) => x.id === c.id);
    const p = pending.find((x) => x.id === c.id);
    const change = r && r.change || reviewTargetOf(String(c.input.prompt || ''), changes);
    const mode = r && r.mode || reviewModeOf(String(c.input.prompt || ''), change);
    let reason = !change ? '没有识别到当前项目中的变更' : !mode ? '无法识别提案或代码模式' : r ? '已识别完整结论' : p ? (p.expired ? '发出去 30 分钟还没回结论，多半子代理已经没了，不能登记通过' : '结果尚未送达，检查原任务，不要重复开审查') : '未识别完整结论，或结果失败、迟到；核对原任务的结论格式和送达记录';
    return { call: c.id, change: change ? change.name : '', mode: mode || '', recognized: !!(r && change && mode), reason };
  });
}

/** 提案审过了吗 */
function proposalReviewed(dir) { const r = reviewRecord('proposal', dir); return !!(r && r.done && (!r.proposalHash || r.proposalHash === require('./apply-scope').planHash(dir)) && require('./review-runner').inputsCurrent(r.materialInputs)); }

/** 流程能否继续：完整审查、当前输入的真人跳过记录，或者每个点都有结果了（到轮数、不收敛停了的不再自动审，这里再拦就卡死）；展示仍区分审过和跳过。 */
function reviewAllowed(kind, dir) { return require('./flow-policy').allDone(dir, kind) || (kind === 'proposal' ? proposalReviewed(dir) : codeReviewed(dir)); }

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
    if (['review', 'review-fix', 'user'].includes(require('./task-types').kind(l))) continue;
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
  if (r.fingerprint) return (r.resolvedFingerprint || r.fingerprint) === require('./workspace').fingerprint(dir, 'code').hash;
  if (r.legacy) return true;
  return unreviewedAfter(dir, r).length === 0;
}

/** 归档、催审查时说的话：没审过，还是审过之后又做了任务。审过了返回空串 */
function codeReviewIssue(dir) {
  const P = require('./flow-policy');
  if (P.allPassed(dir, 'code')) return '';
  // 每个审查点都审过了或者到了上限（第 26 条）：到上限的不再挡（复审 V8：以前归档要求全部通过，到上限的点又不能再自动审，两头堵住）；没解决的写在收工报告里，归档本来就要用户点头
  try { const ps = P.points(dir, 'code'); if (ps.length && ps.every((p) => P.settled(dir, p) || P.exhausted(dir, p))) return ''; } catch (e) { /* 算不了照下面的老规矩 */ }
  const r = reviewRecord('code', dir);
  if (!r) return '还没做过代码审查（/ttls-cross-review 的代码模式，前端后端都在内；审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
  if (r.fingerprint && !codeReviewed(dir)) return '代码或任务验法在审查后变更，需要针对变更部分复验和补审；仅打勾不会触发重复审查。';
  if (r.legacy) return '';
  const late = unreviewedAfter(dir, r);
  if (!late.length) return '';
  const rel = (f) => path.basename(f);
  return '代码审查之后又做了 ' + late.length + ' 项任务，这部分代码没审到：' + late.slice(0, 3).map((x) => '"' + x.task.slice(0, 30) + '"（' + x.files.slice(0, 2).map(rel).join('、') + '）').join('；') + '。再按 /ttls-cross-review 的代码模式审一遍这几项的改动（审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
}

const reviewMax = (cfg) => Math.min(10, Math.max(1, Number(cfg.reviewMaxRounds) || 3));

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
  return who + '停止自动循环，展示剩余问题，用 Ask 让用户选择继续审修、逐条处理或放弃。次数用完不代表通过；用户主动要求继续审查时执行。放弃不新增未审查或未测试记录。';
}

/**
 * 打勾（开工）、归档之前：这个变更的多轮审查审完了吗。先调 syncReviewRounds 把会话记录里的审查计上。
 * 没开多轮审查、审完了返回空串；轮数已经用完的，这一次就按"问用户 / 全自动自己定"说，并记成审完（问过了再来就放行）
 */
function reviewLoopIssue(kind, dir, cfg) {
  if (require('./flow-policy').allPassed(dir, kind)) return '';
  if (!cfg.reviewLoop) return '';
  const k = kind + '|' + normKey(dir);
  const rec = readState('review-rounds')[k];
  if (!rec || rec.done) return '';
  if (rec.born && changeBorn(dir) && Math.abs(rec.born - changeBorn(dir)) > 2000) return '';
  if (rec.rounds >= reviewMax(cfg)) {
    updateState('review-rounds', (st) => { if (st[k]) st[k].exhausted = true; });
    try { require('./usage.js').bump('review.exhausted'); } catch (e) { /* 数不了就算了 */ }
    return reviewExhaustedText(rec, kind, cfg, path.basename(dir));
  }
  const name = kind === 'proposal' ? '提案' : '代码';
  return name + '的多轮审查还没审完：第 ' + rec.rounds + ' 轮报了 ' + (rec.issues || 0) + ' 条问题。成立的改掉，再让 ttls-reviewer 复审改动点（提示第一行写"模式：复审' + name + '"，第二行写"变更：' + path.basename(dir) + '"），复审到"问题 0 条"；都不成立的，在这个变更的 revisions.md 里逐条记下理由（起因：审查），就算处理完';
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

module.exports = { taskNotes, reviewModeOf, isRecheck, reviewTargetOf, reviewIssues, reviewsIn, pendingReviewsIn, reviewRecord, recordReview, syncReviews, reviewDiagnostics, proposalReviewed, reviewAllowed, syncTicks, taskCodeFiles, projectRootsOf, unreviewedAfter, codeReviewed, codeReviewIssue, reviewMax, syncReviewRounds, reviewExhaustedText, reviewLoopIssue, handoverReadIn, handoverWrittenIn };

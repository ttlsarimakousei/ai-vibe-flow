'use strict';
/*
 * 审查能不能不用子代理（第 71 条，2026-11-05）：拿一次已经审过的审查，把当时的材料一次发给 claude -p，和子代理当时的结果比用时、输出 token、问题。
 * 内网报告：审查慢在子代理每一步的思考，一次请求没有"每一步"，单次时间有上限（输出上限 ÷ 约 135 token/秒）。要知道的是一次请求会不会漏问题。
 * 这是单个文件，拷到跑过审查的电脑上直接跑，只用 Node 自带的模块，不用改套件。不开子代理。
 *
 *   node review-oneshot.js --list               列出记录里的审查（不发请求）
 *   node review-oneshot.js --job <编号前几位>   对这次审查跑一次（发 1 个真请求，没拿到结论重试 1 次）
 *   node review-oneshot.js --job <编号> --turns 8    允许用 Read、Grep，最多 8 步（一次请求漏得多时再试这个）
 *   其它：--model 名字（默认 sonnet）、--exe <claude 的路径>、--dir <会话记录目录>、--days N（默认 14）、--budget 字数（材料上限，默认 24 万）、--out 文件
 *
 * 怎么还原当时的材料（代码和文档后来都修过，直接拿现在的比不公平）：
 *   要审的文件、基线、要求都从子代理读到的范围文件里取。文件内容取审查开始那一刻的：主会话记录里审查开始之后第一次改它的 Edit、Write 带的 originalFile；
 *   没带的，从后面带的那次或者磁盘上现在的内容，把审查开始之后的编辑一条条倒着撤回去。撤不回去的在报告里标"可能不准"。别的会话以外的改动（手改、git checkout）认不出来。
 * 只读会话记录和项目文件，只写报告这一个文件（临时目录用完删）。敏感配置（.env、secrets.json、db-crud.ini 这类）不送，口令形式的值遮掉。
 * 报告里有问题的原文和路径，带出内网前看一眼；开头的数字表不含这些。
 */
process.noDeprecation = true; // shell:true 带参数的提示，参数都自己加了引号
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const MODEL = val('--model', 'sonnet');
const EXE = val('--exe', 'claude');
const TURNS = Number(val('--turns', 0)) || 0;
const BUDGET = Number(val('--budget', 240000)) || 240000;
const FILE_CAP = 40000; // 一个文件超过这么多字，只送差异
const NAMED_CAP = 20000; // 文档点名的文件，每个最多这么多字
const SYSTEM = 'You are a code and requirements reviewer. Read only, change nothing. Write your findings in Chinese.';

const TASK = /审查任务\s*[:：]\s*([0-9a-f]{24})\/([^\s`"，。]+)/;
const SCOPE_FILE = /[\\/]\.vibe[\\/]reviews[\\/].*job-[0-9a-f]+[\\/][^\\/]+\.md$/i;
const SECRET_FILE = /(^|[\\/])(secrets\.json|router-data|\.env(?:\.[^/\\]*)?|db-crud\.ini|redis\.json|login\.json)([\\/]|$)/i;
const slash = (p) => String(p || '').replace(/\\/g, '/');
const norm = (p) => slash(p).toLowerCase();
const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'; };
const k = (n) => (n >= 10000 ? Math.round(n / 1000) + 'K' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const oneLine = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\|/g, '/').trim(); return n && t.length > n ? t.slice(0, n) + '…' : t; };
const textOf = (v) => { if (typeof v === 'string') return v; if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.content)) || '')).join(''); return ''; };
const mask = (s) => String(s).replace(/((?:password|passwd|pwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1***');
const readLines = (f) => { const out = []; for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line || line.startsWith('{"type":"api-request-blob"')) continue; try { out.push(JSON.parse(line)); } catch (e) { /* 半行 */ } } return out; };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-');

/** 回复里的结论：JSON，可以包在代码块里、前后带话 */
function parseResult(text) {
  const body = String(text || '');
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  let result;
  for (const m of [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse()) { result = tryParse(m[1]); if (result !== undefined) break; }
  if (result === undefined) { const i = body.indexOf('{'); const j = body.lastIndexOf('}'); if (i >= 0 && j > i) result = tryParse(body.slice(i, j + 1)); }
  return result && Array.isArray(result.issues) ? result : null;
}

// ---------- 记录里的审查 ----------
function parseAgent(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.slice(0, 30000).includes('审查任务')) return null;
  const r = { file, sid: '', cwd: '', version: '', firstAt: 0, lastAt: 0, reqs: [], texts: [], scope: '', model: '' };
  const calls = new Map(); let cur = null; let first = '';
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request-blob"')) continue;
    let e; try { e = JSON.parse(line); } catch (x) { continue; }
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (t && ['user', 'assistant', 'system', 'attachment'].includes(e.type)) { r.firstAt = r.firstAt || t; r.lastAt = Math.max(r.lastAt, t); }
    if (e.sessionId) r.sid = r.sid || e.sessionId;
    if (e.cwd) r.cwd = r.cwd || e.cwd;
    if (e.version) r.version = e.version;
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      if (m.model === '<synthetic>' || e.isApiErrorMessage) { cur = null; continue; }
      if (!cur || (m.id && cur.id && cur.id !== m.id)) { cur = { id: m.id || '', ctx: 0, out: 0, think: 0 }; r.reqs.push(cur); }
      const u = m.usage || {};
      cur.ctx = Math.max(cur.ctx, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)); cur.out = Math.max(cur.out, u.output_tokens || 0);
      if (m.model) r.model = m.model;
      for (const c of [].concat(m.content || [])) {
        if (!c) continue;
        if (c.type === 'thinking') cur.think += String(c.thinking || '').length;
        else if (c.type === 'text') r.texts.push(String(c.text || ''));
        else if (c.type === 'tool_use') { calls.set(c.id, c); if (c.name === 'SubagentHandback' && c.input && c.input.message) r.texts.push(String(c.input.message)); }
      }
    } else if (e.type === 'user' && e.message) {
      cur = null;
      if (!first) first = textOf(e.message.content);
      for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
        if (!c || c.type !== 'tool_result') continue;
        const call = calls.get(c.tool_use_id);
        if (call && call.name === 'Read' && SCOPE_FILE.test(String((call.input || {}).file_path || ''))) { const m = TASK.exec(first); if (m && path.basename(slash(call.input.file_path)) === safeName(m[2]) + '.md') r.scope += textOf(c.content).replace(/^\s*\d+[\t→]/gm, '') + '\n'; }
      }
    }
  }
  const m = TASK.exec(first); if (!m) return null;
  r.job = m[1]; r.lens = m[2];
  const mode = /^模式[:：]\s*(\S+)/m.exec(first); r.mode = mode ? mode[1] : '';
  const ch = /^变更[:：]\s*(.+?)\s*$/m.exec(first); r.change = ch ? ch[1] : '';
  r.issues = null; r.summary = '';
  for (let i = r.texts.length - 1; i >= 0; i--) { const p = parseResult(r.texts[i]); if (p) { r.issues = p.issues; r.summary = String(p.summary || ''); break; } }
  delete r.texts;
  return r;
}
function findAgents(root, days) {
  const out = []; const since = Date.now() - days * 86400000;
  const walk = (d, depth) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3 && !/^(tool-results|memory)$/.test(e.name)) walk(p, depth + 1); continue; }
      if (!/^agent-.*\.jsonl$/.test(e.name)) continue;
      try { if (fs.statSync(p).mtimeMs < since) continue; const a = parseAgent(p); if (a) { a.projDir = slash(p).split('/').slice(0, slash(root).split('/').length + 1).join('/'); out.push(a); } } catch (x) { /* 读不了就跳过 */ }
    }
  };
  walk(root, 0);
  return out;
}
function groupJobs(agents) {
  const jobs = new Map();
  for (const a of agents) { if (!/^(提案|代码)$/.test(a.mode)) continue; const j = jobs.get(a.job) || { id: a.job, mode: a.mode, change: a.change, agents: [], projDir: a.projDir, cwd: a.cwd }; j.agents.push(a); jobs.set(a.job, j); }
  for (const j of jobs.values()) {
    const S = (fn) => j.agents.reduce((n, a) => n + a.reqs.reduce((x, q) => x + fn(q), 0), 0);
    j.start = Math.min(...j.agents.map((a) => a.firstAt)); j.end = Math.max(...j.agents.map((a) => a.lastAt));
    j.requests = j.agents.reduce((n, a) => n + a.reqs.length, 0); j.out = S((q) => q.out); j.input = S((q) => q.ctx); j.think = S((q) => q.think);
    j.issues = mergeIssues(j.agents.map((a) => a.issues || []));
    j.lost = j.agents.filter((a) => !a.issues).length;
    j.model = (j.agents[0] || {}).model; j.version = (j.agents[0] || {}).version;
  }
  return [...jobs.values()].sort((a, b) => b.start - a.start);
}
const counts = (issues) => { const c = { P1: 0, P2: 0, P3: 0 }; for (const x of issues || []) { if (/^out$/i.test(String(x.scope || ''))) continue; const s = String(x.severity || '').toUpperCase(); if (s === 'P1') c.P1++; else if (s === 'P3') c.P3++; else c.P2++; } return c; };
const blockingOf = (x) => !/^P3$/i.test(String(x.severity || '')) && !/^out$/i.test(String(x.scope || ''));

// ---------- 比问题 ----------
function bigrams(s) { const t = String(s || '').replace(/[\s，,。.；;：:、"'“”（）()`]+/g, '').toLowerCase(); const out = new Set(); for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2)); return out; }
function alike(a, b) { const A = bigrams(a); const B = bigrams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n++; return (2 * n) / (A.size + B.size); }
const baseOf = (f) => path.basename(slash(f)).toLowerCase();
function sameIssue(a, b) { return baseOf(a.file) === baseOf(b.file) && alike(a.problem, b.problem) >= 0.7; }
function mergeIssues(groups) { const out = []; for (const list of groups) for (const x of list) if (x && typeof x.problem === 'string' && !out.some((y) => sameIssue(y, x))) out.push(x); return out; }
/** x 在 list 里最像哪一条。同一个文件要求低些。粗算，给人看的，不当结论 */
function bestMatch(x, list) {
  let best = null; let score = 0;
  for (const y of list) {
    const text = alike(String(x.problem) + ' ' + String(x.evidence || ''), String(y.problem) + ' ' + String(y.evidence || ''));
    const same = baseOf(x.file) === baseOf(y.file);
    const near = same && Number(x.line) && Number(y.line) && Math.abs(Number(x.line) - Number(y.line)) <= 15;
    const s = text + (same ? 0.12 : 0) + (near ? 0.1 : 0);
    if (s > score) { score = s; best = y; }
  }
  return score >= 0.3 ? { issue: best, score } : null;
}
/** 审查记录.md：当时每条问题是修了还是不成立。按问题的文字配 */
function decisionsOf(project, change) {
  const out = [];
  let text; try { text = fs.readFileSync(path.join(project, '.vibe', 'reviews', change && !/不走/.test(change) ? change : 'plain', '审查记录.md'), 'utf8'); } catch (e) { return out; }
  let round = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/^## 第/.test(line)) { round = new Map(); continue; }
    let m = /^- (r\d+) P\d \S*?：(.+)$/.exec(line) || /^- (r\d+) P\d .*?：(.+)$/.exec(line);
    if (m && !/^- r\d+ (修了|不成立|接受不改|留给后面的文档)：/.test(line)) { const o = { problem: m[2], action: '' }; round.set(m[1], o); out.push(o); continue; }
    m = /^- (r\d+) (修了|不成立|接受不改|留给后面的文档)：/.exec(line);
    if (m && round.has(m[1])) round.get(m[1]).action = m[2];
  }
  return out;
}

// ---------- 还原当时的文件 ----------
/** 审查开始之后，主会话对文件的成功编辑。key 是小写路径 */
function editsAfter(projDir, since) {
  const map = new Map();
  let files = []; try { files = fs.readdirSync(projDir).filter((n) => /\.jsonl$/.test(n)).map((n) => path.join(projDir, n)); } catch (e) { return map; }
  for (const f of files) {
    try { if (fs.statSync(f).mtimeMs < since) continue; } catch (e) { continue; }
    const uses = new Map();
    for (const e of readLines(f)) {
      if (e.type === 'assistant' && e.message) { for (const c of [].concat(e.message.content || [])) if (c && c.type === 'tool_use' && /^(Edit|Write|MultiEdit)$/.test(c.name)) uses.set(c.id, c); continue; }
      if (e.type !== 'user' || !e.message || !Array.isArray(e.message.content)) continue;
      const t = e.timestamp ? Date.parse(e.timestamp) : 0;
      for (const c of e.message.content) {
        if (!c || c.type !== 'tool_result' || c.is_error) continue;
        const call = uses.get(c.tool_use_id); if (!call || t < since) continue;
        const i = call.input || {}; const key = norm(i.file_path); const res = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : {};
        const steps = call.name === 'MultiEdit' ? (i.edits || []) : call.name === 'Edit' ? [i] : [];
        const list = map.get(key) || [];
        list.push({ at: t, name: call.name, steps, original: typeof res.originalFile === 'string' ? res.originalFile : null });
        map.set(key, list);
      }
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.at - b.at);
  return map;
}
function undo(text, edit) {
  let cur = text; let ok = true;
  if (edit.name === 'Write') return { text: cur, ok: false };
  for (const s of edit.steps.slice().reverse()) {
    const a = String(s.new_string == null ? '' : s.new_string); const b = String(s.old_string == null ? '' : s.old_string);
    if (a && cur.includes(a)) cur = s.replace_all ? cur.split(a).join(b) : cur.replace(a, () => b); else ok = false;
  }
  return { text: cur, ok };
}
function currentPath(file, change) {
  if (fs.existsSync(file)) return file;
  // 变更归档以后挪到 changes/archive/<日期>-<名字>/ 了
  const m = /^(.*[\\/]openspec[\\/]changes)[\\/]([^\\/]+)[\\/](.+)$/.exec(file);
  if (!m) return null;
  const arc = path.join(m[1], 'archive');
  let dirs = []; try { dirs = fs.readdirSync(arc).filter((n) => n.endsWith('-' + m[2])); } catch (e) { return null; }
  for (const d of dirs) { const f = path.join(arc, d, m[3]); if (fs.existsSync(f)) return f; }
  return null;
}
/** 审查开始那一刻的内容。返回 { text, status: 原样 / 还原 / 可能不准 / 读不了 } */
function restore(file, edits, change) {
  const list = edits.get(norm(file)) || [];
  const cur = currentPath(file, change);
  let now = null;
  if (cur) { try { const bytes = fs.readFileSync(cur); if (bytes.includes(0)) return { text: null, status: '二进制，没送' }; if (bytes.length > 4 * 1024 * 1024) return { text: null, status: '超过 4MB，没送' }; now = bytes.toString('utf8'); } catch (e) { now = null; } }
  if (!list.length) return now === null ? { text: null, status: '读不了' } : { text: now, status: '原样' };
  if (list[0].original !== null) return { text: list[0].original, status: '还原' };
  let idx = list.findIndex((x) => x.original !== null);
  let text = idx >= 0 ? list[idx].original : now;
  if (text === null) return { text: null, status: '读不了' };
  if (idx < 0) idx = list.length;
  let ok = true;
  for (let i = idx - 1; i >= 0; i--) { const r = undo(text, list[i]); text = r.text; if (!r.ok) ok = false; }
  return { text, status: ok ? '还原' : '可能不准' };
}

// ---------- 范围文件 ----------
function sec(body, title) { const m = new RegExp('^## ' + title + '[^\\n]*$', 'm').exec(body); if (!m) return ''; const rest = body.slice(m.index + m[0].length); const n = rest.search(/^## /m); return (n >= 0 ? rest.slice(0, n) : rest).trim(); }
function parseScope(body, fallback) {
  const project = ((/^项目[:：]\s*(.+?)\s*$/m.exec(body) || [])[1]) || fallback;
  const files = [];
  const lines = sec(body, '要审的文件').split('\n');
  for (const l of lines) {
    if (!/^- /.test(l)) continue;
    const raw = l.slice(2).trim(); const idx = raw.lastIndexOf('：'); let source = ''; let head = raw;
    if (idx > 0 && /[\\/]/.test(raw.slice(idx + 1))) { source = raw.slice(idx + 1).trim(); head = raw.slice(0, idx); }
    const label = head.split('（')[0].trim();
    if (!label) continue;
    files.push({ label, role: /只用来核对/.test(head), note: /开工前已有改动/.test(head), source: path.resolve(project, source || label) });
  }
  const bases = [];
  const b = /^基线：(.+)$/m.exec(body);
  if (b) for (const part of b[1].split('。')[0].split('；')) { const m = /^(.+) 的 (\S+)$/.exec(part.trim()); if (m) bases.push({ root: m[1], ref: m[2] }); }
  const exploreLine = sec(body, '探索记录').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  const paths = sec(body, '脚本核过的路径');
  const found = /^- 在：(.+)$/m.exec(paths); const missing = /^- 不在[^：]*：(.+)$/m.exec(paths);
  const list = (m) => (m ? m[1].split('；')[0].split('、').map((x) => x.trim()).filter((x) => x && x !== '无') : []);
  return { project, files, bases, explore: exploreLine.split('（')[0].trim(), found: list(found), missing: list(missing), areas: (sec(body, '这次涉及的目录').split('\n')[0] || '').trim(), requirement: sec(body, '要求') };
}
function git(root, a) { const r = spawnSync('git', ['-C', root].concat(a), { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; }
function diffOf(oldText, newText, tmp, name) {
  const a = path.join(tmp, 'old-' + name); const b = path.join(tmp, 'new-' + name);
  fs.writeFileSync(a, oldText); fs.writeFileSync(b, newText);
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=5', '--', a, b], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const at = String(r.stdout || '').indexOf('@@');
  return at >= 0 ? String(r.stdout).slice(at) : '';
}
const KEYWORD = /^(if|for|while|switch|catch|return|new|super|this|else|function|class|async|await|void|public|private|protected|static|final|try|throw|typeof)$/;
/** 差异里改到的方法名 */
function changedNames(diff) {
  const names = new Set();
  for (const l of diff.split('\n')) {
    if (!/^[-+]/.test(l) || /^(---|\+\+\+)/.test(l)) continue;
    for (const m of l.matchAll(/(?:\b[\w<>,\[\]]+\s+|\bfunction\s+|\bdef\s+)([A-Za-z_]\w{3,})\s*\(/g)) if (!KEYWORD.test(m[1])) names.add(m[1]);
    const arrow = /\b(?:const|let|var)\s+([A-Za-z_]\w{3,})\s*=\s*(?:async\s*)?\(/.exec(l); if (arrow) names.add(arrow[1]);
  }
  return [...names];
}
/** 这一行是不是方法定义，是就返回方法名 */
function declOf(line) {
  const t = String(line || '').trim();
  if (!t || /^(if|for|while|switch|catch|return|else|try|new|throw|await|\/\/|\*|\/\*)\b/.test(t) || /;\s*$/.test(t)) return '';
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_]\w{3,})\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.exec(t);
  if (arrow) return arrow[1];
  const m = /\b([A-Za-z_]\w{3,})\s*\([^()]*\)?\s*(?:throws\b[^{]*)?\{?\s*$/.exec(t);
  return m && !KEYWORD.test(m[1]) ? m[1] : '';
}
/** 改动落在哪些方法里：大部分改动在方法体里，定义那一行没动，只看改动行找不到要查谁的调用方 */
function enclosingNames(diff, text) {
  const names = new Set(); const lines = String(text).split('\n');
  let at = 0;
  for (const l of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { at = Number(h[1]) - 1; continue; }
    if (/^-/.test(l)) continue;
    if (/^\+/.test(l)) { for (let i = at; i >= 0 && i > at - 300; i--) { const n = declOf(lines[i]); if (n) { names.add(n); break; } } }
    at++;
  }
  return [...names];
}

// ---------- 备材料 ----------
function buildMaterial(job, scope, tmp) {
  const parts = []; const rows = []; const left = []; let used = 0;
  const add = (title, text, status) => {
    const t = mask(text);
    if (used + t.length > BUDGET) { left.push(title); rows.push([title, t.length, '放不下，没送']); return false; }
    parts.push('=== ' + title + ' ===\n' + t); used += t.length; rows.push([title, t.length, status || '']); return true;
  };
  const edits = editsAfter(job.projDir, job.start);
  const rootOf = (f) => scope.bases.map((b) => b.root).filter((r) => norm(f).startsWith(norm(r) + '/')).sort((a, b) => b.length - a.length)[0];
  const restored = [];
  scope.files.forEach((x, i) => {
    if (SECRET_FILE.test(x.source)) { rows.push([x.label, 0, '敏感配置，没送']); return; }
    const r = restore(x.source, edits, job.change); restored.push(Object.assign({}, x, r, { index: i }));
  });
  if (job.mode === '代码') {
    const review = restored.filter((x) => !x.role); const names = new Set();
    for (const x of review) {
      if (x.text === null) { rows.push([x.label, 0, x.status]); continue; }
      const root = rootOf(x.source); const ref = root && (scope.bases.find((b) => b.root === root) || {}).ref;
      const rel = root ? slash(path.relative(root, x.source)) : '';
      const before = root && ref ? git(root, ['show', ref + ':' + rel]) : null;
      const diff = before === null ? '' : diffOf(before, x.text, tmp, x.index + path.extname(x.source));
      for (const n of changedNames(diff).concat(enclosingNames(diff, x.text))) names.add(n);
      const note = x.note ? '（开工前已有改动，不能全部认作本次改动）' : '';
      if (before === null) add(x.label + '（新文件' + note + '）', x.text.length > FILE_CAP * 2 ? x.text.slice(0, FILE_CAP * 2) + '\n……（后面截掉）' : x.text, x.status);
      else add(x.label + '（改动' + note + '，- 是基线，+ 是审查时）', diff || '（和基线一样）', x.status);
    }
    for (const x of review) if (x.text !== null && x.text.length <= FILE_CAP) { const root = rootOf(x.source); if (root) add(x.label + '（审查时的全文）', x.text, x.status); }
    // 调用方：脚本查好，模型不用自己搜
    // 要审的文件本身不列：上面已经给了审查时的内容，这里查到的是现在的（可能已经修过）
    const callers = [];
    for (const n of [...names].slice(0, 40)) {
      for (const b of scope.bases) {
        const out = git(b.root, ['grep', '-n', '-w', '-F', '--', n]);
        if (!out) continue;
        const own = new Set(review.map((x) => norm(path.relative(b.root, x.source))));
        const hits = out.split('\n').filter(Boolean).filter((l) => !own.has(norm(l.split(':')[0]))).map((l) => l.slice(0, 200));
        if (hits.length) callers.push('# ' + n + '（' + hits.length + ' 处）\n' + hits.slice(0, 12).join('\n'));
      }
    }
    if (callers.length) add('改到的方法在别的文件里哪里用到（git grep，现在的代码，每个最多 12 条）', callers.join('\n'));
  } else {
    for (const x of restored.filter((y) => !y.role)) { if (x.text === null) rows.push([x.label, 0, x.status]); else add(x.label + '（要审）', x.text, x.status); }
  }
  for (const x of restored.filter((y) => y.role)) { if (x.text === null) rows.push([x.label, 0, x.status]); else add(x.label + '（只用来核对，不审它本身）', x.text.length > FILE_CAP ? x.text.slice(0, FILE_CAP) + '\n……（后面截掉）' : x.text, x.status); }
  if (scope.explore) { const r = restore(path.resolve(scope.project, scope.explore), edits, job.change); if (r.text !== null) add('探索记录 ' + path.basename(slash(scope.explore)), r.text, r.status); }
  for (const name of ['CLAUDE.md', path.join('.vibe', 'project.md'), path.join('openspec', 'config.yaml')]) { const f = path.join(scope.project, name); try { const t = fs.readFileSync(f, 'utf8'); if (t.length <= 8000) add('项目约定 ' + slash(name), t, '现在的'); } catch (e) { /* 没有 */ } }
  for (const p of scope.found) {
    const f = path.resolve(scope.project, p);
    if (SECRET_FILE.test(f)) continue;
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (!st.isFile() || restored.some((x) => norm(x.source) === norm(f))) continue;
    const r = restore(f, edits, job.change);
    if (r.text !== null) add('文档点名的文件 ' + slash(p) + (r.text.length > NAMED_CAP ? '（只有开头）' : ''), r.text.slice(0, NAMED_CAP), r.status);
  }
  if (scope.missing.length) add('文档提到但脚本没找到的路径', scope.missing.join('\n'));
  return { text: parts.join('\n\n'), rows, left, used };
}
function promptOf(job, scope, material) {
  return ['这是一次审查。下面的材料是脚本备好的，就是全部材料，一次看完。' + (TURNS ? '材料里没有、又必须看的，可以用 Read、Grep 查，最多 ' + TURNS + ' 步，够了就交。' : '没有工具可用。'),
    '', '## 要求', '', scope.requirement || '找出会在什么情况下出错。',
    '', '第一轮的几个角度你一个人看全，同一件事只报一条。不要报风格偏好。看材料确定不了的不要猜，写进 need。',
    '', '最后只回一个 JSON（代码块）：',
    '{"issues":[{"severity":"P1或P2或P3","file":"路径","line":45,"problem":"一句话","evidence":"具体输入和错误结果","fix":"怎么改","kind":"类别","scope":"in或out"}],"need":["还想看但材料里没有的东西，一句一条"],"summary":"看了什么、没看什么"}',
    '', '变更：' + (job.change || ''), '模式：' + job.mode, '', '## 材料', '', material.text].join('\n');
}

// ---------- 跑 claude -p ----------
function runClaude(prompt, cwd, settings) {
  const raw = ['-p', '--output-format', 'json', '--model', MODEL, '--settings', settings, '--no-session-persistence', '--system-prompt', SYSTEM].concat(TURNS ? ['--tools', 'Read,Grep', '--max-turns', String(TURNS)] : ['--tools', '']);
  const useShell = process.platform === 'win32' && !/\.exe$/i.test(EXE);
  // shell:true 时 Node 只把参数拼起来：空参数和带空格的自己加引号
  const a = useShell ? raw.map((x) => (x === '' ? '""' : /[\s"&|<>^]/.test(x) ? '"' + x.replace(/"/g, '\\"') + '"' : x)) : raw;
  const r = spawnSync(useShell && /\s/.test(EXE) ? '"' + EXE + '"' : EXE, a, { input: prompt, cwd, encoding: 'utf8', windowsHide: true, shell: useShell, timeout: 40 * 60000, maxBuffer: 128 * 1024 * 1024 });
  let j = null; try { j = JSON.parse(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { /* 下面报 */ }
  return { j, err: oneLine(r.stderr || (r.error && r.error.message) || r.stdout, 200) };
}

function listJobs(jobs) {
  if (!jobs.length) { console.log('记录里没找到审查子代理（提示里带"审查任务："的）。--days 放大，或者 --dir 指定会话记录目录。'); return; }
  console.log('| 编号 | 开始 | 变更 | 模式 | 子代理 | 总时长 | 请求 | 输出 | P1/P2/P3 | 有范围文件 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const j of jobs.slice(0, 40)) { const c = counts(j.issues); console.log('| ' + j.id.slice(0, 8) + ' | ' + stamp(j.start) + ' | ' + oneLine(j.change, 30) + ' | ' + j.mode + ' | ' + j.agents.length + ' | ' + dur(j.end - j.start) + ' | ' + j.requests + ' | ' + k(j.out) + ' | ' + c.P1 + '/' + c.P2 + '/' + c.P3 + (j.lost ? '（' + j.lost + ' 个没交）' : '') + ' | ' + (j.agents.some((a) => a.scope) ? '有' : '没有') + ' |'); }
  console.log('\n挑一次问题数不是 0、审查之后修过的，跑：node review-oneshot.js --job <编号>');
}

function main() {
  if (has('--help') || has('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = val('--dir', path.join(cfg, 'projects'));
  const jobs = groupJobs(findAgents(root, Number(val('--days', 14)) || 14));
  const want = val('--job', '');
  if (has('--list') || !want) { listJobs(jobs); return; }
  const job = jobs.find((j) => j.id.startsWith(want));
  if (!job) { console.log('没找到审查 ' + want + '。先跑 --list 看编号。'); process.exitCode = 1; return; }
  const withScope = job.agents.find((a) => a.scope);
  if (!withScope) { console.log('这次审查的记录里没有范围文件的内容，还原不了材料，换一次。'); process.exitCode = 1; return; }
  const scope = parseScope(withScope.scope, job.cwd);
  // 每个角度的要求合起来，相同的段落只留一份
  const paragraphs = []; for (const a of job.agents) if (a.scope) for (const p of sec(a.scope, '要求').split(/\n\s*\n/)) if (p.trim() && !paragraphs.includes(p.trim())) paragraphs.push(p.trim());
  scope.requirement = paragraphs.join('\n\n');
  if (!fs.existsSync(scope.project)) { console.log('项目目录 ' + scope.project + ' 在这台电脑上没有。'); process.exitCode = 1; return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-oneshot-'));
  try {
    const settings = path.join(tmp, 'settings.json');
    // 关掉钩子：这是一次独立的请求，套件的流程检查不该掺进来。权限规则（不让读令牌）还在
    fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
    const material = buildMaterial(job, scope, tmp);
    const prompt = promptOf(job, scope, material);
    console.log('材料 ' + material.rows.length + ' 份，' + Math.round(material.used / 1000) + 'K 字' + (material.left.length ? '，' + material.left.length + ' 份放不下' : '') + '。开始请求，审得久的话要等几分钟……');
    const empty = path.join(tmp, 'cwd'); fs.mkdirSync(empty);
    const work = TURNS ? scope.project : empty;
    const t0 = Date.now(); let attempts = 0; let parsed = null; let last = null; let reply = '';
    const runs = [];
    while (attempts < 2 && !parsed) {
      attempts++;
      const t1 = Date.now();
      last = runClaude(prompt, work, settings);
      reply = last.j ? String(last.j.result || '') : '';
      parsed = parseResult(reply);
      const u = (last.j && last.j.usage) || {};
      runs.push({ ms: Date.now() - t1, out: u.output_tokens || 0, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), chars: reply.length, ok: !!parsed, why: last.j ? String(last.j.subtype || '') : last.err });
      console.log('第 ' + attempts + ' 次：' + dur(Date.now() - t1) + '，输出 ' + k(u.output_tokens || 0) + ' token，' + (parsed ? '拿到结论' : '没拿到结论（' + oneLine(runs[runs.length - 1].why, 100) + '）'));
    }
    const spent = Date.now() - t0;
    const one = parsed ? parsed.issues.filter((x) => x && typeof x.problem === 'string') : [];
    const sub = job.issues; const subIn = sub.filter((x) => !/^out$/i.test(String(x.scope || '')));
    const decisions = decisionsOf(scope.project, job.change);
    const decisionOf = (x) => { let best = ''; let s = 0; for (const d of decisions) { const a = alike(d.problem, x.problem); if (a > s) { s = a; best = d.action; } } return s >= 0.6 ? best || '没登记' : '没配上'; };
    const rows = subIn.map((x) => ({ x, severity: String(x.severity || 'P2'), decision: decisionOf(x), hit: bestMatch(x, one) }));
    const real = rows.filter((r) => blockingOf(r.x) && r.decision === '修了');
    const blocking = rows.filter((r) => blockingOf(r.x));
    const usedOne = new Set(rows.filter((r) => r.hit).map((r) => r.hit.issue));
    const extra = one.filter((x) => !usedOne.has(x));
    const cs = counts(sub); const co = counts(one);
    const outSum = runs.reduce((n, r) => n + r.out, 0); const inSum = runs.reduce((n, r) => n + r.input, 0);
    const stats = (status) => material.rows.filter((r) => r[2] === status).length;
    const head = [
      '| | 子代理（' + job.agents.length + ' 个' + (job.lost ? '，' + job.lost + ' 个没交' : '') + '） | 一次请求' + (TURNS ? '（最多 ' + TURNS + ' 步）' : '') + ' |', '|---|---|---|',
      '| 用时 | ' + dur(job.end - job.start) + ' | ' + dur(spent) + (attempts > 1 ? '（含重试）' : '') + ' |',
      '| 请求数 | ' + job.requests + ' | ' + attempts + (TURNS ? ' 次运行' : '') + ' |',
      '| 输出 token | ' + k(job.out) + ' | ' + k(outSum) + ' |',
      '| 累计输入 token | ' + k(job.input) + ' | ' + k(inSum) + ' |',
      '| P1 / P2 / P3 | ' + cs.P1 + ' / ' + cs.P2 + ' / ' + cs.P3 + ' | ' + co.P1 + ' / ' + co.P2 + ' / ' + co.P3 + ' |',
      '| 子代理的 P1、P2，一次请求对上（粗算） | ' + blocking.length + ' 条 | ' + blocking.filter((r) => r.hit).length + ' 条 |',
      '| 其中当时登记修了的，一次请求对上（粗算） | ' + real.length + ' 条 | ' + real.filter((r) => r.hit).length + ' 条 |',
      '| 一次请求另外报的 | | ' + extra.length + ' 条 |',
      '| 材料 | | ' + Math.round(material.used / 1000) + 'K 字；还原 ' + stats('还原') + ' 份，可能不准 ' + stats('可能不准') + ' 份，放不下 ' + material.left.length + ' 份 |',
    ];
    const out = ['# 一次请求和子代理对比', '', '审查 ' + job.id.slice(0, 8) + '，' + stamp(job.start) + '，变更 ' + oneLine(job.change) + '，模式 ' + job.mode + '。子代理模型 ' + (job.model || '未知') + '（Claude Code ' + (job.version || '未知') + '），这次用模型名 ' + MODEL + (last && last.j && last.j.modelUsage ? '（' + Object.keys(last.j.modelUsage).join('、') + '）' : '') + '。', ''].concat(head);
    out.push('', '"对上"按文字相近和文件、行号粗算，下面逐条看才算数。"修了"来自审查记录.md。', '', '## 子代理报的问题', '');
    out.push('| 级别 | 文件 | 问题 | 当时 | 一次请求 |', '|---|---|---|---|---|');
    for (const r of rows.slice().sort((a, b) => a.severity.localeCompare(b.severity))) out.push('| ' + oneLine(r.severity) + ' | ' + oneLine(r.x.file, 60) + (r.x.line ? ':' + r.x.line : '') + ' | ' + oneLine(r.x.problem, 160) + ' | ' + r.decision + ' | ' + (r.hit ? '对上：' + oneLine(r.hit.issue.problem, 100) : '没提到') + ' |');
    out.push('', '## 一次请求另外报的', '');
    if (!extra.length) out.push('（没有）'); else { out.push('| 级别 | 文件 | 问题 | 依据 |', '|---|---|---|---|'); for (const x of extra) out.push('| ' + oneLine(x.severity) + ' | ' + oneLine(x.file, 60) + (x.line ? ':' + x.line : '') + ' | ' + oneLine(x.problem, 160) + ' | ' + oneLine(x.evidence, 160) + ' |'); }
    out.push('', '## 一次请求还想看的（材料里没有）', '');
    const need = parsed && Array.isArray(parsed.need) ? parsed.need : [];
    if (!need.length) out.push('（没有）'); else for (const n of need) out.push('- ' + oneLine(n, 200));
    if (parsed && parsed.summary) out.push('', '它自己说的：' + oneLine(parsed.summary, 400));
    out.push('', '## 每次运行', '', '| 次 | 用时 | 输出 token | 输入 token | 回复字数 | 结果 |', '|---|---|---|---|---|---|');
    runs.forEach((r, i) => out.push('| ' + (i + 1) + ' | ' + dur(r.ms) + ' | ' + r.out + ' | ' + r.input + ' | ' + r.chars + ' | ' + (r.ok ? '拿到结论' : '没拿到：' + oneLine(r.why, 120)) + ' |'));
    out.push('', '## 送了哪些材料', '', '| 材料 | 字数 | 状态 |', '|---|---|---|');
    for (const r of material.rows) out.push('| ' + oneLine(r[0], 100) + ' | ' + r[1] + ' | ' + (r[2] || '') + ' |');
    const file = path.resolve(val('--out', 'review-oneshot-' + job.id.slice(0, 8) + (TURNS ? '-turns' + TURNS : '') + '.md'));
    fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
    console.log('\n' + head.join('\n') + '\n\n报告：' + file + '（带问题原文和路径，带出内网前看一眼；上面这张表没有）');
  } finally { cleanup(tmp); }
}
/** 删临时目录。claude 退出后可能还有进程占着当前目录（2.1.259 实测，rmSync 报 EPERM）：不能因为这个让结果报错，文件先删掉，目录过一会儿再试 */
function cleanup(dir) {
  try { for (const n of fs.readdirSync(dir)) { try { fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* 还占着 */ } } } catch (e) { /* 目录没了 */ }
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch (e) { console.log('临时目录 ' + dir + ' 还有进程占着，没删掉，以后可以手动删。'); }
}

module.exports = { parseResult, parseScope, restore, undo, bestMatch, decisionsOf, changedNames, enclosingNames, declOf };
if (require.main === module) main();

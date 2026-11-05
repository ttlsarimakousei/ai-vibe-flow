'use strict';
/*
 * 审查和模型请求的耗时诊断（第 64、71 条，2026-11-05）。
 * 仓库主人看到审查子代理"一直读文件读 2 个小时"，路由上请求都正常返回、没有超时。要知道时间花在哪：请求次数、每个请求多慢、读了什么。
 * 这是单个文件，只用 Node 自带的模块，拷到内网电脑上直接跑，不用装套件，不发模型请求，不花 token。
 *
 *   node review-timing.js                       看最近 14 天的审查子代理和主会话
 *   node review-timing.js --days 3              只看最近 3 天
 *   node review-timing.js --project 关键字      只看目录名带这个关键字的项目
 *   node review-timing.js --session 会话号前缀  只看一个会话
 *   node review-timing.js --all-agents          别的子代理也算进来（没有审查子代理时用）
 *   node review-timing.js --anon                文件名、目录名、变更名换成哈希
 *   node review-timing.js --out 报告.md         报告写到哪（默认当前目录 review-timing-<时间>.md）
 *   node review-timing.js --dir <目录>          会话记录目录（默认 ~/.claude/projects）
 *   node review-timing.js --timeline 2          最慢的几个子代理列时间线（默认 2）
 *
 * 只读会话记录（<项目>/<会话>.jsonl、<项目>/<会话>/subagents/agent-*.jsonl），只写报告这一个文件。
 * 报告里有路径、次数、时间、token 数，没有文件内容、提示词、搜索词、命令参数。带出内网前看一眼，介意路径就加 --anon。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const ANON = has('--anon');
const ALL_AGENTS = has('--all-agents');

const TASK = /审查任务\s*[:：]\s*([0-9a-f]{24})\/([^\s`"，。]+)/;
const REVIEWER = /(^|:)(?:vk|ttls)-reviewer$/;
const SCOPE_FILE = /[\\/]\.vibe[\\/]reviews[\\/].*job-[0-9a-f]+[\\/][^\\/]+\.md$/i;
// Read 没给内容、只说文件没变：子代理没读过这个文件却拿到它，就会换着行号再读
const STUB = /unchanged since last read|unchanged since your last read/i;
const TOO_BIG = /exceeds maximum allowed|maximum allowed tokens/i;
// 不能只认"vibe-kit"：命令失败的输出里路径带它（Exit code 127 … vibe-kit/…）不是被拦
const BLOCKED = /\[vibe-kit|拦截编号|hook error|blocked by hook|denied by hook/i;
const MAX_BYTES = 400 * 1024 * 1024;

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const k = (n) => (n >= 10000 ? Math.round(n / 1000) : Math.round(n / 100) / 10);
const sec = (ms) => Math.round(ms / 1000);
const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'; };
const share = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
const slash = (p) => String(p || '').replace(/\\/g, '/');

/** 路径怎么显示：项目里的写相对路径，--anon 换成哈希、留扩展名 */
function nm(p, cwd) {
  const s = slash(p);
  if (ANON) return 'f' + hash(s.toLowerCase()) + path.extname(s);
  const c = slash(cwd);
  if (c && s.toLowerCase().startsWith(c.toLowerCase() + '/')) return s.slice(c.length + 1);
  const home = slash(os.homedir());
  if (home && s.toLowerCase().startsWith(home.toLowerCase() + '/')) return '~/' + s.slice(home.length + 1);
  return s;
}
/** 命令只留命令名：git 和 openspec 带子命令，node 带脚本文件名。参数里可能有口令、业务词，不进报告 */
function cmdHead(cmd) {
  const words = String(cmd || '').trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  const base = (w) => path.basename(slash(w).replace(/^["']|["']$/g, ''));
  const first = base(words[0] || '');
  if (/^(git|openspec)(\.exe)?$/i.test(first)) { const sub = words.slice(1).find((w) => !/^-/.test(w) && !/[\\/:]/.test(w)); return first + (sub ? ' ' + sub : ''); }
  if (/^(node|python3?|py)(\.exe)?$/i.test(first)) { const script = words.slice(1).find((w) => !/^-/.test(w)); return first + (script ? ' ' + base(script) : ''); }
  return first;
}
const textOf = (v) => { if (typeof v === 'string') return v; if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.content)) || '')).join(''); return ''; };

/** 一个会话记录文件 → 请求列表。请求的边界按顺序认：用户或工具结果之后第一条 assistant 开始一个新请求（有的网关 message.id 都一样，不能只靠它） */
function parseFile(file, kind) {
  const r = { file, kind, sessionId: '', agentId: '', meta: {}, versions: new Set(), models: new Map(), cwd: '', firstAt: 0, lastAt: 0, requests: [], errors: 0, compactions: 0, hooks: new Map(), firstText: '', stopBlocks: 0 };
  try { r.meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch (e) { /* 老版本没有 */ }
  const calls = new Map();
  let prevAt = 0; let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('{"type":"api-request-blob"')) continue;
    let e; try { e = JSON.parse(line); } catch (x) { continue; }
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (t && ['user', 'assistant', 'system', 'attachment'].includes(e.type)) { r.firstAt = r.firstAt || t; r.lastAt = Math.max(r.lastAt, t); }
    if (e.sessionId) r.sessionId = r.sessionId || e.sessionId;
    if (e.agentId) r.agentId = r.agentId || e.agentId;
    if (e.version) r.versions.add(e.version);
    if (e.cwd) r.cwd = r.cwd || e.cwd;
    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      if (m.model === '<synthetic>' || e.isApiErrorMessage) { r.errors++; cur = null; if (t) prevAt = t; continue; }
      if (!cur || (m.id && cur.id && cur.id !== m.id)) { cur = { id: m.id || '', start: prevAt || t, end: t, input: 0, cacheRead: 0, cacheNew: 0, out: 0, think: 0, text: 0, stop: '', tools: [] }; r.requests.push(cur); }
      if (t) cur.end = t;
      const u = m.usage || {};
      cur.input = Math.max(cur.input, u.input_tokens || 0); cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens || 0); cur.cacheNew = Math.max(cur.cacheNew, u.cache_creation_input_tokens || 0); cur.out = Math.max(cur.out, u.output_tokens || 0);
      if (m.stop_reason) cur.stop = m.stop_reason;
      if (m.model) r.models.set(m.model, (r.models.get(m.model) || 0) + 1);
      for (const c of [].concat(m.content || [])) {
        if (!c) continue;
        if (c.type === 'thinking') cur.think += String(c.thinking || '').length;
        else if (c.type === 'text') cur.text += String(c.text || '').length;
        else if (c.type === 'tool_use') { const call = { id: c.id, name: c.name, input: c.input || {}, chars: 0, isError: false, stub: false, tooBig: false, blocked: '', at: t, ms: -1, ver: e.version || '' }; cur.tools.push(call); calls.set(c.id, call); }
      }
      continue;
    }
    if (e.type === 'user' && e.message) {
      const content = e.message.content;
      if (!r.firstText) r.firstText = textOf(content);
      cur = null; if (t) prevAt = t;
      if (typeof content === 'string' && /^Stop hook feedback/i.test(content)) r.stopBlocks++;
      for (const c of Array.isArray(content) ? content : []) {
        if (!c) continue;
        if (c.type === 'text' && /^Stop hook feedback/i.test(String(c.text || ''))) r.stopBlocks++;
        if (c.type !== 'tool_result') continue;
        const call = calls.get(c.tool_use_id); if (!call) continue;
        const body = textOf(c.content);
        call.chars = body.length; call.isError = !!c.is_error; if (t && call.at) call.ms = t - call.at;
        if (call.name === 'Read') { call.stub = STUB.test(body.slice(0, 400)); call.tooBig = TOO_BIG.test(body.slice(0, 400)); if (SCOPE_FILE.test(String(call.input.file_path || ''))) call.text = body; }
        if (c.is_error && BLOCKED.test(body)) call.blocked = body.replace(/[\w.:-]*[\\/][^\s，。]*/g, '<路径>').slice(0, 46).replace(/\s+/g, ' ');
      }
      continue;
    }
    if (e.type === 'system') {
      if (e.subtype === 'api_error') r.errors++;
      if (e.subtype === 'compact_boundary') r.compactions++;
      if (e.subtype === 'stop_hook_summary' && e.preventedContinuation) r.stopBlocks++;
      continue;
    }
    if (e.type === 'attachment' && e.attachment && /^hook_/.test(String(e.attachment.type))) {
      const a = e.attachment;
      const size = [a.content, a.stdout, a.additionalContext, a.text, a.message, a.reason, a.blockingError && a.blockingError.blockingError].map(textOf).join('').length;
      const key = (a.hookEvent || '?') + ' / ' + (a.hookName ? String(a.hookName).replace(/^[^:]*:/, '') + ' / ' : '') + a.type;
      const o = r.hooks.get(key) || { n: 0, chars: 0 }; o.n++; o.chars += size; r.hooks.set(key, o);
    }
  }
  const m = TASK.exec(r.firstText);
  r.job = m ? m[1] : ''; r.lens = m ? m[2] : '';
  r.isReview = !!m || REVIEWER.test(String(r.meta.agentType || ''));
  const mode = /^模式[:：]\s*(\S+)/m.exec(r.firstText); r.mode = mode ? mode[1] : '';
  const ch = /^变更[:：]\s*(\S+)/m.exec(r.firstText); r.change = ch ? ch[1] : '';
  r.scope = parseScope(r);
  r.stats = statsOf(r);
  delete r.firstText;
  return r;
}
/** 范围文件的内容从记录里取（审完目录就删了）：要审的文件、涉及的目录 */
function parseScope(r) {
  const out = { read: 0, chars: 0, files: [], areas: [], recheck: /^模式[:：]\s*复审/m.test(r.firstText), afterWaitMs: 0, firstAt: 0 };
  let text = '';
  r.requests.forEach((q, i) => {
    for (const c of q.tools) {
      if (c.text === undefined) continue;
      out.read++; out.chars += c.chars; text += c.text; delete c.text;
      if (out.read === 1) { out.firstAt = q.end; const next = r.requests[i + 1]; if (next) out.afterWaitMs = next.end - next.start; }
    }
  });
  if (!text) return out;
  const body = text.replace(/^\s*\d+[\t→]/gm, '');
  const sec2 = (title) => { const m = new RegExp('^## ' + title + '\\s*$', 'm').exec(body); if (!m) return ''; const rest = body.slice(m.index + m[0].length); const n = rest.search(/^## /m); return n >= 0 ? rest.slice(0, n) : rest; };
  const norm = (s) => slash(s).trim().replace(/^\.\//, '').toLowerCase();
  const area = sec2('这次涉及的目录').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  out.areas = area ? area.split('、').map(norm).filter(Boolean) : [];
  for (const l of sec2('要审的文件').split('\n')) {
    if (!/^- /.test(l)) continue;
    const parts = l.slice(2).split('：');
    out.files.push(norm(parts[0].split('（')[0]));
    if (parts[1]) out.files.push(norm(parts[1]));
  }
  for (const m of body.matchAll(/^### (.+)$/gm)) out.files.push(norm(m[1].split('（')[0].split(' — ')[0]));
  return out;
}
function classOfRead(p, scope) {
  const s = slash(p).toLowerCase();
  if (SCOPE_FILE.test(p)) return 'scope';
  if (scope.files.some((f) => f && (s === f || s.endsWith('/' + f)))) return 'file';
  if (scope.areas.some((d) => s.includes('/' + d + '/'))) return 'area';
  if (/\/openspec\//.test(s)) return 'doc';
  return 'out';
}
function statsOf(r) {
  const o = { reads: 0, files: new Map(), ranges: new Map(), partial: 0, stubs: 0, tooBig: 0, readChars: 0, searches: 0, bash: 0, other: 0, tools: 0, errors: 0, inScope: 0, outScope: 0, outDirs: new Map(), bashHeads: new Map(), hasScope: r.scope.read > 0 };
  for (const q of r.requests) {
    for (const c of q.tools) {
      o.tools++;
      if (c.isError) o.errors++;
      if (c.name === 'Read') {
        o.reads++; o.readChars += c.chars;
        const p = String(c.input.file_path || ''); const key = slash(p).toLowerCase();
        const f = o.files.get(key) || { name: p, n: 0, chars: 0 }; f.n++; f.chars += c.chars; o.files.set(key, f);
        const range = key + '|' + (c.input.offset || 0) + '|' + (c.input.limit || 0); o.ranges.set(range, (o.ranges.get(range) || 0) + 1);
        if (c.input.offset || c.input.limit) o.partial++;
        if (c.stub) o.stubs++;
        if (c.tooBig) o.tooBig++;
        if (o.hasScope) { const cls = classOfRead(p, r.scope); if (cls === 'out') { o.outScope++; const d = path.dirname(slash(p)); o.outDirs.set(d, (o.outDirs.get(d) || 0) + 1); } else if (cls !== 'scope') o.inScope++; }
      } else if (c.name === 'Grep' || c.name === 'Glob') o.searches++;
      else if (c.name === 'Bash' || c.name === 'PowerShell') { o.bash++; const h = cmdHead(c.input.command); o.bashHeads.set(h, (o.bashHeads.get(h) || 0) + 1); } else o.other++;
    }
  }
  const lat = r.requests.map((q) => Math.max(0, q.end - q.start));
  const ctx = r.requests.map((q) => q.input + q.cacheRead + q.cacheNew);
  let toolMs = 0;
  r.requests.forEach((q, i) => { const n = r.requests[i + 1]; if (n && q.tools.length) toolMs += Math.max(0, n.start - q.end); });
  o.lat = lat; o.ctx = ctx; o.modelMs = sum(lat); o.toolMs = toolMs; o.totalMs = Math.max(0, r.lastAt - r.firstAt); o.otherMs = Math.max(0, o.totalMs - o.modelMs - toolMs);
  o.inSum = sum(ctx); o.outSum = sum(r.requests.map((q) => q.out)); o.thinkSum = sum(r.requests.map((q) => q.think)); o.cacheRead = sum(r.requests.map((q) => q.cacheRead));
  o.maxStop = r.requests.filter((q) => q.stop === 'max_tokens').length;
  o.repeat = sum([...o.ranges.values()].map((n) => n - 1));
  return o;
}

// ---------- 主会话的请求花在哪 ----------
function classOfTool(c) {
  const n = String(c.name || ''); const i = c.input || {}; const fp = slash(i.file_path || i.notebook_path || '').toLowerCase();
  if (n === 'Read') return '读文件';
  if (n === 'Grep' || n === 'Glob') return '搜索';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
    if (/tasks\.md$/.test(fp) && /- \[ \]/.test(String(i.old_string || '')) && /- \[x\]/i.test(String(i.new_string || ''))) return '打勾（Edit tasks.md）';
    if (/\/openspec\//.test(fp)) return '写需求文档';
    if (/\/\.vibe\//.test(fp)) return '写过程文件';
    return '写代码';
  }
  if (n === 'Bash' || n === 'PowerShell') {
    const s = String(i.command || '');
    const spec = /(?:^|[\s;&|"'\\/])openspec(?:\.js["']?)?\s+(status|instructions|new|list|show|validate|archive|init|change|spec|update|templates|schemas)\b/.exec(s);
    if (spec) return 'openspec ' + spec[1];
    const rev = /review\.js["']?\s+(prepare|run|status|cancel|resolve)\b/.exec(s);
    if (rev) return '审查脚本 ' + rev[1];
    if (/(workflow|plan|trace|feedback|lesson|checkpoint|doctor|diagnose)\.js/.test(s)) return '套件流程工具';
    if (/devserver\.js/.test(s)) return '起停服务';
    if (/scenario-run|probe-run|layout-tree|pixel-diff/.test(s)) return '看页面';
    if (/\bdb\.py\b|\bredis\.js\b/.test(s)) return '查库、redis';
    if (/commit\.js|\bgit\b[^|;&]*\b(add|commit)\b/.test(s)) return 'git 提交';
    if (/\bgit\b/.test(s)) return 'git 查询';
    if (/\b(mvnw?|gradlew?|npm|pnpm|yarn|cnpm|npx|tsc|vue-tsc|eslint|jest|vitest|pytest|javac|cargo|dotnet)\b|\bgo (build|test|vet)\b/.test(s)) return '编译测试';
    if (/\b(grep|rg|find|ls|cat|head|tail|sed|awk|wc|Get-Content|Select-String|Get-ChildItem|dir|type)\b/.test(s)) return 'shell 读文件';
    return '其它命令';
  }
  if (n === 'Agent' || n === 'Task') return '开子代理';
  if (n === 'AskUserQuestion') return '提问框';
  if (n === 'Skill' || n === 'SlashCommand') return '调技能';
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|TaskStop)$/.test(n)) return '待办';
  if (/^mcp__/.test(n)) return 'MCP';
  return n;
}

// ---------- 找文件 ----------
function findFiles(root, days, projectKey, sessionKey) {
  const out = []; const since = Date.now() - days * 86400000;
  const walk = (d, depth) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4 && !/^(tool-results|memory)$/.test(e.name)) walk(p, depth + 1); continue; }
      if (!/\.jsonl$/.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch (x) { continue; }
      if (st.mtimeMs < since || st.size > MAX_BYTES) continue;
      const rel = slash(path.relative(root, p));
      if (projectKey && !rel.split('/')[0].toLowerCase().includes(projectKey.toLowerCase())) continue;
      if (sessionKey && !rel.includes(sessionKey)) continue;
      out.push({ file: p, kind: /^agent-/.test(e.name) ? 'sub' : 'main' });
    }
  };
  walk(root, 0);
  return out;
}

// ---------- 报告 ----------
function table(heads, rows) { if (!rows.length) return ['（没有）']; return ['| ' + heads.join(' | ') + ' |', '|' + heads.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + r.join(' | ') + ' |')]; }
function bucketTable(list, label) {
  const edges = [[0, 20000, '<2 万'], [20000, 50000, '2–5 万'], [50000, 100000, '5–10 万'], [100000, 200000, '10–20 万'], [200000, Infinity, '≥20 万']];
  const rows = [];
  for (const [a, b, name] of edges) {
    const qs = list.filter((q) => { const c = q.input + q.cacheRead + q.cacheNew; return c >= a && c < b; });
    if (!qs.length) continue;
    const lat = qs.map((q) => q.end - q.start);
    rows.push([label, name, qs.length, sec(median(lat)), sec(pct(lat, 0.9)), Math.round(median(qs.map((q) => q.out))), share(sum(qs.map((q) => q.cacheRead)), sum(qs.map((q) => q.input + q.cacheRead + q.cacheNew)))]);
  }
  return rows;
}
function timeline(r, out) {
  const s = r.stats;
  out.push('', '### ' + (r.lens || r.meta.description || r.agentId) + '（' + dur(s.totalMs) + '，' + r.requests.length + ' 个请求）', '');
  if (r.scope.read) out.push('范围文件 ' + r.scope.chars + ' 字，读了 ' + r.scope.read + ' 次；第一次读在开始后 ' + dur(r.scope.firstAt - r.firstAt) + '，读完下一个请求等了 ' + dur(r.scope.afterWaitMs) + '。', '');
  const row = (q, i) => {
    const tools = q.tools.map((c) => c.name + (c.name === 'Read' ? ' ' + nm(c.input.file_path, r.cwd) + (c.input.offset || c.input.limit ? ' @' + (c.input.offset || 0) + '+' + (c.input.limit || '') : '') : c.name === 'Bash' || c.name === 'PowerShell' ? ' ' + cmdHead(c.input.command) : c.input.path ? ' ' + nm(c.input.path, r.cwd) : '') + '（' + k(c.chars) + 'K 字' + (c.stub ? '，内容没给' : '') + (c.isError ? '，出错' : '') + '）').join('；') || '（回复）';
    return [i + 1, dur(q.start - r.firstAt), sec(q.end - q.start), k(q.input + q.cacheRead + q.cacheNew), q.out, q.think, tools];
  };
  const qs = r.requests; const head = ['#', '开始', '等模型秒', '上下文K', '输出', '思考字', '工具（结果大小）'];
  if (qs.length <= 70) { out.push(...table(head, qs.map(row))); return; }
  out.push(...table(head, qs.slice(0, 50).map(row)), '', '（中间 ' + (qs.length - 65) + ' 个请求省略）', '', ...table(head, qs.slice(-15).map((q, i) => row(q, qs.length - 15 + i))));
}
function top(map, n) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }

function report(all, root, opts) {
  const mains = all.filter((r) => r.kind === 'main');
  const subs = all.filter((r) => r.kind === 'sub' && r.meta.agentType !== 'web-fetch');
  const agents = ALL_AGENTS ? subs : subs.filter((r) => r.isReview);
  const when = (q) => (q.start + q.end) / 2;
  for (const a of agents) for (const q of a.requests) { const t = when(q); q.conc = agents.filter((b) => b.firstAt <= t && t <= b.lastAt).length; }
  const subReq = agents.flatMap((a) => a.requests); const mainReq = mains.flatMap((a) => a.requests);
  const subLat = subReq.map((q) => q.end - q.start); const mainLat = mainReq.map((q) => q.end - q.start);
  const S = (fn) => sum(agents.map((a) => fn(a.stats)));
  const versions = new Set(); const subModels = new Map(); const mainModels = new Map();
  for (const a of all) { for (const v of a.versions) versions.add(v); const m = a.kind === 'main' ? mainModels : subModels; for (const [n, c] of a.models) m.set(n, (m.get(n) || 0) + c); }
  const out = ['# 审查和模型请求的耗时诊断', '', '生成于 ' + stamp(Date.now()) + '；最近 ' + opts.days + ' 天；主会话 ' + mains.length + ' 个，子代理 ' + subs.length + ' 个，算进来的' + (ALL_AGENTS ? '子代理' : '审查子代理') + ' ' + agents.length + ' 个。', '', 'Claude Code：' + ([...versions].sort().join('、') || '未知') + '。主会话模型：' + (top(mainModels, 3).map(([n, c]) => n + ' ' + c + ' 次').join('、') || '无') + '。子代理模型：' + (top(subModels, 3).map(([n, c]) => n + ' ' + c + ' 次').join('、') || '无') + '。'];
  if (!agents.length) out.push('', '**没找到审查子代理**（提示里带"审查任务："或类型是 vk-reviewer 的）。--days 放大，或者加 --all-agents 看别的子代理。下面主会话的数据照样有。');

  // 一眼看
  const totalMs = S((x) => x.totalMs); const modelMs = S((x) => x.modelMs); const toolMs = S((x) => x.toolMs);
  const ctxFirst = agents.map((a) => a.stats.ctx[0] || 0); const ctxLast = agents.map((a) => a.stats.ctx[a.stats.ctx.length - 1] || 0);
  const concRows = [1, 2, 3, 4].map((n) => { const qs = subReq.filter((q) => (n === 4 ? q.conc >= 4 : q.conc === n)); return qs.length ? [n === 4 ? '4 个以上' : n + ' 个', qs.length, sec(median(qs.map((q) => q.end - q.start))), k(median(qs.map((q) => q.input + q.cacheRead + q.cacheNew)))] : null; }).filter(Boolean);
  out.push('', '## 一眼看', '');
  if (agents.length) {
    out.push('- 每个子代理：请求中位 ' + median(agents.map((a) => a.requests.length)) + ' 个，最多 ' + Math.max(...agents.map((a) => a.requests.length)) + ' 个；时长中位 ' + dur(median(agents.map((a) => a.stats.totalMs))) + '，最长 ' + dur(Math.max(...agents.map((a) => a.stats.totalMs))) + '。');
    out.push('- 每个请求等模型：子代理中位 ' + sec(median(subLat)) + ' 秒（P90 ' + sec(pct(subLat, 0.9)) + '，最长 ' + sec(Math.max(0, ...subLat)) + '）；主会话中位 ' + sec(median(mainLat)) + ' 秒（P90 ' + sec(pct(mainLat, 0.9)) + '）。');
    out.push('- 时间花在：等模型 ' + share(modelMs, totalMs) + '，跑工具 ' + share(toolMs, totalMs) + '，其它 ' + share(Math.max(0, totalMs - modelMs - toolMs), totalMs) + '。');
    out.push('- 每个请求发 ' + (S((x) => x.tools) / Math.max(1, subReq.length)).toFixed(2) + ' 个工具（接近 1 = 一次一个，读几个文件就是几次请求）。');
    out.push('- Read ' + S((x) => x.reads) + ' 次，不同文件 ' + S((x) => x.files.size) + ' 个，同一段重复读 ' + S((x) => x.repeat) + ' 次，分段读 ' + S((x) => x.partial) + ' 次，内容没给（"没变"） ' + S((x) => x.stubs) + ' 次，超大报错 ' + S((x) => x.tooBig) + ' 次。搜索 ' + S((x) => x.searches) + ' 次，命令 ' + S((x) => x.bash) + ' 次。');
    if (agents.some((a) => a.stats.hasScope)) out.push('- 读文件的范围：范围内 ' + S((x) => x.inScope) + ' 次，范围外 ' + S((x) => x.outScope) + ' 次（' + share(S((x) => x.outScope), S((x) => x.outScope) + S((x) => x.inScope)) + '）。');
    out.push('- 上下文：第一个请求中位 ' + k(median(ctxFirst)) + 'K token，最后一个请求中位 ' + k(median(ctxLast)) + 'K；累计送进模型 ' + k(S((x) => x.inSum)) + 'K，输出 ' + k(S((x) => x.outSum)) + 'K；提示缓存占输入 ' + share(S((x) => x.cacheRead), S((x) => x.inSum)) + '（0% = 网关没缓存）。');
    out.push('- 思考 ' + k(S((x) => x.thinkSum)) + 'K 字；停在输出上限 ' + S((x) => x.maxStop) + ' 次；API 报错 ' + sum(agents.map((a) => a.errors)) + ' 次；工具报错 ' + S((x) => x.errors) + ' 次。');
  } else out.push('- 主会话每个请求等模型：中位 ' + sec(median(mainLat)) + ' 秒（P90 ' + sec(pct(mainLat, 0.9)) + '）。');

  // 一次审查一行
  const jobs = new Map();
  for (const a of agents) { if (!a.job) continue; const j = jobs.get(a.job) || []; j.push(a); jobs.set(a.job, j); }
  out.push('', '## 每次审查', '');
  out.push(...table(['开始', '变更', '模式', '子代理', '总时长', '请求合计', 'Read', '范围外', '累计入K', '出K'], [...jobs.values()].sort((a, b) => b[0].firstAt - a[0].firstAt).slice(0, 25).map((list) => {
    const first = Math.min(...list.map((a) => a.firstAt)); const last = Math.max(...list.map((a) => a.lastAt));
    const name = list[0].change || ''; const T = (fn) => sum(list.map((a) => fn(a.stats)));
    return [stamp(first), ANON ? hash(name) : name, list[0].mode, list.length, dur(last - first), sum(list.map((a) => a.requests.length)), T((x) => x.reads), T((x) => x.outScope), k(T((x) => x.inSum)), k(T((x) => x.outSum))];
  })));

  out.push('', '## 每个子代理（最慢的 30 个）', '');
  const slow = agents.slice().sort((a, b) => b.stats.totalMs - a.stats.totalMs);
  out.push(...table(['开始', '名字', '请求', '总时长', '等模型', '跑工具', '中位秒', '最长秒', '工具/请求', 'Read/不同', '重复', '分段', '没给', '搜索', '命令', '范围外', '首K', '末K', '累计入K', '出K', '思考K字', '错'], slow.slice(0, 30).map((a) => {
    const s = a.stats;
    return [stamp(a.firstAt), ANON ? hash(a.lens || a.agentId) : a.lens || String(a.meta.description || a.agentId).slice(0, 20), a.requests.length, dur(s.totalMs), dur(s.modelMs), dur(s.toolMs), sec(median(s.lat)), sec(Math.max(0, ...s.lat)), (s.tools / Math.max(1, a.requests.length)).toFixed(1), s.reads + '/' + s.files.size, s.repeat, s.partial, s.stubs, s.searches, s.bash, s.outScope, k(s.ctx[0] || 0), k(s.ctx[s.ctx.length - 1] || 0), k(s.inSum), k(s.outSum), k(s.thinkSum), a.errors + s.errors];
  })));

  out.push('', '## 请求速度：和上下文大小的关系', '');
  out.push(...table(['谁', '上下文（token）', '请求数', '中位秒', 'P90 秒', '中位输出', '缓存占输入'], bucketTable(mainReq, '主会话').concat(bucketTable(subReq, '子代理'))));
  out.push('', '## 请求速度：和同时在跑的子代理数的关系', '');
  out.push(...table(['同时在跑', '请求数', '中位秒', '中位上下文K'], concRows));

  // 读了什么
  const files = new Map(); const outDirs = new Map(); const heads = new Map();
  for (const a of agents) {
    for (const f of a.stats.files.values()) { const o = files.get(nm(f.name, a.cwd)) || { n: 0, chars: 0 }; o.n += f.n; o.chars += f.chars; files.set(nm(f.name, a.cwd), o); }
    for (const [d, n] of a.stats.outDirs) { const key = nm(d, a.cwd); outDirs.set(key, (outDirs.get(key) || 0) + n); }
    for (const [h, n] of a.stats.bashHeads) heads.set(h, (heads.get(h) || 0) + n);
  }
  out.push('', '## 子代理读得最多的文件', '');
  out.push(...table(['文件', '读了几次', '读入 K 字'], [...files.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 15).map(([n, o]) => [n, o.n, k(o.chars)])));
  if (outDirs.size) { out.push('', '## 读到范围外的目录', ''); out.push(...table(['目录', '次数'], top(outDirs, 12))); }
  if (heads.size) { out.push('', '## 子代理跑的命令', ''); out.push(...table(['命令', '次数'], top(heads, 12))); }
  // 工具本身多久：Read 没挂套件的钩子，Bash 挂了两个，两边一比看得出钩子占多少
  const toolRows = [];
  for (const [who, list] of [['子代理', subReq], ['主会话', mainReq]]) {
    const by = new Map();
    for (const q of list) for (const c of q.tools) if (c.ms >= 0) { const a = by.get(c.name) || []; a.push(c.ms); by.set(c.name, a); }
    for (const [n, a] of [...by.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 6)) toolRows.push([who, n, a.length, (median(a) / 1000).toFixed(1), (pct(a, 0.9) / 1000).toFixed(1), dur(sum(a))]);
  }
  out.push('', '## 工具本身花多久', '', '从模型发出工具调用到结果记下来。Read 没挂套件的钩子，Bash 挂了两个。', '');
  out.push(...table(['谁', '工具', '次数', '中位秒', 'P90 秒', '合计'], toolRows));
  // 同一台电脑上几个版本一比，看得出慢是版本带来的还是电脑的（第 71 条：一台 Read 中位 6.4 秒，另一台 0.0 秒）
  const byVer = new Map();
  for (const q of subReq.concat(mainReq)) for (const c of q.tools) if (c.ms >= 0 && /^(Read|Edit|Write|Bash|Grep)$/.test(c.name)) { const v = byVer.get(c.ver || '未知') || {}; (v[c.name] = v[c.name] || []).push(c.ms); byVer.set(c.ver || '未知', v); }
  const cell = (a) => (a ? a.length + ' 次 ' + (median(a) / 1000).toFixed(1) + ' 秒' : '-');
  out.push('', '### 按 Claude Code 版本（次数和中位秒）', '');
  out.push(...table(['版本', 'Read', 'Edit', 'Write', 'Grep', 'Bash'], [...byVer.entries()].sort().map(([v, o]) => [v, cell(o.Read), cell(o.Edit), cell(o.Write), cell(o.Grep), cell(o.Bash)])));
  // 配置里挂了哪些钩子：只列时机、匹配和脚本文件名，不带参数
  const hookRows = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    let s = null; try { s = JSON.parse(fs.readFileSync(path.join(opts.cfg, name), 'utf8')); } catch (e) { continue; }
    for (const [ev, list] of Object.entries(s.hooks || {})) for (const g of [].concat(list || [])) for (const x of [].concat((g && g.hooks) || [])) {
      const words = String((x && x.command) || (x && x.url) || (x && x.type) || '').match(/"[^"]*"|\S+/g) || [];
      const script = words.map((w) => w.replace(/^"|"$/g, '')).filter((w) => /\.(js|mjs|cjs|py|sh|ps1|cmd|bat|exe)$/i.test(w)).pop() || words[0] || '';
      hookRows.push([name, ev, (g && g.matcher) || '（全部）', ANON ? hash(script) : path.basename(slash(script))]);
    }
  }
  out.push('', '### 配置里挂的钩子（用户级）', '');
  out.push(...table(['文件', '时机', '匹配', '脚本'], hookRows));

  if (slow.length) { out.push('', '## 时间线（最慢的 ' + Math.min(opts.timeline, slow.length) + ' 个子代理）'); for (const a of slow.slice(0, opts.timeline)) timeline(a, out); }

  // 第一点：主会话的模型请求花在哪
  const cls = new Map(); const wasted = new Map(); let plain = 0; let plainIn = 0; let blocked = 0; let stops = 0; let compacts = 0;
  const hooks = new Map(); const shellHeads = new Map(); const otherHeads = new Map();
  for (const m of mains) {
    stops += m.stopBlocks; compacts += m.compactions;
    for (const [key, o] of m.hooks) { const h = hooks.get(key) || { n: 0, chars: 0 }; h.n += o.n; h.chars += o.chars; hooks.set(key, h); }
    for (const q of m.requests) {
      const input = q.input + q.cacheRead + q.cacheNew;
      if (!q.tools.length) { plain++; plainIn += input; continue; }
      const name = classOfTool(q.tools[0]);
      const o = cls.get(name) || { req: 0, tools: 0, input: 0, ms: 0 }; o.req++; o.input += input; o.ms += q.end - q.start; cls.set(name, o);
      for (const c of q.tools) {
        const n = classOfTool(c); const x = cls.get(n) || { req: 0, tools: 0, input: 0, ms: 0 }; x.tools++; cls.set(n, x);
        if (c.blocked) { blocked++; wasted.set(c.blocked, (wasted.get(c.blocked) || 0) + 1); }
        if (n === 'shell 读文件' || n === '其它命令') { const m = n === '其它命令' ? otherHeads : shellHeads; const h = cmdHead(c.input.command); m.set(h, (m.get(h) || 0) + 1); }
      }
    }
  }
  const reqTotal = mainReq.length; const inTotal = sum(mainReq.map((q) => q.input + q.cacheRead + q.cacheNew));
  out.push('', '## 主会话的模型请求花在哪', '', '一个请求算到它发的第一个工具头上。累计输入 = 这些请求每次送进模型的上下文加起来。', '');
  const rows = [...cls.entries()].sort((a, b) => b[1].req - a[1].req).map(([n, o]) => [n, o.req, share(o.req, reqTotal), o.tools, share(o.input, inTotal), dur(o.ms)]);
  rows.push(['纯回复（没发工具）', plain, share(plain, reqTotal), 0, share(plainIn, inTotal), '-']);
  out.push(...table(['做什么', '请求', '占请求', '工具次数', '占累计输入', '等模型合计'], rows));
  if (shellHeads.size) out.push('', '"shell 读文件"里：' + top(shellHeads, 10).map(([n, c]) => n + ' ' + c).join('，') + '。');
  if (otherHeads.size) out.push('', '"其它命令"里：' + top(otherHeads, 12).map(([n, c]) => n + ' ' + c).join('，') + '。');
  out.push('', '- 合计 ' + reqTotal + ' 个请求，累计输入 ' + k(inTotal) + 'K token，提示缓存占 ' + share(sum(mainReq.map((q) => q.cacheRead)), inTotal) + '；压缩 ' + compacts + ' 次。');
  out.push('- 被钩子拦下的工具调用 ' + blocked + ' 次（每次多一个请求）；收工钩子让模型接着干 ' + stops + ' 次（每次多一个请求）。');
  if (wasted.size && !ANON) { out.push('', '### 拦得最多的（提示开头）', ''); out.push(...table(['提示开头', '次数'], top(wasted, 10))); }
  if (hooks.size) { out.push('', '### 钩子送给模型的字数', ''); out.push(...table(['钩子', '次数', '合计字', '平均字'], [...hooks.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 15).map(([n, o]) => [n, o.n, o.chars, Math.round(o.chars / Math.max(1, o.n))]))); }
  return out.join('\n') + '\n';
}

function main() {
  if (has('--help') || has('-h')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const root = val('--dir', path.join(cfg, 'projects'));
  const opts = { days: Number(val('--days', 14)) || 14, timeline: Number(val('--timeline', 2)) || 0, cfg };
  const list = findFiles(root, opts.days, val('--project', ''), val('--session', ''));
  if (!list.length) { console.log('没找到会话记录：' + root + '（最近 ' + opts.days + ' 天）。--dir 指定目录，或者 --days 放大。'); return; }
  const all = []; let bad = 0;
  for (const it of list) { try { all.push(parseFile(it.file, it.kind)); } catch (e) { bad++; } }
  const text = report(all, root, opts);
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const file = path.resolve(val('--out', 'review-timing-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.md'));
  fs.writeFileSync(file, text, 'utf8');
  const at = text.indexOf('## 一眼看'); const end = text.indexOf('## 每次审查');
  console.log(text.slice(0, end > 0 ? end : at > 0 ? at : 2000).trim());
  console.log('\n报告：' + file + (bad ? '（' + bad + ' 个文件读不了，跳过）' : ''));
}

module.exports = { parseFile, classOfTool, cmdHead, classOfRead, report };
if (require.main === module) main();

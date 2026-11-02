'use strict';
/*
 * 审查怎么分轮（问题表第 37 条，2026-11-02 用户定的）。起因：一份提案审了 8 轮，问题数还在 5—11 条之间晃：
 *   每轮都从头全量审、不带上一轮的结论，0 条问题才算过，提示不分阶段，模型把实现细节全往提案里塞，越改越长、问题越多，过程也没留下来。
 * 现在：
 *   第一轮：2～3 个角度同时审（并发的独立请求，不是子代理），一次看全。材料超过 3 批的用 2 个角度。
 *   后面的轮：只审修改点。送上一轮的问题和这次的改动（和上一轮审过的内容比），只问"改对了没有""改出新问题没有"。
 *     改动超过六成（整个重写）按第一轮算；上一轮没审到的文件整份送。
 *     没处理、文件也没改过的问题不问模型，照旧算没解决：不会因为再审一次就消失。
 *   按阶段给提示：提案只审需求、范围、验收和事实，算法步骤这些归 design。后面的点只审新写的文档，前面的只用来核对是否对齐。
 *   通过标准：没有 P1、P2 就算过，P3 记下来，不为它再审一轮。
 *   不收敛就停：连续两轮 P1、P2 没减少，停止这个点的自动循环（flow-policy.js 的 stalled）。
 *   过程脚本记：每轮追加到 .vibe/reviews/<变更>/审查记录.md，不靠模型自觉，也不会被下一轮盖掉。
 * 上一轮的内容和问题存在 <结果文件>.snapshot.json（.vibe 不进仓库；文本遮过口令）。这一轮没审成（失败、取消、审查期间文件变了）不动它。
 * 只用 Node 自带的模块。
 */
const fs = require('fs');
const path = require('path');

const SEVERITY_NOTE = 'severity：P1 上线会出事故、丢数据或有安全漏洞；P2 功能做不到、会出错；P3 说法、写法、可有可无的改进。别把 P3 说成 P1、P2。';
const STAGE = {
  proposal: '这是提案，只审提案该管的事：要解决什么问题说清了没有；做什么、不做什么划清了没有；验收条件能不能核对；写的事实和材料对不对得上（说存在的文件、接口、配置是不是真的那样）；有没有明显漏掉的场景。不审实现细节：算法步骤、字段规则、日志格式、魔数、错误文案这些归 design，提案里写了也不要挑它们的毛病，缺了也不要求补。',
  specs: '这是规格，只审规格该管的事：每条需求有没有写清场景，WHEN、THEN 能不能核对；和提案的范围对不对得上；异常、空数据、无权限这些场景漏没漏。不审怎么实现。',
  design: '这是设计：技术方案能不能落地；决策有没有写默认怎么做和理由；和规格的场景对不对得上；边界和异常怎么处理；有没有绕过或回归的风险；验收用例是否覆盖了规格的场景。',
  tasks: '这是任务清单，只审任务清单该管的事：是不是只写实现、一项是不是一次提交的量、顺序依赖对不对、有没有落不到设计上的任务、设计里的决策有没有任务去做。不重新审设计本身。',
  code: '这是代码：规格的场景做到了没有；有没有改错、改漏；连带影响；边界和异常。只审这次改动和它直接影响的地方。',
};
const ROLE_NOTE = '材料里带 role 的（上游文档、需求文档、参考材料）只用来核对，不审它本身；只有和要审的内容对不上时才报，file 写要审的那份。';
const LENSES = {
  doc: [
    { name: '事实和范围', text: '这一次你只看一个角度：事实和范围。写的事实和材料对不对得上，做什么、不做什么划清了没有，有没有超出或漏掉需求。' },
    { name: '场景和风险', text: '这一次你只看一个角度：场景和风险。异常、空数据、无权限、并发、重复提交有没有考虑到，验收能不能核对，有没有绕过或回归的风险。' },
    { name: '自洽和对齐', text: '这一次你只看一个角度：自洽和对齐。文档自己前后矛盾没有，和上游文档对不对得上，别人拿到能不能照着做。' },
  ],
  code: [
    { name: '需求和连带影响', text: '这一次你只看一个角度：需求和连带影响。规格的每条场景做到了没有；改了这里，依赖它的地方有没有跟着改；有没有和项目约定冲突。' },
    { name: '边界和异常', text: '这一次你只看一个角度：边界和异常。空值、空列表、重复提交、并发、异常分支、事务、超长输入、时区和日期。' },
    { name: '安全和假验证', text: '这一次你只看一个角度：安全和假验证。权限、注入、路径穿越、敏感信息；测试是不是真的覆盖到了改动。' },
  ],
};
const RECHECK = '这是复审，不是重新审一遍。只做两件事：1. "上一轮的问题"逐条看现在改对了没有：改对了不报；没改对、只改了一部分的照旧报，severity 不变。2. 材料里这次的改动有没有改出新问题（改错了、改漏了、和上下文对不上）。没改过的内容不要审，看着有问题也不报。"已处理"里的问题已经定过了，不要再报。新问题只报 P1、P2。';

const P3 = /^P3$/i;
/** 挡通过的问题有几条：除了 P3 都算（模型没写 severity 的当 P2） */
function blocking(issues) { return (issues || []).filter((x) => !P3.test(String((x && x.severity) || ''))).length; }
function countBySeverity(issues) {
  const c = { P1: 0, P2: 0, P3: 0 };
  for (const x of issues || []) { const s = String((x && x.severity) || '').toUpperCase(); if (s === 'P1') c.P1++; else if (s === 'P3') c.P3++; else c.P2++; }
  return c;
}
function stageText(mode, point) {
  if (mode === 'proposal') return STAGE[point] || '这是需求文档：' + STAGE.proposal;
  return STAGE.code;
}
/** 第一轮几个角度：配置 reviewLenses（不做开关，手写的值给测试和排查用，默认 3）；材料超过 3 批的最多 2 个 */
function lensesFor(mode, batchCount, cfg) {
  const want = Number(cfg && cfg.reviewLenses);
  const n = Math.min(Number.isFinite(want) && want >= 1 ? Math.floor(want) : 3, batchCount > 3 ? 2 : 3);
  return n <= 1 ? [] : (mode === 'proposal' ? LENSES.doc : LENSES.code).slice(0, n);
}

// ---------- 比两份文本 ----------
const lines = (s) => String(s || '').replace(/\r\n/g, '\n').split('\n');
/** 按行比。返回 { text: 带上下文的改动（- 改之前，+ 改之后）, changed: 改了几行 }。一样的返回 changed: 0 */
function lineDiff(oldText, newText, context) {
  const ctx = context === undefined ? 3 : context;
  const a = lines(oldText); const b = lines(newText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const A = a.slice(s, a.length - e); const B = b.slice(s, b.length - e);
  if (!A.length && !B.length) return { text: '', changed: 0 };
  const ops = []; // [类型, 文本, 改后的行号]
  const n = A.length; const m = B.length;
  if (n * m <= 4000000) {
    // 最长公共子序列：只留这一段，前后相同的上面已经去掉
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i], s + j + 1]); i++; j++; }
      else if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { ops.push(['+', B[j], s + j + 1]); j++; }
      else { ops.push(['-', A[i], s + j + 1]); i++; }
    }
  } else {
    // 太大了不细比：这一段整个算改过
    for (const l of A) ops.push(['-', l, s + 1]);
    B.forEach((l, k) => ops.push(['+', l, s + k + 1]));
  }
  const adds = ops.filter((o) => o[0] === '+').length; const dels = ops.filter((o) => o[0] === '-').length;
  const show = new Set();
  ops.forEach((o, k) => { if (o[0] !== ' ') for (let x = Math.max(0, k - ctx); x <= Math.min(ops.length - 1, k + ctx); x++) show.add(x); });
  const out = [];
  // 开头、结尾相同的几行也当上下文
  for (let k = Math.max(0, s - ctx); k < s; k++) out.push('  ' + a[k]);
  let last = -1;
  ops.forEach((o, k) => {
    if (!show.has(k)) return;
    if (last >= 0 && k > last + 1) out.push('@@ 改后第 ' + o[2] + ' 行附近 @@');
    out.push(o[0] + ' ' + o[1]);
    last = k;
  });
  for (let k = a.length - e; k < Math.min(a.length, a.length - e + ctx); k++) out.push('  ' + a[k]);
  return { text: '@@ 改后第 ' + (s + 1) + ' 行附近 @@\n' + out.join('\n'), changed: Math.max(adds, dels) };
}

// ---------- 上一轮 ----------
const snapshotFile = (reportFile) => String(reportFile).replace(/\.json$/i, '') + '.snapshot.json';
const baseKey = (base) => JSON.stringify([].concat(base || []).filter(Boolean));
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
/** 上一轮：{ files, issues, decisions, covered, round }。没有、不是同一个变更（归档后重建）、基线换了，返回 null */
function readPrior(reportFile, born, base) {
  const p = readJson(snapshotFile(reportFile));
  if (!p || !p.files || typeof p.files !== 'object') return null;
  if (born && p.born && Math.abs(Number(p.born) - Number(born)) > 2000) return null;
  if (baseKey(base) !== String(p.base === undefined ? baseKey(base) : p.base)) return null;
  return { files: p.files, issues: Array.isArray(p.issues) ? p.issues : [], decisions: Array.isArray(p.decisions) ? p.decisions : [], covered: Array.isArray(p.covered) ? p.covered : [], round: Number(p.round) || 1 };
}
function writeSnapshot(store, reportFile, o) {
  return store.atomicWrite(snapshotFile(reportFile), { version: 1, born: o.born || 0, base: baseKey(o.base), at: Date.now(), round: o.round, files: o.files, issues: o.issues, decisions: [], covered: o.covered });
}
/** 登记处理结果时记进上一轮：下一轮才知道哪些定过了 */
function noteDecisions(store, reportFile, decisions) {
  const f = snapshotFile(reportFile);
  const p = readJson(f);
  if (!p) return false;
  p.decisions = decisions;
  return store.atomicWrite(f, p);
}
function chunkItems(file, text, root, source, role) {
  const parts = [];
  let chunk = '';
  for (const row of String(text).split(/(?<=\n)/)) {
    if (chunk && chunk.length + row.length > 40000) { parts.push(chunk); chunk = ''; }
    for (let i = 0; i < row.length; i += 40000) { if (i) { parts.push(chunk); chunk = ''; } chunk += row.slice(i, i + 40000); }
  }
  if (chunk || !parts.length) parts.push(chunk);
  return parts.map((t, i) => Object.assign({ file, root, source, text: t, startLine: 1, part: i + 1, parts: parts.length }, role ? { role } : {}));
}
function batchesOf(items) {
  const out = []; let batch = []; let size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { out.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) out.push(batch);
  return out;
}
const CLOSED = new Set(['rejected', 'accepted', 'deferred']);
const brief = (x) => ({ severity: x.severity, file: x.file, line: x.line, problem: x.problem, fix: x.fix });
/**
 * 这一轮审什么。prior 是 null：第一轮，{ scoped: false }。不然比出改过的地方：
 * { scoped: true, items, batches, open: 上一轮没定、文件改过的问题（送去核对）, closed: 定过的, carried: 没定、文件也没改的（照旧算没解决）, kept: 没改过、已经审过的文件, changed }。
 * 改动超过六成：{ scoped: false, why }
 */
function planRound(material, prior) {
  if (!prior) return { scoped: false };
  const covered = new Set(prior.covered);
  const items = []; const changed = []; const kept = [];
  let changedLines = 0; let totalLines = 0;
  for (const [file, cur] of material.currents) {
    const n = lines(cur.text).length;
    totalLines += n;
    const old = prior.files[file];
    if (old === undefined || !covered.has(file)) { changed.push(file); changedLines += n; items.push(...chunkItems(file, cur.text, cur.root, cur.source, cur.role)); continue; }
    if (old === cur.text) { kept.push(file); continue; }
    const d = lineDiff(old, cur.text);
    changed.push(file); changedLines += d.changed;
    items.push(...chunkItems(file, '这次的改动（- 是改之前，+ 是改之后，其余是上下文）：\n' + d.text, cur.root, cur.source, cur.role));
  }
  for (const file of Object.keys(prior.files)) {
    if (material.currents.has(file)) continue;
    changed.push(file);
    items.push(...chunkItems(file, '这个文件已经删除', '', file));
  }
  if (totalLines && changedLines / totalLines > 0.6) return { scoped: false, why: '改动超过六成，按第一轮全量审' };
  const decided = new Map(prior.decisions.map((d) => [d.id, d]));
  const open = []; const closed = []; const carried = [];
  for (const x of prior.issues) {
    const d = decided.get(x.id);
    if (d && CLOSED.has(d.action)) { closed.push(Object.assign(brief(x), { action: d.action, reason: d.reason })); continue; }
    // 修了的要核对；没登记的也要：文件改过的送去问，没改过的不用问
    if (changed.includes(x.file)) open.push(brief(x));
    else { const c = Object.assign({}, x); delete c.id; carried.push(c); }
  }
  return { scoped: true, items, batches: batchesOf(items), open, closed, carried, kept, changed };
}
// ---------- 几个角度的结果合起来 ----------
function bigrams(s) { const t = String(s || '').replace(/[\s，,。.；;：:、"'“”（）()]+/g, ''); const out = new Set(); for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2)); return out; }
function alike(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size) >= 0.55;
}
const rank = (x) => { const s = String((x && x.severity) || '').toUpperCase(); return s === 'P1' ? 1 : s === 'P3' ? 3 : 2; };
/** 同一个文件、说的是同一件事的合成一条，留最严重的那个说法 */
function mergeIssues(list) {
  const out = [];
  for (const x of list || []) {
    const hit = out.findIndex((y) => String(y.file) === String(x.file) && alike(y.problem, x.problem));
    if (hit < 0) out.push(x);
    else if (rank(x) < rank(out[hit])) out[hit] = x;
  }
  return out;
}
/** 第一轮要带给这一步的：上游审查标了"留给 design"的问题 */
function carryover(folder, points) {
  const out = [];
  for (const point of points) {
    const p = readJson(path.join(folder, 'proposal-' + point + '.snapshot.json'));
    if (!p || !Array.isArray(p.decisions)) continue;
    for (const d of p.decisions) { if (d.action !== 'deferred') continue; const x = (p.issues || []).find((i) => i.id === d.id); if (x) out.push({ from: point, problem: x.problem, fix: x.fix }); }
  }
  return out;
}
// ---------- 审查记录 ----------
const LOG_NAME = '审查记录.md';
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
function appendLog(folder, text) {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const f = path.join(folder, LOG_NAME);
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# 审查记录\n\n脚本自动记的，每轮一节，不会被下一轮盖掉。只在本机（.vibe 不进仓库）。业务上的变化照旧写 revisions.md。\n');
    fs.appendFileSync(f, text);
    return f;
  } catch (e) { return ''; }
}
function stamp(at) { const d = new Date(at || Date.now()); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
/** 一轮审完：轮次、怎么审的、模型、用时、每条问题 */
function logRound(folder, o) {
  const c = countBySeverity(o.issues);
  const out = ['', '## 第 ' + o.round + ' 轮 · ' + (o.point || o.mode) + ' · ' + stamp(o.at), ''];
  out.push('- 怎么审的：' + (o.scoped ? '只审修改点（改过 ' + (o.changed || []).length + ' 个文件：' + (o.changed || []).join('、') + '）' : '全量' + (o.lenses > 1 ? '，' + o.lenses + ' 个角度同时审' : '')) + (o.why ? '（' + o.why + '）' : ''));
  out.push('- 结果：' + o.status + (o.reason ? '（' + oneLine(o.reason) + '）' : '') + '；P1 ' + c.P1 + ' 条、P2 ' + c.P2 + ' 条、P3 ' + c.P3 + ' 条；用时 ' + Math.round((o.spentMs || 0) / 1000) + ' 秒' + (o.model ? '；模型 ' + o.model : ''));
  for (const x of o.issues || []) out.push('- ' + x.id + ' ' + (x.severity || 'P2') + ' ' + x.file + (x.line ? ':' + x.line : '') + '：' + oneLine(x.problem));
  return appendLog(folder, out.join('\n') + '\n');
}
/** 登记处理结果 */
function logDecisions(folder, point, findings) {
  const ACTION = { fixed: '修了', rejected: '不成立', accepted: '接受不改', deferred: '留给后面的文档' };
  const out = ['', '### 处理结果 · ' + (point || '') + ' · ' + stamp(), ''];
  for (const d of findings || []) out.push('- ' + d.id + ' ' + (ACTION[d.action] || d.action) + '：' + oneLine(d.reason));
  return appendLog(folder, out.join('\n') + '\n');
}

module.exports = { SEVERITY_NOTE, ROLE_NOTE, RECHECK, blocking, countBySeverity, stageText, lensesFor, lineDiff, snapshotFile, readPrior, writeSnapshot, noteDecisions, planRound, batchesOf, mergeIssues, carryover, appendLog, logRound, logDecisions, LOG_NAME };

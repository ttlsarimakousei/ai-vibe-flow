'use strict';
/*
 * 溯源：人工测试、用户反馈发现问题时，找回当初是哪个 OpenSpec 变更、哪项任务改的这里。只读，不改任何东西。
 *   node trace.js <出问题的文件>[:行号] [--dir <项目目录>]
 *
 * 归档之后变更目录还在（openspec/changes/archive/<日期>-<名字>/，proposal、design、tasks、revisions 都在），
 * 规格已经并进 openspec/specs/；代码的提交在 git 里。三样东西本来就在，缺的是把它们对上：
 *   1. 哪些变更的 tasks.md / design.md / proposal.md 提到了这个文件（按相对路径对，对不上再按文件名），列出对应的任务
 *   2. 这个文件最近的提交、这一行最后是哪个提交改的（git blame）
 *   3. 按时间对：提交落在哪个变更的"提案 ~ 归档"时间段里；提交信息里写了"源自 <变更名>"的直接认
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let changeRoots = null;
try { changeRoots = require('../lib/session.js').changeRoots; } catch (e) { /* 单独拷出来用也行，只看当前目录 */ }

const args = process.argv.slice(2);
const dirArg = (() => { const i = args.indexOf('--dir'); return i >= 0 ? args[i + 1] : ''; })();
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');
if (!target) { console.log('用法：node trace.js <出问题的文件>[:行号] [--dir <项目目录>]'); process.exit(2); }
const lm = target.match(/^(.*?)(?::(\d+))?$/);
const cwd = path.resolve(dirArg || process.cwd());
const file = path.resolve(cwd, lm[1]);
const line = lm[2] ? Number(lm[2]) : 0;
if (!fs.existsSync(file)) { console.log('找不到文件：' + file); process.exit(2); }

const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
function gitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 12; i++) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}
function git(repo, a) {
  try { return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false'].concat(a), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { return null; }
}
const repo = gitRoot(path.dirname(file));

// ---------- 1. 哪些变更提到了这个文件 ----------
const roots = new Set();
for (const d of [cwd, path.dirname(file), repo].filter(Boolean)) {
  if (changeRoots) for (const c of changeRoots(d)) roots.add(path.resolve(c));
  else { const c = path.join(d, 'openspec', 'changes'); if (fs.existsSync(c)) roots.add(c); }
}
// 文件相对各个可能的根目录的写法：仓库根、放 openspec 的那一层（壳子）、当前目录
const relForms = new Set();
for (const base of [repo, cwd].concat([...roots].map((c) => path.dirname(path.dirname(c))))) {
  if (!base) continue;
  const rel = path.relative(base, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) relForms.add(norm(rel));
}
const base = path.basename(file).toLowerCase();
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; } };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

function scanChange(dir, name, archivedAt) {
  const hits = [];
  let byName = false;
  const tasks = read(path.join(dir, 'tasks.md'));
  let done = 0; let total = 0;
  const lookIn = (label, text) => {
    text.split(/\r?\n/).forEach((l, i) => {
      const low = norm(l);
      const m = l.match(/^\s*[-*]\s*\[([ xX])\]\s*(?:(\d+(?:\.\d+)*)[.)]?\s*)?(.*)$/);
      if (label === 'tasks.md' && m) { total++; if (m[1] !== ' ') done++; }
      let hit = [...relForms].some((r) => low.includes(r));
      if (!hit && new RegExp('(^|[^\\w.])' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w])').test(low)) { hit = true; byName = true; }
      if (!hit) return;
      hits.push(label === 'tasks.md' && m ? { where: 'tasks.md', task: m[2] || '', done: m[1] !== ' ', text: m[3].trim() } : { where: label, lineNo: i + 1, text: l.trim() });
    });
  };
  lookIn('tasks.md', tasks);
  lookIn('design.md', read(path.join(dir, 'design.md')));
  lookIn('proposal.md', read(path.join(dir, 'proposal.md')));
  if (!hits.length) return null;
  const caps = dirs(path.join(dir, 'specs'));
  return { name, dir, archivedAt, done, total, hits, byName, caps };
}
const found = [];
for (const c of roots) {
  for (const n of dirs(c)) if (n.toLowerCase() !== 'archive') { const r = scanChange(path.join(c, n), n, ''); if (r) found.push(Object.assign(r, { changes: c })); }
  for (const n of dirs(path.join(c, 'archive'))) {
    const m = n.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    const r = scanChange(path.join(c, 'archive', n), m ? m[2] : n, m ? m[1] : '?');
    if (r) found.push(Object.assign(r, { changes: c, archDir: n }));
  }
}

// ---------- 2. git：这个文件的提交、这一行最后是谁改的 ----------
let commits = [];
let blame = null;
if (repo) {
  const rel = path.relative(repo, file);
  const log = git(repo, ['log', '--format=%h%x09%ad%x09%s', '--date=short', '-n', '20', '--', rel]);
  if (log) commits = log.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [h, d, ...s] = l.split('\t'); return { h, d, s: s.join('\t') }; });
  if (line) {
    const b = git(repo, ['blame', '-L', line + ',' + line, '--porcelain', '--', rel]);
    if (b) {
      const h = (b.match(/^([0-9a-f]{7,40}) /m) || [])[1] || '';
      const t = Number((b.match(/^author-time (\d+)/m) || [])[1] || 0);
      const s = (b.match(/^summary (.*)$/m) || [])[1] || '';
      if (h) blame = { h: h.slice(0, 7), d: t ? new Date(t * 1000).toISOString().slice(0, 10) : '', s, uncommitted: /^0+$/.test(h) };
    }
  }
}

// ---------- 3. 按时间和提交信息把提交对到变更上 ----------
const today = new Date().toISOString().slice(0, 10);
for (const f of found) {
  // 时间段：这个变更目录第一次出现在 git 里（提案提交）～ 归档那天；目录不在 git 里就用目录的创建时间
  const osRepo = gitRoot(f.changes);
  let start = '';
  if (osRepo) {
    const paths = [path.relative(osRepo, path.join(f.changes, f.name))].concat(f.archDir ? [path.relative(osRepo, path.join(f.changes, 'archive', f.archDir))] : []);
    const out = git(osRepo, ['log', '--format=%ad', '--date=short', '--'].concat(paths));
    if (out) { const ds = out.trim().split(/\r?\n/).filter(Boolean).sort(); start = ds[0] || ''; }
  }
  if (!start) { try { const st = fs.statSync(f.archDir ? path.join(f.changes, 'archive', f.archDir) : path.join(f.changes, f.name)); start = new Date(st.birthtimeMs || st.mtimeMs).toISOString().slice(0, 10); } catch (e) { start = ''; } }
  f.start = start;
  f.end = f.archivedAt && f.archivedAt !== '?' ? f.archivedAt : today;
}
const namesRe = (n) => new RegExp('(^|[^\\w-])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w-])', 'i');
function ownerOf(c) {
  const byMsg = found.filter((f) => namesRe(f.name).test(c.s));
  if (byMsg.length) return byMsg.map((f) => f.name + '（提交信息里写了）');
  return found.filter((f) => f.start && c.d >= f.start && c.d <= f.end).map((f) => f.name + '（按时间段）');
}

// ---------- 输出 ----------
const show = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
console.log('溯源：' + show(file) + (line ? '（第 ' + line + ' 行）' : ''));
console.log('');
if (!roots.size) console.log('这里没有 openspec（当前目录、文件所在的仓库都没找到 openspec/changes）。只能看 git 记录。');
else if (!found.length) console.log('没有哪个 OpenSpec 变更（进行中的、已归档的）的 tasks.md / design.md / proposal.md 提到过这个文件。它可能是不走提案的小改动改的，看下面的 git 记录。');
else {
  console.log('提到过这个文件的 OpenSpec 变更：');
  for (const f of found) {
    const state = f.archivedAt ? '已归档 ' + f.archivedAt : '进行中 ' + f.done + '/' + f.total;
    console.log('  ' + f.name + '（' + state + (f.start ? '，' + f.start + ' 开始' : '') + '）  ' + show(f.archDir ? path.join(f.changes, 'archive', f.archDir) : path.join(f.changes, f.name)) + (f.byName ? '  〔有的只按文件名对上，核对一下是不是同一个文件〕' : ''));
    for (const h of f.hits.slice(0, 8)) console.log('    ' + (h.where === 'tasks.md' ? '任务 ' + (h.task || '?') + ' ' + (h.done ? '[x]' : '[ ]') + ' ' + h.text : h.where + ' 第 ' + h.lineNo + ' 行：' + h.text).slice(0, 200));
    if (f.caps.length) console.log('    规格：' + f.caps.map((c) => 'openspec/specs/' + c + '/spec.md').join('、') + (f.archivedAt ? '（归档时已并入，那里是现在的规格）' : '（变更里的是增量，归档后并入 openspec/specs/）'));
  }
}
console.log('');
if (!repo) console.log('这个文件不在 git 仓库里，没有提交记录可查。');
else {
  if (blame) console.log('第 ' + line + ' 行最后一次改动：' + (blame.uncommitted ? '还没提交' : blame.h + ' ' + blame.d + ' ' + blame.s + (ownerOf(blame).length ? '  → ' + ownerOf(blame).join('、') : '')));
  if (commits.length) {
    console.log('这个文件最近的提交（新的在前）：');
    for (const c of commits) { const o = ownerOf(c); console.log('  ' + c.h + ' ' + c.d + ' ' + c.s + (o.length ? '  → ' + o.join('、') : '')); }
  } else console.log('这个文件还没有提交记录。');
}
console.log('');
console.log('下一步：读对应变更的 design.md、revisions.md 和现在的 openspec/specs/，判断是代码没做到规格（直接修，提交写"fix: <问题>（源自 <变更名> <任务号>）"），还是规格本身漏了、写错了（新开一个变更改规格，proposal 的 Why 写明源自哪个变更、测试发现了什么）。拿不准是哪一种，把溯源结果给用户看，让用户定。归档目录不要改。');

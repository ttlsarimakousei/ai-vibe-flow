'use strict';
/*
 * 审查材料里脚本先查好的东西（第 72 条，2026-11-05）。审查改成脚本调 claude -p、不带工具，一次看完（仓库主人定的：内网两台电脑的报告看到子代理的时间几乎全花在一步步反复想上）。
 * 子代理以前自己 grep、读文件核对的，能确定的这里查好一起送：
 *   文档点名的类、方法、表在代码里的位置，第一处带前后几行；一处都没搜到的名字（"想当然"最常见的来源）。
 *   改到的方法在别的文件里哪里用到（连带影响）。
 * 还管按请求上限分批：网关对单次请求体有上限（docs/claude-code-facts.md：约 1 MB），一次放不下就分几批，每批一个请求，都送到（第 45 条：不设文件上限）。
 * 只用 Node 自带的模块，git 查不到就当没有。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REQUEST_CHARS = 240000; // 一个请求最多送这么多字
const FILE_CHARS = 40000; // 一个文件超过这么多字：改动的只送差异
const ROLE_CHARS = 60000; // 分批时每批带的需求文档最多这么多字
const FACT_CHARS = 40000;
const SECRET = /(^|[\\/])(secrets\.json|router-data|\.env(?:\.[^/\\]*)?|db-crud\.ini|redis\.json|login\.json)([\\/]|$)/i;
const KEYWORD = /^(if|for|while|switch|catch|return|new|super|this|else|function|class|async|await|void|public|private|protected|static|final|try|throw|typeof)$/;

function git(root, args) { const r = spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 }); return r.status === 0 ? String(r.stdout || '') : ''; }
/** 要搜的仓库：给的几个，加上项目目录本身所在的仓库、它下面一层的子项目（壳子） */
function reposOf(project, roots) {
  const out = new Set((roots || []).map(String));
  const top = git(project, ['rev-parse', '--show-toplevel']).trim(); if (top) out.add(top);
  try { for (const e of fs.readdirSync(project, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(project, e.name, '.git'))) out.add(path.join(project, e.name)); } catch (e) { /* 没有 */ }
  const seen = new Set();
  return [...out].filter((r) => { const k = String(r).replace(/\\/g, '/').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
/** 文档点名的名字：反引号里的、驼峰的、大写下划线的。按出现次数排 */
function symbolsOf(text) {
  const c = new Map();
  const bump = (s) => { if (s.length >= 5 && s.length <= 60) c.set(s, (c.get(s) || 0) + 1); };
  for (const m of String(text).matchAll(/`([^`\n]{4,80})`/g)) for (const w of m[1].split(/[^A-Za-z0-9_]+/)) if (/[a-z][A-Z]|[A-Za-z]_[A-Za-z]|^[A-Z][a-z0-9]+[A-Z]/.test(w)) bump(w);
  for (const m of String(text).matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) bump(m[0]);
  for (const m of String(text).matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) bump(m[0]);
  for (const m of String(text).matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) bump(m[0]);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}
/** 一个仓库里一次 git grep 查完这批名字（一个名字一条命令，大仓库在 Windows 上要等很久）。返回 名字 → 命中的行 */
function grepAll(root, names, excludes) {
  const map = new Map(names.map((n) => [n, []]));
  if (!names.length) return map;
  const out = git(root, ['grep', '-n', '-w', '-F', '-I'].concat(names.flatMap((n) => ['-e', n]), ['--', '.'], (excludes || []).map((x) => ':(exclude)' + x)));
  for (const line of out.split('\n')) {
    if (!line || SECRET.test(line.split(':')[0])) continue;
    const words = new Set((line.slice(line.indexOf(':') + 1).match(/[A-Za-z0-9_]+/g) || []));
    for (const n of names) if (words.has(n) && map.get(n).length < 200) map.get(n).push(line);
  }
  return map;
}
function symbolFacts(docs, repos) {
  const blocks = []; const absent = []; let size = 0;
  const names = symbolsOf(docs).slice(0, 40);
  const found = repos.map((root) => ({ root, map: grepAll(root, names, ['openspec', '.vibe']) }));
  for (const name of names) {
    if (size > FACT_CHARS) break;
    let total = 0; const shown = [];
    for (const { root, map } of found) {
      const hits = map.get(name);
      if (!hits.length) continue;
      total += hits.length;
      hits.slice(0, 2).forEach((h, i) => {
        const m = /^(.+?):(\d+):/.exec(h);
        if (!m || i > 0) { shown.push(h.slice(0, 200)); return; }
        try { const all = fs.readFileSync(path.join(root, m[1]), 'utf8').split('\n'); const at = Number(m[2]); shown.push(m[1] + ':' + at + '\n' + all.slice(Math.max(0, at - 6), at + 5).map((l) => '  ' + l.slice(0, 200)).join('\n')); } catch (e) { shown.push(h.slice(0, 200)); }
      });
      for (const h of hits.slice(2, 6)) shown.push(h.slice(0, 200));
    }
    if (!total) { absent.push(name); continue; }
    const block = '# ' + name + '（' + total + ' 处）\n' + shown.join('\n');
    blocks.push(block); size += block.length;
  }
  return { text: blocks.join('\n\n'), absent };
}
/** 差异里改到的方法名 */
function changedNames(diff) {
  const names = new Set();
  for (const l of String(diff).split('\n')) {
    if (!/^[-+]/.test(l) || /^(---|\+\+\+)/.test(l)) continue;
    for (const m of l.matchAll(/(?:\b[\w<>,[\]]+\s+|\bfunction\s+|\bdef\s+)([A-Za-z_]\w{3,})\s*\(/g)) if (!KEYWORD.test(m[1])) names.add(m[1]);
    const arrow = /\b(?:const|let|var)\s+([A-Za-z_]\w{3,})\s*=\s*(?:async\s*)?\(/.exec(l); if (arrow) names.add(arrow[1]);
  }
  return [...names];
}
function declOf(line) {
  const t = String(line || '').trim();
  if (!t || /^(if|for|while|switch|catch|return|else|try|new|throw|await|\/\/|\*|\/\*)\b/.test(t) || /;\s*$/.test(t)) return '';
  const arrow = /\b(?:const|let|var)\s+([A-Za-z_]\w{3,})\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.exec(t);
  if (arrow) return arrow[1];
  const m = /\b([A-Za-z_]\w{3,})\s*\([^()]*\)?\s*(?:throws\b[^{]*)?\{?\s*$/.exec(t);
  return m && !KEYWORD.test(m[1]) ? m[1] : '';
}
/** 改动落在哪些方法里：大部分改动在方法体里，定义那一行没动 */
function enclosingNames(diff, text) {
  const names = new Set(); const lines = String(text).split('\n');
  let at = 0;
  for (const l of String(diff).split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { at = Number(h[1]) - 1; continue; }
    if (/^-/.test(l)) continue;
    if (/^\+/.test(l)) { for (let i = at; i >= 0 && i > at - 300; i--) { const n = declOf(lines[i]); if (n) { names.add(n); break; } } }
    at++;
  }
  return [...names];
}
function callers(names, repos, own) {
  const out = [];
  const ownKeys = own.map((f) => String(f).replace(/\\/g, '/').toLowerCase());
  const list = [...names].slice(0, 40);
  for (const root of repos) {
    const map = grepAll(root, list);
    for (const n of list) {
      const hits = map.get(n).filter((l) => !ownKeys.includes(path.resolve(root, l.split(':')[0]).replace(/\\/g, '/').toLowerCase())).map((l) => l.slice(0, 200));
      if (hits.length) out.push('# ' + n + '（' + hits.length + ' 处）\n' + hits.slice(0, 12).join('\n'));
    }
  }
  return out.join('\n').slice(0, FACT_CHARS);
}
const DIFF_HEAD = '基线差异：\n'; const CURRENT_HEAD = '\n当前文件：\n';
/** 代码的材料是"基线差异 + 当前文件"：拆开 */
function splitCode(text) {
  const t = String(text);
  const at = t.indexOf(CURRENT_HEAD);
  if (!t.includes(DIFF_HEAD) || at < 0) return { diff: '', current: t };
  return { diff: t.slice(t.indexOf(DIFF_HEAD) + DIFF_HEAD.length, at), current: t.slice(at + CURRENT_HEAD.length) };
}
/** material.items（一个文件可能几片）合成一个文件一条。太大的文件：改动的只留差异 */
function entriesOf(items) {
  const map = new Map();
  for (const it of items) { const e = map.get(it.file) || { file: it.file, role: it.role, text: '' }; e.text += it.text; map.set(it.file, e); }
  for (const e of map.values()) { const c = splitCode(e.text); if (c.diff && c.current.length > FILE_CHARS) { e.text = DIFF_HEAD + c.diff + '\n（文件太大，只送差异）'; } }
  return [...map.values()];
}
/** 分批：一批一个请求。要审的按顺序装，需求文档每批都带（分批时截到 ROLE_CHARS）。放得下就一批 */
function packsOf(items, limit) {
  const max = limit || REQUEST_CHARS;
  const all = entriesOf(items);
  if (all.reduce((n, e) => n + e.text.length, 0) <= max) return [all];
  const roles = []; let left = ROLE_CHARS;
  for (const e of all.filter((x) => x.role)) { if (left <= 0) break; roles.push(e.text.length > left ? Object.assign({}, e, { text: e.text.slice(0, left) + '\n……（后面截掉）' }) : e); left -= e.text.length; }
  const roleSize = roles.reduce((n, e) => n + e.text.length, 0);
  const packs = []; let cur = []; let size = 0;
  for (const e of all.filter((x) => !x.role)) {
    let rest = e.text; let part = 1;
    while (rest.length) {
      const room = max - roleSize - size;
      if (room < 2000 && cur.length) { packs.push(cur); cur = []; size = 0; continue; }
      const piece = rest.slice(0, Math.max(room, 2000));
      cur.push(Object.assign({}, e, { text: piece, part: piece.length < e.text.length ? part : 0 }));
      size += piece.length; rest = rest.slice(piece.length); part++;
    }
  }
  if (cur.length) packs.push(cur);
  return packs.length ? packs.map((p) => p.concat(roles)) : [roles];
}
const renderEntry = (e) => '=== ' + e.file + (e.role ? '（' + e.role + '，只用来核对，不审它本身）' : '') + (e.part ? '（第 ' + e.part + ' 段）' : '') + ' ===\n' + e.text;
/** 定角度数用的大小：只算要审的。代码按差异算（整个文件不算），只用来核对的文档不算：大文件改几行不用开 3 个角度（第 73 条） */
function reviewChars(items) {
  let n = 0;
  for (const e of entriesOf(items)) { if (e.role) continue; const c = splitCode(e.text); n += c.diff ? c.diff.length : c.current.length; }
  return n;
}
/** 第一轮要带的事实：文档点名的、改到的方法哪里用到 */
function factsOf(mode, items, project, roots) {
  const repos = reposOf(project, roots);
  const entries = entriesOf(items);
  const parts = [];
  const docs = entries.filter((e) => mode === 'proposal' || e.role).map((e) => e.text).join('\n');
  if (mode === 'code') {
    const names = new Set(); const own = [];
    for (const it of items) { if (it.role) continue; if (it.source) own.push(it.source); }
    for (const e of entries.filter((x) => !x.role)) { const c = splitCode(e.text); for (const n of changedNames(c.diff).concat(enclosingNames(c.diff, c.current))) names.add(n); }
    const used = callers(names, repos, own);
    if (used) parts.push('## 脚本查的：改到的方法在别的文件里哪里用到（git grep，每个最多 12 条）\n\n' + used);
  }
  const f = symbolFacts(docs, repos);
  if (f.text) parts.push('## 脚本查的：文档点名的类、方法、表在代码里的位置（第一处带前后几行）\n\n' + f.text);
  if (f.absent.length) parts.push('## 脚本查的：文档点名、但代码里一处都没搜到的名字（表名、字段名可能只在数据库里）\n\n' + f.absent.join('、'));
  return parts.join('\n\n');
}

module.exports = { reviewChars, grepAll, REQUEST_CHARS, reposOf, symbolsOf, symbolFacts, changedNames, declOf, enclosingNames, callers, splitCode, entriesOf, packsOf, renderEntry, factsOf };

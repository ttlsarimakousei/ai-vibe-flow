'use strict';
/*
 * 大需求的计划 openspec/plan.md：读、刷新进度、缺什么、提案产物快照。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readConfig } = require('./session-config');
const { changeRoots, listChanges, changeNames, archivedChanges } = require('./session-projects');
const { readState, writeState, normKey } = require('./session-state');
const { normTicks, artifactFiles } = require('./session-proposal');
const { codeReviewIssue } = require('./session-review');

// ===================== 大需求的计划：openspec/plan.md =====================
// 一个大需求拆成几个变更做，模型下次怎么知道哪些做完了？靠 plan.md：每个大任务一节（## 名字、探索记录：路径、模块 | 变更名 | 状态 | 说明 的表）。
// 状态不靠人记：会话开头的汇总按 changes/ 和 changes/archive/ 的实际情况算。钩子只算不写（不动跟踪文件），文件里的状态列跑 tools/plan.js 才更新。
// 老的 plan.md 没有分节，整张表算一个大任务（lib/big-task.js 按老任务算）。
/**
 * 这一格是不是 change 名（问题表第 51 条）：OpenSpec 的变更名只能是英文、数字加连字符。
 * 别的（未开始、待定、—、订单导出）是还没建变更的占位，目录真在才算；tbd、todo 这些英文占位不算。
 */
const ENGLISH_PLACEHOLDER = /^(tbd|todo|none|na|pending|wip|done)$/i;
function isChangeName(name, openspecDir) {
  if (/^[\w.-]*[a-z0-9][\w.-]*$/i.test(name)) return !ENGLISH_PLACEHOLDER.test(name);
  const changes = path.join(openspecDir, 'changes');
  try { if (fs.existsSync(path.join(changes, name))) return true; } catch (e) { /* 当不是 */ }
  try { return fs.readdirSync(path.join(changes, 'archive')).some((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name); } catch (e) { return false; }
}
function readPlan(openspecDir) {
  const file = path.join(openspecDir, 'plan.md');
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const rows = [];
  const sections = [];
  let section = null;
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) { section = { name: h[1], explore: '', line: i }; sections.push(section); cols = null; continue; }
    const ex = /^探索记录[：:]\s*(.+?)\s*$/.exec(l);
    if (ex) { if (section) section.explore = ex[1]; cols = null; continue; }
    if (!/^\s*\|/.test(l)) { cols = null; continue; }
    const cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim());
    if (!cols) { const c = cells.findIndex((x) => /变更|change/i.test(x) && !/状态|status/i.test(x)); const s = cells.findIndex((x) => /状态|status/i.test(x)); if (c >= 0 && s >= 0) cols = { change: c, status: s }; continue; }
    if (cells.every((x) => /^:?-*:?$/.test(x))) continue;
    const name = (cells[cols.change] || '').replace(/`/g, '').trim();
    if (!name || !isChangeName(name, openspecDir)) continue;
    rows.push({ line: i, name, status: cells[cols.status] || '', cells, cols, task: section ? section.name : '' });
  }
  // 只认这一行：\s 会跨行，"# 计划"后面紧跟表时会把表头当标题（问题表第 50 条）
  const title = (/^#[ \t]+(?:计划[：:]?)?[ \t]*(.*)$/m.exec(text) || [])[1] || '';
  return { file, eol, lines, rows, sections, title: title.trim() };
}

/** 计划展示任务进度与审查门槛；任务全勾不等于获准归档。 */
function planStatusOf(name, changesDir) {
  const dir = path.join(changesDir, name);
  try {
    const t = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
    const done = (t.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
    const todo = (t.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
    if (done + todo === 0) return '提案中';
    if (todo === 0) {
      // 自动改成按会话开以后，这里不知道是哪个会话（复审 V14）：审过一轮、还没收尾的写"待审查"，从没审过的照旧写"待用户验收"
      let started = false; try { const P = require('./flow-policy'); started = P.points(dir, 'code').some((p) => !!P.record(dir, p).status); } catch (e) { started = false; }
      const pending = started && codeReviewIssue(dir);
      return '已完成 ' + done + '/' + done + (pending ? '，待审查或处理意见' : '，待用户验收并确认归档');
    }
    return (done ? '进行中 ' : '已提案 ') + done + '/' + (done + todo);
  } catch (e) { /* 没有 tasks.md */ }
  if (fs.existsSync(dir)) return '提案中';
  try {
    const hit = fs.readdirSync(path.join(changesDir, 'archive')).filter((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name).sort().pop();
    if (hit) return '已归档 ' + ((hit.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0]);
  } catch (e) { /* 没有 archive */ }
  return '未开始';
}

/** 计算计划最新状态；钩子只读，plan.js 显式传 write 才写回并随本次工作提交。 */
function refreshPlan(openspecDir, write) {
  const p = readPlan(openspecDir);
  if (!p || !p.rows.length) return null;
  const changesDir = path.join(openspecDir, 'changes');
  let changed = false; let archived = 0; const active = []; let next = '';
  const byTask = new Map();
  for (const r of p.rows) {
    const s = planStatusOf(r.name, changesDir);
    if (!byTask.has(r.task)) byTask.set(r.task, { name: r.task, total: 0, archived: 0, active: [], next: '' });
    const t = byTask.get(r.task);
    t.total++;
    if (/^已归档/.test(s)) { archived++; t.archived++; }
    else if (/^(进行中|已完成|已提案|提案中)/.test(s)) { active.push(r.name + '（' + s + '）'); t.active.push(r.name + '（' + s + '）'); }
    else { if (!next) next = r.name; if (!t.next) t.next = r.name; }
    if (s !== r.status) { r.cells[r.cols.status] = s; p.lines[r.line] = '| ' + r.cells.join(' | ') + ' |'; changed = true; }
  }
  if (changed && write) { try { fs.writeFileSync(p.file, p.lines.join(p.eol)); } catch (e) { /* 写不了就只汇总 */ } }
  return { file: p.file, total: p.rows.length, archived, active, next, changed, tasks: [...byTask.values()] };
}

function planSummary(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) { const s = refreshPlan(path.dirname(changes)); if (s) out.push(s); }
  return out;
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
  const lines = ['# 计划', '', '## <大任务的名字>', '', '<一两句话：这个大任务要做什么，PRD 在哪。>', '', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(rows.map((n) => '| <模块> | ' + n + ' | | |'), ['']);
  fs.writeFileSync(file, lines.join('\n'));
  refreshPlan(openspecDir, true);
  return { file, created: true, rows };
}

const safeName = (s) => String(s).trim().replace(/[\\/:*?"<>|\s]+/g, '-');
const EXPLORE_TEMPLATE = (name, changes) => ['# 探索记录：' + name, '', '写给接手的会话：换一个新会话，读公共几节和要做的 change 那一节，不用再问用户就能写 proposal。具体改哪些文件、任务清单不写在这里，开始这个 change 时才写。', '',
  '## 原话和材料', '<!-- 用户的原话、PRD 和材料的路径 -->', '', '## 定了的', '<!-- 决定和理由，用户说的写原话 -->', '', '## 否了的', '<!-- 否掉的方案和为什么 -->', '', '## 还没定的', '<!-- 写了就不能开工；定了就挪到"定了的" -->', '',
  '## 现状', '<!-- 读过哪些路径，看到了什么 -->', '', '## 范围', '<!-- 做什么、不做什么。需求、apply、自测都对着这一节，没写的不加 -->', '', '## 跨 change 约定', '<!-- 业务规则、接口、数据结构 -->', '']
  .concat(changes.flatMap((c) => ['## change: ' + c, '<!-- 目标、边界（做什么、不做什么）、依赖谁、留给后面的接口、要的验收场景 -->', '']), ['## 整体验收用例', '<!-- 所有 change 都做完后，一起跑的用例 -->', '', '## 落地偏差', '<!-- 每做完一个 change 追加：和上面写的不一样的地方 -->', '']).join('\n');

/** 探索时建大任务：plan.md 加一节、建探索记录。已经有的不动，表里缺的 change 补上。tools/plan.js new 调 */
function planAddTask(openspecDir, name, changes) {
  const file = path.join(openspecDir, 'plan.md');
  const base = safeName(name);
  const rel = 'explore/' + base + '.md';
  let p = readPlan(openspecDir);
  if (!p) { fs.mkdirSync(openspecDir, { recursive: true }); fs.writeFileSync(file, '# 计划\n'); p = readPlan(openspecDir); }
  const row = (c) => '| | ' + c + ' | | |';
  const sec = p.sections.find((s) => s.name === name);
  let text = fs.readFileSync(file, 'utf8');
  const eol = p.eol;
  if (!sec) {
    text = text.replace(/\s*$/, eol) + eol + ['## ' + name, '', '探索记录：' + rel, '', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(changes.map(row)).join(eol) + eol;
  } else {
    const have = new Set(p.rows.filter((r) => r.task === name).map((r) => r.name));
    const add = changes.filter((c) => !have.has(c));
    if (add.length) {
      const lines = text.split(/\r?\n/);
      const own = p.rows.filter((r) => r.task === name);
      const at = own.length ? own[own.length - 1].line + 1 : sec.line + 1;
      lines.splice(at, 0, ...(own.length ? add.map(row) : ['', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(add.map(row))));
      text = lines.join(eol);
    }
  }
  fs.writeFileSync(file, text);
  const explore = path.resolve(openspecDir, (sec && sec.explore) || rel);
  let created = false;
  if (!fs.existsSync(explore)) { fs.mkdirSync(path.dirname(explore), { recursive: true }); fs.writeFileSync(explore, EXPLORE_TEMPLATE(name, changes)); created = true; }
  return { plan: file, explore, created };
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

module.exports = { readPlan, planStatusOf, refreshPlan, planSummary, planMissingInfo, planInit, planAddTask, planUnlisted, artifactHash, snapshotArtifacts };

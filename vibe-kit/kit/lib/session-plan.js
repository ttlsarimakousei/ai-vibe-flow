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
const { codeReviewIssue, reviewLoopIssue } = require('./session-review');

// ===================== 大需求的计划：openspec/plan.md =====================
// 一个大需求拆成几个变更做，做完一个归档一个，模型下次怎么知道哪些做完了？靠 plan.md 这张表：模块 | 变更名 | 状态 | 说明。
// 状态不靠人记：会话开头的汇总按 changes/ 和 changes/archive/ 的实际情况算。钩子只算不写（不动跟踪文件），文件里的状态列跑 tools/plan.js 才更新。
function readPlan(openspecDir) {
  const file = path.join(openspecDir, 'plan.md');
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const rows = [];
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*\|/.test(l)) { cols = null; continue; }
    const cells = l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((s) => s.trim());
    if (!cols) { const c = cells.findIndex((x) => /变更|change/i.test(x)); const s = cells.findIndex((x) => /状态|status/i.test(x)); if (c >= 0 && s >= 0) cols = { change: c, status: s }; continue; }
    if (cells.every((x) => /^:?-*:?$/.test(x))) continue;
    const name = (cells[cols.change] || '').replace(/`/g, '').trim();
    if (!name) continue;
    rows.push({ line: i, name, status: cells[cols.status] || '', cells, cols });
  }
  return { file, eol, lines, rows };
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
      const cfg = readConfig();
      // 自动改成按会话开以后，这里不知道是哪个会话（复审 V14）：审过一轮、还没收尾的写"待审查"，从没审过的照旧写"待用户验收"
      let started = false; try { const P = require('./flow-policy'); started = P.points(dir, 'code').some((p) => !!P.record(dir, p).status); } catch (e) { started = false; }
      const pending = started && codeReviewIssue(dir) || (cfg.reviewLoop && reviewLoopIssue('code', dir, cfg));
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
  for (const r of p.rows) {
    const s = planStatusOf(r.name, changesDir);
    if (/^已归档/.test(s)) archived++;
    else if (/^(进行中|已完成|已提案|提案中)/.test(s)) active.push(r.name + '（' + s + '）');
    else if (!next) next = r.name;
    if (s !== r.status) { r.cells[r.cols.status] = s; p.lines[r.line] = '| ' + r.cells.join(' | ') + ' |'; changed = true; }
  }
  if (changed && write) { try { fs.writeFileSync(p.file, p.lines.join(p.eol)); } catch (e) { /* 写不了就只汇总 */ } }
  return { file: p.file, total: p.rows.length, archived, active, next, changed };
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
  const lines = ['# 计划：<大需求的名字>', '', '<一两句话：这个大需求要做什么，PRD 在哪。>', '', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(rows.map((n) => '| <模块> | ' + n + ' | | |'), ['']);
  fs.writeFileSync(file, lines.join('\n'));
  refreshPlan(openspecDir, true);
  return { file, created: true, rows };
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

module.exports = { readPlan, planStatusOf, refreshPlan, planSummary, planMissingInfo, planInit, planUnlisted, artifactHash, snapshotArtifacts };

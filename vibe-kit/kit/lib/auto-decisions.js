'use strict';
/*
 * 到点替用户定的事（问题表第 94 条，仓库主人 2026-11-20 定的）：提问框、权限确认框没人回，hooks/ask-timeout.js 到点替他收掉的，
 * 每一件记进启动 Claude 的那个目录的 .vibe/auto-decisions.json（.vibe 不进仓库；换会话、死机、压缩都还在）。
 *   ask    提问框到点，让模型自己定：钩子只知道问了什么、有哪些选项，定了什么由模型跑 tools/decided.js 补上（chose、why）
 *   apply  需求审过问"开始实施 / 先不实施"的那一问：到点开工了，或者对不上开工的条件、停下等用户
 *   allow  权限确认框到点替他点了允许
 *   deny   权限确认框到点没放行，留给他（推送、发布、查库和 redis、关服务、还原不了的删）
 * 什么时候列给用户（仓库主人选的"大任务全部做完时"，中间停下不列）：
 *   属于大任务的：plan.md 表里的变更任务都做完了（big-task.phaseOf 到了 selftest、verify、archive、done）
 *   不在哪个大任务里的变更：记的时候在做的变更，任务都勾完了、或者归档了（目录不在了）
 *   不走 OpenSpec 的（会话不在流程里）：记它的那个会话停下来的那次收工就列（Claude 定的：没有"任务"可等）
 *   在流程里、记的时候还没有大任务和变更的（探索刚开始）：到时候按记它的会话再认（复审 R3）
 * 收工钩子（verify-gate）别的事都了了时取一次（takeDue）：接在全自动报告后面，或者单独交给模型照抄进最后的交代；
 * 列过的记 shown，不再列。同时写一份 .vibe/reports/替你定的事-<时间>.md。
 * 只读写这个文件和报告目录，不调 git。出错的地方由调用方 try 住（钩子出错放行）。
 */
const fs = require('fs');
const path = require('path');

const FILE = 'auto-decisions.json';
const MAX_ITEMS = 500;
const DONE_PHASES = ['selftest', 'verify', 'archive', 'done'];
const KIND_NAME = { ask: '提问框', apply: '开工那一问', allow: '确认框', deny: '确认框' };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t || Date.now()); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const fileStamp = (t) => { const d = new Date(t || Date.now()); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); };
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** 这个会话的记录文件：启动 Claude 的那个目录的 .vibe/auto-decisions.json（模型 cd 过也不变，和全自动报告一样） */
function fileOf(j) {
  const S = require('./session');
  return path.join(S.sessionHome(j), '.vibe', FILE);
}
function read(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const d = JSON.parse(t);
    return { next: Number(d.next) || 1, items: Array.isArray(d.items) ? d.items : [] };
  } catch (e) { return { next: 1, items: [] }; }
}
/**
 * 读改写一次只让一个进程做（复审 R2：几个框同时到点，几个 ask-timeout 进程同时记，后写的盖掉先写的、编号重复）。
 * 锁在记录文件旁边，5 秒拿不到照旧做（和 lessons.js 一样）
 */
function withLock(file, fn) {
  let lock = null;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); lock = require('./state-store').acquire(file + '.lock', { waitMs: 5000 }); } catch (e) { lock = null; }
  try { return fn(); } finally { if (lock) lock.release(); }
}
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  try { require('./session').ensureVibeIgnored(file); } catch (e) { /* 加不上不影响 */ }
}

/** 这个会话在做的变更目录（流程里动过的） */
function flowDirs(j) {
  const S = require('./session');
  try { const keys = S.flowChanges(j); return S.allChanges(S.sessionHome(j)).filter((c) => keys.includes(S.normKey(c.dir))).map((c) => c.dir); } catch (e) { return []; }
}
/**
 * 记的时候在做什么。不在流程里的会话是不走 OpenSpec 的（plain），不去认目录里碰巧只有一个的大任务（复审 R1：big-task.forSession 的兜底会认上它）。
 * 在流程里：属于哪个大任务（task、osDir）；不在大任务里的在做哪些变更（change、dirs）；都还没有的（探索刚开始、plan.md 还没建）记成 flow，到时候按会话再认
 */
function contextOf(j) {
  const S = require('./session');
  let on = false;
  try { on = !!S.flowState(j).on; } catch (e) { on = false; }
  if (!on) return { group: 'plain', task: '', osDir: '', dirs: [] };
  let task = null;
  try { task = require('./big-task').forSession(j); } catch (e) { task = null; }
  if (task) return { group: 'task', task: task.name, osDir: S.normKey(task.osDir), dirs: [] };
  const dirs = flowDirs(j);
  return dirs.length ? { group: 'change', task: '', osDir: '', dirs } : { group: 'flow', task: '', osDir: '', dirs: [] };
}

/**
 * 记一件。item：{ kind, title（问的什么、哪条命令）, options（提问框的选项）, outcome（钩子怎么收的）, chose（钩子能定的直接写上）}。
 * 返回 { id, file }；记不了抛出去，调用方 try
 */
function record(j, item) {
  const file = fileOf(j);
  const ctx = contextOf(j);
  let redact = (s) => s;
  try { redact = require('./feedback').redact; } catch (e) { /* 老版本没有 */ }
  return withLock(file, () => {
    const d = read(file);
    const id = d.next;
    d.items.push(Object.assign({
      id, at: Date.now(), session: String((j && j.session_id) || ''), kind: item.kind,
      title: clip(redact(item.title), 300), options: clip(item.options, 300), outcome: clip(item.outcome, 200),
      chose: clip(redact(item.chose || ''), 300), why: '', shown: 0,
    }, ctx));
    d.next = id + 1;
    // 攒多了：列过的旧条目先丢
    while (d.items.length > MAX_ITEMS) { const i = d.items.findIndex((x) => x.shown); d.items.splice(i >= 0 ? i : 0, 1); }
    write(file, d);
    return { id, file };
  });
}

/** 模型补上自己定了什么（tools/decided.js）。返回 { ok, id, reason } */
function fill(file, id, chose, why) {
  let redact = (s) => s;
  try { redact = require('./feedback').redact; } catch (e) { /* 老版本没有 */ }
  return withLock(file, () => {
    const d = read(file);
    const it = d.items.find((x) => Number(x.id) === Number(id));
    if (!it) return { ok: false, reason: '没有编号 ' + id + ' 这一条（' + file + '）' };
    it.chose = clip(redact(chose), 300);
    it.why = clip(redact(why), 300);
    it.filledAt = Date.now();
    write(file, d);
    return { ok: true, id: it.id };
  });
}

/** 从 cwd 往上找记录文件（decided.js 没给 --file 时用） */
function findFile(cwd) {
  let d = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 20; i++) { const f = path.join(d, '.vibe', FILE); if (fs.existsSync(f)) return f; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}

/** 一个变更目录的任务做完了没有：目录不在（归档了、删了）也算 */
function changeDone(dir) {
  if (!fs.existsSync(dir)) return true;
  let t = '';
  try { t = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'); } catch (e) { return false; }
  const done = (t.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const todo = (t.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
  return done > 0 && todo === 0;
}
/**
 * 这一件到没到列给用户的时候。tasksOf 给 big-task 的大任务清单（同一次收工只算一遍）；j 是现在收工的会话。
 *   plain：只在记它的那个会话收工时列（复审 R3：同一个目录里别的会话的不归这个会话交代）
 *   flow：记的时候还认不出大任务、变更的，按记它的会话现在的样子再认：认出大任务的等大任务做完，认出变更的等变更做完；
 *         那个会话已经不在流程里了（走完了、关了），记它的会话收工时列
 */
function isDue(it, tasksOf, j) {
  const S = require('./session');
  const B = require('./big-task');
  const taskDone = (t) => { try { return DONE_PHASES.includes(B.phaseOf(t).phase); } catch (e) { return false; } };
  if (it.group === 'task') {
    const t = tasksOf().find((x) => S.normKey(x.osDir) === it.osDir && x.name === it.task);
    // 表没了、大任务改名了：找不到它，就别一直压着
    return t ? taskDone(t) : true;
  }
  if (it.group === 'change') return (it.dirs || []).every(changeDone);
  const mine = String(it.session || '') === String((j && j.session_id) || '');
  if (it.group === 'flow') {
    const jj = { session_id: it.session, cwd: S.sessionHome(j) };
    let on = false;
    try { on = !!S.flowState(jj).on; } catch (e) { on = false; }
    if (!on) return mine;
    let t = null;
    try { t = B.forSession(jj); } catch (e) { t = null; }
    if (t) return taskDone(t);
    const dirs = flowDirs(jj);
    return dirs.length > 0 && dirs.every(changeDone);
  }
  return mine;
}

/** 一件写成一行 */
function lineOf(it) {
  const head = stamp(it.at) + ' ' + (KIND_NAME[it.kind] || it.kind) + '：' + it.title + (it.options ? '（选项：' + it.options + '）' : '');
  if (it.kind === 'ask') return head + ' → ' + (it.chose ? '它定的：' + it.chose + (it.why ? '。理由：' + it.why : '') : '没登记定了什么');
  return head + ' → ' + (it.outcome || '') + (it.chose ? '：' + it.chose : '');
}
function groupHead(it) {
  if (it.group === 'task') return '大任务 ' + it.task;
  if (it.group === 'change') return '变更 ' + (it.dirs || []).map((d) => path.basename(d)).join('、');
  if (it.group === 'flow') return '这一段流程';
  return '不走 OpenSpec 的活';
}

/**
 * 收工时取一次该列的：没列过、到了时候的。记成列过，写一份报告。
 * 返回 null，或 { count, file（报告）, heads（几组的标题）, lines（给模型照抄的，一件一行，按组分开）}
 */
function takeDue(j) {
  const file = fileOf(j);
  if (!fs.existsSync(file)) return null;
  let cache = null;
  const S = require('./session');
  const tasksOf = () => { if (!cache) { try { cache = require('./big-task').tasks(S.sessionHome(j)); } catch (e) { cache = []; } } return cache; };
  const now = Date.now();
  // 挑出来、记成列过，在锁里一起做：两个会话同时收工不会各列一遍
  const due = withLock(file, () => {
    const d = read(file);
    const list = d.items.filter((x) => !x.shown && isDue(x, tasksOf, j));
    if (!list.length) return [];
    for (const it of list) it.shown = now;
    write(file, d);
    return list;
  });
  if (!due.length) return null;
  const groups = [];
  for (const it of due) { const h = groupHead(it); let g = groups.find((x) => x.head === h); if (!g) { g = { head: h, items: [] }; groups.push(g); } g.items.push(it); }
  const lines = [];
  for (const g of groups) { lines.push(g.head + '（' + g.items.length + ' 件）：'); g.items.forEach((it, i) => lines.push('  ' + (i + 1) + '. ' + lineOf(it))); }
  let out = '';
  try {
    const dir = path.join(path.dirname(file), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    out = path.join(dir, '替你定的事-' + fileStamp(now) + '.md');
    const md = ['# 替你定的事（' + stamp(now) + '）', '', '询问没人回、到点替你定的事。套件按记录写的，原始记录在 ' + file + '。', ''];
    for (const g of groups) { md.push('## ' + g.head, ''); for (const it of g.items) md.push('- ' + lineOf(it)); md.push(''); }
    fs.writeFileSync(out, md.join('\n'));
  } catch (e) { out = ''; }
  return { count: due.length, file: out, record: file, heads: groups.map((g) => g.head), lines };
}

/** 单独交给模型的那一段（没有全自动报告的收工） */
function dueText(r) {
  return '[vibe-kit 替你定的事] ' + r.heads.join('、') + ' 做完了。用户不在的时候，询问没人回、到点替他定的事一共 ' + r.count + ' 件'
    + (r.file ? '，清单也写进了 ' + r.file : '') + '：\n' + r.lines.join('\n') + '\n'
    + '把这份清单原样放进最后的交代给用户看（一件一行，不删、不改写）。写着"没登记定了什么"的，照你当时实际怎么定的补一句。写完收工，不要再做别的。';
}
/** 接在全自动报告交代顺序里的那一项 */
function dueItem(r, n) {
  return n + '. 替你定的事（询问没人回、到点替你定的，' + r.count + ' 件' + (r.file ? '，清单在 ' + r.file : '') + '；原样列出，一件一行，"没登记定了什么"的照实补一句）：\n' + r.lines.join('\n') + '\n';
}

module.exports = { FILE, fileOf, read, record, fill, findFile, isDue, takeDue, dueText, dueItem, lineOf, DONE_PHASES };

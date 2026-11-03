'use strict';
/*
 * 大任务（2026-11-03，用户定的）：探索出来的一件事，拆成一个或几个 change，一起做、最后一起自测和核验。
 *   openspec/plan.md            索引：## 大任务名、探索记录的路径、change 的表
 *   openspec/explore/<名>.md    探索结果全文，边谈边写，随仓库提交
 * 做到哪不靠谁记，从文件算：plan.md 的表、changes/ 下的 tasks.md、归档目录。换会话、死机、压缩都不影响。
 * 跨会话要留的只有脚本才能写的几样（自动开没开、全面自测结果、归档预演结果），放 state/big-task.json，模型改不了（~/.claude 禁改）。
 * 只读文件、不调 git、不算审查，状态栏和钩子都能用。
 * 老的 plan.md（没有 ## 分节、没有探索记录）算老任务：照样算进度，不查探索记录。
 */
const fs = require('fs');
const path = require('path');
const { changeRoots } = require('./session-projects');
const { readPlan } = require('./session-plan');
const { readState, updateState, normKey } = require('./session-state');

const TICK_DONE = /^\s*[-*]\s*\[[xX]\]/gm;
const TICK_TODO = /^\s*[-*]\s*\[ \]/gm;

/** 一个 change 现在什么样：没建、写需求中（没有 tasks.md 或没有任务）、做到几项、归档了没有 */
function changeInfo(name, changesDir) {
  const dir = path.join(changesDir, name);
  const info = { name, dir, exists: fs.existsSync(dir), archived: false, done: 0, todo: 0, total: 0 };
  if (info.exists) {
    try {
      const t = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8');
      info.done = (t.match(TICK_DONE) || []).length;
      info.todo = (t.match(TICK_TODO) || []).length;
      info.total = info.done + info.todo;
    } catch (e) { /* 还没有 tasks.md */ }
    return info;
  }
  try { info.archived = fs.readdirSync(path.join(changesDir, 'archive')).some((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name); } catch (e) { /* 没有 archive */ }
  return info;
}

function build(osDir, plan, name, explore, rows) {
  const changesDir = path.join(osDir, 'changes');
  return {
    name, osDir, planFile: plan.file,
    explore: explore ? path.resolve(osDir, explore) : '',
    legacy: !explore,
    changes: rows.map((r) => changeInfo(r.name, changesDir)),
  };
}

/** 这个目录能看到的所有大任务（壳子里每个子项目各算） */
function tasks(cwd) {
  const out = [];
  for (const changes of changeRoots(cwd)) {
    const osDir = path.dirname(changes);
    const plan = readPlan(osDir);
    if (!plan) continue;
    const named = new Set();
    for (const s of plan.sections) {
      const rows = plan.rows.filter((r) => r.task === s.name);
      if (!s.explore && !rows.length) continue; // plan.md 里普通的二级标题
      named.add(s.name);
      out.push(build(osDir, plan, s.name, s.explore, rows));
    }
    const loose = plan.rows.filter((r) => !named.has(r.task));
    if (loose.length) out.push(build(osDir, plan, plan.title || '计划', '', loose));
  }
  return out;
}

/** 这个 change 属于哪个大任务；不在表里返回 null */
function ofChange(cwd, change) {
  const name = path.basename(String(change || ''));
  return tasks(cwd).find((t) => t.changes.some((c) => c.name === name)) || null;
}
function named(cwd, name) { return tasks(cwd).find((t) => t.name === name) || null; }

/** 探索记录按二级标题分节：{ 标题: 正文 }。HTML 注释（模板里的提示）不算内容 */
function exploreSections(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  const out = {}; let cur = null;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += line + '\n';
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}
const NOTHING = /^(无|没有|暂无|none|n\/a|-|—)?[。.]?$/i;

/** 探索记录缺什么：离开探索、开工之前要都解决。老任务不查。change 给了就查这个 change 有没有一节 */
function exploreIssues(task, change) {
  if (!task || task.legacy) return [];
  const rel = path.relative(task.osDir, task.explore).split(path.sep).join('/');
  const s = exploreSections(task.explore);
  if (!s) return ['探索记录 ' + rel + ' 还没有'];
  const out = [];
  if (!NOTHING.test(s['还没定的'] || '')) out.push('探索记录"还没定的"还有内容：' + s['还没定的'].split('\n')[0].slice(0, 80));
  if (!s['范围']) out.push('探索记录"范围"还没写（做什么、不做什么）');
  if (change && !s['change: ' + change]) out.push('探索记录 change ' + change + ' 这一节没有或是空的（## change: ' + change + '）');
  return out;
}

const keyOf = (task) => normKey(task.explore || (task.planFile + '#' + task.name));
function taskState(task) { return readState('big-task')[keyOf(task)] || {}; }
function setTaskState(task, patch) {
  return updateState('big-task', (o) => { o[keyOf(task)] = Object.assign({}, o[keyOf(task)], patch, { at: Date.now() }); });
}

/**
 * 大任务走到哪一步：explore 探索 / plan 写需求（还没开工）/ apply 做任务 / selftest 全面自测 / verify 等人工核验 / archive 归档中 / done。
 * change 是当前要做的那个：按表的顺序，最前面没做完的。回改前面的 change 补了任务，它就排回前面。
 */
function phaseOf(task) {
  const list = task.changes;
  const started = list.some((c) => c.exists || c.archived);
  if (!list.length || (!started && exploreIssues(task).length)) return { phase: 'explore', change: '' };
  for (const c of list) {
    if (c.archived) continue;
    if (!c.total || (c.todo && !c.done)) return { phase: 'plan', change: c.name };
    if (c.todo) return { phase: 'apply', change: c.name };
  }
  const left = list.filter((c) => !c.archived);
  if (!left.length) return { phase: 'done', change: '' };
  if (left.length < list.length) return { phase: 'archive', change: left[0].name };
  return { phase: taskState(task).selfTest ? 'verify' : 'selftest', change: '' };
}

/** 给人看的进度：共 3 个，c1 已归档，c2 做到 2/5，后面还有 c3 */
function progressText(task) {
  const parts = ['共 ' + task.changes.length + ' 个'];
  const later = [];
  for (const c of task.changes) {
    if (c.archived) parts.push(c.name + ' 已归档');
    else if (c.total && !c.todo) parts.push(c.name + ' 任务全勾完');
    else if (c.total) parts.push(c.name + ' 做到 ' + c.done + '/' + c.total);
    else if (c.exists) parts.push(c.name + ' 在写需求');
    else later.push(c.name);
  }
  if (later.length) parts.push('后面还有 ' + later.join('、'));
  return parts.join('，');
}

module.exports = { tasks, ofChange, named, changeInfo, exploreSections, exploreIssues, taskState, setTaskState, phaseOf, progressText };

'use strict';
/*
 * 大任务（2026-11-03，用户定的）：探索出来的一件事，拆成一个或几个 change，一起做、最后一起自测和核验。
 *   openspec/plan.md            索引：## 大任务名、探索记录的路径、change 的表
 *   openspec/explore/<名>.md    探索结果全文，边谈边写，随仓库提交
 * 做到哪不靠谁记，从文件算：plan.md 的表、changes/ 下的 tasks.md、归档目录。换会话、死机、压缩都不影响。
 * 跨会话要留的只有脚本才能写的几样（自动开没开、全面自测结果、归档预演结果），放 state/big-task.json。2026-11-04 起套件可以改，模型改得了这个文件；约定里写着"没让改就不改"
 * 只读文件、不调 git、不算审查，状态栏和钩子都能用。
 * 老的 plan.md（没有 ## 分节、没有探索记录）算老任务：照样算进度，不查探索记录。
 */
const fs = require('fs');
const path = require('path');
const { changeRoots } = require('./session-projects');
const { readPlan } = require('./session-plan');
const { readState, updateState, normKey } = require('./session-state');
const { flowState, flowChanges } = require('./session-flow');

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
  const dirs = changeRoots(cwd).map((c) => path.dirname(c));
  // 还没建过变更的项目没有 changes/，plan.md 已经在了（探索时建的）
  const here = path.join(cwd, 'openspec');
  if (!dirs.some((d) => normKey(d) === normKey(here)) && fs.existsSync(path.join(here, 'plan.md'))) dirs.push(here);
  for (const osDir of dirs) {
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
// 写成"（无）""无（都定了）""已全部确认"都算空（第 68 条：以前只认一个"无"，模型写成这样就一直算没定完，开着自动也退回人工）。"无法确定分页"这种不算
const NOTHING = /^(?:[（(]?(?:无|没有|暂无|none|n\/a|-|—|都定了|全定了|全部定了|全部确认|已全部确认|已全部定|已清空)[）)]?[。.，,]?\s*(?:[（(][^）)\n]{0,30}[）)])?)?[。.]?$/i;
/** 探索记录里还有真的没定的事。大任务写了探索记录、文件却不在的也算（还没探索）；不是大任务、老任务算没有 */
function exploreOpen(task) {
  if (!task || task.legacy) return false;
  const s = exploreSections(task.explore);
  return !s || !NOTHING.test(s['还没定的'] || '');
}

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

/** 这个会话在做哪个大任务：接回时记的名字；动过的变更属于哪个；都没有时目录里只有一个没做完的就是它 */
function forSession(j) {
  const all = tasks((j && j.cwd) || process.cwd());
  const st = flowState(j);
  if (st.task) { const t = all.find((x) => x.name === st.task); if (t) return t; }
  // 切到了表外的 change（/vk-resume <变更名>、开工点名）、还没做完：这个会话不归哪个大任务。做完了、归档了不算，不然后面开的大任务全失效（复审 R1）
  if (st.current && !all.some((t) => t.changes.some((c) => c.name === st.current)) && currentAlive(j)) return null;
  const dirs = flowChanges(j);
  const hit = all.find((t) => t.changes.some((c) => dirs.includes(normKey(c.dir))));
  if (hit) return hit;
  const open = all.filter((t) => t.changes.some((c) => !c.archived) || !t.changes.length);
  return open.length === 1 ? open[0] : null;
}
/** 自动开没开记到大任务上：死机后 /vk-resume 接回时恢复（用户 2026-11-03 定的"接回就接着开"） */
function noteAuto(j, on) {
  const t = forSession(j);
  if (t && taskState(t).auto !== !!on) setTaskState(t, { auto: !!on });
}

const keyOf = (task) => normKey(task.explore || (task.planFile + '#' + task.name));
function taskState(task) { return readState('big-task')[keyOf(task)] || {}; }
function setTaskState(task, patch) {
  return updateState('big-task', (o) => { o[keyOf(task)] = Object.assign({}, o[keyOf(task)], patch, { at: Date.now() }); });
}

/**
 * 表里这一行的目录不在、也没归档，后面的 change 又已经开始了：多半是改名或者删了，不算当前（问题表第 50 条）。
 * 老任务一直跳过（老表的行可能早就不用了）；新任务探索记录里定了要做，只在后面还有没做完的时跳过，做完了回来算。
 * 表最后面还没建的行不算：那是计划要做的。
 */
function goneRow(task, i) {
  const c = task.changes[i];
  if (c.exists || c.archived) return false;
  const later = task.changes.slice(i + 1);
  return task.legacy ? later.some((x) => x.exists || x.archived) : later.some((x) => x.exists && (!x.total || x.todo));
}
/** 切到的 change 还算数吗：表里的没归档、没勾完（还没建的也算，切过去就是要写它）；表外的目录在、没勾完 */
function currentAlive(j) {
  const name = flowState(j).current;
  if (!name) return false;
  const cwd = (j && j.cwd) || process.cwd();
  // 用户切到一个任务都勾完的 change（第 60 条）：一直算当前，直到归档、切走
  const keep = flowState(j).keepCurrent === name;
  for (const t of tasks(cwd)) { const c = t.changes.find((x) => x.name === name); if (c) return !c.archived && (keep || !c.total || c.todo > 0); }
  for (const d of changeRoots(cwd)) { const c = changeInfo(name, d); if (c.exists) return keep || !c.total || c.todo > 0; }
  return false;
}
/** 收工时：切到的 change 做完了、归档了、没了，指针清掉。不清的话它之后回改加了任务又抢回来，打勾顺序也一直豁免（复审 R4） */
function dropDeadCurrent(j) {
  const st = flowState(j);
  if (st.current && !currentAlive(j)) { updateState(String(j.session_id) + '-flow', (s) => { delete s.current; delete s.keepCurrent; }); return; }
  // 切到任务都勾完的 change 之后又补了任务：按普通的算，做完回到表的顺序
  if (st.keepCurrent && st.keepCurrent === st.current) {
    const cwd = (j && j.cwd) || process.cwd();
    const c = tasks(cwd).flatMap((t) => t.changes).find((x) => x.name === st.current) || changeRoots(cwd).map((d) => changeInfo(st.current, d)).find((x) => x.exists);
    if (c && c.todo > 0) updateState(String(j.session_id) + '-flow', (s) => { delete s.keepCurrent; });
  }
}
/** 这个会话当前的 change：用户用 /vk-resume <变更名> 切过、还没做完的就是它；做完了回到表的顺序（问题表第 49、50 条） */
function phaseFor(j, task) {
  const name = flowState(j).current;
  const c = name ? task.changes.find((x) => x.name === name) : null;
  if (c && !c.archived && (!c.total || c.todo)) return { phase: !c.total || !c.done ? 'plan' : 'apply', change: name };
  // 用户切到一个任务都勾完的 change（第 60 条）：算在做它，等用户说下一步，不接下一个、不催全面自测
  if (c && !c.archived && flowState(j).keepCurrent === name) return { phase: 'apply', change: name };
  return phaseOf(task);
}
/**
 * 大任务走到哪一步：explore 探索 / plan 写需求（还没开工）/ apply 做任务 / selftest 全面自测 / verify 等人工核验 / archive 归档中 / done。
 * change 是当前要做的那个：按表的顺序，最前面没做完的。回改前面的 change 补了任务，它就排回前面。
 */
function phaseOf(task) {
  const list = task.changes;
  const started = list.some((c) => c.exists || c.archived);
  if (!list.length || (!started && exploreIssues(task).length)) return { phase: 'explore', change: '' };
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.archived || goneRow(task, i)) continue;
    if (!c.total || (c.todo && !c.done)) return { phase: 'plan', change: c.name };
    if (c.todo) return { phase: 'apply', change: c.name };
  }
  const left = list.filter((c, i) => !c.archived && !goneRow(task, i));
  if (!left.length) return { phase: 'done', change: '' };
  if (list.some((c) => c.archived)) return { phase: 'archive', change: left[0].name };
  return { phase: taskState(task).selfTest ? 'verify' : 'selftest', change: '' };
}

/** 给人看的进度：共 3 个，c1 已归档，c2 做到 2/5，后面还有 c3 */
function progressText(task) {
  const parts = ['共 ' + task.changes.length + ' 个'];
  const later = [];
  for (const [i, c] of task.changes.entries()) {
    if (goneRow(task, i)) parts.push(c.name + (task.legacy ? ' 目录不在，跳过' : ' 还没建，后面做完了回来算'));
    else if (c.archived) parts.push(c.name + ' 已归档');
    else if (c.total && !c.todo) parts.push(c.name + ' 任务全勾完');
    else if (c.total) parts.push(c.name + ' 做到 ' + c.done + '/' + c.total);
    else if (c.exists) parts.push(c.name + ' 在写需求');
    else later.push(c.name);
  }
  if (later.length) parts.push('后面还有 ' + later.join('、'));
  return parts.join('，');
}

/** 大任务全部 change 的需求增量和探索记录的指纹：预演过之后这些变了就要重新预演 */
function specsHash(task) {
  const rows = [];
  const walk = (d) => { let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const n of names) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else { try { rows.push([normKey(p), fs.readFileSync(p, 'utf8')]); } catch (e) { /* 读不了 */ } } } };
  for (const c of task.changes) if (c.exists) walk(path.join(c.dir, 'specs'));
  return require('crypto').createHash('sha1').update(JSON.stringify(rows)).digest('hex');
}
/** 范围外建议（用户 2026-11-03 定的）：探索记录里没有的新东西不加，记下来，人工核验时列给用户。放项目的 .vibe，不进仓库 */
function suggestFile(task) { return path.join(path.dirname(task.osDir), '.vibe', 'big-task', task.name.replace(/[\\/:*?"<>|\s]+/g, '-') + '-范围外建议.md'); }
function addSuggestion(task, text, from) {
  const f = suggestFile(task);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, '- ' + String(text).replace(/\s+/g, ' ').trim() + (from ? '（' + from + '）' : '') + '\n');
  return f;
}
function suggestions(task) { try { return fs.readFileSync(suggestFile(task), 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch (e) { return []; } }

// ---------- 状态栏的步骤条（用户 2026-11-03 定的，问题表第 46、47 条） ----------
const DOC_STEPS = [['proposal', '提案'], ['specs', '规格'], ['design', '设计'], ['tasks', '任务']];
/** 审查状态：◆审过 ◇在审 ✗N 有 N 条 P1、P2 待修。用记录值，不调 git（状态栏刷新得勤） */
function reviewMark(P, dir, point) {
  const r = P.record(dir, point);
  if (r.status === 'running' || r.status === 'needs_review') return '◇';
  if (r.status === 'resolved') return '◆';
  if (r.status !== 'completed') return '';
  const n = r.blocking === undefined ? Number(r.issues) || 0 : Number(r.blocking) || 0;
  return n ? '✗' + n : '◆';
}
function changeSteps(dir) {
  const P = require('./flow-policy');
  const have = P.written(dir);
  const parts = []; let open = false;
  for (const [id, label] of DOC_STEPS) {
    if (have.includes(id)) { parts.push(label + '✓' + reviewMark(P, dir, id)); continue; }
    parts.push(label + (open ? '○' : '●')); open = true;
  }
  const groups = P.groups(dir);
  const cur = groups.findIndex((g) => !g.done);
  // 组太多折叠成一个
  if (groups.length > 6) {
    const k = cur < 0 ? groups.length : cur + 1; const g = groups[k - 1];
    parts.push('组 ' + k + '/' + groups.length + (cur < 0 ? '✓' : '●') + reviewMark(P, dir, g.id));
  } else groups.forEach((g, i) => parts.push(g.id.slice(6) + '组' + (g.done ? '✓' : i === cur ? '●' : '○') + reviewMark(P, dir, g.id)));
  // 整个 change 的审查（第 58 条）：任务全部做完才开始。旧版按组审完的算审过
  if (groups.length) {
    const mark = reviewMark(P, dir, P.CHANGE) || (groups.every((g) => reviewMark(P, dir, g.id) === '◆') ? '◆' : '');
    parts.push('审查' + (mark || (cur < 0 ? '●' : '○')));
  }
  return parts.join(' ');
}
const shortName = (s) => { const n = String(s); return n.length > 16 ? n.slice(0, 15) + '…' : n; };
/**
 * 这个会话在流程里：{ steps: 步骤条, next: 下一项或等什么 }；不在流程里 null（目录里有没勾完的 change 也不显示，第 46 条）。
 * change 名后面不带它在 plan.md 里排第几、一共几个（仓库主人 2026-11-04 定的）。
 * 探索✓ │ c2-api 提案✓ 规格✓ 设计✓ 任务✓◆ 1组✓ 2组● 3组○ 审查○ │ 自测○ 核验○ 归档○（任务后面的 ◆ 是整套文档审过）
 */
function bar(j) {
  const S = require('./session');
  if (!flowState(j).on) return null;
  const task = forSession(j);
  const T = require('./task-types');
  const P = require('./flow-policy');
  let ph; let list; let dir = ''; let shownName = '';
  if (task) {
    ph = phaseFor(j, task); list = task.changes;
    const c = ph.change ? list.find((x) => x.name === ph.change) : null;
    if (c && c.exists) dir = c.dir;
    // 任务勾完阶段就往后走了，审查这时才开始（第 58 条）：在审、有问题待修的 change 显示它；全做完了显示最后一个，看得到审查走到哪
    const reviewing = flowState(j).current ? null : list.find((x) => x.exists && !x.archived && x.total && !x.todo && /^[◇✗]/.test(reviewMark(P, x.dir, P.CHANGE)));
    const last = !dir ? list.slice().reverse().find((x) => x.exists && !x.archived) : null;
    const shown = reviewing || last;
    if (shown) { dir = shown.dir; shownName = shown.name; }
  } else {
    const dirs = flowChanges(j);
    const hit = S.allChanges(j.cwd || process.cwd()).filter((c) => dirs.includes(normKey(c.dir)));
    if (!hit.length) return { steps: '', next: '' };
    const pick = hit.find((c) => c.name === flowState(j).current) || hit[0];
    dir = pick.dir; list = hit.map((c) => ({ name: c.name }));
    const tasks = T.tasks(dir); const done = tasks.filter((x) => x.done).length;
    ph = { phase: !tasks.length || !done ? 'plan' : done < tasks.length ? 'apply' : 'verify', change: pick.name };
  }
  const name = shownName || ph.change || (list.length ? list[list.length - 1].name : '');
  const after = { explore: 0, plan: 1, apply: 1, selftest: 2, verify: 3, archive: 4, done: 5 }[ph.phase];
  const mark = (n) => (after > n ? '✓' : after === n ? '●' : '○');
  const mid = name ? shortName(name) + (dir ? ' ' + changeSteps(dir) : '') : '';
  const steps = [task ? '探索' + mark(0) : '', mid, '自测' + mark(2) + ' 核验' + mark(3) + ' 归档' + mark(4)].filter(Boolean).join(' │ ');
  let next = '';
  if (ph.phase === 'explore') next = '探索中';
  else if (ph.phase === 'plan' && dir) { const miss = DOC_STEPS.find(([id]) => !P.written(dir).includes(id)); next = miss ? '下一份 ' + miss[1] : ''; }
  else if (ph.phase === 'plan' || ph.phase === 'apply') { const left = dir ? T.automatedLeft(dir) : []; next = left.length ? '下一项 ' + left[0].text : ''; }
  else if (ph.phase === 'selftest') next = '下一步 全面自测';
  else if (ph.phase === 'verify') next = '等你核验：看完说归档或 /vk-archive';
  else if (ph.phase === 'archive') next = '下一步 按 plan.md 的顺序归档 ' + ph.change;
  if (!next && dir) { const left = T.automatedLeft(dir); if (left.length) next = '下一项 ' + left[0].text; }
  if (!next && name && flowState(j).keepCurrent === name) next = '任务都勾完了，等你说下一步';
  return { steps, next };
}

module.exports = { phaseFor, goneRow, currentAlive, dropDeadCurrent, bar, specsHash, suggestFile, addSuggestion, suggestions, tasks, ofChange, named, forSession, noteAuto, changeInfo, exploreSections, exploreIssues, exploreOpen, taskState, setTaskState, phaseOf, progressText };

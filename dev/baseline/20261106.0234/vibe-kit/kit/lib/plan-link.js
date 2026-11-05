'use strict';
/*
 * 哪些 change 可能是一件事（问题表第 61、62 条，仓库主人 2026-11-05 定的：找出来问他，确认了才写进 plan.md）。
 *   第 61 条：流程改版前留下的几个 change 没有大任务：找出可能是一件事的几组，问要不要归成一个大任务。
 *   第 62 条：没有在做的大任务时开了新 change：找相关的旧大任务，问归到哪个。做到一半开的照旧自动补进在做的大任务（planAddUnlisted）。
 * 线索三个：名字前缀相同、文档里互相提到、任务改同一批文件。脚本只给线索，起名字和判断是模型的事，定不定是用户的事。
 * 问过的按内容记（state/plan-link.json），用户说不归就不再问。只读文件、不调 git。
 */
const fs = require('fs');
const path = require('path');
const { readPlan, planUnlisted } = require('./session-plan');
const { changeNames, archivedChanges } = require('./session-projects');
const { pathTokens } = require('./session-proposal');
const { readState, updateState, normKey, KIT } = require('./session-state');

const VERB = /^(add|fix|update|remove|delete|refactor|feat|feature|change|support|improve|new|impl|implement|optimize|adjust|enable|disable|migrate|rename|cleanup|clean|upgrade|bump|docs|test|chore|modify|create)$/i;
// 几乎每个需求都会动的文件，不算线索
const COMMON = /^(pom\.xml|package\.json|package-lock\.json|readme\.md|\.gitignore|build\.gradle|settings\.gradle|application\.ya?ml|application\.properties)$/i;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };

/** 一个 change 的线索：名字、在不在进行中、任务改的文件、文档全文。目录不在、也没归档的返回 null */
function infoOf(osDir, name) {
  const changes = path.join(osDir, 'changes');
  let dir = path.join(changes, name); let archived = false;
  if (!fs.existsSync(dir)) {
    let hit = '';
    try { hit = fs.readdirSync(path.join(changes, 'archive')).filter((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name).sort().pop() || ''; } catch (e) { hit = ''; }
    if (!hit) return null;
    dir = path.join(changes, 'archive', hit); archived = true;
  }
  const tasks = read(path.join(dir, 'tasks.md'));
  const files = new Set();
  for (const l of tasks.split(/\r?\n/)) {
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(l)) continue;
    for (const t of pathTokens(l)) { const f = String(t).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(); if (!COMMON.test(path.basename(f))) files.add(f); }
  }
  return { name, archived, files, text: [tasks, read(path.join(dir, 'proposal.md')), read(path.join(dir, 'design.md')), read(path.join(dir, 'revisions.md'))].join('\n').toLowerCase() };
}
/** 三个以上 change 都改的文件是热点（路由表、总入口），不算线索。原地改 */
function dropHot(list) {
  const count = new Map();
  for (const c of list) for (const f of c.files) count.set(f, (count.get(f) || 0) + 1);
  for (const c of list) for (const f of [...c.files]) if (count.get(f) >= 3) c.files.delete(f);
  return list;
}
function mentions(text, name) { const n = String(name).toLowerCase(); if (!text.includes(n)) return false; return new RegExp('(^|[^\\w.-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w.-])', 'i').test(text); }
function tokens(name) { const t = String(name).toLowerCase().split(/[-_]/).filter(Boolean); while (t.length > 1 && VERB.test(t[0])) t.shift(); return t; }
/** 两个 change 为什么可能是一件事。没有线索返回空数组 */
function whyRelated(a, b) {
  const out = [];
  const ta = tokens(a.name); const tb = tokens(b.name); let n = 0;
  while (n < ta.length && n < tb.length && ta[n] === tb[n]) n++;
  if (n >= 2 || (n === 1 && ta[0].length >= 5)) out.push('名字前缀都是 ' + ta.slice(0, n).join('-'));
  if (mentions(a.text, b.name)) out.push(a.name + ' 的文档提到 ' + b.name);
  else if (mentions(b.text, a.name)) out.push(b.name + ' 的文档提到 ' + a.name);
  const same = [...a.files].filter((f) => b.files.has(f));
  if (same.length) out.push('都改 ' + same.slice(0, 3).join('、'));
  return out;
}
/** 第 61 条：不在 plan.md 表里、可能是一件事的几组。至少有一个还没归档；没有 plan.md 的项目全部算。返回 [{ changes, why }] */
function orphanGroups(osDir) {
  const plan = readPlan(osDir);
  const listed = new Set(plan ? plan.rows.map((r) => r.name) : []);
  const changesDir = path.join(osDir, 'changes');
  const active = plan ? planUnlisted(osDir) || [] : changeNames(changesDir);
  if (!active.length) return [];
  const old = archivedChanges(changesDir, 60).map((a) => a.name).filter((n) => !listed.has(n) && !active.includes(n)).slice(-60);
  const infos = dropHot(active.concat(old).map((n) => infoOf(osDir, n)).filter(Boolean));
  const group = new Map(infos.map((c) => [c.name, c.name]));
  const root = (n) => { let r = n; while (group.get(r) !== r) r = group.get(r); return r; };
  const reasons = new Map();
  for (let i = 0; i < infos.length; i++) {
    for (let k = i + 1; k < infos.length; k++) {
      const why = whyRelated(infos[i], infos[k]);
      if (!why.length) continue;
      group.set(root(infos[k].name), root(infos[i].name));
      reasons.set(infos[i].name + '|' + infos[k].name, why);
    }
  }
  const out = new Map();
  for (const c of infos) { const r = root(c.name); if (!out.has(r)) out.set(r, []); out.get(r).push(c); }
  return [...out.values()].filter((list) => list.length >= 2 && list.some((c) => !c.archived)).map((list) => {
    const names = list.map((c) => c.name);
    const why = [...reasons.entries()].filter(([k]) => names.includes(k.split('|')[0])).flatMap(([, v]) => v);
    return { changes: names, why: [...new Set(why)].slice(0, 4) };
  });
}
/** 第 62 条：这个 change 和 plan.md 里哪些大任务有关。返回 [{ task, from, why }]，线索多的排前面，最多 3 个 */
function relatedTasks(osDir, name) {
  const plan = readPlan(osDir); const me = infoOf(osDir, name);
  if (!plan || !me) return [];
  const best = new Map();
  const others = plan.rows.filter((r) => r.name !== name && r.task).map((r) => ({ r, info: infoOf(osDir, r.name) })).filter((x) => x.info);
  dropHot([me].concat(others.map((x) => x.info)));
  for (const { r, info: other } of others) {
    const why = whyRelated(me, other);
    if (why.length && (!best.has(r.task) || best.get(r.task).why.length < why.length)) best.set(r.task, { task: r.task, from: r.name, why });
  }
  return [...best.values()].sort((a, b) => b.why.length - a.why.length).slice(0, 3);
}
/** 这件事问过了没有；没问过记成问过（用户答不归就不再问）。true = 这次要问 */
function firstAsk(key) {
  let fresh = false;
  updateState('plan-link', (o) => { if (!o[key]) { o[key] = Date.now(); fresh = true; } });
  return fresh;
}
const tool = () => 'node "' + path.join(KIT, 'tools', 'plan.js').split(path.sep).join('/') + '"';
/** 第 61 条的提示：有没问过的几组就给模型一段话，没有给 '' */
function groupHint(osDir) {
  const fresh = orphanGroups(osDir).filter((g) => firstAsk(normKey(osDir) + '|group|' + g.changes.slice().sort().join(',')));
  if (!fresh.length) return '';
  const project = path.dirname(osDir).split(path.sep).join('/');
  return '这些 change 没归到大任务，看着可能是一件事：' + fresh.map((g) => g.changes.join('、') + '（' + g.why.join('；') + '）').join('；另一组：') + '。先回应用户这一句；手上的事告一段落时，读它们的 proposal 起个大任务名字，用一个提问框问一次，一组一个问题，选项写"归成 <名字>""不归"（一个 change 不属于这一组的，用户可以在"其他"里说）。用户选了归才跑：' + tool() + ' link --task <名字> --changes <逗号分隔> --project "' + project + '"。这样补进去的算老任务，不用写探索记录，不按表的顺序拦。选不归就不用管，不会再问。';
}
/** 第 62 条的提示：这个 change 和旧大任务有关，没问过就给模型一段话，没有给 '' */
function taskHint(osDir, name) {
  const found = relatedTasks(osDir, name);
  if (!found.length || !firstAsk(normKey(osDir) + '|task|' + name)) return '';
  const project = path.dirname(osDir).split(path.sep).join('/');
  return '变更 ' + name + ' 不在计划表里，现在也没有在做的大任务，可能和这些旧大任务有关：' + found.map((f) => f.task + '（' + f.why.join('；') + '）').join('、') + '。用一个提问框问用户归到哪，选项写' + found.map((f) => '"归到 ' + f.task + '"').join('') + '"新开大任务""不归"。归到旧大任务：' + tool() + ' link --task <大任务名> --changes ' + name + ' --note "来源：' + found[0].from + '" --project "' + project + '"（来源写最相关的那个旧 change）。新开：同样的命令，--task 写新名字，不带 --note。不归就不用管，不会再问。';
}
module.exports = { whyRelated, orphanGroups, relatedTasks, groupHint, taskHint };

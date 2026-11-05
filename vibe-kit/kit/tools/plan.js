'use strict';
/*
 * 大需求的计划表 openspec/plan.md：没有就按现有的变更生成骨架，有就按实际情况刷新状态列。只动 plan.md，别的不碰。
 *   node plan.js [项目目录或 openspec 目录] [--days 60]
 *     不写目录就是当前目录；--days：骨架里带最近多少天归档的变更，默认 60，0 表示全部
 * 骨架里已归档的按日期排在前面、进行中的在后面，状态填好；大需求的名字、每行的模块和说明、还没开始的模块留给模型补。
 *   node plan.js new --task <大任务名> --changes c1,c2 [项目目录]
 *     探索时建大任务：plan.md 加一节，建 openspec/explore/<大任务名>.md。已经有的不动，表里缺的 change 补上。
 *   node plan.js link --task <大任务名> --changes c1,c2 [--note <说明>] [--project <项目目录>]
 *     把已有的 change（进行中或已归档）归到一个大任务（第 61、62 条）：没有这个大任务就建一节，不建探索记录，算老任务。已经在别的大任务里的不动。
 *   node plan.js related [--project <项目目录>]
 *     列出没归到大任务、可能是一件事的 change 和线索。只读。
 */
const fs = require('fs');
const path = require('path');
const { changeRoots, planInit, planAddTask, planLink, refreshPlan } = require('../lib/session');

const args = process.argv.slice(2);
if (args[0] === 'link' || args[0] === 'related') {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] || '' : ''; };
  const dir0 = path.resolve(flag('--project') || process.cwd());
  const oses = path.basename(dir0).toLowerCase() === 'openspec' ? [dir0] : changeRoots(dir0).map((c) => path.dirname(c));
  if (args[0] === 'related') {
    const Link = require('../lib/plan-link');
    let n = 0;
    for (const os of oses) for (const g of Link.orphanGroups(os)) { n++; console.log(g.changes.join('、') + '：' + g.why.join('；')); }
    if (!n) console.log('没有找到可能是一件事的 change。');
    process.exit(0);
  }
  const task = flag('--task').trim(); const names = flag('--changes').split(/[,，\s]+/).filter(Boolean);
  if (!task || !names.length) { console.log('用法：node plan.js link --task <大任务名> --changes c1,c2 [--note <说明>] [--project <项目目录>]'); process.exit(1); }
  const os = oses.find((o) => names.some((c) => fs.existsSync(path.join(o, 'changes', c)))) || oses[0] || path.join(dir0, 'openspec');
  const r = planLink(os, task, names, flag('--note'));
  console.log((r.added.length ? '大任务 ' + task + ' 加了：' + r.added.join('、') + '。计划 ' + path.join(os, 'plan.md') : '没有加') + (r.skipped.length ? '。没动：' + r.skipped.map((s) => s.name + '（' + s.why + '）').join('、') : '') + '。');
  process.exit(r.added.length || r.skipped.length ? 0 : 1);
}
if (args[0] === 'new') {
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] || '' : ''; };
  const name = flag('--task').trim();
  const changes = flag('--changes').split(/[,，\s]+/).filter(Boolean);
  if (!name || !changes.length) { console.log('用法：node plan.js new --task <大任务名> --changes c1,c2 [项目目录]'); process.exit(1); }
  const skip = new Set([args.indexOf('--task') + 1, args.indexOf('--changes') + 1]);
  const dir = path.resolve(args.slice(1).find((a) => !a.startsWith('--') && !skip.has(args.indexOf(a))) || process.cwd());
  let root = dir;
  try { root = require('../lib/openspec').ensureRoot(dir) || dir; } catch (e) { /* 建不了 openspec/ 就按当前目录 */ }
  const osDir = path.basename(root).toLowerCase() === 'openspec' ? root : path.join(root, 'openspec');
  fs.mkdirSync(path.join(osDir, 'changes'), { recursive: true });
  const r = planAddTask(osDir, name, changes);
  console.log('大任务 ' + name + '：计划 ' + r.plan + '；探索记录 ' + r.explore + (r.created ? '（新建）' : '（已有）') + '。边谈边写进探索记录，定一件写一件。');
  process.exit(0);
}
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--days') || process.cwd());
const di = args.indexOf('--days');
const days = di >= 0 ? Number(args[di + 1]) || 0 : 60;
let osDir = '';
if (fs.existsSync(path.join(dir, 'openspec', 'changes'))) osDir = path.join(dir, 'openspec');
else if (path.basename(dir).toLowerCase() === 'openspec' && fs.existsSync(path.join(dir, 'changes'))) osDir = dir;
else { const r = changeRoots(dir); if (r.length) osDir = path.dirname(r[0]); }
if (!osDir) { console.log('没找到 openspec/changes：' + dir); process.exit(1); }
const r = planInit(osDir, days);
const s = refreshPlan(osDir, true);
if (r.created) console.log('已生成 ' + r.file + '：' + r.rows.length + ' 个变更，已归档的按日期排在前面，进行中的在后面，状态已填好。\n接下来补上：大需求的名字；每行的模块和说明；还没开始的模块（先起好变更名，状态会显示"未开始"）。不属于这个大需求的行删掉。会话汇总实时计算状态；需要更新表格时再运行本工具，写回的 plan.md 随本次提案、阶段或归档提交。');
else console.log(r.file + ' 已经有了，状态列已按实际情况刷新。');
if (s) console.log('共 ' + s.total + ' 个变更，已归档 ' + s.archived + (s.active.length ? '，进行中：' + s.active.join('、') : '') + (s.next ? '，下一个未开始：' + s.next : ''));

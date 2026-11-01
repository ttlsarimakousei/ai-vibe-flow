'use strict';
/*
 * 大需求的计划表 openspec/plan.md：没有就按现有的变更生成骨架，有就按实际情况刷新状态列。只动 plan.md，别的不碰。
 *   node plan.js [项目目录或 openspec 目录] [--days 60]
 *     不写目录就是当前目录；--days：骨架里带最近多少天归档的变更，默认 60，0 表示全部
 * 骨架里已归档的按日期排在前面、进行中的在后面，状态填好；大需求的名字、每行的模块和说明、还没开始的模块留给模型补。
 */
const fs = require('fs');
const path = require('path');
const { changeRoots, planInit, refreshPlan } = require('../lib/session');

const args = process.argv.slice(2);
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

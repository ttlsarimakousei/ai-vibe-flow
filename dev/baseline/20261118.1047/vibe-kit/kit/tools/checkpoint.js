'use strict';
/*
 * 检查点和一键回退（K3 M07，2026-11-01）。做法见 lib/checkpoint.js 开头。
 *
 *   node checkpoint.js save [--why "<接下来要做什么>"]       存一个检查点（不动暂存区、分支、工作区）
 *   node checkpoint.js list                                   这个会话存过的检查点
 *   node checkpoint.js restore <序号> [--only <文件>[,<文件>…]]  回退：只还原这个会话改过的文件，回退前自动再存一个
 *   node checkpoint.js help
 * 找自己是哪个会话、哪些文件算这个会话改过的：lib/edited-files.js（会话记录里成功的 Edit、Write）。--session <会话号> 可以直接给。
 */
const path = require('path');
const E = require('../lib/edited-files');
const C = require('../lib/checkpoint');

const argv = process.argv.slice(2);
const sub = (argv[0] || 'help').toLowerCase();
const opts = { only: [] };
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--why' && argv[i + 1] !== undefined) { opts.why = argv[++i]; continue; }
  if (a === '--session' && argv[i + 1] !== undefined) { opts.session = argv[++i]; continue; }
  if (a === '--only' && argv[i + 1] !== undefined) { opts.only.push(...argv[++i].split(',').map((s) => s.trim()).filter(Boolean)); continue; }
  pos.push(a);
}
const SELF = 'node "$HOME/.claude/vibe-kit/tools/checkpoint.js"';
const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

function help() {
  console.log([
    '检查点：大改之前把工作区存一份（只在本机的 git 引用里，不动暂存区、分支、工作区）；改坏了一条命令回去，只还原这个会话改过的文件。',
    '',
    '  ' + SELF + ' save --why "改订单导出"     存一个',
    '  ' + SELF + ' list                       这个会话存过的',
    '  ' + SELF + ' restore <序号>              回到那个检查点：只还原这个会话用 Edit、Write 改过的文件，别的不碰；回退前自动再存一个，回退也能撤销',
    '  ' + SELF + ' restore <序号> --only a.java  只还原其中几个',
    '',
    '这个会话用 Bash 改的文件（sed、脚本生成的）认不出来，回退不管它们。',
  ].join('\n'));
  return 0;
}

function session() {
  const s = E.findSession({ sid: opts.session, cwd: process.cwd(), marker: /checkpoint\.js/i });
  if (s.error) { console.log(s.error + '。'); return null; }
  return s;
}

function save() {
  const s = session();
  if (!s) return 1;
  const r = C.save({ sid: s.sid, transcript: s.transcript, cwd: process.cwd(), why: opts.why || pos.join(' ') });
  if (r.error) { console.log(r.error); return 1; }
  const bad = r.repos.filter((x) => x.error);
  const ok = r.repos.filter((x) => !x.error);
  const out = [];
  if (ok.length) out.push('已存第 ' + r.n + ' 个检查点' + (ok.length > 1 ? '（' + ok.length + ' 个仓库：' + ok.map((x) => path.basename(x.root)).join('、') + '）' : '') + '。改坏了：' + SELF + ' restore ' + r.n);
  for (const x of ok) if (x.big.length) out.push(path.basename(x.root) + ' 里这几个太大（超过 20 MB）没存，回退时不管它们：' + x.big.slice(0, 5).join('、') + (x.big.length > 5 ? ' 等' : ''));
  for (const x of bad) out.push(path.basename(x.root) + ' 没存成：' + x.error);
  console.log(out.join('\n'));
  return ok.length ? 0 : 1;
}

function list() {
  const s = session();
  if (!s) return 1;
  const files = E.editedFiles(E.entriesOf(s.transcript), process.cwd());
  const roots = [...new Map([E.repoOf(process.cwd())].concat(files.map((f) => E.repoOf(f.abs))).filter(Boolean).map((r) => [r.toLowerCase(), r])).values()];
  const out = [];
  for (const root of roots) {
    const l = C.list(root, s.sid);
    if (!l.length) continue;
    out.push(path.basename(root) + '（' + root + '）：');
    for (const x of l) out.push('  ' + x.n + '  ' + when(x.at) + '  ' + x.why);
  }
  console.log(out.length ? out.join('\n') : '这个会话还没存过检查点。' + SELF + ' save --why "<接下来要做什么>"');
  return 0;
}

function restore() {
  const n = Number(pos[0]);
  if (!Number.isInteger(n) || n < 1) { console.log('要写序号：' + SELF + ' restore <序号>（' + SELF + ' list 看有哪些）'); return 1; }
  const s = session();
  if (!s) return 1;
  const r = C.restore({ sid: s.sid, transcript: s.transcript, cwd: process.cwd(), n, only: opts.only });
  if (r.error) { console.log(r.error); return 1; }
  const out = ['回到了第 ' + n + ' 个检查点（回退之前的样子存成了第 ' + r.before + ' 个，要撤销就 restore ' + r.before + '）。'];
  if (r.restored.length) out.push('还原了：' + r.restored.join('、'));
  if (r.removed.length) out.push('删掉了（检查点之后才建的）：' + r.removed.join('、'));
  if (!r.restored.length && !r.removed.length) out.push('这个会话改过的文件和那时一样，没动。');
  if (r.unsure.length) out.push('没动（拿不准那时的样子）：' + r.unsure.map((x) => x.rel + '（' + x.why + '）').join('、'));
  if (r.missing.length) out.push('这几个仓库里没有这个检查点，没动：' + r.missing.map((x) => path.basename(x)).join('、'));
  out.push('暂存区、分支没动；用 git diff 看现在的样子。');
  console.log(out.join('\n'));
  return 0;
}

let code = 0;
try {
  if (sub === 'save') code = save();
  else if (sub === 'list') code = list();
  else if (sub === 'restore') code = restore();
  else code = help();
} catch (e) { console.log('出错了：' + ((e && e.stack) || e)); code = 1; }
process.exit(code);

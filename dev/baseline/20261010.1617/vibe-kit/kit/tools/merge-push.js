'use strict';
/*
 * 用户说“合并push”时用的工具：先 plan 把本地事件分组列出来，再 apply --plan <文件> --push。
 * --push 仍由 guard-commit 检查最新真人授权。计划文件只在项目 .vibe/tmp 下。
 */
const fs = require('fs');
const path = require('path');
const M = require('../lib/merge-push');
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i < 0 ? '' : args[i + 1] || ''; };
function planPath(root, file) {
  const base = path.resolve(root, '.vibe', 'tmp');
  const f = path.resolve(file || path.join(base, 'merge-push', 'plan.json'));
  if (!f.startsWith(base + path.sep)) throw new Error('计划文件放在当前项目 .vibe/tmp 内。');
  let parent = f;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = fs.realpathSync(parent);
  const realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.toLowerCase().startsWith((realRoot + path.sep).toLowerCase())) throw new Error('计划目录链接到了项目之外，不能读写。');
  return f;
}
try {
  if (args[0] === 'plan') {
    const p = M.plan(path.resolve(val('--dir') || process.cwd()));
    const f = planPath(p.root, val('--out'));
    const ignored = require('child_process').spawnSync('git', ['-C', p.root, 'check-ignore', '--quiet', '--no-index', f], { windowsHide: true });
    if (ignored.status !== 0) throw new Error('先在 .gitignore 里忽略 .vibe/ 并提交，再生成计划；过程文件不能混进提交。');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
    console.log(JSON.stringify({ ok: true, plan: f, before: p.groups.reduce((n, g) => n + g.ids.length, 0), after: p.groups.length, groups: p.groups }));
  } else if (args[0] === 'apply') {
    const root = path.resolve(val('--dir') || process.cwd());
    const f = planPath(root, val('--plan'));
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (fs.realpathSync(p.root).toLowerCase() !== fs.realpathSync(root).toLowerCase()) throw new Error('计划属于别的项目，不能借用这次合并授权。');
    const result = M.apply(p, args.includes('--push'));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else throw new Error('用法：merge-push.js plan [--dir 目录]，再 apply --dir 目录 --plan 文件 --push');
} catch (e) {
  console.log(JSON.stringify({ ok: false, msg: String(e.message || e) }));
  process.exitCode = 1;
}

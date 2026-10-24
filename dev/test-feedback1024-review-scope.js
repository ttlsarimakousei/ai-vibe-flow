'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 5 类：review.js 的材料、用法、预算（#197、#206、#211，旧 #189、#187）
 * 用法：node dev/test-feedback1024-review-scope.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');

(async () => {
  const h = H.makeHome('feedback1024-review-scope', process.argv[2], { reviewBudgetSeconds: 60 });
  const S = require(path.join(h.kit, 'lib/session'));
  const R = require(path.join(h.kit, 'lib/review-runner'));
  const F = require(path.join(h.kit, 'lib/flow-policy'));
  const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
  const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();

  let mode = 'text';
  H.section('#206 早就在的未跟踪文件不送审；改过的已跟踪文件排在前面');
  mode = 'text';
  const q = H.makeRepo(path.join(h.work, 'q'), { '.gitignore': '.vibe/\n', 'src/A.java': 'class A {}\n' });
  for (let i = 0; i < 30; i++) H.write(path.join(q, '.claude', 'skills', 's' + i + '.md'), '老技能 ' + i + '\n');
  const old = (Date.now() - 3 * 86400000) / 1000;
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else fs.utimesSync(f, old, old); } };
  walk(path.join(q, '.claude'));
  // 基线提交在这些文件之后
  H.write(path.join(q, 'README.md'), '说明\n'); H.git(q, ['add', 'README.md']); H.git(q, ['commit', '-qm', 'docs: 说明']);
  const qbase = H.git(q, ['rev-parse', 'HEAD']).out.trim();
  H.write(path.join(q, 'src/A.java'), 'class A { int x; }\n'); H.write(path.join(q, 'src/B.java'), 'class B {}\n');
  const m = R.materials({ cwd: q, mode: 'code', base: qbase }, null);
  const files = [...new Set(m.items.map((x) => x.file))];
  H.ok('改过的 A.java、新建的 B.java 都在材料里', files.includes('src/A.java') && files.includes('src/B.java'), files);
  H.ok('基线提交之前就在的未跟踪文件（.claude/skills/…）不送审，也不占 20 个文件的上限', !files.some((f) => /^\.claude\//.test(f)) && !m.skipped.some((x) => /上限/.test(x.reason)), { files, skipped: m.skipped.slice(0, 3) });
  H.ok('已跟踪的改动排在最前面', files[0] === 'src/A.java', files);

  // ---------------------------------------------------------------------------------------------
  H.section('#197 不走 OpenSpec 的改动：报错里带上不带 --change 的写法；--help 有完整用法');
  let err = '';
  try { await R.run({ cwd: p, change: 'print-textarea-truncate', mode: 'code', base }); } catch (e) { err = e.message; }
  H.ok('编了个变更名：报错说清楚不走 OpenSpec 的改动不带 --change、给出写法', /没找到当前变更/.test(err) && /不带 --change/.test(err) && /--mode code --project .* --base/.test(err), err);
  const help = H.node(h, path.join(h.kit, 'tools/review.js'), ['--help']);
  H.ok('review.js --help：列出 run 的几种写法（变更、审查点、不走 OpenSpec、多仓 --base）', /--change/.test(help.out + help.err) && /不走 OpenSpec/.test(help.out + help.err) && /--base\s+<仓库[^>]*>=<提交>/.test(help.out + help.err), help.out + help.err);

  // ---------------------------------------------------------------------------------------------
  H.section('#189 多仓：--base 写成 仓库=提交，几个仓库各用各的基线');
  const shell = path.join(h.work, 'shell'); H.write(path.join(shell, 'CLAUDE.md'), '# 壳子\n');
  const g1 = H.makeRepo(path.join(shell, 'gwjh'), { 'a.js': 'a\n' }); const g2 = H.makeRepo(path.join(shell, 'gwjhmq'), { 'b.js': 'b\n' });
  H.makeRepo(shell, { 'openspec/changes/add-page/proposal.md': '## Why\n\n页面。\n\n## What Changes\n\n- 改 gwjh/a.js\n', 'openspec/changes/add-page/tasks.md': '- [x] 1.1 改 gwjh/a.js：加页面\n', '.gitignore': '.vibe/\ngwjh/\ngwjhmq/\n' });
  const b1 = H.git(g1, ['rev-parse', 'HEAD']).out.trim(); const b2 = H.git(g2, ['rev-parse', 'HEAD']).out.trim();
  H.write(path.join(g1, 'a.js'), 'a2\n'); H.write(path.join(g2, 'b.js'), 'b2\n');
  const change = S.allChanges(shell).find((c) => c.name === 'add-page');
  let mm = null; let me = '';
  try { mm = R.materials({ cwd: shell, mode: 'code', base: ['gwjh=' + b1, 'gwjhmq=' + b2] }, change); } catch (e) { me = e.message; }
  const mf = mm ? [...new Set(mm.items.map((x) => x.file))] : [];
  H.ok('两个仓库各自的 --base 都认：两个改动都在材料里', !!mm && mf.some((f) => /gwjh\/a\.js$/.test(f)) && mf.some((f) => /gwjhmq\/b\.js$/.test(f)), me || mf);
  let m2 = null; me = '';
  try { m2 = R.materials({ cwd: shell, mode: 'code', base: b1 }, change); } catch (e) { me = e.message; }
  H.ok('只给一个不带等号的 --base：用在认得它的仓库上，不整轮报"不是本地提交"', !!m2 && [...new Set(m2.items.map((x) => x.file))].some((f) => /gwjh\/a\.js$/.test(f)), me || m2.skipped);
  H.ok('别的仓库没有基线：跳过并说出要的写法', !!m2 && m2.skipped.some((x) => /--base\s+\S+=/.test(x.reason)), m2 && m2.skipped);

  // ---------------------------------------------------------------------------------------------
  H.section('#211 不带变更名的审查：基线不同各算各的预算');
  const k1 = R.jobKey(p, '', 'code', '', base); const k2 = R.jobKey(p, '', 'code', '', 'abc1234');
  H.ok('不带变更名的审查：基线不同就是不同的审查', k1 !== k2);
  H.ok('带变更名的审查不受影响：基线不进钥匙', R.jobKey(shell, 'add-page', 'code', '', b1) === R.jobKey(shell, 'add-page', 'code', '', b2));
  H.done('1024 反馈：审查材料和用法');
})().catch((e) => { console.error(e); process.exit(1); });

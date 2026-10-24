'use strict';
/*
 * 1024 导出议题（docs/feedback-20261024.md）第 7 类：钩子 12 秒预算用完、git 超时
 *   #208（0051，旧 #147）收工检查"核对文件指纹"：对每个已跟踪文件都 lstat、realpath，壳子带五六个子项目、上万个文件时 12 秒不够
 *   #198、#200—#205、#216、#217（1453）阶段名只写"Git config""Git ls-files"，看不出慢在哪个子项目
 * 改法：没改过的已跟踪文件直接用 ls-files -s 的哈希；阶段名带上仓库名。指纹的值对没有链接的仓库和改前完全一样（已有的许可、审查记录不失效）。
 * 用法：node dev/test-feedback1024-budget.js [旧版的 vibe-kit 目录]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const BASE = path.join(__dirname, 'baseline', '20261018.0051', 'vibe-kit');
const h = H.makeHome('feedback1024-budget', process.argv[2], {});
const ref = H.makeHome('feedback1024-budget-ref', BASE, {});
const W = require(path.join(h.kit, 'lib/workspace'));
const W0 = require(path.join(ref.kit, 'lib/workspace'));
const I = require(path.join(h.kit, 'lib/invocation'));

H.section('指纹：改前改后哈希一样（有改动、有未跟踪、有删掉的、tasks.md 打勾、core.autocrlf=true）');
const files = { '.gitignore': '.vibe/\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n', 'docs/a.md': '说明\r\n', 'openspec/changes/x/tasks.md': '- [ ] 1.1 改 src/A.java：加功能\n', 'openspec/changes/x/design.md': '设计\n' };
const p = H.makeRepo(path.join(h.work, 'p'), files);
const same = (label) => { for (const kind of ['all', 'code']) H.ok(label + '（' + kind + '）', W.fingerprint(p, kind).hash === W0.fingerprint(p, kind).hash); };
same('干净的仓库');
H.write(path.join(p, 'src/A.java'), 'class A { int x; }\n'); same('改了一个文件');
H.write(path.join(p, 'src/C.java'), 'class C {}\n'); same('加了一个未跟踪文件');
fs.unlinkSync(path.join(p, 'src/B.java')); same('删了一个已跟踪文件');
H.write(path.join(p, 'openspec/changes/x/tasks.md'), '- [x] 1.1 改 src/A.java：加功能\n'); same('打了勾');
H.git(p, ['config', 'core.autocrlf', 'true']); H.write(path.join(p, 'docs/a.md'), '说明\r\n改了\r\n'); same('core.autocrlf=true、改了带 CRLF 的文件');

H.section('指纹：上万个文件的仓库，改后明显比改前快');
const big = path.join(h.work, 'big');
fs.mkdirSync(big, { recursive: true });
H.git(big, ['init', '-q']); H.git(big, ['config', 'user.email', 't@e.com']); H.git(big, ['config', 'user.name', 't']); H.git(big, ['config', 'core.autocrlf', 'false']);
for (let d = 0; d < 60; d++) for (let i = 0; i < 100; i++) H.write(path.join(big, 'm' + d, 'F' + i + '.java'), 'class F' + i + ' { }\n');
H.git(big, ['add', '-A']); H.git(big, ['commit', '-qm', 'chore: 初始']);
const time = (WW) => { const t = Date.now(); const r = WW.fingerprint(big, 'all'); return { ms: Date.now() - t, hash: r.hash, n: r.files.length }; };
time(W); time(W0); // 先各跑一次热身（git 的索引、文件缓存）
const now = time(W); const before = time(W0);
H.ok('6000 个文件：指纹和改前一样', now.hash === before.hash && now.n === 6000, { now, before });
H.ok('6000 个文件：改后用时不到改前的六成（改前 ' + before.ms + ' 毫秒，改后 ' + now.ms + ' 毫秒）', now.ms <= before.ms * 0.6, { now: now.ms, before: before.ms });

H.section('阶段名写出是哪个仓库（预算用完的报错里报的就是最后一个阶段）');
const names = [];
I.run(() => W.fingerprint(p, 'code'), { budgetMs: 12000, onPhase: (name) => names.push(name) });
H.ok('git 的阶段带仓库名', names.some((n) => /^Git ls-files（p）$/.test(n)) && names.some((n) => /^Git diff（p）$/.test(n)), names);
H.ok('核对文件指纹的阶段带仓库名', names.includes('核对文件指纹（p）'), names);
H.done('1024 反馈：钩子预算');

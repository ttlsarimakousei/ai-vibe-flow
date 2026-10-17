'use strict';
/*
 * 发版回归里"没动过的独立模块不测"（用户 2026-10-17 提的，2026-10-18 做）：从某个版本（git 标签）以来，
 * 一个模块的测试用到的文件一个都没改过，这个模块的测试就跳过。全由脚本判断，不靠模型。
 *   - 一个模块 = 几套测试 + 它们用到的文件。用到的文件这样找：
 *       1. 写明的目录（技能目录、看页面的执行器）：整个目录
 *       2. 测试脚本自己，连同它 require 到的 dev/ 下的文件（测试支架、假服务）
 *       3. 测试脚本、写明的目录里的脚本调到的套件文件（H.hook(h, '名字')、'tools', 'x.js' 这类写法、Python 里的 "tools" / "x.js"），
 *          连同这些套件文件 require 到的（按源码里的 require('./x')、path.join(__dirname, ...) 逐层找）
 *     测试支架（dev/lib/）里提到的套件文件不往下找：那是某些测试才调的公共函数，不是每个模块都用
 *   - 这些文件从 <since> 以来改过的（提交过的、工作区里没提交的、新加没跟踪的），有一个就照测；都没改才跳过
 *   - 判断不了（git 出错、标签不存在）一律照测
 *   - 运行环境（Python、JDK、H2 的版本）不在 git 里，换了要自己全量跑一次（不给 --since）
 * 用法（run-all.js 的 --since 用它）：plan(since) → { ok, why, skip: [{ module, suites, files（用到的文件数） }], run: [...] }
 * 单独看：node dev/lib/affected.js <标签>   列出每个模块用到哪些文件、哪些改过
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const KIT = 'vibe-kit/kit';
// 独立模块。suites：dev/ 下的测试脚本；dirs：整个算进去的目录（仓库根起的相对路径）
const MODULES = [
  { name: '查库（H2）', suites: ['test-dbcrud.js'], dirs: ['vibe-kit/claude/skills/ttls-db-crud/'] },
  { name: '起服务', suites: ['test-devserver-0929.js'], dirs: [] },
  { name: '看页面', suites: ['test-page-0929.js'], dirs: ['vibe-kit/kit/page/', 'vibe-kit/claude/skills/ttls-see-page/'] },
  { name: '查 redis', suites: ['test-redis.js'], dirs: ['vibe-kit/claude/skills/ttls-redis/'] },
];

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch (e) { return false; } };
const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch (e) { return ''; } };
function asJs(abs) { for (const c of [abs, abs + '.js']) if (isFile(c)) return c; return ''; }
function walk(absDir, out) {
  let list = [];
  try { list = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of list) { const p = path.join(absDir, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p); }
  return out;
}
/** 一个文件里提到的别的文件（绝对路径）。kitRefs 为假时只找相对的 require（测试支架用） */
function refsOf(abs, kitRefs) {
  const text = read(abs);
  const dir = path.dirname(abs);
  const out = [];
  const add = (p) => { const f = asJs(p); if (f) out.push(f); };
  // require('./x')、'../lib/x'：相对这个文件
  for (const m of text.matchAll(/['"](\.{1,2}\/[\w./-]+)['"]/g)) add(path.resolve(dir, m[1]));
  // path.join(__dirname, 'a', 'b.js')：相对这个文件
  for (const m of text.matchAll(/path\.join\(\s*__dirname\s*((?:,\s*['"][^'"]+['"]\s*)+)\)/g)) add(path.resolve(dir, ...[...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])));
  if (!kitRefs) return out;
  const kit = path.join(REPO, KIT);
  // 'tools', 'x.js'、'kit', 'page', 'x.js'、'lib/x.js'：套件里的文件
  for (const m of text.matchAll(/['"](?:kit['"]\s*,\s*['"])?(lib|hooks|tools|router|page)['"]\s*,\s*['"]([\w.-]+)['"]/g)) add(path.join(kit, m[1], m[2]));
  for (const m of text.matchAll(/['"](lib|hooks|tools|router|page)\/([\w.-]+\.js)['"]/g)) add(path.join(kit, m[1], m[2]));
  // Python：k / "tools" / "onboard.js"
  for (const m of text.matchAll(/["'](lib|hooks|tools|router)["']\s*\/\s*["']([\w.-]+\.js)["']/g)) add(path.join(kit, m[1], m[2]));
  // 测试里调钩子：H.hook(h, 'guard-commit' …)、hook('pre-edit' …)
  for (const m of text.matchAll(/\bhook\(\s*(?:[\w.]+\s*,\s*)?['"]([a-z][\w-]*)['"]/g)) add(path.join(kit, 'hooks', m[1] + '.js'));
  return out;
}
/** 一个模块用到的文件（仓库根起的相对路径，排好序） */
function filesOf(mod) {
  const seen = new Set();
  const queue = [];
  const push = (abs) => { const k = path.resolve(abs); if (!seen.has(k) && isFile(k)) { seen.add(k); queue.push(k); } };
  for (const s of mod.suites) push(path.join(REPO, 'dev', s));
  for (const d of mod.dirs) for (const f of walk(path.join(REPO, d), [])) push(f);
  const devLib = path.join(REPO, 'dev', 'lib') + path.sep;
  const inDirs = (abs) => mod.dirs.some((d) => rel(abs).startsWith(d));
  for (let i = 0; i < queue.length; i++) {
    const f = queue[i];
    // node_modules 里的不往下找（整个目录已经算进去了）；只看脚本
    if (/[\\/]node_modules[\\/]/.test(f) || !/\.(js|py|ps1)$/i.test(f)) continue;
    for (const r of refsOf(f, !f.startsWith(devLib) || inDirs(f))) push(r);
  }
  return [...seen].map(rel).sort();
}
function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? String(r.stdout || '') : null;
}
/** 从 since 以来改过的文件：提交过的 + 工作区里的（git diff since 已经包含暂存和没暂存的）+ 没跟踪的。判断不了返回 null */
function changedSince(since) {
  if (!since || git(['rev-parse', '--verify', '--quiet', since + '^{commit}']) === null) return null;
  const a = git(['diff', '--name-only', '--no-renames', since]);
  const b = git(['ls-files', '--others', '--exclude-standard']);
  if (a === null || b === null) return null;
  return new Set((a + '\n' + b).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}
function plan(since) {
  const changed = changedSince(since);
  if (!changed) return { ok: false, why: '判断不了从 ' + since + ' 以来改了什么（标签不存在或 git 出错），全部照测', skip: [], run: MODULES.map((m) => ({ module: m.name, suites: m.suites })) };
  const skip = [];
  const run = [];
  for (const m of MODULES) {
    const files = filesOf(m);
    const hit = files.filter((f) => changed.has(f));
    if (hit.length) run.push({ module: m.name, suites: m.suites, changed: hit });
    else skip.push({ module: m.name, suites: m.suites, files: files.length });
  }
  return { ok: true, since, skip, run };
}

module.exports = { MODULES, filesOf, changedSince, plan };

if (require.main === module) {
  const since = process.argv[2];
  if (!since) { console.log('用法：node dev/lib/affected.js <标签，比如 v20261018.0051>'); process.exit(2); }
  const changed = changedSince(since);
  if (!changed) { console.log('判断不了从 ' + since + ' 以来改了什么'); process.exit(1); }
  for (const m of MODULES) {
    const files = filesOf(m);
    const hit = files.filter((f) => changed.has(f));
    console.log('== ' + m.name + '（' + m.suites.join('、') + '）：用到 ' + files.length + ' 个文件，' + (hit.length ? '改过 ' + hit.length + ' 个，照测' : '都没改过，可以跳过'));
    for (const f of files) console.log('   ' + (changed.has(f) ? '* ' : '  ') + f);
  }
}

'use strict';
/*
 * 随包依赖里运行时用不到的文件（类型声明、TS 源码、source map、包根目录的 README 和更新记录）：删掉，安装包小一点（仓库主人 2026-11-04："看看还有没有多余的残留"）。
 * LICENSE 留着；OpenSpec 的模板也是 .md，所以 .md 只删包根目录的 README、CHANGELOG、HISTORY。
 * 整个目录删的：playwright-core/lib/vite（录制器、trace 查看器、面板、测试报告的网页界面）。代码里只有 page.pause、codegen、
 *   show-trace、面板这几个功能读它，套件都不用（kit/page/browser.js、scenario-run.js 只开浏览器、截图、发请求）。
 * 升级依赖（docs/release.md）之后跑一次；dev/pack.js 打包前用 --check 查，有残留不打包。
 * 用法：node dev/prune-deps.js          删
 *       node dev/prune-deps.js --check  只查，有就退出码 1
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['kit/page/node_modules', 'kit/openspec/node_modules'].map((d) => path.join(__dirname, '..', 'vibe-kit', d));
const CODE_ONLY = /\.(d\.ts|d\.cts|d\.mts|ts|cts|mts|map)$/i;
const DOC_AT_ROOT = /^(readme|changelog|history)(\.|$)/i;
const WHOLE_DIRS = ['kit/page/node_modules/playwright-core/lib/vite'].map((d) => path.join(__dirname, '..', 'vibe-kit', d));

function all(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) all(f, out); else out.push(f); }
  return out;
}
function find(dir, out) {
  if (WHOLE_DIRS.includes(dir)) return all(dir, out);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  const isPackageRoot = entries.some((e) => e.isFile() && e.name === 'package.json');
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) find(f, out);
    else if (CODE_ONLY.test(e.name) || (isPackageRoot && DOC_AT_ROOT.test(e.name))) out.push(f);
  }
  return out;
}
/** 删完留下的空目录也删掉 */
function dropEmpty(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) dropEmpty(path.join(dir, e.name));
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

const left = ROOTS.flatMap((r) => find(r, []));
if (process.argv.includes('--check')) {
  if (left.length) { console.log('依赖里还有运行时用不到的文件 ' + left.length + ' 个，跑 node dev/prune-deps.js，例：' + left[0]); process.exit(1); }
  console.log('依赖里没有运行时用不到的文件');
  process.exit(0);
}
let bytes = 0;
for (const f of left) { bytes += fs.statSync(f).size; fs.unlinkSync(f); }
for (const r of ROOTS) if (fs.existsSync(r)) dropEmpty(r);
console.log('删了 ' + left.length + ' 个文件，' + (bytes / 1048576).toFixed(1) + ' MB');

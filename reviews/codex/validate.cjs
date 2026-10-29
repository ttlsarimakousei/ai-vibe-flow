'use strict';
// 交付检查：只读报告、源码清单和新脚本，验证完整性；不执行套件、不改变用户目录。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const base = __dirname;
const root = path.resolve(base, '../..');
const failures = [];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink()) { failures.push('报告中不能有目录链接：' + e.name); continue; }
    if (e.isDirectory()) walk(f); else files.push(f);
  }
}
walk(base);
for (const name of ['README.md', '20261029-vibe-kit-第一轮-sol.md', '20261029-vibe-kit-第二轮-terra.md', '20261030-vibe-kit-第三轮-astra.md', '20261030-vibe-kit-三轮审核综合.md', '20261030-vibe-kit-改进路线.md', 'evidence/inventory.json', 'evidence/execution.json', 'evidence/dynamic-results.json']) {
  if (!fs.existsSync(path.join(base, name))) failures.push('缺交付文件：' + name);
}
for (const f of files) {
  if (!/\.(md|json|txt|cjs)$/.test(f)) continue;
  const b = fs.readFileSync(f);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { failures.push('不是 UTF-8：' + path.relative(base, f)); continue; }
  if (b[0] === 239 && b[1] === 187 && b[2] === 191) failures.push('含 BOM：' + path.relative(base, f));
  if (text.includes('\r')) failures.push('不是 LF 换行：' + path.relative(base, f));
  if (f.endsWith('.json')) { try { JSON.parse(text); } catch (e) { failures.push('JSON 解析失败：' + path.relative(base, f)); } }
  if (f.endsWith('.cjs')) {
    const r = spawnSync(process.execPath, ['--check', f], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) failures.push('脚本语法失败：' + path.relative(base, f));
  }
  if (f.endsWith('.md')) for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = m[1].replace(/^<|>$/g, '').split('#')[0];
    if (!link || /^(https?:|mailto:)/i.test(link)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(f), decodeURIComponent(link)))) failures.push('文件链接失效：' + path.relative(base, f) + ' -> ' + link);
  }
}
const inventory = JSON.parse(fs.readFileSync(path.join(base, 'evidence/inventory.json'), 'utf8'));
const integration = JSON.parse(fs.readFileSync(path.join(base, 'evidence/upstream-integration.json'), 'utf8'));
let unchanged = 0; const upstreamDocumentationChanges = [];
for (const row of inventory.files) {
  const f = path.join(root, row.file);
  const sha = fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : '';
  if (sha === row.sha256) { unchanged++; continue; }
  const known = integration.upstreamChanges.find(x => x.file === row.file);
  if (row.file === 'docs/decisions.md' && known && known.before === row.sha256 && known.after === sha) upstreamDocumentationChanges.push(row.file);
  else failures.push('审核期间源码或文档发生未核对变化：' + row.file);
}
for (const row of integration.upstreamChanges) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(root, row.file))).digest('hex') !== row.after) failures.push('远端文档合入后又有变化：' + row.file);
const execution = JSON.parse(fs.readFileSync(path.join(base, 'evidence/execution.json'), 'utf8'));
if (execution.regression.code !== 0) failures.push('基础回归未成功');
const summary = fs.readFileSync(path.join(base, 'evidence/regression-summary.txt'), 'utf8');
if (!/合计：64 套，通过 3498 项，失败 0 项/.test(summary)) failures.push('基础回归摘要与本轮记录不一致');
console.log(JSON.stringify({ files: files.length, baselineFilesUnchanged: unchanged, upstreamDocumentationChanges, scripts: files.filter(f => f.endsWith('.cjs')).length, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;

'use strict';
// 审核清单：只解析源文件，不 require 或执行套件；第三方内置依赖只记录版本。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const root = path.resolve(__dirname, '../..');
const out = path.join(__dirname, 'evidence'); fs.mkdirSync(out, { recursive: true });
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (['node_modules', 'baseline', '__pycache__', '.git'].includes(e.name)) continue;
    const rel = dir + '/' + e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(rel);
    else if (/\.(?:js|cjs|py|java|md|json|html|bat|ps1)$/.test(rel)) files.push(rel);
  }
}
walk('vibe-kit'); walk('dev'); walk('docs');
const rows = [], failures = [];
for (const file of files.sort()) {
  const b = fs.readFileSync(path.join(root, file)); const text = b.toString('utf8');
  const item = { file, bytes: b.length, lines: text.split('\n').length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
  if (!file.endsWith('.bat')) { try { new TextDecoder('utf-8', { fatal: true }).decode(b); item.utf8 = true; } catch (e) { item.utf8 = false; } item.bom = b[0] === 239 && b[1] === 187 && b[2] === 191; }
  if (/\.(?:js|cjs)$/.test(file)) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    item.syntax = r.status === 0;
    if (!item.syntax) failures.push({ file, error: String(r.stderr || r.error || '').slice(0, 1000) });
  }
  rows.push(item);
}
const packages = ['vibe-kit/kit/openspec/package.json', 'vibe-kit/kit/openspec/node_modules/@fission-ai/openspec/package.json', 'vibe-kit/kit/page/node_modules/playwright/package.json', 'vibe-kit/kit/page/node_modules/pixelmatch/package.json', 'vibe-kit/kit/page/node_modules/pngjs/package.json'].map(file => {
  try { const p = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); return { file, name: p.name, version: p.version, engines: p.engines, dependencies: p.dependencies }; } catch (e) { return { file, missing: true }; }
});
const summary = { base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim(), node: process.version, files: rows.length, jsChecked: rows.filter(x => x.syntax !== undefined).length, syntaxFailures: failures.length, ownedSourceLines: rows.filter(x => x.file.startsWith('vibe-kit/') && /\.(js|py|java)$/.test(x.file)).reduce((n, x) => n + x.lines, 0), packages };
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify({ summary, failures, files: rows }, null, 2) + '\n');
console.log(JSON.stringify(summary));
console.log('语法失败：' + JSON.stringify(failures));

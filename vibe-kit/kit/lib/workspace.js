'use strict';
/* 本机范围指纹。只保存哈希和相对文件名单，不把代码、差异或凭据写进状态。进度打勾不改变代码指纹。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
function git(root, args) { try { return execFileSync('git', ['-C', root].concat(args), { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 12 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; } }
function rootOf(dir) { return git(dir, ['rev-parse', '--show-toplevel']).trim() || path.resolve(dir); }
function checkedGit(root, args) { return execFileSync('git', ['-C', root].concat(args), { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 12 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
function progressText(s) { return String(s).replace(/^([ \t]*[-*][ \t]+)\[[ xX]\]/gm, '$1[ ]').replace(/^\s*(?:进度|已完成|更新时间)[：:].*$/gm, ''); }
function fingerprintOne(dir, kind) {
  const root = rootOf(dir);
  const hasGit = !!git(root, ['rev-parse', '--show-toplevel']).trim();
  if (!hasGit && fs.existsSync(path.join(root, '.git'))) throw new Error('Git 状态暂时无法读取，不能确认当前输入指纹');
  const listing = (args) => hasGit ? checkedGit(root, args) : '';
  const index = new Map();
  for (const line of listing(['ls-files', '-s', '-z']).split('\0')) { const m = line.match(/^\d+ ([a-f0-9]+) \d\t([\s\S]+)$/); if (m) index.set(m[2], m[1]); }
  const changed = new Set(listing(['diff', '--name-only', '-z']).split('\0'));
  let names = [...index.keys()].concat(listing(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'));
  if (!hasGit) {
    names = []; const walk = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (/^(\.git|\.vibe|router-data|node_modules|target|build|dist|out)$/.test(e.name) || e.isSymbolicLink()) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (e.isFile()) names.push(r); if (names.length > 5000) throw new Error('本机范围过大，无法核对完整输入，请缩小项目范围'); } }; walk(root, '');
  }
  const objectType = git(root, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 'sha256' : 'sha1';
  const normalize = /^(true|input)$/i.test(git(root, ['config', '--get', 'core.autocrlf']).trim());
  const selected = [...new Set(names)].filter((n) => n && !/(^|\/)(\.vibe|router-data|node_modules|target|build|dist|out)(\/|$)|(^|\/)(secrets\.json|\.env(?:\.[^/]*)?)$/i.test(n)).sort();
  const rows = [];
  for (const n of selected) {
    if (kind === 'code' && /^openspec\/.*(?:revisions\.md|plan\.md)$/.test(n)) continue;
    if (kind === 'code' && /^openspec\/.*\.md$/.test(n) && !/tasks\.md$/.test(n)) continue;
    try {
      const f = path.join(root, n); const st = fs.statSync(f); if (!st.isFile()) continue;
      const progress = kind === 'code' && /(^|\/)tasks\.md$/.test(n);
      if (index.has(n) && !changed.has(n) && !progress) { rows.push([n, index.get(n)]); continue; }
      let b = fs.readFileSync(f);
      if (progress) b = Buffer.from(progressText(b.toString('utf8')));
      else if (normalize && !b.includes(0)) b = Buffer.from(b.toString('utf8').replace(/\r\n/g, '\n'));
      rows.push([n, crypto.createHash(objectType).update('blob ' + b.length + '\0').update(b).digest('hex')]);
    }
    catch (e) { rows.push([n, '缺失']); }
  }
  return { root, hash: hash(JSON.stringify(rows)), files: rows.map((r) => r[0]) };
}
function fingerprint(dir, kind) {
  return require('./invocation').memo('fingerprint|' + path.resolve(dir) + '|' + kind, () => fingerprintRaw(dir, kind));
}
function fingerprintRaw(dir, kind) {
  const first = fingerprintOne(dir, kind); let roots = [];
  try { const S = require('./session'); if (S.isShell(first.root)) roots = S.nestedRepos(first.root); } catch (e) { /* 底层首次加载不探子项目 */ }
  const parts = roots.filter((r) => path.resolve(r).toLowerCase() !== first.root.toLowerCase()).map((r) => fingerprintOne(r, kind));
  if (!parts.length) return first;
  return { root: first.root, hash: hash(JSON.stringify([first].concat(parts).map((p) => [path.relative(first.root, p.root).replace(/\\/g, '/'), p.hash]))), files: first.files.concat(...parts.map((p) => p.files.map((f) => path.relative(first.root, p.root).replace(/\\/g, '/') + '/' + f))) };
}
module.exports = { hash, git, rootOf, fingerprint, progressText };

'use strict';
/* 更新前保留上一份程序包，断网也可恢复。只拷受管程序和原始模板，不拷 key、用户配置、状态、数据库连接或厂商驱动。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const safe = (r) => !/(^|\/)(?:state|router-data|feedback|drivers|__pycache__|update)(\/|$)|(^|\/)(?:secrets\.json|gitlab\.json|config\.json|local\.json|installed\.json|db-crud\.ini|redis\.json|\.env(?:\..*)?)$|\.jar$/i.test(r);
function list(dir, rel, out, dirs, strict) {
  if (fs.lstatSync(path.join(dir, rel)).isSymbolicLink()) throw new Error('恢复目录是链接');
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (!safe(r) || e.isSymbolicLink()) { if (strict) throw new Error('恢复包含未允许文件或链接'); continue; }
    if (e.isDirectory()) { dirs.push(r); list(dir, r, out, dirs, strict); }
    else if (e.isFile()) out[r] = hash(fs.readFileSync(path.join(dir, r)));
    else if (strict) throw new Error('恢复包含特殊文件');
  }
  return out;
}
function save(kit, folder) {
  const S = require('./session'); const drift = S.kitCodeDrift(); if (drift && drift.length) return { ok: false, reason: '当前程序与安装指纹不符，不把它当可恢复包' };
  const tmp = folder + '.' + process.pid + '.tmp';
  try {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true }); fs.mkdirSync(tmp, { recursive: true });
    const copy = (src, dst, rel) => { if (!safe(rel) || !fs.existsSync(src)) return; const st = fs.lstatSync(src); if (st.isSymbolicLink()) return; if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const n of fs.readdirSync(src)) copy(path.join(src, n), path.join(dst, n), rel + '/' + n); } else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); } };
    for (const n of ['hooks', 'lib', 'tools', 'page', 'statusline.js', '.ignore', 'VERSION']) copy(path.join(kit, n), path.join(tmp, 'kit', n), 'kit/' + n);
    copy(path.join(kit, 'router'), path.join(tmp, 'router'), 'router'); copy(path.join(kit, 'pristine'), path.join(tmp, 'claude'), 'claude');
    copy(path.join(kit, 'install.js'), path.join(tmp, 'install.js'), 'install.js'); copy(path.join(kit, 'settings.fragment.json'), path.join(tmp, 'settings.fragment.json'), 'settings.fragment.json');
    if (!fs.existsSync(path.join(tmp, 'claude', 'CLAUDE.md')) || !fs.existsSync(path.join(tmp, 'install.js'))) throw new Error('缺原始模板或安装器');
    const dirs = []; const manifest = { version: fs.readFileSync(path.join(kit, 'VERSION'), 'utf8').trim(), files: list(tmp, '', {}, dirs, false), dirs: dirs.sort() }; const text = JSON.stringify(manifest); fs.writeFileSync(path.join(tmp, 'backup-manifest.json'), text);
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true }); fs.renameSync(tmp, folder); return { ok: true, folder, version: manifest.version, manifestHash: hash(text) };
  } catch (e) { return { ok: false, reason: '本地恢复包未能建立' }; }
  finally { if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); }
}
function verify(folder, expected) {
  try {
    if (fs.lstatSync(folder).isSymbolicLink() || fs.lstatSync(path.join(folder, 'backup-manifest.json')).isSymbolicLink()) return false;
    const text = fs.readFileSync(path.join(folder, 'backup-manifest.json'), 'utf8'); const m = JSON.parse(text);
    if (!expected || hash(text) !== expected.manifestHash || m.version !== expected.version || !Array.isArray(m.dirs)) return false;
    const dirs = []; const now = list(folder, '', {}, dirs, true); delete now['backup-manifest.json'];
    return JSON.stringify(now) === JSON.stringify(m.files) && JSON.stringify(dirs.sort()) === JSON.stringify(m.dirs);
  } catch (e) { return false; }
}
module.exports = { save, verify };

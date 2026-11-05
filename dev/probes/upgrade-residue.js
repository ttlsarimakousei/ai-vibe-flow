'use strict';
/*
 * 升级残留（第 73 条，2026-11-06）：拿旧版的安装包装一遍，升到现在的源码，再开一次会话；和全新安装逐项比，多出来的就是历史残留。
 * 比这几样：~/.claude 下的文件（state、feedback、备份目录不算）、settings.json 的钩子和环境变量、权限规则、别的顶层设置。
 * 被跳过的目录（state、备份、pristine）另外按个数比；用户目录下别的东西也列。--with-router：旧版连路由一起装（2026-11-03 之前的版本才有）。
 * 假用户目录，不碰真实的。用法：node dev/probes/upgrade-residue.js [--with-router] <旧版 zip> [<旧版 zip> ...]
 */
const fs = require('fs');
const path = require('path');
const H = require('../lib/harness');

const WITH_ROUTER = process.argv.includes('--with-router');
const zips = process.argv.slice(2).filter((a) => a !== '--with-router');
/** 没跳过任何东西的目录概况：用户目录、.claude、vibe-kit 下每一项的文件数；state 下的文件名 */
function overview(h) {
  const count = (d) => { let n = 0; const go = (x) => { let l; try { l = fs.readdirSync(x, { withFileTypes: true }); } catch (e) { return; } for (const e of l) { if (e.isDirectory()) go(path.join(x, e.name)); else n++; } }; go(d); return n; };
  const out = new Map();
  for (const [label, base] of [['~', h.home], ['.claude', h.cfg], ['vibe-kit', path.join(h.cfg, 'vibe-kit')]]) {
    let l = []; try { l = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of l) out.set(label + '/' + e.name, e.isDirectory() ? count(path.join(base, e.name)) : 1);
  }
  let st = []; try { st = fs.readdirSync(path.join(h.cfg, 'vibe-kit', 'state')); } catch (e) { /* 没有 */ }
  for (const n of st) out.set('state/' + n, 1);
  return out;
}
const SKIP = /^(vibe-kit\/(state|feedback|openspec\/node_modules|page\/node_modules|pristine|user)\/|vibe-kit-backup|backups?\/|\.claude\.json|projects\/|vibe-kit\/backup)/;
function walk(root) {
  const out = [];
  const go = (d) => { let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of list) { const p = path.join(d, e.name); const rel = path.relative(root, p).split(path.sep).join('/'); if (SKIP.test(rel + '/')) continue; if (e.isDirectory()) go(p); else out.push(rel); } };
  go(root);
  return out;
}
function settingsView(cfg) {
  let s = {}; try { s = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8')); } catch (e) { return ['（settings.json 读不了）']; }
  const out = [];
  for (const [ev, list] of Object.entries(s.hooks || {})) for (const g of [].concat(list || [])) for (const x of [].concat((g && g.hooks) || [])) { const m = /([\w.-]+\.(?:js|py|ps1|cmd|bat))/.exec(String(x.command || x.url || '')); out.push('钩子 ' + ev + ' [' + ((g && g.matcher) || '') + '] ' + (m ? m[1] : String(x.command || x.url || '').slice(0, 60))); }
  for (const k of Object.keys(s.env || {})) out.push('环境变量 ' + k);
  for (const k of ['allow', 'deny', 'ask']) for (const v of (s.permissions && s.permissions[k]) || []) out.push('权限 ' + k + ' ' + v);
  for (const k of Object.keys(s)) if (!['hooks', 'env', 'permissions'].includes(k)) out.push('设置 ' + k + (typeof s[k] === 'object' ? '' : ' = ' + String(s[k]).slice(0, 40)));
  return out;
}
function newInstall(h) {
  const r = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  if (r.code !== 0) console.log('  新版安装退出码 ' + r.code + '：' + (r.out + r.err).slice(-300));
  return r;
}
function openSession(h) {
  const proj = H.makeRepo(path.join(h.root, 'w', 'p'), { 'a.txt': 'x\n' });
  H.node(h, path.join(h.kit, 'hooks', 'session-start.js'), [], { cwd: proj, timeout: 60000, input: JSON.stringify({ session_id: 'res-1', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: '' }) });
}
(async () => {
  const fresh = H.freshHome('res-new');
  newInstall(fresh); openSession(fresh);
  const baseFiles = new Set(walk(fresh.cfg)); const baseSettings = new Set(settingsView(fresh.cfg)); const baseView = overview(fresh);
  console.log('全新安装：' + baseFiles.size + ' 个文件，settings ' + baseSettings.size + ' 项');
  const union = new Map();
  for (const zip of zips) {
    const version = /(\d{8}\.\d{4})/.exec(zip); const name = version ? version[1] : path.basename(zip);
    const dir = H.tempDir('res-zip');
    try { require('../lib/unzip').extract(zip, dir); } catch (e) { console.log(name + '：解不开 ' + String(e.message).slice(0, 200)); continue; }
    let inst = path.join(dir, 'install.js');
    if (!fs.existsSync(inst)) { const sub = fs.readdirSync(dir).find((n) => fs.existsSync(path.join(dir, n, 'install.js'))); if (sub) inst = path.join(dir, sub, 'install.js'); }
    const h = H.freshHome('res-old');
    const old = H.node(h, inst, WITH_ROUTER ? ['--no-open'] : ['--no-router', '--no-open'], { cwd: path.dirname(inst), timeout: 180000 });
    if (old.code !== 0) { console.log(name + '：旧版装不上（' + old.code + '）' + (old.out + old.err).slice(-200)); continue; }
    const r = newInstall(h); openSession(h);
    const extra = walk(h.cfg).filter((f) => !baseFiles.has(f));
    const sets = settingsView(h.cfg).filter((s) => !baseSettings.has(s));
    const missing = [...baseFiles].filter((f) => !fs.existsSync(path.join(h.cfg, f)));
    console.log('\n## ' + name + '：多 ' + extra.length + ' 个文件，settings 多 ' + sets.length + ' 项，少 ' + missing.length + ' 个文件；新版安装退出码 ' + r.code);
    for (const f of extra) { union.set(f, (union.get(f) || []).concat(name)); console.log('  文件 ' + f); }
    for (const s of sets) { union.set(s, (union.get(s) || []).concat(name)); console.log('  ' + s); }
    for (const f of missing.slice(0, 10)) console.log('  少了 ' + f);
    for (const [k, n] of overview(h)) { const b = baseView.get(k); if (b === undefined || (b !== n && !/^vibe-kit\/(openspec|page|lib|hooks|tools)$/.test(k))) console.log('  概况 ' + k + '：' + n + (b === undefined ? '（全新安装没有）' : '（全新安装 ' + b + '）')); }
  }
  console.log('\n# 合计：' + union.size + ' 样');
  H.done('升级残留');
})().catch((e) => { console.log(e.stack); H.done('升级残留'); });

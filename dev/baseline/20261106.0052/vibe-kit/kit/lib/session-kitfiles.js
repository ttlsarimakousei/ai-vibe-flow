'use strict';
/*
 * 套件自己的文件不许模型改（保护路径），会话中途全局约定、技能变了的提示。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { KIT, readState, writeState, hookLog, normKey } = require('./session-state');

// ===================== 套件自己的文件（用户级）不许模型改 =====================
// 以前拿它拦模型改套件（开关"禁止改套件"），2026-11-04 去掉了（仓库主人定的：套件可以改）。现在拿它认"这是套件的东西"：读令牌、改动清单跳过套件的文件。
const CFG_DIR = path.dirname(KIT);

/** 路径解析成真实路径（跟着目录联接、符号链接走）；路径还不存在时解析它最近一级存在的上级，再把剩下的拼回去 */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (let i = 0; i < 60; i++) {
    try { const r = fs.realpathSync.native(cur); return rest.length ? path.join(r, ...rest.reverse()) : r; } catch (e) { /* 往上一级 */ }
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.push(path.basename(cur));
    cur = up;
  }
  return path.resolve(p);
}

/**
 * 套件装在用户目录里的东西：vibe-kit 目录本身、settings.json、全局 CLAUDE.md、装进去的技能和代理（按 pristine 里的清单）。
 * 同时认两种写法：用户看到的路径（CLAUDE_CONFIG_DIR 或 ~/.claude）和真实路径（.claude 挪到别的盘再建目录联接时，两者不一样）。
 * 每个进程只算一次。
 */
let protectedCache = null;

function protectedKitPaths() {
  if (protectedCache) return protectedCache;
  const bases = [...new Set([CFG_DIR, process.env.CLAUDE_CONFIG_DIR || '', path.join(os.homedir(), '.claude')].filter(Boolean).map((b) => path.resolve(b)))]
    .filter((b) => { try { return normKey(realish(b)) === normKey(realish(CFG_DIR)); } catch (e) { return false; } });
  const names = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
  const skills = names(path.join(KIT, 'pristine', 'skills'));
  const agents = names(path.join(KIT, 'pristine', 'agents'));
  const out = new Set();
  for (const base of bases) {
    const list = [path.join(base, 'vibe-kit'), path.join(base, 'settings.json'), path.join(base, 'CLAUDE.md')];
    for (const n of (skills.length ? skills : ['vk-onboard', 'vk-see-page', 'vk-cross-review', 'vk-handover', 'vk-db-crud', 'vk-redis'])) list.push(path.join(base, 'skills', n));
    for (const n of (agents.length ? agents : ['vk-reviewer.md'])) list.push(path.join(base, 'agents', n));
    for (const p of list) { out.add(normKey(p)); out.add(normKey(realish(p))); }
  }
  out.add(normKey(KIT));
  protectedCache = [...out];
  return protectedCache;
}

/** 把 ~、$HOME（大小写都认）、$env:USERPROFILE、%USERPROFILE%、$CLAUDE_CONFIG_DIR 这些换成真实路径 */
function expandHome(word) {
  const home = os.homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR || CFG_DIR;
  return String(word || '')
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/\$\{?home\}?(?![\w])/gi, home).replace(/\$\{?env:(?:USERPROFILE|HOME)\}?/gi, home).replace(/%USERPROFILE%/gi, home).replace(/%HOMEDRIVE%%HOMEPATH%/gi, home)
    .replace(/\$\{?env:CLAUDE_CONFIG_DIR\}?/gi, cfg).replace(/%CLAUDE_CONFIG_DIR%/gi, cfg).replace(/\$\{?CLAUDE_CONFIG_DIR\}?/gi, cfg);
}

/** 这个路径（绝对的、相对 baseDir 的、带 ~ 或环境变量的）是不是套件的东西 */
function isKitPath(p, baseDir) {
  try {
    let s = expandHome(String(p || '').replace(/^["']|["']$/g, ''));
    if (!s) return false;
    if (process.platform === 'win32') s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir || process.cwd(), s);
    const keys = [normKey(abs), normKey(realish(abs))];
    return protectedKitPaths().some((x) => keys.some((k) => k === x || k.startsWith(x + '/')));
  } catch (e) { return false; }
}

/**
 * 套件装的技能自带的脚本：<技能目录>/scripts/ 下面那一层的 .py、.js（查库的 db.py、查 redis 的 redis.js）。
 * 跑它们是技能的正常用法；更深的目录（执行器的 class）、别的扩展名不算
 */
function isKitSkillScript(p, baseDir) {
  try {
    let s = expandHome(String(p || '').replace(/^["']|["']$/g, ''));
    if (!s) return false;
    if (process.platform === 'win32') s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir || process.cwd(), s);
    const keys = [normKey(abs), normKey(realish(abs))];
    return protectedKitPaths().some((x) => /\/skills\/[^/]+$/.test(x) && keys.some((k) => k.startsWith(x + '/scripts/') && /^[^/]+\.(py|js)$/.test(k.slice(x.length + 9))));
  } catch (e) { return false; }
}

// ===================== 会话中途约定、技能变了：不用 /clear 也能让模型知道 =====================
// 实测（2.1.259）：会话进行中，钩子脚本和钩子登记改了立刻生效；全局 CLAUDE.md 改了、新装了技能，模型看不到，/clear 之后才重新读。
// 所以由钩子来送：会话开始时记下模型拿到的版本，用户每次开口时比一下，变了就把变了的那几段带给它，只送一次。
const globalMdFile = () => path.join(CFG_DIR, 'CLAUDE.md');

function readTextFile(f) { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; } catch (e) { return null; } }

/** 按标题（# 到 ####）切段，代码块里的 # 不算标题。key 是标题路径（重名的加序号），body 是这一段自己的内容 */
function mdSections(text) {
  const out = [];
  const stack = [];
  let cur = { key: '（开头）', heading: '', lines: [] };
  const flush = () => { const body = cur.lines.join('\n').trim(); if (cur.heading || body) out.push({ key: cur.key, heading: cur.heading, body }); };
  let fence = false;
  for (const l of String(text || '').split(/\r?\n/)) {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = fence ? null : l.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (!m) { cur.lines.push(l); continue; }
    flush();
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: m[2] });
    cur = { key: stack.map((s) => s.title).join(' > '), heading: l.trim(), lines: [] };
  }
  flush();
  const seen = {};
  for (const s of out) { const n = (seen[s.key] = (seen[s.key] || 0) + 1); if (n > 1) s.key += ' #' + n; }
  return out;
}

/** 两版约定按段比：新加的、内容变了的段，和删掉的段 */
function conventionDiff(oldText, newText) {
  const a = mdSections(oldText);
  const b = mdSections(newText);
  const oldMap = new Map(a.map((s) => [s.key, s.body]));
  const newKeys = new Set(b.map((s) => s.key));
  return { changed: b.filter((s) => oldMap.get(s.key) !== s.body), removed: a.filter((s) => !newKeys.has(s.key)) };
}

const CONV_MAX = 6000;

function conventionNotice(diff, file) {
  const removed = diff.removed.map((s) => (s.heading || '（开头）').replace(/^#+\s*/, ''));
  const text = diff.changed.map((s) => (s.heading ? s.heading + '\n' : '') + s.body).join('\n\n').trim();
  if (text.length > CONV_MAX) return '全局约定（' + file + '）在这个会话里改了好几处（装了新版套件，或者配置页改了开关），不用重开会话，但改动太多不在这里贴：现在先用 Read 读一遍这个文件，以它为准；会话开头给你的旧版本作废。';
  let t = '全局约定刚改了（装了新版套件，或者配置页改了开关），不用重开会话。' + (text ? '下面这几段以新的为准，会话开头给你的旧版本里对应的部分作废：\n\n' + text : '');
  if (removed.length) t += (text ? '\n\n' : '') + '这几段已经删掉，不再适用：' + removed.join('、') + '。';
  return t;
}

/** 模型能看到的技能（用户级、从 cwd 往上各层的 .claude/skills）：名字 → 文件、内容指纹 */
function skillIndex(cwd) {
  const out = {};
  const dirs = [path.join(CFG_DIR, 'skills')];
  let d = path.resolve(cwd || process.cwd());
  for (let i = 0; i < 6; i++) { if (normKey(path.join(d, '.claude')) !== normKey(CFG_DIR)) dirs.push(path.join(d, '.claude', 'skills')); const up = path.dirname(d); if (up === d) break; d = up; }
  for (const dir of dirs) {
    let names = []; try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      if (out[n]) continue;
      const f = path.join(dir, n, 'SKILL.md');
      let buf; try { buf = fs.readFileSync(f); } catch (e) { continue; }
      let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch (e) { /* 读得到就有 */ }
      out[n] = { file: f, sig: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16), mtime };
    }
  }
  return out;
}

function skillDescOf(file) {
  try { const fm = require(path.join(KIT, 'tools', 'skills-check.js')).frontmatter(fs.readFileSync(file, 'utf8')); return String(fm.description || '').slice(0, 160); } catch (e) { return ''; }
}

function skillNotice(changed, gone) {
  const lines = changed.slice(0, 12).map((s) => { const desc = skillDescOf(s.file); return '- ' + s.name + (s.isNew ? '（新装的）' : '（改过）') + (desc ? '：' + desc : '') + '；文件：' + s.file; });
  let t = '';
  if (lines.length) t = '技能有变化，这个会话开头给你的技能列表还没反映出来：\n' + lines.join('\n') + '\n新装的技能不在这个会话的技能列表里，调不出来：要用就直接读它的文件照着做。改过的技能，用它的时候以文件的最新内容为准。';
  if (gone.length) t += (t ? '\n' : '') + '这些技能已经删掉，别再用：' + gone.join('、') + '。';
  return t;
}

/** 会话是什么时候开始的：会话记录第一条带时间的条目，读不到就看文件的创建时间 */
function sessionStartMs(file) {
  if (!file) return 0;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const l of buf.toString('utf8', 0, n).split('\n')) { try { const e = JSON.parse(l); const t = e && e.timestamp && Date.parse(e.timestamp); if (t) return t; } catch (e) { /* 半截行 */ } }
  } catch (e) { /* 读不了 */ }
  try { return fs.statSync(file).birthtimeMs || 0; } catch (e) { return 0; }
}

const convCurrent = (cwd) => ({ md: readTextFile(globalMdFile()) || '', skills: skillIndex(cwd) });

/**
 * 会话开始时记下模型拿到的版本。startup、clear、resume：就是现在的文件（实测 /clear 会重新读）。
 * compact（压缩之后）：送过的更新可能随着压缩丢了，退回到会话开始时的版本，下次开口再把改了的送一遍；重复送一遍无害。
 */
function recordConvBaseline(sessionId, cwd, source) {
  if (!sessionId) return;
  const key = sessionId + '-conv';
  if (source === 'compact') { const st = readState(key); if (st.start) writeState(key, Object.assign({}, st, { delivered: st.start, at: Date.now() })); return; }
  const cur = convCurrent(cwd);
  writeState(key, { cwd: path.resolve(cwd || process.cwd()), start: cur, delivered: cur, at: Date.now() });
}

/** 用户开口时调：约定、技能和模型手上的不一样，就返回要带给它的话（只送一次，送完记成已送） */
function convUpdateNotice(j) {
  const sid = j && j.session_id;
  if (!sid) return '';
  const key = sid + '-conv';
  const st = readState(key);
  const cwd = st.cwd || path.resolve(j.cwd || process.cwd());
  const cur = convCurrent(cwd);
  const out = [];
  if (!st.delivered) {
    // 这个会话开始时还没有这个功能（比如会话开着的时候装了新版）：按会话开始的时间判断，之后改过的让它重新读
    const since = sessionStartMs(j.transcript_path);
    let mdStale = false;
    if (since) {
      try { mdStale = fs.statSync(globalMdFile()).mtimeMs > since + 2000; } catch (e) { /* 没有这个文件 */ }
      if (mdStale) out.push('全局约定（' + globalMdFile() + '）在这个会话开始之后改过（装了新版套件，或者配置页改了开关），不用重开会话：现在先用 Read 读一遍这个文件，以它为准；会话开头给你的旧版本作废。');
      const fresh = Object.entries(cur.skills).filter(([, s]) => s.mtime > since + 2000).map(([name, s]) => ({ name, file: s.file, isNew: false }));
      if (fresh.length) out.push(skillNotice(fresh, []));
    }
    // 会话开始时模型拿到的约定不知道是哪一版：按"空的"记，压缩之后会再提醒它读一遍全文
    writeState(key, { cwd, start: { md: mdStale ? '' : cur.md, skills: cur.skills }, delivered: cur, at: Date.now() });
    if (out.length) hookLog('conv-notice fallback session=' + sid + ' md=' + mdStale);
    return out.join('\n\n');
  }
  const diff = conventionDiff(st.delivered.md || '', cur.md);
  if (diff.changed.length || diff.removed.length) out.push(conventionNotice(diff, globalMdFile()));
  const old = st.delivered.skills || {};
  const changed = [];
  for (const [name, s] of Object.entries(cur.skills)) { if (!old[name]) changed.push({ name, file: s.file, isNew: true }); else if (old[name].sig !== s.sig) changed.push({ name, file: s.file, isNew: false }); }
  const gone = Object.keys(old).filter((n) => !cur.skills[n]);
  if (changed.length || gone.length) out.push(skillNotice(changed, gone));
  if (out.length || Date.now() - (st.at || 0) > 86400000) writeState(key, Object.assign({}, st, { delivered: cur, at: Date.now() }));
  if (out.length) hookLog('conv-notice session=' + sid + ' sections=' + diff.changed.length + '/' + diff.removed.length + ' skills=' + changed.length + '/' + gone.length);
  return out.join('\n\n');
}

module.exports = { CFG_DIR, realish, protectedKitPaths, expandHome, isKitPath, isKitSkillScript, mdSections, conventionDiff, skillIndex, sessionStartMs, recordConvBaseline, convUpdateNotice };

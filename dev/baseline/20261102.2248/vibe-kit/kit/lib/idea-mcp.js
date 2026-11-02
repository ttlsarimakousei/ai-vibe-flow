'use strict';
/*
 * 撤回套件以前登记给 Claude Code 的 IDEA MCP（用户 2026-10-28 定的：IDEA MCP 接入整条删掉，起服务只走 devserver）。
 * 2026-10-10 起安装、更新、后台检查会把本机 IDEA 的 MCP 登记成 vibe-idea-<端口>；这一版起不再登记，装新版、卸载时把套件加的、
 * 用户没改过的那几项从 Claude Code 的用户配置里删掉。用户自己登记的、改过的不动。不连 IDEA、不探端口。
 * 配置解析失败、并发写入时不覆盖。不输出 Claude 配置的原文，里面可能有别的 MCP 的令牌。
 * 老版本的代码（自动更新时还在内存里的那一份）会调 due()、sync()、status()：due 恒为 false，sync 只做撤回，status 报"已撤回"。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CFG_DIR } = require('./session');
const obj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => obj(a) && obj(b) && Object.keys(a).length === 2 && a.type === b.type && a.url === b.url;
const localUrl = (s) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/stream$/.test(String(s || ''));
function files(dir) { return { state: path.join(dir, 'vibe-kit', 'state', 'idea-mcp.json'), lock: path.join(dir, 'vibe-kit', 'state', 'idea-mcp.lock') }; }
function readState(dir) { try { const s = JSON.parse(fs.readFileSync(files(dir).state, 'utf8')); return obj(s) ? s : {}; } catch (e) { return {}; } }
function clientFile(dir, st) {
  const choices = [path.join(dir, '.claude.json'), path.join(path.dirname(dir), '.claude.json')];
  if (choices.includes(st.clientFile)) return st.clientFile;
  return process.env.CLAUDE_CONFIG_DIR && path.resolve(process.env.CLAUDE_CONFIG_DIR) === path.resolve(dir) ? choices[0] : choices[1];
}
function status(dir) { const s = readState(dir || CFG_DIR); return { status: s.status === 'retract-busy' ? 'retract-busy' : 'off', checkedAt: Number(s.checkedAt) || 0, connections: [] }; }
function due() { return false; }
function snapshot(f) {
  try {
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024) throw new Error('config');
    const raw = fs.readFileSync(f);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!obj(value) || (value.mcpServers !== undefined && !obj(value.mcpServers))) throw new Error('config');
    return { raw, value, mode: st.mode };
  } catch (e) { if (e.code === 'ENOENT') return { raw: null, value: {}, mode: 0o600 }; throw new Error('config'); }
}
function writeClient(f, before) {
  const tmp = f + '.vibe-idea-' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(before.value, null, 2) + '\n', { flag: 'wx', mode: before.mode & 0o777 });
    const latest = snapshot(f);
    if (before.raw === null ? latest.raw !== null : latest.raw === null || !before.raw.equals(latest.raw)) throw new Error('changed');
    fs.renameSync(tmp, f);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* 已经换过去了 */ } }
}
/**
 * 撤回套件加的登记。返回 { status: 'off' | 'retract-busy' | 'config-error' | 'config-busy', removed: [名字], kept: [用户改过、没删的名字] }。
 * 没登记过的（状态里没有 owned）什么都不读、不写
 */
async function retract(opt) {
  const o = opt || {}, dir = path.resolve(o.claudeDir || CFG_DIR), f = files(dir);
  const st = readState(dir);
  const owned = obj(st.owned) ? st.owned : {};
  const done = (status, extra) => { try { fs.mkdirSync(path.dirname(f.state), { recursive: true }); fs.writeFileSync(f.state, JSON.stringify(Object.assign({ status, checkedAt: Date.now(), clientFile: st.clientFile }, status === 'off' ? {} : { owned }), null, 2) + '\n'); } catch (e) { /* 记不了，下次装新版再撤 */ } return Object.assign({ status, removed: [], kept: [] }, extra || {}); };
  if (!Object.keys(owned).length) return { status: 'off', removed: [], kept: [] };
  let fd;
  try { fs.mkdirSync(path.dirname(f.lock), { recursive: true }); fd = fs.openSync(f.lock, 'wx'); } catch (e) {
    // 进程异常退出留下的锁，一分钟后可以接手
    try { if (Date.now() - fs.statSync(f.lock).mtimeMs > 60000) { fs.unlinkSync(f.lock); fd = fs.openSync(f.lock, 'wx'); } } catch (x) { /* 另一个正在做 */ }
    if (fd === undefined) return { status: 'retract-busy', removed: [], kept: [] };
  }
  try {
    const target = clientFile(dir, st);
    let before;
    try { before = snapshot(target); } catch (e) { return done('config-error'); }
    const servers = before.value.mcpServers || {};
    const removed = [], kept = [];
    for (const [name, entry] of Object.entries(owned)) {
      if (!/^vibe-idea-\d+$/.test(name) || !obj(entry) || !localUrl(entry.url)) continue;
      if (!Object.prototype.hasOwnProperty.call(servers, name)) continue;
      if (same(servers[name], { type: 'http', url: entry.url })) { delete servers[name]; removed.push(name); } else kept.push(name);
    }
    if (removed.length) {
      before.value.mcpServers = servers;
      try { writeClient(target, before); } catch (e) { return done('config-busy'); }
    }
    return done('off', { removed, kept });
  } finally { fs.closeSync(fd); try { fs.unlinkSync(f.lock); } catch (e) { /* 已清掉 */ } }
}
/** 老版本的调用：只撤回，不登记 */
async function sync(opt) { return retract(opt); }
module.exports = { retract, sync, status, due };

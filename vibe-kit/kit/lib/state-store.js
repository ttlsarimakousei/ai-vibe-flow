'use strict';
/*
 * 本机状态的跨进程读改写。先独占同一文件的锁，再读取和写入；原子改名只防半截文件，不能防两个进程覆盖各自的更新。
 * 锁的归属先写好再用硬链接登记，避免进程中断留下无法识别归属的空锁。只回收已退出进程的锁，不抢活进程的锁。
 * 锁争用和写入失败返回 null/false，调用方按既有 fail-open 处理。用户目录仍由 session.js 按自身位置传入。
 * 死机、断电（问题表第 80 条，2026-11-11）：
 *   要紧的几份（DURABLE：审查记录、开工基线、大任务、会话的流程状态……）写完先落盘再改名，改名之前把上一份留成 .prev；
 *   读出来是坏的（断电那一刻正在写，文件成了空的或一片 0）就用 .prev，不从空的重新记。别的照旧只改名，不落盘（每次落盘要几毫秒到几十毫秒）。
 *   锁、进程记录里的时间比这次开机还早的，是重启之前留下的：进程号可能被别的程序占了，不看进程号，直接按失效算（bootTime）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { threadId } = require('worker_threads');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const os = require('os');
/** 这次开机的时间（毫秒）。一次进程里算一次 */
let boot = 0;
function bootTime() { if (!boot) { try { boot = Date.now() - os.uptime() * 1000; } catch (e) { boot = 0; } } return boot; }
/**
 * 这个时间点在这次开机之前：那时记下的进程号现在不作数。留 2 分钟余量（复审 R9：开机后校时把时钟往前拨，拨之前写的记录
 * 会显得比"开机"还早；拨得比 2 分钟还多的，退回只看进程号和租期，和以前一样）
 */
function beforeBoot(at) { const b = bootTime(); return !!b && Number(at) > 0 && Number(at) < b - 120000; }
// 写完先落盘、留上一份的几份状态（按文件名认，会话目录里的按后缀名）
const DURABLE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-)?(?:review-points|review-jobs|work-baselines|big-task|change-files|reviewed|reviewed-proposal|flow|changes|auto-switch)\.json$/i;
const durable = (file) => DURABLE.test(path.basename(file));
function owner(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function release(file, token) {
  try { const o = owner(file); if (o && o.token === token) { fs.unlinkSync(file); return true; } } catch (e) { /* 已释放或文件被占用 */ }
  return false;
}
function claim(file, record) {
  const tmp = file + '.' + record.token + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(record), { flag: 'wx' });
    fs.linkSync(tmp, file);
    return true;
  } catch (e) { return false; }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* 没有生成或已清理 */ } }
}
function acquire(file, options) {
  const opt = options || {};
  const wait = opt.waitMs === undefined ? 2000 : Math.max(0, Number(opt.waitMs) || 0);
  // 租期（审核 P05、P46）：锁只认进程号时，Windows 复用了进程号，锁就永远拿不回来（自动更新、上报全停）。超过租期的锁按失效处理
  const lease = opt.leaseMs === undefined ? 10 * 60000 : Math.max(1000, Number(opt.leaseMs) || 0);
  const record = { pid: process.pid, thread: threadId, token: crypto.randomBytes(12).toString('hex'), at: Date.now() };
  const reap = file + '.recover';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { return null; }
  const began = Date.now();
  const end = began + wait;
  // 等了 200 毫秒以上的记一笔（K1-8，lib/diag.js）。诊断自己的文件不记，不然等它的锁又要记它
  const waited = () => { const ms = Date.now() - began; if (ms >= 200 && !/diag\.json/.test(file)) { try { require('./diag').note('锁等待', path.basename(file).replace(/^[0-9a-f]{8}-[0-9a-f-]{27}-?/i, '').replace(/\.lock$/, ''), ms); } catch (e) { /* 老版本没有 */ } } };
  do {
    const recovery = owner(reap);
    if (recovery && (beforeBoot(recovery.at) || !alive(recovery.pid))) release(reap, recovery.token);
    if (!fs.existsSync(reap) && claim(file, record)) {
      if (!fs.existsSync(reap)) { waited(); return { file, token: record.token, release: () => release(file, record.token) }; }
      release(file, record.token);
    }
    const old = owner(file);
    const stale = (o) => !!o && Number.isInteger(o.pid) && o.pid > 0 && (beforeBoot(o.at) || !alive(o.pid) || (Number(o.at) > 0 && Date.now() - Number(o.at) > lease));
    if (stale(old) && claim(reap, record)) {
      try {
        const cur = owner(file);
        if (cur && cur.token === old.token && stale(cur)) release(file, cur.token);
        if (!fs.existsSync(file) && claim(file, record)) return { file, token: record.token, release: () => release(file, record.token) };
      }
      finally { release(reap, record.token); }
      continue;
    }
    if (Date.now() >= end) break;
    pause(Math.min(15, Math.max(1, end - Date.now())));
  } while (Date.now() <= end);
  waited();
  return null;
}
function atomicText(file, value, opts) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  const keep = (opts && opts.durable !== undefined) ? !!opts.durable : durable(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (keep) {
      // 先落盘：断电时改名可能已经落到目录里、内容还在缓存里，留下一个空文件（NTFS 只保证目录项）
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, String(value), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // 上一份留着：这一份万一还是坏了，读的时候用它。现在这份本身读不懂（断电留下的坏文件）就不拿它盖掉好的上一份
      try { const cur = fs.readFileSync(file, 'utf8'); if (cur.trim()) { JSON.parse(cur); fs.writeFileSync(file + '.prev', cur, 'utf8'); } } catch (e) { /* 第一次写、或者现在这份是坏的：上一份不动 */ }
    } else fs.writeFileSync(tmp, String(value), 'utf8');
    for (let i = 0; i < 6; i++) { try { fs.renameSync(tmp, file); return true; } catch (e) { pause(20); } }
  } catch (e) { /* 磁盘或权限错误由调用方显示降级 */ }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* 原子替换成功后临时文件已消失 */ } }
  return false;
}
function atomicWrite(file, value) { return atomicText(file, JSON.stringify(value)); }
/** 上一份（.prev）读得懂就返回它，不然 null */
function previous(file) { try { const t = fs.readFileSync(file + '.prev', 'utf8'); const o = t.trim() ? JSON.parse(t) : null; return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } }
/** 文件坏了（不是别人正在写）：空的、一片 0、5 秒前写的还读不懂 */
function broken(file, text) {
  if (/^[\0\s]*$/.test(text)) return true;
  try { return Date.now() - fs.statSync(file).mtimeMs >= 5000; } catch (e) { return false; }
}
function read(file) {
  let text = '';
  for (let i = 0; i < 3; i++) {
    try { text = fs.readFileSync(file, 'utf8'); if (!text.trim()) break; return JSON.parse(text); }
    catch (e) { if (e.code === 'ENOENT') return {}; pause(15); }
  }
  // 读不懂、或者是空的：要紧的那几份，坏了就用上一份（死机、断电留下的）
  if (durable(file) && broken(file, text)) { const p = previous(file); if (p) return p; }
  return {};
}
function write(file, value) {
  const lock = acquire(file + '.lock');
  if (!lock) return false;
  try { return atomicWrite(file, value); } finally { lock.release(); }
}
function update(file, fn, log) {
  const lock = acquire(file + '.lock');
  if (!lock) return null;
  try {
    let obj = {};
    if (fs.existsSync(file)) {
      let ok = false;
      let text = '';
      for (let i = 0; i < 4 && !ok; i++) { try { text = fs.readFileSync(file, 'utf8'); obj = text.trim() ? JSON.parse(text) : {}; ok = true; } catch (e) { pause(20); } }
      // 要紧的那几份成了空文件、一片 0（断电）：接着上一份记
      if (durable(file) && (!ok || !text.trim()) && broken(file, text)) { const p = previous(file); if (p) { obj = p; ok = true; if (log) log('状态文件 ' + path.basename(file) + ' 坏了（死机或断电），接着上一份（.prev）记'); } }
      if (!ok) {
        let age = 0;
        try { age = Date.now() - fs.statSync(file).mtimeMs; } catch (e) { return null; }
        if (age < 5000) return null;
        try { fs.renameSync(file, file + '.bad'); } catch (e) { return null; }
        if (log) log('状态文件 ' + path.basename(file) + ' 坏了（读不懂），改名留成 .bad，从空的重新记');
        obj = {};
      }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    const result = fn(obj);
    const next = result === undefined ? obj : result;
    return atomicWrite(file, next) ? next : null;
  } finally { lock.release(); }
}
module.exports = { acquire, release, read, write, update, atomicWrite, atomicText, bootTime, beforeBoot, DURABLE };

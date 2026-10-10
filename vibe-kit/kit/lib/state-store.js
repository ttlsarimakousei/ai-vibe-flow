'use strict';
/*
 * 本机状态的跨进程读改写。先独占同一文件的锁，再读取和写入；原子改名只防半截文件，不能防两个进程覆盖各自的更新。
 * 锁的归属先写好再用硬链接登记，避免进程中断留下无法识别归属的空锁。只回收已退出进程的锁，不抢活进程的锁。
 * 锁争用和写入失败返回 null/false，调用方按既有 fail-open 处理。用户目录仍由 session.js 按自身位置传入。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { threadId } = require('worker_threads');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
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
  const record = { pid: process.pid, thread: threadId, token: crypto.randomBytes(12).toString('hex'), at: Date.now() };
  const reap = file + '.recover';
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { return null; }
  const end = Date.now() + wait;
  do {
    const recovery = owner(reap);
    if (recovery && !alive(recovery.pid)) release(reap, recovery.token);
    if (!fs.existsSync(reap) && claim(file, record)) {
      if (!fs.existsSync(reap)) return { file, token: record.token, release: () => release(file, record.token) };
      release(file, record.token);
    }
    const old = owner(file);
    if (old && Number.isInteger(old.pid) && old.pid > 0 && !alive(old.pid) && claim(reap, record)) {
      try {
        const cur = owner(file);
        if (cur && cur.token === old.token && !alive(cur.pid)) release(file, cur.token);
        if (!fs.existsSync(file) && claim(file, record)) return { file, token: record.token, release: () => release(file, record.token) };
      }
      finally { release(reap, record.token); }
      continue;
    }
    if (Date.now() >= end) break;
    pause(Math.min(15, Math.max(1, end - Date.now())));
  } while (Date.now() <= end);
  return null;
}
function atomicWrite(file, value) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value));
    for (let i = 0; i < 6; i++) { try { fs.renameSync(tmp, file); return true; } catch (e) { pause(20); } }
  } catch (e) { /* 磁盘或权限错误由调用方显示降级 */ }
  finally { try { fs.unlinkSync(tmp); } catch (e) { /* 原子替换成功后临时文件已消失 */ } }
  return false;
}
function read(file) {
  for (let i = 0; i < 3; i++) {
    try { const t = fs.readFileSync(file, 'utf8'); return t.trim() ? JSON.parse(t) : {}; }
    catch (e) { if (e.code === 'ENOENT') return {}; pause(15); }
  }
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
      for (let i = 0; i < 4 && !ok; i++) { try { const t = fs.readFileSync(file, 'utf8'); obj = t.trim() ? JSON.parse(t) : {}; ok = true; } catch (e) { pause(20); } }
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
/** HTTP 工作线程异常退出后，宿主只释放该线程确实持有的锁。 */
function releaseThread(dir, id) {
  try { for (const f of fs.readdirSync(dir)) if (/\.lock$/.test(f)) { const p = path.join(dir, f); const o = owner(p); if (o && o.pid === process.pid && o.thread === id) release(p, o.token); } }
  catch (e) { /* 清理失败仍显示检查降级 */ }
}
module.exports = { acquire, release, read, write, update, atomicWrite, releaseThread };

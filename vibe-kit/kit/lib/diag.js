'use strict';
/*
 * 本机诊断指标（K1-8，2026-11-01）：出了"钩子慢、路由卡"这类问题时，有数可看，不靠猜。
 *   钩子预算    12 秒用完时停在哪个阶段（lib/invocation.js）
 *   锁等待      拿状态文件的锁等了 200 毫秒以上的（lib/state-store.js）
 *   审查批次    每批拿到结论、重试后才拿到、没拿到（lib/review-runner.js）
 *   路由首字节  上游多久回头部，按模型（router/forward.js）；路由等待：被限流等了多久
 * 按天汇总进 state/diag.json，留 14 天：{ 日期: { 类别: { 键: { n, total, max } } } }。tools/doctor.js 显示。
 * 只记本机，不上报（硬规矩 15）：使用情况、问题反馈都不读这个文件。
 * 记不下来不影响正事，什么都不抛。路由一秒可能很多次，传 buffer 先攒在内存里，最多 30 秒写一次。
 * 只依赖 state-store：路由、钩子都用；state-store 反过来也调这里（迟一点才载），所以 diag.json 自己的锁不记。
 */
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'diag.json');
const KEEP_DAYS = 14;
const FLUSH_MS = 30000;
let pending = [];
let lastFlush = 0;
let timer = null;

const dayKey = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
function write(items) {
  require('./state-store').update(FILE, (o) => {
    for (const x of items) {
      const day = o[x.day] || (o[x.day] = {});
      const cat = day[x.cat] || (day[x.cat] = {});
      const it = cat[x.key] || (cat[x.key] = { n: 0, total: 0, max: 0 });
      it.n++; it.total += x.ms; it.max = Math.max(it.max, x.ms);
    }
    for (const d of Object.keys(o).sort().slice(0, -KEEP_DAYS)) delete o[d];
  });
}
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const items = pending;
  pending = [];
  lastFlush = Date.now();
  if (!items.length) return;
  try { write(items); } catch (e) { /* 记不下来就算了 */ }
}
/** 记一笔。opt.buffer：攒着，第一笔马上写，之后最多 30 秒写一次 */
function note(cat, key, ms, opt) {
  try {
    pending.push({ day: dayKey(Date.now()), cat: String(cat), key: String(key || '-'), ms: Math.max(0, Math.round(Number(ms) || 0)) });
    if (!(opt && opt.buffer) || Date.now() - lastFlush >= FLUSH_MS) { flush(); return; }
    if (!timer) { timer = setTimeout(flush, FLUSH_MS); if (timer.unref) timer.unref(); }
  } catch (e) { /* 记不下来就算了 */ }
}
/** 最近 days 天合起来：{ 类别: { 键: { n, total, max } } } */
function recent(days) {
  let o = {};
  try { o = require('./state-store').read(FILE); } catch (e) { o = {}; }
  const out = {};
  const since = dayKey(Date.now() - ((days || 7) - 1) * 86400000);
  for (const d of Object.keys(o)) {
    if (d < since) continue;
    for (const [cat, keys] of Object.entries(o[d] || {})) {
      const c = out[cat] || (out[cat] = {});
      for (const [k, v] of Object.entries(keys || {})) {
        const it = c[k] || (c[k] = { n: 0, total: 0, max: 0 });
        it.n += Number(v.n) || 0; it.total += Number(v.total) || 0; it.max = Math.max(it.max, Number(v.max) || 0);
      }
    }
  }
  return out;
}

module.exports = { FILE, note, flush, recent };

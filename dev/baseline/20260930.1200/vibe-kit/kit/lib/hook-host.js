'use strict';
/*
 * 在路由进程里跑钩子（HTTP 钩子）。Claude Code 把钩子的输入 POST 到 http://127.0.0.1:<端口>/vibe-kit/hook/<名字>，
 * 这里交给工作线程里的 handle，把结果原样回给它。和命令方式用的是同一份钩子代码、同样的判断，只是不用每次起一个 node 进程
 * （命令方式每个钩子零点几秒到将近一秒，改一次文件、跑一条命令都要等它）。
 *   - 只认这几个：pre-edit（改文件）、guard-commit（跑命令）、guard-ask（提问框）、guard-read（搜文件内容）、source-hint（读文件提醒）、verify-gate（收工检查）。
 *     会话开始、用户开口两个钩子一直走命令方式：它们负责把路由拉起来、检查 HTTP 钩子有没有生效
 *   - 最多 3 个工作线程：一个钩子慢（收工检查要跑 git status），别的会话改文件不用排队等它
 *   - 钩子文件更新了（装了新版），下一次调用换新线程、用新代码；旧线程手上的做完再退
 *   - 25 秒没结果当放行（和命令方式出错、超时时一样），结束那个线程，下次重建
 *   - 每次调用记进 state/hook-stats.json：配置页显示"最近一次收到钩子调用"，用户开口时的自检（hook-health.js）也看它
 * 只由路由（router.js）载入。
 */
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const NAMES = new Set(['pre-edit', 'guard-commit', 'guard-ask', 'guard-read', 'source-hint', 'verify-gate']);
const MAX_WORKERS = 3;
const CALL_TIMEOUT_MS = 25000;
const SESSION_KEEP_MS = 3 * 86400000;

function createHost(opts) {
  const kitDir = path.resolve(opts.kitDir);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const WORKER_FILE = path.join(kitDir, 'lib', 'hook-worker.js');
  const STATS_FILE = path.join(kitDir, 'state', 'hook-stats.json');
  let workers = [];
  let seq = 0;
  let stamp = '';
  let stampAt = 0;
  const lastErrLog = {};

  // ---------- 代码有没有更新：hooks/、lib/ 里文件的修改时间和大小，一秒最多看一次 ----------
  // pristine/ 下的技能、代理的清单也算：工作线程里记着"哪些是套件装的技能"（不许改的范围），只增删了技能、代码没变时也要换线程
  function codeStamp() {
    const parts = [];
    for (const d of ['hooks', 'lib']) {
      let names = [];
      try { names = fs.readdirSync(path.join(kitDir, d)).filter((n) => /\.js$/i.test(n)).sort(); } catch (e) { /* 没有 */ }
      for (const n of names) { try { const st = fs.statSync(path.join(kitDir, d, n)); parts.push(d + '/' + n + ':' + st.mtimeMs + ':' + st.size); } catch (e) { /* 刚被删 */ } }
    }
    for (const d of ['pristine/skills', 'pristine/agents']) { try { parts.push(d + ':' + fs.readdirSync(path.join(kitDir, d)).sort().join(',')); } catch (e) { /* 没有 */ } }
    return parts.join('|');
  }
  function refreshCode() {
    if (Date.now() - stampAt < 1000) return;
    stampAt = Date.now();
    const s = codeStamp();
    if (s === stamp) return;
    if (stamp) log('钩子代码更新了，换新的工作线程');
    stamp = s;
    for (const x of workers) { x.retired = true; if (!x.inflight.size) end(x); }
  }

  // ---------- 工作线程 ----------
  function end(x) {
    workers = workers.filter((y) => y !== x);
    try { x.w.removeAllListeners(); x.w.on('error', () => {}); x.w.terminate().catch(() => {}); } catch (e) { /* 已经没了 */ }
  }
  function broken(x, why) {
    if (!workers.includes(x)) return;
    end(x);
    for (const [, c] of x.inflight) { clearTimeout(c.timer); c.resolve({ ok: false, error: why }); }
    x.inflight.clear();
  }
  function spawn() {
    const w = new Worker(WORKER_FILE);
    w.unref();
    const x = { w, inflight: new Map(), retired: false };
    w.on('message', (m) => {
      const c = x.inflight.get(m && m.id);
      if (!c) return;
      x.inflight.delete(m.id);
      clearTimeout(c.timer);
      c.resolve(m);
      if (x.retired && !x.inflight.size) end(x);
    });
    w.on('error', (e) => broken(x, '工作线程出错：' + ((e && e.message) || e)));
    w.on('exit', () => broken(x, '工作线程退出了'));
    workers.push(x);
    return x;
  }
  /** 手上没活的优先；都在忙、还没到 3 个就再开一个；到了就交给手上活最少的 */
  function pick() {
    let best = null;
    for (const x of workers) if (!x.retired && (!best || x.inflight.size < best.inflight.size)) best = x;
    if (best && !best.inflight.size) return best;
    if (workers.filter((x) => !x.retired).length < MAX_WORKERS) return spawn();
    return best;
  }

  // ---------- 调用记录 ----------
  let stats = { byHook: {}, sessions: {}, lastAt: 0 };
  try { const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); if (s && typeof s === 'object') stats = Object.assign(stats, s, { byHook: s.byHook || {}, sessions: s.sessions || {} }); } catch (e) { /* 还没有 */ }
  stats.hostStartedAt = Date.now();
  let flushTimer = null;
  function flush() {
    flushTimer = null;
    try {
      const old = Date.now() - SESSION_KEEP_MS;
      for (const k of Object.keys(stats.sessions)) if (!(stats.sessions[k] > old)) delete stats.sessions[k];
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      const tmp = STATS_FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(stats));
      fs.renameSync(tmp, STATS_FILE);
    } catch (e) { /* 记不了不影响钩子 */ }
  }
  function record(name, input, m, ms) {
    const now = Date.now();
    const h = stats.byHook[name] = stats.byHook[name] || { n: 0, at: 0, ms: 0, blocked: 0, errors: 0 };
    // ms 是最近这一次的耗时（配置页上显示的）；算平均用 total / timed（timed 是从开始累计耗时起的次数）
    h.n++; h.at = now; h.ms = ms; h.total = (h.total || 0) + ms; h.timed = (h.timed || 0) + 1;
    if (!m.ok) {
      h.errors++; h.errorAt = now; h.lastError = String(m.error || '').slice(0, 300);
      if (!lastErrLog[name] || now - lastErrLog[name] > 60000) { lastErrLog[name] = now; log('钩子 ' + name + ' 出错（这次当放行）：' + String(m.error || '').split('\n')[0]); }
    } else {
      const o = m.out;
      if (o && typeof o === 'object' && (o.decision === 'block' || (o.hookSpecificOutput && /^(deny|ask)$/.test(String(o.hookSpecificOutput.permissionDecision || ''))))) { h.blocked++; h.blockedAt = now; }
    }
    const sid = String((input && input.session_id) || '');
    if (sid) stats.sessions[sid] = now;
    stats.lastAt = now;
    if (!flushTimer) flushTimer = setTimeout(flush, 300);
  }

  /** 跑一个钩子。返回 { status, out }：status 404 = 不认这个名字；out 为 null 表示放行 */
  function run(name, input) {
    if (!NAMES.has(name)) return Promise.resolve({ status: 404, out: null });
    if (!fs.existsSync(path.join(kitDir, 'hooks', name + '.js'))) return Promise.resolve({ status: 404, out: null });
    refreshCode();
    const started = Date.now();
    return new Promise((resolve) => {
      let x;
      try { x = pick(); } catch (e) { return resolve({ ok: false, error: '开不了工作线程：' + e.message }); }
      const id = ++seq;
      const timer = setTimeout(() => {
        if (!x.inflight.has(id)) return;
        x.inflight.delete(id);
        resolve({ ok: false, error: '25 秒没有结果' });
        log('钩子 ' + name + ' 25 秒没有结果，这次当放行；结束这个工作线程');
        // 卡住当放行，用户和模型都看不到：记进问题反馈（每次现读，装了新版不用重启路由）
        try { const f = path.join(kitDir, 'lib', 'feedback.js'); delete require.cache[require.resolve(f)]; require(f).recordHookError(name, input, new Error('HTTP 方式下 25 秒没有结果，这次当放行（钩子可能卡在读很大的会话记录、慢磁盘或网络盘上）')); } catch (e) { /* 记不了就算了 */ }
        broken(x, '前面的钩子卡住了');
      }, CALL_TIMEOUT_MS);
      x.inflight.set(id, { resolve, timer });
      try { x.w.postMessage({ id, name, input }); } catch (e) { x.inflight.delete(id); clearTimeout(timer); resolve({ ok: false, error: '交不给工作线程：' + e.message }); }
    }).then((m) => {
      record(name, input, m, Date.now() - started);
      return { status: 200, out: m.ok ? m.out : null };
    });
  }
  function close() {
    if (flushTimer) { clearTimeout(flushTimer); flush(); }
    for (const x of workers.slice()) broken(x, '路由退出');
  }
  return { run, close, stats: () => stats, flush };
}

module.exports = { createHost, NAMES };

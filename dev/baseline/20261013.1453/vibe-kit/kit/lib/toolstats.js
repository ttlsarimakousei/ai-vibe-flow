'use strict';
/*
 * 套件里的工具（ttls-db-crud、ttls-redis）用得怎么样：用量统计，和工具自己出的毛病。
 *
 * 工具每跑一条命令往 state/tool-usage.jsonl 里追加一行（db-crud 是 Python 写的，redis 是 Node 写的，所以用文件接）：
 *   用量  { tool, cmd, exit, ms, java, daemon, cached, dialect, errors: [类别…], project, at }
 *   毛病  { tool, incident: crash | runner | no-driver | no-java, what, detail, cmd, project, at }
 * 这里把新的行读进来（钩子里顺手做：用户开口、收工的时候）：
 *   用量 → 累计进 state/tool-stats.json（哪条命令跑了多少次、多慢、哪种错多）；里面的错每天汇总一次，记成问题反馈（reportErrors）
 *   毛病 → 记成一条问题反馈（同样的只记一条，次数加一），和钩子的问题走同一条路上报
 *
 * 工具那头只记工具的事：SQL、查出来的数据、key、连接串、口令都不在这个文件里。
 */
const fs = require('fs');
const path = require('path');
const { KIT, readState, writeState, updateState, hookLog } = require('./session');

const LOG = path.join(KIT, 'state', 'tool-usage.jsonl');
const POS = 'tool-usage-pos';
const STATS = 'tool-stats';
const MAX_READ = 512 * 1024;
const MAX_LOG = 2 * 1024 * 1024;          // 日志到这么大就丢掉前一半
/** 日志第一行的指纹：文件被截过（丢掉了前面的）它就变了 */
function headOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(400);
      const n = fs.readSync(fd, b, 0, 400, 0);
      const nl = b.subarray(0, n).indexOf(0x0a);
      if (nl < 0) return '';
      return require('crypto').createHash('sha1').update(b.subarray(0, nl)).digest('hex').slice(0, 12);
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}
const INCIDENT = {
  crash: { kind: '出错', title: '脚本自己出错了' },
  runner: { kind: '出错', title: '连库的执行器出了毛病' },
  'no-driver': { kind: '卡住', title: '找不到数据库驱动' },
  'no-java': { kind: '卡住', title: '找不到 java' },
};

/*
 * 定期把用量里的错报上去（用户 2026-09-30 定的："数据库驱动的调用记录，定期上报错误"）。
 * 查库、查 redis 的命令出的错（连不上、口令不对、SQL 被打回来的类别……）以前只在配置页"用得怎么样"那张表里看得到，
 * 维护套件的人看不到别的电脑上出了什么错、哪种多。每隔 REPORT_MS，把这段时间里出的错按"工具 + 数据库 + 错的类别"
 * 各记成一条问题反馈（同一种只有一条；再出现就在那一条后面加一句这段时间的次数），和别的问题走同一条路上报到 GitLab：
 * 别的电脑报过同一种错的，在那条议题下面加一句。
 * 只有类别和次数：SQL、数据、表名、连接串、口令一概没有（工具那头就没记；数据库报的错只记 SQLSTATE 和厂商的错误码）。
 */
const REPORT_MS = 24 * 3600000;
const REPORT_MAX = 20;
// 不算出错的：被工具自己的规矩拦下（全自动模式下的写操作、禁止名单里的表）
const SKIP_ERR = /^BLOCKED/;
const ERR_NOTE = [
  [/^SQL_ERROR:42S22(?::|$)/, '列或标识符相关错误：在本机查看完整错误，用 columns --fresh 重新读取 涉及的表或视图，核对 schema、字段、别名和引号；不要凭计数认定套件有错，也不要重复盲试 SQL。神通的具体含义仍以对应版本的错误详情为准。'],
  [/^SQL_ERROR:08/, 'SQLSTATE 08 类是连接异常，先核对服务是否可达、驱动版本和连接配置。只有错误码，不能判断是 SQL 写法的问题。'],
  [/^SQL_ERROR:22/, 'SQLSTATE 22 类是数据异常，检查值、类型和转换规则。厂商数字码需要对应数据库版本的文档；仅凭计数不能定位语句。'],
  [/^SQL_ERROR:40/, 'SQLSTATE 40 类与事务回滚有关，检查并发冲突、隔离级别和事务状态。不要直接改 SQL 或自动重试写操作。'],
  [/^SQL_ERROR:3F/, 'SQLSTATE 3F 类是 schema 名称问题，核对当前用户和 schema。只有错误码，无法证明是套件缺陷。'],
  [/^SQL_ERROR/, '数据库报了错误，后面两段是 SQLSTATE 和厂商错误码。这里只记录类别和次数，没有语句和连接现场，无法判断是配置、SQL 写法还是套件问题；需在本机核对错误详情。'],
  [/^(NO_CONFIG|NO_CONN)/, '找不到连接配置：后台自动探索没认出项目里的连接（配置文件的名字、写法不认识），或者模型写错了连接名。'],
  [/^(TIMEOUT|CMD_TIMEOUT|CONN_REFUSED|CONN_LOST|HOST_UNRESOLVED|NET_UNREACHABLE|EAI_AGAIN)/, '连不上：库没起、要走 VPN，或者探索到的是别的环境的地址。'],
  [/^AUTH_FAILED/, '口令不对：配置里的口令和库里的对不上，或者配置里的口令是加密过的。'],
  [/^BAD_ARGS/, '命令的参数不对：模型没照技能说明写。同一条命令老出现，多半是说明里那一条没写清。'],
  [/^(UNSUPPORTED_TYPE|UNSUPPORTED_MODE)/, '碰到了工具不支持的类型、部署方式。'],
  [/^(RUNNER_ERROR|IO_ERROR|UNKNOWN)/, '工具内部的错。'],
];
const DIALECT_NAME = { dm: '达梦', oscar: '神通', mysql: 'MySQL', oracle: 'Oracle', kingbase: '人大金仓', postgresql: 'PostgreSQL', h2: 'H2' };
/**
 * 到时候了就把攒着的错记成问题反馈。返回记下的问题编号。now、every 是给测试用的。
 * 头一回见到错的那一刻起算，满一个周期才报：一个周期里同一种错不管出了多少次，只报一次、带次数
 */
function reportErrors(now, every) {
  const t = now || Date.now();
  const st = readState(STATS);
  const errs = st.errs && typeof st.errs === 'object' ? st.errs : {};
  const keys = Object.keys(errs);
  if (!keys.length || !(Number(st.errsSince) > 0) || t - Number(st.errsSince) < (every === undefined ? REPORT_MS : every)) return [];
  let fb = null;
  try { fb = require('./feedback.js'); } catch (e) { fb = null; }
  if (!fb) return [];
  const hours = Math.max(1, Math.round((t - Number(st.errsSince)) / 3600000));
  const ids = [];
  const list = keys.map((k) => errs[k]).filter((x) => x && x.n > 0).sort((a, b) => b.n - a.n).slice(0, REPORT_MAX);
  for (const x of list) {
    const db = x.dialect ? (DIALECT_NAME[x.dialect] || x.dialect) : '';
    const cmds = Object.keys(x.cmds || {}).sort((a, b) => x.cmds[b] - x.cmds[a]).map((c) => c + ' ' + x.cmds[c] + ' 次').join('、');
    const what = x.dialect === 'oracle' && /^SQL_ERROR:[^:]*:904$/.test(x.code)
      ? 'Oracle 904 是无效标识符。先在本机用 columns --fresh 读取 涉及的表或视图，核对 schema、字段拼写、别名作用域和带引号的大小写；仅凭计数无法定位语句或认定套件有错。'
      : (ERR_NOTE.find((p) => p[0].test(x.code)) || [null, '工具报的错。'])[1];
    const times = '最近 ' + hours + ' 小时出了 ' + x.n + ' 次（' + cmds + '）';
    try {
      const rec = fb.record({
        kind: '工具报错', hook: String(x.tool), source: '工具自动记录（用量里的错）',
        title: (db ? db + ' ' : '') + x.code,
        what: x.tool + (db ? ' 连' + db : '') + ' 的时候出的错：' + x.code + '。' + times + '。\n' + what,
        why: '从工具的调用记录里定期汇总上来的，给维护套件的人看哪种错多。只有类别和次数，没有 SQL、数据、连接串、口令。',
        note: times,
        sig: fb.sigOf(['tool-error', x.tool, x.dialect, x.code]),
        sid: '', cwd: '', transcript: '',
      });
      if (rec && rec.id && !ids.includes(rec.id)) ids.push(rec.id);
    } catch (e) { /* 记不了就算了 */ }
  }
  updateState(STATS, (s) => Object.assign({}, s, { errs: {}, errsSince: 0, reportAt: t }));
  if (ids.length) hookLog('工具的调用记录里的错，汇总成问题反馈：' + ids.join('、'));
  return ids;
}

/** 把工具新写的行读进来，到时候了把攒着的错报上去。返回 { usage: 条数, incidents: [问题编号…], reported: [问题编号…] } */
function ingest(j) {
  const out = readNew(j);
  try { out.reported = reportErrors(); } catch (e) { out.reported = []; }
  return out;
}
/** 把工具新写的行读进来。没有新的行时只取一次文件大小 */
function readNew(j) {
  const out = { usage: 0, incidents: [] };
  let size = 0;
  try { size = fs.statSync(LOG).size; } catch (e) { return out; }
  const pos = readState(POS);
  let from = Number(pos.offset) || 0;
  // 文件被截过（到了上限会丢掉前一半）：变短了，或者第一行和上次不一样了。从头读，只要上次之后记的
  const head = headOf(LOG);
  const cut = from > size || !!(pos.head && head && pos.head !== head);
  if (cut) from = 0;
  if (!cut && from === size) return out;
  // 攒得太多时只看最后这一段（从中间读起，第一行可能是半行：解析不了会被跳过）
  const start = Math.max(from, size - MAX_READ);
  let buf;
  try {
    const fd = fs.openSync(LOG, 'r');
    try { buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  } catch (e) { return out; }
  // 最后一行可能还没写完：只处理到最后一个换行，剩下的留到下次
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return out;
  const done = start + nl + 1;
  const lines = buf.slice(0, nl).toString('utf8').split('\n');
  const recs = [];
  const since = cut ? Number(pos.lastAt) || 0 : 0;
  for (const l of lines) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && typeof r === 'object' && r.tool && !(since && Number(r.at) <= since)) recs.push(r); } catch (e) { /* 半行、坏行：跳过 */ } }
  const lastAt = recs.reduce((m, r) => Math.max(m, Number(r.at) || 0), Number(pos.lastAt) || 0);
  let next = { offset: done, head, lastAt, at: Date.now() };
  // 太大了：丢掉前一半。这一刻正好有工具在追加的话可能丢一行，用量是个大概数，不要紧
  if (size > MAX_LOG && done === size) {
    try {
      const all = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
      const keep = all.slice(Math.floor(all.length / 2)).join('\n') + '\n';
      fs.writeFileSync(LOG, keep, 'utf8');
      next = { offset: Buffer.byteLength(keep), head: headOf(LOG), lastAt, at: Date.now() };
    } catch (e) { /* 截不了下次再说 */ }
  }
  writeState(POS, next);
  if (!recs.length) return out;

  const usage = recs.filter((r) => !r.incident && r.cmd);
  if (usage.length) {
    updateState(STATS, (st) => {
      const by = st.by && typeof st.by === 'object' ? st.by : {};
      for (const u of usage) {
        const k = String(u.tool) + '|' + String(u.cmd);
        const s = by[k] || (by[k] = { tool: String(u.tool), cmd: String(u.cmd), n: 0, fail: 0, ms: 0, max: 0, java: 0, daemon: 0, cached: 0, errors: {}, first: u.at || Date.now(), last: 0 });
        s.n++;
        if (Number(u.exit) === 1 || Number(u.exit) === 2 || (Array.isArray(u.errors) && u.errors.length)) s.fail++;
        const ms = Math.max(0, Number(u.ms) || 0);
        s.ms += ms;
        if (ms > s.max) s.max = ms;
        s.java += Number(u.java) || 0;
        s.daemon += Number(u.daemon) || 0;
        s.cached += Number(u.cached) || 0;
        for (const e of (Array.isArray(u.errors) ? u.errors : []).slice(0, 5)) { const c = String(e).slice(0, 60); s.errors[c] = (s.errors[c] || 0) + 1; }
        s.last = Math.max(s.last || 0, Number(u.at) || 0);
      }
      // 错误的类别太多时只留次数多的
      for (const k of Object.keys(by)) { const es = Object.keys(by[k].errors); if (es.length > 20) { const keep = es.sort((a, b) => by[k].errors[b] - by[k].errors[a]).slice(0, 20); const o = {}; for (const e of keep) o[e] = by[k].errors[e]; by[k].errors = o; } }
      // 还没报上去的错：按"工具 + 数据库 + 错的类别"攒着，到时候一起报（reportErrors）
      const errs = st.errs && typeof st.errs === 'object' ? st.errs : {};
      let since = Number(st.errsSince) || 0;
      for (const u of usage) {
        for (const e of (Array.isArray(u.errors) ? u.errors : []).slice(0, 5)) {
          const code = String(e).slice(0, 60);
          if (SKIP_ERR.test(code)) continue;
          const dialect = String(u.dialect || '').slice(0, 20);
          const k = String(u.tool) + '|' + dialect + '|' + code;
          const x = errs[k] || (errs[k] = { tool: String(u.tool), dialect, code, n: 0, cmds: {} });
          x.n++;
          x.cmds[String(u.cmd)] = (x.cmds[String(u.cmd)] || 0) + 1;
          x.last = Math.max(x.last || 0, Number(u.at) || 0);
          if (!since) since = Date.now();
        }
      }
      const keys = Object.keys(errs);
      if (keys.length > 100) for (const k of keys.sort((a, b) => errs[a].n - errs[b].n).slice(0, keys.length - 100)) delete errs[k];
      return Object.assign({}, st, { by, errs, errsSince: since, at: Date.now() });
    });
    out.usage = usage.length;
  }

  const incidents = recs.filter((r) => r.incident);
  if (incidents.length) {
    let fb = null;
    try { fb = require('./feedback.js'); } catch (e) { fb = null; }
    // 这条毛病算不算这个会话的：工具只记了项目目录的名字。和这个会话的目录（或者它下面的子项目）对得上才算；
    // 对不上的是别的会话里出的，碰巧这个会话先收工：记下来，但不算到这个会话头上（不然它得在交代里说一件它没碰过的事）
    const mine = (r) => {
      if (!j || !j.cwd || !r.project) return false;
      const want = String(r.project).toLowerCase();
      if (path.basename(j.cwd).toLowerCase() === want) return true;
      try { return require('./session').nestedRepos(j.cwd).some((d) => path.basename(d).toLowerCase() === want); } catch (e) { return false; }
    };
    for (const r of fb ? incidents.slice(-20) : []) {
      const def = INCIDENT[r.incident] || { kind: '出错', title: '出了毛病' };
      try {
        const own = mine(r);
        const rec = fb.record({
          kind: def.kind, hook: String(r.tool), source: '工具自动记录', title: r.tool + ' ' + def.title + '：' + String(r.what || '').slice(0, 80),
          what: String(r.what || '') + (r.cmd ? '\n命令：' + r.cmd : '') + (own || !r.project ? '' : '\n项目：' + r.project),
          stack: String(r.detail || ''),
          why: '工具自己报上来的：不是数据库、redis 那头的错，是工具跑不起来或者内部出错。',
          // 同一种毛病、同一句话只记一条。数字抹掉：行号、耗时每次不一样
          sig: fb.sigOf(['tool', r.tool, r.incident, String(r.what || '').replace(/\d+/g, '#').slice(0, 120)]),
          sid: own ? (j && j.session_id) || '' : '', cwd: own ? (j && j.cwd) || '' : '', transcript: own && j ? j.transcript_path : '',
        });
        if (rec && rec.id && !out.incidents.includes(rec.id)) out.incidents.push(rec.id);
      } catch (e) { /* 记不了就算了 */ }
    }
    if (out.incidents.length) hookLog('工具报了毛病，记成问题反馈：' + out.incidents.join('、'));
  }
  return out;
}

/** 用量，次数多的在前：[{ tool, cmd, n, fail, avg, max, java（平均每条命令起几次）, daemon, cached, errors: [[类别, 次数]…], last }] */
function stats(n) {
  const by = readState(STATS).by || {};
  return Object.keys(by).map((k) => by[k]).filter((s) => s && s.n).sort((a, b) => b.n - a.n).slice(0, n || 40).map((s) => ({
    tool: s.tool, cmd: s.cmd, n: s.n, fail: s.fail || 0, avg: Math.round(s.ms / s.n), max: s.max || 0,
    java: Math.round(((s.java || 0) / s.n) * 10) / 10, daemon: s.daemon || 0, cached: s.cached || 0,
    errors: Object.keys(s.errors || {}).map((e) => [e, s.errors[e]]).sort((a, b) => b[1] - a[1]).slice(0, 5), last: s.last || 0,
  }));
}

/**
 * 从用量里看出来的、能优化的地方。只说数得出来的事，不猜。
 * 返回 [{ what, detail }]
 */
function hints() {
  const out = [];
  const all = stats(100);
  const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(KIT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } })();
  const db = all.filter((s) => s.tool === 'ttls-db-crud' && s.java > 0);
  const dbN = db.reduce((a, s) => a + s.n, 0);
  const dbMs = db.reduce((a, s) => a + s.avg * s.n, 0);
  if (dbN >= 20 && dbMs / dbN >= 1500 && cfg.dbcrudDaemon !== true) out.push({ what: '查库的命令平均每条 ' + (dbMs / dbN / 1000).toFixed(1) + ' 秒（共 ' + dbN + ' 条）', detail: '时间多半花在起 java、连库上。配置页"数据库驱动"那一页的"查库快一点"里可以打开后台执行器：连接留着，几分钟不用自己退。' });
  for (const s of all) {
    if (s.n >= 5 && s.avg >= 5000) out.push({ what: s.tool + ' 的 ' + s.cmd + ' 平均 ' + (s.avg / 1000).toFixed(1) + ' 秒（' + s.n + ' 次，最慢 ' + (s.max / 1000).toFixed(1) + ' 秒）', detail: '慢在哪要看具体的库和语句：大表上不带条件的查询、find 扫整个库的字段。' });
    for (const [e, n] of s.errors) {
      if (n < 3) continue;
      if (/^NO_CONFIG|^NO_CONN/.test(e)) out.push({ what: s.tool + ' 有 ' + n + ' 次找不到连接配置', detail: '后台自动探索没找到开发环境的连接（配置文件的名字、写法不认识），或者模型没写对连接名。看看项目说明里有没有"数据库""redis"那一行。' });
      else if (/^TIMEOUT|^CONN_REFUSED|^HOST_UNRESOLVED|^NET_UNREACHABLE/.test(e)) out.push({ what: s.tool + ' 有 ' + n + ' 次连不上（' + e + '）', detail: '探索到的地址在这台电脑上连不通：库没起、要走 VPN、或者是别的环境的地址。' });
      else if (/^AUTH_FAILED/.test(e)) out.push({ what: s.tool + ' 有 ' + n + ' 次口令不对', detail: '项目配置里的口令和库里的对不上，或者配置里的口令是加密的。' });
    }
    if (s.tool === 'ttls-db-crud' && s.cmd === 'query' && s.n >= 30) { const peek = all.find((x) => x.tool === s.tool && x.cmd === 'peek'); if (!peek || peek.n * 5 < s.n) out.push({ what: '查数据几乎都在写 SQL（query ' + s.n + ' 次，peek ' + (peek ? peek.n : 0) + ' 次）', detail: '看一张表、按值找数据用 peek 不用写 SQL。模型没用上，可能是技能说明里那张"先挑最省事的命令"的表没起作用。' }); }
  }
  // 钩子：平均耗时长的（路由里记的，走命令方式的没有）
  try {
    const hs = readState('hook-stats').byHook || {};
    for (const k of Object.keys(hs)) { const h = hs[k] || {}; if ((h.timed || 0) >= 20 && (h.total || 0) / h.timed >= 1500) out.push({ what: '检查 ' + k + ' 平均 ' + Math.round(h.total / h.timed) + ' 毫秒（' + h.timed + ' 次）', detail: '每次改文件、跑命令都要等它。多半是会话记录很长。' }); }
  } catch (e) { /* 没有 */ }
  const seen = new Set();
  return out.filter((x) => (seen.has(x.what) ? false : seen.add(x.what))).slice(0, 12);
}

module.exports = { LOG, ingest, reportErrors, stats, hints };

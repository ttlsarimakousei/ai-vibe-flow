'use strict';
/*
 * 问题上报：把这台电脑上记下的问题反馈（lib/feedback.js）建成内网 GitLab 仓库里的议题（issue），集中到一处。
 *
 *   什么时候传   记了新问题、或者老问题又出现了，之后由后台进程（lib/updater.js 的 run）顺带传。传不上去下次再传
 *   传什么       本地那份记录：写进去的时候已经遮过密码、token、内网地址（lib/feedback.js 的 redact）
 *   不重复建     每条记录带一个签名（同样的问题签名一样）。先在仓库里搜这个签名：
 *                  别的电脑已经建过、还开着 → 在那条下面加一句"这台电脑也出现了"
 *                  没有 → 新建一条
 *                老问题又出现（次数涨了）→ 在对应的那条下面加一句，同一条 12 小时里最多加一次
 *   不传的       套件代码、开关被绕开改过的记录（篡改）：那是这台电脑自己的事；
 *                老版本自动记的"同一条理由拦了 3 次"、配置页上改开关：不是套件的问题（lib/feedback.js 的 isNoise）
 *   要什么       一个令牌（GitLab 的接口只认令牌），账号在项目里至少是 Reporter。两个来处：
 *                  配置页里手填的个人访问令牌（勾 api）
 *                  没填、这台电脑和 GitLab 换过 SSH 密钥：用 SSH 向 GitLab 申请一个（lib/gitlab.js 的 withToken），到期、失效了自动再申请
 *
 * 开关：config.json 的 issueUpload（on / off）、sshToken（auto / off）。
 * 哪条记录对应哪个议题记在 feedback/issues.json（和记录放在一起：卸载重装也还在，不会把传过的再传一遍）；
 * 上次传到哪了、最近一次出错记在 state/issues.json。
 * 令牌不对、没权限、申请不到令牌时停 6 小时再试，不一直打接口。
 *
 * 只传"有了这个功能之后"记的：这台电脑第一次有问题上报功能的时刻记在 feedback/issues.json 的 since，
 * 最后一次更新比它早的记录不传。（20260928.2054 / 2055 那两版装好之后会把以前攒下的推一次，这一版起去掉了。）
 *
 * 导出（只在维护套件的那台电脑上用，配置页"导出 issue"）：把仓库里开放中的议题连同下面的补充合成一份 .md，给改套件的人；
 * 导出的这一批随后在 GitLab 上关闭，下面留一句"已导出"。所以每次导出的都是上次导出之后新冒出来的。
 * 关掉之后同样的问题再出现，会新建一条（写明之前是哪条），下次导出就能看到。
 * 导出的文件在本机也存一份（~/.claude/vibe-kit/issue-exports/，留最近 30 份）：先存好了才去关，页面上没下载成也丢不了。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { KIT, readConfig, readState, updateState } = require('./session');
const gl = require('./gitlab');
const fb = require('./feedback');

const SKIP_KINDS = new Set(['开关变更', '篡改']);
const MARK = 'vibe-kit-sig:';
const MAX_PER_RUN = 8;
const NOTE_EVERY_MS = 12 * 3600000;
const BLOCK_MS = 6 * 3600000;
const EXPORT_DIR = path.join(KIT, 'issue-exports');
const KEEP_EXPORTS = 30;

const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; };
const sigOf = (r) => String(r.meta['签名'] || '').trim() || crypto.createHash('sha1').update('title|' + r.title).digest('hex').slice(0, 16);
const countOf = (r) => Number(r.meta['次数']) || 1;
const uploadable = (r) => !!r && !!r.meta && !!r.meta.id && !SKIP_KINDS.has(String(r.meta['类型'] || '')) && !(fb.isNoise && fb.isNoise(r));
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function titleOf(r) {
  const hook = String(r.meta['涉及'] || '').trim();
  return clip('[' + (r.meta['类型'] || '其他') + '] ' + (hook && hook !== '（没说）' ? hook + '：' : '') + (r.title || '（没写标题）'), 240);
}
/** 议题的正文：开头一张表（版本、模型、电脑、项目……），下面是记录原文，最后一行是签名（搜重复靠它） */
function describe(r) {
  const m = r.meta;
  const rows = [['类型', m['类型']], ['涉及', m['涉及']], ['来源', m['来源']], ['放行', m['放行']], ['套件版本', m['套件版本']], ['Claude Code', m['Claude Code']], ['模型', m['模型']], ['电脑', m['电脑']], ['项目', m['项目']], ['第一次出现', m['时间']], ['到现在几次', m['次数']], ['本机编号', m.id]].filter((x) => x[1] !== undefined && String(x[1]).trim());
  const body = String(r.text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^#\s+.*\r?\n?/, '').trim();
  return '| 项 | 内容 |\n|---|---|\n' + rows.map((x) => '| ' + x[0] + ' | ' + cell(x[1]) + ' |').join('\n') + '\n\n' + clip(body, 60000) + '\n\n---\n由 vibe-kit 自动上报。' + MARK + sigOf(r) + '\n';
}
function noteOf(r, why) {
  const m = r.meta;
  const again = (String(r.text || '').split(/\n## 又出现了\n/)[1] || '').trim().split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
  return why + '\n\n| 项 | 内容 |\n|---|---|\n| 电脑 | ' + cell(m['电脑']) + ' |\n| 项目 | ' + cell(m['项目']) + ' |\n| 套件版本 | ' + cell(m['套件版本']) + ' |\n| Claude Code | ' + cell(m['Claude Code']) + ' |\n| 模型 | ' + cell(m['模型']) + ' |\n| 这台电脑上到现在几次 | ' + countOf(r) + ' |\n| 本机编号 | ' + cell(m.id) + ' |\n' + (again ? '\n最近几次：\n' + again + '\n' : '');
}

// ---------- 对照表（feedback/issues.json） ----------
const STORE = path.join(fb.DIR, 'issues.json');
function readStore() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { j = {}; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  if (!j.map || typeof j.map !== 'object') j.map = {};
  return j;
}
function writeStore(j) {
  try {
    fs.mkdirSync(fb.DIR, { recursive: true });
    const tmp = STORE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j));
    try { fs.renameSync(tmp, STORE); } catch (e) { fs.writeFileSync(STORE, JSON.stringify(j)); try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ } }
  } catch (e) { /* 记不了：下次可能重复传一条，GitLab 那边按签名还会再去一次重 */ }
}
/** 这台电脑第一次有问题上报功能的时刻：没记过就记成现在 */
function sinceOf(store) {
  // 记录里的时间只到秒，这里也取整到秒：同一秒里记的算新的
  if (!(Number(store.since) > 0)) { store.since = Math.floor(Date.now() / 1000) * 1000; writeStore(store); }
  return Number(store.since);
}
// 记录的编号清空之后会重新从 1 排，所以认一条记录要带上它第一次出现的时间
const keyOf = (r) => r.meta.id + '@' + String(r.meta['时间'] || '');
const timeOf = (r) => { const t = Date.parse(String(r.meta['更新'] || r.meta['时间'] || '').replace(' ', 'T')); return isNaN(t) ? 0 : t; };

/** 现在要传的：since 之后记的、还没对上议题的；对上了、次数又涨了、离上次补充超过 12 小时的。老的在前 */
function pending(map, now, since) {
  const out = [];
  for (const r of fb.listRecords().filter(uploadable)) {
    const x = map[keyOf(r)];
    if (!x) { if (timeOf(r) >= (since || 0)) out.push({ r, op: 'create' }); } else if (countOf(r) > (x.count || 1) && now - (x.noteAt || x.at || 0) >= NOTE_EVERY_MS) out.push({ r, op: 'note' });
  }
  return out.reverse();
}

function summary() {
  const cfg = readConfig();
  const st = readState('issues');
  const store = readStore();
  const map = store.map;
  const since = Number(store.since) || 0;
  const recs = fb.listRecords().filter(uploadable);
  const up = recs.filter((r) => map[keyOf(r)]);
  return { on: cfg.issueUpload !== 'off', sshToken: gl.mayMint(cfg) ? 'auto' : 'off', total: recs.length, uploaded: up.length, waiting: recs.filter((r) => !map[keyOf(r)] && timeOf(r) >= since).length,
    lastSyncAt: st.lastSyncAt || 0, lastTryAt: st.lastTryAt || 0, lastError: st.lastError || '', blockedUntil: st.blockedUntil || 0, tokenSource: st.tokenSource || '',
    recent: up.slice(0, 5).map((r) => ({ id: r.meta.id, iid: map[keyOf(r)].iid, url: map[keyOf(r)].url, title: r.title })) };
}

// ---------- 连接口 ----------
/**
 * 准备好连接口要的东西：令牌（没有就用 SSH 申请）、项目的接口地址。
 * 返回 { ok, api, ctx, why, status, noToken, mintFailed }；ctx 给 call() 用
 */
async function connect(cfg) {
  let s = gl.withToken(cfg);
  if (!s.token) return { ok: false, why: s.tokenWhy || '还没有令牌', noToken: true, mintFailed: !!s.mintFailed };
  let api = await gl.projectApi(s);
  let renewed = !!s.minted;
  // SSH 申请来的令牌不认了（被删了、提前失效了）：换一个再试一次
  if (!api.ok && api.status === 401 && s.tokenSource === 'ssh' && !renewed) {
    renewed = true;
    if (gl.dropSshToken()) { const s2 = gl.withToken(cfg); if (s2.token) { s = s2; api = await gl.projectApi(s); } }
  }
  if (!api.ok) return { ok: false, why: api.why, status: api.status };
  return { ok: true, api, ctx: { cfg, s, renewed, ropt: { token: s.token, verifyCert: s.verifyCert } } };
}
/** 发一个请求；SSH 申请来的令牌不认了（401）就重新申请一个再发一次，一轮里只换一次 */
async function call(ctx, method, url, body, timeout) {
  const send = () => gl.request(method, url, Object.assign(body === undefined ? {} : { body }, timeout ? { timeout } : {}, ctx.ropt));
  let r = await send();
  if (r.status === 401 && ctx.s.tokenSource === 'ssh' && !ctx.renewed) {
    ctx.renewed = true;
    if (gl.dropSshToken()) { const s2 = gl.withToken(ctx.cfg); if (s2.token) { ctx.s = s2; ctx.ropt = { token: s2.token, verifyCert: s2.verifyCert }; r = await send(); } }
  }
  return r;
}

/** 在仓库里找带这个签名、还开着的议题 */
async function findOpen(api, ctx, sig) {
  const r = await call(ctx, 'GET', api.base + '/issues?state=opened&per_page=20&search=' + encodeURIComponent(sig));
  if (r.status !== 200 || !Array.isArray(r.json)) return { error: r };
  return { issue: r.json.find((i) => i && String(i.description || '').includes(MARK + sig)) || null };
}
async function createIssue(api, ctx, r, extra) {
  const body = { title: titleOf(r), description: (extra ? extra + '\n\n' : '') + describe(r), labels: 'vibe-kit反馈,' + String(r.meta['类型'] || '其他') };
  let x = await call(ctx, 'POST', api.base + '/issues', body);
  // 没有建标签的权限、或者这个版本的 GitLab 不认：不带标签再建一次
  if (x.status === 400 || x.status === 403 || x.status === 422) { const y = await call(ctx, 'POST', api.base + '/issues', { title: body.title, description: body.description }); if (y.status === 201) x = y; }
  return x;
}
/**
 * 把还没上报的传上去。返回 { created, noted, left, error }。opt.force：不管"停 6 小时"
 */
async function sync(opt) {
  const o = opt || {};
  const cfg = readConfig();
  if (cfg.issueUpload === 'off') return { skipped: '问题上报关着' };
  const now = Date.now();
  const st = readState('issues');
  const store = readStore();
  const map = store.map;
  const since = sinceOf(store);
  if (!o.force && now < (st.blockedUntil || 0)) return { skipped: '上次' + (st.lastError || '出错') + '，先停一阵' };
  const todo = pending(map, now, since).slice(0, MAX_PER_RUN);
  const save = (patch) => { writeStore(store); updateState('issues', (x) => Object.assign(x, { lastTryAt: now }, patch)); };
  if (!todo.length) {
    save({ lastSyncAt: now, lastError: '', blockedUntil: 0 });
    return { created: 0, noted: 0, left: 0 };
  }
  const c = await connect(cfg);
  if (!c.ok) {
    // 没有令牌不算出错：问题照旧存在本机，有了令牌之后一起传
    save({ lastError: c.why, blockedUntil: c.mintFailed || [401, 403, 404].includes(c.status) ? now + BLOCK_MS : now + 30 * 60000 });
    return { created: 0, noted: 0, left: todo.length, error: c.why, noToken: !!c.noToken };
  }
  const api = c.api;
  const ctx = c.ctx;
  let created = 0;
  let noted = 0;
  let error = '';
  let blocked = 0;
  for (const t of todo) {
    const r = t.r;
    const key = keyOf(r);
    const sig = sigOf(r);
    let x = null;
    if (t.op === 'note') {
      const cur = await call(ctx, 'GET', api.base + '/issues/' + map[key].iid);
      if (cur.status === 200 && cur.json && cur.json.state === 'closed') {
        // 那一条已经关掉了（导出过、或者修过了），现在又出现：新建一条，写明之前是哪条
        x = await createIssue(api, ctx, r, '之前的 #' + cur.json.iid + ' 已经关闭，问题又出现了。');
        if (x.status === 201) { map[key] = { iid: x.json.iid, url: x.json.web_url || '', sig, count: countOf(r), at: now, noteAt: now }; created++; continue; }
      } else {
        x = await call(ctx, 'POST', api.base + '/issues/' + map[key].iid + '/notes', { body: noteOf(r, '又出现了。') });
        if (x.status === 201) { map[key] = Object.assign({}, map[key], { count: countOf(r), noteAt: now }); noted++; continue; }
      }
    } else {
      const f = await findOpen(api, ctx, sig);
      if (f.error) x = f.error;
      else if (f.issue) {
        x = await call(ctx, 'POST', api.base + '/issues/' + f.issue.iid + '/notes', { body: noteOf(r, '这台电脑上也出现了。') });
        if (x.status === 201) { map[key] = { iid: f.issue.iid, url: f.issue.web_url || '', sig, count: countOf(r), at: now, noteAt: now, joined: true }; noted++; continue; }
      } else {
        x = await createIssue(api, ctx, r, '');
        if (x.status === 201 && x.json && x.json.iid) { map[key] = { iid: x.json.iid, url: x.json.web_url || '', sig, count: countOf(r), at: now, noteAt: now }; created++; continue; }
      }
    }
    error = gl.explain(x || { status: 0, error: '没有回应' }, '上报 ' + r.meta.id);
    if (x && [401, 403, 404].includes(x.status)) blocked = now + BLOCK_MS;
    break;
  }
  // 清掉对不上任何记录的（记录已经在配置页清空了）：对照表不会越攒越大
  const alive = new Set(fb.listRecords().map(keyOf));
  for (const k of Object.keys(map)) if (!alive.has(k)) delete map[k];
  const left = pending(map, now, since).length;
  save(Object.assign({ lastError: error, tokenSource: ctx.s.tokenSource }, blocked ? { blockedUntil: blocked } : { blockedUntil: 0 }, !error && !left ? { lastSyncAt: now } : {}));
  return { created, noted, left, error };
}

// ---------- 导出（维护套件的那台电脑） ----------
const maskIps = (t) => String(t || '').replace(/\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g, '内网IP');
const safe = (t) => maskIps(fb.redact(t));
const when = (t) => { const d = new Date(t); return isNaN(d) ? String(t || '') : d.toLocaleString('zh-CN', { hour12: false }); };
async function listAll(api, ctx, query) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const r = await call(ctx, 'GET', api.base + query + (query.includes('?') ? '&' : '?') + 'per_page=100&page=' + page, undefined, 30000);
    if (r.status !== 200 || !Array.isArray(r.json)) return { error: r, list: out };
    out.push(...r.json);
    if (r.json.length < 100) break;
  }
  return { list: out };
}
/**
 * 导出开放中的议题，然后把导出的这一批关掉。opt.close 给 false 就只导出不关。
 * 返回 { ok, name, text, count, closed, failed, saved }：saved 是本机存的那一份在哪
 */
async function exportIssues(opt) {
  const o = opt || {};
  const c = await connect(readConfig());
  if (!c.ok) return { ok: false, why: c.why };
  const api = c.api;
  const ctx = c.ctx;
  const got = await listAll(api, ctx, '/issues?state=opened&order_by=created_at&sort=asc');
  if (got.error) return { ok: false, why: gl.explain(got.error, '读议题') };
  const pick = got.list;
  const close = o.close !== false && pick.length > 0;
  const parts = [];
  const kinds = {};
  for (const i of pick) {
    const n = await listAll(api, ctx, '/issues/' + i.iid + '/notes?sort=asc&order_by=created_at');
    if (n.error) return { ok: false, why: gl.explain(n.error, '读 #' + i.iid + ' 下面的补充') };
    const notes = (n.list || []).filter((x) => x && !x.system);
    const kind = (/^\[([^\]]+)\]/.exec(String(i.title || '')) || [])[1] || '（手写的）';
    kinds[kind] = (kinds[kind] || 0) + 1;
    const desc = String(i.description || '').replace(/\n+---\n由 vibe-kit 自动上报。.*$/s, '').trim();
    parts.push('## #' + i.iid + ' ' + safe(i.title) + '\n\n- 提的人：' + safe((i.author && (i.author.name || i.author.username)) || '？') + '　创建：' + when(i.created_at) + '　最近更新：' + when(i.updated_at) + '　补充：' + notes.length + ' 条'
      + (Array.isArray(i.labels) && i.labels.length ? '　标签：' + safe(i.labels.join('、')) : '') + '\n\n' + safe(desc)
      + (notes.length ? '\n\n### 后来的补充\n\n' + notes.map((x) => '**' + when(x.created_at) + '　' + safe((x.author && (x.author.name || x.author.username)) || '？') + '**\n\n' + safe(clip(x.body, 8000))).join('\n\n') : ''));
  }
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const name = 'vibe-kit议题汇总-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.md';
  const head = '# vibe-kit 议题汇总\n\n- 项目：' + ctx.s.parsed.projectPath + '\n- 导出时间：' + when(Date.now()) + '\n- 导出的电脑：' + os.hostname() + '\n- 这次导出 ' + pick.length + ' 条，是仓库里开放中的全部议题'
    + (close ? '。导出之后它们已经在 GitLab 上关闭（按编号还能查到）' : '。这次只导出，没有关闭')
    + '\n\n给改套件的人：每条的编号（#数字）是议题号。修好之后在《更新说明.md》那一版里写上"修了 #编号"，发布时会在对应的议题下面留一句是哪一版修的。\n\n'
    + (pick.length ? '| 类型 | 条数 |\n|---|---|\n' + Object.keys(kinds).sort((a, b) => kinds[b] - kinds[a]).map((k) => '| ' + k + ' | ' + kinds[k] + ' |').join('\n') + '\n' : '现在没有开放中的议题。\n');
  const text = head + (parts.length ? '\n---\n\n' + parts.join('\n\n---\n\n') + '\n' : '');
  // 本机先存一份：存好了才去关
  let saved = '';
  if (pick.length) {
    try {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      saved = path.join(EXPORT_DIR, name);
      fs.writeFileSync(saved, text);
      const old = fs.readdirSync(EXPORT_DIR).filter((n) => /^vibe-kit议题汇总-.*\.md$/.test(n)).sort();
      while (old.length > KEEP_EXPORTS) { try { fs.unlinkSync(path.join(EXPORT_DIR, old.shift())); } catch (e) { break; } }
    } catch (e) { saved = ''; }
  }
  const closed = [];
  const failed = [];
  let notClosed = '';
  if (close && !saved) notClosed = '本机没能存下导出的文件，为了不丢东西，这次没有关闭议题';
  else if (close) {
    for (const i of pick) {
      await call(ctx, 'POST', api.base + '/issues/' + i.iid + '/notes', { body: '已导出，交给改套件的人处理（' + when(Date.now()) + '，' + name + '）。关掉之后同样的问题再出现，会重新报上来。' });
      const r = await call(ctx, 'PUT', api.base + '/issues/' + i.iid, { state_event: 'close' });
      if (r.status === 200) closed.push(i.iid); else failed.push('#' + i.iid + '（' + gl.explain(r, '关闭') + '）');
    }
  }
  updateState('issues-exported', () => ({ last: { at: Date.now(), name, count: pick.length, closed: closed.length, failed: failed.length, saved } }));
  return { ok: true, name, text, count: pick.length, closed, failed, notClosed, saved };
}
/** 上一次导出的情况（配置页上显示） */
function lastExport() { const x = readState('issues-exported').last; return x && x.at ? x : null; }
/**
 * 发布新版时：更新说明里写了"修了 #编号"的议题，在下面留一句是哪一版修的；还开着的顺手关掉。
 * 返回 { ok, noted, closed, failed }
 */
async function closeFixed(version, iids) {
  const c = await connect(readConfig());
  if (!c.ok) return { ok: false, why: c.why, noted: [], closed: [], failed: [] };
  const api = c.api;
  const ctx = c.ctx;
  const noted = [];
  const closed = [];
  const failed = [];
  for (const iid of iids) {
    const cur = await call(ctx, 'GET', api.base + '/issues/' + iid);
    if (cur.status !== 200 || !cur.json) { failed.push('#' + iid + '（' + (cur.status === 404 ? '没有这个议题' : '读不到') + '）'); continue; }
    const n = await call(ctx, 'POST', api.base + '/issues/' + iid + '/notes', { body: '已在 ' + version + ' 这一版里修了。装了这一版还出现的话，会重新报上来。' });
    if (n.status === 201) noted.push(iid); else { failed.push('#' + iid + '（' + gl.explain(n, '留言') + '）'); continue; }
    if (cur.json.state === 'closed') continue;
    const r = await call(ctx, 'PUT', api.base + '/issues/' + iid, { state_event: 'close' });
    if (r.status === 200) closed.push(iid); else failed.push('#' + iid + '（' + gl.explain(r, '关闭') + '）');
  }
  return { ok: true, noted, closed, failed };
}

module.exports = { sync, summary, pending, exportIssues, lastExport, closeFixed, describe, titleOf, sigOf, keyOf, MARK, EXPORT_DIR, STORE };

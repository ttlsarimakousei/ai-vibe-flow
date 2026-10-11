'use strict';
/*
 * 测试用的假 GitLab：一个进程里两样东西。
 *   git 的 http 通道   /<组>/<项目>.git/...，背后是本机的裸仓库（git http-backend）。要带令牌（Authorization: Basic oauth2:令牌），不带回 401
 *   议题的接口         /api/v4/projects/...，数据在内存里，每次变动写一份到 <数据目录>/issues.json 给测试读
 * 行为由 <数据目录>/behavior.json 控制（每个请求现读）：
 *   project        项目路径（默认 nb-2026/p1/vibe-kit）      access     这个账号在项目里的级别（默认 20 = Reporter）
 *   anonymousGit   拉仓库不要登录                            encoded404 用"路径转码"的写法查项目回 404（有的反向代理会这样）
 *   labels403      带标签建议题回 403                        issuesOff  项目关掉了议题
 *   apiDown        接口一律回 500
 * 认哪些令牌看 <数据目录>/tokens.json（{ 令牌: { user, expires } }，过了 expires 的不认）。
 * 请求记在 <数据目录>/requests.log（一行一个 JSON，令牌只记前 6 位）。
 * 用法：node fake-gitlab.js <端口> <裸仓库的根目录> <数据目录>
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.argv[2]);
const REPOS = process.argv[3];
const DATA = process.argv[4];
const PROJECT_ID = 77;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return d; } };
const behavior = () => Object.assign({ project: 'nb-2026/p1/vibe-kit', access: 20 }, readJson('behavior.json', {}));
const tokenOk = (t) => { const all = readJson('tokens.json', {}); const x = all[t]; return !!x && (!x.expires || Date.parse(x.expires + 'T23:59:59') >= Date.now()) ? x : null; };
const short = (t) => (t ? String(t).slice(0, 6) + '…' : '');
const log = (o) => { try { fs.appendFileSync(path.join(DATA, 'requests.log'), JSON.stringify(o) + '\n'); } catch (e) { /* 记不了就算了 */ } };

let issues = readJson('issues.json', []);
let noteSeq = 1000;
const save = () => fs.writeFileSync(path.join(DATA, 'issues.json'), JSON.stringify(issues, null, 2));
const now = () => new Date().toISOString();
const base = () => 'http://127.0.0.1:' + PORT;
const pub = (i) => Object.assign({}, i, { notes: undefined, user_notes_count: i.notes.filter((n) => !n.system).length });

function send(res, status, body, headers) {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': data.length }, headers || {}));
  res.end(data);
}
function projectJson(b, user) {
  return { id: PROJECT_ID, name: b.project.split('/').pop(), path_with_namespace: b.project, web_url: base() + '/' + b.project, issues_enabled: !b.issuesOff, visibility: 'internal', permissions: { project_access: b.access ? { access_level: b.access } : null, group_access: null }, _user: user };
}
function api(req, res, u, body) {
  const b = behavior();
  const token = String(req.headers['private-token'] || '');
  const who = tokenOk(token);
  let json = null;
  try { json = body.length ? JSON.parse(body.toString('utf8')) : null; } catch (e) { json = null; }
  log({ kind: 'api', method: req.method, url: req.url, token: short(token), ok: !!who, body: json });
  if (b.apiDown) return send(res, 500, { message: '500 Internal Server Error' });
  if (!who) return send(res, 401, { message: '401 Unauthorized' });
  const p = u.pathname.replace(/^\/api\/v4/, '');
  const q = u.searchParams;
  if (req.method === 'GET' && p === '/projects') {
    const s = String(q.get('search') || '').toLowerCase();
    return send(res, 200, b.project.toLowerCase().includes(s) ? [{ id: PROJECT_ID, path_with_namespace: b.project, name: b.project.split('/').pop() }] : []);
  }
  const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return send(res, 404, { message: '404 Not Found' });
  const ref = decodeURIComponent(m[1]);
  const byPath = !/^\d+$/.test(ref);
  if (byPath && (b.encoded404 || ref.toLowerCase() !== b.project.toLowerCase())) return send(res, 404, { message: '404 Project Not Found' });
  if (!byPath && Number(ref) !== PROJECT_ID) return send(res, 404, { message: '404 Project Not Found' });
  const rest = m[2] || '';
  if (req.method === 'GET' && rest === '') return send(res, 200, projectJson(b, who.user));
  if (b.issuesOff && /^\/issues/.test(rest)) return send(res, 403, { message: '403 Forbidden' });
  if (req.method === 'GET' && rest === '/issues') {
    let list = issues.slice();
    const state = q.get('state');
    if (state === 'opened' || state === 'closed') list = list.filter((i) => i.state === state);
    const s = String(q.get('search') || '').toLowerCase();
    if (s) list = list.filter((i) => (i.title + '\n' + i.description).toLowerCase().includes(s));
    if (q.get('sort') !== 'asc') list.reverse();
    const per = Number(q.get('per_page')) || 20;
    const page = Number(q.get('page')) || 1;
    return send(res, 200, list.slice((page - 1) * per, page * per).map(pub));
  }
  if (req.method === 'POST' && rest === '/issues') {
    if (!json || !json.title) return send(res, 400, { message: { title: ['is missing'] } });
    if (b.labels403 && json.labels) return send(res, 403, { message: '403 Forbidden' });
    if ((b.access || 0) < 20 && b.strict) return send(res, 403, { message: '403 Forbidden' });
    const iid = issues.length + 1;
    const i = { id: 5000 + iid, iid, title: String(json.title), description: String(json.description || ''), state: 'opened', labels: String(json.labels || '').split(',').filter(Boolean), author: { name: who.user, username: who.user }, created_at: now(), updated_at: now(), web_url: base() + '/' + b.project + '/-/issues/' + iid, notes: [] };
    issues.push(i); save();
    return send(res, 201, pub(i));
  }
  const im = /^\/issues\/(\d+)(\/notes)?$/.exec(rest);
  if (im) {
    const i = issues.find((x) => x.iid === Number(im[1]));
    if (!i) return send(res, 404, { message: '404 Not found' });
    if (!im[2] && req.method === 'GET') return send(res, 200, pub(i));
    if (!im[2] && req.method === 'PUT') {
      if (json && typeof json.title === 'string') i.title = json.title;
      if (json && typeof json.description === 'string') i.description = json.description;
      if (json && json.state_event === 'close' && i.state !== 'closed') { i.state = 'closed'; i.updated_at = now(); i.notes.push({ id: ++noteSeq, body: 'closed', system: true, author: { name: who.user, username: who.user }, created_at: now() }); }
      if (json && json.state_event === 'reopen') { i.state = 'opened'; i.updated_at = now(); }
      save();
      return send(res, 200, pub(i));
    }
    if (im[2] && req.method === 'GET') return send(res, 200, i.notes);
    if (im[2] && req.method === 'POST') {
      if (!json || !json.body) return send(res, 400, { message: { body: ['is missing'] } });
      const n = { id: ++noteSeq, body: String(json.body), system: false, author: { name: who.user, username: who.user }, created_at: now() };
      i.notes.push(n); i.updated_at = now(); save();
      return send(res, 201, n);
    }
  }
  return send(res, 404, { message: '404 Not Found' });
}

function gitHttp(req, res, u, body) {
  const b = behavior();
  const auth = String(req.headers.authorization || '');
  let user = '';
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (m) { const [name, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(/:(.*)/s); const who = name === 'oauth2' ? tokenOk(pass) : null; if (who) user = who.user; log({ kind: 'git', method: req.method, url: req.url, auth: name + ':' + short(pass), ok: !!who }); } else log({ kind: 'git', method: req.method, url: req.url, auth: '', ok: !!b.anonymousGit });
  if (!user && !b.anonymousGit) return send(res, 401, 'HTTP Basic: Access denied\n', { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="GitLab"' });
  const env = Object.assign({}, process.env, {
    GIT_PROJECT_ROOT: REPOS, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.replace(/^\?/, ''),
    CONTENT_TYPE: String(req.headers['content-type'] || ''), CONTENT_LENGTH: String(body.length), REMOTE_ADDR: '127.0.0.1', GATEWAY_INTERFACE: 'CGI/1.1',
  });
  if (user) env.REMOTE_USER = user; else delete env.REMOTE_USER;
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);
  const c = spawn('git', ['http-backend'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  let err = '';
  c.stdout.on('data', (d) => out.push(d));
  c.stderr.on('data', (d) => { err += d; });
  c.on('error', (e) => send(res, 500, 'git http-backend 起不来：' + e.message, { 'content-type': 'text/plain' }));
  c.on('close', () => {
    const all = Buffer.concat(out);
    let cut = all.indexOf('\r\n\r\n');
    let skip = 4;
    if (cut < 0) { cut = all.indexOf('\n\n'); skip = 2; }
    if (cut < 0) return send(res, 500, 'git http-backend 的输出看不懂：' + err, { 'content-type': 'text/plain' });
    const headers = {};
    let status = 200;
    for (const line of all.slice(0, cut).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (/^status$/i.test(k)) status = parseInt(v, 10) || 200; else headers[k.toLowerCase()] = v;
    }
    const data = all.slice(cut + skip);
    headers['content-length'] = data.length;
    res.writeHead(status, headers);
    res.end(data);
  });
  c.stdin.on('error', () => {});
  c.stdin.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, base());
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    try {
      if (u.pathname === '/__ping') return send(res, 200, { ok: true });
      if (u.pathname.startsWith('/api/v4/')) return api(req, res, u, body);
      if (/\.git\//.test(u.pathname)) return gitHttp(req, res, u, body);
      log({ kind: 'other', method: req.method, url: req.url });
      return send(res, 404, { message: '404 Not Found' });
    } catch (e) { return send(res, 500, { message: String((e && e.stack) || e) }); }
  });
});
server.listen(PORT, '127.0.0.1', () => { process.stdout.write('listening ' + PORT + '\n'); });

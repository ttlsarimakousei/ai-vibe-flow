'use strict';
/*
 * 内网 GitLab：自动更新（lib/updater.js）和问题上报（lib/issues.js）共用的一层。
 *
 *   仓库地址、分支、SSH 地址   ~/.claude/vibe-kit/gitlab.json（配置页"自动更新和问题上报"里填；没填过就用下面的默认地址）
 *   令牌                       ~/.claude/vibe-kit/secrets.json（单独一个文件：接口从不把它原样回给页面；模型用命令读它会被拦，
 *                              Read 工具由 settings.json 里的 deny 规则拦）
 *
 * 同一个仓库两个用途：仓库里放解开的安装包（自动更新用 git 拉），仓库的议题（issue）收问题反馈（用接口建）。
 *
 * 拉仓库能走三条路，挨个试，走通的那条记下来下次先试：
 *   令牌     配置页里手填的个人访问令牌（勾 read_repository；要建议题再勾 api）
 *   SSH      这台电脑和 GitLab 换过密钥的，不用令牌。SSH 地址默认从 http 地址推出来（git@主机:路径.git），端口不是 22 的在配置页里单独填
 *   本机登录 这台电脑上 git 自己记着的账号（凭据管理器里的）
 *
 * 议题的接口只认令牌，不认 SSH 密钥。没填令牌、SSH 又是通的：用 GitLab 自带的功能，拿 SSH 密钥向它申请一个令牌
 * （ssh git@主机 personal_access_token 名字 api 天数），存在 secrets.json 里，到期前自动再申请。
 * 这个功能比较新的 GitLab 才有，管理员也可以关掉；不支持的话议题建不了，问题照旧只存在本机。开关：config.json 的 sshToken（auto / off）。
 *
 * git 和 ssh 一律关掉交互：没登录、没权限、密钥带口令，都是安静地失败，不弹登录框、不卡住。
 * 令牌不写进仓库地址、不写进 .git/config：每次用环境变量带一个请求头进去（git 2.31 起支持；老的 git 退回用 -c 参数）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const DEFAULT_REPO = 'http://scm.skytech.io/nb-2026/p1/ai-engineering/90-personal/3139/vibe-kit.git';
const SETTINGS_FILE = path.join(KIT, 'gitlab.json');
const SECRETS_FILE = path.join(KIT, 'secrets.json');
const TOKEN_DAYS = 30;
const RENEW_BEFORE_MS = 2 * 24 * 3600000;

function readJson(f) { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n');
  try { fs.renameSync(tmp, f); } catch (e) { fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n'); try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ } }
}
const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f​-‏﻿]/g, '').trim();

// ---------- 地址 ----------
/** SSH 地址拆开。两种写法：git@主机:组/项目.git，ssh://git@主机:端口/组/项目.git */
function parseSsh(url) {
  const u = clean(url);
  let m = /^ssh:\/\/(?:([\w.-]+)@)?([\w.-]+)(?::(\d+))?\/(.+?)\/?$/i.exec(u);
  if (m) return { ok: true, url: u, user: m[1] || 'git', host: m[2], port: Number(m[3]) || 0, projectPath: m[4].replace(/^\/+/, '').replace(/\.git$/i, '') };
  m = /^([\w.-]+)@([\w.-]+):(?!\/\/)(.+?)\/?$/.exec(u);
  if (m && !/^\d+\//.test(m[3])) return { ok: true, url: u, user: m[1], host: m[2], port: 0, projectPath: m[3].replace(/^\/+/, '').replace(/\.git$/i, '') };
  return { ok: false, why: 'SSH 地址要写成 git@主机:组/项目.git，端口不是 22 的写成 ssh://git@主机:端口/组/项目.git' };
}
/** 从仓库地址看出 GitLab 在哪、项目路径是什么。http / https 的能拉仓库也能用接口；ssh 的只能拉仓库 */
function parseRepo(url) {
  const u0 = clean(url);
  if (!u0) return { ok: false, why: '没填仓库地址' };
  if (!/^https?:\/\//i.test(u0)) {
    const ssh = parseSsh(u0);
    if (ssh.ok) return { ok: true, git: u0, ssh: true, host: ssh.host, hostname: ssh.host, projectPath: ssh.projectPath, origin: '', web: '' };
    if (/^[A-Za-z]:[\\/]|^\/|^file:\/\//.test(u0)) return { ok: true, git: u0, local: true, host: '', hostname: '', projectPath: '', origin: '', web: '' };
    return { ok: false, why: '仓库地址要以 http:// 或 https:// 开头' };
  }
  let u;
  try { u = new URL(u0); } catch (e) { return { ok: false, why: '仓库地址不是合法的网址' }; }
  const projectPath = decodeURIComponent(u.pathname).replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!projectPath || !/\//.test(projectPath)) return { ok: false, why: '仓库地址里看不出项目路径（应该像 http://地址/组/项目.git）' };
  // 地址里带了账号密码的：拉仓库时照用，别处（页面、日志）一律不显示
  const bare = u.protocol + '//' + u.host;
  return { ok: true, git: u0, host: u.host, hostname: u.hostname, origin: bare, projectPath, web: bare + '/' + projectPath, https: u.protocol === 'https:' };
}
/** SSH 走哪：配置页里填了就用填的；没填就从仓库地址推（git@主机:路径.git，端口 22） */
function sshTarget(parsed, sshRepo) {
  if (clean(sshRepo)) { const p = parseSsh(sshRepo); return p.ok ? Object.assign(p, { derived: false }) : { ok: false, why: p.why }; }
  if (!parsed || !parsed.ok || parsed.local) return { ok: false, why: '仓库地址不是 GitLab 上的' };
  if (parsed.ssh) return Object.assign(parseSsh(parsed.git), { derived: false });
  return { ok: true, url: 'git@' + parsed.hostname + ':' + parsed.projectPath + '.git', user: 'git', host: parsed.hostname, port: 0, projectPath: parsed.projectPath, derived: true };
}
const maskUrl = (url) => clean(url).replace(/^(https?:\/\/)[^/@]+@/i, '$1***@');
const maskToken = (t) => { const s = clean(t); if (!s) return ''; return s.length <= 8 ? '****' : s.slice(0, 6) + '…' + s.slice(-4); };

// ---------- 设置 ----------
function settings() {
  const s = readJson(SETTINGS_FILE);
  const sec = readJson(SECRETS_FILE);
  const repo = clean(s.repo) || DEFAULT_REPO;
  const parsed = parseRepo(repo);
  const sshRepo = clean(s.sshRepo);
  const token = clean(sec.gitlabToken);
  const who = repo + '|' + sshRepo;
  return {
    repo, isDefault: !clean(s.repo), branch: clean(s.branch), sshRepo, ssh: sshTarget(parsed, sshRepo), parsed, verifyCert: s.verifyCert === true,
    token, tokenSource: token ? (sec.gitlabTokenSource === 'ssh' ? 'ssh' : 'manual') : '', tokenExpires: token ? clean(sec.gitlabTokenExpires) : '',
    projectId: Number(s.projectId) > 0 && clean(s.projectIdFor) === repo ? Number(s.projectId) : 0,
    route: clean(s.routeFor) === who ? clean(s.route) : '', who,
  };
}
/** 同一个项目的记号（暂存处是不是还对得上这个仓库，靠它认）：主机 + 项目路径，不分 http 还是 ssh */
function repoKey(s0) {
  const s = s0 || settings();
  const p = s.parsed;
  if (!p.ok) return '';
  if (p.local) return 'local:' + clean(p.git).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (String(p.hostname || p.host) + '/' + p.projectPath).toLowerCase();
}
/** 给页面看的：令牌只给遮过的 */
function publicSettings() {
  const s = settings();
  return {
    repo: maskUrl(s.repo), isDefault: s.isDefault, defaultRepo: DEFAULT_REPO, branch: s.branch, verifyCert: s.verifyCert, problem: s.parsed.ok ? '' : s.parsed.why, web: s.parsed.web || '', canIssue: !!(s.parsed.ok && s.parsed.origin),
    sshRepo: s.sshRepo, sshUrl: s.ssh.ok ? s.ssh.url : '', sshDerived: !!(s.ssh.ok && s.ssh.derived), sshProblem: s.ssh.ok ? '' : (s.sshRepo ? s.ssh.why : ''),
    tokenSet: !!s.token, tokenMasked: maskToken(s.token), tokenSource: s.tokenSource, tokenExpires: s.tokenExpires, route: s.route,
  };
}
/** 配置页保存：repo、sshRepo 给空串 = 用默认的；token 没传 = 不动，传空串 = 清掉 */
function saveSettings(x) {
  const cur = readJson(SETTINGS_FILE);
  const next = Object.assign({}, cur);
  if (x && x.repo !== undefined) {
    const r = clean(x.repo);
    if (r && r !== DEFAULT_REPO) { const p = parseRepo(r); if (!p.ok) throw new Error(p.why); next.repo = r; } else delete next.repo;
    if ((clean(cur.repo) || DEFAULT_REPO) !== (clean(next.repo) || DEFAULT_REPO)) { delete next.projectId; delete next.projectIdFor; }
  }
  if (x && x.sshRepo !== undefined) { const r = clean(x.sshRepo); if (r) { const p = parseSsh(r); if (!p.ok) throw new Error(p.why); next.sshRepo = r; } else delete next.sshRepo; }
  if (x && x.branch !== undefined) { const b = clean(x.branch); if (b && !/^[\w./-]{1,100}$/.test(b)) throw new Error('分支名里有不认识的字符'); if (b) next.branch = b; else delete next.branch; }
  if (x && typeof x.verifyCert === 'boolean') next.verifyCert = x.verifyCert;
  // 改过设置：上次走通的是哪条路不作数了，重新挨个试
  delete next.route; delete next.routeFor;
  writeJson(SETTINGS_FILE, next);
  if (x && x.token !== undefined) {
    const t = clean(x.token);
    if (t && !/^[\x21-\x7e]{8,200}$/.test(t)) throw new Error('令牌里有不该有的字符（中文、空格），重新复制一遍');
    const sec = readJson(SECRETS_FILE);
    delete sec.gitlabTokenExpires; delete sec.gitlabTokenAt;
    if (t) { sec.gitlabToken = t; sec.gitlabTokenSource = 'manual'; } else { delete sec.gitlabToken; delete sec.gitlabTokenSource; }
    writeJson(SECRETS_FILE, sec);
  }
  return publicSettings();
}
function rememberProjectId(id, repo) { try { const cur = readJson(SETTINGS_FILE); cur.projectId = id; cur.projectIdFor = repo; writeJson(SETTINGS_FILE, cur); } catch (e) { /* 记不了就每次现查 */ } }
function rememberRoute(s, name) { try { if (s.route === name) return; const cur = readJson(SETTINGS_FILE); cur.route = name; cur.routeFor = s.who; writeJson(SETTINGS_FILE, cur); s.route = name; } catch (e) { /* 记不了就每次挨个试 */ } }

// ---------- 接口 ----------
/** 发一个请求。返回 { status, json, text, error }：连不上、超时 status 是 0，error 里是原因 */
function request(method, url, opt) {
  const o = opt || {};
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, json: null, text: '', error: '地址不对：' + url }); }
    const data = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
    const headers = { Accept: 'application/json', 'User-Agent': 'vibe-kit' };
    if (o.token) headers['PRIVATE-TOKEN'] = o.token;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({ agent: false, method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers, timeout: o.timeout || 15000, rejectUnauthorized: o.verifyCert === true }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 不是 JSON（登录页、报错页） */ }
        resolve({ status: res.statusCode, json, text: text.slice(0, 2000), headers: res.headers, error: '' });
      });
    });
    req.on('timeout', () => req.destroy(new Error('等了 ' + Math.round((o.timeout || 15000) / 1000) + ' 秒没回应')));
    req.on('error', (e) => resolve({ status: 0, json: null, text: '', error: (e && (e.code || e.message)) || String(e) }));
    if (data) req.write(data);
    req.end();
  });
}
/** 出错时给人看的一句话 */
function explain(r, what) {
  if (!r.status) return what + '：连不上 GitLab（' + r.error + '）';
  if (r.status === 401) return what + '：令牌不对或者过期了（401）';
  if (r.status === 403) return what + '：没有权限（403）。令牌要勾 api，账号在项目里至少是 Reporter';
  if (r.status === 404) return what + '：找不到项目（404）。仓库地址不对，或者这个账号看不到它';
  const msg = r.json && (r.json.message || r.json.error) ? JSON.stringify(r.json.message || r.json.error).slice(0, 200) : r.text.slice(0, 200);
  return what + '：GitLab 回了 ' + r.status + (msg ? '（' + msg + '）' : '');
}
/**
 * 项目的接口地址。先用"路径转码"的写法；有的反向代理会把 %2F 解开，那样会 404，这时按名字搜一遍、对上完整路径，拿到数字编号再用。
 * 返回 { ok, base, id, why }
 */
async function projectApi(s0) {
  const s = s0 || settings();
  const p = s.parsed;
  if (!p.ok) return { ok: false, why: p.why };
  if (!p.origin) return { ok: false, why: '仓库地址不是 http / https 的，用不了议题的接口（SSH 地址填到"SSH 地址"那一栏，仓库地址填 http 的）' };
  if (!s.token) return { ok: false, why: '还没有令牌', noToken: true };
  const api = p.origin + '/api/v4';
  const opt = { token: s.token, verifyCert: s.verifyCert };
  if (s.projectId) return { ok: true, base: api + '/projects/' + s.projectId, id: s.projectId, api };
  let r = await request('GET', api + '/projects/' + encodeURIComponent(p.projectPath), opt);
  if (r.status === 200 && r.json && r.json.id) { rememberProjectId(r.json.id, s.repo); return { ok: true, base: api + '/projects/' + r.json.id, id: r.json.id, api, project: r.json }; }
  if (r.status === 404) {
    const name = p.projectPath.split('/').pop();
    const q = await request('GET', api + '/projects?simple=true&per_page=100&search=' + encodeURIComponent(name), opt);
    const hit = q.status === 200 && Array.isArray(q.json) ? q.json.find((x) => x && String(x.path_with_namespace).toLowerCase() === p.projectPath.toLowerCase()) : null;
    if (hit) { rememberProjectId(hit.id, s.repo); return { ok: true, base: api + '/projects/' + hit.id, id: hit.id, api, project: hit }; }
    if (q.status && q.status !== 200) r = q;
  }
  return { ok: false, why: explain(r, '查项目'), status: r.status };
}

// ---------- git ----------
let gitVer = null;
function gitVersion() {
  if (gitVer !== null) return gitVer;
  try { const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); const m = /(\d+)\.(\d+)/.exec(String(r.stdout || '')); gitVer = r.status === 0 && m ? Number(m[1]) * 100 + Number(m[2]) : 0; } catch (e) { gitVer = 0; }
  return gitVer;
}
let sshBase = null;
/**
 * git 用哪个 ssh：这台电脑上原来怎么配的就怎么用（环境变量 GIT_SSH_COMMAND、git 配置里的 core.sshCommand、环境变量 GIT_SSH），
 * 都没配就是 ssh。后面加上"不许交互"：要输口令、要确认指纹的，直接失败
 */
function sshCommand() {
  if (sshBase === null) {
    let base = clean(process.env.GIT_SSH_COMMAND);
    if (!base) { try { const r = spawnSync('git', ['config', '--get', 'core.sshCommand'], { encoding: 'utf8', windowsHide: true, timeout: 10000, cwd: os.tmpdir() }); if (r.status === 0) base = clean(r.stdout); } catch (e) { /* 没配 */ } }
    if (!base && clean(process.env.GIT_SSH)) base = '"' + clean(process.env.GIT_SSH).replace(/\\/g, '/') + '"';
    sshBase = base || 'ssh';
  }
  return /plink/i.test(sshBase) ? sshBase + ' -batch' : sshBase + ' -o BatchMode=yes -o ConnectTimeout=10';
}
const hide = (t) => String(t || '').replace(/Authorization: Basic \S+/g, 'Authorization: Basic ***').replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@').replace(/\bglpat-[\w-]{6,}/g, 'glpat-***');
function quietEnv() { return Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo', LANG: 'C', LC_ALL: 'C' }); }
/**
 * 跑一条 git：不交互、不弹窗口、不改文件的换行。opt.route 是走哪条路（routes() 里的一项）；不给就是不碰远端的本地操作。
 * 返回 { code, out, err, ms }
 */
function git(cwd, args, opt) {
  const o = opt || {};
  const s = o.settings || settings();
  const route = o.route ? (typeof o.route === 'string' ? o.route : o.route.name) : '';
  const env = quietEnv();
  // safe.directory：暂存处、安装包目录在移动硬盘、网络盘上时，git 会因为"认不出目录是谁的"拒绝干活
  const pre = ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'credential.interactive=false', '-c', 'safe.directory=*'];
  if (route === 'token' && s.token) {
    const header = 'Authorization: Basic ' + Buffer.from('oauth2:' + s.token).toString('base64');
    if (gitVersion() >= 231) { env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.extraHeader'; env.GIT_CONFIG_VALUE_0 = header; } else pre.push('-c', 'http.extraHeader=' + header);
  }
  if (route === 'ssh') env.GIT_SSH_COMMAND = sshCommand();
  if (route && route !== 'ssh' && s.parsed.https && !s.verifyCert) pre.push('-c', 'http.sslVerify=false');
  const t0 = Date.now();
  let r;
  try { r = spawnSync('git', pre.concat(args), { cwd: cwd || undefined, env, encoding: 'utf8', windowsHide: true, timeout: o.timeout || 120000, maxBuffer: 32 * 1024 * 1024 }); } catch (e) { return { code: -1, out: '', err: String((e && e.message) || e), ms: Date.now() - t0 }; }
  if (r.error) return { code: -1, out: '', err: r.error.code === 'ENOENT' ? '这台电脑上找不到 git' : r.error.code === 'ETIMEDOUT' ? '等了 ' + Math.round((o.timeout || 120000) / 1000) + ' 秒没结果' : String(r.error.message), ms: Date.now() - t0, missing: r.error.code === 'ENOENT' };
  return { code: r.status, out: hide(r.stdout), err: hide(r.stderr), ms: Date.now() - t0 };
}
/** git、ssh 报的错翻成人话 */
function explainGit(r, what) {
  const e = String(r.err || '').trim();
  if (r.missing) return what + '：这台电脑上找不到 git';
  if (/Host key verification failed/i.test(e)) return what + '：这台电脑还没用 SSH 连过 GitLab。先在终端里手动连一次、确认指纹（ssh -T git@GitLab的地址）';
  if (/Permission denied \(publickey|Permission denied, please try again|Too many authentication failures/i.test(e)) return what + '：SSH 密钥 GitLab 不认。这台电脑的公钥没登记到 GitLab，或者密钥带口令（后台没法输口令）';
  if (/Authentication failed|could not read (Username|Password)|unable to get password|terminal prompts disabled|HTTP Basic: Access denied|\b401\b/i.test(e)) return what + '：没登录，或者令牌不对';
  if (/Could not resolve host|unable to access|Failed to connect|Connection refused|timed out|Couldn't connect|Connection closed|Network is unreachable|No route to host/i.test(e)) return what + '：连不上 GitLab';
  if (/not found|does not exist|does not appear to be a git repository|\b403\b|The requested URL returned error: 404|Could not read from remote/i.test(e)) return what + '：找不到仓库，或者没有权限';
  return what + '：' + (e.split(/\r?\n/).filter(Boolean).pop() || '退出码 ' + r.code).slice(0, 200);
}

// ---------- 几条路 ----------
/** 拉仓库能走的几条路，按先后：手填的令牌 → SSH 密钥 → SSH 申请来的令牌 → 这台电脑上 git 自己登录的身份 */
function routes(s0) {
  const s = s0 || settings();
  const p = s.parsed;
  if (!p.ok) return [];
  if (p.local) return [{ name: 'local', url: p.git, label: '本机目录' }];
  if (p.ssh) return [{ name: 'ssh', url: p.git, label: 'SSH 密钥' }];
  const out = [];
  if (s.token && s.tokenSource !== 'ssh') out.push({ name: 'token', url: p.git, label: '令牌' });
  if (s.ssh.ok) out.push({ name: 'ssh', url: s.ssh.url, label: 'SSH 密钥' });
  if (s.token && s.tokenSource === 'ssh') out.push({ name: 'token', url: p.git, label: 'SSH 申请的令牌' });
  out.push({ name: 'login', url: p.git, label: '这台电脑上 git 登录的身份' });
  return out;
}
/** 上次走通的那条排最前面 */
function orderedRoutes(s) {
  const list = routes(s);
  const i = list.findIndex((r) => r.name === s.route);
  return i > 0 ? [list[i]].concat(list.slice(0, i), list.slice(i + 1)) : list;
}
/**
 * 挨个试几条路：run(route) 返回 git 的结果，第一条成功的记下来。都不行的话，返回最后一条的结果，tried 里是每条路为什么不行。
 * only：只试这一条（前一步已经走通过的）
 */
function viaRoutes(s, run, only) {
  const list = only ? orderedRoutes(s).filter((r) => r.name === (only.name || only)) : orderedRoutes(s);
  const tried = [];
  let last = null;
  for (const r of list) {
    const x = run(r);
    if (x.code === 0) { rememberRoute(s, r.name); return Object.assign(x, { route: r, tried }); }
    tried.push({ name: r.name, label: r.label, why: explainGit(x, r.label) });
    last = x;
    if (x.missing) break;
  }
  return Object.assign(last || { code: -1, out: '', err: s.parsed.ok ? '没有能走的路' : s.parsed.why, ms: 0 }, { tried });
}
/** 几条路都没走通时给人看的话 */
function explainRoutes(r, what) {
  if (r.missing) return what + '：这台电脑上找不到 git';
  if (!r.tried || !r.tried.length) return explainGit(r, what);
  if (r.tried.length === 1) return what + '没成功。' + r.tried[0].why;
  return what + '没成功，' + r.tried.length + ' 条路都试过了。' + r.tried.map((t) => t.why).join('；');
}

// ---------- SSH：问一声是谁、申请令牌 ----------
/** 借 git 来跑 ssh：和拉仓库用的是同一个 ssh（Git 自带的 ssh 不在系统的 PATH 里，直接叫 ssh 可能叫到别的、或者叫不到） */
function ssh(s, words, timeout) {
  const t = s.ssh;
  if (!t.ok) return { code: -1, out: '', err: t.why || '没有 SSH 地址', ms: 0 };
  const cmd = sshCommand();
  const port = t.port ? [/plink/i.test(cmd) ? '-P' : '-p', String(t.port)] : [];
  const t0 = Date.now();
  let r;
  try { r = spawnSync('git', ['-c', 'alias.vibe-kit-ssh=!' + cmd, 'vibe-kit-ssh', '-T'].concat(port, [t.user + '@' + t.host], words), { cwd: os.tmpdir(), env: quietEnv(), encoding: 'utf8', windowsHide: true, timeout: timeout || 40000, maxBuffer: 4 * 1024 * 1024 }); } catch (e) { return { code: -1, out: '', err: String((e && e.message) || e), ms: Date.now() - t0 }; }
  if (r.error) return { code: -1, out: '', err: r.error.code === 'ENOENT' ? '这台电脑上找不到 git' : String(r.error.message), ms: Date.now() - t0, missing: r.error.code === 'ENOENT' };
  return { code: r.status, out: String(r.stdout || ''), err: hide(r.stderr), ms: Date.now() - t0 };
}
/** SSH 通不通、GitLab 认出来的是谁（GitLab 会回一句 Welcome to GitLab, @账号!） */
function sshWho(s0) {
  const s = s0 || settings();
  const r = ssh(s, []);
  const m = /Welcome to GitLab,\s*@?([^\s!]+)/i.exec(r.out + '\n' + r.err);
  if (m) return { ok: true, user: m[1], ms: r.ms };
  if (r.code === 0) return { ok: true, user: '', ms: r.ms };
  return { ok: false, why: explainGit(r, 'SSH'), ms: r.ms };
}
const tokenName = () => 'vibe-kit-' + String(os.hostname()).replace(/[^\w.-]/g, '_').slice(0, 40);
/**
 * 拿 SSH 密钥向 GitLab 申请一个令牌（权限 api，30 天），存进 secrets.json。令牌本身不返回、不进日志。
 * 返回 { ok, masked, expires, why }
 */
function mintToken(s0) {
  const s = s0 || settings();
  if (!s.parsed.ok || !s.parsed.origin) return { ok: false, why: '仓库地址不是 http / https 的，议题的接口用不了' };
  if (!s.ssh.ok) return { ok: false, why: s.ssh.why || '没有 SSH 地址' };
  const r = ssh(s, ['personal_access_token', tokenName(), 'api', String(TOKEN_DAYS)]);
  const m = /^Token:\s+(\S+)/m.exec(r.out);
  if (r.code !== 0 || !m) {
    const said = hide(r.out + '\n' + r.err).split(/\r?\n/).map((l) => l.replace(/^remote:\s*/i, '').trim()).filter(Boolean);
    if (/Permission denied|Host key verification|Could not resolve|timed out|Connection refused|Connection closed/i.test(r.err)) return { ok: false, why: explainGit(r, '用 SSH 申请令牌') };
    return { ok: false, unsupported: true, why: '用 SSH 申请令牌：这个 GitLab 不支持，或者管理员关掉了（' + (said.pop() || '退出码 ' + r.code).slice(0, 160) + '）。要建议题，在配置页手填一个令牌' };
  }
  const exp = (/^Expires:\s+(\S+)/m.exec(r.out) || [])[1] || '';
  const sec = readJson(SECRETS_FILE);
  sec.gitlabToken = m[1];
  sec.gitlabTokenSource = 'ssh';
  sec.gitlabTokenAt = Date.now();
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) sec.gitlabTokenExpires = exp; else delete sec.gitlabTokenExpires;
  writeJson(SECRETS_FILE, sec);
  return { ok: true, masked: maskToken(m[1]), expires: /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : '' };
}
/** SSH 申请来的令牌不认了（401）：清掉，下次重新申请。手填的不动 */
function dropSshToken() {
  const sec = readJson(SECRETS_FILE);
  if (sec.gitlabTokenSource !== 'ssh') return false;
  delete sec.gitlabToken; delete sec.gitlabTokenSource; delete sec.gitlabTokenExpires; delete sec.gitlabTokenAt;
  writeJson(SECRETS_FILE, sec);
  return true;
}
const mayMint = (cfg) => !(cfg && cfg.sshToken === 'off');
/**
 * 议题的接口要用的设置：有令牌就用（SSH 申请来的快到期了先换一个）；没有令牌、开关允许，就用 SSH 申请一个。
 * 返回 settings()，多一个 minted（这次是不是新申请的）、tokenWhy（没拿到令牌的原因）
 */
function withToken(cfg, opt) {
  const o = opt || {};
  let s = settings();
  const expiring = s.token && s.tokenSource === 'ssh' && s.tokenExpires && Date.parse(s.tokenExpires + 'T00:00:00') - Date.now() < RENEW_BEFORE_MS;
  if (s.token && !expiring && !o.renew) return s;
  if (s.token && s.tokenSource !== 'ssh') return s;
  if (!mayMint(cfg)) return Object.assign(s, { tokenWhy: s.token ? '' : '还没填令牌（用 SSH 自动申请令牌的开关关着）' });
  if (!s.parsed.ok || !s.parsed.origin || !s.ssh.ok) return Object.assign(s, { tokenWhy: s.token ? '' : '还没填令牌' });
  const m = mintToken(s);
  if (!m.ok) return Object.assign(s, { tokenWhy: s.token ? '' : m.why, mintFailed: true });
  s = settings();
  return Object.assign(s, { minted: true });
}

const LEVELS = { 10: 'Guest', 15: 'Planner', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };
/**
 * 配置页"测试连接"：拉仓库的几条路哪条通、SSH 认出来的是谁、议题的接口能不能用。
 * 只看不动：不申请令牌、不拉文件（走通的是哪条路会记下来）
 */
async function diagnose(cfg) {
  const s = settings();
  const out = { repo: maskUrl(s.repo), problem: s.parsed.ok ? '' : s.parsed.why, hasGit: gitVersion() > 0, git: null, ssh: null, api: null };
  if (!s.parsed.ok) return out;
  if (!out.hasGit) out.git = { ok: false, why: '这台电脑上找不到 git', tried: [] };
  else {
    const r = viaRoutes(s, (route) => git(null, ['ls-remote', '--symref', route.url, 'HEAD'], { settings: s, route, timeout: 40000 }));
    out.git = r.code === 0
      ? { ok: true, route: r.route.name, label: r.route.label, ms: r.ms, empty: !/^[0-9a-f]{40}\s/m.test(r.out), branch: (/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(r.out) || [])[1] || '', tried: r.tried }
      : { ok: false, why: explainRoutes(r, '连仓库'), tried: r.tried };
    if (s.ssh.ok && !s.parsed.local) out.ssh = Object.assign(sshWho(s), { url: s.ssh.url, derived: !!s.ssh.derived });
  }
  if (!s.parsed.origin) { out.api = { ok: false, why: '仓库地址不是 http / https 的，议题的接口用不了' }; return out; }
  if (!s.token) {
    const canMint = mayMint(cfg) && !!(out.ssh && out.ssh.ok);
    out.api = { ok: false, noToken: true, canMint, why: canMint ? '还没有令牌。SSH 是通的：有问题要上报时会用 SSH 自动申请一个，也可以现在就点"用 SSH 申请令牌"' : '还没有令牌，议题建不了（问题照旧存在本机）。在上面填一个勾了 api 的令牌' };
    return out;
  }
  const api = await projectApi(s);
  if (!api.ok) { out.api = { ok: false, why: api.why, source: s.tokenSource, expires: s.tokenExpires }; return out; }
  let p = api.project;
  if (!p || !p.permissions) { const r = await request('GET', api.base, { token: s.token, verifyCert: s.verifyCert }); if (r.status === 200 && r.json) p = r.json; else if (r.status) { out.api = { ok: false, why: explain(r, '查项目'), source: s.tokenSource, expires: s.tokenExpires }; return out; } }
  const perm = (p && p.permissions) || {};
  const level = Math.max(Number(perm.project_access && perm.project_access.access_level) || 0, Number(perm.group_access && perm.group_access.access_level) || 0);
  const issuesOn = !(p && (p.issues_enabled === false || p.issues_access_level === 'disabled'));
  out.api = { ok: issuesOn, project: (p && p.path_with_namespace) || s.parsed.projectPath, level, levelName: LEVELS[level] || (level ? String(level) : '不是项目成员'), issuesOn, source: s.tokenSource, expires: s.tokenExpires,
    why: issuesOn ? '' : '这个项目关掉了议题功能（项目设置 → 通用 → 可见性、项目功能、权限 里打开 Issues）' };
  return out;
}

/**
 * 这台电脑是不是维护套件的那台（配置页上多出"导出 issue"）：本机的地址、电脑名里有没有下面列的。
 * 2026-10-01 起写死在这里，不再是配置页上的开关（用户定的：不要让别的电脑看到）。
 * VIBE_KIT_MAINTAINER_HOSTS 只给测试用（逗号分开）：测试机不是那台电脑，要测"导出 issue"得有办法装成它
 */
const MAINTAINER_HOSTS = ['32.1.4.4'];
function isMaintainer() {
  const test = String(process.env.VIBE_KIT_MAINTAINER_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const want = test.length ? test : MAINTAINER_HOSTS;
  const mine = [];
  try { const ifs = os.networkInterfaces(); for (const k of Object.keys(ifs)) for (const a of ifs[k] || []) if (a && a.address) mine.push(String(a.address)); } catch (e) { /* 查不了 */ }
  mine.push(String(os.hostname()).toLowerCase());
  return want.some((w) => mine.includes(w) || mine.includes(String(w).toLowerCase()));
}

module.exports = { DEFAULT_REPO, SETTINGS_FILE, SECRETS_FILE, TOKEN_DAYS, parseRepo, parseSsh, sshTarget, maskUrl, maskToken, settings, repoKey, publicSettings, saveSettings, request, explain, projectApi, git, gitVersion, sshCommand, explainGit, routes, orderedRoutes, viaRoutes, explainRoutes, ssh, sshWho, mintToken, dropSshToken, mayMint, withToken, tokenName, diagnose, isMaintainer };

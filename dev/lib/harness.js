'use strict';
/*
 * 测试用的公共部分。原则（都是吃过亏的）：
 *   - 不碰真实的用户目录：套件拷到临时目录里的假用户目录再跑，子进程的 HOME / USERPROFILE / CLAUDE_CONFIG_DIR 都指假的；
 *     结尾核对真实的 settings.json、CLAUDE.md 没变，也没多出 rules、vibe-kit 目录
 *   - 不在桌面留窗口：子进程一律 windowsHide，不用 detached
 *   - 用完的临时目录自己删掉
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SRC = path.join(REPO, 'vibe-kit');
const REAL_HOME = os.homedir();
// 真实的"启动"文件夹里路由的自启动脚本：测试里装了路由的话会写到这里（2026-09-28 出过事），所以一并盯着
const REAL_STARTUP_VBS = process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'vibe-kit-router.vbs') : path.join(REAL_HOME, '.no-startup');
// 用户自己装的旧技能（urai-db-crud、redis）：安装器会删改名之前的技能，测试里绝不能删到真的
const REAL = [path.join(REAL_HOME, '.claude', 'settings.json'), path.join(REAL_HOME, '.claude', 'CLAUDE.md'), path.join(REAL_HOME, '.claude.json'), REAL_STARTUP_VBS,
  path.join(REAL_HOME, '.claude', 'skills', 'urai-db-crud', 'SKILL.md'), path.join(REAL_HOME, '.claude', 'skills', 'urai-db-crud', 'scripts', 'db.py'), path.join(REAL_HOME, '.claude', 'skills', 'redis', 'SKILL.md')];
// ~/.db-crud：db-crud 的留痕和后台执行器的状态放在这里（2026-09-29 手工试的时候在真实目录下建出来过）
const REAL_ABSENT = [path.join(REAL_HOME, '.claude', 'rules'), path.join(REAL_HOME, '.claude', 'vibe-kit'), path.join(REAL_HOME, '.db-crud')];
const sha = (f) => { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return '(没有)'; } };
const realBefore = REAL.map(sha);
const absentBefore = REAL_ABSENT.map((p) => fs.existsSync(p));

let pass = 0;
let fail = 0;
const failed = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failed.push(name);
  console.log('  [X] ' + name + (detail !== undefined ? '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1500) : ''));
  return false;
}
function section(title) { console.log('— ' + title); }

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(e.name, path.join(src, e.name))) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, skip); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
const roots = [];
/**
 * 一个假的用户目录，里面放一份套件（不带看页面的 node_modules，钩子和工具用不着）。
 * from 不给就是现在的源码；给一个目录就拷那一份（新旧对比用）
 */
function makeHome(name, from, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkt-' + name + '-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cfg = path.join(home, '.claude');
  const kit = path.join(cfg, 'vibe-kit');
  const src = from || SRC;
  copyDir(path.join(src, 'kit'), kit, (n) => n === 'node_modules');
  for (const f of ['install.js', 'settings.fragment.json']) fs.copyFileSync(path.join(src, f), path.join(kit, f));
  fs.copyFileSync(path.join(src, 'claude', 'CLAUDE.md'), path.join(kit, 'CLAUDE.md'));
  copyDir(path.join(src, 'claude', 'rules'), path.join(kit, 'rules'));
  copyDir(path.join(src, 'claude'), path.join(kit, 'pristine'));
  copyDir(path.join(src, 'claude', 'skills'), path.join(cfg, 'skills'));
  copyDir(path.join(src, 'claude', 'agents'), path.join(cfg, 'agents'));
  // 技能、约定的修改时间统一拨到两天前：钩子会拿它和会话开始的时间比（"会话开始之后技能变了就提醒"），
  // 刚改过的源文件拷过来带着刚才的时间，会被当成会话中途变了
  const old = new Date(Date.now() - 2 * 86400000);
  const age = (p) => { let st; try { st = fs.statSync(p); } catch (e) { return; } if (st.isDirectory()) { for (const n of fs.readdirSync(p)) age(path.join(p, n)); } else { try { fs.utimesSync(p, old, old); } catch (e) { /* 拨不了就算了 */ } } };
  for (const p of [path.join(cfg, 'skills'), path.join(cfg, 'agents'), path.join(kit, 'CLAUDE.md'), path.join(kit, 'rules')]) age(p);
  fs.mkdirSync(path.join(kit, 'state'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'config.json'), JSON.stringify(Object.assign({ hookTransport: 'command', autoUpdate: 'off', issueUpload: 'off' }, config || {}), null, 2));
  // 封条：测试里要关禁改、开自动放行时才认
  fs.writeFileSync(path.join(kit, 'state', 'config-seal.json'), JSON.stringify({ kitLock: !(config && config.kitLock === false), kitBypass: (config && config.kitBypass) || 'ask', autoMode: !!(config && config.autoMode === true), at: Date.now() }));
  return { root, home, cfg, kit, work: path.join(root, 'work') };
}
function setConfig(h, patch) {
  const f = path.join(h.kit, 'config.json');
  const c = Object.assign(JSON.parse(fs.readFileSync(f, 'utf8')), patch);
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  fs.writeFileSync(path.join(h.kit, 'state', 'config-seal.json'), JSON.stringify({ kitLock: c.kitLock !== false, kitBypass: c.kitBypass || 'ask', autoMode: c.autoMode === true, at: Date.now() }));
}
function envFor(h, extra) {
  const env = {};
  for (const k of Object.keys(process.env)) { if (/^(CLAUDE|ANTHROPIC|VIBE_|PROBE_|FAKE_GITLAB_|GIT_SSH|GIT_CONFIG_)/i.test(k)) continue; env[k] = process.env[k]; }
  // VIBE_KIT_NO_UPDATE：钩子里不甩后台的更新进程（它会去连团队的 GitLab、留下一个没人等的进程）。测更新的那一套自己把它去掉
  // VIBE_KIT_NO_ONBOARD：钩子里不甩后台的自动探索（它会往测试的项目里写 .vibe/project.md，别的测试的输出就跟着变了）。测探索的那一套自己把它去掉
  // APPDATA、"启动"文件夹也指假的：路由的自启动脚本是往"启动"文件夹里写的
  const roaming = path.join(h.home, 'AppData', 'Roaming');
  const localApp = path.join(h.home, 'AppData', 'Local');
  const startup = path.join(h.home, 'Startup');
  for (const d of [roaming, localApp, startup]) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 建不了就算了 */ } }
  const out = Object.assign(env, { HOME: h.home, USERPROFILE: h.home, CLAUDE_CONFIG_DIR: h.cfg, APPDATA: roaming, LOCALAPPDATA: localApp, VIBE_KIT_STARTUP_DIR: startup, VIBE_KIT_NO_UPDATE: '1', VIBE_KIT_NO_ONBOARD: '1' }, extra || {});
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}
/** 一个会自己清掉的临时目录 */
function tempDir(name) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vkt-' + name + '-')); roots.push(d); return d; }
/** 一个空的假用户目录（套件用真的 install.js 装进去） */
function freshHome(name) {
  const root = tempDir(name);
  const home = path.join(root, 'home');
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  return { root, home, cfg, kit: path.join(cfg, 'vibe-kit'), work: path.join(root, 'work') };
}
/**
 * 一份安装包（从现在的源码拷，不带看页面的依赖，放几个占位的目录让安装器认）。version 给了就改成这个版本号、
 * 在《更新说明.md》最前面加一节；mutate(dir) 里可以再改文件
 */
function makePackage(name, version, mutate, notes) {
  const dir = path.join(tempDir(name), 'vibe-kit');
  copyDir(SRC, dir, (n) => n === 'node_modules' || n === '.git');
  for (const dep of ['pixelmatch', 'pngjs', 'playwright', 'playwright-core']) write(path.join(dir, 'kit', 'page', 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0-test' }) + '\n');
  if (version) {
    fs.writeFileSync(path.join(dir, 'kit', 'VERSION'), version + '\n');
    const f = path.join(dir, '更新说明.md');
    const t = fs.readFileSync(f, 'utf8');
    const at = t.search(/^## /m);
    fs.writeFileSync(f, (at < 0 ? t + '\n' : t.slice(0, at)) + '## ' + version + '（测试）\n\n' + (notes || '- 测试用的版本\n') + '\n' + (at < 0 ? '' : t.slice(at)));
  }
  if (mutate) mutate(dir);
  return dir;
}
/**
 * 查库的测试要用的运行环境：Python、Java、H2 的驱动。返回 { python, java, h2 }，没找到的那一项是 ''。
 * 以前是给一个放便携版的目录（python/python.exe、jdk/bin/java.exe、h2.jar），用完就删、下次再下。
 * 2026-09-30 起它们装在各自的正式位置（%LOCALAPPDATA%\Programs\Python、…\Eclipse Adoptium、~/.m2），
 * 给 auto 就到那些位置去找；给的是老式的目录、里面三样齐全的，照旧用它
 */
function runtime(arg) {
  const first = (list) => list.find((p) => p && fs.existsSync(p)) || '';
  const newest = (dir, re) => { try { return fs.readdirSync(dir).filter((n) => re.test(n)).sort().reverse().map((n) => path.join(dir, n)); } catch (e) { return []; } };
  const a = String(arg || '');
  if (a && a !== 'auto') {
    const d = path.resolve(a);
    const old = { python: path.join(d, 'python', 'python.exe'), java: path.join(d, 'jdk', 'bin', 'java.exe'), h2: path.join(d, 'h2.jar') };
    if (Object.keys(old).every((k) => fs.existsSync(old[k]))) return old;
  }
  const programs = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : path.join(REAL_HOME, 'AppData', 'Local', 'Programs');
  const python = first([process.env.VIBE_TEST_PYTHON].concat(newest(path.join(programs, 'Python'), /^Python3\d+$/i).map((d) => path.join(d, 'python.exe'))));
  const java = first([process.env.VIBE_TEST_JAVA, process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : '']
    .concat(newest(path.join(programs, 'Eclipse Adoptium'), /^jdk-/i).map((d) => path.join(d, 'bin', 'java.exe'))));
  const m2 = path.join(REAL_HOME, '.m2', 'repository', 'com', 'h2database', 'h2');
  const h2 = first([process.env.VIBE_TEST_H2].concat(newest(m2, /^\d/).map((d) => path.join(d, 'h2-' + path.basename(d) + '.jar'))));
  return { python, java, h2 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url) {
  return new Promise((resolve) => {
    const r = require('http').get(url, { timeout: 3000 }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, text: '' }));
  });
}
const children = [];
/**
 * 起一个假 GitLab（lib/fake-gitlab.js）：git 的 http 通道、议题的接口；配套一个假 ssh（lib/fake-ssh.js）。
 * 返回 { port, url（项目的 http 地址）, data, repos, bare, env（给子进程的环境变量：假 ssh、数据目录）, ... }
 */
async function fakeGitlab(name, port, project) {
  const root = tempDir(name);
  const data = path.join(root, 'data');
  const repos = path.join(root, 'repos');
  const proj = project || 'nb-2026/p1/vibe-kit';
  fs.mkdirSync(data, { recursive: true });
  const bare = path.join(repos, proj + '.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '--initial-branch=main']);
  git(bare, ['config', 'http.receivepack', 'true']);
  fs.writeFileSync(path.join(data, 'behavior.json'), JSON.stringify({ project: proj }));
  fs.writeFileSync(path.join(data, 'tokens.json'), '{}');
  fs.writeFileSync(path.join(data, 'ssh.json'), JSON.stringify({ mode: 'ok', pat: 'ok', user: 'tester' }));
  const child = require('child_process').spawn(process.execPath, [path.join(__dirname, 'fake-gitlab.js'), String(port), repos, data], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(150); up = (await httpGet('http://127.0.0.1:' + port + '/__ping')).status === 200; }
  const q = (p) => '"' + p.replace(/\\/g, '/') + '"';
  const lines = (f) => (read(path.join(data, f)) || '').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  const setJson = (f, patch) => fs.writeFileSync(path.join(data, f), JSON.stringify(Object.assign(JSON.parse(read(path.join(data, f)) || '{}'), patch)));
  return {
    up, log: () => log, port, root, data, repos, bare, project: proj, url: 'http://127.0.0.1:' + port + '/' + proj + '.git', sshUrl: 'git@127.0.0.1:' + proj + '.git',
    env: { FAKE_GITLAB_DATA: data, FAKE_GITLAB_REPOS: repos, GIT_SSH_COMMAND: q(process.execPath) + ' ' + q(path.join(__dirname, 'fake-ssh.js')) },
    requests: () => lines('requests.log'), sshCalls: () => lines('ssh-calls.log'),
    clearLogs: () => { for (const f of ['requests.log', 'ssh-calls.log']) { try { fs.unlinkSync(path.join(data, f)); } catch (e) { /* 还没有 */ } } },
    issues: () => JSON.parse(read(path.join(data, 'issues.json')) || '[]'),
    tokens: () => JSON.parse(read(path.join(data, 'tokens.json')) || '{}'),
    behave: (patch) => setJson('behavior.json', patch), ssh: (patch) => setJson('ssh.json', patch),
    addToken: (token, user, expires) => setJson('tokens.json', { [token]: { user: user || 'tester', expires: expires || '' } }),
    dropToken: (token) => { const all = JSON.parse(read(path.join(data, 'tokens.json')) || '{}'); delete all[token]; fs.writeFileSync(path.join(data, 'tokens.json'), JSON.stringify(all)); },
    stop: () => { try { child.kill(); } catch (e) { /* 已经退了 */ } },
  };
}
const SUSPECT = /^(node|git|git-remote-https?|ssh|sh|bash|cmd|conhost|openconsole|windowsterminal|powershell|pwsh|claude|wscript|cscript|mintty)$/i;
/**
 * 盯着桌面：测试跑的时候冒出来的窗口都记下来，一闪就关的也算。stop() 返回可疑的那些（控制台、终端、node、git、ssh 的窗口）。
 * 起不来（不是 Windows）就什么都不盯，stop() 返回空
 */
async function watchWindows(name) {
  if (process.platform !== 'win32') return { ready: false, stop: async () => [] };
  const dir = tempDir(name || 'win');
  const out = path.join(dir, 'windows.log');
  const stopFile = path.join(dir, 'stop');
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = require('child_process').spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'watch-windows.ps1'), '-Out', out, '-Stop', stopFile], { windowsHide: true, stdio: 'ignore' });
  children.push(child);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { await sleep(200); ready = /READY/.test(read(out) || ''); }
  return {
    ready,
    stop: async () => {
      fs.writeFileSync(stopFile, '');
      for (let i = 0; i < 50 && !/DONE/.test(read(out) || ''); i++) await sleep(100);
      try { child.kill(); } catch (e) { /* 已经退了 */ }
      return (read(out) || '').split(/\r?\n/).filter((l) => /^NEW\t/.test(l)).map((l) => { const p = l.split('\t'); return { process: p[1], pid: p[2], cls: p[3], title: p[4] || '' }; })
        .filter((w) => SUSPECT.test(w.process) || /ConsoleWindowClass|CASCADIA/i.test(w.cls));
    },
  };
}
function node(h, script, args, opts) {
  const o = opts || {};
  const r = spawnSync(process.execPath, [script].concat(args || []), { cwd: o.cwd || h.root, env: envFor(h, o.env), encoding: 'utf8', input: o.input, windowsHide: true, timeout: o.timeout || 60000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** 跑一个程序（python、java）：环境变量和 node() 一样指着假用户目录 */
function run(h, exe, args, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const r = spawnSync(exe, args || [], { cwd: o.cwd || h.root, env: envFor(h, o.env), encoding: 'utf8', input: o.input, windowsHide: true, timeout: o.timeout || 120000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), ms: Date.now() - t0 };
}
/** 跑一个钩子：输入是对象，输出解析成对象（没有输出返回 null） */
function hook(h, name, input) {
  const r = node(h, path.join(h.kit, 'hooks', name + '.js'), [], { input: JSON.stringify(input), cwd: input.cwd });
  const t = r.out.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return { raw: t, err: r.err }; }
}
const reasonOf = (o) => (o ? String(o.reason || (o.hookSpecificOutput && (o.hookSpecificOutput.permissionDecisionReason || o.hookSpecificOutput.additionalContext)) || o.raw || '') : '');
function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function makeRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  for (const [rel, text] of Object.entries(files || {})) write(path.join(dir, rel), text);
  if (files && Object.keys(files).length) { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'chore: 初始']); }
  return dir;
}
function write(f, text) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, 'utf8'); }
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };

// ---------- 会话记录 ----------
let seq = 0;
let clock = Date.now() - 3600000;
const stamp = () => new Date((clock += 1000)).toISOString();
const uid = () => 'u' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
const tr = {
  user: (text) => ({ type: 'user', uuid: uid(), timestamp: stamp(), message: { role: 'user', content: text } }),
  say: (text) => ({ type: 'assistant', uuid: uid(), timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  call: (name, input, id) => ({ type: 'assistant', uuid: uid(), timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
  result: (id, text, isError) => ({ type: 'user', uuid: uid(), timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text == null ? 'ok' : text, is_error: !!isError }] } }),
  /** 一次成功的工具调用：调用 + 结果 */
  ran: (name, input, text, isError) => { const id = 'toolu_' + (++seq); return [tr.call(name, input, id), tr.result(id, text, isError)]; },
};
function transcript(file, entries) { write(file, entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n'); return file; }

function cleanup() {
  for (const c of children.splice(0)) { try { c.kill(); } catch (e) { /* 已经退了 */ } }
  for (const r of roots.splice(0)) {
    // 刚结束的子进程可能还占着目录一小会儿：多试几次
    for (let i = 0; i < 5; i++) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* 再试 */ } if (!fs.existsSync(r)) break; try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); } catch (e) { break; } }
  }
}
// 只认测试自己会起的这几种程序。终端（bash、cmd、powershell）不算：有人正好在终端里敲着这个临时目录的名字，不能把他的终端结束掉
const LEFT_NAMES = /^(node|git|git-remote-https?|ssh|wscript|cscript|java|javaw|python|claude)(\.exe)?$/i;
/** 命令行里带着这次测试的临时目录、还在跑的进程（测试起的路由、后台更新进程没退干净）。names 是临时目录的名字 */
function leftovers(names) {
  if (process.platform !== 'win32' || !names.length) return [];
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 名字是 mkdtemp 起的（字母、数字、横线），直接拼进去没有引号的问题
    const safe = names.filter((n) => /^[\w-]+$/.test(n));
    if (!safe.length) return [];
    const cmd = "$names = @('" + safe.join("','") + "'); Get-CimInstance Win32_Process | Where-Object { $c = $_.CommandLine; $c -and ($names | Where-Object { $c.Contains($_) }) } | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.Name + [char]9 + $_.CommandLine }";
    const out = require('child_process').execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return out.split(/\r?\n/).filter(Boolean).map((l) => { const p = l.split('\t'); return { pid: Number(p[0]), name: p[1], cmd: String(p[2] || '').slice(0, 220) }; }).filter((x) => x.pid && x.pid !== process.pid && LEFT_NAMES.test(x.name || ''));
  } catch (e) { return []; }
}
function killTree(pid) { try { require('child_process').execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 20000 }); } catch (e) { /* 已经退了 */ } }
function done(title) {
  const keep = roots.slice();
  cleanup();
  // 先让刚结束的子进程退干净，再查有没有留下的
  const names = keep.map((r) => path.basename(r));
  let left = leftovers(names);
  for (let i = 0; i < 6 && left.length; i++) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } catch (e) { break; } left = leftovers(names); }
  ok('没有留下还在跑的进程', left.length === 0, left);
  if (left.length) { for (const p of left) killTree(p.pid); for (const r of keep) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* 留给下次 */ } } }
  const realAfter = REAL.map(sha);
  REAL.forEach((f, i) => ok('真实用户目录没被碰：' + f, realBefore[i] === realAfter[i]));
  REAL_ABSENT.forEach((p, i) => ok('真实用户目录里没多出：' + p, fs.existsSync(p) === absentBefore[i]));
  console.log((fail ? '[X] ' : '[OK] ') + (title || path.basename(process.argv[1])) + '：通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项：' + failed.join('；') : ''));
  process.exit(fail ? 1 : 0);
}
process.on('uncaughtException', (e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); cleanup(); process.exit(2); });

/**
 * 全自动模式只在走 OpenSpec 流程的会话里算数（kit/lib/session.js）：测全自动的行为时，先把这个会话记成"在流程里"。
 * changes 是这个会话在流程里动手做过的变更的目录（收工时只催这几个）；stage 见下面
 */
function inFlow(h, sid, changes, on, stage) {
  const f = path.join(h.kit, 'state', String(sid).replace(/[^\w.-]/g, '_').slice(0, 80) + '-flow.json');
  const norm = (p) => path.resolve(p).split(path.sep).join('/').toLowerCase();
  // stage：plan（写提案那一段，全自动不算数）/ apply（做任务那一段）；不给的按 apply 算（1008 之前的记录没有这一项，也按 apply 算）
  write(f, JSON.stringify({ on: on !== false, why: '测试', at: Date.now(), was: Date.now(), changes: (changes || []).map(norm), stage: stage || 'apply' }));
}

module.exports = { REPO, SRC, ok, section, makeHome, freshHome, tempDir, makePackage, runtime, inFlow, fakeGitlab, watchWindows, sleep, httpGet, setConfig, envFor, node, run, hook, reasonOf, git, makeRepo, write, read, copyDir, tr, transcript, cleanup, done };

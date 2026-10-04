'use strict';
/*
 * 端到端（0930）：真的 Claude Code + 按脚本回复的假模型，走一遍这一版新加的东西。
 *   套件用真的 install.js 装进假的用户目录：模型看到的技能是 ttls- 开头的六个，审查代理是 ttls-reviewer，没有旧名字
 *   没探索过的项目（壳子里套着一个后端）：会话一开始套件在后台探索，第一条消息就带上了项目说明；
 *     开发环境的数据库、redis 配好了，生产环境的没进来
 *   配置文件改了（redis 换了端口）：下一个会话一开口，探索结果已经跟着更新，模型收到"哪几处变了"
 *   模型照技能说的跑查库、查 redis 的脚本：没被"不许动套件"拦下，拿到了数据
 *   收工之后：工具的用量进了统计
 * 查库那几项要运行环境（python、java、H2）：第三个参数给 auto（到正式位置去找），或者一个放着便携版的目录；不给就不测。
 * 用法：node dev/e2e-0930.js <claude.exe 的路径> [标签] [auto 或运行环境的目录] [端口，默认 18765，连着用两个]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const H = require('./lib/harness');

const EXE = process.argv[2];
const LABEL = process.argv[3] || path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(EXE || ''))))));
// 运行环境：给 auto 就到正式位置去找（见 lib/harness.js 的 runtime），也可以给一个放着便携版的目录
const RT = process.argv[4] ? H.runtime(process.argv[4]) : { python: '', java: '', h2: '' };
const PORT = Number(process.argv[5]) || 18765;
if (!EXE || !fs.existsSync(EXE)) { console.log('用法：node dev/e2e-0930.js <claude.exe 的路径> [标签] [auto 或运行环境的目录] [端口]'); process.exit(2); }
const PY = RT.python;
const JDK = RT.java ? path.dirname(path.dirname(RT.java)) : '';
const H2 = RT.h2;
const HAS_RT = [PY, RT.java, H2].every((f) => f && fs.existsSync(f));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vke-'));
const home = path.join(root, 'home');
const cfg = path.join(home, '.claude');
const kit = path.join(cfg, 'vibe-kit');
const h = { root, home, cfg, kit };
fs.mkdirSync(cfg, { recursive: true });

const SECRET = 'Dev#口令-0930';
const PROD_SECRET = 'Prod#绝密-0930';
const devYml = (redisPort) => ['server:', '  port: 8081', 'spring:', '  datasource:', '    url: jdbc:mysql://127.0.0.1:3306/shop_dev?useSSL=false', '    username: shop', '    password: ' + SECRET, '  redis:', '    host: 127.0.0.1', '    port: ' + redisPort, '    password: ' + SECRET, '    database: 0', ''].join('\n');
const shell = H.makeRepo(path.join(root, 'w', 'shell'), { 'README.md': '# 壳子\n\n里面套着后端。\n', '.gitignore': 'backend/\n' });
const back = H.makeRepo(path.join(shell, 'backend'), {
  'pom.xml': '<project>\n  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>\n  <artifactId>shop</artifactId>\n  <properties><java.version>1.8</java.version></properties>\n</project>\n',
  'src/main/resources/application.yml': 'spring:\n  profiles:\n    active: dev\n',
  'src/main/resources/application-dev.yml': devYml(PORT),
  'src/main/resources/application-prod.yml': ['spring:', '  datasource:', '    url: jdbc:mysql://10.9.9.9:3306/shop', '    username: shop', '    password: ' + PROD_SECRET, '  redis:', '    host: 10.9.9.8', '    password: ' + PROD_SECRET, ''].join('\n'),
  'src/main/java/com/x/UserService.java': 'package com.x;\npublic class UserService {\n}\n',
});
const YML = path.join(back, 'src', 'main', 'resources', 'application-dev.yml');
const PM = path.join(back, '.vibe', 'project.md');
const INI = path.join(back, '.vibe', 'db-crud.ini');
const RJ = path.join(back, '.vibe', 'redis.json');
const DB_CMD = 'python "$HOME/.claude/skills/ttls-db-crud/scripts/db.py" --conn h2dev peek --table t_user --count';
const RD_CMD = 'node "$HOME/.claude/skills/ttls-redis/scripts/redis.js" --conn dev get user:1';

// ---------- 假模型 ----------
let requests = [];
const textsOf = (m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => (typeof c.text === 'string' ? c.text : c.type === 'tool_result' ? (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')) : '')));
const allText = (body) => (body.messages || []).flatMap(textsOf).join('\n');
const uses = (body) => (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use') : []));
const resultOf = (body, id) => { for (const m of body.messages || []) for (const c of (Array.isArray(m.content) ? m.content : [])) if (c.type === 'tool_result' && c.tool_use_id === id) return typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n'); return null; };
function sse(res, events) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n'); res.end(); }
function reply(body, res, block, stop) {
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage })); return; }
  const ev = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  if (block.type === 'text') { ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }); ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }); }
  else { ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }); ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }); }
  ev.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
  sse(res, ev);
}
const say = (body, res, text) => reply(body, res, { type: 'text', text }, 'end_turn');
let toolSeq = 0;
const tool = (body, res, name, input) => reply(body, res, { type: 'tool_use', id: 'toolu_e2e_' + (++toolSeq), name, input }, 'tool_use');
function answer(body, res) {
  const names = (body.tools || []).map((t) => t.name);
  if (!names.includes('Edit') || !names.includes('Bash')) return say(body, res, 'ok');
  const done = uses(body);
  const ran = (re) => done.some((u) => u.name === 'Bash' && re.test(String((u.input || {}).command || '')));
  const everything = allText(body);
  if (!/查一下用户表/.test(everything)) return say(body, res, '看过了，是一个 Spring Boot 的后端。');
  // 第二个会话：照技能说的查库、查缓存
  const skill = (body.tools || []).find((t) => t.name === 'Skill');
  const key = skill ? (Object.keys((skill.input_schema || {}).properties || {}).includes('skill') ? 'skill' : 'command') : '';
  const called = (n) => done.some((u) => u.name === 'Skill' && String((u.input || {})[key] || '') === n);
  if (HAS_RT) {
    if (skill && !called('ttls-db-crud')) return tool(body, res, 'Skill', { [key]: 'ttls-db-crud' });
    if (!ran(/ttls-db-crud\/scripts\/db\.py/)) return tool(body, res, 'Bash', { command: DB_CMD, description: '数用户表有几行' });
  }
  if (skill && !called('ttls-redis')) return tool(body, res, 'Skill', { [key]: 'ttls-redis' });
  if (!ran(/ttls-redis\/scripts\/redis\.js/)) return tool(body, res, 'Bash', { command: RD_CMD, description: '看缓存里的 user:1' });
  return say(body, res, '查完了。');
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 不是 JSON */ }
    requests.push({ url: req.url, method: req.method, body });
    if (req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url) && body) { try { return answer(body, res); } catch (e) { console.log('假模型出错：' + e.stack); } }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'e2e: not found' } }));
  });
});
/** Claude Code 的环境：指着假用户目录；后台自动探索开着（别的测试里是关的）；python 放进 PATH（模型敲的就是 python） */
function claudeEnv(port) {
  const env = H.envFor(h, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'e2e-token', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), VIBE_KIT_NO_ONBOARD: undefined });
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'JAVA_HOME', 'DBCRUD_JAVA']) delete env[k];
  if (HAS_RT) { const k = Object.keys(env).find((x) => /^path$/i.test(x)) || 'PATH'; env[k] = path.dirname(PY) + path.delimiter + (env[k] || ''); }
  fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  return env;
}
function runClaude(port, promptText) {
  return new Promise((resolve) => {
    requests = [];
    const t0 = Date.now();
    const p = spawn(EXE, ['-p', promptText, '--output-format', 'json'], { cwd: shell, env: claudeEnv(port), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let killed = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { killed = true; try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { try { p.kill(); } catch (e2) { /* 忽略 */ } } }, Number(process.env.E2E_TIMEOUT) || 300000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, killed, ms: Date.now() - t0, out, err, requests: requests.slice() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, killed, ms: Date.now() - t0, out, err: String(e), requests: requests.slice() }); });
  });
}
const mains = (run) => run.requests.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === 'Edit') && r.body.tools.some((t) => t.name === 'Bash'));
const seen = (run, re) => mains(run).some((r) => re.test(allText(r.body)));
const lastMain = (run) => (mains(run).length ? mains(run)[mains(run).length - 1].body : { messages: [], tools: [] });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await H.sleep(150); } return fn(); };

(async () => {
  console.log('===== 端到端（0930）：Claude Code ' + LABEL + (HAS_RT ? '' : '（没给运行环境，查库那几项不测）') + ' =====');
  const watch = await H.watchWindows('e2e-0930-win');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: root, timeout: 180000 });
  H.ok('套件装进了假的用户目录', inst.code === 0, inst.out + inst.err);
  H.setConfig(h, { autoCommit: 'off', autoUpdate: 'off', issueUpload: 'off' });
  if (HAS_RT) H.write(path.join(kit, 'local.json'), JSON.stringify({ jdks: [{ name: '17', path: JDK.replace(/\\/g, '/') }], defaultJdk: '17', mavens: [] }));
  const skillsDir = fs.readdirSync(path.join(cfg, 'skills')).sort();
  H.ok('装上的技能是 ttls- 开头的六个', JSON.stringify(skillsDir) === JSON.stringify(['ttls-cross-review', 'ttls-db-crud', 'ttls-handover', 'ttls-onboard', 'ttls-redis', 'ttls-see-page']), skillsDir);

  // 两个假 redis：配置文件里先写旧端口，后面改成新端口
  const servers = [];
  const startRedis = async (port) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-redis.js'), String(port), SECRET], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(c);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    for (let i = 0; i < 50 && !/READY/.test(out); i++) await H.sleep(100);
    return /READY/.test(out);
  };
  H.ok('两个假 redis 起来了', await startRedis(PORT) && await startRedis(PORT + 1));
  const RD = path.join(cfg, 'skills', 'ttls-redis', 'scripts', 'redis.js');
  const seed = (name, port, value) => { const d = path.join(root, 'seed', name); H.write(path.join(d, '.vibe', 'redis.json'), JSON.stringify({ connections: { dev: { host: '127.0.0.1', port, password: SECRET, db: 0 } } })); return H.node(h, RD, ['set', 'user:1', value], { cwd: d }); };
  const sa = seed('a', PORT, '旧端口的张三');
  const sb = seed('b', PORT + 1, '新端口的张三');
  H.ok('两个假 redis 里各放了一条数据', sa.code === 0 && sb.code === 0, sa.out + sa.err + sb.out + sb.err);

  // H2（MySQL 兼容模式）当真的数据库：建一张表、放三行
  const dataDir = path.join(root, 'h2');
  const jdbc = 'jdbc:h2:file:' + dataDir.replace(/\\/g, '/') + '/db;MODE=MySQL';
  const h2ini = ['[h2dev]', 'dialect = mysql', 'jdbc = ' + jdbc, 'user = sa', 'password =', 'driver_class = org.h2.Driver', 'driver_jar = ' + H2.replace(/\\/g, '/'), ''].join('\n');
  if (HAS_RT) {
    fs.mkdirSync(dataDir, { recursive: true });
    const sd = path.join(root, 'seed', 'db');
    H.write(path.join(sd, '.vibe', 'db-crud.ini'), h2ini);
    const DBPY = path.join(cfg, 'skills', 'ttls-db-crud', 'scripts', 'db.py');
    const db = (args) => H.run(h, PY, [DBPY].concat(args), { cwd: sd, env: { DBCRUD_DAEMON: '0' } });
    const both = (sql, n) => { const f = path.join(sd, '.vibe', 'tmp', 's' + n + '.sql'); H.write(f, sql); const a = db(['exec', '--sql-file', f]); const ack = (a.out.match(/--ack (\S+)/) || [])[1] || ''; return db(['exec', '--sql-file', f, '--ack', ack]); };
    const c1 = both('CREATE TABLE T_USER (ID INT PRIMARY KEY, NAME VARCHAR(50))', 1);
    const c2 = both("INSERT INTO T_USER VALUES (1, '张三'), (2, '李四'), (3, '王五')", 2);
    H.ok('H2 里建了表、放了三行', c1.code === 0 && c2.code === 0 && /影响 3 行/.test(c2.out), c1.out + c1.err + c2.out + c2.err);
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const show = (r) => console.log('    退出码 ' + r.code + (r.killed ? '（超时被结束）' : '') + '，' + r.ms + ' ms，主会话 ' + mains(r).length + ' 个请求；用过的工具：' + uses(lastMain(r)).map((u) => u.name + (u.name === 'Bash' ? '(' + String(u.input.command).slice(0, 40) + ')' : u.name === 'Skill' ? '(' + JSON.stringify(u.input) + ')' : '')).join(' ｜ '));

  // ---------- 第一个会话：没探索过的项目 ----------
  const r1 = await runClaude(port, '这个项目是做什么的');
  show(r1);
  H.ok('第一个会话跑完了，没有挂住', r1.code === 0 && !r1.killed, r1.err.slice(-600));

  H.section('模型看到的技能和代理');
  const first = mains(r1)[0] ? mains(r1)[0].body : { tools: [], messages: [] };
  const whole = JSON.stringify(first);
  if (process.env.E2E_DUMP === '1') { for (const m of whole.match(/[^\\"]{0,80}ttls-[a-z-]+[^\\"]{0,80}/g) || []) console.log('      ' + m.replace(/\s+/g, ' ').slice(0, 200)); }
  for (const n of ['ttls-onboard', 'ttls-see-page', 'ttls-cross-review', 'ttls-handover', 'ttls-db-crud', 'ttls-redis']) H.ok('技能清单里有 ' + n, new RegExp('(^|[^\\w-])' + n + '\\b').test(whole), '');
  H.ok('技能清单里没有旧名字', !/urai-db-crud/.test(whole) && !/(\\n|^)- (onboard|see-page|cross-review|handover|db-crud|redis):/.test(whole), (whole.match(/(\\n|^)- (onboard|see-page|cross-review|handover|db-crud|redis):[^\\]{0,80}/g) || []).join(' ｜ '));
  H.ok('审查代理是 ttls-reviewer，没有 vibe-reviewer', /ttls-reviewer/.test(whole) && !/vibe-reviewer/.test(whole));

  H.section('没探索过的项目：后台探索，第一条消息就带上');
  H.ok('探索好了', await waitFor(() => fs.existsSync(path.join(back, '.vibe', 'onboard.json')) && !fs.existsSync(path.join(back, '.vibe', 'onboard.lock')), 30000), H.read(path.join(kit, 'state', 'onboard.log')));
  H.ok('会话开始时说了"正在后台自动探索"，不用自己跑 /ttls-onboard', seen(r1, /套件正在后台自动探索/) && seen(r1, /不用自己跑 \/ttls-onboard/), allText(first).slice(0, 1500));
  H.ok('第一条消息带上了探索好的项目说明', seen(r1, /这个项目后台自动探索好了，项目说明在 [^\n]*backend[\\/]+\.vibe[\\/]+project\.md/) && seen(r1, /- 类型：代码工程。Maven[^\n]*Spring Boot 2\.7\.18/), allText(first).slice(0, 3000));
  const pm = H.read(PM) || '';
  H.ok('项目说明里有数据库、redis 两行，连接名照着写', /- 数据库：连接 shop_dev（MySQL，jdbc:mysql:\/\/127\.0\.0\.1:3306\/shop_dev/.test(pm) && new RegExp('- redis：连接 dev（127\\.0\\.0\\.1:' + PORT + '，库 0').test(pm) && /测试、生产环境的连接没有配进来/.test(pm), pm);
  const ini = H.read(INI) || '';
  const rj = readJson(RJ) || {};
  H.ok('连接配置：只有开发环境的', /\[shop_dev\]\ndialect = mysql/.test(ini) && (ini.match(/^\[/gm) || []).length === 1 && Object.keys(rj.connections || {}).join() === 'dev' && rj.connections.dev.port === PORT, [ini, rj]);
  H.ok('生产环境的地址和口令哪都没进', ![pm, ini, JSON.stringify(rj), H.read(path.join(kit, 'state', 'onboard.log')) || ''].some((t) => t.includes(PROD_SECRET) || t.includes('10.9.9.9') || t.includes('10.9.9.8')));
  H.ok('开发环境的口令没有发给模型', !r1.requests.some((r) => JSON.stringify(r.body || '').includes(SECRET)));
  H.ok('壳子里没有建 .vibe/project.md', !fs.existsSync(path.join(shell, '.vibe', 'project.md')));
  H.ok('.vibe 进了后端的 .gitignore', /^\.vibe\/$/m.test(H.read(path.join(back, '.gitignore')) || ''), H.read(path.join(back, '.gitignore')));

  // ---------- 两个会话之间：用户手加了一个连接；项目的配置文件改了（redis 换了端口） ----------
  if (HAS_RT) fs.appendFileSync(INI, '\n' + h2ini);
  await H.sleep(3300);
  fs.writeFileSync(YML, devYml(PORT + 1));

  // ---------- 第二个会话：查库、查缓存 ----------
  const r2 = await runClaude(port, '查一下用户表有几个人，再看看缓存里 user:1 是什么');
  show(r2);
  H.ok('第二个会话跑完了，没有挂住', r2.code === 0 && !r2.killed, r2.err.slice(-600));
  const body2 = lastMain(r2);
  const done2 = uses(body2);

  H.section('配置文件改了：探索结果跟着改，一开口就告诉模型');
  const rj2 = readJson(RJ) || {};
  H.ok('redis 的连接跟着换成了新端口', await waitFor(() => ((readJson(RJ) || {}).connections || { dev: {} }).dev.port === PORT + 1, 15000), rj2);
  H.ok('项目说明里 redis 那一行也换了', new RegExp('- redis：连接 dev（127\\.0\\.0\\.1:' + (PORT + 1) + '，').test(H.read(PM) || ''), H.read(PM));
  H.ok('会话开始时带的是项目说明的位置，不是整份', seen(r2, /下面这些目录各有项目说明/) && !seen(r2, /这个项目后台自动探索好了/), allText(body2).slice(0, 2000));
  H.ok('一开口就告诉模型哪几处变了', seen(r2, /项目依据的文件改了，后台重新探索过（backend）/) && seen(r2, /redis 连接 dev 跟着项目的配置更新了/), allText(body2).slice(0, 3000));
  if (HAS_RT) H.ok('用户手加的连接没被动', /\[h2dev\]\ndialect = mysql\njdbc = jdbc:h2:file:/.test(H.read(INI) || '') && /\[shop_dev\]/.test(H.read(INI) || ''), H.read(INI));

  H.section('模型照技能说的查库、查缓存');
  const skillOffered = (body2.tools || []).some((t) => t.name === 'Skill');
  if (skillOffered) {
    H.ok('技能叫得起来：ttls-redis 的说明进了对话', /# redis|ttls-redis\/scripts\/redis\.js/.test(allText(body2)) && done2.some((u) => u.name === 'Skill'), allText(body2).slice(-1500));
    if (HAS_RT) H.ok('技能叫得起来：ttls-db-crud 的说明进了对话', /# 数据库读写/.test(allText(body2)), allText(body2).slice(-1500));
  } else console.log('    这个版本用 -p 跑的时候不给 Skill 工具，叫技能的两项不测');
  const rdUse = done2.find((u) => u.name === 'Bash' && /redis\.js/.test(String(u.input.command)));
  const rdOut = rdUse ? String(resultOf(body2, rdUse.id) || '') : '';
  H.ok('查缓存：没被"不许动套件"拦下', !!rdUse && !/\[vibe-kit\]/.test(rdOut), rdOut);
  H.ok('查缓存：连的是新端口，拿到了数据', /新端口的张三/.test(rdOut) && !/旧端口/.test(rdOut), rdOut);
  H.ok('查缓存：结果里没有口令', !rdOut.includes(SECRET), rdOut);
  if (HAS_RT) {
    const dbUse = done2.find((u) => u.name === 'Bash' && /db\.py/.test(String(u.input.command)));
    const dbOut = dbUse ? String(resultOf(body2, dbUse.id) || '') : '';
    H.ok('查库：没被"不许动套件"拦下', !!dbUse && !/\[vibe-kit\]/.test(dbOut), dbOut);
    H.ok('查库：小写的表名自己试出了大写，数出 3 行', /^3\s*$/m.test(dbOut), dbOut);
    H.ok('查库：java 用的是配置页"本机环境"里配的那个', !/找不到 java/.test(dbOut), dbOut);
  }
  H.ok('口令没有发给模型', !r2.requests.some((r) => JSON.stringify(r.body || '').includes(SECRET)));

  H.section('工具的用量');
  const usage = (H.read(path.join(kit, 'state', 'tool-usage.jsonl')) || '').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } });
  H.ok('查缓存那一次记下了', usage.some((u) => u.tool === 'ttls-redis' && u.cmd === 'get' && u.exit === 0), usage.slice(-4));
  if (HAS_RT) H.ok('查库那一次记下了，起了一次 java', usage.some((u) => u.tool === 'ttls-db-crud' && u.cmd === 'peek' && u.exit === 0 && u.java === 1), usage.slice(-4));
  const stats = readJson(path.join(kit, 'state', 'tool-stats.json')) || {};
  H.ok('收工时并进了统计', JSON.stringify(stats).includes('ttls-redis'), stats);
  H.ok('用量里没有表名、key、地址、口令', !/t_user|T_USER|user:1|127\.0\.0\.1/.test(JSON.stringify(usage) + JSON.stringify(stats)) && !(JSON.stringify(usage) + JSON.stringify(stats)).includes(SECRET), usage.slice(-4));
  const fb = fs.existsSync(path.join(kit, 'feedback')) ? fs.readdirSync(path.join(kit, 'feedback')).filter((n) => /^F\d{8}-/.test(n)) : [];
  H.ok('整个过程没有记出套件的问题', fb.length === 0, fb.map((n) => n + '\n' + (H.read(path.join(kit, 'feedback', n)) || '').slice(0, 600)).join('\n----\n'));

  server.close();
  for (const c of servers) { try { c.kill(); } catch (e) { /* 已经退了 */ } }
  await H.sleep(800);
  let left = '';
  try { left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + path.basename(root) + "*' -and $_.ProcessId -ne " + process.pid + " -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }"], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim(); } catch (e) { left = ''; }
  H.ok('没有留下进程', left === '', left);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 再试 */ } if (!fs.existsSync(root)) break; await H.sleep(500); }
  if (fs.existsSync(root)) console.log('    临时目录没删干净：' + root);
  H.done('端到端（0930）' + LABEL);
})().catch((e) => { console.log('端到端脚本出错：' + ((e && e.stack) || e)); try { server.close(); } catch (e2) { /* 忽略 */ } process.exit(2); });

'use strict';
/*
 * 端到端（0929）：真的 Claude Code + 按脚本回复的假模型，全自动模式走一遍。
 *   想用提问框问 → 被拦下，问题记进报告
 *   打勾被拦（验法里的场景没跑）→ 自己申请放行 → 中间内容变了再打勾，照样放行
 *   审查报了问题、改了；下一个会话里复审，工具调用的 id 和上一个会话那次一样（内网的网关就是这样）→ 照样计成第 2 轮，归档不被拦
 *   收工 → 套件交报告 → 它照着交代 → 它的交代接在报告后面
 * 同一个对话里 Claude Code 自己不认重复的 id（第二次调用会被它换成"Tool use interrupted"），所以重复只会出现在两个会话之间。
 * 套件用真的 install.js 装进假的用户目录（--no-router，钩子走命令方式）。
 * 用法：node dev/e2e-auto-0929.js <claude.exe 的路径> [标签]
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
if (!EXE || !fs.existsSync(EXE)) { console.log('用法：node dev/e2e-auto-0929.js <claude.exe 的路径> [标签]'); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vke-'));
const home = path.join(root, 'home');
const cfg = path.join(home, '.claude');
const kit = path.join(cfg, 'vibe-kit');
const h = { root, home, cfg, kit };
fs.mkdirSync(cfg, { recursive: true });
const proj = H.makeRepo(path.join(root, 'w', 'proj'), {
  'pom.xml': '<project/>\n',
  'src/main/java/com/x/OrderService.java': 'package com.x;\npublic class OrderService {\n  // FILE-ORDER-SERVICE\n}\n',
  '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：node -e "console.log(1)"\n- 看页面：不适用\n',
  'openspec/changes/a1/proposal.md': '## Why\n\n要导出。\n',
  'openspec/changes/a1/tasks.md': '- [x] 1.0 改 pom.xml；验：人工看\n- [ ] 1.1 审核接口角色：src/main/java/com/x/OrderService.java；验：快检；对照场景 `role_compare.json`\n',
});
const JAVA = path.join(proj, 'src', 'main', 'java', 'com', 'x', 'OrderService.java');
const TASKS = path.join(proj, 'openspec', 'changes', 'a1', 'tasks.md');
const FEEDBACK = path.join(kit, 'tools', 'feedback.js').replace(/\\/g, '/');
const FINAL = '## 做了什么\na1 的 1.1 做完了，代码审过一轮、改了。\n## 留给你做的\n没有。\n## 库里改过的\n没有。\n## 自己定的事\n导出的文件名按带日期的做。\n## 没验证的\n1.1 的对照场景没跑：要先改库。\n## 放行的检查\n打勾检查一次。\n## 套件问题\n没有。';

// ---------- 假模型 ----------
let requests = [];
const textsOf = (m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => (typeof c.text === 'string' ? c.text : c.type === 'tool_result' ? (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')) : '')));
const allText = (body) => (body.messages || []).flatMap(textsOf).join('\n');
const uses = (body) => (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use') : []));
const afterLastAssistant = (body) => { const ms = body.messages || []; let i = ms.length - 1; while (i >= 0 && ms[i].role !== 'assistant') i--; return ms.slice(i + 1).flatMap(textsOf).join('\n'); };
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
const tool = (body, res, name, input, id) => reply(body, res, { type: 'tool_use', id: id || 'toolu_e2e_' + (++toolSeq), name, input }, 'tool_use');
// 内网的网关给的就是这种 id，两个会话里会重复
const DUP = 'chatcmpl-tool-b9a8989979ffa5ac';
let reviewCalls = 0;
function answer(body, res) {
  const names = (body.tools || []).map((t) => t.name);
  const sys = Array.isArray(body.system) ? body.system.map((s) => s.text || '').join('\n') : String(body.system || '');
  // 审查代理：第一次报 1 条，之后报 0 条
  if (/你是审查者/.test(sys)) return say(body, res, ++reviewCalls === 1 ? '- 位置：src/main/java/com/x/OrderService.java:3\n- 问题：角色写死了\n- 什么情况下会出错：换了角色名就进不去\n- 严重程度：会出错\n- 类别：边界\n\n结论：问题 1 条（会出错 1，有隐患 0，建议 0）' : '上一轮的问题改对了，没有新问题。\n\n结论：问题 0 条');
  if (!names.includes('Edit') || !names.includes('Bash')) return say(body, res, 'ok');
  const done = uses(body);
  const ran = (re) => done.some((u) => u.name === 'Bash' && re.test(String((u.input || {}).command || '')));
  const edits = (f) => done.filter((u) => u.name === 'Edit' && path.resolve(String((u.input || {}).file_path || '')).toLowerCase() === path.resolve(f).toLowerCase());
  const read = (f) => done.some((u) => u.name === 'Read' && path.resolve(String((u.input || {}).file_path || '')).toLowerCase() === path.resolve(f).toLowerCase());
  const everything = allText(body);
  const last = afterLastAssistant(body);
  const agent = (body.tools || []).find((t) => t.name === 'Agent' || t.name === 'Task');
  const props = Object.keys(((agent || {}).input_schema || {}).properties || {});
  const reviews = done.filter((u) => u.name === 'Agent' || u.name === 'Task');
  const reviewOf = (mode) => { const input = { description: '审查代码', subagent_type: 'ttls-reviewer', prompt: '模式：' + mode + '\n变更：openspec/changes/a1/\n改了 src/main/java/com/x/OrderService.java，仓库在 ' + proj }; if (props.includes('run_in_background')) input.run_in_background = false; return input; };
  const finish = () => {
    if (/\[vibe-kit 全自动报告\]/.test(everything)) return say(body, res, FINAL);
    if (/\[vibe-kit 收工检查\]/.test(last)) return say(body, res, '复审留到下一个会话做，这个会话先收工。没验证：1.1 的对照场景要先改库。');
    return say(body, res, '做完了。');
  };
  // ---------- 第二个会话：复审（用的是和上一个会话那次审查一样的 id），然后归档 ----------
  if (/接着做：复审/.test(everything)) {
    if (agent && reviews.length === 0) return tool(body, res, agent.name, reviewOf('复审代码'), DUP);
    if (!ran(/git mv openspec\/changes\/a1 /)) return tool(body, res, 'Bash', { command: 'mkdir -p openspec/changes/archive && git mv openspec/changes/a1 openspec/changes/archive/2026-09-29-a1', description: '归档 a1' });
    return finish();
  }
  // ---------- 第一个会话 ----------
  // 1. 想问一句
  if (names.includes('AskUserQuestion') && !done.some((u) => u.name === 'AskUserQuestion')) return tool(body, res, 'AskUserQuestion', { questions: [{ question: '导出的文件名用哪种格式？', header: '文件名', multiSelect: false, options: [{ label: '带日期', description: '文件名里带导出的日期' }, { label: '不带日期', description: '固定的文件名' }] }] });
  // 2. 改代码、验
  if (!read(JAVA)) return tool(body, res, 'Read', { file_path: JAVA });
  if (!edits(JAVA).length) return tool(body, res, 'Edit', { file_path: JAVA, old_string: '  // FILE-ORDER-SERVICE', new_string: '  // FILE-ORDER-SERVICE\n  // 角色改成 aqbmy' });
  if (!ran(/console\.log\('verify ok'\)/)) return tool(body, res, 'Bash', { command: 'node -e "console.log(\'verify ok\')"', description: '快检' });
  // 3. 打勾：被拦 → 申请放行 → 换个写法再打
  if (!read(TASKS)) return tool(body, res, 'Read', { file_path: TASKS });
  if (!edits(TASKS).length) return tool(body, res, 'Edit', { file_path: TASKS, old_string: '- [ ] 1.1', new_string: '- [x] 1.1' });
  const id = (everything.match(/拦截编号 ([A-Z0-9]{4})/) || [])[1];
  if (id && !ran(/feedback\.js" bypass/)) return tool(body, res, 'Bash', { command: 'node "' + FEEDBACK + '" bypass ' + id + ' --why "对照场景要先执行备号脚本，改库不可逆要用户确认；快检刚跑过，输出 verify ok"', description: '申请放行' });
  if (ran(/feedback\.js" bypass/) && edits(TASKS).length < 2) return tool(body, res, 'Edit', { file_path: TASKS, old_string: '- [ ] 1.1 审核接口角色', new_string: '- [x] 1.1 审核接口角色' });
  // 4. 审代码（报 1 条）→ 改 → 验
  if (agent && reviews.length === 0) return tool(body, res, agent.name, reviewOf('代码'), DUP);
  if (edits(JAVA).length < 2) return tool(body, res, 'Edit', { file_path: JAVA, old_string: '  // 角色改成 aqbmy', new_string: '  // 角色改成 aqbmy，名字从配置里读' });
  if (!ran(/console\.log\('verify again'\)/)) return tool(body, res, 'Bash', { command: 'node -e "console.log(\'verify again\')"', description: '快检' });
  return finish();
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
function runClaude(port, promptText) {
  return new Promise((resolve) => {
    requests = [];
    const env = H.envFor(h, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'e2e-token', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
    fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
    const t0 = Date.now();
    const p = spawn(EXE, ['-p', promptText, '--output-format', 'json'], { cwd: proj, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let killed = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { killed = true; try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { try { p.kill(); } catch (e2) { /* 忽略 */ } } }, Number(process.env.E2E_TIMEOUT) || 300000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, killed, ms: Date.now() - t0, out, err, requests: requests.slice() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, killed, ms: Date.now() - t0, out, err: String(e), requests: requests.slice() }); });
  });
}
const isReviewer = (r) => /你是审查者/.test(JSON.stringify((r.body && r.body.system) || ''));
const mains = (run) => run.requests.filter((r) => r.body && !isReviewer(r) && Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === 'Edit') && r.body.tools.some((t) => t.name === 'Bash'));
const seen = (run, re) => mains(run).some((r) => re.test(allText(r.body)));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  console.log('===== 端到端（全自动）：Claude Code ' + LABEL + ' =====');
  const watch = await H.watchWindows('e2e-auto-win');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: root, timeout: 180000 });
  H.ok('套件装进了假的用户目录', inst.code === 0, inst.out + inst.err);
  H.setConfig(h, { autoMode: true, reviewLoop: true, reviewMaxRounds: 3, autoCommit: 'off', lessons: 'off', vibeTidy: false, autoUpdate: 'off', issueUpload: 'off' });
  const sync = H.node(h, path.join(kit, 'install.js'), ['--sync'], { cwd: root, timeout: 180000 });
  const md = H.read(path.join(cfg, 'CLAUDE.md')) || '';
  H.ok('全局约定里有全自动模式那一节，最前面说了以它为准', sync.code === 0 && /### 全自动模式（已开）/.test(md) && /> 全自动模式开着：走 OpenSpec 流程的时候/.test(md) && /别的时候我在，照常来/.test(md) && /以这一节为准/.test(md), sync.out + sync.err);
  const st = JSON.parse(H.read(path.join(cfg, 'settings.json')));
  H.ok('环境变量里关掉了 OpenSpec 的遥测和更新检查', st.env && st.env.OPENSPEC_TELEMETRY === '0' && st.env.OPENSPEC_NO_UPDATE_CHECK === '1', st.env);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const S = require(path.join(kit, 'lib', 'session.js'));
  const a1 = path.join(proj, 'openspec', 'changes', 'a1');
  const keyA = S.normKey(a1);
  const fbCount = () => { try { return fs.readdirSync(path.join(kit, 'feedback')).filter((n) => /^F\d{8}-/.test(n)).length; } catch (e) { return 0; } };
  const n0 = fbCount();

  const rounds = () => (readJson(path.join(kit, 'state', 'review-rounds.json'))['code|' + keyA] || {});
  const reports = () => { const d = path.join(proj, '.vibe', 'reports'); return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => /^全自动报告-\d{8}-\d{6}\.md$/.test(n)).sort().map((n) => path.join(d, n)) : []; };
  const cmdsOf = (r) => (mains(r).length ? uses(mains(r)[mains(r).length - 1].body).filter((u) => u.name === 'Bash').map((u) => String(u.input.command)) : []);
  const show = (r) => console.log('    退出码 ' + r.code + (r.killed ? '（超时被结束）' : '') + '，' + r.ms + ' ms，主会话 ' + mains(r).length + ' 个请求；跑过的命令：' + cmdsOf(r).map((c) => c.slice(0, 50)).join(' ｜ '));
  const dump = (r) => {
    if (process.env.E2E_DUMP !== '1' || !mains(r).length) return;
    const ms = mains(r)[mains(r).length - 1].body.messages || [];
    const blocks = ms.flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []).map((c) => ({ role: m.role, c })));
    for (const { role, c } of blocks.slice(-24)) console.log('      ' + role + ' ' + c.type + ' ' + String(c.name || '') + ' ' + String(c.id || c.tool_use_id || '') + ' ' + String(c.text || (c.input && JSON.stringify(c.input)) || (typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '')) || '').replace(/\s+/g, ' ').slice(0, 220));
  };

  const r = await runClaude(port, '把变更 a1 的 1.1 做完，审一下代码，有问题就改');
  show(r); dump(r);
  const cmds = cmdsOf(r);
  H.ok('第一个会话跑完了，没有挂住', r.code === 0 && !r.killed, r.err.slice(-600));

  H.section('提问框');
  // 有的版本用 -p 跑的时候不给模型提问框这个工具（2.1.259 就是）：那就没得问，这两项不测
  const askOffered = mains(r).some((x) => x.body.tools.some((t) => t.name === 'AskUserQuestion'));
  if (askOffered) H.ok('想用提问框问：被拦下，没有挂着等人', seen(r, /你想问的已经记进全自动报告/), r.out.slice(-400));
  else console.log('    这个版本用 -p 跑的时候不给提问框工具，提问框的两项不测');

  H.section('打勾：被拦 → 申请放行 → 内容变了再打，照样放行');
  H.ok('第一次打勾被拦，提示里有拦截编号和申请放行的命令', seen(r, /打勾之前先验证/) && seen(r, /拦截编号 [A-Z0-9]{4}。全自动模式：照提示能改的先改/), cmds);
  H.ok('它申请了放行，当场放行', cmds.some((c) => /feedback\.js" bypass/.test(c)) && seen(r, /放行申请登记好了/) && seen(r, /会直接放行/), cmds);
  H.ok('勾打上了', /- \[x\] 1\.1 审核接口角色/.test(H.read(TASKS) || ''), H.read(TASKS));
  H.ok('没有记成套件的问题', fbCount() === n0, fs.existsSync(path.join(kit, 'feedback')) ? fs.readdirSync(path.join(kit, 'feedback')) : []);

  H.section('审查报了 1 条，改了');
  const r1 = rounds();
  H.ok('审查代理真的跑了', r.requests.some((x) => isReviewer(x)));
  H.ok('记成第 1 轮，1 条问题，还没审完', r1.rounds === 1 && r1.issues === 1 && !r1.done && Array.isArray(r1.seen) && r1.seen.length === 1 && r1.seen[0].endsWith(':' + DUP), r1);

  H.section('收工：交报告');
  H.ok('收工时套件交了报告', seen(r, /\[vibe-kit 全自动报告\] 这一轮的情况套件记下来了/));
  const body = reports().length ? fs.readFileSync(reports()[reports().length - 1], 'utf8') : '';
  H.ok('报告文件在项目的 .vibe/reports 里', reports().length === 1, reports());
  if (askOffered) H.ok('报告里有它想问的问题和选项', /导出的文件名用哪种格式？（选项：带日期 \/ 不带日期）/.test(body), body);
  H.ok('报告里有放行的那一次和理由', /## 放行的检查\n\n- \d\d:\d\d OpenSpec 产物的门槛：Edit：/.test(body) && /改库不可逆要用户确认/.test(body), body);
  H.ok('报告里说了 a1 做到哪：审了一轮、还没复审', /- a1：任务 2\/2，代码审了 1 轮，上一轮报了 1 条，还没复审/.test(body), body);
  H.ok('以前打的勾（验法是人工看的）不重复列进"没验证的"', !/要你看一眼（a1）：1\.0/.test(body), body);
  H.ok('它最后的交代接在报告后面', body.includes('## AI 最后的交代\n\n## 做了什么\na1 的 1.1 做完了'), body.slice(-500));
  let result = null;
  try { result = JSON.parse(r.out.trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { result = null; }
  H.ok('它最后说的就是那七节', result && /## 留给你做的/.test(String(result.result || '')) && /## 库里改过的/.test(String(result.result || '')) && /## 放行的检查/.test(String(result.result || '')), r.out.slice(-600));
  H.ok('.vibe 在 .gitignore 里，报告不会被提交', /^\.vibe\/?$/m.test(H.read(path.join(proj, '.gitignore')) || ''), H.read(path.join(proj, '.gitignore')));

  H.section('下一个会话：复审用的调用 id 和上一个会话那次一样（F20260929-006 / -016）');
  await H.sleep(1500);
  const r2 = await runClaude(port, '接着做：复审 a1 的代码，没问题就归档');
  show(r2); dump(r2);
  H.ok('第二个会话跑完了', r2.code === 0 && !r2.killed, r2.err.slice(-600));
  const r2s = rounds();
  H.ok('复审计成了第 2 轮，0 条，审完了', r2s.rounds === 2 && r2s.issues === 0 && r2s.done === true && r2s.seen.length === 2 && r2s.seen.every((k) => k.endsWith(':' + DUP)) && r2s.seen[0] !== r2s.seen[1], r2s);
  const archA = path.join(proj, 'openspec', 'changes', 'archive', '2026-09-29-a1');
  H.ok('归档没被拦', fs.existsSync(archA) && !seen(r2, /还不能归档/), cmdsOf(r2));
  H.ok('第二个会话也交了报告，是另一份，里面说了 a1 已归档', reports().length === 2 && /- a1：已归档/.test(fs.readFileSync(reports()[1], 'utf8')), reports().map((f) => f + '\n' + fs.readFileSync(f, 'utf8')).join('\n----\n'));

  server.close();
  let left = '';
  try { left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + path.basename(root) + "*' -and $_.ProcessId -ne " + process.pid + " -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }"], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim(); } catch (e) { left = ''; }
  H.ok('没有留下进程', left === '', left);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.log('    临时目录没删干净：' + root); }
  H.done('端到端（全自动）' + LABEL);
})().catch((e) => { console.log('端到端脚本出错：' + ((e && e.stack) || e)); try { server.close(); } catch (e2) { /* 忽略 */ } process.exit(2); });

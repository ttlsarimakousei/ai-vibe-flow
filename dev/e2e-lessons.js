'use strict';
/*
 * 端到端：真的 Claude Code + 按脚本回复的假模型，走一遍"审查报问题 → 改 → 收经验 → 第二次出现升成规则 → 提交 → 新会话读文件时带上规则"。
 * 两条路各走一遍：
 *   auto（默认）   "审查报的问题自动收"开着：脚本在收工时自己收，不催模型记；规则的文字是审查者写的"以后怎么避免"
 *   manual        关着：收工时催模型用 lesson.js 记
 * 套件用真的 install.js 装进假的用户目录（--no-router，钩子走命令方式），钩子是真的在跑。
 * 用法：node dev/e2e-lessons.js <claude.exe 的路径> [标签] [auto | manual]
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
const AUTO = process.argv[4] !== 'manual';
if (!EXE || !fs.existsSync(EXE)) { console.log('用法：node dev/e2e-lessons.js <claude.exe 的路径> [标签] [auto | manual]'); process.exit(2); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vke-'));
const home = path.join(root, 'home');
const cfg = path.join(home, '.claude');
const kit = path.join(cfg, 'vibe-kit');
const h = { root, home, cfg, kit };
fs.mkdirSync(cfg, { recursive: true });
const proj = H.makeRepo(path.join(root, 'w', 'proj'), {
  'pom.xml': '<project/>\n',
  'src/main/java/com/x/OrderService.java': 'package com.x;\npublic class OrderService {\n  // FILE-ORDER-SERVICE\n}\n',
  'src/main/java/com/x/OrderMapper.java': 'package com.x;\npublic interface OrderMapper {}\n',
  '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：node -e "console.log(1)"\n- 看页面：不适用\n',
  'openspec/changes/add-export/proposal.md': '## Why\n\n要导出。\n',
  'openspec/changes/add-export/tasks.md': '- [x] 1.1 改 src/main/java/com/x/OrderService.java；验：人工看\n',
  'openspec/changes/fix-order/proposal.md': '## Why\n\n修订单。\n',
  'openspec/changes/fix-order/tasks.md': '- [x] 1.1 改 src/main/java/com/x/OrderService.java；验：人工看\n',
});
const JAVA = path.join(proj, 'src', 'main', 'java', 'com', 'x', 'OrderService.java');
const RULE_TEXT = '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错';
const LESSON = 'node "' + path.join(kit, 'tools', 'lesson.js').replace(/\\/g, '/') + '" add --file src/main/java/com/x/OrderService.java --when "调 OrderMapper.selectByIds 之前" --do "先判空列表，传空列表会拼出 in () 报错"';

// ---------- 假模型 ----------
let requests = [];
let scenario = null;
const textsOf = (m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => (typeof c.text === 'string' ? c.text : c.type === 'tool_result' ? (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')) : '')));
const allText = (body) => [].concat((Array.isArray(body.system) ? body.system.map((s) => s.text || '') : [String(body.system || '')]), (body.messages || []).flatMap(textsOf)).join('\n');
const uses = (body) => (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use') : []));
const lastUser = (body) => { const ms = (body.messages || []).filter((m) => m.role !== 'assistant'); return ms.length ? textsOf(ms[ms.length - 1]).join('\n') : ''; };
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
const tool = (body, res, name, input) => reply(body, res, { type: 'tool_use', id: 'toolu_e2e_' + (++toolSeq), name, input }, 'tool_use');
function answer(body, res) {
  const names = (body.tools || []).map((t) => t.name);
  const sys = Array.isArray(body.system) ? body.system.map((s) => s.text || '').join('\n') : String(body.system || '');
  // 审查代理：只读的那几个工具，系统提示里有它的人设
  if (/你是审查者/.test(sys)) return say(body, res, '- 位置：src/main/java/com/x/OrderService.java:3\n- 问题：调 selectByIds 之前没有判空\n- 什么情况下会出错：传空列表，拼出 in ()，SQL 报错\n- 严重程度：会出错\n- 类别：边界\n- 以后怎么避免：' + RULE_TEXT + '\n\n结论：问题 1 条（会出错 1，有隐患 0，建议 0）');
  if (!names.includes('Read') || !names.includes('Bash')) return say(body, res, 'ok');
  const shell = 'Bash';
  const done = uses(body);
  const ran = (re) => done.some((u) => u.name === shell && re.test(String((u.input || {}).command || '')));
  const last = afterLastAssistant(body);
  const s = scenario;
  if (s.kind === 'commit') {
    if (!ran(/git commit/)) return tool(body, res, shell, { command: 'git add src/main/java/com/x/OrderService.java' + (s.includeRule ? ' ".claude/rules/ttls-lessons-java.md"' : '') + ' && git commit -m "fix: 查询前判空' + (s.includeRule ? '并登记经验规则' : '') + '（源自 ' + s.change + ' 1.1）"', description: '按用户确认提交当前成果' });
    return say(body, res, '当前成果已提交。');
  }
  if (s.kind === 'read') {
    if (!done.some((u) => u.name === 'Read')) return tool(body, res, 'Read', { file_path: JAVA });
    return say(body, res, '读完了。');
  }
  // 兼容代理入口：审查、修复和经验照常；故意未经确认尝试提交，必须拦截，后续真人确认再提交。
  if (!done.some((u) => u.name === 'Agent' || u.name === 'Task')) {
    const agent = (body.tools || []).find((t) => t.name === 'Agent' || t.name === 'Task');
    const props = Object.keys(((agent || {}).input_schema || {}).properties || {});
    const input = { description: '审查代码', subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/' + s.change + '/\n改了 src/main/java/com/x/OrderService.java，仓库在 ' + proj };
    if (props.includes('run_in_background')) input.run_in_background = false;
    return tool(body, res, agent ? agent.name : 'Agent', input);
  }
  if (!done.some((u) => u.name === 'Edit')) {
    if (!done.some((u) => u.name === 'Read')) return tool(body, res, 'Read', { file_path: JAVA });
    return tool(body, res, 'Edit', { file_path: JAVA, old_string: '  // FILE-ORDER-SERVICE', new_string: '  // FILE-ORDER-SERVICE\n  // 判空：' + s.change });
  }
  if (!ran(/console\.log\('verify ok'\)/)) return tool(body, res, shell, { command: 'node -e "console.log(\'verify ok\')"', description: '快检' });
  if (!ran(/git add src\/main/)) return tool(body, res, shell, { command: 'git add src/main/java/com/x/OrderService.java && git commit -m "fix: 查询前判空（源自 ' + s.change + ' 1.1）"', description: '提交修复' });
  if (/各记一条经验/.test(allText({ messages: body.messages })) && !ran(/lesson\.js/)) return tool(body, res, shell, { command: LESSON + ' --from "' + s.change + ' 1.1" --kind 边界', description: '记经验' });
  if ((AUTO ? /经验规则文件更新了，还没提交/ : /规则文件跟着仓库走/).test(allText({ messages: body.messages })) && (AUTO || ran(/lesson\.js/)) && !ran(/git add "?\.claude\/rules/)) return tool(body, res, shell, { command: 'git add ".claude/rules/ttls-lessons-java.md" && git commit -m "docs: 更新经验规则"', description: '提交规则文件' });
  if (/\[vibe-kit 收工检查\]/.test(last)) return say(body, res, '收工检查里说的都处理了，没有别的要做的。');
  return say(body, res, '审查的问题改完了，已验证、已提交。');
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

function runClaude(port, promptText, s) {
  return new Promise((resolve) => {
    requests = [];
    scenario = s;
    const env = H.envFor(h, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'e2e-token', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
    fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
    const t0 = Date.now();
    const p = spawn(EXE, ['-p', promptText, '--output-format', 'json'], { cwd: proj, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let killed = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { killed = true; try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { try { p.kill(); } catch (e2) { /* 忽略 */ } } }, 180000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, killed, ms: Date.now() - t0, out, err, requests: requests.slice() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, killed, ms: Date.now() - t0, out, err: String(e), requests: requests.slice() }); });
  });
}
const mains = (run) => run.requests.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === 'Read') && r.body.tools.some((t) => t.name === 'Bash'));
const commandsIn = (run) => { const m = mains(run); return m.length ? uses(m[m.length - 1].body).filter((u) => u.name === 'Bash').map((u) => String(u.input.command)) : []; };
const seen = (run, re) => mains(run).some((r) => re.test(allText(r.body)));

(async () => {
  console.log('===== 端到端：Claude Code ' + LABEL + '，' + (AUTO ? '审查报的问题自动收' : '模型自己记') + ' =====');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: root, timeout: 180000 });
  H.ok('套件装进了假的用户目录', inst.code === 0, inst.out + inst.err);
  const st = JSON.parse(H.read(path.join(cfg, 'settings.json')));
  H.ok('钩子登记成命令方式', JSON.stringify(st.hooks).includes('verify-gate.js') && !JSON.stringify(st.hooks).includes('"type":"http"'), st.hooks);
  if (!AUTO) H.setConfig(h, { lessonAuto: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const L = require(path.join(kit, 'lib', 'lessons.js'));
  const ruleFile = path.join(proj, '.claude', 'rules', 'ttls-lessons-java.md');

  H.section(AUTO ? '第一个变更：审查报问题，改了，脚本自己收' : '第一个变更：审查报问题，改了，被催着记经验');
  const r1 = await runClaude(port, '审一下变更 add-export 的代码，有问题就改', { kind: 'review', change: 'add-export' });
  console.log('    退出码 ' + r1.code + (r1.killed ? '（超时被结束）' : '') + '，' + r1.ms + ' ms，主会话 ' + mains(r1).length + ' 个请求；跑过的命令：' + commandsIn(r1).map((c) => c.slice(0, 50)).join(' ｜ '));
  H.ok('系统提示里没有自动记忆那一节（已关掉）', mains(r1).length > 0 && !/^# (auto memory|Memory)\s*$/im.test((mains(r1)[0].body.system || []).map((s) => s.text || '').join('\n')));
  H.ok('审查代理真的跑了', r1.requests.some((r) => r.body && /你是审查者/.test(JSON.stringify(r.body.system || ''))));
  if (AUTO) {
    H.ok('收工时没有催它记经验', !seen(r1, /各记一条经验/), commandsIn(r1));
    H.ok('它没有去跑 lesson.js', !commandsIn(r1).some((c) => /lesson\.js/.test(c)), commandsIn(r1));
  } else {
    H.ok('收工时被催记经验', seen(r1, /各记一条经验/), commandsIn(r1));
    H.ok('它照着记了', commandsIn(r1).some((c) => /lesson\.js" add/.test(c)), commandsIn(r1));
    H.ok('工具回了"已记下，第 1 次"', seen(r1, /已记下（L[0-9a-f]{6}，第 1 次）/));
  }
  const c1 = L.readCandidates(proj);
  H.ok('候选里有一条' + (AUTO ? '，是自动收的，文字是审查者写的"以后怎么避免"' : ''), c1.length === 1 && c1[0].text === RULE_TEXT && c1[0].kind === '边界' && !!c1[0].auto === AUTO, c1);
  H.ok('还没有规则文件', !fs.existsSync(ruleFile));
  H.ok('修改完成但未确认时没有自行提交', H.git(proj, ['rev-list', '--count', 'HEAD']).out.trim() === '1' && H.git(proj, ['status', '--porcelain', '--', 'src']).out.trim() !== '');
  const commit1 = await runClaude(port, '提交当前 add-export 的修复', { kind: 'commit', change: 'add-export' });
  H.ok('真人确认后实际提交第一个修复', commit1.code === 0 && H.git(proj, ['rev-list', '--count', 'HEAD']).out.trim() === '2', commit1.out + commit1.err);

  H.section('第二个变更：同样的问题又出现，升成规则并提交');
  const r2 = await runClaude(port, '审一下变更 fix-order 的代码，有问题就改', { kind: 'review', change: 'fix-order' });
  console.log('    退出码 ' + r2.code + (r2.killed ? '（超时被结束）' : '') + '，' + r2.ms + ' ms，主会话 ' + mains(r2).length + ' 个请求；跑过的命令：' + commandsIn(r2).map((c) => c.slice(0, 50)).join(' ｜ '));
  if (AUTO) H.ok('收工时让它提交规则文件', seen(r2, /经验规则文件更新了，还没提交/), commandsIn(r2));
  else H.ok('工具回了"已升成这个项目的规则"', seen(r2, /第 2 次出现，已升成这个项目的规则/));
  H.ok('规则文件写出来了' + (AUTO ? '，标着"自动"' : ''), fs.existsSync(ruleFile) && (H.read(ruleFile) || '').includes('- ' + RULE_TEXT) && /自动=具体/.test(H.read(ruleFile) || '') === AUTO, H.read(ruleFile));
  H.ok('提交规则文件的命令没被拦', commandsIn(r2).some((c) => /git add "\.claude\/rules\/ttls-lessons-java\.md"/.test(c)) && !seen(r2, /会改到经验规则的文件/), commandsIn(r2));
  // #112（2026-10-14 起）：只提交套件催着提交的经验规则文件，不再被当成提案提交拦下（10-07 定的"经验规则的文件不问"）；
  // 修复代码仍要这一次的真人确认，不能借上一个变更的许可
  const head2 = H.git(proj, ['show', '--name-only', '--format=%s', 'HEAD']).out.trim().split(/\r?\n/).filter(Boolean);
  H.ok('只提交了规则文件', H.git(proj, ['rev-list', '--count', 'HEAD']).out.trim() === '3' && head2[0] === 'docs: 更新经验规则' && head2.slice(1).join() === '.claude/rules/ttls-lessons-java.md', head2);
  H.ok('新成果仍需本次确认，不能借上次许可', H.git(proj, ['status', '--porcelain', '--', 'src']).out.trim() !== '');
  const commit2 = await runClaude(port, '提交当前 fix-order 的修复和经验规则', { kind: 'commit', change: 'fix-order', includeRule: true });
  H.ok('真人确认后实际提交修复和规则', commit2.code === 0 && H.git(proj, ['rev-list', '--count', 'HEAD']).out.trim() === '4' && H.git(proj, ['status', '--porcelain', '--', 'src']).out.trim() === '', commit2.out + commit2.err);
  const log = H.git(proj, ['log', '--oneline', '--name-only', '-3']).out;
  H.ok('规则文件进了仓库', /fix: 查询前判空并登记经验规则/.test(log) && /\.claude\/rules\/ttls-lessons-java\.md/.test(log), log);
  H.ok('工作区里规则文件是干净的', H.git(proj, ['status', '--porcelain', '--', '.claude/rules']).out.trim() === '', H.git(proj, ['status', '--porcelain']).out);
  if (!AUTO) H.ok('没有再被催提交规则文件', !seen(commit2, /经验规则文件更新了，还没提交/));

  H.section('新会话：读到 java 文件时自动带上规则');
  const r3 = await runClaude(port, '读一下 src/main/java/com/x/OrderService.java', { kind: 'read' });
  const m3 = mains(r3);
  console.log('    退出码 ' + r3.code + (r3.killed ? '（超时被结束）' : '') + '，' + r3.ms + ' ms，主会话 ' + m3.length + ' 个请求');
  H.ok('第一个请求里没有规则（平时不占上下文）', m3.length >= 2 && !allText(m3[0].body).includes(RULE_TEXT));
  H.ok('读了 java 文件之后的请求里有规则', m3.length >= 2 && allText(m3[m3.length - 1].body).includes(RULE_TEXT));
  H.ok('编号、次数、出处那行注释没进上下文', m3.length >= 2 && !/次数=\d+ 最近=/.test(allText(m3[m3.length - 1].body)) && !/vibe-kit 经验规则：审查里反复出现/.test(allText(m3[m3.length - 1].body)));

  server.close();
  // 留在桌面上的进程：这个临时目录里起的都应该结束了
  let left = '';
  try { left = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + path.basename(root) + "*' -and $_.ProcessId -ne " + process.pid + " -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name + ' ' + $_.ProcessId }"], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim(); } catch (e) { left = ''; }
  H.ok('没有留下进程', left === '', left);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.log('    临时目录没删干净：' + root); }
  H.done('端到端（经验规则，' + (AUTO ? '自动收' : '自己记') + '）' + LABEL);
})().catch((e) => { console.log('端到端脚本出错：' + ((e && e.stack) || e)); try { server.close(); } catch (e2) { /* 忽略 */ } process.exit(2); });

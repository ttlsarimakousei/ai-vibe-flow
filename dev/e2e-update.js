'use strict';
/*
 * 端到端：真的 Claude Code + 按脚本回复的假模型 + 假 GitLab。两件事：
 *   1. 令牌和模型的 key 读不到：Read、Grep 被安装器加的权限规则挡住，用命令读被钩子挡住；那两串字从头到尾没发给模型
 *   2. 用着 Claude Code 的时候，钩子在后台发现仓库里的新版、自己装上；攒下的问题反馈建成了议题；桌面上没有窗口
 * 套件用真的 install.js 装进假的用户目录（--no-router，钩子走命令方式）。
 * 用法：node dev/e2e-update.js <claude.exe 的路径> [标签] [假 GitLab 的端口，默认 18748]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const H = require('./lib/harness');

const EXE = process.argv[2];
const LABEL = process.argv[3] || path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(EXE || ''))))));
const GL_PORT = Number(process.argv[4]) || 18748;
if (!EXE || !fs.existsSync(EXE)) { console.log('用法：node dev/e2e-update.js <claude.exe 的路径> [标签] [端口]'); process.exit(2); }
const A = '20260921.0900';
const B = '20260922.0900';
const TOKEN_MARK = 'glpat-E2E-MARKER-0000000001';
const KEY_MARK = 'sk-E2E-ROUTER-KEY-MARKER';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

// ---------- 假模型 ----------
let requests = [];
let scenario = null;
const textsOf = (m) => (typeof m.content === 'string' ? [m.content] : (m.content || []).map((c) => (typeof c.text === 'string' ? c.text : c.type === 'tool_result' ? (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n')) : '')));
const uses = (body) => (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_use') : []));
const results = (body) => (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result') : []));
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
const tool = (body, res, name, input) => reply(body, res, { type: 'tool_use', id: 'toolu_e2u_' + (++toolSeq), name, input }, 'tool_use');
function answer(body, res) {
  const names = (body.tools || []).map((t) => t.name);
  if (!names.includes('Read') || !names.includes('Bash')) return say(body, res, 'ok');
  const done = uses(body);
  const s = scenario;
  if (s.kind === 'secret') {
    // 一步一步试：每一步都是模型"想读令牌"的一种办法
    const steps = s.steps;
    if (done.length < steps.length) { const st = steps[done.length]; return tool(body, res, st.tool, st.input); }
    return say(body, res, '都试过了。');
  }
  return say(body, res, '你好。');
}
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch (e) { /* 不是 JSON */ }
    requests.push({ url: req.url, method: req.method, body, raw });
    if (req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url) && body) { try { return answer(body, res); } catch (e) { console.log('假模型出错：' + e.stack); } }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'e2e: not found' } }));
  });
});

(async () => {
  console.log('===== 端到端（更新、令牌）：Claude Code ' + LABEL + ' =====');
  const watch = await H.watchWindows('e2u-win');
  const gl = await H.fakeGitlab('e2u-gl', GL_PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 维护的人发布 A
  const MT = 'glpat-maintainer-token-03';
  gl.addToken(MT, 'maintainer');
  gl.addToken(TOKEN_MARK, 'xiaowang');
  const m = H.freshHome('e2u-m');
  fs.mkdirSync(m.kit, { recursive: true });
  fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  const pkgA = H.makePackage('e2u-a', A);
  const pkgB = H.makePackage('e2u-b', B);
  const publish = (pkg) => H.node(m, path.join(pkg, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkg, timeout: 600000, env: { VIBE_KIT_NO_UPDATE: undefined } });
  const pa = publish(pkgA);
  H.ok('（维护的人发布了 A）', pa.code === 0, pa.out + pa.err);

  // 同事的电脑：装 A
  const h = H.freshHome('e2u-u');
  const inst = H.node(h, path.join(pkgA, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  H.ok('套件装进了假的用户目录', inst.code === 0, inst.out + inst.err);
  fs.writeFileSync(path.join(h.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlabToken: TOKEN_MARK, gitlabTokenSource: 'manual' }));
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ providers: [{ name: 'x', api_key: KEY_MARK }] }));
  const st = readJson(path.join(h.cfg, 'settings.json'));
  H.ok('权限规则里有"不许读"那两条', st.permissions && Array.isArray(st.permissions.deny) && st.permissions.deny.includes('Read(~/.claude/vibe-kit/secrets.json)') && st.permissions.deny.includes('Read(~/.claude/vibe-kit/router-data/**)'), st.permissions);
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：node -e "console.log(1)"\n' });

  function runClaude(promptText, s, extraEnv) {
    return new Promise((resolve) => {
      requests = [];
      scenario = s;
      const env = H.envFor(h, Object.assign({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port, ANTHROPIC_AUTH_TOKEN: 'e2e-token', NO_PROXY: '127.0.0.1,localhost', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe' }, gl.env, extraEnv || {}));
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
      const t0 = Date.now();
      const p = spawn(EXE, ['-p', promptText, '--output-format', 'json'], { cwd: proj, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; let killed = false;
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => { killed = true; try { execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (e) { try { p.kill(); } catch (e2) { /* 忽略 */ } } }, 240000);
      p.on('close', (code) => { clearTimeout(timer); resolve({ code, killed, ms: Date.now() - t0, out, err, requests: requests.slice() }); });
      p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, killed, ms: Date.now() - t0, out, err: String(e), requests: requests.slice() }); });
    });
  }
  const mains = (run) => run.requests.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.some((t) => t.name === 'Read') && r.body.tools.some((t) => t.name === 'Bash'));

  H.section('令牌和模型的 key：模型读不到');
  {
    const K = h.kit.replace(/\\/g, '/');
    const steps = [
      { tool: 'Read', input: { file_path: path.join(h.kit, 'secrets.json') } },
      { tool: 'Read', input: { file_path: path.join(h.kit, 'router-data', 'config.json') } },
      { tool: 'Read', input: { file_path: K + '/secrets.json' } },
      { tool: 'Grep', input: { pattern: 'MARKER', path: h.kit, output_mode: 'content' } },
      { tool: 'Grep', input: { pattern: 'glpat', path: h.cfg, output_mode: 'content', glob: '*.json' } },
      { tool: 'Grep', input: { pattern: 'MARKER', path: path.join(h.kit, 'secrets.json'), output_mode: 'content' } },
      { tool: 'Grep', input: { pattern: 'MARKER', path: path.join(h.kit, 'router-data'), output_mode: 'content' } },
      { tool: 'Grep', input: { pattern: 'MARKER', path: h.home, output_mode: 'content' } },
      { tool: 'Grep', input: { pattern: 'autoUpdate', path: h.kit, output_mode: 'files_with_matches' } },
      { tool: 'Bash', input: { command: 'cat "' + K + '/secrets.json"', description: '看令牌' } },
      { tool: 'Bash', input: { command: 'cat ' + K + '/*.json', description: '看所有 json' } },
      { tool: 'Bash', input: { command: 'grep -rn MARKER "' + K + '"', description: '搜' } },
      { tool: 'Read', input: { file_path: path.join(h.kit, 'config.json') } },
      { tool: 'Bash', input: { command: 'ls "' + K + '"', description: '列目录' } },
    ];
    const r = await runClaude('看看套件的配置', { kind: 'secret', steps });
    const mm = mains(r);
    console.log('    退出码 ' + r.code + (r.killed ? '（超时被结束）' : '') + '，' + r.ms + ' ms，主会话 ' + mm.length + ' 个请求');
    const last = mm.length ? mm[mm.length - 1].body : { messages: [] };
    const res = results(last).map((x) => ({ err: !!x.is_error, text: (typeof x.content === 'string' ? x.content : (x.content || []).map((c) => c.text || '').join('\n')).slice(0, 300) }));
    H.ok('每一步都走到了', res.length === steps.length, res);
    const all = r.requests.map((x) => x.raw).join('\n');
    H.ok('令牌那串字从头到尾没发给模型', !all.includes(TOKEN_MARK), res);
    H.ok('模型的 key 那串字从头到尾没发给模型', !all.includes(KEY_MARK), res);
    for (const i of [0, 1, 2]) H.ok('Read 第 ' + (i + 1) + ' 次：被权限规则挡住', res[i] && res[i].err && /denied|permission|不允许|拒绝/i.test(res[i].text), res[i]);
    for (const i of [3, 4, 7]) H.ok('Grep 对着上级目录搜内容（第 ' + (i + 1) + ' 步）：被钩子挡住', res[i] && /里有放令牌、放模型 key 的文件/.test(res[i].text), res[i]);
    for (const i of [5, 6]) H.ok('Grep 直接对着那两处搜（第 ' + (i + 1) + ' 步）：挡住了（钩子先拦；没有钩子时权限规则也会拦）', res[i] && res[i].err && /denied|permission|放令牌、放模型 key/i.test(res[i].text), res[i]);
    H.ok('Grep 只看文件名：照常能用，列不出那两处', res[8] && !res[8].err && /config\.json/.test(res[8].text) && !/secrets\.json|router-data/.test(res[8].text), res[8]);
    for (const i of [9, 10, 11]) H.ok('命令第 ' + (i - 8) + ' 次：被钩子挡住', res[i] && /令牌或者模型的 key|放令牌、放模型 key/.test(res[i].text), res[i]);
    H.ok('读开关（config.json）照常能读', res[12] && !res[12].err && /autoVerify/.test(res[12].text), res[12]);
    H.ok('列目录照常能列', res[13] && !res[13].err && /config\.json/.test(res[13].text), res[13]);
  }

  H.section('用着 Claude Code 的时候，后台自己更新');
  {
    const pb = publish(pkgB);
    H.ok('（维护的人发布了 B）', pb.code === 0, pb.out + pb.err);
    H.node(h, '-e', ['require(' + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '出错', hook: 'verify-gate', title: '端到端里记的一条', what: 'x', sig: 'sig-e2e-1' }) + ')'], { cwd: h.root });
    const r = await runClaude('你好', { kind: 'hello' }, { VIBE_KIT_NO_UPDATE: undefined });
    console.log('    退出码 ' + r.code + (r.killed ? '（超时被结束）' : '') + '，' + r.ms + ' ms，主会话 ' + mains(r).length + ' 个请求');
    // 2.1.259 用 -p 时答完可能不退出（已知问题），所以不看退出码，看它有没有答
    H.ok('会话跑完了', mains(r).length >= 1, r.err.slice(0, 500));
    const ver = () => (H.read(path.join(h.kit, 'VERSION')) || '').trim();
    let done = false;
    for (let i = 0; i < 240 && !done; i++) { await H.sleep(500); done = ver() === B && !fs.existsSync(path.join(h.kit, 'update', 'lock.json')); }
    const us = readJson(path.join(h.kit, 'state', 'update.json'));
    H.ok('后台查到了 B，自己装上了', done && us.lastApplied && us.lastApplied.from === A && us.lastApplied.to === B, [ver(), us, H.read(path.join(h.kit, 'update', 'update.log'))]);
    H.ok('是钩子甩出去的', /会话开始|用户开口|收工/.test(us.lastKickWhy || ''), us.lastKickWhy);
    H.ok('令牌、仓库地址、权限规则都还在', readJson(path.join(h.kit, 'secrets.json')).gitlabToken === TOKEN_MARK && readJson(path.join(h.kit, 'gitlab.json')).repo === gl.url && readJson(path.join(h.cfg, 'settings.json')).permissions.deny.includes('Read(~/.claude/vibe-kit/secrets.json)'));
    // 第二个会话：新版的钩子照常工作；攒下的那条问题反馈传上去
    const f = path.join(h.kit, 'state', 'update.json');
    fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), { lastKickAt: 0 })));
    const before = gl.issues().length;
    const r2 = await runClaude('你好', { kind: 'hello' }, { VIBE_KIT_NO_UPDATE: undefined });
    H.ok('更新之后再开会话：正常', mains(r2).length >= 1, r2.err.slice(0, 500));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await H.sleep(500); up = gl.issues().length > before && !fs.existsSync(path.join(h.kit, 'update', 'lock.json')); }
    H.ok('攒下的问题反馈建成了议题', up && gl.issues().some((i) => /端到端里记的一条/.test(i.title) && i.author.username === 'xiaowang'), gl.issues().map((i) => i.title));
    const all = r.requests.concat(r2.requests).map((x) => x.raw).join('\n');
    H.ok('整个过程令牌没发给模型', !all.includes(TOKEN_MARK) && !all.includes(KEY_MARK));
  }

  server.close();
  gl.stop();
  await H.sleep(500);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('端到端（更新、令牌）' + LABEL);
})().catch((e) => { console.log('端到端脚本出错：' + ((e && e.stack) || e)); try { server.close(); } catch (e2) { /* 忽略 */ } H.cleanup(); process.exit(2); });

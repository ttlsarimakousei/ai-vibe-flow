'use strict';
/*
 * 端到端：真的 Claude Code + 假模型，审查子代理走完一个审查点（问题表第 45 条）。交互界面（后台子代理的通知只有交互界面才接着一轮）。
 *   用户说"审查"→ prepare → 一条回复开 3 个 vk-reviewer → 第一个角度回坏 JSON，SubagentStop 回 block，看到 reason 重写 → 交齐入账
 *   → status 看到 1 条 P2 → 改代码、快检、resolve → 再 prepare，只开 1 个，只审修改点 → 交 0 条 → 这个点过了
 * 2.1.120 子代理在前台，工具结果是全文；2.1.259 起在后台，工具结果只说已启动，做完来通知：主会话这一轮先收工，收工检查不能催它再开一个。
 * 套件用真的 install.js 装进假的用户目录。
 * 用法：node dev/e2e-subagent.js <版本号 | claude.exe>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { H, exeOf, fakeGateway, claudeEnv, killTree } = require('./probes/common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 240;
const WINPTY = 'C:/Program Files/Git/usr/bin/winpty.exe';

function send(body, res, blocks, stop) {
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const usage = { input_tokens: 3000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: blocks, stop_reason: stop, usage })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }];
  blocks.forEach((b, index) => {
    if (b.type === 'text') ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    else ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 50 } }, { type: 'message_stop' });
  for (const e of ev) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
  res.end();
}
const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
const textOfResult = (b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(''));

(async () => {
  const watch = await H.watchWindows('e2e-sub-win');
  const h = H.freshHome('e2e-sub');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), {
    '.gitignore': '.vibe/\n',
    '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：node --check src/a.js\n- 看页面：不适用\n',
    'src/a.js': 'const a = 1;\n',
    'openspec/changes/c1/proposal.md': '## Why\n\n要导出。\n',
    'openspec/changes/c1/design.md': '## Context\n\n现状。\n\n## 验收用例\n\n- AC-01：点导出下载文件\n',
    'openspec/changes/c1/tasks.md': '## 1. 实现\n\n- [x] 1.1 改 src/a.js；验：node --check src/a.js\n',
  });
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  H.ok('套件装进了假的用户目录', inst.code === 0, inst.out + inst.err);
  H.setConfig(h, { reviewSmallChars: 0, commitMode: 'off', lessons: 'off', vibeTidy: false, autoUpdate: 'off', issueUpload: 'off', reviewLenses: 3 });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const setFile = path.join(h.cfg, 'settings.json');
  const st = JSON.parse(H.read(setFile));
  st.permissions = Object.assign({}, st.permissions, { allow: [...new Set(((st.permissions || {}).allow || []).concat(['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Task']))] });
  H.ok('登记了 SubagentStop', JSON.stringify(st.hooks.SubagentStop || '').includes('review-stop'), st.hooks.SubagentStop);
  fs.writeFileSync(setFile, JSON.stringify(st, null, 2));

  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
  const dir = path.join(proj, 'openspec', 'changes', 'c1');
  const tool = path.join(h.kit, 'tools', 'review.js').replace(/\\/g, '/');
  const pj = proj.replace(/\\/g, '/');
  const ARGS = ' --change c1 --mode code --point change --project "' + pj + '" --base ' + H.git(proj, ['rev-parse', 'HEAD']).out.trim();
  const decisions = path.join(proj, '.vibe', 'decisions.json').replace(/\\/g, '/');
  const result = path.join(proj, '.vibe', 'reviews', 'c1', 'code-change.json');

  const t0 = Date.now(); const ms = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const events = []; const note = (s) => events.push(ms() + ' ' + s);
  let child = null; let agentTool = ''; let phase = 'first'; let sawBlock = false; let lensCalls = 0; let reviewerModels = new Set(); const mainModels = new Set();
  let sawBackground = false; let round = 0; let n = 0; let opened = 0; let stoppedWhileRunning = 0; let toolUse = 0;
  const run = (command, description) => ({ type: 'tool_use', id: 'toolu_e2e_' + (++toolUse), name: 'Bash', input: { command, description } });
  const done = () => { try { return JSON.parse(fs.readFileSync(result, 'utf8')); } catch (e) { return null; } };
  const resultId = { id: '' };
  const gw = await fakeGateway((body, res) => {
    const names = (body.tools || []).map((t) => t.name);
    const all = JSON.stringify(body.messages);
    const task = /审查任务：([0-9a-f]{24})\/([^\s"\\]+)/.exec(all);
    // 子代理：只读的工具，提示第三行是审查任务
    if (!names.includes('Edit') && task) {
      reviewerModels.add(body.model);
      lensCalls++;
      const scoped = /模式：复审/.test(all);
      const head = '审查任务：' + task[1] + '/' + task[2] + '\n';
      if (!scoped && /事实|需求和连带影响/.test(task[2]) && !/vibe-kit 审查/.test(all)) { note('子代理回坏 JSON'); return send(body, res, [{ type: 'text', text: head + '我看完了，没有 JSON' }], 'end_turn'); }
      if (/vibe-kit 审查/.test(all)) { if (!sawBlock) note('子代理看到了 block 的 reason'); sawBlock = true; }
      const issues = !scoped && /边界/.test(task[2]) ? [{ severity: 'P2', file: 'src/a.js', line: 1, problem: 'a 的初值不对', evidence: '传 1 得到错的结果', fix: '改成 2', kind: '边界', avoid: '无', scope: 'in' }] : [];
      return send(body, res, [{ type: 'text', text: head + '```json\n' + JSON.stringify({ issues, summary: '看完了' }) + '\n```' }], 'end_turn');
    }
    if (!names.includes('Edit')) return send(body, res, [{ type: 'text', text: 'ok' }], 'end_turn');
    mainModels.add(body.model);
    n++;
    if (!agentTool) agentTool = names.includes('Agent') ? 'Agent' : 'Task';
    const results = body.messages.slice(-3).filter((m) => m.role === 'user').flatMap(blocksOf).filter((b) => b.type === 'tool_result');
    const lastResult = results.length ? textOfResult(results[results.length - 1]) : '';
    if (/Async agent launched|working in the background/i.test(all)) sawBackground = true;
    if (phase === 'first') { phase = 'prepared'; round = 1; note('主会话：prepare'); return send(body, res, [run('node "' + tool + '" prepare' + ARGS, '备审查')], 'tool_use'); }
    if (phase === 'prepared') {
      let j = null; try { j = JSON.parse(lastResult.split('\n').find((l) => /^\{/.test(l))); } catch (e) { j = null; }
      if (!j || !j.agents) { note('主会话：prepare 没给 agents：' + lastResult.slice(0, 200) + ' …结尾：' + lastResult.slice(-300)); phase = 'end'; return send(body, res, [{ type: 'text', text: 'E2E-FAIL' }], 'end_turn'); }
      phase = 'waiting'; resultId.id = j.id; opened = j.agents.length; note('主会话：开 ' + j.agents.length + ' 个子代理');
      return send(body, res, j.agents.map((a, i) => ({ type: 'tool_use', id: 'toolu_agent_' + round + '_' + i, name: agentTool, input: { description: a.description, prompt: a.prompt, subagent_type: a.subagent_type } })), 'tool_use');
    }
    if (phase === 'waiting') {
      const r = done();
      if (!r || r.id !== resultId.id) { stoppedWhileRunning++; note('主会话：还没交齐，先收工'); return send(body, res, [{ type: 'text', text: '子代理还在跑，等通知。' }], 'end_turn'); }
      phase = round === 1 ? 'fix' : 'finish';
      note('主会话：交齐了，看结果');
      return send(body, res, [run('node "' + tool + '" status' + ARGS, '看结果')], 'tool_use');
    }
    if (phase === 'fix') { phase = 'edit'; return send(body, res, [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: path.join(proj, 'src', 'a.js') } }], 'tool_use'); }
    if (phase === 'edit') { phase = 'check'; note('主会话：改代码'); return send(body, res, [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: path.join(proj, 'src', 'a.js'), old_string: 'const a = 1;', new_string: 'const a = 2;' } }], 'tool_use'); }
    if (phase === 'check') { phase = 'resolve'; return send(body, res, [run('node --check src/a.js', '快检')], 'tool_use'); }
    if (phase === 'resolve') {
      phase = 'again';
      fs.mkdirSync(path.dirname(decisions), { recursive: true });
      fs.writeFileSync(decisions, JSON.stringify({ findings: [{ id: 'r1', action: 'fixed', reason: '把初值改成了 2，快检过了' }] }));
      return send(body, res, [run('node "' + tool + '" resolve' + ARGS + ' --decisions "' + decisions + '"', '登记处理结果')], 'tool_use');
    }
    if (phase === 'again') { phase = 'prepared'; round = 2; note('主会话：第二轮 prepare'); return send(body, res, [run('node "' + tool + '" prepare' + ARGS, '备复审')], 'tool_use'); }
    if (phase === 'finish') { phase = 'end'; note('主会话：结束'); setTimeout(() => killTree(child.pid), 6000); return send(body, res, [{ type: 'text', text: 'E2E-END' }], 'end_turn'); }
    return send(body, res, [{ type: 'text', text: 'E2E-END' }], 'end_turn');
  });

  child = spawn(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '审查 c1 的代码，用 vk-reviewer'], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color', ANTHROPIC_MODEL: 'vk-e2e', ...(process.env.VK_E2E_NO_SONNET_ENV ? {} : { ANTHROPIC_DEFAULT_SONNET_MODEL: 'vk-e2e-sonnet' }) }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
  const timer = setTimeout(() => { note('到时间，结束'); killTree(child.pid); }, SECONDS * 1000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  console.log('===== ' + EXE + ' =====\n过程：\n' + events.map((e) => '  ' + e).join('\n'));

  H.ok('第一轮开了 3 个、第二轮 1 个', round === 2 && opened === 1, { round, opened });
  H.ok('坏 JSON：SubagentStop 拦下，子代理看到 reason 重写了', sawBlock);
  H.ok('审查子代理用 Sonnet（代理文件 model: sonnet，走 ANTHROPIC_DEFAULT_SONNET_MODEL），主会话不受影响（第 63 条）', reviewerModels.size === 1 && [...reviewerModels][0] === 'vk-e2e-sonnet' && [...mainModels].every((m) => m === 'vk-e2e'), [[...reviewerModels], [...mainModels]]);
  const r = done();
  H.ok('复审只审修改点，交 0 条', r && r.scope === 'changes' && r.status === 'completed' && r.issues.length === 0, r);
  H.ok('这个点过了', P.settled(dir, 'change'), P.record(dir, 'change'));
  const log = H.read(path.join(proj, '.vibe', 'reviews', 'c1', '审查记录.md')) || '';
  H.ok('审查记录有两轮和处理结果', /## 第 1 轮/.test(log) && /## 第 2 轮/.test(log) && /处理结果/.test(log) && /r1 修了/.test(log), log);
  H.ok('任务目录清掉了', !fs.readdirSync(path.dirname(result)).some((f) => /^job-/.test(f)), fs.readdirSync(path.dirname(result)));
  const jobs = S.readState('review-jobs');
  H.ok('任务记账：completed', Object.values(jobs).every((x) => x.status === 'completed'), Object.values(jobs).map((x) => x.status));
  console.log('子代理在后台：' + sawBackground + '；后台时主会话先收工 ' + stoppedWhileRunning + ' 次；子代理请求 ' + lensCalls + ' 个');
  gw.close();
  const wins = await watch.stop();
  H.ok('没有弹窗口', wins.length === 0, wins);
  H.done('审查子代理端到端');
})().catch((e) => { H.ok('端到端异常', false, e.stack); H.done('审查子代理端到端'); });

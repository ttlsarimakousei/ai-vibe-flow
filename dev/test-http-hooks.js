'use strict';
/*
 * 装了路由时，改文件、跑命令、收工这几个检查是在路由的工作线程里跑的（HTTP 钩子）。
 * 这里起一个临时路由，把同一份输入分别用 HTTP 和命令方式各跑一遍，结果要一样：新加的经验规则那几处在工作线程里也得照常工作。
 * 用法：node dev/test-http-hooks.js [端口，默认 18734]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18734;
// 催记经验是"审查报的问题自动收"关着的时候才有的：这里要测的是两种方式结果一样，关掉它好让这道检查有话说
// 经验规则文件的提交在"询问""自动"下不用再问；2026-10-17 晚上起默认是"关"，这里写明"询问"
const h = H.makeHome('http', null, { lessonAuto: false, commitMode: 'ask' });
H.copyDir(path.join(H.SRC, 'router'), path.join(h.kit, 'router'));
fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ listen: { host: '127.0.0.1', port: PORT }, providers: [], routes: [], default: { provider: '' }, failover: [], options: {} }, null, 2));
fs.writeFileSync(path.join(h.cfg, 'settings.json'), '{}\n');
const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n', 'openspec/changes/add-export/tasks.md': '- [x] 1.1 改 src/main/java/A.java；验：人工看\n' });
const TOOL = path.join(h.kit, 'tools', 'lesson.js');
H.setConfig(h, { lessonThreshold: 1 });
H.node(h, TOOL, ['add', '--file', 'src/main/java/A.java', '--text', '分页查询的 pageSize 要限制上限：不限制的话传 100000 会把库拖垮', '--from', 'c1 1.1', '--new'], { cwd: proj });
const rule = path.join(proj, '.claude', 'rules', 'ttls-lessons-java.md');

const post = (name, input) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify(input));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/vibe-kit/hook/' + name, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) { /* 不是 JSON */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', (e) => resolve({ status: 0, json: null, text: String(e) }));
  req.write(data); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (o) => JSON.stringify(o === null || (o && typeof o === 'object' && !Object.keys(o).length) ? null : o).replace(/拦截编号 [A-Z0-9]{4,6}/g, '拦截编号 ####');

(async () => {
  const router = spawn(process.execPath, [path.join(h.kit, 'router', 'router.js'), '-c', path.join(h.kit, 'router-data', 'config.json'), '-p', String(PORT)], { env: H.envFor(h), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  router.stdout.on('data', (d) => { log += d; });
  router.stderr.on('data', (d) => { log += d; });
  process.on('exit', () => { try { router.kill(); } catch (e) { /* 已经退了 */ } });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = (await post('guard-ask', { session_id: 's', cwd: proj, tool_name: 'AskUserQuestion', tool_input: {} })).status === 200; }
  H.ok('临时路由起来了，认得钩子请求', up, log);
  if (up) {
    const tfile = path.join(h.root, 't.jsonl');
    const review = H.tr.ran('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/add-export/', run_in_background: false }, '有问题。\n\n结论：问题 1 条（会出错 1，有隐患 0，建议 0）');
    const turn = [H.tr.user('审一下'), review, H.tr.ran('Edit', { file_path: path.join(proj, 'src/main/java/A.java'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'ok'), H.tr.say('都改完了')];
    H.transcript(tfile, turn);
    const base = { cwd: proj, transcript_path: tfile };
    const cases = [
      ['IDEA MCP 读令牌', 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'mcp__vibe-idea-64342__execute_tool', tool_input: { projectPath: proj, command: 'read_file --file_path ' + JSON.stringify(path.join(h.kit, 'secrets.json').replace(/\\/g, '/')) } }, /令牌|key/],
      ['IDEA MCP 普通索引查询', 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'mcp__vibe-idea-64342__search_symbol', tool_input: { projectPath: proj, q: 'A' } }, null],
      ['改经验规则文件', 'pre-edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: rule, old_string: '- 分页', new_string: '- 改了' } }, /经验规则的文件，不要直接改/],
      ['改普通代码', 'pre-edit', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'src/main/java/A.java'), old_string: 'class A {}', new_string: 'class A { }' } }, null],
      ['命令删经验规则文件', 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm .claude/rules/ttls-lessons-java.md' } }, /会改到经验规则的文件/],
      ['命令提交经验规则文件', 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git add .claude/rules/ttls-lessons-java.md && git commit -m "docs: 更新经验规则"' } }, null],
      ['收工：催记经验、催提交规则文件', 'verify-gate', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '都改完了' }, /各记一条经验[\s\S]*经验规则文件更新了，还没提交/],
    ];
    for (const [name, hook, input, expect] of cases) {
      // 两种方式各用一个会话号：同一道检查"每个会话只催一次"，不能互相影响
      const viaHttp = await post(hook, Object.assign({ session_id: 's-http-' + hook }, base, input));
      const viaCmd = H.hook(h, hook, Object.assign({ session_id: 's-cmd-' + hook }, base, input));
      H.ok(name + '：HTTP 方式有回应', viaHttp.status === 200, viaHttp.text);
      if (expect) H.ok(name + '：HTTP 方式结果符合预期', expect.test(H.reasonOf(viaHttp.json)), viaHttp.text);
      else H.ok(name + '：HTTP 方式放行', clean(viaHttp.json) === 'null', viaHttp.text);
      H.ok(name + '：和命令方式一样', clean(viaHttp.json) === clean(viaCmd), 'HTTP：' + clean(viaHttp.json) + '\n      命令：' + clean(viaCmd));
    }
    const stats = JSON.parse(H.read(path.join(h.kit, 'state', 'hook-stats.json')) || '{}');
    H.ok('路由记下了钩子调用，没有出错的', stats.byHook && Object.values(stats.byHook).every((x) => !x.errors), stats.byHook);
  }
  try { router.kill(); } catch (e) { /* 已经退了 */ }
  await sleep(600);
  H.done('HTTP 方式的钩子');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); process.exit(2); });

'use strict';
/*
 * 探测：交互界面里中途打断时 Claude Code 怎么做，和步骤显示用哪个工具。
 * 1. 请求里给模型的任务工具是哪个（TodoWrite / TaskCreate），调了之后屏幕上有没有步骤。
 * 2. 工具跑着的时候打字发一句：什么时候送到模型、UserPromptSubmit 触发不触发、Stop 触发几次。
 * 3. 工具跑着的时候按 Esc：Stop 触发不触发；再说一句 UserPromptSubmit 触发不触发。
 * 家目录是假的（H.freshHome），连假网关，不装套件。钩子只把收到的东西记进文件。
 * 用法：node dev/probes/cc-interrupt.js <claude.exe> [跑多少秒，默认 100]
 *       PROBE_ENV=CLAUDE_CODE_ENABLE_TODO_TOOLS  多设一个环境变量（值为 1）
 *       PROBE_DUMP=<文件>  把屏幕内容存下来
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { H, brief, isMain, reply, fakeGateway, claudeEnv, killTree } = require('./common');

const EXE = process.argv[2];
const SECONDS = Number(process.argv[3]) || 100;
const WINPTY = 'C:/Program Files/Git/usr/bin/winpty.exe';
const QUEUED = '插话问题QQQ';
const SECOND = '第二句RRR';
const THIRD = '第三句SSS';
const WAIT_CMD = 'node -e "setTimeout(()=>{},15000)"';

(async () => {
  const watch = await H.watchWindows('pin-win');
  const h = H.freshHome('pin');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const hookLog = path.join(h.root, 'hooks.log');
  const hookJs = path.join(h.root, 'hook.js');
  fs.writeFileSync(hookJs, "const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let j={};try{j=JSON.parse(s)}catch(e){}fs.appendFileSync(" + JSON.stringify(hookLog) + ",JSON.stringify({ev:process.argv[2],at:Date.now(),prompt:j.prompt,active:j.stop_hook_active,tool:j.tool_name})+'\\n');process.exit(0)});");
  const cmd = (ev) => [{ hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '" ' + ev }] }];
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable', allow: ['Bash', 'TodoWrite', 'TaskCreate', 'TaskUpdate'] }, hooks: { UserPromptSubmit: cmd('UserPromptSubmit'), Stop: cmd('Stop'), PostToolUse: cmd('PostToolUse') } }, null, 2));

  const t0 = Date.now(); const ms = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const events = []; const note = (s) => events.push(ms() + ' ' + s);
  let child = null; let n = 0; let toolNames = null; let bashN = 0;
  const type = (text) => { note('输入：' + JSON.stringify(text)); child.stdin.write(text); if (text !== '\x1b') setTimeout(() => child.stdin.write('\r'), 400); };
  const strip = (s) => String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '<提醒…>');
  const blocks = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
  const describe = (m) => blocks(m).map((b) => (b.type === 'text' ? '文字[' + brief(strip(b.text), 120) + ']' : b.type === 'tool_result' ? '工具结果[' + brief(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 90) + ']' : b.type)).join(' + ');
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) { note('别的请求：工具 ' + (body.tools || []).length + ' ' + brief(JSON.stringify(body.system || '').slice(0, 60), 60)); return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn', 3000); }
    n++;
    const names = (body.tools || []).map((t) => t.name);
    if (!toolNames) { toolNames = names.filter((x) => /todo|task/i.test(x)); const sys = JSON.stringify(body.system || '') + JSON.stringify(body.messages); for (const w of ['TodoWrite', 'TaskCreate']) { const i = sys.indexOf(w); note(w + ' 在系统提示或消息里：' + (i < 0 ? '没有' : brief(sys.slice(Math.max(0, i - 80), i + 80), 170))); } note('全部工具：' + names.join(',')); }
    const last = body.messages[body.messages.length - 1];
    const recent = body.messages.slice(-3).filter((m) => m.role === 'user').flatMap(blocks);
    const lastText = strip(recent.filter((b) => b.type === 'text').map((b) => b.text).filter((x) => !/^<total_tokens>/.test(x)).join('\n'));
    note('最近三条里的用户块：' + recent.map((b) => (b.type === 'text' ? '文字[' + brief(strip(b.text), 70) + ']' : b.type === 'tool_result' ? '工具结果[' + brief(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 70) + ']' : b.type)).join(' + '));
    const all = JSON.stringify(body.messages);
    note('请求#' + n + ' 最后一条：' + describe(last) + (all.includes(QUEUED) ? '（整段里已有插话）' : ''));
    if (n === 1) {
      const block = names.includes('TaskCreate') ? { type: 'tool_use', id: 'toolu_plan1', name: 'TaskCreate', input: { subject: '步骤一探针', description: 'x', activeForm: '步骤一探针进行中' } } : { type: 'tool_use', id: 'toolu_plan1', name: 'TodoWrite', input: { todos: [{ content: '步骤一探针', status: 'in_progress', activeForm: '步骤一探针进行中' }, { content: '步骤二探针', status: 'pending', activeForm: '步骤二探针进行中' }] } };
      note('回：调 ' + block.name);
      return reply(body, res, block, 'tool_use', 3000);
    }
    if (n === 2 || (lastText.includes(SECOND) && !lastText.includes(THIRD))) {
      bashN++; const esc = lastText.includes(SECOND);
      note('回：调 Bash 等 15 秒' + (esc ? '（这次要按 Esc）' : ''));
      setTimeout(() => (esc ? type('\x1b') : type(QUEUED)), 5000);
      if (esc) setTimeout(() => type(THIRD), 10000);
      return reply(body, res, { type: 'tool_use', id: 'toolu_wait' + bashN, name: 'Bash', input: { command: WAIT_CMD, description: 'wait' } }, 'tool_use', 3000);
    }
    if (lastText.includes(THIRD)) { note('回：结束语'); setTimeout(() => killTree(child.pid), 6000); return reply(body, res, { type: 'text', text: 'PROBE-END' }, 'end_turn', 3000); }
    note('回：文字');
    setTimeout(() => { if (!events.some((e) => e.includes('"' + SECOND + '"'))) type(SECOND); }, 6000);
    return reply(body, res, { type: 'text', text: 'PROBE-ANSWER' }, 'end_turn', 3000);
  });

  console.log('===== ' + EXE + ' =====');
  child = spawn(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '探针第一句'], { cwd: proj, env: claudeEnv(h, gw.port, Object.assign({ TERM: 'xterm-256color' }, process.env.PROBE_ENV ? { [process.env.PROBE_ENV]: '1' } : {})), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { note('到时间，结束'); killTree(child.pid); }, SECONDS * 1000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);

  console.log('任务工具：' + JSON.stringify(toolNames));
  console.log('过程：\n' + events.map((e) => '  ' + e).join('\n'));
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log('钩子：\n' + hooks.map((e) => '  ' + ((e.at - t0) / 1000).toFixed(1) + 's ' + e.ev + (e.prompt ? ' prompt=' + brief(e.prompt, 40) : '') + (e.tool ? ' tool=' + e.tool : '') + (e.active ? ' active' : '')).join('\n'));
  const plain = out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  if (process.env.PROBE_DUMP) fs.writeFileSync(process.env.PROBE_DUMP, plain);
  const stepLines = [...new Set(plain.split('\n').filter((l) => /步骤.探针/.test(l)).map((l) => l.trim()))];
  console.log('屏幕上带步骤的行（去重）：\n' + stepLines.slice(0, 12).map((l) => '  | ' + brief(l, 120)).join('\n'));
  const tail = plain.split('\n').map((l) => l.trimEnd()).filter((l) => l && !/^[─\s>]*$/.test(l));
  console.log('屏幕最后几行：\n' + tail.slice(-10).map((l) => '  | ' + brief(l, 120)).join('\n'));
  gw.close();
  const wins = await watch.stop();
  console.log('冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.cleanup();
  process.exit(0);
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

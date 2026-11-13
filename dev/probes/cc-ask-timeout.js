'use strict';
/*
 * 探测：提问框、权限确认框已经显示在屏幕上以后，钩子还能不能替用户作答（问题表第 90 条：询问发出后没人回，过一阵自动替他做主）。
 * 官方文档只说 PreToolUse 钩子能带 updatedInput.answers 替提问框作答、PermissionRequest 在"要问用户之前"触发，
 * 没说框显示以后一个慢的钩子还作不作数。这里在交互界面（winpty）里实测，家目录是假的、连假网关、不装套件。
 * 用法：node dev/probes/cc-ask-timeout.js <版本号 | claude.exe> <模式> [钩子等几秒，默认 12] [总共跑几秒，默认 等的秒数 + 40]
 * 模式：
 *   watch            不作答，只记各个钩子什么时候被调（Notification 的类型、PermissionRequest 触发不触发）
 *   perm-allow       PermissionRequest 钩子等够秒数后 allow，带 updatedInput.answers
 *   perm-deny        PermissionRequest 钩子等够秒数后 deny，带一句话
 *   perm-allow-user  同 perm-allow，但 5 秒时按回车（用户先答），看钩子后到的决定还起不起作用
 *   pre-allow        PreToolUse 钩子等够秒数后 allow，带 updatedInput.answers（等的时候屏幕上有没有提问框）
 *   bash-perm-allow  模型调一条没放行的 Bash，PermissionRequest 钩子等够秒数后 allow（权限确认框）
 *       PROBE_DUMP=<文件>  把屏幕内容存下来
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { H, exeOf, brief, isMain, reply, fakeGateway, claudeEnv, killTree } = require('./common');

const EXE = exeOf(process.argv[2]);
const MODE = String(process.argv[3] || 'watch');
const WAIT = Number(process.argv[4]) || 12;
const SECONDS = Number(process.argv[5]) || WAIT + 40;
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));
const QUESTION = 'PROBE-QUESTION-ZZZ which plan';
const ANSWER = 'PLAN-BBB';
const DENY = 'PROBE-DENY-TEXT nobody answered, decide yourself';
const MODES = {
  watch: null,
  'perm-allow': { event: 'PermissionRequest', tool: 'AskUserQuestion', behavior: 'allow' },
  'perm-deny': { event: 'PermissionRequest', tool: 'AskUserQuestion', behavior: 'deny' },
  'perm-allow-user': { event: 'PermissionRequest', tool: 'AskUserQuestion', behavior: 'allow' },
  'pre-allow': { event: 'PreToolUse', tool: 'AskUserQuestion', behavior: 'allow' },
  'bash-perm-allow': { event: 'PermissionRequest', tool: 'Bash', behavior: 'allow' },
};

/** 钩子的正文：整个函数转成文字写进假用户目录。只记日志；轮到它作答时等够秒数再输出决定 */
function hookMain(LOG, CONF) {
  const fs = require('fs');
  const ev = process.argv[2];
  const log = (o) => fs.appendFileSync(LOG, JSON.stringify(Object.assign({ ev, at: Date.now(), pid: process.pid }, o)) + '\n');
  let s = '';
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(s); } catch (e) { /* 不是 JSON */ }
    log({ what: '收到', tool: j.tool_name, type: j.notification_type, message: j.message, keys: Object.keys(j), response: j.tool_response });
    const d = CONF.decide;
    if (!d || d.event !== ev || j.tool_name !== d.tool) return;
    setTimeout(() => {
      const input = j.tool_input || {};
      const first = ((input.questions || [])[0] || {}).question || '';
      const answered = d.tool === 'AskUserQuestion' ? Object.assign({}, input, { answers: { [first]: CONF.answer } }) : input;
      let out;
      if (ev === 'PreToolUse') out = { hookSpecificOutput: { hookEventName: ev, permissionDecision: d.behavior, permissionDecisionReason: CONF.denyText, updatedInput: d.behavior === 'allow' ? answered : undefined } };
      else out = { hookSpecificOutput: { hookEventName: ev, decision: d.behavior === 'allow' ? { behavior: 'allow', updatedInput: answered } : { behavior: 'deny', message: CONF.denyText } } };
      log({ what: '给出决定', behavior: d.behavior });
      process.stdout.write(JSON.stringify(out));
    }, d.wait * 1000);
  });
  process.on('exit', (c) => log({ what: '钩子进程退出', code: c }));
}

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  if (!(MODE in MODES)) { console.log('不认识的模式：' + MODE + '。可用：' + Object.keys(MODES).join('、')); process.exit(2); }
  const watch = await H.watchWindows('pat-win');
  const h = H.freshHome('pat');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const hookLog = path.join(h.root, 'hooks.log');
  const hookJs = path.join(h.root, 'hook.js');
  const decide = MODES[MODE] ? Object.assign({ wait: WAIT }, MODES[MODE]) : null;
  fs.writeFileSync(hookJs, '(' + hookMain.toString() + ')(' + JSON.stringify(hookLog) + ', ' + JSON.stringify({ decide, answer: ANSWER, denyText: DENY }) + ');\n');
  const cmd = (ev, matcher) => [Object.assign(matcher ? { matcher } : {}, { hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '" ' + ev, timeout: WAIT + 60 }] })];
  const tools = 'AskUserQuestion|Bash';
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' }, hooks: { PreToolUse: cmd('PreToolUse', tools), PermissionRequest: cmd('PermissionRequest', tools), PostToolUse: cmd('PostToolUse', tools), Notification: cmd('Notification'), Stop: cmd('Stop') } }, null, 2));

  const t0 = Date.now(); const sec = (t) => (((t || Date.now()) - t0) / 1000).toFixed(1) + 's';
  const events = []; const note = (s, t) => events.push({ at: t || Date.now(), s });
  const blocks = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
  const strip = (s) => String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '<提醒…>');
  const describe = (m) => blocks(m).map((b) => (b.type === 'text' ? '文字[' + brief(strip(b.text), 160) + ']' : b.type === 'tool_result' ? '工具结果' + (b.is_error ? '（出错）' : '') + '[' + brief(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 300) + ']' : b.type)).join(' + ');
  let n = 0; let hasAsk = null;
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn', 3000);
    n++;
    if (hasAsk === null) hasAsk = (body.tools || []).some((t) => t.name === 'AskUserQuestion');
    note('请求#' + n + ' 最后一条：' + describe(body.messages[body.messages.length - 1]));
    if (n === 1) {
      const block = MODE === 'bash-perm-allow'
        ? { type: 'tool_use', id: 'toolu_probe_bash', name: 'Bash', input: { command: 'node -e "console.log(\'PROBE-BASH-RAN\')"', description: 'probe' } }
        : { type: 'tool_use', id: 'toolu_probe_ask', name: 'AskUserQuestion', input: { questions: [{ question: QUESTION, header: 'Plan', multiSelect: false, options: [{ label: 'PLAN-AAA', description: 'first option' }, { label: ANSWER, description: 'second option' }] }] } };
      note('回：调 ' + block.name);
      return reply(body, res, block, 'tool_use', 3000);
    }
    return reply(body, res, { type: 'text', text: 'PROBE-DONE-' + n }, 'end_turn', 3000);
  });

  console.log('===== ' + EXE + ' 模式 ' + MODE + '，钩子等 ' + WAIT + ' 秒，总共跑 ' + SECONDS + ' 秒 =====');
  const child = spawn(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, 'ask me one question'], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let screen = ''; let seenDialog = 0; let pressed = false;
  const marker = MODE === 'bash-perm-allow' ? /Do you want to proceed|PROBE-BASH-RAN'\)/ : /PROBE-QUESTION-ZZZ/;
  child.stdout.on('data', (d) => {
    screen += d;
    const plain = String(d).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    if (!seenDialog && marker.test(plain)) { seenDialog = Date.now(); note('屏幕上出现了' + (MODE === 'bash-perm-allow' ? '权限确认框' : '提问框')); }
    if (/PROBE-DONE-\d/.test(plain)) note('屏幕上出现了模型的下一句回复');
  });
  child.stderr.on('data', (d) => { screen += d; });
  const tick = setInterval(() => {
    if (MODE === 'perm-allow-user' && seenDialog && !pressed && Date.now() - seenDialog > 5000) { pressed = true; note('按回车（用户先答，选第一项）'); child.stdin.write('\r'); }
  }, 250);
  await new Promise((r) => { const timer = setTimeout(() => { killTree(child.pid); }, SECONDS * 1000); child.on('close', () => { clearTimeout(timer); r(); }); });
  clearInterval(tick);

  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const e of hooks) note('钩子 ' + e.ev + '（进程 ' + e.pid + '）' + e.what + (e.tool ? ' 工具=' + e.tool : '') + (e.type ? ' 类型=' + e.type : '') + (e.message ? ' 消息=' + brief(e.message, 80) : '') + (e.behavior ? ' ' + e.behavior : '') + (e.code !== undefined ? ' 退出码=' + e.code : '') + (e.response ? ' 工具返回=' + brief(JSON.stringify(e.response), 260) : ''), e.at);
  events.sort((a, b) => a.at - b.at);
  console.log('请求里' + (hasAsk ? '有' : '没有') + ' AskUserQuestion 这个工具');
  console.log('时间线：\n' + events.map((e) => '  ' + sec(e.at).padStart(6) + ' ' + e.s).join('\n'));
  const first = hooks.find((e) => e.what === '收到' && e.ev === 'PermissionRequest');
  const decided = hooks.find((e) => e.what === '给出决定');
  const req2 = events.find((e) => /^请求#2/.test(e.s));
  console.log('小结：PermissionRequest 钩子' + (first ? '被调了（' + sec(first.at) + '）' : '没被调') + '；框' + (seenDialog ? '在 ' + sec(seenDialog) + ' 显示' : '没显示') + '；钩子' + (decided ? '在 ' + sec(decided.at) + ' 给出决定' : '没给出决定') + '；第二个请求' + (req2 ? '在 ' + sec(req2.at) + ' 发出' : '没发出（会话一直停在框上）'));
  if (process.env.PROBE_DUMP) fs.writeFileSync(process.env.PROBE_DUMP, screen);
  const lines = screen.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  const tail = []; for (const l of lines.slice(-80)) if (!/^[─\s>]*$/.test(l) && tail[tail.length - 1] !== l) tail.push(l);
  console.log('屏幕最后几行：\n' + tail.slice(-16).map((l) => '    | ' + brief(l, 160)).join('\n'));
  gw.close();
  const wins = await watch.stop();
  console.log('探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：提问框超时作答 ' + MODE);
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

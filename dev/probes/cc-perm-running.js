'use strict';
/*
 * 探测（全量审核 B4，2026-11-21）：权限确认框用户点了允许、命令还在跑的时候，会话记录里写了什么。
 * ask-timeout 现在只认"这次调用有了结果"或者"后面有用户的话"：命令跑得比等待时间还久，到点照样记一条"替你点了允许"。
 * 要找的是：点了允许之后、结果出来之前，会话记录里有没有能当"已经批准、在跑"的条目（progress 这类）。
 * 交互界面（winpty），家目录是假的、连假网关、不装套件；模型调一条要等 20 秒的 Bash，框出来 3 秒后按回车（选第一项"允许"）。
 * 用法：node dev/probes/cc-perm-running.js <版本号 | claude.exe> [命令跑几秒，默认 20]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { H, exeOf, brief, isMain, reply, fakeGateway, claudeEnv, killTree } = require('./common');

const EXE = exeOf(process.argv[2]);
const RUN = Number(process.argv[3]) || 20;
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));

/** 钩子：只记收到了什么（PermissionRequest 带着 transcript_path），不作答 */
function hookMain(LOG) {
  const fs = require('fs');
  let s = '';
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => {
    let j = {}; try { j = JSON.parse(s); } catch (e) { /* 不是 JSON */ }
    fs.appendFileSync(LOG, JSON.stringify({ ev: j.hook_event_name, at: Date.now(), tool: j.tool_name, transcript: j.transcript_path, keys: Object.keys(j) }) + '\n');
  });
}

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  const watch = await H.watchWindows('cpr-win');
  const h = H.freshHome('cpr');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const hookLog = path.join(h.root, 'hooks.log');
  const hookJs = path.join(h.root, 'hook.js');
  fs.writeFileSync(hookJs, '(' + hookMain.toString() + ')(' + JSON.stringify(hookLog) + ');\n');
  const cmd = [{ hooks: [{ type: 'command', command: '"' + process.execPath + '" "' + hookJs + '"', timeout: 30 }] }];
  fs.writeFileSync(path.join(h.cfg, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' }, hooks: { PermissionRequest: cmd, PostToolUse: cmd, PreToolUse: cmd } }, null, 2));

  const t0 = Date.now(); const sec = (t) => (((t || Date.now()) - t0) / 1000).toFixed(1) + 's';
  const events = []; const note = (s, t) => events.push({ at: t || Date.now(), s });
  let n = 0;
  const gw = await fakeGateway((body, res) => {
    if (!isMain(body)) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn', 3000);
    n++;
    note('请求#' + n);
    if (n === 1) return reply(body, res, { type: 'tool_use', id: 'toolu_probe_run', name: 'Bash', input: { command: 'node -e "setTimeout(()=>console.log(\'PROBE-RUN-DONE\'),' + RUN * 1000 + ')"', description: 'probe', timeout: (RUN + 60) * 1000 } }, 'tool_use', 3000);
    return reply(body, res, { type: 'text', text: 'PROBE-END' }, 'end_turn', 3000);
  });
  console.log('===== ' + EXE + '，命令跑 ' + RUN + ' 秒 =====');
  const child = spawn(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, 'run it'], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let seenDialog = 0; let pressed = 0;
  child.stdout.on('data', (d) => {
    const plain = String(d).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    if (!seenDialog && /Do you want to proceed/.test(plain)) { seenDialog = Date.now(); note('屏幕上出现了权限确认框'); }
  });
  // 盯着会话记录：每半秒读一次，新出现的行记下类型和关键字段
  let tfile = ''; let seenLines = 0; let resultAt = 0;
  const tick = setInterval(() => {
    if (seenDialog && !pressed && Date.now() - seenDialog > 3000) { pressed = Date.now(); note('按回车（选第一项：允许）'); child.stdin.write('\r'); }
    if (!tfile && fs.existsSync(hookLog)) { const l = fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.transcript); if (l) tfile = l.transcript; }
    if (!tfile || !fs.existsSync(tfile)) return;
    const lines = fs.readFileSync(tfile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(seenLines)) {
      let e = {}; try { e = JSON.parse(l); } catch (x) { continue; }
      const c = e.message && e.message.content;
      const blocks = Array.isArray(c) ? c.map((b) => b.type + (b.type === 'tool_result' ? '(' + b.tool_use_id + ')' : b.type === 'tool_use' ? '(' + b.id + ')' : '')).join(',') : typeof c === 'string' ? 'text' : '';
      const data = e.data && typeof e.data === 'object' ? ' data.type=' + e.data.type : '';
      const ids = ['toolUseID', 'parentToolUseID', 'tool_use_id', 'sourceToolUseID'].filter((k) => e[k]).map((k) => k + '=' + e[k]).join(' ');
      note('会话记录 +1：type=' + e.type + (e.subtype ? ' subtype=' + e.subtype : '') + data + (blocks ? ' [' + blocks + ']' : '') + (ids ? ' ' + ids : '') + ' 键：' + Object.keys(e).filter((k) => !/^(parentUuid|uuid|sessionId|cwd|version|gitBranch|userType|isSidechain|timestamp)$/.test(k)).join(','));
      if (/tool_result\(toolu_probe_run\)/.test(blocks)) resultAt = Date.now();
    }
    seenLines = lines.length;
  }, 500);
  await new Promise((r) => { const timer = setTimeout(() => killTree(child.pid), (RUN + 60) * 1000); const stop = setInterval(() => { if (resultAt && Date.now() - resultAt > 5000) { clearInterval(stop); killTree(child.pid); } }, 500); child.on('close', () => { clearTimeout(timer); clearInterval(stop); r(); }); });
  clearInterval(tick);
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const e of hooks) note('钩子 ' + e.ev + ' 工具=' + e.tool, e.at);
  events.sort((a, b) => a.at - b.at);
  console.log('时间线：\n' + events.map((e) => '  ' + sec(e.at).padStart(6) + ' ' + brief(e.s, 260)).join('\n'));
  console.log('小结：框' + (seenDialog ? '在 ' + sec(seenDialog) + ' 出现' : '没出现') + '，' + (pressed ? sec(pressed) + ' 按了允许' : '没按') + '，工具结果' + (resultAt ? '在 ' + sec(resultAt) + ' 写进会话记录' : '没等到') + '。看"按了允许"和"工具结果"之间有没有新的条目');
  gw.close();
  const wins = await watch.stop();
  console.log('探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：确认框点了允许、命令还在跑');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

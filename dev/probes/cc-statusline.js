'use strict';
/*
 * 探测：交互界面（不是 -p）里状态栏照不照常：脚本被调了没有、多久调一次、给它的输入长什么样、几行都显示出来没有。
 * 交互界面要一个终端：用 Git for Windows 带的 winpty（-Xallow-non-tty -Xplain）在看不见的控制台里跑，把屏幕抓成文本。
 * 套件用真的 install.js 装进假用户目录（--no-router）。状态栏的命令外面包一层，把每次收到的输入存下来。
 * 用法：node dev/probes/cc-statusline.js <版本号 | claude.exe> [跑多少秒，默认 80]
 *       PROBE_USED=300000  假网关报的上下文用量
 *       PROBE_MODE=kit（默认：套件装成什么样就什么样）| default（只写 defaultMode: default，看会不会弹"要不要把自动模式设成默认"）
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, brief, isMain, reply, fakeGateway, claudeEnv, runFor } = require('./common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 80;
const USED = Number(process.env.PROBE_USED) || 300000;
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  const watch = await H.watchWindows('psl-win');
  const log = [];
  const gw = await fakeGateway((body, res) => { log.push(body.model + ' 工具 ' + (body.tools || []).length); reply(body, res, { type: 'text', text: isMain(body) ? 'PROBE-REPLY-OK' : 'ok' }, 'end_turn', USED); }, (req) => log.push(req.method + ' ' + req.url));
  const h = H.freshHome('psl');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  // 状态栏外面包一层：把输入存下来，再交给套件的状态栏
  const dumpDir = path.join(h.root, 'sl');
  fs.mkdirSync(dumpDir, { recursive: true });
  const wrap = path.join(h.root, 'sl-wrap.js');
  fs.writeFileSync(wrap, [
    "'use strict';",
    "const fs = require('fs'); const path = require('path'); const { spawnSync } = require('child_process');",
    "let raw = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { raw += c; }); process.stdin.on('end', () => {",
    '  const dir = ' + JSON.stringify(dumpDir) + ';',
    "  const n = String(fs.readdirSync(dir).filter((x) => /^in-/.test(x)).length + 1).padStart(3, '0');",
    "  fs.writeFileSync(path.join(dir, 'in-' + n + '.json'), raw);",
    '  const r = spawnSync(process.execPath, [' + JSON.stringify(path.join(h.kit, 'statusline.js')) + "], { input: raw, encoding: 'utf8', windowsHide: true });",
    "  fs.writeFileSync(path.join(dir, 'out-' + n + '.txt'), String(r.stdout || ''));",
    "  process.stdout.write(String(r.stdout || ''));",
    '});',
  ].join('\n'));
  const sf = path.join(h.cfg, 'settings.json');
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  console.log('===== ' + EXE + ' =====');
  console.log('安装：退出码 ' + inst.code + '；安装器写的 statusLine：' + JSON.stringify(s.statusLine) + '；autoCompactWindow ' + s.autoCompactWindow + '；disableAutoMode ' + (s.permissions || {}).disableAutoMode);
  s.statusLine = Object.assign({}, s.statusLine, { command: 'node "' + wrap.split(path.sep).join('/') + '"' });
  if (process.env.PROBE_MODE === 'default') { delete s.permissions.disableAutoMode; s.permissions.defaultMode = 'default'; }
  fs.writeFileSync(sf, JSON.stringify(s, null, 2));
  // 跳过第一次启动的引导、信任这个目录
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));

  const r = await runFor(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '说一句话'], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color' }), stdio: ['pipe', 'pipe', 'pipe'] }, SECONDS);
  const lines = r.out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  console.log('假网关收到：' + log.join('；'));
  const dumps = fs.readdirSync(dumpDir).filter((n) => /^in-/.test(n)).sort();
  console.log('状态栏脚本被调了 ' + dumps.length + ' 次' + (dumps.length > 1 ? '，各次相隔（秒）：' + dumps.map((n) => fs.statSync(path.join(dumpDir, n)).mtimeMs).map((t, i, a) => (i ? ((t - a[i - 1]) / 1000).toFixed(1) : null)).filter(Boolean).join('、') : ''));
  if (dumps.length) {
    const first = JSON.parse(fs.readFileSync(path.join(dumpDir, dumps[0]), 'utf8'));
    const last = JSON.parse(fs.readFileSync(path.join(dumpDir, dumps[dumps.length - 1]), 'utf8'));
    console.log('给状态栏的输入有这些字段：' + Object.keys(last).join('、'));
    console.log('  第一次的 context_window：' + JSON.stringify(first.context_window));
    console.log('  最后一次的 context_window：' + JSON.stringify(last.context_window));
    console.log('  model ' + JSON.stringify(last.model) + '；version ' + last.version + '；workspace.current_dir ' + (last.workspace && last.workspace.current_dir ? '有' : '没有') + '；session_id ' + (last.session_id ? '有' : '没有') + '；transcript_path ' + (last.transcript_path ? '有' : '没有'));
    console.log('最后一次状态栏脚本的输出：\n' + fs.readFileSync(path.join(dumpDir, dumps[dumps.length - 1].replace('in-', 'out-').replace('.json', '.txt')), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).map((l) => '    | ' + l).join('\n'));
  }
  const want = [['第一行（上下文百分比）', /上下文 .*\d+%/], ['第二行（全自动开没开）', /全自动 (开|关)/], ['模型的回复', /PROBE-REPLY-OK/], ['"要不要把自动模式设成默认"的弹框', /Make auto mode your default/], ['权限模式那一行', /(manual|auto|bypass)[^\n]{0,30} mode on|permissions on/i]];
  console.log('屏幕上抓到的：' + want.map(([n, re]) => n + '=' + (lines.some((l) => re.test(l)) ? '有' : '没有')).join('；'));
  const tail = []; for (const l of lines.slice(-60)) if (!/^[─\s>]*$/.test(l) && tail[tail.length - 1] !== l) tail.push(l);
  console.log('屏幕最后几行：\n' + tail.slice(-14).map((l) => '    | ' + brief(l, 160)).join('\n'));
  gw.close();
  const wins = await watch.stop();
  console.log('探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：状态栏');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

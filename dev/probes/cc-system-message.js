'use strict';
/*
 * 探测：用户开口的钩子（UserPromptSubmit）用 JSON 输出时，systemMessage 在交互界面里显示不显示、additionalContext 送不送得到模型。
 * 套件 1008 起开工（/opsx:apply、"开工"）时用这两样告诉用户全自动开没开。
 * 做法和 cc-statusline.js 一样：套件用真的 install.js 装进假用户目录（--no-router），用 winpty 在看不见的控制台里跑交互界面，
 * 项目里放一个已经打过勾的变更，开口说"开工，接着做 add-x"，抓屏幕上有没有 "[vibe-kit] 开始 apply"，看假网关收到的请求里有没有给模型的那一行。
 * 用法：node dev/probes/cc-system-message.js <版本号 | claude.exe> [跑多少秒，默认 80]
 *       PROBE_PROMPT=做一个导出订单的功能   换一句开口的话（不开工，钩子输出的是纯文本：拿来对照纯文本的提醒送不送得到）
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, brief, isMain, reply, fakeGateway, claudeEnv, runFor, systemOf, textOf } = require('./common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 80;
const PROMPT = process.env.PROBE_PROMPT || '开工，接着做 add-x';
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));
const HINT = /\[vibe-kit 提醒\]/;

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  const watch = await H.watchWindows('psm-win');
  const log = [];
  const seen = { context: false, userMsgs: [], system: '' };
  const gw = await fakeGateway((body, res) => {
    log.push(body.model + ' 工具 ' + (body.tools || []).length);
    if (isMain(body)) {
      seen.userMsgs = [];
      for (const m of body.messages || []) if (m.role === 'user') { const t = textOf(m); seen.userMsgs.push(t); if (HINT.test(t)) seen.context = true; }
      seen.system = systemOf(body);
      if (HINT.test(seen.system)) seen.context = true;
    }
    reply(body, res, { type: 'text', text: isMain(body) ? 'PROBE-REPLY-OK' : 'ok' }, 'end_turn', 3000);
  }, (req) => log.push(req.method + ' ' + req.url));
  const h = H.freshHome('psm');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n', 'src/A.java': 'class A {}\n', 'openspec/changes/add-x/tasks.md': '- [x] 1.1 改 src/A.java；验：人工看\n- [ ] 1.2 改 src/A.java；验：人工看\n' });
  console.log('===== ' + EXE + ' =====');
  console.log('安装：退出码 ' + inst.code + '；开口说的是："' + PROMPT + '"');
  // 跳过第一次启动的引导、信任这个目录
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));

  const r = await runFor(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, PROMPT], { cwd: proj, env: claudeEnv(h, gw.port, { TERM: 'xterm-256color' }), stdio: ['pipe', 'pipe', 'pipe'] }, SECONDS);
  const lines = r.out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  console.log('假网关收到：' + log.join('；'));
  const flowFile = fs.readdirSync(path.join(h.kit, 'state')).filter((n) => /-flow\.json$/.test(n));
  console.log('流程记录：' + flowFile.map((n) => n + ' ' + fs.readFileSync(path.join(h.kit, 'state', n), 'utf8')).join(' | '));
  const want = [['屏幕上的 systemMessage（[vibe-kit] 开始 apply）', /\[vibe-kit\] 开始 apply/], ['模型的回复', /PROBE-REPLY-OK/]];
  console.log('屏幕上抓到的：' + want.map(([n, re]) => n + '=' + (lines.some((l) => re.test(l)) ? '有' : '没有')).join('；'));
  console.log('给模型的提醒（[vibe-kit 提醒] …）送到了没有：' + (seen.context ? '送到了' : '没送到'));
  const strip = (s) => String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '<system-reminder…>');
  console.log('模型看到的用户消息（最后两条，去掉 system-reminder）：\n' + seen.userMsgs.slice(-2).map((s) => '    | ' + brief(strip(s), 600)).join('\n'));
  const si = seen.system.indexOf('[vibe-kit 提醒]');
  if (si >= 0) console.log('提醒出现在系统提示里：' + brief(seen.system.slice(Math.max(0, si - 80), si + 300), 400));
  const tail = []; for (const l of lines.slice(-60)) if (!/^[─\s>]*$/.test(l) && tail[tail.length - 1] !== l) tail.push(l);
  console.log('屏幕最后几行：\n' + tail.slice(-14).map((l) => '    | ' + brief(l, 160)).join('\n'));
  gw.close();
  const wins = await watch.stop();
  console.log('探测过程中桌面上冒出来的窗口：' + (wins.length ? JSON.stringify(wins) : '没有'));
  H.done('探测：开工时的 systemMessage');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

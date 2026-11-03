'use strict';
/*
 * 探测：敲 /vk-config（用户开口的钩子起配置页、decision:block）：发不发模型请求、屏幕上看不看得到地址。
 * 交互界面，winpty 跑在看不见的控制台里，假用户目录，不开浏览器。
 * 用法：node dev/probes/cc-vk-config.js <版本号 | claude.exe> [跑多少秒，默认 40]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { H, exeOf, isMain, reply, fakeGateway, claudeEnv, runFor } = require('./common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 40;
const PORT = 18797;
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  const watch = await H.watchWindows('pvc-win');
  const main = []; const seen = [];
  const gw = await fakeGateway((body, res) => {
    if (isMain(body)) { main.push(body.model); seen.push((body.messages || []).map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(' '))).join(' | ').slice(-400)); }
    reply(body, res, { type: 'text', text: isMain(body) ? 'PROBE-REPLY-OK' : 'ok' }, 'end_turn', 3000);
  }, () => {});
  const h = H.freshHome('pvc');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-open'], { cwd: h.root, timeout: 180000 });
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'README.md': '# x\n' });
  console.log('===== ' + EXE + ' =====');
  console.log('安装：退出码 ' + inst.code);
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const env = claudeEnv(h, gw.port, { TERM: 'xterm-256color', MSYS2_ARG_CONV_EXCL: '*', MSYS_NO_PATHCONV: '1', VIBE_KIT_CONFIG_PORT: String(PORT), VIBE_KIT_NO_BROWSER: '1', VIBE_KIT_CONFIG_NOBODY_MS: String((SECONDS + 10) * 1000) });
  const r = await runFor(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '//vk-config'], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, SECONDS);
  const text = r.out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  const ui = await new Promise((resolve) => { const q = http.get({ host: '127.0.0.1', port: PORT, path: '/ui', agent: false, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', () => resolve(0)); q.on('timeout', () => { q.destroy(); resolve(0); }); });
  console.log('主会话的模型请求：' + main.length + ' 个');
  console.log('模型看到：' + seen.join('\n'));
  console.log('钩子流水账：' + (H.read(path.join(h.kit, 'state', 'hooks.log')) || '').split('\n').filter((l) => /task-anchor|UserPrompt/.test(l)).slice(-5).join('\n').slice(0, 800));
  console.log('反馈：' + fs.readdirSync(path.join(h.kit, 'feedback')).slice(0, 5).join(','));
  const st = JSON.parse(H.read(path.join(h.cfg, 'settings.json')) || '{}');
  console.log('登记的开口钩子：' + JSON.stringify((st.hooks || {}).UserPromptSubmit || []).slice(0, 300));
  console.log('状态目录：' + fs.readdirSync(path.join(h.kit, 'state')).join(',').slice(0, 400));
  console.log('屏幕全文：\n' + [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))].filter((l) => !/^[─-]+$/.test(l)).join('\n').slice(0, 1500));
  console.log('屏幕上有地址：' + (new RegExp('配置页：\\s*http://127\\.0\\.0\\.1:' + PORT).test(text.replace(/\n\s*/g, '')) ? '有' : '没有'));
  console.log('配置页答话：' + ui);
  console.log('屏幕最后几行：\n' + text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-12).join('\n'));
  try { process.kill(JSON.parse(fs.readFileSync(path.join(h.kit, 'state', 'config-page.json'), 'utf8')).pid); } catch (e) { /* 已经退了 */ }
  await gw.close();
  const wins = await watch.stop();
  console.log('桌面上冒出来的窗口：' + (wins.length ? wins.join('、') : '没有'));
  H.cleanup();
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

'use strict';
/*
 * 探测：真 CLI 里敲 /vk-resume <变更名>：带参数的斜杠命令钩子收不收得到、切得过去没有、屏幕上说没说、状态栏跟没跟。
 * 交互界面，winpty 跑在看不见的控制台里，假用户目录。Git Bash 下参数要写 //vk-resume，不然被改写成路径（见 facts）。
 * 用法：node dev/probes/cc-vk-resume.js <版本号 | claude.exe> [跑多少秒，默认 35]
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, isMain, reply, fakeGateway, claudeEnv, runFor } = require('./common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 35;
const WINPTY = ['C:/Program Files/Git/usr/bin/winpty.exe', 'C:/Program Files (x86)/Git/usr/bin/winpty.exe'].find((p) => fs.existsSync(p));
const walk = (d, out) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f, out); else out.push(f); } return out; };

(async () => {
  if (!WINPTY) { console.log('没找到 winpty.exe（Git for Windows 带的），这个探测跑不了'); process.exit(2); }
  const watch = await H.watchWindows('pvr-win');
  const seen = [];
  const gw = await fakeGateway((body, res) => {
    if (isMain(body)) seen.push(JSON.stringify(body.messages || []).includes('切到这个 change'));
    reply(body, res, { type: 'text', text: isMain(body) ? 'PROBE-REPLY-OK' : 'ok' }, 'end_turn', 3000);
  }, () => {});
  const h = H.freshHome('pvr');
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-open'], { cwd: h.root, timeout: 180000 });
  const table = '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | first-c | 进行中 | |\n| | second-c | 进行中 | |\n';
  const files = { 'README.md': '# x\n', 'openspec/plan.md': '# 计划\n\n' + table };
  for (const c of ['first-c', 'second-c']) {
    files['openspec/changes/' + c + '/proposal.md'] = '## Why\n要做。\n';
    files['openspec/changes/' + c + '/tasks.md'] = '## 1. 实现\n\n- [x] 1.1 改 a\n- [ ] 1.2 改 b\n';
  }
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), files);
  console.log('===== ' + EXE + ' =====');
  console.log('安装：退出码 ' + inst.code);
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [proj.split(path.sep).join('/')]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const env = claudeEnv(h, gw.port, { TERM: 'xterm-256color' });
  const r = await runFor(WINPTY, ['-Xallow-non-tty', '-Xplain', EXE, '//vk-resume second-c'], { cwd: proj, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }, SECONDS);
  const text = r.out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  const flows = walk(path.join(h.kit, 'state'), []).filter((f) => /flow\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } });
  const fl = flows.find((x) => x.current) || flows[0] || {};
  const flat = text.replace(/\n\s*/g, '');
  console.log('流程状态：on=' + fl.on + ' stage=' + fl.stage + ' current=' + fl.current);
  console.log('屏幕上说切到了：' + (/切到 second-c/.test(flat) ? '有' : '没有'));
  console.log('状态栏跟着它：' + (/second-c\(2\/2\)/.test(flat) ? '有' : '没有'));
  console.log('模型收到了提醒：' + (seen.some(Boolean) ? '有' : '没有') + '（主会话请求 ' + seen.length + ' 个）');
  await gw.close();
  const wins = await watch.stop();
  console.log('桌面上冒出来的窗口：' + (wins.length ? wins.join('、') : '没有'));
  H.cleanup();
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

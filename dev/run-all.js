'use strict';
/*
 * 依次跑这个目录里的全部测试，最后汇总。
 *   node dev/run-all.js                                   单元测试、安装、配置页接口、HTTP 钩子
 *   node dev/run-all.js --old <上一版的 vibe-kit 目录> [--old <更早一版的>]    再加上：新旧钩子对比（每个都比一遍）、
 *                                   旧版复现和从老版本升级（只对 20260925.1411 那一版做：那几个毛病是它的）
 *   node dev/run-all.js --claude <claude.exe> [--claude <另一个版本的 claude.exe>]   再加上：端到端（每个版本跑一遍）
 *   node dev/run-all.js --rt auto                 再加上：查库的技能连真的 JDBC 数据库走一遍。auto = 到正式位置找 Python、JDK、H2
 *                                                 （%LOCALAPPDATA%\Programs\Python、…\Eclipse Adoptium、~/.m2，见 dev/README.md）；
 *                                                 也可以给一个放着便携版的目录（里面有 python/python.exe、jdk/bin/java.exe、h2.jar）
 * 结尾查三件事：真实用户目录没被碰（各个测试自己查）、临时目录清干净了、桌面上没有多出窗口。
 * 2026-10-18 起分几路同时跑（--lanes，默认 3；--lanes 1 退回一个接一个），怎么排见下面"怎么排"。结尾打印每一段的用时。
 *   --only a.js,b.js,e2e,diff    只跑这几套（e2e = 全部端到端，diff = 新旧钩子对比）
 *   --since <标签>               没动过的独立模块不测（规则见 lib/affected.js）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const all = (f) => args.map((a, i) => (a === f ? args[i + 1] : null)).filter(Boolean);
const olds = all('--old');
const verOf = (d) => { try { return fs.readFileSync(path.join(d, 'kit', 'VERSION'), 'utf8').trim(); } catch (e) { return ''; } };
// 复现 0928 那批问题反馈、测"从没有经验规则的版本升级"：要 20260928.1700 之前的版本
const old = olds.find((d) => verOf(d) && verOf(d) < '20260928.1700') || '';
// 复现 0929 那批问题反馈：要 20260928.2054 / 2055 那一版
const old0929 = olds.find((d) => /^20260928\.205[45]$/.test(verOf(d))) || '';
const claudes = all('--claude');
const rt = all('--rt')[0] || '';
// 改名（ttls- 前缀）那一版：要一个还用着旧名字的版本来测"升上来会怎样"
const oldNames = olds.find((d) => verOf(d) && verOf(d) <= '20260929.2205') || '';
// 1005 那一批测"从上一版升上来"（上一版还没有 disableAutoMode）：给的旧版里比 1005 早的最新那个
const before1005 = olds.filter((d) => verOf(d) && verOf(d) < '20261005.0000').sort((a, b) => verOf(b).localeCompare(verOf(a)))[0] || '';
const ps = (cmd) => { try { return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 }); } catch (e) { return ''; } };
const windows = () => ps('Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.ProcessName + "#" + $_.Id }').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
const temps = () => fs.readdirSync(os.tmpdir()).filter((n) => /^(vkt|vke|vkz)-/.test(n));

const before = windows();
const suites = [['内网反馈 1007', 'test-feedback1007.js', [rt || 'none']], ['内网反馈 0928', 'test-feedback0928.js', []], ['内网反馈 0929', 'test-feedback0929.js', []], ['内网反馈 0930', 'test-feedback0930.js', []], ['1001：压缩、状态栏、拉代码', 'test-1001.js', []], ['1005：自动模式、约定、路由', 'test-1005.js', ['18787'].concat(before1005 ? [before1005] : [])], ['1007：产出、公共配置、端口、按阶段提交', 'test-1007.js', ['18757']], ['1008：归档、提交要点头，全自动只管 apply', 'test-1008.js', ['18737']],['看页面 0929', 'test-page-0929.js', ['18771']], ['起服务 0929', 'test-devserver-0929.js', ['18781']], ['配置页 0929', 'ui-kit-0929.js', ['18791']],
  ['查 redis', 'test-redis.js', ['18761']], ['后台自动探索', 'test-onboard.js', rt ? [rt] : []], ['自动归并、工具用量', 'test-auto-0930.js', []], ['全仓审查之后改的', 'test-review-0930.js', []], ['拦截类钩子（0930 审查）', 'test-guard-0930.js', []], ['配置页：数据库驱动', 'ui-data-0930.js', ['18795']], ['经验规则', 'test-lessons.js', []], ['安装、升级、卸载', 'test-install-0928.js', old ? [old] : []], ['配置页的经验规则', 'ui-lessons.js', ['18733', '0']], ['HTTP 方式的钩子', 'test-http-hooks.js', ['18734']], ['令牌保护、发布确认', 'test-secrets.js', []], ['自动更新和发布', 'test-update.js', ['18741']], ['问题上报和导出', 'test-issues.js', ['18743']], ['配置页的更新和上报', 'ui-update.js', ['18745', '0', '18746']]];
suites.unshift(['内网反馈 1010、提交和多版本驱动', 'test-feedback1010.js', [rt || 'none']]);
suites.unshift(['提案材料和相似入口', 'test-proposal-files.js', []]);
suites.unshift(['1017：任务只写实现、验收用例、一份一份来、自带 OpenSpec', 'test-1017.js', []]);
suites.unshift(['用 IDEA 的运行配置起服务', 'test-idea-run.js', []]);
suites.unshift(['1012 推送反馈', 'test-feedback1012-push.js', []], ['1012 流程反馈', 'test-feedback1012-workflow.js', []], ['1012 页面探针', 'test-feedback1012-page.js', []]);
suites.unshift(['1012 数据库诊断', 'test-feedback1012-db.js', [rt || 'none']]);
suites.unshift(...['workflow', 'review', 'push', 'diagnostics', 'feedback', 'decisions', 'states', 'context'].map((name) => ['1013 反馈 ' + name, 'test-feedback1013-' + name + '.js', []]));
suites.unshift(['提案审查结果有效性', 'test-proposal-review-state.js', []]);
suites.unshift(...['apply', 'stop', 'review', 'review-scope', 'review-command', 'budget', 'output', 'idea', 'push'].map((name) => ['1024 反馈 ' + name, 'test-feedback1024-' + name + '.js', []]));
if (old) suites.push(['旧版复现', 'check-old-repro.js', [old]]);
if (old0929) suites.push(['旧版复现 0929', 'check-old-repro-0929.js', [old0929]]);
if (oldNames) suites.push(['改名和并进来的技能', 'test-ttls.js', [oldNames]]);
if (rt) suites.push(['查库（H2）', 'test-dbcrud.js', [rt]]);
for (const d of olds) suites.push(['新旧钩子对比 ' + (verOf(d) || path.basename(d)), 'diff-hooks.js', [d]]);
for (const c of claudes) for (const m of ['auto', 'manual']) suites.push(['端到端（经验，' + (m === 'auto' ? '自动收' : '自己记') + '）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-lessons.js', [c, path.basename(path.resolve(c, '../../../../..')), m]]);
// 端到端几个版本同时跑：假 GitLab、假 redis 的端口每个版本错开 100（以前都传同一个，同时跑会抢端口，2026-10-18 实测）
claudes.forEach((c, i) => suites.push(['端到端（更新、令牌）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-update.js', [c, path.basename(path.resolve(c, '../../../../..')), String(18748 + 100 * i)]]));
for (const c of claudes) suites.push(['端到端（全自动）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-auto-0929.js', [c, path.basename(path.resolve(c, '../../../../..'))]]);
// 不给 --rt 的话查库那几项不测（第三个参数给一个不存在的目录）
claudes.forEach((c, i) => suites.push(['端到端（0930）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-0930.js', [c, path.basename(path.resolve(c, '../../../../..')), rt || path.join(__dirname, '没有运行环境'), String(18765 + 100 * i)]]));

suites.unshift(['IDEA MCP 自动接入', 'test-idea-mcp.js', claudes.flatMap(c => ['--claude', c])]);
suites.unshift(['IDEA MCP 保护入口', 'test-idea-tools.js', []]);

suites.unshift(['1014 非数据库反馈', 'test-feedback1014.js', []], ['1014 两阶段工作流', 'test-workflow1014.js', []]);
const rows = [];
suites.unshift(['使用情况匿名标识', 'test-usage-identity.js', []]);
suites.unshift(['归档解包的临时目录', 'test-archive-extract.js', []]);
suites.unshift(['推送预览和合并确认', 'test-push-preview.js', []]);
suites.unshift(['服务实际地址', 'test-service-address.js', []]);
for (const [name, file] of [['状态并发和恢复', 'test-workflow-state.js'], ['用户意图与许可', 'test-workflow-intent.js'], ['许可与上下文', 'test-workflow-permissions.js'], ['连接生命周期', 'test-connection-lifecycle.js'], ['诊断脱敏', 'test-diagnostic-redaction.js'], ['审查和执行证据', 'test-review-evidence.js'], ['运行流程优化', 'test-optimization-runtime.js'], ['优化边界', 'test-optimization-boundaries.js']]) suites.unshift([name, file, []]);
// --only a.js,b.js：只跑这几套（日常专项用；发版必须全量，不带它）。e2e 代表全部端到端（每个 --claude 版本），diff 代表新旧钩子对比（每个 --old）
const only = all('--only').flatMap((s) => s.split(',')).map((s) => path.basename(s.trim())).filter(Boolean);
const picked = (file) => only.includes(file) || (only.includes('e2e') && /^e2e-/.test(file)) || (only.includes('diff') && file === 'diff-hooks.js');
if (only.length) { for (let i = suites.length - 1; i >= 0; i--) if (!picked(suites[i][1])) suites.splice(i, 1); console.log('只跑：' + suites.map((s) => s[0]).join('、')); }
// --since <标签>：没动过的独立模块（查库、起服务、看页面、redis）不测，发版时带上一版的标签。判断规则见 lib/affected.js：模块自己的目录、
// 测试脚本和它 require 的测试支架、直接调到的套件脚本，从这个标签以来一个都没改过才跳过，判断不了就照测。跳过了什么在开头和结尾都打印
const since = all('--since')[0] || '';
const skipped = [];
if (since) {
  const p = require('./lib/affected').plan(since);
  if (!p.ok) console.log(p.why);
  for (const s of p.skip) {
    for (let i = suites.length - 1; i >= 0; i--) if (s.suites.includes(suites[i][1])) suites.splice(i, 1);
    skipped.push(s.module + '（' + s.suites.join('、') + '：用到的 ' + s.files + ' 个文件从 ' + since + ' 以来都没改过）');
  }
  for (const r of p.run) console.log('照测 ' + r.module + '：从 ' + since + ' 以来改过 ' + (r.changed ? r.changed.length + ' 个用到的文件，比如 ' + r.changed.slice(0, 3).join('、') : '（判断不了）'));
  console.log('跳过：' + (skipped.length ? skipped.join('；') : '没有'));
}
// 每套的完整输出存到 .vibe/tmp/run-all-<时间>/，失败时打印每个失败项和它下面的说明（以前只打印前 30 行，常常只看到原因的第一行）
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const LOGS = path.join(__dirname, '..', '.vibe', 'tmp', 'run-all-' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '-' + pad2(now.getHours()) + pad2(now.getMinutes()));
fs.mkdirSync(LOGS, { recursive: true });
function runSuite(name, file, a) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = ''; let done = false;
    const p = spawn(process.execPath, [path.join(__dirname, file)].concat(a), { windowsHide: true });
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\n（超过 20 分钟，结束这一套）'; try { p.kill(); } catch (e) { /* 已经退了 */ } }, 1200000);
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ name, file, code, out, sec: Math.round((Date.now() - t0) / 1000) }); };
    p.on('close', finish); p.on('error', (e) => { out += String(e); finish(-1); });
  });
}
function report(r, index) {
  const log = path.join(LOGS, pad2(index + 1) + '-' + path.basename(r.file, '.js') + '.log');
  try { fs.writeFileSync(log, r.out); } catch (e) { /* 存不了日志不影响结果 */ }
  const last = r.out.trim().split(/\r?\n/).filter((l) => /^\[(OK|X)\]/.test(l)).pop() || '(没有汇总行)';
  const m = last.match(/通过 (\d+) 项(?:，失败 (\d+) 项)?/);
  rows.push({ name: r.name, ok: r.code === 0, pass: m ? Number(m[1]) : 0, fail: m ? Number(m[2] || 0) : 0, sec: r.sec, out: r.out });
  console.log((r.code === 0 ? '[OK] ' : '[X]  ') + r.name.padEnd(20) + ' 通过 ' + (m ? m[1] : '?') + (m && m[2] ? '，失败 ' + m[2] : '') + '（' + r.sec + ' 秒）');
  if (r.code === 0) return;
  const lines = r.out.split(/\r?\n/); const shown = [];
  for (let i = 0; i < lines.length && shown.length < 200; i++) {
    if (!/^\s+\[X\]|测试脚本出错|端到端脚本出错/.test(lines[i])) continue;
    shown.push(lines[i]);
    for (let k = i + 1; k < lines.length && k <= i + 20 && /^\s{4,}/.test(lines[k]) && !/^\s+\[(OK|X)\]/.test(lines[k]); k++) shown.push(lines[k]);
  }
  console.log((shown.length ? shown : lines.slice(-20)).join('\n'));
  console.log('      完整输出：' + log);
}
// ---------- 怎么排（2026-10-18 起；实测数据见 docs/release-timing.md） ----------
//   1. 一般的套分几路同时跑（--lanes，默认 3：8 核机器上 3 套同时跑快 2.6 倍、整机 CPU 最高 94%，再多也快不了）。
//      上一轮跑得久的排前面（记在 .vibe/tmp/run-all-times.json），免得最后剩一套长的单独拖着
//   2. 怕机器忙的（SOLO：同时跑时会因时序出问题的，多跑几轮试出来的）等前面的都跑完，一个一个单独跑。临时加几套用 --solo a.js,b.js
//   3. 新旧钩子对比：各用自己的临时目录、不占端口，几份一起跑（和以前一样）
//   4. 端到端：每个 Claude Code 版本一路，几个版本同时跑（--e2e-lanes，默认和版本数一样；假 GitLab、假 redis 的端口每个版本错开）；同一个版本里一个接一个
//   --lanes 1：和以前一样，除了钩子对比，全部按列表顺序一个接一个（怀疑失败是同时跑引起的时候用）
const LANES = Math.max(1, Number(all('--lanes')[0]) || 3);
const E2E_LANES = Math.max(1, Number(all('--e2e-lanes')[0]) || (LANES === 1 ? 1 : claudes.length || 1));
const SOLO = new Set([].concat(all('--solo').flatMap((s) => s.split(',')).map((s) => path.basename(s.trim())).filter(Boolean)));
const TIMES_FILE = path.join(__dirname, '..', '.vibe', 'tmp', 'run-all-times.json');
let lastTimes = {}; try { lastTimes = JSON.parse(fs.readFileSync(TIMES_FILE, 'utf8')) || {}; } catch (e) { lastTimes = {}; }
const times = Object.assign({}, lastTimes);
const fmt = (s) => (s >= 60 ? Math.floor(s / 60) + ' 分 ' + Math.round(s % 60) + ' 秒' : Math.round(s) + ' 秒');
const jobs = suites.map((s, i) => ({ name: s[0], file: s[1], args: s[2], index: i }));
const isE2E = (j) => /^e2e-/.test(j.file);
const isDiff = (j) => j.file === 'diff-hooks.js';
const normal = jobs.filter((j) => !isE2E(j) && !isDiff(j) && !(LANES > 1 && SOLO.has(j.file)));
const solo = jobs.filter((j) => !isE2E(j) && !isDiff(j) && LANES > 1 && SOLO.has(j.file));
const diffs = jobs.filter(isDiff);
const e2e = jobs.filter(isE2E);
const phaseTimes = [];
async function phase(label, fn) { const t = Date.now(); await fn(); phaseTimes.push(label + ' ' + fmt((Date.now() - t) / 1000)); }
async function runJob(j) { const r = await runSuite(j.name, j.file, j.args); report(r, j.index); times[j.name] = r.sec; }
/** n 路同时跑：每路做完一套就去拿下一套 */
async function pool(list, n) { const q = list.slice(); await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await runJob(q.shift()); })); }
(async () => {
const t0 = Date.now();
if (normal.length) await phase('一般的套 ' + Math.min(LANES, normal.length) + ' 路', () => pool(LANES > 1 ? normal.slice().sort((a, b) => (lastTimes[b.name] || 0) - (lastTimes[a.name] || 0)) : normal, LANES));
if (solo.length) await phase('怕机器忙的单独跑', () => pool(solo, 1));
if (diffs.length) await phase('新旧钩子对比 ' + diffs.length + ' 份一起', () => pool(diffs, diffs.length));
if (e2e.length) {
  // 按 Claude Code 版本分组（第一个参数是 claude.exe），一组一路
  const groups = []; for (const j of e2e) { let g = groups.find((x) => x.exe === j.args[0]); if (!g) groups.push(g = { exe: j.args[0], list: [] }); g.list.push(j); }
  const n = Math.min(E2E_LANES, groups.length);
  await phase('端到端 ' + n + ' 路', async () => { const q = groups.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) { const g = q.shift(); for (const j of g.list) await runJob(j); } })); });
}
try { fs.writeFileSync(TIMES_FILE, JSON.stringify(times, null, 1)); } catch (e) { /* 记不了，下次按列表顺序排 */ }
const after = windows();
const newWin = after.filter((w) => !before.includes(w));
const left = temps();
console.log('');
console.log('合计：' + rows.length + ' 套，通过 ' + rows.reduce((n, r) => n + r.pass, 0) + ' 项，失败 ' + rows.reduce((n, r) => n + r.fail, 0) + ' 项');
console.log('桌面上多出来的窗口：' + (newWin.length ? newWin.join('、') : '没有'));
console.log('临时目录里留下的测试目录：' + (left.length ? left.join('、') : '没有'));
console.log('用时：' + fmt((Date.now() - t0) / 1000) + '（' + phaseTimes.join('；') + '）');
if (since) console.log('没测的独立模块：' + (skipped.length ? skipped.join('；') : '没有'));
console.log('每套的完整输出：' + LOGS);
process.exit(rows.every((r) => r.ok) && !newWin.length && !left.length ? 0 : 1);
})();

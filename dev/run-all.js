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
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

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
suites.unshift(['1012 推送反馈', 'test-feedback1012-push.js', []], ['1012 流程反馈', 'test-feedback1012-workflow.js', []], ['1012 页面探针', 'test-feedback1012-page.js', []]);
suites.unshift(['1012 数据库诊断', 'test-feedback1012-db.js', [rt || 'none']]);
suites.unshift(...['workflow', 'review', 'push', 'diagnostics', 'feedback', 'decisions'].map((name) => ['1013 反馈 ' + name, 'test-feedback1013-' + name + '.js', []]));
suites.unshift(['提案审查结果有效性', 'test-proposal-review-state.js', []]);
if (old) suites.push(['旧版复现', 'check-old-repro.js', [old]]);
if (old0929) suites.push(['旧版复现 0929', 'check-old-repro-0929.js', [old0929]]);
if (oldNames) suites.push(['改名和并进来的技能', 'test-ttls.js', [oldNames]]);
if (rt) suites.push(['查库（H2）', 'test-dbcrud.js', [rt]]);
for (const d of olds) suites.push(['新旧钩子对比 ' + (verOf(d) || path.basename(d)), 'diff-hooks.js', [d]]);
for (const c of claudes) for (const m of ['auto', 'manual']) suites.push(['端到端（经验，' + (m === 'auto' ? '自动收' : '自己记') + '）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-lessons.js', [c, path.basename(path.resolve(c, '../../../../..')), m]]);
for (const c of claudes) suites.push(['端到端（更新、令牌）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-update.js', [c, path.basename(path.resolve(c, '../../../../..')), '18748']]);
for (const c of claudes) suites.push(['端到端（全自动）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-auto-0929.js', [c, path.basename(path.resolve(c, '../../../../..'))]]);
// 不给 --rt 的话查库那几项不测（第三个参数给一个不存在的目录）
for (const c of claudes) suites.push(['端到端（0930）' + path.basename(path.resolve(c, '../../../../..')), 'e2e-0930.js', [c, path.basename(path.resolve(c, '../../../../..')), rt || path.join(__dirname, '没有运行环境'), '18765']]);

suites.unshift(['IDEA MCP 自动接入', 'test-idea-mcp.js', claudes.flatMap(c => ['--claude', c])]);
suites.unshift(['IDEA MCP 保护入口', 'test-idea-tools.js', []]);

const rows = [];
suites.unshift(['使用情况匿名标识', 'test-usage-identity.js', []]);
suites.unshift(['归档解包的临时目录', 'test-archive-extract.js', []]);
suites.unshift(['推送预览和合并确认', 'test-push-preview.js', []]);
suites.unshift(['服务实际地址', 'test-service-address.js', []]);
for (const [name, file] of [['状态并发和恢复', 'test-workflow-state.js'], ['用户意图与许可', 'test-workflow-intent.js'], ['许可与上下文', 'test-workflow-permissions.js'], ['连接生命周期', 'test-connection-lifecycle.js'], ['诊断脱敏', 'test-diagnostic-redaction.js'], ['审查和执行证据', 'test-review-evidence.js'], ['运行流程优化', 'test-optimization-runtime.js'], ['优化边界', 'test-optimization-boundaries.js']]) suites.unshift([name, file, []]);
for (const [name, file, a] of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(a), { encoding: 'utf8', windowsHide: true, timeout: 1200000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const last = out.trim().split(/\r?\n/).filter((l) => /^\[(OK|X)\]/.test(l)).pop() || '(没有汇总行)';
  const m = last.match(/通过 (\d+) 项(?:，失败 (\d+) 项)?/);
  rows.push({ name, ok: r.status === 0, pass: m ? Number(m[1]) : 0, fail: m ? Number(m[2] || 0) : 0, sec: Math.round((Date.now() - t0) / 1000), out });
  console.log((r.status === 0 ? '[OK] ' : '[X]  ') + name.padEnd(20) + ' 通过 ' + (m ? m[1] : '?') + (m && m[2] ? '，失败 ' + m[2] : '') + '（' + rows[rows.length - 1].sec + ' 秒）');
  if (r.status !== 0) console.log(out.split(/\r?\n/).filter((l) => /\[X\]|^\s{6}/.test(l)).slice(0, 30).join('\n'));
}
const after = windows();
const newWin = after.filter((w) => !before.includes(w));
const left = temps();
console.log('');
console.log('合计：' + rows.length + ' 套，通过 ' + rows.reduce((n, r) => n + r.pass, 0) + ' 项，失败 ' + rows.reduce((n, r) => n + r.fail, 0) + ' 项');
console.log('桌面上多出来的窗口：' + (newWin.length ? newWin.join('、') : '没有'));
console.log('临时目录里留下的测试目录：' + (left.length ? left.join('、') : '没有'));
process.exit(rows.every((r) => r.ok) && !newWin.length && !left.length ? 0 : 1);

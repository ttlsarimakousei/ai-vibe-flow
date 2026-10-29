'use strict';
// 从本轮临时日志抽取可公开的审核证据；不复制桌面标题、测试详情中的路径或原始工具输出。
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const temp = path.join(root, '.vibe/tmp/codex-audit-20261029');
const out = path.join(__dirname, 'evidence'); fs.mkdirSync(out, { recursive: true });
function read(name) { const b = fs.readFileSync(path.join(temp, name)); return b[0] === 255 && b[1] === 254 ? b.subarray(2).toString('utf16le') : b.toString('utf8').replace(/^\uFEFF/, ''); }
const logs = Object.fromEntries(['reproduce.log', 'router.log', 'supplemental.log', 'edges.log', 'hook-fault.log', 'round3.log', 'install-check.log'].map(name => [name, read(name)]));
function assertions(name) {
  const lines = logs[name].split(/\r?\n/); const last = lines.filter(x => /^\[(OK|X)\]/.test(x)).pop() || '';
  const m = /^\[OK\].*：通过 (\d+) 项\s*$/.exec(last);
  if (!m || /^\s*\[X\]/m.test(logs[name])) throw new Error(name + ' 缺少成功收尾或包含失败断言，不生成通过证据');
  return Number(m[1]);
}
for (const name of Object.keys(logs)) assertions(name);
const observations = [];
const basic = logs['reproduce.log'].split(/\r?\n/).find(x => x.startsWith('AUDIT_RESULT '));
if (!basic) throw new Error('基础复现日志缺少结构化结果');
observations.push(...JSON.parse(basic.slice(13)));
for (const file of ['router.log', 'supplemental.log', 'edges.log', 'hook-fault.log']) for (const line of logs[file].split(/\r?\n/)) {
  const m = /^(F\d+) (\{.*\})$/.exec(line); if (!m) continue;
  const x = JSON.parse(m[2]); observations.push({ id: m[1], observed: x });
}
const limits = {
  F06: '只注入 Node 18 版本检查输入，未运行 Node 18 二进制完整兼容回归',
  F07: '假网关与真实路由集成；未验证 Claude Code SDK 是否自行拒绝半截事件',
  F08: '假网关与真实路由集成；假客户端故意不自行超时以观察路由总时长',
  F09: '直接执行源码中的 writeReg 函数，屏障控制两进程读取同一旧值；未运行真实服务',
  F10: '只向 Python 返回分支注入 SQL_ERROR，未运行 JDBC、未制造真实提交异常',
  F11: '原 pending_take 两进程先读取同一值，再依次保存；没有执行数据库 SQL',
  F12: '真实 cleanTmp 仅删除测试支架创建的假目录',
  F13: '真实 Redis CLI 对本机假 RESP 服务；注入 PTTL=0，未连接 Redis 实例',
  F14: 'Git 在临时裸仓库实际推送；未调用内网发布器、未推送真实远端',
  F15: '只替换假 KIT 中的工作线程为收到消息后退出，真实 hook-host 的错误和反馈路径被执行'
};
for (const row of observations) if (limits[row.id]) row.level = limits[row.id];
const ids = observations.map(x => x.id);
if (observations.length !== 15 || new Set(ids).size !== 15 || Array.from({ length: 15 }, (_, i) => 'F' + String(i + 1).padStart(2, '0')).some(id => !ids.includes(id))) throw new Error('动态观察缺项或重复，不生成完整证据');
const third = [];
for (const file of ['round3.log', 'install-check.log']) for (const line of logs[file].split(/\r?\n/)) {
  const m = /^(G\d+) (\{.*\})$/.exec(line); if (m) third.push({ id: m[1], observed: JSON.parse(m[2]) });
}
if (third.length !== 4 || new Set(third.map(x => x.id)).size !== 4 || ['G01', 'G02', 'G03', 'G04'].some(id => !third.some(x => x.id === id))) throw new Error('第三轮动态观察缺项或重复');
fs.writeFileSync(path.join(out, 'round3-results.json'), JSON.stringify({ observations: third, assertions: assertions('round3.log'), installationAssertions: assertions('install-check.log'), limits: ['服务停止仅针对本测试创建且核对 PID 的随机回环端口假服务', '兼容审查使用假会话记录，未运行真实 Claude Code', '安装故障仅验证真实安装器和 updater.selfCheck，未执行完整自动更新仓库链', 'harness 的全局进程扫描存在被沙箱拒绝后返回空的路径；自建假服务已直接等待退出，不将扫描返回空作为全机无遗留的证明'] }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'dynamic-results.json'), JSON.stringify(observations, null, 2) + '\n');
const regression = read('regression.log').split(/\r?\n/);
const selected = regression.filter(x => /^\[(OK|X)\]/.test(x) || /^合计：|^桌面上多出来|^临时目录里留下|^用时：/.test(x));
fs.writeFileSync(path.join(out, 'regression-summary.txt'), '命令：node dev/run-all.js --lanes 2\n\n' + selected.join('\n') + '\n');
const windows = read('watch.log').split(/\r?\n/); const byProcess = {};
for (const row of windows.filter(x => x.startsWith('NEW\t'))) { const p = row.split('\t')[1] || '未知'; byProcess[p] = (byProcess[p] || 0) + 1; }
const parsed = logs['supplemental.log'].split(/\r?\n/).find(x => /^\{"pythonParsed":/.test(x));
const sqlCases = /sqlguard_selftest\.py 全部通过：(\d+) 项/.exec(logs['supplemental.log']);
if (!parsed || !sqlCases) throw new Error('Python 核验结果缺失');
const regressionResult = JSON.parse(read('regression-result.json'));
if (regressionResult.code !== 0) throw new Error('基础回归未成功收尾');
fs.writeFileSync(path.join(out, 'execution.json'), JSON.stringify({ regression: regressionResult, desktopWatch: { started: windows.includes('READY'), ended: windows.includes('DONE'), newEvents: Object.values(byProcess).reduce((n,x)=>n+x,0), byProcess, note: '记录新可见窗口，不等同测试弹窗；未保存标题。回归末尾没有遗留窗口。' }, additionalChecks: { basicReproductionAssertions: assertions('reproduce.log'), routerIntegrationAssertions: assertions('router.log'), supplementalAssertions: assertions('supplemental.log'), edgeAssertions: assertions('edges.log'), hookFaultAssertions: assertions('hook-fault.log'), pythonSyntaxFiles: JSON.parse(parsed).pythonParsed, sqlClassifierCases: Number(sqlCases[1]), pythonOfflineSuites: logs['supplemental.log'].split(/\r?\n/).filter(x => /_selftest\.py 全部通过/.test(x)).length }, missingValidation: ['真实 JDBC/H2 集成：本机缺 Java/JDK', '真实 Claude Code 多版本端到端：本机未发现测试版本', '完整 Node 18/20 运行矩阵', '第三方依赖逐行审计和在线漏洞库核对', '真实公司网关、内网 GitLab、真实数据库、真实 Redis'] }, null, 2) + '\n');
console.log('已整理 ' + observations.length + ' 条动态观察和全量回归摘要；桌面监视 ' + Object.values(byProcess).reduce((n,x)=>n+x,0) + ' 条出现记录。');

'use strict';
/* #70、#78、#88、#89 与反馈元数据：只读入口、总预算、额度去重和完整重现说明。全部使用假用户目录。 */
const path = require('path'); const fs = require('fs'); const H = require('./lib/harness');
const h = H.makeHome('feedback1013-diagnostics', process.argv[2], { kitBypass: 'auto' });
const p = H.makeRepo(path.join(h.work, 'p'), { 'a.js': 'let a=1;\n' });
const S = require(path.join(h.kit, 'lib/session')); const F = require(path.join(h.kit, 'lib/feedback')); const I = require(path.join(h.kit, 'lib/invocation'));
S.setFlow({ session_id: 'inspect' }, true, '提案修订', 'plan');
const cli = path.join(h.kit, 'tools/diagnose.js');
H.ok('受控诊断入口存在', fs.existsSync(cli));
if (fs.existsSync(cli)) {
  const before = S.readState('inspect-flow');
  const r = H.node(h, cli, ['flow', '--session', 'inspect']); H.ok('只读诊断显示实际阶段', r.code === 0 && JSON.parse(r.out).stage === 'plan', r);
  H.ok('只读诊断不改变许可', JSON.stringify(before) === JSON.stringify(S.readState('inspect-flow')));
  H.write(path.join(h.kit, 'secrets.json'), '{"token":"FAKE_DIAG_SECRET"}');
  const invalid = H.node(h, cli, ['flow', '--session', '../secrets']); H.ok('诊断参数不能读其它文件', invalid.code !== 0 && !invalid.out.includes('FAKE_DIAG_SECRET'));
}
let expired = false; const phases = [];
if (I.remaining) { try { I.run(() => { I.phase('测试等待'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); I.remaining(5000); }, { budgetMs: 5, onPhase: (name) => phases.push(name) }); } catch (e) { expired = e.code === 'VIBE_HOOK_BUDGET' && /测试等待/.test(e.message); } }
H.ok('总预算结束携带最后阶段', expired);
H.ok('阶段消息只有操作类别', phases.includes('测试等待'));
if (I.remaining) I.run(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); F.recordHookError('budget-test', { cwd: p }, new Error('检查预算用完，阶段：测试')); }, { budgetMs: 1 });
H.ok('检查预算用完仍可记录诊断', F.listRecords().some((r) => r.meta['涉及'] === 'budget-test'));
H.done('1013 钩子预算与受控诊断');

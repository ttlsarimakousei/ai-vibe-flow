'use strict';
/* #89 与重复反馈：不同问题额度、重复申请、最新版本和完整补充。只在假用户目录记反馈。 */
const path = require('path'); const H = require('./lib/harness');
const h = H.makeHome('feedback1013-feedback', process.argv[2], { kitBypass: 'auto' });
const p = H.makeRepo(path.join(h.work, 'p'), { 'a.js': 'let a=1;\n' });
const S = require(path.join(h.kit, 'lib/session')); const F = require(path.join(h.kit, 'lib/feedback'));
let ok = 0; let last;
for (let i = 0; i < 8; i++) {
  F.registerBlock({ session_id: 'quota', cwd: p }, 'guard-spec', 'sig' + i, '任务缺审查依据', 'Edit', 'file:' + path.join(p, 'task' + i));
  const b = S.readState('blocks').list.slice(-1)[0]; last = F.requestBypass(b.id, '查过任务与验证记录，这是同一个已确认操作的误拦，申请放行。', { bug: true }); if (last.ok) ok++;
}
H.ok('配置自行放行不会在第五次卡住', ok === 8, last);
H.ok('申请结果显示剩余额度', /还可申请/.test(last.msg), last);
H.setConfig(h, { kitBypass: 'ask' });
for (let i = 0; i < 8; i++) {
  F.registerBlock({ session_id: 'repeat', cwd: p }, 'guard-spec', 'repeat' + i, '相同任务缺审查依据', 'Edit', 'file:' + path.join(p, 'same-task'));
  const b = S.readState('blocks').list.slice(-1)[0]; last = F.requestBypass(b.id, '查过任务与验证记录，同一目标同一检查反复误拦，申请这次放行。', { bug: true });
  H.ok('相同目标重试不重复扣额度 ' + i, last.ok, last);
}
const first = F.record({ sig: 'recent-meta', kind: '误拦', title: '重现', hook: 'guard-spec', sid: 'x', cwd: p });
H.write(path.join(h.kit, 'VERSION'), '20990101.0101\n'); const note = '证据'.repeat(500) + ' 最后一条关键命令';
const again = F.record({ sig: 'recent-meta', kind: '误拦', title: '重现', hook: 'guard-spec', sid: 'x', cwd: p, note });
const record = F.listRecords().find((r) => r.meta.id === first.id);
H.ok('重现仍复用原编号', again.id === first.id);
H.ok('保留最近版本且不覆盖首次版本', record.meta['最近套件版本'] === '20990101.0101' && record.meta['套件版本'] !== '20990101.0101', record.meta);
H.ok('重现关键说明不再截到二百字', record.text.includes('最后一条关键命令'));
H.done('1013 反馈重现与放行额度');

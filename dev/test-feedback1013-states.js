'use strict';
/* #102：业务状态名可以原样写入产物，同一行其它未定事项仍要拦；检查普通和全自动入口。 */
const path = require('path');
const H = require('./lib/harness');
const h = H.makeHome('feedback1013-states', process.argv[2]);
const S = require(path.join(h.kit, 'lib/session'));
const pass = ['自己的状态（待确认 / 已确认 / 退回）', '操作 **查看 / 开始确认（仅待确认）**', '`SUBMITTED`（待确认）', '状态（已确认、待确认、退回）', '状态：待确认 / 已确认 / 退回', '只有待确认状态的可以确认', '| `SUBMITTED` | 待确认 | 允许确认 |', '状态（待补充 / 已补充）'];
const block = ['接口验法待确认', '确认状态的接口待确认', '状态（待确认 / 已确认）；接口验法待确认', '`SUBMITTED`（待确认）；权限规则待确认', '操作 **查看 / 开始确认（仅待确认）**；细节以后再说', '状态（待确认后再补验法）', '状态设计（待确认）', '| `SUBMITTED` | 验法待确认 |', '操作说明（待确认）'];
for (const line of pass) H.ok('保留业务状态：' + line, S.findHedges(line).length === 0, S.findHedges(line));
for (const line of block) H.ok('仍拦未定事项：' + line, S.findHedges(line).length > 0);
H.ok('同一枚举内未定说明仍拦', S.findHedges('状态（待确认 / 待确认后再补验法）').length > 0);
const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'openspec/changes/add-a/proposal.md': '# 提案\n原文\n' });
const file = path.join(p, 'openspec/changes/add-a/proposal.md');
for (const autoMode of [false, true]) {
  H.setConfig(h, { autoMode });
  for (const [text, allowed] of [[pass.slice(0, 3).join('\n'), true], [block[2], false]]) {
    const j = { cwd: p, session_id: 'state-' + autoMode, tool_name: 'Edit', tool_input: { file_path: file, old_string: '原文', new_string: text } };
    const out = H.hook(h, 'pre-edit', j);
    H.ok((autoMode ? '全自动' : '普通') + '实际编辑' + (allowed ? '允许状态名' : '仍拦验法未定'), allowed ? !out : /待确认/.test(H.reasonOf(out)), out);
  }
}
H.done('1013 业务状态名');

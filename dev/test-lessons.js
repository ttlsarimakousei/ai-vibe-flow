'use strict';
/*
 * 经验规则：记一条 → 候选 → 到次数升成项目规则 → 跨项目升用户级；条数上限、手写的行、过时退役、保护、收工检查。
 * 全程在假的用户目录里跑，用户级规则写进的是假目录的 .claude/rules。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('lessons');
const L = require(path.join(h.kit, 'lib', 'lessons.js'));
const TOOL = path.join(h.kit, 'tools', 'lesson.js');
const files = {
  'pom.xml': '<project/>\n',
  'src/main/java/com/x/OrderService.java': 'class OrderService {}\n',
  'src/main/java/com/x/OrderMapper.java': 'interface OrderMapper {}\n',
  'src/main/resources/mapper/OrderMapper.xml': '<mapper/>\n',
  'web/src/views/Order.vue': '<template></template>\n',
  'openspec/changes/add-export/tasks.md': '- [x] 1.1 改 src/main/java/com/x/OrderService.java；验：人工看\n',
  'openspec/changes/add-export/design.md': '## Context\n',
};
const A = H.makeRepo(path.join(h.work, 'projA'), files);
const B = H.makeRepo(path.join(h.work, 'projB'), { 'pom.xml': '<project/>\n', 'src/main/resources/mapper/UserMapper.xml': '<mapper/>\n', 'src/main/java/U.java': 'class U {}\n' });
const lesson = (cwd, args) => H.node(h, TOOL, args, { cwd });
const ruleFile = (root, g) => path.join(root, '.claude', 'rules', 'ttls-lessons-' + g + '.md');
const JAVA = 'src/main/java/com/x/OrderService.java';
const T1 = ['--when', '调 OrderMapper.selectByIds 之前', '--do', '先判空列表，传空列表会拼出 in () 报错'];

H.section('像不像同一条');
{
  const a = '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错';
  H.ok('一模一样', L.similarity(a, a) === 1);
  H.ok('只差标点和空格：当成同一条', L.similarity(a, '调 OrderMapper.selectByIds 之前，先判空列表；传空列表会拼出 in() 报错') >= L.SAME);
  const para = L.similarity(a, '调用 OrderMapper.selectByIds 前先判断列表是否为空：空列表会拼出 in () 导致 SQL 报错');
  H.ok('换了说法：算相近，要模型自己认', para >= L.NEAR && para < L.SAME, para);
  H.ok('不相干的：不算相近', L.similarity(a, '日期格式化用 yyyy 不用 YYYY：跨年那一周会算成下一年') < L.NEAR);
  H.ok('编号跟文字走，不是流水号', L.idOf(a) === L.idOf(a) && /^L[0-9a-f]{6}$/.test(L.idOf(a)) && L.idOf(a) !== L.idOf('别的一句话'));
}

H.section('分组');
{
  H.ok('java', L.groupOf('a/b/C.java') === 'java');
  H.ok('带行号也认', L.groupOf('a/b/C.java:88') === 'java');
  H.ok('mapper 和 sql 一组', L.groupOf('x/OrderMapper.xml') === 'sql' && L.groupOf('db/a.sql') === 'sql');
  H.ok('前端一组', L.groupOf('web/A.vue') === 'web' && L.groupOf('a.ts') === 'web');
  H.ok('提案文档', L.groupOf('openspec/changes/x/design.md') === 'spec');
  H.ok('别的按扩展名', L.groupOf('a/b.jsp') === 'other-jsp' && L.groupInfo('other-jsp').paths[0] === '**/*.jsp');
  H.ok('没有扩展名的不收', L.groupOf('Makefile') === '');
  H.ok('paths 不用花括号（老版本花括号多了会卡住）', Object.values(L.GROUPS).every((g) => g.paths.every((p) => !/[{}]/.test(p))));
}

H.section('写法不合要求的不收');
{
  const r1 = lesson(A, ['add'].concat(T1, ['--from', 'add-export 2.3']));
  H.ok('没写文件', r1.code === 1 && /--file/.test(r1.out), r1.out);
  const r2 = lesson(A, ['add', '--file', JAVA].concat(T1));
  H.ok('没写出处', r2.code === 1 && /--from/.test(r2.out), r2.out);
  const r3 = lesson(A, ['add', '--file', JAVA, '--when', '写代码时', '--do', '尽量注意边界', '--from', 'add-export 2.3']);
  H.ok('"尽量"这种话不收', r3.code === 1 && /尽量/.test(r3.out), r3.out);
  const r4 = lesson(A, ['add', '--file', JAVA, '--when', '很长', '--do', '字'.repeat(130), '--from', 'add-export 2.3']);
  H.ok('太长的不收', r4.code === 1 && /太长/.test(r4.out), r4.out);
  const r5 = lesson(h.root, ['add', '--file', path.join(h.root, 'nowhere', 'X.java')].concat(T1, ['--from', 'add-export 2.3']));
  H.ok('不在任何项目里的不收', r5.code === 1 && /不在任何项目里/.test(r5.out), r5.out);
  H.write(path.join(A, 'CLAUDE.md'), '# 项目约定\n\n- 删东西、改公共配置之前，先全局搜一遍引用，包括用字符串拼出来的用法\n');
  const r6 = lesson(A, ['add', '--file', JAVA, '--when', '删东西、改公共配置之前', '--do', '先全局搜一遍引用，包括字符串拼出来的用法', '--from', 'add-export 2.3']);
  H.ok('约定里已经有的不收', r6.code === 1 && /约定里已经有/.test(r6.out), r6.out);
  fs.unlinkSync(path.join(A, 'CLAUDE.md'));
  H.ok('一条都没记上', L.readCandidates(A).length === 0 && !fs.existsSync(ruleFile(A, 'java')));
}

H.section('第一次：进候选，不进上下文');
let id1 = '';
{
  const r = lesson(A, ['add', '--file', JAVA].concat(T1, ['--from', 'add-export 2.3', '--kind', '边界']));
  H.ok('记下了', r.code === 0 && /已记下（L[0-9a-f]{6}，第 1 次）/.test(r.out), r.out);
  const c = L.readCandidates(A);
  id1 = c[0] && c[0].id;
  H.ok('候选里有一条', c.length === 1 && c[0].group === 'java' && c[0].kind === '边界' && c[0].file === JAVA, c);
  H.ok('没有生成规则文件', !fs.existsSync(ruleFile(A, 'java')));
  H.ok('.vibe 进了 .gitignore', /^\.vibe\/?$/m.test(H.read(path.join(A, '.gitignore')) || ''), H.read(path.join(A, '.gitignore')));
  const again = lesson(A, ['add', '--file', JAVA].concat(T1, ['--from', 'add-export 3.1']));
  H.ok('同一个变更里再出现不算第二次', /第 1 次/.test(again.out) && L.readCandidates(A)[0].sources.length === 1, again.out);
}

H.section('换了说法：列出相近的，让模型自己认');
{
  const args = ['add', '--file', 'src/main/java/com/x/OrderMapper.java', '--when', '调用 OrderMapper.selectByIds 前', '--do', '先判断列表是否为空：空列表会拼出 in () 导致 SQL 报错', '--from', 'fix-order 1.2'];
  const r = lesson(A, args);
  H.ok('列出了相近的，没有直接记', r.code === 0 && /已有相近的/.test(r.out) && r.out.includes(id1) && /--same/.test(r.out), r.out);
  H.ok('候选没变', L.readCandidates(A).length === 1 && L.readCandidates(A)[0].sources.length === 1);
  const r2 = lesson(A, args.concat(['--same', id1]));
  H.ok('认了是同一条：第 2 次，升成规则', /第 2 次出现，已升成这个项目的规则/.test(r2.out), r2.out);
  H.ok('告诉它怎么提交', /git -C ".*projA" add "\.claude\/rules\/ttls-lessons-java\.md"/.test(r2.out) && /docs: 更新经验规则/.test(r2.out), r2.out);
}

H.section('规则文件');
{
  const f = ruleFile(A, 'java');
  const t = H.read(f) || '';
  H.ok('文件在出问题的文件所在的仓库里', fs.existsSync(f));
  H.ok('带 paths，一个模式一行', /^---\npaths:\n  - "\*\*\/\*\.java"\n---\n/.test(t), t);
  H.ok('有说明注释、标题、编号注释、规则', /<!-- vibe-kit 经验规则/.test(t) && /^# 写Java时注意/m.test(t) && new RegExp('^<!-- ' + id1 + ' 次数=2 最近=\\d{4}-\\d\\d-\\d\\d 类别=边界 名字=OrderMapper 出处=add-export 2\\.3；fix-order 1\\.2 -->$', 'm').test(t) && /^- 调 OrderMapper\.selectByIds 之前：先判空列表/m.test(t), t);
  H.ok('注释都单独占一行（行尾的注释会进上下文）', t.split('\n').every((l) => !/<!--/.test(l) || /^<!--.*-->$/.test(l.trim())), t);
  const d = L.readRuleFile(f);
  H.ok('读回来一样', d.rules.length === 1 && d.rules[0].id === id1 && d.rules[0].count === 2 && d.rules[0].names.join() === 'OrderMapper' && d.rules[0].from.length === 2 && d.paths.join() === '**/*.java', d);
  H.ok('再写一遍不走样', L.renderRuleFile(d, 'project', 'java') === t);
  H.ok('候选里已经没有它了', !L.readCandidates(A).some((c) => c.id === id1));
  H.ok('记下了要提交的文件', L.uncommitted(A).length === 1 && L.uncommitted(A)[0].rel === '.claude/rules/ttls-lessons-java.md', L.uncommitted(A));
}

H.section('规则文件不许模型直接改');
{
  const f = ruleFile(A, 'java');
  const base = { session_id: 's-guard', cwd: A, hook_event_name: 'PreToolUse', transcript_path: H.transcript(path.join(h.root, 'tg.jsonl'), [H.tr.user('x')]) };
  const edit = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: f, old_string: '- 调', new_string: '- 改' } }));
  H.ok('Edit 拦', edit && edit.decision === 'block' && /lesson\.js/.test(H.reasonOf(edit)), edit);
  const wr = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: path.join(A, '.claude', 'rules', 'ttls-lessons-web.md'), content: '- x\n' } }));
  H.ok('Write 新的规则文件也拦', wr && wr.decision === 'block', wr);
  const cand = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: L.candidatesFile(A), old_string: 'a', new_string: 'b' } }));
  H.ok('候选文件拦', cand && cand.decision === 'block', cand);
  const userRule = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: path.join(h.cfg, 'rules', 'ttls-lessons-java.md'), content: '- x\n' } }));
  H.ok('用户级的拦', userRule && userRule.decision === 'block', userRule);
  const other = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: path.join(A, '.claude', 'rules', 'team-style.md'), content: '- 团队自己的规则\n' } }));
  H.ok('别的规则文件不管', other === null, other);
  const cmd = (c, tool) => H.hook(h, 'guard-commit', Object.assign({}, base, { tool_name: tool || 'Bash', tool_input: { command: c } }));
  for (const c of ['echo "- x" >> .claude/rules/ttls-lessons-java.md', 'rm .claude/rules/ttls-lessons-java.md', "sed -i 's/a/b/' .claude/rules/ttls-lessons-java.md", 'cd .claude/rules && rm ttls-lessons-java.md', 'git checkout -- .claude/rules/ttls-lessons-java.md', 'rm -rf .vibe/lessons']) {
    const r = cmd(c);
    H.ok('命令拦：' + c, r && r.decision === 'block' && /经验规则/.test(H.reasonOf(r)), r);
  }
  const ps = cmd('Remove-Item .claude\\rules\\ttls-lessons-java.md', 'PowerShell');
  H.ok('PowerShell 删也拦', ps && ps.decision === 'block', ps);
  for (const c of ['cat .claude/rules/ttls-lessons-java.md', 'git add .claude/rules/ttls-lessons-java.md', 'git -C "' + A.replace(/\\/g, '/') + '" add ".claude/rules/ttls-lessons-java.md"', 'git diff -- .claude/rules/ttls-lessons-java.md', 'node "' + TOOL.replace(/\\/g, '/') + '" list']) {
    const r = cmd(c);
    H.ok('命令放行：' + c.slice(0, 50), r === null, r);
  }
  H.setConfig(h, { kitLock: false });
  const off = H.hook(h, 'pre-edit', Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: f, old_string: '- 调', new_string: '- 改' } }));
  H.ok('用户在配置页关了禁改：放行', off === null, off);
  H.setConfig(h, { kitLock: true });
}

H.section('规则文件改了没提交：收工时催一次');
{
  const tfile = path.join(h.root, 'ts.jsonl');
  const stop = (sid, entries, extra) => H.hook(h, 'verify-gate', Object.assign({ session_id: sid, cwd: A, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: false, last_assistant_message: '好了' }, extra || {}));
  // 同一轮：同一份会话记录（用户那句话的编号不变）
  const turn = [H.tr.user('记一下经验'), H.tr.say('好了')];
  const r = stop('s-commit', turn);
  H.ok('催提交', r && r.decision === 'block' && /经验规则文件更新了，还没提交：projA 的 \.claude\/rules\/ttls-lessons-java\.md/.test(H.reasonOf(r)), r);
  const r2 = stop('s-commit', turn, { stop_hook_active: true });
  H.ok('同一轮不催第二次', !r2 || !/经验规则文件更新了/.test(H.reasonOf(r2)), r2);
  H.setConfig(h, { autoCommit: 'off' });
  const r3 = stop('s-commit-off', [H.tr.user('记一下经验'), H.tr.say('好了')]);
  H.ok('关闭自动提交仍可提醒，用 Ask 决定', /经验规则文件更新了/.test(H.reasonOf(r3)) && /Ask/.test(H.reasonOf(r3)));
  H.setConfig(h, { autoCommit: 'task' });
  H.git(A, ['add', '.claude/rules/ttls-lessons-java.md', '.gitignore']);
  const c = H.git(A, ['commit', '-q', '-m', 'docs: 更新经验规则']);
  H.ok('提交成功', c.code === 0, c.err);
  const r4 = stop('s-commit-2', [H.tr.user('继续'), H.tr.say('好了')]);
  H.ok('提交之后不催', !r4 || !/经验规则文件更新了/.test(H.reasonOf(r4)), r4);
  H.ok('记录清掉了', L.uncommitted(A).length === 0);
}

H.section('已经是规则了还犯：记"没管住"');
{
  const r = lesson(A, ['add', '--file', JAVA].concat(T1, ['--from', 'add-refund 1.1']));
  H.ok('记了一次没管住', /已经是项目规则了/.test(r.out) && /没管住/.test(r.out), r.out);
  let d = L.readRuleFile(ruleFile(A, 'java'));
  H.ok('次数和没管住都加一', d.rules[0].count === 3 && d.rules[0].miss === 1, d.rules[0]);
  const r2 = lesson(A, ['add', '--file', JAVA].concat(T1, ['--from', 'add-refund 2.2']));
  d = L.readRuleFile(ruleFile(A, 'java'));
  H.ok('同一个变更里再犯不重复算', d.rules[0].miss === 1, r2.out);
  const r3 = lesson(A, ['add', '--file', JAVA].concat(T1, ['--from', 'add-stock 1.1']));
  d = L.readRuleFile(ruleFile(A, 'java'));
  H.ok('两次没管住：建议改成脚本检查', d.rules[0].miss === 2 && /建议改成脚本检查/.test(r3.out), r3.out);
  H.git(A, ['add', '.claude/rules/ttls-lessons-java.md']); H.git(A, ['commit', '-q', '-m', 'docs: 更新经验规则']);
}

H.section('条数上限：满了挤掉最久没再出现的；手写的行不动');
{
  H.setConfig(h, { lessonThreshold: 1, lessonMaxPerGroup: 3 });
  const f = ruleFile(A, 'java');
  fs.writeFileSync(f, H.read(f) + '- 手写的一条：金额一律用 BigDecimal，不用 double\n');
  const texts = ['分页查询的 pageSize 要限制上限：不限制的话传 100000 会把库拖垮', '导出接口要走异步任务：同步导出超过一万行会超时', '事务方法不要 catch 了异常不抛：吞掉异常事务不会回滚'];
  const outs = texts.map((t, i) => lesson(A, ['add', '--file', JAVA, '--text', t, '--from', 'chg-' + i + ' 1.1', '--new']));
  H.ok('都升成了规则', outs.every((o) => /已升成这个项目的规则/.test(o.out)), outs.map((o) => o.out));
  const d = L.readRuleFile(f);
  H.ok('手写的行还在', d.manual.some((l) => /BigDecimal/.test(l)), d.manual);
  H.ok('连手写的一共不超过 3 条', d.rules.length + d.manual.filter((l) => /^\s*-/.test(l)).length === 3, d);
  H.ok('次数最多的那条留着', d.rules.some((r) => r.id === id1), d.rules);
  H.ok('最后升的那条留着', d.rules.some((r) => /事务方法/.test(r.text)), d.rules);
  H.ok('挤掉的退回候选', L.readCandidates(A).some((c) => c.state === 'evicted'), L.readCandidates(A));
  H.ok('提示里说了挤掉', outs.some((o) => /这一组满了，挤掉了/.test(o.out)), outs.map((o) => o.out));
  H.setConfig(h, { lessonThreshold: 2, lessonMaxPerGroup: 10 });
  H.git(A, ['add', '.claude/rules']); H.git(A, ['commit', '-q', '-m', 'docs: 更新经验规则']);
}

H.section('只收集、关掉');
{
  H.setConfig(h, { lessons: 'collect' });
  const t = ['--text', '前端列表页切换查询条件要把页码重置成 1：不重置会停在一个不存在的页上'];
  lesson(A, ['add', '--file', 'web/src/views/Order.vue'].concat(t, ['--from', 'c1 1.1']));
  const r = lesson(A, ['add', '--file', 'web/src/views/Order.vue'].concat(t, ['--from', 'c2 1.1']));
  H.ok('只收集：到了次数也不生成规则', /只收集/.test(r.out) && !fs.existsSync(ruleFile(A, 'web')), r.out);
  H.setConfig(h, { lessons: 'off' });
  const r2 = lesson(A, ['add', '--file', 'web/src/views/Order.vue'].concat(t, ['--from', 'c3 1.1']));
  H.ok('关着：不记', /关着/.test(r2.out), r2.out);
  H.setConfig(h, { lessons: 'on' });
  const r3 = lesson(A, ['add', '--file', 'web/src/views/Order.vue'].concat(t, ['--from', 'c3 1.1']));
  H.ok('重新打开：之前攒的次数还在，这次就升', /已升成这个项目的规则/.test(r3.out) && fs.existsSync(ruleFile(A, 'web')), r3.out);
  H.ok('前端规则的 paths 一个模式一行', /  - "\*\*\/\*\.vue"\n  - "\*\*\/\*\.js"\n/.test(H.read(ruleFile(A, 'web'))), H.read(ruleFile(A, 'web')));
}

H.section('两个项目里都成了规则：等用户确认升用户级');
let pendingId = '';
{
  const t = ['--text', 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空，空的直接返回空结果'];
  for (const [root, file] of [[A, 'src/main/resources/mapper/OrderMapper.xml'], [B, 'src/main/resources/mapper/UserMapper.xml']]) {
    lesson(root, ['add', '--file', file].concat(t, ['--from', 'm1 1.1', '--new']));
    const r = lesson(root, ['add', '--file', file].concat(t, ['--from', 'm2 1.1']));
    H.ok(path.basename(root) + ' 里升成了规则', /已升成这个项目的规则/.test(r.out), r.out);
    if (root === B) H.ok('第二个项目升的时候说了等确认', /可以升成用户级/.test(r.out), r.out);
  }
  const p = L.pendingUser();
  pendingId = p[0] && p[0].id;
  H.ok('待确认一条', p.length === 1 && Object.keys(p[0].projects).length === 2, p);
  H.ok('还没写用户级规则', !fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-sql.md')));
  const sl = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ cwd: A, model: { display_name: 'm' } }) });
  H.ok('状态栏提醒', /经验待确认 1 条/.test(sl.out), sl.out);
  // 带项目特有名字的，两个项目里都有也不升
  const t2 = ['--text', '调 OrderMapper.selectByIds 之前：先判空列表，传空列表会拼出 in () 报错'];
  H.write(path.join(B, 'src/main/java/OrderMapper.java'), 'interface OrderMapper {}\n'); H.git(B, ['add', '-A']); H.git(B, ['commit', '-q', '-m', 'feat: x']);
  lesson(B, ['add', '--file', 'src/main/java/U.java'].concat(t2, ['--from', 'n1 1.1', '--new']));
  lesson(B, ['add', '--file', 'src/main/java/U.java'].concat(t2, ['--from', 'n2 1.1']));
  H.ok('带项目特有名字的不列为待确认', L.pendingUser().length === 1, L.pendingUser());
  const help = lesson(A, ['promote', pendingId]);
  H.ok('命令行里没有"升用户级"（只能用户在配置页点）', !fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-sql.md')) && /经验规则/.test(help.out), help.out);
  const r = L.promoteUser(pendingId);
  const uf = path.join(h.cfg, 'rules', 'ttls-lessons-sql.md');
  H.ok('用户点了：写进用户目录的规则', r.ok && fs.existsSync(uf) && /几个项目的审查里都出现过/.test(H.read(uf)) && /foreach 传空列表/.test(H.read(uf)), H.read(uf));
  H.ok('用户级的 paths', /  - "\*\*\/\*\.xml"\n  - "\*\*\/\*\.sql"\n/.test(H.read(uf)), H.read(uf));
  H.ok('不再待确认', L.pendingUser().length === 0);
  const ov = L.overview();
  H.ok('配置页能看到：用户级、两个项目', ov.user.length === 1 && ov.projects.length === 2 && ov.projects.every((p2) => p2.files.length > 0), ov);
  const e = L.editRule('user', '', ov.user[0].rules[0].id, 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空');
  H.ok('配置页改字', e.ok && /调用前先判空\n/.test(H.read(uf)), H.read(uf));
  const del = L.editRule('user', '', ov.user[0].rules[0].id, null);
  H.ok('配置页删掉：没有规则了文件也删掉', del.ok && !fs.existsSync(uf));
  H.git(A, ['add', '.claude/rules']); H.git(A, ['commit', '-q', '-m', 'docs: 更新经验规则']);
}

H.section('过时的规则：提到的类、文件不在了就退役');
{
  H.ok('现在没有过时的', L.tidy(A, false).stale.length === 0, L.tidy(A, false));
  H.git(A, ['rm', '-q', 'src/main/java/com/x/OrderMapper.java', 'src/main/resources/mapper/OrderMapper.xml']);
  H.git(A, ['commit', '-q', '-m', 'refactor: 去掉 OrderMapper']);
  const t = lesson(A, ['tidy']);
  H.ok('查出来了', /发现 1 条过时的规则/.test(t.out) && t.out.includes(id1), t.out);
  H.ok('没加 --apply 不动文件', L.readRuleFile(ruleFile(A, 'java')).rules.some((r) => r.id === id1));
  const t2 = lesson(A, ['tidy', '--apply']);
  H.ok('退掉了', /已退掉 1 条/.test(t2.out) && !L.readRuleFile(ruleFile(A, 'java')).rules.some((r) => r.id === id1), t2.out);
  H.ok('记在候选里，带原因', L.readCandidates(A).some((c) => c.id === id1 && c.state === 'retired' && /OrderMapper/.test(c.why)), L.readCandidates(A));
}

H.section('退役、列表');
{
  const d = L.readRuleFile(ruleFile(A, 'java'));
  const victim = d.rules[0];
  const r0 = lesson(A, ['retire', victim.id]);
  H.ok('退役要写原因', r0.code === 1 && /原因/.test(r0.out), r0.out);
  const r = lesson(A, ['retire', victim.id, '--why', '项目已经统一加了参数校验，这条用不上了']);
  H.ok('退役', r.code === 0 && !L.readRuleFile(ruleFile(A, 'java')).rules.some((x) => x.id === victim.id), r.out);
  const l = lesson(A, ['list']);
  H.ok('列表', /项目 projA/.test(l.out) && /手写/.test(l.out) && /候选/.test(l.out) && /用户级/.test(l.out), l.out);
  const n = lesson(A, ['none', '--from', 'add-export']);
  H.ok('none', n.code === 0 && /没有需要沉淀的经验/.test(n.out), n.out);
}

H.section('能用脚本查的：转成问题反馈');
{
  const r = lesson(A, ['add', '--file', JAVA, '--when', '写 Mapper 的 XML 时', '--do', '不许用 ${} 拼接参数', '--from', 'add-export 2.3', '--checkable', '在改过的 xml 里搜 ${']);
  H.ok('记成了问题反馈，不进候选', r.code === 0 && /已记成一条问题反馈（F\d{8}-\d+）/.test(r.out) && !L.readCandidates(A).some((c) => /拼接参数/.test(c.text)), r.out);
  const fdir = path.join(h.kit, 'feedback');
  H.ok('反馈文件在', fs.existsSync(fdir) && fs.readdirSync(fdir).some((f) => /\.md$/.test(f)));
}

H.section('收工检查：审查报了问题、处理过了，却没记经验（"审查报的问题自动收"关着的时候才催）');
{
  H.setConfig(h, { lessonAuto: false });
  const tfile = path.join(h.root, 'tl.jsonl');
  const stop = (sid, entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: A, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: false, last_assistant_message: said || '审查的问题都改完了' });
  const review = (issues, mode) => H.tr.ran('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：' + (mode || '代码') + '\n变更：openspec/changes/add-export/\n改了 src/main/java/com/x/OrderService.java', run_in_background: false }, '- 位置：OrderService.java:12\n- 问题：没判空\n\n结论：问题 ' + issues + ' 条（会出错 ' + issues + '，有隐患 0，建议 0）');
  const fix = H.tr.ran('Edit', { file_path: path.join(A, JAVA), old_string: 'a', new_string: 'b' }, 'ok');
  const asked = (r) => !!r && /各记一条经验/.test(H.reasonOf(r));
  const e1 = [H.tr.user('审一下'), review(2), fix, H.tr.say('审查的问题都改完了')];
  const r1 = stop('s-l1', e1);
  H.ok('报了问题、改了、没记：催', asked(r1), r1);
  H.ok('催的话里有写法和"不用记"的出口', /lesson\.js" add --file/.test(H.reasonOf(r1)) && /没有需要沉淀的经验/.test(H.reasonOf(r1)), H.reasonOf(r1));
  const r1b = stop('s-l1', e1.concat([H.tr.user('还有别的吗'), H.tr.say('没有了')]));
  H.ok('同一次审查只催一次', !asked(r1b), r1b);
  const r2 = stop('s-l2', [H.tr.user('审一下'), review(2), fix, H.tr.ran('Bash', { command: 'node "$HOME/.claude/vibe-kit/tools/lesson.js" add --file a.java --when "x" --do "y" --from "add-export 1.1"' }, '已记下'), H.tr.say('都改完了')]);
  H.ok('记过了：不催', !asked(r2), r2);
  const r3 = stop('s-l3', [H.tr.user('审一下'), review(2), fix, H.tr.say('都改完了。都是笔误，没有需要沉淀的经验。')], '都改完了。都是笔误，没有需要沉淀的经验。');
  H.ok('说了没有要沉淀的：不催', !asked(r3), r3);
  const e4 = [H.tr.user('审一下'), review(2), H.tr.say('审查报了 2 条，我先看看')];
  const r4 = stop('s-l4', e4);
  H.ok('还没动手处理：先不催', !asked(r4), r4);
  const r4b = stop('s-l4', e4.concat([H.tr.user('改吧'), H.tr.ran('Edit', { file_path: path.join(A, JAVA), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.say('都改完了')]));
  H.ok('处理完了再催', asked(r4b), r4b);
  const r5 = stop('s-l5', [H.tr.user('审一下'), review(0), fix, H.tr.say('审查没问题')]);
  H.ok('审查报 0 条：不催', !asked(r5), r5);
  const r6 = stop('s-l6', [H.tr.user('复审'), review(1, '复审代码'), fix, H.tr.say('都改完了')]);
  H.ok('复审那几轮不催', !asked(r6), r6);
  H.setConfig(h, { lessons: 'off' });
  const r7 = stop('s-l7', [H.tr.user('审一下'), review(2), fix, H.tr.say('都改完了')]);
  H.ok('关着：不催', !asked(r7), r7);
  H.setConfig(h, { lessons: 'on', lessonAuto: true });
  const r8 = stop('s-l8', [H.tr.user('审一下'), review(2), fix, H.tr.say('审查的问题都改完了')]);
  H.ok('"审查报的问题自动收"开着：脚本自己收，不催它记', !asked(r8), r8);
}

H.done('经验规则');

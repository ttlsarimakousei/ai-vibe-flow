'use strict';
/*
 * 0930 这一版的两件"自动"的事：
 *   审查报的问题自动收、自动归并成规则（kit/lib/lessons.js 的 autoCollect，开关 lessonAuto）
 *   查库、查 redis 的工具的用量和毛病并进问题反馈（kit/lib/toolstats.js）
 * 用法：node dev/test-auto-0930.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('auto0930', null, { autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', commitMode: 'off', vibeTidy: false, specGate: false, lessons: 'on', lessonThreshold: 2 });
const L = require(path.join(h.kit, 'lib', 'lessons.js'));
const proj = H.makeRepo(path.join(h.work, 'proj'), {
  'pom.xml': '<project/>\n',
  '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 快检：mvn -q -o compile\n',
  'src/main/java/com/x/OrderService.java': 'class OrderService {}\n',
  'src/main/java/com/x/UserService.java': 'class UserService {}\n',
  'src/main/java/com/x/ExportService.java': 'class ExportService {}\n',
  'src/main/java/com/x/PayService.java': 'class PayService {}\n',
  'src/main/java/com/x/RoleService.java': 'class RoleService {}\n',
  'web/src/views/Order.vue': '<template><div/></template>\n',
});
for (const c of ['c1', 'c2', 'c3', 'c4']) H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '- [x] 1.1 改 src/main/java/com/x/A.java；验：`mvn -q -o compile`\n');
const J = (n) => path.join(proj, 'src/main/java/com/x', n);
const finding = (where, problem, sev, kind, when) => ['- 位置：`' + where + '`', '- 问题：' + problem, '- **什么情况下会出错**：' + (when || '传空的时候'), '- 严重程度：' + sev, '- 类别：' + kind].join('\n');
const reviewText = (list) => list.join('\n\n') + '\n\n结论：问题 ' + list.length + ' 条（会出错 ' + list.length + '，有隐患 0，建议 0）';
let seq = 0;
/** 一个会话：审查报了这些问题，之后改了这些文件，然后说做完了。跑收工检查 */
function session(change, findings, editFiles, opts) {
  const o = opts || {};
  const id = 'toolu_auto_' + (++seq);
  const entries = [H.tr.user('做 ' + change)]
    .concat((o.before || []).map((f) => H.tr.ran('Edit', { file_path: f, old_string: 'a', new_string: 'b' }, 'ok')))
    .concat([H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：' + (o.mode || '代码') + '\n变更：openspec/changes/' + change + '/\n材料…', run_in_background: false }, id), H.tr.result(id, reviewText(findings))])
    .concat(editFiles.map((f) => H.tr.ran('Edit', { file_path: f, old_string: 'a', new_string: 'b' }, 'ok')))
    .concat([H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'ok'), H.tr.say('改完了。没有需要沉淀的经验。')]);
  const tf = H.transcript(path.join(h.work, 't-' + seq + '.jsonl'), entries);
  return H.hook(h, 'verify-gate', { session_id: 's-auto-' + seq, cwd: proj, hook_event_name: 'Stop', transcript_path: tf, stop_hook_active: false, last_assistant_message: '改完了。没有需要沉淀的经验。' });
}
const ruleFile = path.join(proj, '.claude', 'rules', 'ttls-lessons-java.md');
const rules = () => L.readRuleFile(ruleFile).rules;
const cands = () => L.readCandidates(proj);
const found = () => L.readFindings(proj).items;

// ---------------------------------------------------------------------------------------------
H.section('从审查者的回复里取出问题');
{
  const t = ['这次改动有两个问题。', '', '1. 位置：`src/A.java:12`', '   问题：导出接口没有判断列表为空', '   什么情况下会出错：列表为空时抛异常', '   严重程度：会出错', '   类别：边界', '',
    '- **位置**：src/B.java:30-35、src/C.java:8', '- **问题**：分页参数为空时直接拼进 SQL。', '- **什么情况下会出错**：不传分页参数', '- **严重程度**：有隐患', '- **类别（选一个）**：数据库', '',
    '- 位置：src/D.java', '- 严重程度：建议', '', '结论：问题 2 条（会出错 1，有隐患 1，建议 0）'].join('\n');
  const f = L.parseFindings(t);
  H.ok('两种写法都认；没写"问题"的那条不要', f.length === 2 && f[0].file === 'src/A.java' && f[0].problem === '导出接口没有判断列表为空' && f[0].severity === '会出错' && f[0].kind === '边界' && f[1].file === 'src/B.java' && f[1].kind === '数据库' && f[1].severity === '有隐患' && /拼进 SQL/.test(f[1].problem), f);
  H.ok('没有问题的回复：取不出东西', L.parseFindings('没发现问题。\n\n结论：问题 0 条').length === 0);
}

// ---------------------------------------------------------------------------------------------
H.section('第一个变更：收下来，还不是规则');
{
  session('c1', [
    finding('src/main/java/com/x/OrderService.java:12', '导出接口没有判断列表为空', '会出错', '边界'),
    finding('src/main/java/com/x/UserService.java:30', '分页参数为空时直接拼进 SQL', '有隐患', '数据库'),
    finding('src/main/java/com/x/OrderService.java:40', '变量命名不统一', '建议', '其他'),
  ], [J('OrderService.java')]);
  const f = found();
  H.ok('报了之后改过的那条收了；没改过的、只是建议的不收', f.length === 1 && f[0].problem === '导出接口没有判断列表为空' && f[0].change === 'c1' && f[0].group === 'java' && f[0].kind === '边界' && f[0].file === 'src/main/java/com/x/OrderService.java', f);
  H.ok('进了候选，标着是自动收的；还没有规则', cands().length === 1 && cands()[0].auto === true && cands()[0].sources.length === 1 && !fs.existsSync(ruleFile), cands());
  H.ok('收下来的东西在 .vibe 里（不进仓库）', fs.existsSync(path.join(proj, '.vibe', 'lessons', 'findings.json')));
  // 同一个会话再收工一次：不重复收
  session('c1', [finding('src/main/java/com/x/OrderService.java:12', '导出接口没有判断列表为空', '会出错', '边界')], [J('OrderService.java')]);
  H.ok('同一个变更里同一条再报：不重复收、不加次数', found().length === 1 && cands()[0].sources.length === 1, [found(), cands()]);
}

H.section('第二个变更里又出现：自动变成规则');
{
  const r = session('c2', [finding('src/main/java/com/x/ExportService.java:8', '导出接口没判断列表为空就写文件', '会出错', '边界')], [J('ExportService.java')]);
  const rs = rules();
  H.ok('说法差不多、类别一样：当成同一条，第 2 个变更里出现就升成规则', rs.length === 1 && rs[0].text === '导出接口没有判断列表为空' && rs[0].count === 2 && rs[0].auto === '具体' && rs[0].kind === '边界' && rs[0].from.join() === 'c1,c2', rs);
  H.ok('规则文件里标着"自动"', /<!-- L[0-9a-f]+ 次数=2 最近=\d{4}-\d\d-\d\d 类别=边界 自动=具体 出处=c1；c2 -->\n- 导出接口没有判断列表为空/.test(H.read(ruleFile) || ''), H.read(ruleFile));
  H.ok('读到 Java 文件才带上（paths）', /^---\npaths:\n {2}- "\*\*\/\*\.java"\n---/.test(H.read(ruleFile) || ''), H.read(ruleFile));
  H.ok('候选里没有它了', !cands().some((c) => c.state === 'candidate' && /导出接口/.test(c.text)), cands());
  H.ok('记着规则文件要提交', L.uncommitted(proj).some((x) => x.rel === '.claude/rules/ttls-lessons-java.md'), L.uncommitted(proj));
  H.ok('关闭自动提交仍提醒，但不指令自动提交', /经验规则文件更新了/.test(H.reasonOf(r)) && /Ask/.test(H.reasonOf(r)));
}

H.section('已经是规则了还被审出来：记"没管住"');
{
  session('c3', [finding('src/main/java/com/x/PayService.java:5', '导出接口没有判断列表为空', '会出错', '边界')], [J('PayService.java')]);
  const r = rules().find((x) => /导出接口/.test(x.text));
  H.ok('次数加一，没管住加一', r && r.count === 3 && r.miss === 1 && r.from.includes('c3'), r);
}

H.section('同一类在好几个变更里反复出现：出一条"这一类要对照检查"');
{
  const cat = rules().find((x) => x.auto === '类别');
  H.ok('边界类已经在 3 个变更里出现：出了按类别的规则', cat && /^边界类的问题在审查里反复出现，写完对照这一类自查。例如：/.test(cat.text) && cat.count === 3 && /^L[0-9a-f]{8}$/.test(cat.id), rules());
  H.ok('规则的文字里没有个数（个数是各人电脑上自己数的，写进去同事之间会来回改同一行）', cat && !/\d+ 个变更|\d+ 条/.test(cat.text), cat);
  H.ok('例子里说法差不多的只留一个', cat && (cat.text.match(/导出接口/g) || []).length === 1, cat);
  const fileBefore = H.read(ruleFile);
  session('c4', [finding('src/main/java/com/x/RoleService.java:9', '重复提交没有拦截', '会出错', '边界', '连点两次保存')], [J('RoleService.java')]);
  const cat2 = rules().find((x) => x.auto === '类别');
  H.ok('又来一个变更：那条规则不跟着改，规则文件一个字没变（以前每来一条就改一次、催一次提交）', cat2 && cat2.id === cat.id && cat2.text === cat.text && cat2.count === 3 && H.read(ruleFile) === fileBefore, cat2);
  for (const c of ['k1', 'k2']) H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
  session('k1', [finding('src/main/java/com/x/PayService.java:19', '金额是零的时候除出了异常', '会出错', '边界')], [J('PayService.java')]);
  session('k2', [finding('src/main/java/com/x/ExportService.java:29', '文件名超长时没有截断', '会出错', '边界')], [J('ExportService.java')]);
  const cat3 = rules().find((x) => x.auto === '类别');
  H.ok('又多出来 3 个变更：次数更新一次，文字还是原来的', cat3 && cat3.id === cat.id && cat3.text === cat.text && cat3.count === 6, cat3);
  H.ok('不同的问题各是各的候选', cands().some((c) => c.text === '重复提交没有拦截' && c.auto), cands());
  H.ok('一条规则不超过字数上限', rules().every((x) => x.text.length <= 120), rules().map((x) => x.text.length));
}

H.section('审查者写的是相对子项目的路径、前端的文件、提案的审查');
{
  session('c4', [finding('web/src/views/Order.vue:3', '列表为空时没有空状态提示', '有隐患', '前端交互')], [path.join(proj, 'web/src/views/Order.vue')]);
  H.ok('前端的文件归到前端那一组', found().some((x) => x.group === 'web' && x.kind === '前端交互'), found().slice(-2));
  session('c4', [finding('openspec/changes/c4/design.md:10', '设计里说的表不存在', '会出错', '想当然')], [path.join(proj, 'openspec/changes/c4/design.md')], { mode: '提案' });
  H.ok('提案的审查归到提案那一组', found().some((x) => x.group === 'spec' && x.mode === '提案'), found().slice(-2));
  // 壳子里开的会话：审查者写的路径相对子项目
  const shell = H.makeRepo(path.join(h.work, 'shell'), { 'CLAUDE.md': '# 壳子\n', 'openspec/changes/s1/tasks.md': '- [x] 1.1 x；验：`mvn -q compile`\n' });
  const sub = H.makeRepo(path.join(shell, 'backend'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n' });
  const id = 'toolu_shell_1';
  const tf = H.transcript(path.join(h.work, 't-shell.jsonl'), [H.tr.user('做 s1'), H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/s1/\n仓库在 backend', run_in_background: false }, id), H.tr.result(id, reviewText([finding('src/main/java/A.java:1', '空指针没处理', '会出错', '边界')]))].concat(H.tr.ran('Edit', { file_path: path.join(sub, 'src/main/java/A.java'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q compile' }, 'ok'), [H.tr.say('改完了。没有需要沉淀的经验。')]));
  H.hook(h, 'verify-gate', { session_id: 's-auto-shell', cwd: shell, hook_event_name: 'Stop', transcript_path: tf, stop_hook_active: false, last_assistant_message: '改完了。没有需要沉淀的经验。' });
  H.ok('路径相对子项目的：认到子项目里，收在子项目的 .vibe 下', L.readFindings(sub).items.length === 1 && L.readFindings(sub).items[0].file === 'src/main/java/A.java' && !fs.existsSync(path.join(shell, '.vibe', 'lessons', 'findings.json')), L.readFindings(sub));
}

H.section('人删掉、改过的，脚本不再动');
{
  const cat = rules().find((x) => x.auto === '类别');
  const ed = L.editRule('project', proj, rules().find((x) => x.auto === '具体').id, '导出之前先判断列表是不是空的，空的返回空文件');
  const edited = rules().find((x) => /导出之前先判断/.test(x.text));
  H.ok('在配置页里改了措辞：不再标"自动"', ed.ok && edited && edited.auto === '', edited);
  H.ok('删掉按类别出的那条', L.editRule('project', proj, cat.id, null).ok && !rules().some((x) => x.id === cat.id));
  for (const c of ['c5']) H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
  session('c5', [finding('src/main/java/com/x/UserService.java:2', '金额为负数时没有校验', '会出错', '边界')], [J('UserService.java')]);
  H.ok('再收到同类的问题：删掉的那条不会再冒出来', !rules().some((x) => x.id === cat.id) && found().some((x) => x.change === 'c5'), rules());
  const view = L.projectView(proj);
  H.ok('配置页拿得到收了多少、各类多少', view.findings.total >= 6 && view.findings.by[0].group === 'java' && view.findings.by[0].kind === '边界' && view.findings.by[0].changes >= 5 && view.files.some((f) => f.rules.some((r) => 'auto' in r)), view.findings);

  // 改过字的那条（不再标着"自动"）删掉：照样记着删过，差不多的问题再来不会又升成规则
  H.ok('删掉改过字的那条', L.editRule('project', proj, edited.id, null).ok && !rules().some((x) => x.id === edited.id));
  H.ok('记着是用户删的', cands().some((c) => c.id === edited.id && c.state === 'retired' && c.byUser === true), cands().filter((c) => c.state === 'retired'));
  for (const c of ['g1', 'g2']) H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
  session('g1', [finding('src/main/java/com/x/PayService.java:5', '导出之前没有判断列表是不是空的', '会出错', '边界')], [J('PayService.java')]);
  session('g2', [finding('src/main/java/com/x/RoleService.java:5', '导出之前没判断列表是不是空的', '会出错', '边界')], [J('RoleService.java')]);
  H.ok('用户删掉的具体规则：差不多的问题又在两个变更里出现，也不会再冒出来', !rules().some((x) => /导出之前/.test(x.text)) && !cands().some((c) => c.state === 'candidate' && /导出之前/.test(c.text)), [rules().map((x) => x.text), cands().filter((c) => /导出/.test(c.text))]);
  const again = L.add({ file: 'src/main/java/com/x/PayService.java', when: '导出之前', do: '先判断列表是不是空的，空的返回空文件', from: 'g9 1.1', kind: '边界', cwd: proj });
  H.ok('模型自己去记差不多的：也不收，说了是用户删过的', again.status === 'rejected' && /用户在配置页里删过/.test(again.msg), again);
}

H.section('按类别出的规则：人改过字的不再被脚本改回去；人直接在文件里删掉的不再出');
{
  const p2 = H.makeRepo(path.join(h.work, 'proj2'), { 'pom.xml': '<project/>\n', '.vibe/project.md': '# 项目说明\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n', 'src/C.java': 'class C {}\n', 'src/D.java': 'class D {}\n' });
  const rf = path.join(p2, '.claude', 'rules', 'ttls-lessons-java.md');
  const run2 = (change, where, problem) => {
    H.write(path.join(p2, 'openspec', 'changes', change, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
    const id = 'toolu_p2_' + (++seq);
    const tf = H.transcript(path.join(h.work, 't-p2-' + seq + '.jsonl'), [H.tr.user('做 ' + change), H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/' + change + '/\n材料…', run_in_background: false }, id), H.tr.result(id, reviewText([finding(where, problem, '会出错', '权限')]))]
      .concat(H.tr.ran('Edit', { file_path: path.join(p2, where.replace(/:\d+$/, '')), old_string: 'a', new_string: 'b' }, 'ok'), [H.tr.say('改完了。')]));
    return H.hook(h, 'verify-gate', { session_id: 's-p2-' + seq, cwd: p2, hook_event_name: 'Stop', transcript_path: tf, stop_hook_active: false, last_assistant_message: '改完了。' });
  };
  run2('m1', 'src/A.java:1', '删除按钮没有判断权限');
  run2('m2', 'src/B.java:1', '导出接口谁都能调');
  run2('m3', 'src/C.java:1', '越权能看到别的部门的单子');
  const cat = L.readRuleFile(rf).rules.find((x) => x.auto === '类别');
  H.ok('三个变更之后出了"权限"这一类的规则', !!cat && /^权限类的问题/.test(cat.text), L.readRuleFile(rf).rules);
  H.ok('在配置页里改了字', L.editRule('project', p2, cat.id, '涉及增删改、导出的接口：都要有权限判断，写完对照菜单权限表查一遍').ok);
  for (const [c, f2, p] of [['m4', 'src/D.java:1', '审批接口没有校验是不是本人的单子'], ['m5', 'src/A.java:1', '批量删除绕过了数据权限'], ['m6', 'src/B.java:1', '下载附件没有校验归属'], ['m7', 'src/C.java:1', '菜单隐藏了但接口还能调']]) run2(c, f2, p);
  const kept = L.readRuleFile(rf).rules.find((x) => x.id === cat.id);
  H.ok('又来了四个变更的同类问题：人改的字还在（以前下一条同类的问题一来就被改回去）', kept && kept.text === '涉及增删改、导出的接口：都要有权限判断，写完对照菜单权限表查一遍' && kept.auto === '', kept);
  // 人直接在规则文件里把那两行删了
  const text = H.read(rf).split('\n').filter((l) => !l.includes(cat.id) && !l.includes('涉及增删改')).join('\n');
  fs.writeFileSync(rf, text);
  H.ok('人在文件里删掉了这一条', !L.readRuleFile(rf).rules.some((x) => x.id === cat.id));
  run2('m8', 'src/D.java:1', '角色被停用之后令牌还能用');
  H.ok('再来同类的问题：不再出（以前文件里删的没有记录，会整条加回来）', !L.readRuleFile(rf).rules.some((x) => x.id === cat.id) && !L.readRuleFile(rf).rules.some((x) => x.auto === '类别'), L.readRuleFile(rf).rules);
}

H.section('不该收的不收：写了"无"的几种写法、驳回了的、带着口令的、说法像但不是一回事的');
{
  const p3 = H.makeRepo(path.join(h.work, 'proj3'), { 'pom.xml': '<project/>\n', '.vibe/project.md': '# 项目说明\n', 'src/A.java': 'class A {}\n', 'src/B.java': 'class B {}\n', 'src/DbUtil.java': 'class DbUtil {}\n' });
  const run3 = (change, list, files, extra) => {
    if (!(extra && extra.noDir)) H.write(path.join(p3, 'openspec', 'changes', change, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
    const id = 'toolu_p3_' + (++seq);
    const tf = H.transcript(path.join(h.work, 't-p3-' + seq + '.jsonl'), [H.tr.user('做 ' + change), H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：' + ((extra && extra.line) || 'openspec/changes/' + change + '/') + '\n材料…', run_in_background: false }, id), H.tr.result(id, (extra && extra.head ? extra.head + '\n\n' : '') + reviewText(list))]
      .concat(files.map((f) => H.tr.ran('Edit', { file_path: path.join(p3, f), old_string: 'a', new_string: 'b' }, 'ok')), [H.tr.say('改完了。')]));
    return H.hook(h, 'verify-gate', { session_id: 's-p3-' + seq, cwd: p3, hook_event_name: 'Stop', transcript_path: tf, stop_hook_active: false, last_assistant_message: '改完了。' });
  };
  const items = () => L.readFindings(p3).items;
  const withAvoid = (where, problem, avoid, kind) => finding(where, problem, '会出错', kind || '边界') + '\n- 以后怎么避免：' + avoid;
  for (const a of ['无（一次性疏忽）', '暂无', '不适用，笔误', '无，只是漏看了', 'N/A']) H.ok('"以后怎么避免：' + a + '"算"无"', L.parseFindings(withAvoid('src/A.java:1', '变量名拼错', a))[0].avoid === '无');
  H.ok('"无线网络断开时：先提示再重试"不算"无"', L.parseFindings(withAvoid('src/A.java:1', 'x 没处理', '无线网络断开时：先提示再重试'))[0].avoid !== '无');
  run3('n1', [withAvoid('src/A.java:1', '变量名拼错了', '无（一次性疏忽）')], ['src/A.java']);
  run3('n2', [withAvoid('src/B.java:1', '变量名拼错了一个字母', '无（一次性疏忽）')], ['src/B.java']);
  H.ok('两个变更里都写"无（一次性疏忽）"：一条都不收，规则文件里没有多出"无（一次性疏忽）"这一条', items().length === 0 && !fs.existsSync(path.join(p3, '.claude', 'rules', 'ttls-lessons-java.md')), [items(), L.readCandidates(p3)]);

  // 审查者的原话里引了代码里的口令
  run3('n3', [finding('src/DbUtil.java:3', 'DbUtil 里 password = "Prod#2024x" 写死了', '会出错', '项目约定')], ['src/DbUtil.java']);
  const sec = items().find((x) => x.change === 'n3');
  H.ok('带着口令的：本机的记录里遮掉了，不进候选', sec && sec.secret === true && !/Prod#2024x/.test(JSON.stringify(items())) && !/Prod#2024x/.test(JSON.stringify(L.readCandidates(p3))) && !L.readCandidates(p3).some((c) => /DbUtil/.test(c.text)), [sec, L.readCandidates(p3)]);

  // 模型核对之后驳回的意见：同一个文件因为别的问题改过，也不收
  H.write(path.join(p3, 'openspec', 'changes', 'n4', 'revisions.md'), '## 2026-09-30 10:00 · 代码审查\n- 起因：审查。第 2 条"保存接口没做参数校验"不成立：有全局的参数校验，见 ValidAdvice\n- 改了：第 1 条，补了空列表的判断\n- 上层：不用改\n');
  run3('n4', [finding('src/A.java:1', '查询之前没有判断列表为空', '会出错', '边界'), finding('src/A.java:9', '保存接口没做参数校验', '会出错', '边界')], ['src/A.java']);
  H.ok('驳回了的那条不收，成立的那条照收', items().some((x) => x.change === 'n4' && /判断列表为空/.test(x.problem)) && !items().some((x) => /参数校验/.test(x.problem)), items());

  // 套话一样、说的不是一回事
  run3('n5', [withAvoid('src/A.java:1', '批量插入有重复的主键', '批量插入之前：先按主键去重', '数据库')], ['src/A.java']);
  run3('n6', [withAvoid('src/B.java:1', '批量更新互相死锁', '批量更新之前：先按主键排序', '数据库')], ['src/B.java']);
  const two = L.readCandidates(p3).filter((c) => /批量/.test(c.text));
  H.ok('"先按主键去重"和"先按主键排序"：各是各的候选，没有并成一条规则', two.length === 2 && two.every((c) => c.sources.length === 1) && !fs.existsSync(path.join(p3, '.claude', 'rules', 'ttls-lessons-sql.md')) && !(L.readRuleFile(path.join(p3, '.claude', 'rules', 'ttls-lessons-java.md')).rules || []).some((r) => /批量/.test(r.text)), two);

  H.section('收工之前就归档了的变更、"变更：无"的小改动：照样收');
  fs.mkdirSync(path.join(p3, 'openspec', 'changes', 'archive', '2026-09-30-done-x'), { recursive: true });
  run3('done-x', [finding('src/A.java:1', '时间没有按东八区算', '会出错', '边界')], ['src/A.java'], { noDir: true });
  H.ok('已经归档的变更：认得出，出处是那个变更', items().some((x) => x.change === 'done-x' && /东八区/.test(x.problem)), items().slice(-2));
  run3('x', [finding('src/B.java:1', '循环里反复查库', '有隐患', '数据库')], ['src/B.java'], { noDir: true, line: '无' });
  H.ok('"变更：无"的小改动：出处是"日期 小改动"', items().some((x) => /^\d{4}-\d\d-\d\d 小改动$/.test(x.change) && /反复查库/.test(x.problem)), items().slice(-2));

  H.section('审查者的写法不标准');
  const odd = L.parseFindings(['- 问题：先写的问题', '- 位置：`src/A.java:45`（updateUser 方法）', '- 严重程度：会出错', '', '- 问题：第二条的问题', '- 位置：src/B.java 第 12 行', '- 严重程度：有隐患', '', '- 问题：以上都属于边界处理不足', '',
    '| 位置 | 问题 | 严重程度 | 类别 |', '|---|---|---|---|', '| src/C.java#L3 | 表格里的问题 | 会出错 | 边界 |', '| src/D.java:3-9 | 表格里的第二条 | 有隐患 | 权限 |'].join('\n'));
  H.ok('先写问题后写位置：不张冠李戴；末尾的总结行不算一条', odd.length === 4 && odd[0].file === 'src/A.java' && odd[0].problem === '先写的问题' && odd[1].file === 'src/B.java' && odd[1].problem === '第二条的问题', odd);
  H.ok('位置后面带括号、写"第 N 行"、#L3、3-9：都取得出文件', odd.map((x) => x.file).join() === 'src/A.java,src/B.java,src/C.java,src/D.java', odd.map((x) => x.file));
  H.ok('表格也认', odd[2].problem === '表格里的问题' && odd[2].kind === '边界' && odd[3].severity === '有隐患', odd.slice(2));
  H.ok('复审的时候引了上一轮的结论：以最后一个为准', require(path.join(h.kit, 'lib', 'session.js')).reviewIssues('上一轮结论：问题 3 条\n都改对了。\n结论：问题 0 条') === 0);

  H.section('记录文件坏了：留一份，不当成空的直接盖掉');
  const cf = L.candidatesFile(p3);
  const had = L.readCandidates(p3).length;
  fs.writeFileSync(cf, '{"version":1,"items":[{"id":"L1"');
  H.ok('读不懂的当成没有', had > 0 && L.readCandidates(p3).length === 0);
  H.ok('坏掉的那一份改名留着了', fs.existsSync(cf + '.bad') && /"id":"L1"/.test(H.read(cf + '.bad')), fs.readdirSync(path.dirname(cf)));
  H.ok('临时文件没有留下', !fs.readdirSync(path.dirname(cf)).some((n) => /\.tmp$/.test(n)) && !fs.existsSync(path.join(p3, '.claude', 'rules')) || !fs.readdirSync(path.join(p3, '.claude', 'rules')).some((n) => /\.tmp$/.test(n)));
}

H.section('开关');
{
  const n = found().length;
  H.setConfig(h, { lessonAuto: false });
  H.write(path.join(proj, 'openspec', 'changes', 'c6', 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
  session('c6', [finding('src/main/java/com/x/UserService.java:9', '时区没处理', '会出错', '边界')], [J('UserService.java')]);
  H.ok('lessonAuto 关了：不收', found().length === n);
  H.setConfig(h, { lessonAuto: true, lessons: 'off' });
  session('c6', [finding('src/main/java/com/x/UserService.java:9', '时区没处理', '会出错', '边界')], [J('UserService.java')]);
  H.ok('经验规则整个关了：不收', found().length === n);
  H.setConfig(h, { lessons: 'collect' });
  const before = (H.read(ruleFile) || '');
  session('c6', [finding('src/main/java/com/x/UserService.java:9', '时区没处理', '会出错', '边界')], [J('UserService.java')]);
  H.ok('只收集、不生成规则：收了，规则文件没变', found().length === n + 1 && (H.read(ruleFile) || '') === before, [found().length, n]);
  H.setConfig(h, { lessons: 'on' });
}

// ---------------------------------------------------------------------------------------------
H.section('规则的文字用审查者写的"以后怎么避免"');
{
  // "问题"那一句说的是哪里错了，规则要的是该怎么做：审查者每条多写一行"以后怎么避免"
  for (const c of ['d1', 'd2', 'd3', 'e1', 'e2']) H.write(path.join(proj, 'openspec', 'changes', c, 'tasks.md'), '- [x] 1.1 x；验：`mvn -q compile`\n');
  const withAvoid = (where, problem, avoid, kind) => finding(where, problem, '会出错', kind || '连带影响') + '\n- 以后怎么避免：' + avoid;
  const AVOID = '删字段、改方法名之前：全局搜一遍引用，包括字符串拼出来的';
  const pf = L.parseFindings(reviewText([withAvoid('src/A.java:1', '删了字段没搜引用', AVOID), withAvoid('src/B.java:2', '变量名拼错', '无。'), finding('src/C.java:3', '没判空', '会出错', '边界')]));
  H.ok('取得出这一句；写"无"的认得；没写的是空的', pf.length === 3 && pf[0].avoid === AVOID && pf[1].avoid === '无' && pf[2].avoid === '', pf);
  const n = found().length;
  session('d1', [withAvoid('src/main/java/com/x/PayService.java:3', '删了 status 字段，报表里还在用', AVOID), withAvoid('src/main/java/com/x/PayService.java:9', '变量名拼错', '无')], [J('PayService.java')]);
  H.ok('写"无"的不收（一次性的疏忽，换个任务不会再犯）', found().length === n + 1 && !found().some((x) => x.problem === '变量名拼错'), found().slice(-2));
  const c = cands().find((x) => x.text === AVOID);
  H.ok('候选的文字是"以后怎么避免"那一句；"问题"那一句留着，对相近的时候用', c && c.alt === '删了 status 字段，报表里还在用' && c.auto === true, cands().slice(-2));
  session('d2', [finding('src/main/java/com/x/RoleService.java:3', '删了 status 字段，导出里还在用', '会出错', '连带影响')], [J('RoleService.java')]);
  const r = rules().find((x) => x.text === AVOID);
  H.ok('另一个变更里审查者没写这一句、"问题"的说法差不多：对得上，升成规则，文字是能照着做的那一句', r && r.count === 2 && r.from.join() === 'd1,d2', [rules().map((x) => x.text), cands().slice(-2)]);
  session('d3', [withAvoid('src/main/java/com/x/UserService.java:3', '日志里打出了手机号', '尽量不要在日志里打敏感信息', '项目约定')], [J('UserService.java')]);
  H.ok('这一句写得没法照着做（带"尽量"）：不用它，用"问题"那一句', cands().some((x) => x.text === '日志里打出了手机号') && !cands().some((x) => /尽量/.test(x.text)), cands().slice(-2));
  // 先收到的那次没有这一句，后来的有：换成后来的
  session('e1', [finding('src/main/java/com/x/OrderService.java:3', '金额用 double 相加算出了误差', '会出错', '数据库')], [J('OrderService.java')]);
  session('e2', [withAvoid('src/main/java/com/x/PayService.java:3', '金额用 double 相乘算出了误差', '算金额：用 BigDecimal，不用 double 和 float', '数据库')], [J('PayService.java')]);
  const m = rules().find((x) => /BigDecimal/.test(x.text));
  H.ok('先收的那次没有这一句、后来的有：规则用后来这一句', m && m.text === '算金额：用 BigDecimal，不用 double 和 float' && m.count === 2 && !rules().some((x) => /算出了误差/.test(x.text)), [rules().map((x) => x.text), cands().slice(-3)]);
  H.ok('一条规则不超过字数上限', rules().every((x) => x.text.length <= 120), rules().map((x) => x.text.length));
}

// ---------------------------------------------------------------------------------------------
H.section('工具的用量和毛病');
{
  const T = require(path.join(h.kit, 'lib', 'toolstats.js'));
  const F = require(path.join(h.kit, 'lib', 'feedback.js'));
  const log = path.join(h.kit, 'state', 'tool-usage.jsonl');
  const line = (o) => JSON.stringify(Object.assign({ at: Date.now() }, o)) + '\n';
  let text = '';
  for (let i = 0; i < 25; i++) text += line({ tool: 'ttls-db-crud', cmd: 'query', exit: 0, ms: 2000 + i * 10, java: 1, daemon: 0, cached: 0, dialect: 'dm', errors: [], project: 'proj' });
  for (let i = 0; i < 6; i++) text += line({ tool: 'ttls-db-crud', cmd: 'query', exit: 2, ms: 1800, java: 1, errors: ['SQL_ERROR:42S02:942'], project: 'proj' });
  text += line({ tool: 'ttls-db-crud', cmd: 'columns', exit: 0, ms: 90, java: 0, cached: 1, errors: [], project: 'proj' });
  for (let i = 0; i < 4; i++) text += line({ tool: 'ttls-redis', cmd: 'get', exit: 0, ms: 3100, errors: ['TIMEOUT'], project: 'proj' });
  text += line({ tool: 'ttls-db-crud', incident: 'no-driver', what: '找不到达梦的驱动', detail: '数据库：dm', cmd: 'ping', project: 'proj' });
  text += line({ tool: 'ttls-db-crud', incident: 'crash', what: 'KeyError: \'rows\'', detail: 'File "db.py", line 412, in cmd_query', cmd: 'query', project: 'proj' });
  fs.writeFileSync(log, text + '{"tool":"ttls-db-crud","cmd":"pe');     // 最后一行还没写完
  const n0 = F.listRecords().length;
  const tf = H.transcript(path.join(h.work, 't-tool.jsonl'), [H.tr.user('查一下订单表')]);
  H.hook(h, 'task-anchor', { session_id: 's-tool', cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: tf, prompt: '查一下订单表' });
  const recs = F.listRecords().slice(0, F.listRecords().length - n0);
  H.ok('工具报的两个毛病记成了问题反馈，来源写着"工具自动记录"', recs.length === 2 && recs.every((r) => r.meta['来源'] === '工具自动记录' && r.meta['涉及'] === 'ttls-db-crud' && r.meta['会话'] === 's-tool') && recs.some((r) => /找不到数据库驱动：找不到达梦的驱动/.test(r.title) && r.meta['类型'] === '卡住') && recs.some((r) => /脚本自己出错了/.test(r.title) && /db\.py/.test(r.text)), recs.map((r) => [r.title, r.meta]));
  const s = T.stats();
  const q = s.find((x) => x.tool === 'ttls-db-crud' && x.cmd === 'query') || {};
  H.ok('用量累计起来了', q.n === 31 && q.fail === 6 && q.java === 1 && q.avg > 1900 && q.errors[0][0] === 'SQL_ERROR:42S02:942' && q.errors[0][1] === 6 && s.some((x) => x.cmd === 'columns' && x.cached === 1), s);
  // 同样的毛病再来一次：不另起一条
  fs.appendFileSync(log, 'ek","exit":0,"ms":500,"java":1,"errors":[],"project":"proj","at":1}\n' + line({ tool: 'ttls-db-crud', incident: 'no-driver', what: '找不到达梦的驱动', detail: '数据库：dm', cmd: 'ping', project: 'proj' }));
  H.hook(h, 'verify-gate', { session_id: 's-tool', cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, [H.tr.user('查一下订单表'), H.tr.say('查到了')]), stop_hook_active: false, last_assistant_message: '查到了' });
  const again = F.listRecords().find((r) => /找不到数据库驱动/.test(r.title));
  H.ok('同样的毛病再来：次数加一，不另起一条；半行接上之后照样认', F.listRecords().length === n0 + 2 && Number(again.meta['次数']) === 2 && T.stats().some((x) => x.cmd === 'peek' && x.n === 1), [F.listRecords().length, again && again.meta]);
  H.ok('没有新的行：什么都不做', T.ingest(null).usage === 0);
  const tips = T.hints();
  H.ok('从用量里数出来的：查库慢（建议开后台执行器）、redis 连不上、几乎都在写 SQL', tips.some((t) => /查库的命令平均每条 \d\.\d 秒/.test(t.what) && /后台执行器/.test(t.detail)) && tips.some((t) => /ttls-redis 有 4 次连不上（TIMEOUT）/.test(t.what)) && tips.some((t) => /几乎都在写 SQL/.test(t.what)), tips);
  H.setConfig(h, { dbcrudDaemon: true });
  H.ok('后台执行器已经开着：不再建议开', !T.hints().some((t) => /后台执行器/.test(t.detail)), T.hints());
  H.setConfig(h, { dbcrudDaemon: false });
  // 2026-10-01 起没有本机导出了：工具用量、能优化的地方跟着使用情况上报（lib/usage.js），工具报的毛病是问题反馈、跟着问题上报
  const us = require(path.join(h.kit, 'lib', 'usage.js')).summary().text;
  H.ok('使用情况只传工具次数，耗时建议留本机', /查库、查 redis 的工具（累计到现在）：[^\n]*ttls-db-crud query 31 次（出错 6）/.test(us) && /ttls-redis get 4 次/.test(us) && !/从用量里看出来能优化的：/.test(us) && T.hints().some((x) => /平均每条/.test(x.what)), us);
  H.ok('工具报的毛病记成了问题反馈', F.listRecords().filter((r) => !F.isNoise(r)).some((r) => /ttls-db-crud 找不到数据库驱动/.test(r.title)), F.listRecords().map((r) => r.title));

  // 日志被工具截过（丢掉前一半），截完又长过了上次读到的位置：不能从旧位置接着读，也不能把留下的那一半再数一遍
  const nOf = (cmd) => (T.stats(100).find((x) => x.tool === 'ttls-redis' && x.cmd === cmd) || { n: 0 }).n;
  const old = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const later = Date.now() + 5000;
  let more = '';
  for (let i = 0; i < 60; i++) more += JSON.stringify({ tool: 'ttls-redis', cmd: 'ttl', exit: 0, ms: 20, errors: [], project: 'proj', at: later + i }) + '\n';
  fs.writeFileSync(log, old.slice(Math.floor(old.length / 2)).join('\n') + '\n' + more);
  const getBefore = nOf('get');
  const r1 = T.ingest(null);
  H.ok('日志被截过又长回去：只数新记的那些，留下的那一半不重复数', r1.usage === 60 && nOf('ttl') === 60 && nOf('get') === getBefore, [r1, nOf('ttl'), nOf('get'), getBefore]);
  H.ok('接着没有新的行：什么都不做', T.ingest(null).usage === 0);
  // 日志太大：由套件这头丢掉前一半（redis 那头只管追加）
  let big = '';
  const row = (i) => JSON.stringify({ tool: 'ttls-redis', cmd: 'ping', exit: 0, ms: 5, errors: [], project: 'proj', at: later + 1000 + i, pad: 'x'.repeat(120) }) + '\n';
  for (let i = 0; i < 12000; i++) big += row(i);
  fs.appendFileSync(log, big);
  const sizeBefore = fs.statSync(log).size;
  const r2 = T.ingest(null);
  const sizeAfter = fs.statSync(log).size;
  H.ok('日志超过 2 MB：读完之后丢掉前一半', sizeBefore > 2 * 1024 * 1024 && sizeAfter < sizeBefore * 0.6 && sizeAfter > sizeBefore * 0.4 && r2.usage > 1000, [sizeBefore, sizeAfter, r2.usage]);
  H.ok('丢完之后没有新的行：什么都不做', T.ingest(null).usage === 0);
  const pingBefore = nOf('ping');
  fs.appendFileSync(log, row(99999));
  H.ok('再来一行：只数这一行', T.ingest(null).usage === 1 && nOf('ping') === pingBefore + 1, [nOf('ping'), pingBefore]);
}

H.done('自动归并审查问题、工具用量（0930）');

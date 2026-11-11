'use strict';
/*
 * 2026-11-11 这批（docs/feedback-20261111.md）：问题表第 77—84 条和议题 #455、#456、#457。
 *   - 第 77 条、#456：代码审查只收这个 change 的文件（点了名的、做它的会话用编辑工具改过的），别的会话的改动不进材料、不动指纹；
 *     上一轮记在别人文件上的问题重审时不带了；一个都认不出时照旧全收；--all 不筛
 *   - #455：提交被"审查还没收尾"拦时写清变更、审查点、条数、下一步；resolve 对处理完的点说清楚
 *   - #457："所有未push的合并成一个进行push"认得出；reset --soft 之后重新提交（内容没变）不被审查状态拦
 * 用法：node dev/test-feedback1111.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] || H.SRC;
const h = H.makeHome('feedback1111', FROM, { commitMode: 'auto' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
const I = require(path.join(h.kit, 'lib', 'intent.js'));

let seq = 0;
function project(files) {
  const proj = H.makeRepo(path.join(h.work, 'p' + (++seq)), Object.assign({ 'README.md': '# x\n', 'pom.xml': '<project/>\n', 'src/duty/A.java': 'class A {}\n', 'src/other/B.java': 'class B {}\n', '.gitignore': '.vibe/\n' }, files || {}));
  fs.mkdirSync(path.join(proj, 'openspec', 'changes'), { recursive: true });
  return proj;
}
/** 四份文档齐的 change；named 是任务里点名的文件（空串就一个都不点） */
function docs(proj, c, done, todo, named) {
  const d = path.join(proj, 'openspec', 'changes', c);
  const where = named === undefined ? '：src/duty/A.java' : named ? '：' + named : '';
  H.write(path.join(d, 'proposal.md'), '# 值班\n\n## Why\n\n要调整值班。\n');
  H.write(path.join(d, 'design.md'), '# 设计\n\n- 改值班的服务\n\n## 验收用例\n\n- AC-01 调整：人工\n');
  H.write(path.join(d, 'tasks.md'), '## 1. x\n\n' + Array.from({ length: done }, (_, i) => '- [x] 1.' + (i + 1) + ' 做完' + where + '\n').join('') + Array.from({ length: todo }, (_, i) => '- [ ] 1.' + (done + i + 1) + ' 没做' + where + '\n').join(''));
  H.write(path.join(d, 'specs', 'duty', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 调整值班\n\nThe system SHALL adjust duty.\n\n#### Scenario: 调整\n\n- **WHEN** 点调整\n- **THEN** 值班表更新\n');
  return d;
}
function session(proj) { const sid = 'k' + (++seq); return { session_id: sid, cwd: proj, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user('接着做')]) }; }
const hookOut = (name, j, tool, input) => H.hook(h, name, Object.assign({}, j, { tool_name: tool, tool_input: input, hook_event_name: 'PreToolUse' }));
const bash = (j, command) => H.reasonOf(hookOut('guard-commit', j, 'Bash', { command }));
/** 这个会话用编辑工具改成功了一个文件（落盘 + after-tool） */
function edited(j, file, text) {
  H.write(file, text);
  return H.hook(h, 'after-tool', Object.assign({}, j, { tool_name: 'Write', tool_input: { file_path: file, content: text }, tool_response: { filePath: file }, hook_event_name: 'PostToolUse', tool_use_id: 'toolu_' + (++seq) }));
}
const apply = (j, name, dir) => { S.setFlow(j, true, '测试', 'apply'); if (dir) S.flowTouch(j, dir); return A.grant(j, '开工 ' + name, '', {}); };
const planOf = (p) => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(p.pending[0].scope), 'plan.json'), 'utf8')); } catch (e) { return { currents: {}, excluded: [] }; } };
const labels = (p) => Object.keys(planOf(p).currents);
const prep = (proj, c, extra) => { try { return R.prepare(Object.assign({ cwd: proj, change: c, mode: 'code', point: 'change' }, extra || {})); } catch (e) { return { status: 'threw', reason: e.message }; } };
const answer = (issues) => JSON.stringify({ issues, need: [], summary: '看了' });

H.section('第 77 条、#456：代码审查只收这个 change 的文件');
let stuck = null;
{
  const proj = project(); const d = docs(proj, 'c1', 2, 0); const j = session(proj);
  apply(j, 'c1', d);
  edited(j, path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; }\n');
  edited(j, path.join(proj, 'src', 'duty', 'New.java'), 'class New {}\n');
  // 别的会话、别的变更在同一个仓库里留下的没提交改动：没经过这个会话的编辑工具
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; }\n');
  H.write(path.join(proj, 'docs', '业务说明', '别的模块.md'), '# 别的模块\n');
  const fp1 = P.fingerprint(d, 'change');
  const all = prep(proj, 'c1', { all: true });
  H.ok('--all：照旧按这个仓库的全部改动审', all.status === 'prepared' && labels(all).includes('src/other/B.java') && labels(all).includes('src/duty/A.java'), [all.status, all.reason, labels(all)]);
  // 这一轮（按全部改动审的）审出两条：一条在别人的文件上，一条在这个 change 的文件上
  const done = R.submit(all.id, all.lenses[0], answer([{ severity: 'P1', file: 'src/other/B.java', line: 1, problem: '别的模块里 y 没有初始化', evidence: '调用时是 0' }, { severity: 'P2', file: 'src/duty/A.java', line: 1, problem: '值班的 x 没有校验范围', evidence: '传负数会存进去' }]));
  H.ok('两条都入了账', done.ok && done.blocking === 2, done);
  H.ok('下一步里写着注释不写审查编号', /不写审查编号/.test(String(done.next)), done.next);
  const p = prep(proj, 'c1');
  const got = labels(p); const plan = planOf(p);
  H.ok('不带 --all 再审：这个 change 的文件在材料里', p.status !== 'threw' && fs.existsSync(path.join(proj, '.vibe', 'reviews', 'c1')), [p.status, p.reason]);
  const result = p.status === 'prepared' ? null : p;
  // 文件都没变：这一轮不用发请求，直接出结果
  H.ok('别人的文件不算这个 change 的：记在它上面的那条不带了', !!result && result.status === 'completed' && result.blocking === 1 && result.issues.every((x) => x.file !== 'src/other/B.java') && result.droppedOthers === 1, result || [p.status, got, plan.excluded]);
  H.ok('下一步里说出有几个文件没审、怎么认回来', !!result && /另有 2 个改过的文件不算这个 change 的，没审/.test(String(result.next)) && /--all/.test(String(result.next)), result && result.next);
  H.ok('结果里列出没算进来的文件和原因', !!result && (result.excluded || []).some((x) => x.others === 2 && /不是这个 change 改的/.test(x.reason) && x.files.includes('src/other/B.java')), result && result.excluded);
  H.ok('审查点记的也是 1 条', P.record(d, 'change').blocking === 1, P.record(d, 'change'));
  // 别人的文件再变：这个 change 的指纹不动
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; int z; }\n');
  H.ok('别人的文件变了，这个 change 的审查点指纹不变', P.fingerprint(d, 'change') === fp1, [fp1, P.fingerprint(d, 'change')]);
  edited(j, path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; int w; }\n');
  H.ok('这个 change 的文件变了，指纹跟着变', P.fingerprint(d, 'change') !== fp1);
  stuck = { proj, d, j };
}

H.section('第 79 条：自动模式审出问题没处理，收工时催处理、不催重审');
{
  const { d, j } = stuck;
  S.setSessionAuto(j, true, '测试');
  const said = [1, 2, 3, 4].map((n) => { H.write(path.join(stuck.proj, 'src', 'duty', 'A.java'), 'class A { int x; int w; int t' + n + '; }\n'); return P.stop(j, [d], false, 'turn-79').join('\n'); });
  H.ok('催的是处理上一轮的问题，写了条数、清单在哪、下一步的命令', /c1）上一轮审出的 1 条 P1、P2 还没处理，不用重新审/.test(said[0]) && /code-change\.json/.test(said[0]) && /review\.js run --change c1 --mode code --point change --decisions/.test(said[0]), said[0]);
  H.ok('模型不处理就接着催，同一个状态一共催 3 次（中间改了文件也不从头数）', !!said[1] && !!said[2] && !said[3], said.map((x) => x.length));
  let noted = [];
  try { noted = require(path.join(h.kit, 'lib', 'report.js')).stateOf(j).items || []; } catch (e) { noted = []; }
  H.ok('催够 3 次记进全自动报告', noted.some((x) => /c1 的审查点 change 有 1 条 P1、P2 没处理/.test(String(x.title))), noted);
  // 等复审的点：催复审
  S.updateState('review-points', (o) => { for (const k of Object.keys(o)) if (/\|change$/.test(k)) o[k].status = 'needs_review'; });
  const again = P.stop(j, [d], false, 'turn-79b').join('\n');
  H.ok('登记过、还没复审的：催复审', /意见登记过了、还没复审/.test(again) && !/--decisions/.test(again), again);
  S.updateState('review-points', (o) => { for (const k of Object.keys(o)) if (/\|change$/.test(k)) o[k].status = 'completed'; });
  S.setSessionAuto(j, false, '测试');
  const O = require(path.join(h.kit, 'lib', 'session-out.js'));
  H.ok('收工、用户开口的钩子预算比每次工具调用的长', typeof O.budgetFor === 'function' && O.budgetFor({ hook_event_name: 'Stop' }) === 40000 && O.budgetFor({ hook_event_name: 'UserPromptSubmit' }) === 30000 && O.budgetFor({ hook_event_name: 'PreToolUse' }) === 12000 && O.budgetFor({}) === 12000);
  const inst = H.read(path.join(FROM, 'install.js')) || '';
  H.ok('安装器登记收工钩子时写明等 120 秒', /verify-gate\.js'\), \{ timeout: 120 \}/.test(inst), '');
  H.ok('install.js 被 require 时什么都不做（只有直接运行才安装）', /if \(require\.main !== module\) return;/.test(inst), '');
}
{
  // 第一轮就不带 --all
  const proj = project(); const d = docs(proj, 'c1', 2, 0); const j = session(proj);
  apply(j, 'c1', d);
  edited(j, path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; }\n');
  edited(j, path.join(proj, 'src', 'duty', 'New.java'), 'class New {}\n');
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; }\n');
  H.write(path.join(proj, 'docs', '业务说明', '别的模块.md'), '# 别的模块\n');
  const p = prep(proj, 'c1'); const got = labels(p);
  H.ok('材料里有点了名的、编辑工具改过的和新建的', got.includes('src/duty/A.java') && got.includes('src/duty/New.java'), [p.status, p.reason, got]);
  H.ok('材料里没有别的会话改的文件', p.status === 'prepared' && !got.includes('src/other/B.java') && !got.some((f) => /别的模块/.test(f)), got);
  const scope = fs.readFileSync(p.pending[0].scope, 'utf8');
  H.ok('给审查者的要求里写着别的模块的问题不报', /别的模块、别的需求的问题不报/.test(scope), scope.slice(0, 600));
}
{
  // 任务里只写了文件名（没带路径）、会话也没记过：按文件名认
  const proj = project(); const d = docs(proj, 'c1', 2, 0, 'A.java 和 src/duty/'); const j = session(proj);
  apply(j, 'c1', d);
  H.write(path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; }\n');
  H.write(path.join(proj, 'src', 'duty', 'sub', 'C.java'), 'class C {}\n');
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; }\n');
  const got = labels(prep(proj, 'c1'));
  H.ok('任务里点名的目录下面的都算，别的目录不算', got.includes('src/duty/A.java') && got.includes('src/duty/sub/C.java') && !got.includes('src/other/B.java'), got);
}
{
  // 一个都没点名、也没记过：认不出范围，照旧全收
  const proj = project(); const d = docs(proj, 'c1', 2, 0, ''); const j = session(proj);
  apply(j, 'c1', d);
  H.write(path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; }\n');
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; }\n');
  const p = prep(proj, 'c1'); const got = labels(p);
  H.ok('认不出范围时照旧全收，不报"没有代码可审"', p.status === 'prepared' && got.includes('src/duty/A.java') && got.includes('src/other/B.java'), [p.status, p.reason, got]);
}
{
  // 改过的都不算这个 change 的：说清楚，不报成"没有代码改动"
  const proj = project(); const d = docs(proj, 'c1', 2, 0); const j = session(proj);
  apply(j, 'c1', d);
  H.write(path.join(proj, 'src', 'other', 'B.java'), 'class B { int y; }\n');
  const p = prep(proj, 'c1');
  H.ok('改过的都是别人的：报错里列出文件、给出 --all', p.status === 'failed' && /都不算这个 change 的/.test(p.reason) && /--all/.test(p.reason) && /B\.java/.test(p.reason), p);
}

H.section('#455：提交被审查拦下时说清是哪个变更、哪个审查点');
{
  const { proj, d, j } = stuck;
  H.git(proj, ['add', 'src/duty/A.java']);
  const r = bash(j, 'git commit -m "feat: 调整值班"');
  H.ok('拦下', /审查还没收尾/.test(r), r);
  H.ok('写了变更名、审查点、条数', /c1 的审查点 change（1 条 P1、P2 没处理）/.test(r), r);
  H.ok('写了下一步的命令和问题清单在哪', /review\.js run --change c1 --mode code --point change --decisions/.test(r) && /code-change\.json/.test(r), r);
  // 登记处理完了的点再去登记：说清楚不用再登记
  S.updateState('review-points', (o) => { for (const k of Object.keys(o)) if (/\|change$/.test(k)) o[k].status = 'resolved'; });
  let msg = '';
  const f = path.join(h.work, 'decisions.json'); H.write(f, JSON.stringify({ findings: [] }));
  try { R.resolve({ cwd: proj, change: 'c1', mode: 'code', point: 'change', decisions: f }); } catch (e) { msg = e.message; }
  H.ok('处理完的点再登记：说已经处理完了、不是这一个', /已经登记处理完了/.test(msg) && /c1/.test(msg), msg);
  S.updateState('review-points', (o) => { for (const k of Object.keys(o)) if (/\|change$/.test(k)) o[k].status = 'completed'; });
  H.git(proj, ['reset', '-q']);
  void d;
}

H.section('#457：把没推的提交合并成一条');
{
  H.ok('"所有未push的合并成一个进行push"算说了推送', I.explicit('所有未push的合并成一个进行push', 'push') === true);
  H.ok('也算合并推送', I.mergeIntent('所有未push的合并成一个进行push') === true);
  H.ok('"把没推的提交合并成一条再推送"照旧认', I.explicit('把没推的提交合并成一条再推送', 'push') === true);
  H.ok('"把这两个接口合并成一个推送接口"不算', I.explicit('把这两个接口合并成一个推送接口', 'push') === false);
  H.ok('"未push的先别合并"不算', I.explicit('未push的先别合并', 'push') === false);
  const { proj, j } = stuck;
  // 两笔没推的提交，reset --soft 退回去，暂存区里是合起来的内容
  H.write(path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; int w; int v; }\n');
  H.git(proj, ['add', 'src/duty/A.java']); H.git(proj, ['commit', '-q', '-m', 'feat: 一']);
  H.write(path.join(proj, 'src', 'duty', 'New.java'), 'class New { int n; }\n');
  H.git(proj, ['add', 'src/duty/New.java']); H.git(proj, ['commit', '-q', '-m', 'feat: 二']);
  H.git(proj, ['reset', '-q', '--soft', 'HEAD~2']);
  let r = bash(j, 'git commit -m "feat: 调整值班"');
  H.ok('reset --soft 之后重新提交、内容没变：不被审查状态拦', !r, r);
  r = bash(j, 'git commit -p -m "feat: 调整值班"');
  H.ok('带 -p（提交工作区里挑的内容）不算重新提交：照旧拦', /审查还没收尾/.test(r), r);
  r = bash(j, 'git commit --pathspec-from-file=list.txt -m "feat: 调整值班"');
  H.ok('带 --pathspec-from-file 不算重新提交：照旧拦', /审查还没收尾/.test(r), r);
  // 暂存区里多了新改动：不算重新提交
  H.write(path.join(proj, 'src', 'duty', 'A.java'), 'class A { int x; int w; int v; int more; }\n');
  H.git(proj, ['add', 'src/duty/A.java']);
  r = bash(j, 'git commit -m "feat: 调整值班"');
  H.ok('暂存区里有新改动：照旧拦', /审查还没收尾/.test(r), r);
  H.git(proj, ['reset', '-q', 'src/duty/A.java']);
  r = bash(j, 'git add src/duty/A.java && git commit -m "feat: 调整值班"');
  H.ok('同一条命令里先 git add 再提交：照旧拦', /审查还没收尾/.test(r), r);
}

H.section('第 78 条：不再提明文口令');
{
  const rule = H.read(path.join(FROM, 'claude', 'rules', '20-git-commit.md')) || '';
  H.ok('提交规范里没有"密码、key、token 不写进要提交的文件"', !/密码、key、token/.test(rule) && !/占位符/.test(rule), rule.slice(-300));
  const Sc = require(path.join(h.kit, 'lib', 'review-scope.js'));
  const lens = Sc.lensesFor('code', 1, { reviewLenses: 3, reviewSmallChars: 0 }, 0).map((l) => l.text).join('\n');
  H.ok('审查的安全角度不再写"把敏感信息写出去"，写明明文口令不报', !/敏感信息/.test(lens) && /明文口令、密钥、token 不算问题/.test(lens), lens);
  H.ok('注入、越权、路径穿越照旧审', /注入/.test(lens) && /路径穿越/.test(lens) && /越权/.test(lens), lens);
  const prompt = H.read(path.join(h.kit, 'review-prompt.md')) || '';
  H.ok('审查的规矩里写着明文口令不报', /明文口令、密钥、token 不算问题/.test(prompt), prompt.slice(0, 400));
}

H.section('第 82 条：写进代码的文字里不带套件专属的字眼');
{
  const proj = project(); const j = session(proj);
  const java = path.join(proj, 'src', 'duty', 'A.java');
  const edit = (file, a, b) => H.reasonOf(hookOut('pre-edit', j, 'Edit', { file_path: file, old_string: a, new_string: b }));
  let r = edit(java, 'class A {}', '// 修复审核 r3：空列表\nclass A {}');
  H.ok('注释里写"修复审核 r3"：拦下，说明原因、给出例子', /\[vibe-kit 注释\]/.test(r) && /审核 r3/.test(r) && /同事/.test(r) && /例：/.test(r), r);
  H.ok('这一条不带拦截编号', !/拦截编号/.test(r), r);
  r = edit(java, 'class A {}', '// 修复审核 r3：空列表\nclass A {}');
  H.ok('原样再写一次放行', !r, r);
  r = edit(java, 'class A {}', 'class A {} // 值班为空时直接返回（审查r2）');
  H.ok('"（审查r2）"：拦下', /\[vibe-kit 注释\]/.test(r), r);
  r = edit(java, 'class A {}', '// fix r1: 判空\nclass A {}');
  H.ok('"fix r1:"：拦下', /\[vibe-kit 注释\]/.test(r), r);
  r = edit(java, 'class A {}', '// 第 2 轮审查发现的问题\nclass A {}');
  H.ok('"第 2 轮审查"：拦下', /\[vibe-kit 注释\]/.test(r) && /第几轮审查/.test(r), r);
  r = edit(java, 'class A {}', '// vibe-kit 的检查要求\nclass A {}');
  H.ok('套件的名字：拦下', /\[vibe-kit 注释\]/.test(r), r);
  r = edit(java, 'class A {}', '// 列表为空时直接返回，不然会拼出 in ()\nclass A {}');
  H.ok('只写业务原因的注释放行', !r, r);
  r = edit(java, 'class A {}', '// 进入第二轮审核，审核人改成处长\nclass A {}');
  H.ok('审批业务里的"第二轮审核"不算', !r, r);
  r = H.reasonOf(H.hook(h, 'pre-edit', { cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: java, old_string: 'class A {}', new_string: '// 修复审核 r9：空列表\nclass A {}' } }));
  H.ok('没有会话号（原样再写放不了行）：不查', !/\[vibe-kit 注释\]/.test(r), r);
  const t0 = Date.now();
  r = edit(java, 'class A {}', '// review' + ' '.repeat(6000) + 'x\nclass A {}');
  H.ok('review 后面跟几千个空白：不卡（复审 R3）', Date.now() - t0 < 5000, Date.now() - t0);
  r = edit(java, 'class A {}', '// 解决 r2 和 r3 的冲突：以 r3 为准\nclass A { int r1; }');
  H.ok('变量名 r2、r3 不算', !r, r);
  r = edit(java, 'class A {}', '// preview r2: layout\n// prefix r1: name\nclass A {}');
  H.ok('英文词里带 review、fix 的（preview r2、prefix r1）不算', !r, r);
  r = edit(java, '// 复审 r5 留下的\nclass A {}', '// 复审 r5 留下的\nclass A { int x; }');
  H.ok('改之前这一处就有的不管', !r, r);
  r = H.reasonOf(hookOut('pre-edit', j, 'Write', { file_path: path.join(proj, 'src', 'duty', 'C.java'), content: '// 审核 r7 要求加的类\nclass C {}\n' }));
  H.ok('新建文件整份写入也查', /\[vibe-kit 注释\]/.test(r), r);
  r = edit(path.join(proj, 'README.md'), '# x', '# x\n\n审核 r3 的处理记录');
  H.ok('不是代码文件（README.md）不管', !/\[vibe-kit 注释\]/.test(r), r);
}

H.section('第 80 条：死机、断电之后');
{
  const St = require(path.join(h.kit, 'lib', 'state-store.js'));
  // 拿旧版跑时没有这几个函数：照旧算开机时间，断言不过，不让脚本崩
  const boot = St.bootTime ? St.bootTime() : Date.now() - require('os').uptime() * 1000;
  H.ok('算得出这次开机的时间', boot > 0 && boot < Date.now(), boot);
  // 要紧的状态：写两次，本体变成一片 0（断电），读出来是上一份
  S.updateState('review-points', (o) => { o['x|change'] = { status: 'completed', blocking: 0, n: 1 }; });
  S.updateState('review-points', (o) => { o['x|change'].n = 2; });
  const file = path.join(h.kit, 'state', 'review-points.json');
  H.ok('写的时候留了上一份', fs.existsSync(file + '.prev'), '');
  fs.writeFileSync(file, Buffer.alloc(300));
  const got = St.read(file);
  H.ok('本体成了一片 0：读到的是上一份，不是空的', got['x|change'] && got['x|change'].n === 1, got);
  S.updateState('review-points', (o) => { if (o['x|change']) o['x|change'].n = 3; });
  H.ok('接着上一份记，没有从空的重新记', (St.read(file)['x|change'] || {}).n === 3, St.read(file));
  let prevOk = false; try { prevOk = !!JSON.parse(fs.readFileSync(file + '.prev', 'utf8'))['x|change']; } catch (e) { prevOk = false; }
  H.ok('坏的那份没有拿去盖掉上一份', prevOk, '');
  // 不要紧的状态照旧：坏了从空的记
  const plain = path.join(h.kit, 'state', 'tidy-hint.json');
  fs.writeFileSync(plain, Buffer.alloc(50));
  H.ok('升级前旧位置的会话流程文件（<会话号>-flow.json）也算要紧的', St.DURABLE && St.DURABLE.test('0f8fad5b-d9cb-469f-a165-70867728950e-flow.json') && St.DURABLE.test('flow.json') && !St.DURABLE.test('tidy-hint.json'), '');
  H.ok('别的状态文件不留上一份、不落盘', !fs.existsSync(plain + '.prev') && JSON.stringify(St.read(plain)) === '{}', '');
  // 锁：进程号还活着（这个测试自己），但记的时间比这次开机早
  const lockFile = path.join(h.root, 'old.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'x', at: boot - 300000 }));
  const lock = St.acquire(lockFile, { waitMs: 300 });
  H.ok('重启之前留下的锁：进程号被占着也马上拿得到', !!lock, '');
  if (lock) lock.release();
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'y', at: Date.now() }));
  const busy = St.acquire(lockFile, { waitMs: 200 });
  H.ok('这次开机之后的锁：进程还活着就照旧等', !busy, '');
  if (busy) busy.release();
  // 审查进程：重启之前起的，进程号被别的程序占着（这里用这个测试自己的进程号）
  const proj = project(); const d = docs(proj, 'c1', 2, 0);
  const key = R.jobKey(proj, 'c1', 'code', 'change');
  S.updateState('review-points', (o) => { o[S.normKey(d) + '|change'] = { status: 'running', rounds: 1, failStreak: 1, born: S.changeBorn(d), at: Date.now() }; });
  S.updateState('review-jobs', (o) => { o[key] = { id: 'job80', key, mode: 'code', change: 'c1', point: 'change', root: proj, status: 'running', started: boot - 400000, deadline: Date.now() + 3600000, expectMs: 300000, lenses: ['全量'], state: { '全量': { status: 'sent', sentAt: boot - 300000, pid: process.pid } }, dir: path.join(proj, '.vibe', 'reviews', 'c1', 'job-job80'), file: path.join(proj, '.vibe', 'reviews', 'c1', 'code-change.json') }; });
  H.ok('重启之前起的审查进程不算在跑', R.inFlight(d, 'code') === false, '');
  const j0 = { session_id: 'k80', cwd: proj, source: 'startup', hook_event_name: 'SessionStart' };
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const gl = path.join(proj, '.git', 'index.lock'); fs.writeFileSync(gl, '');
  fs.utimesSync(gl, new Date(boot - 300000), new Date(boot - 300000));
  const ctx = H.reasonOf(H.hook(h, 'session-start', j0));
  H.ok('会话开始：说出重启之前留下的 .git/index.lock 和怎么办', /index\.lock/.test(ctx) && /先删掉/.test(ctx), ctx.slice(0, 300));
  H.ok('会话开始：说出被打断的审查，再跑一次只补没交的', /被打断了/.test(ctx) && /c1 的 change/.test(ctx), ctx.slice(0, 300));
  R.sweep(proj);
  const st = (S.readState('review-jobs')[key] || {}).state || {};
  H.ok('被打断的角度记成没交，原因写电脑重启过', (st['全量'] || {}).status === 'failed' && /重启/.test((st['全量'] || {}).why), st);
  H.ok('不算一次没拿到结论（连续 3 次的数不加）', (P.record(d, 'change').failStreak || 0) === 1, P.record(d, 'change'));
  fs.unlinkSync(gl);
  const ctx2 = H.reasonOf(H.hook(h, 'session-start', Object.assign({}, j0, { session_id: 'k80b' })));
  H.ok('没有锁文件就不说', !/index\.lock/.test(ctx2), '');
  const U = require(path.join(h.kit, 'lib', 'updater.js'));
  fs.mkdirSync(path.join(h.kit, 'update'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'update', 'lock.json'), JSON.stringify({ pid: process.pid + 1, token: 'u', at: boot - 300000 }));
  H.ok('自动更新：重启之前的锁不算有人在装', U.lockHeld() === false, '');
}

H.section('第 81、84 条：多 change 做到后面回改前面的，当前 change 只往后走');
{
  const B = require(path.join(h.kit, 'lib', 'big-task.js'));
  const TASK = '值班';
  const bigProject = (legacy) => {
    const proj = project();
    const names = ['c1', 'c2', 'c3'];
    H.write(path.join(proj, 'openspec', 'plan.md'), '# 计划\n\n## ' + TASK + '\n\n' + (legacy ? '' : '探索记录：explore/' + TASK + '.md\n\n') + '| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n' + names.map((c) => '| | ' + c + ' | | |\n').join(''));
    if (!legacy) H.write(path.join(proj, 'openspec', 'explore', TASK + '.md'), '# 探索\n\n## 定了的\n\n调整值班\n\n## 还没定的\n\n无\n\n## 范围\n\n只做值班\n\n' + names.map((c) => '## change: ' + c + '\n\n目标\n\n').join('') + '## 落地偏差\n\n');
    const d1 = docs(proj, 'c1', 2, 0); const d2 = docs(proj, 'c2', 2, 0); const d3 = docs(proj, 'c3', 1, 1);
    return { proj, d1, d2, d3, task: () => B.tasks(proj).find((x) => x.name === TASK) };
  };
  const addTask = (d) => { const f = path.join(d, 'tasks.md'); H.write(f, H.read(f) + '- [ ] 1.9 回改：src/duty/A.java\n'); };
  const p = bigProject(false);
  H.ok('c1、c2 做完，c3 做到 1/2：当前是 c3', B.phaseOf(p.task()).change === 'c3', B.phaseOf(p.task()));
  const fin = () => (B.finishedMap ? B.finishedMap(p.task()) : {});
  H.ok('做完过的记下来了', !!fin().c1 && !!fin().c2, fin());
  // c2 审过了
  const fp2 = P.fingerprint(p.d2, 'change');
  S.updateState('review-points', (o) => { o[S.normKey(p.d2) + '|change'] = { status: 'completed', blocking: 0, issues: 0, rounds: 1, fingerprint: fp2, born: S.changeBorn(p.d2), at: Date.now() }; });
  H.ok('c2 审过', P.settled(p.d2, 'change'), P.record(p.d2, 'change'));
  addTask(p.d2);
  H.ok('做 c3 时给 c2 补了一项任务：当前还是 c3', B.phaseOf(p.task()).change === 'c3', B.phaseOf(p.task()));
  const rv = B.revisits ? B.revisits(p.task(), 'c3') : [];
  H.ok('c2 算回改', rv.map((x) => x.name).join() === 'c2', rv);
  {
    // c1、c2 做完，c3 文档写好、一项没勾：会话改的文件同时记到 c2（c2 的审查、修复正在这一段）
    const q2 = bigProject(false); const f3b = path.join(q2.d3, 'tasks.md'); H.write(f3b, H.read(f3b).replace(/- \[x\]/g, '- [ ]'));
    B.phaseOf(q2.task());
    const jq = session(q2.proj); S.setFlow(jq, true, '测试', 'apply'); A.grant(jq, '开工 c3', '', {});
    edited(jq, path.join(q2.proj, 'src', 'duty', 'Fix.java'), 'class Fix {}\n');
    const cf = S.readState('change-files');
    const has = (d) => ((cf[S.normKey(d)] || {}).files || []).some((x) => /fix\.java$/i.test(x));
    H.ok('c3 一项没勾：改的文件记到 c3，也记到前面开过工的 c2（复审 R1）', has(q2.d3) && has(q2.d2), cf);
  }
  const j = session(p.proj);
  S.setFlow(j, true, '测试', 'apply'); S.flowTouch(j, p.d3); A.grant(j, '开工 c3', '', {});
  const b = B.bar(j) || {};
  H.ok('状态栏第二行前面是大任务的名字，中间是 c3', /^值班：探索/.test(b.steps) && /c3/.test(b.steps) && !/c2/.test(b.steps), b);
  H.ok('状态栏第三行写回改 c2 还有 1 项', /回改 c2 还有 1 项/.test(b.next), b);
  let r = H.reasonOf(hookOut('pre-edit', j, 'Edit', { file_path: path.join(p.d3, 'tasks.md'), old_string: '- [ ] 1.2 没做', new_string: '- [x] 1.2 没做' }));
  H.ok('c2 有回改没做完：c3 的任务照样能勾，不按表的顺序拦', !/表的顺序/.test(r), r);
  r = H.reasonOf(hookOut('pre-edit', j, 'Edit', { file_path: path.join(p.d2, 'tasks.md'), old_string: '- [ ] 1.9 回改', new_string: '- [x] 1.9 回改' }));
  H.ok('c2 回改的任务也能勾', !/表的顺序/.test(r) && !/不在当前 apply 许可/.test(r), r);
  // c2 回改做完：审过的结论不重开（任务文字、代码都变了）
  const f2 = path.join(p.d2, 'tasks.md'); H.write(f2, H.read(f2).replace('- [ ] 1.9 回改', '- [x] 1.9 回改'));
  H.write(path.join(p.proj, 'src', 'duty', 'A.java'), 'class A { int revisit; }\n');
  H.ok('c2 回改做完：审过的结论不重开', P.settled(p.d2, 'change'), [P.fingerprint(p.d2, 'change'), fp2]);
  // c3 做完，c2 又补了一项：后面都做完了，回头做 c2
  const f3 = path.join(p.d3, 'tasks.md'); H.write(f3, H.read(f3).replace(/- \[ \]/g, '- [x]'));
  addTask(p.d2);
  H.ok('后面的都做完了：回头做前面剩下的', B.phaseOf(p.task()).change === 'c2', B.phaseOf(p.task()));
  // 老任务（没有探索记录）照旧从头找
  const q = bigProject(true);
  B.phaseOf(q.task()); addTask(q.d2);
  H.ok('老任务照旧按表的顺序：c2 补了任务就排回前面', B.phaseOf(q.task()).change === 'c2', B.phaseOf(q.task()));
}

H.section('第 83 条：定原因要的数据跟着问题反馈上报');
{
  const Iv = require(path.join(h.kit, 'lib', 'invocation.js'));
  const W = require(path.join(h.kit, 'lib', 'workspace.js'));
  const proj = project();
  let err = null; const started = Date.now();
  try {
    Iv.run(() => {
      Iv.phase('命令：读开关');
      W.git(proj, ['status', '--porcelain']);
      if (Iv.note) Iv.note('Git diff（慢仓库）', 6800);
      const until = started + 2600; while (Date.now() < until) { /* 等预算用完 */ }
      Iv.phase('命令：串着 cd');
    }, { budgetMs: 2500 });
  } catch (e) { err = e; }
  H.ok('预算用完的错误上带着这一次的用时', !!err && err.code === 'VIBE_HOOK_BUDGET' && /各阶段：开始/.test(err.timeline) && /命令：读开关/.test(err.timeline), err && err.timeline);
  H.ok('列出最慢的命令和各用了多久', !!err && /最慢的命令：Git diff（慢仓库） 6\.8 秒/.test(err.timeline) && /Git status（p\d+）/.test(err.timeline), err && err.timeline);
  const Fb = require(path.join(h.kit, 'lib', 'feedback.js'));
  Fb.recordHookError('verify-gate', { session_id: 'k83', cwd: proj, hook_event_name: 'Stop' }, err);
  const rec = Fb.listRecords().find((x) => /verify-gate 出错：本机检查超时/.test(x.text));
  H.ok('问题反馈里带上这一次的用时、最慢的命令、电脑配置', !!rec && /用时（自动带上的）/.test(rec.text) && /最慢的命令/.test(rec.text) && /核，内存/.test(rec.text), rec && rec.text.slice(0, 900));
  Fb.recordHookError('verify-gate', { session_id: 'k83', cwd: proj, hook_event_name: 'Stop' }, err);
  const again = Fb.listRecords().find((x) => /verify-gate 出错：本机检查超时/.test(x.text));
  H.ok('又出现的那一行也带用时', !!again && /## 又出现了[\s\S]*各阶段：/.test(again.text), again && again.text.slice(-600));
  // 审查：一个角度到 20 分钟上限被结束、没交
  const key = 'k83-review';
  S.updateState('review-jobs', (o) => { o[key] = { id: 'job83', key, mode: 'proposal', change: '', point: '', root: proj, status: 'running', started: Date.now() - 1000, deadline: Date.now() + 3600000, expectMs: 300000, files: 23, chars: 289000, lenses: ['事实和范围'], state: { '事实和范围': { status: 'sent', sentAt: Date.now() - 1250000, pid: 0, calls: [{ ms: 1200000, killed: true, apiMs: 0, turns: 0, out: 0, chars: 289000, err: '' }] } } }; });
  R.failLens('job83', '事实和范围', '审查进程没了，没交结论');
  const rv = Fb.listRecords().find((x) => /审查有 1 个角度没交结论/.test(x.text));
  H.ok('审查没交的问题反馈里带每次请求：用时、到上限被结束、提示多少字', !!rv && /每次请求（自动带上的）/.test(rv.text) && /第 1 次 1200 秒（到 20 分钟上限被结束）/.test(rv.text) && /提示 289 千字/.test(rv.text), rv && rv.text.slice(0, 900));
}

H.done('2026-11-11 这批：第 77—84 条和 #455、#456、#457');

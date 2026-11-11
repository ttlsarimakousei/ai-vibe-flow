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
  const said = [1, 2, 3, 4].map(() => P.stop(j, [d], false, 'turn-79').join('\n'));
  H.ok('催的是处理上一轮的问题，写了条数、清单在哪、下一步的命令', /c1）上一轮审出的 1 条 P1、P2 还没处理，不用重新审/.test(said[0]) && /code-change\.json/.test(said[0]) && /review\.js run --change c1 --mode code --point change --decisions/.test(said[0]), said[0]);
  H.ok('模型不动就接着催，同一个状态一共催 3 次', !!said[1] && !!said[2] && !said[3], said.map((x) => x.length));
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
  r = edit(java, 'class A {}', '// 解决 r2 和 r3 的冲突：以 r3 为准\nclass A { int r1; }');
  H.ok('变量名 r2、r3 不算', !r, r);
  r = edit(java, '// 复审 r5 留下的\nclass A {}', '// 复审 r5 留下的\nclass A { int x; }');
  H.ok('改之前这一处就有的不管', !r, r);
  r = H.reasonOf(hookOut('pre-edit', j, 'Write', { file_path: path.join(proj, 'src', 'duty', 'C.java'), content: '// 审核 r7 要求加的类\nclass C {}\n' }));
  H.ok('新建文件整份写入也查', /\[vibe-kit 注释\]/.test(r), r);
  r = edit(path.join(proj, 'README.md'), '# x', '# x\n\n审核 r3 的处理记录');
  H.ok('不是代码文件（README.md）不管', !/\[vibe-kit 注释\]/.test(r), r);
}

H.done('2026-11-11 这批：第 77—84 条和 #455、#456、#457');

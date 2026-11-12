'use strict';
/*
 * K3 M07（2026-11-01，docs/feedback-20261101.md）：检查点和一键回退。
 *   存：refs/vibe/ckpt/<会话>/<序号>，不动暂存区、分支、工作区；这个会话改过的被忽略的文件也存
 *   回退：只还原这个会话改过的文件（会话记录里的 Edit、Write），别的文件不碰；回退前先自动再存一个，回退也能撤销；拿不准的不动
 *   壳子里几个仓库：各存一份，序号相同
 *   自动模式开工、开新一组任务之前，钩子送一句"先存检查点"（不进全局约定）；人工模式不送
 * 用法：node dev/test-checkpoint.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;

function setup(name) {
  const h = H.makeHome(name, FROM);
  const repo = H.makeRepo(path.join(h.work, 'proj'), { 'a.js': 'a0\n', 'b.js': 'b0\n', '.gitignore': '.env\nlocal.yml\n.vibe/\n' });
  const sid = 'sess-' + name + '-0001';
  const transcript = path.join(h.cfg, 'projects', 'C--work-proj', sid + '.jsonl');
  return { h, repo, sid, transcript, entries: [H.tr.user('改导出')] };
}
/** 会话里用 Edit、Write 改一个文件（真改，并记进会话记录） */
function edit(t, rel, text, tool) {
  const f = path.isAbsolute(rel) ? rel : path.join(t.repo, rel);
  H.write(f, text);
  t.entries.push(...H.tr.ran(tool || 'Edit', Object.assign({ file_path: f }, tool === 'Write' ? { content: text } : { old_string: 'x', new_string: text }), 'ok'));
  H.transcript(t.transcript, t.entries);
}
const ck = (t, args, cwd) => H.node(t.h, path.join(t.h.kit, 'tools', 'checkpoint.js'), args, { cwd: cwd || t.repo, env: { CLAUDE_CODE_SESSION_ID: t.sid } });
const read = (t, rel) => H.read(path.join(t.repo, rel));
const snap = (t) => ({ status: H.git(t.repo, ['status', '--porcelain']).out, cached: H.git(t.repo, ['diff', '--cached']).out, head: H.git(t.repo, ['rev-parse', 'HEAD']).out, branch: H.git(t.repo, ['symbolic-ref', 'HEAD']).out });

(async () => {
  H.section('存检查点：不动暂存区、分支、工作区');
  const t = setup('tck');
  // 用户自己原来就有的：b.js 改了、暂存了；u.txt 是没跟踪的新文件
  H.write(path.join(t.repo, 'b.js'), 'b 用户暂存的\n');
  H.git(t.repo, ['add', 'b.js']);
  H.write(path.join(t.repo, 'u.txt'), '用户的笔记\n');
  edit(t, 'a.js', 'a1\n');
  edit(t, 'n.js', 'n1\n', 'Write');
  edit(t, '.env', 'X=1\n');
  const before = snap(t);
  const s = ck(t, ['save', '--why', '改导出前']);
  H.ok('存好了第 1 个', s.code === 0 && /已存第 1 个检查点/.test(s.out), [s.out, s.err]);
  H.ok('挂在 refs/vibe/ckpt/<会话>/1 上', H.git(t.repo, ['rev-parse', '--verify', '-q', 'refs/vibe/ckpt/' + t.sid + '/1']).code === 0);
  const after = snap(t);
  H.ok('暂存区、分支、HEAD、工作区的状态都没变', JSON.stringify(before) === JSON.stringify(after), [before, after]);
  const tree = H.git(t.repo, ['ls-tree', '-r', '--name-only', 'refs/vibe/ckpt/' + t.sid + '/1']).out;
  H.ok('检查点里有 a.js、n.js、用户的 u.txt，和这个会话改过的被忽略的 .env', ['a.js', 'n.js', 'u.txt', '.env'].every((f) => new RegExp('^' + f.replace('.', '\\.') + '$', 'm').test(tree)), tree);
  const l = ck(t, ['list']);
  H.ok('list 列出来', l.code === 0 && /\b1\s+\d\d-\d\d \d\d:\d\d\s+改导出前/.test(l.out), l.out);

  H.section('回退：只还原这个会话改过的文件，别的不碰；回退前先存一个，回退也能撤销');
  edit(t, 'a.js', 'a2 改坏了\n');
  edit(t, 'n2.js', '检查点之后才建的\n', 'Write');
  edit(t, '.env', 'X=2\n');
  edit(t, 'local.yml', 'port: 1\n', 'Write');   // 被忽略、检查点之后才第一次改：拿不准那时的样子
  H.write(path.join(t.repo, 'b.js'), 'b 用户后来又改的\n');   // 不是这个会话改的
  H.write(path.join(t.repo, 'u.txt'), '用户的笔记 改过\n');
  const cachedBefore = H.git(t.repo, ['diff', '--cached']).out;
  const r = ck(t, ['restore', '1']);
  H.ok('回退成功，回退前存成了第 2 个', r.code === 0 && /回退之前的样子存成了第 2 个/.test(r.out), [r.out, r.err]);
  H.ok('a.js 回到检查点时的样子', read(t, 'a.js') === 'a1\n', read(t, 'a.js'));
  H.ok('检查点之后才建的 n2.js 删掉了', !fs.existsSync(path.join(t.repo, 'n2.js')) && /删掉了（检查点之后才建的）：n2\.js/.test(r.out), r.out);
  H.ok('被忽略的 .env 也回到那时的样子（存的时候这个会话改过它）', read(t, '.env') === 'X=1\n', read(t, '.env'));
  H.ok('被忽略、检查点之后才改的 local.yml：不动，说清楚', read(t, 'local.yml') === 'port: 1\n' && /local\.yml（被 \.gitignore 忽略/.test(r.out), r.out);
  H.ok('不是这个会话改的 b.js、u.txt 不碰', read(t, 'b.js') === 'b 用户后来又改的\n' && read(t, 'u.txt') === '用户的笔记 改过\n');
  H.ok('暂存区没动', H.git(t.repo, ['diff', '--cached']).out === cachedBefore);
  const u = ck(t, ['restore', '2']);
  H.ok('撤销回退：a.js、n2.js、.env 回到回退之前', u.code === 0 && read(t, 'a.js') === 'a2 改坏了\n' && read(t, 'n2.js') === '检查点之后才建的\n' && read(t, '.env') === 'X=2\n', [u.out, read(t, 'a.js')]);
  const o = ck(t, ['restore', '1', '--only', 'a.js']);
  H.ok('--only 只还原点名的', o.code === 0 && read(t, 'a.js') === 'a1\n' && read(t, 'n2.js') === '检查点之后才建的\n', o.out);
  const bad = ck(t, ['restore', '99']);
  H.ok('没有的序号：说清楚，什么都不动', bad.code !== 0 && /没有第 99 个检查点/.test(bad.out), bad.out);

  H.section('壳子里的子项目：各存一份，序号相同');
  {
    const t2 = setup('tck-shell');
    const shell = H.makeRepo(path.join(t2.h.work, 'shell'), { 'workspace.yaml': 'projects: [svc]\n' });
    const svc = H.makeRepo(path.join(shell, 'svc'), { 'S.java': 'class S {}\n' });
    t2.repo = shell;
    edit(t2, path.join(svc, 'S.java'), 'class S { int x; }\n');
    const s2 = ck(t2, ['save', '--why', '壳子'], shell);
    H.ok('两个仓库都存了第 1 个', s2.code === 0 && H.git(shell, ['rev-parse', '--verify', '-q', 'refs/vibe/ckpt/' + t2.sid + '/1']).code === 0 && H.git(svc, ['rev-parse', '--verify', '-q', 'refs/vibe/ckpt/' + t2.sid + '/1']).code === 0, s2.out);
    H.write(path.join(svc, 'S.java'), 'class S { 改坏了 }\n');
    const r2 = ck(t2, ['restore', '1'], shell);
    H.ok('在壳子里回退，子项目里这个会话改过的文件也回去了', r2.code === 0 && H.read(path.join(svc, 'S.java')) === 'class S { int x; }\n', r2.out);
  }

  H.section('Windows：Edit 记的大小写和 git 记的不一样，回退不能把文件删了（复审发现）');
  if (process.platform === 'win32') {
    const c = setup('tck-case');
    edit(c, 'a.js', 'a1\n');
    H.ok('（存了检查点）', ck(c, ['save']).code === 0);
    edit(c, 'A.JS', 'a2\n');
    const r = ck(c, ['restore', '1']);
    H.ok('还原成检查点里的内容，没有删', r.code === 0 && read(c, 'a.js') === 'a1\n' && fs.existsSync(path.join(c.repo, 'a.js')), [r.out, r.err, read(c, 'a.js')]);
    const made = setup('tck-case2');
    edit(made, 'a.js', 'a1\n');
    ck(made, ['save']);
    edit(made, 'NEW.js', 'n\n');
    ck(made, ['restore', '1']);
    H.ok('检查点之后才建的照旧删掉', !fs.existsSync(path.join(made.repo, 'NEW.js')));
  }

  H.section('自动模式开工、开新一组任务之前：钩子送一句"先存检查点"；人工模式不送');
  {
    const h = H.makeHome('tck-hint', FROM);
    const proj = H.makeRepo(path.join(h.work, 'flow'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
    const chg = path.join(proj, 'openspec', 'changes', 'add-export');
    H.write(path.join(chg, 'proposal.md'), '# add-export\n');
    H.write(path.join(chg, 'design.md'), '## Context\n\n- 读过 src/A.java\n');
    H.write(path.join(chg, 'specs', 'x', 'spec.md'), '## ADDED Requirements\n');
    H.write(path.join(chg, 'tasks.md'), '- [ ] 1.1 改 src/A.java\n- [ ] 2.1 改 src/A.java\n');
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify({ [S.normKey(chg)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(chg), issues: 0 } }));
    const tfile = path.join(h.root, 't.jsonl');
    const prompt = (sid, text) => H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: H.transcript(tfile, [H.tr.user(text)]), prompt: text });
    const stop = (sid) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, [H.tr.user('/opsx:apply add-export'), H.tr.ran('Read', { file_path: path.join(chg, 'tasks.md') }, 'x'), H.tr.say('读完了')]), stop_hook_active: false, last_assistant_message: '读完了' });
    const ctxOf = (o) => String((o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || (typeof o === 'string' ? o : (o && o.raw) || ''));
    // 人工模式开工：不送
    const m = prompt('s-manual', '/opsx:apply add-export');
    H.ok('人工模式开工：不提检查点', !/检查点/.test(ctxOf(m) + JSON.stringify(m || '')), m);
    // 这个会话开了自动（提问框选了自动实施），开工
    fs.writeFileSync(path.join(h.kit, 'state', 's-auto-auto-switch.json'), JSON.stringify({ on: true, at: Date.now(), by: '提问框选了自动' }));
    const a = prompt('s-auto', '/opsx:apply add-export');
    H.ok('自动模式开工：送一句先存检查点', /大改之前先存一个检查点：node "[^"]*checkpoint\.js" save --why/.test(ctxOf(a)), a);
    // 第 1 组做完、审过：下一组开改之前再送一次
    H.write(path.join(chg, 'tasks.md'), '- [x] 1.1 改 src/A.java\n- [ ] 2.1 改 src/A.java\n');
    H.reviewPoints(h, chg);
    const g = stop('s-auto');
    H.ok('自动模式开新一组（2.1）：再送一句先存检查点', /继续当前范围的下一项 2\.1[\s\S]*大改之前先存一个检查点/.test(H.reasonOf(g)), H.reasonOf(g));
  }

  H.done('检查点和一键回退');
})().catch((e) => { H.ok('测试脚本出错', false, e.stack); H.done('检查点和一键回退'); });

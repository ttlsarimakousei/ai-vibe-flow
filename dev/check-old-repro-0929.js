'use strict';
/*
 * 确认 0929 那批问题反馈"修之前确实有这个毛病"：拿上一版（20260928.2055）跑同样的输入。
 * 用法：node dev/check-old-repro-0929.js <上一版的 vibe-kit 目录>
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const old = process.argv[2];
if (!old) { console.log('用法：node dev/check-old-repro-0929.js <上一版的 vibe-kit 目录>'); process.exit(2); }
const h = H.makeHome('oldrepro29', old, { reviewLoop: true, reviewMaxRounds: 3 });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const state = (name) => readJson(path.join(h.kit, 'state', name + '.json'));

const proj = H.makeRepo(path.join(h.work, 'src-swfg'), { 'pom.xml': '<project/>', 'src/main/java/A.java': 'class A {}\n', 'src/main/java/B.java': 'class B {}\n' });
const changes = path.join(proj, 'openspec', 'changes');
const mk = (name, tasks) => { const d = path.join(changes, name); H.write(path.join(d, 'proposal.md'), '# ' + name + '\n'); H.write(path.join(d, 'tasks.md'), tasks); return d; };
const tfile = path.join(h.root, 't.jsonl');
const base = (sid) => ({ session_id: sid, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse' });
const review = (id, mode, change, issues) => [H.tr.call('Agent', { subagent_type: 'vibe-reviewer', prompt: '模式：' + mode + '\n变更：openspec/changes/' + change + '/\n材料…' }, id), H.tr.result(id, '审完了。\n结论：问题 ' + issues + ' 条')];
const fix = (f) => H.tr.ran('Edit', { file_path: path.join(proj, f), old_string: 'a', new_string: 'b' }, 'ok');

H.section('F20260929-006 / -016：调用的 id 重复，第 3 轮复审记不上');
{
  const sec = mk('secflow-gate', '- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n');
  mk('login-gate', '- [x] 1.1 改 src/main/java/B.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/main/java/B.java；验：`mvn -q -o compile`\n');
  H.transcript(tfile, [H.tr.user('做完归档'),
    review('chatcmpl-tool-b9a8', '代码', 'secflow-gate', 4), fix('src/main/java/A.java'),
    review('chatcmpl-tool-b9a8', '代码', 'login-gate', 3), fix('src/main/java/B.java'),
    review('chatcmpl-tool-b823', '复审代码', 'secflow-gate', 2), fix('src/main/java/A.java'),
    review('chatcmpl-tool-b823', '复审代码', 'login-gate', 1), fix('src/main/java/B.java'),
    review('chatcmpl-tool-b9a8', '复审代码', 'secflow-gate', 0)]);
  const es = S.tailEntries(tfile, 8000000);
  const found = S.syncReviews(es, proj);
  S.syncReviewRounds(es, found);
  // 五次审查的结论本来是 4、3、2、1、0 条
  H.ok('旧版：审查的结论配错了人（毛病能复现）', found.map((x) => x.issues).join() !== '4,3,2,1,0', found.map((x) => x.issues));
  const a = state('review-rounds')['code|' + S.normKey(sec)];
  H.ok('旧版：secflow-gate 审了 3 轮，只记上 2 轮（毛病能复现）', a && a.rounds !== 3, a);
  const r = H.hook(h, 'guard-commit', Object.assign(base('s1'), { tool_name: 'Bash', tool_input: { command: 'git mv openspec/changes/secflow-gate openspec/changes/archive/2026-09-29-secflow-gate' } }));
  H.ok('旧版：审完了的变更归档被拦（毛病能复现）', r && r.decision === 'block' && /变更 secflow-gate 还不能归档/.test(H.reasonOf(r)), H.reasonOf(r));
}

H.section('F20260929-003：审过之后打了个勾，就说没审过');
{
  for (const n of ['review-rounds', 'reviewed']) { try { fs.unlinkSync(path.join(h.kit, 'state', n + '.json')); } catch (e) { /* 没有 */ } }
  H.setConfig(h, { reviewLoop: false });
  const chg = mk('gate2', '- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n- [ ] 6.1 执行 .vibe/pending/gate2_dml.sql；验：查库\n');
  H.transcript(tfile, [H.tr.user('审代码'), review('toolu_r1', '代码', 'gate2', 0)]);
  S.syncReviews(S.tailEntries(tfile, 8000000), proj);
  const tasks = path.join(chg, 'tasks.md');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('- [ ] 6.1', '- [x] 6.1'));
  H.ok('旧版：打了不改代码的任务的勾，审过的变成没审过（毛病能复现）', S.codeReviewed(chg) === false);
}

H.section('F20260928-010 / F20260929-015：验法跑过了，打勾还是被拦');
{
  const chg = mk('miping', ['- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`',
    '- [ ] 1.3 改密入口收口：src/main/java/A.java；验：javac 快检该 .java；/see-page 接口场景 POST `Oa_sys_user_extend/ChangePassWord.do` 返回 iserror=true', ''].join('\n'));
  const tasks = path.join(chg, 'tasks.md');
  fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify({ [S.normKey(chg)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(chg), issues: 0 } }));
  H.transcript(tfile, [H.tr.user('继续'), fix('src/main/java/A.java'),
    H.tr.ran('Bash', { command: '"/c/Program Files/Java/jdk1.8.0_201/bin/javac" -d out src/main/java/A.java' }, 'COMPILE_OK'),
    H.tr.ran('Bash', { command: 'node "$HOME/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/gate_oldpwdentry_reject.json' }, 'RESULT {"ok":true}'),
    H.tr.ran('Edit', { file_path: tasks, old_string: 'x', new_string: 'y' }, 'ok')]);
  const r = H.hook(h, 'pre-edit', Object.assign(base('s2'), { tool_name: 'Edit', tool_input: { file_path: tasks, old_string: '- [ ] 1.3', new_string: '- [x] 1.3' } }));
  H.ok('旧版：验证之后改过 tasks.md 就不认了（毛病能复现）', r && r.decision === 'block' && /上次改 tasks\.md 之后还没看到它成功跑过/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('旧版："场景 POST"里的 POST 被当成场景名（毛病能复现）', /场景 POST/.test(S.verifyPlan('javac 快检；/see-page 接口场景 POST `a/b.do` 返回 x').need), S.verifyPlan('javac 快检；/see-page 接口场景 POST `a/b.do` 返回 x').need);
  H.ok('旧版：.json 被认成 .js 脚本（毛病能复现）', /checklist_role_compare\.js(?!on)/.test(S.verifyPlan('javac 快检通过。本次不做对照场景 .vibe/scenarios/checklist_role_compare.json').need), S.verifyPlan('javac 快检通过。本次不做对照场景 .vibe/scenarios/checklist_role_compare.json').need);
}

H.section('F20260928-012：注释里提到套件的路径，git checkout 被拦');
{
  const r = H.hook(h, 'guard-commit', Object.assign(base('s3'), { tool_name: 'Bash', tool_input: { command: '# 先用 node "$HOME/.claude/vibe-kit/tools/trace.js" 溯源过了\ngit checkout -- src/main/java/A.java' } }));
  H.ok('旧版：被当成改套件拦下（毛病能复现）', r && r.decision === 'block' && /trace\.js/.test(H.reasonOf(r)), H.reasonOf(r));
}

H.section('F20260929-002 / -005：全自动模式下这一类放行要等用户');
{
  H.setConfig(h, { autoMode: true, kitBypass: 'ask' });
  const r = H.hook(h, 'guard-commit', Object.assign(base('s4'), { tool_name: 'Bash', tool_input: { command: 'openspec archive miping --yes' } }));
  const id = (H.reasonOf(r).match(/拦截编号 ([A-Z0-9]{4})/) || [])[1] || '';
  const b = H.node(h, path.join(h.kit, 'tools', 'feedback.js'), ['bypass', id, '--why', '这几项任务每项都有对应的提交，当轮验证都通过了，是打勾的时候被拦才没打上'], { cwd: proj });
  H.ok('旧版：不放行，要等用户回来（毛病能复现）', b.code !== 0 && /要等用户回来确认/.test(b.out), b.out + b.err);
}

H.section('F20260928-006 / -008 / -013：同一条理由拦了 3 次，自动记成一条问题');
{
  H.setConfig(h, { autoMode: false });
  const tasks = path.join(changes, 'miping', 'tasks.md');
  const n0 = fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /^F\d{8}/.test(n)).length;
  H.transcript(tfile, [H.tr.user('继续'), fix('src/main/java/A.java'), H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  for (let i = 0; i < 3; i++) H.hook(h, 'pre-edit', Object.assign(base('s5'), { tool_name: 'Edit', tool_input: { file_path: tasks, old_string: '- [ ] 1.3', new_string: '- [x] 1.3' } }));
  const recs = fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /^F\d{8}/.test(n));
  H.ok('旧版：多出一条"拦了 3 次"的记录（毛病能复现）', recs.length === n0 + 1 && recs.some((n) => /拦了 3 次|同一个会话里/.test(n) || /拦了 3 次/.test(fs.readFileSync(path.join(h.kit, 'feedback', n), 'utf8'))), recs);
}

H.done('旧版复现 0929');

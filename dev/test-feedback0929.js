'use strict';
/*
 * 内网导出的问题反馈（vibe-kit问题汇总-OFFIC-20200413X-20260929-1801.md），照着原样复现：
 *   F20260929-006 / -016 / -008   工具调用的 id 重复，审查轮次记到别的变更头上，归档一直被拦
 *   F20260928-014 / F20260929-003 审过代码，之后打了个勾、改了一句验法，就说"还没做过代码审查"
 *   F20260928-010 / -007          验法跑过了，打勾还是被拦（窗口从"上次改 tasks.md"算；"场景"后面的词被当成场景名）
 *   F20260929-015                 申请了放行，中间改过一次验法，再打勾又被拦；.json 被认成 .js
 *   F20260929-001                 收工检查说"这一轮改了 tasks.md 没记录"，其实几小时前改的、记过了
 *   F20260929-004                 命令没写变更名，归档门槛查的是另一个变更，提示里没说
 *   F20260928-012                 注释里提到套件的路径，git checkout 被当成改套件
 *   F20260929-002 / -005 / -009   全自动模式下放行要等用户，挂一整晚
 *   F20260929-010 / -011 / -013   全自动模式和"问用户"的说法打架；留给用户的任务卡住整条链
 *   F20260929-007、F20260928-006 / -008 / -013   不是问题的记录（配置页改开关、同一条理由拦了 3 次）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('fb0929');
const S = require(path.join(h.kit, 'lib', 'session.js'));
const F = require(path.join(h.kit, 'lib', 'feedback.js'));
const R = require(path.join(h.kit, 'lib', 'report.js'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const state = (name) => readJson(path.join(h.kit, 'state', name + '.json'));
const dropState = (name) => { try { fs.unlinkSync(path.join(h.kit, 'state', name + '.json')); } catch (e) { /* 没有 */ } };
const records = () => { try { return fs.readdirSync(path.join(h.kit, 'feedback')).filter((n) => /^F\d{8}-\d+/.test(n)); } catch (e) { return []; } };

const proj = H.makeRepo(path.join(h.work, 'src-swfg'), { 'pom.xml': '<project/>', 'src/main/java/A.java': 'class A {}\n', 'src/main/java/B.java': 'class B {}\n', 'deploy/readme.txt': 'x\n' });
const changes = path.join(proj, 'openspec', 'changes');
const mk = (name, tasks, extra) => {
  const d = path.join(changes, name);
  H.write(path.join(d, 'proposal.md'), '# ' + name + '\n');
  H.write(path.join(d, 'tasks.md'), tasks);
  for (const [rel, text] of Object.entries(extra || {})) H.write(path.join(d, rel), text);
  return d;
};
const tfile = path.join(h.root, 'transcript.jsonl');
const base = (sid) => ({ session_id: sid, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse' });
const review = (id, mode, change, issues) => [H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：' + mode + '\n变更：openspec/changes/' + change + '/\n材料…' }, id), H.tr.result(id, '审完了。\n结论：问题 ' + issues + ' 条')];
const entriesOf = () => S.tailEntries(tfile, 8000000).filter((e) => e && !e.isSidechain);

// ---------------------------------------------------------------------------------------------
H.section('工具调用的 id 重复：调用和结果按先后配对');
{
  const es = S.uniquifyToolIds([
    H.tr.call('Bash', { command: 'node a.js' }, 'chatcmpl-tool-aaaa'), H.tr.result('chatcmpl-tool-aaaa', 'A 的结果'),
    H.tr.call('Bash', { command: 'node b.js' }, 'chatcmpl-tool-aaaa'), H.tr.result('chatcmpl-tool-aaaa', 'B 的结果', true),
    H.tr.call('Bash', { command: 'node c.js' }, 'chatcmpl-tool-aaaa'),
    H.tr.call('Bash', { command: 'node d.js' }, 'chatcmpl-tool-aaaa'), H.tr.result('chatcmpl-tool-aaaa', 'D 的结果'),
  ]);
  const calls = S.toolCalls(es, 0);
  const res = S.toolResults(es);
  const of = (cmd) => res.get(calls.find((c) => c.input.command === cmd).id);
  H.ok('四次调用的 id 互不相同', new Set(calls.map((c) => c.id)).size === 4, calls.map((c) => c.id));
  H.ok('原来的 id 留着', calls.every((c) => c.raw === 'chatcmpl-tool-aaaa'), calls.map((c) => c.raw));
  H.ok('第一次调用拿到的是自己的结果', of('node a.js') && of('node a.js').text === 'A 的结果' && !of('node a.js').error, of('node a.js'));
  H.ok('第二次调用拿到的是自己的结果（报错的那个）', of('node b.js') && of('node b.js').text === 'B 的结果' && of('node b.js').error, of('node b.js'));
  H.ok('被打断、没有结果的调用不会认走后面的结果', of('node c.js') === undefined, of('node c.js'));
  H.ok('它后面那次调用拿到自己的结果', of('node d.js') && of('node d.js').text === 'D 的结果', of('node d.js'));
  H.ok('记账用的键互不相同', new Set(calls.map((c) => c.key)).size === 4, calls.map((c) => c.key));
  // 调用在会话记录更前面、没读进来：它的结果不会被后面同 id 的调用认走
  const es2 = S.uniquifyToolIds([H.tr.result('chatcmpl-tool-bbbb', '更早那次的结果'), H.tr.call('Bash', { command: 'node e.js' }, 'chatcmpl-tool-bbbb')]);
  H.ok('没头的结果不配给后面同 id 的调用', S.toolResults(es2).get(S.toolCalls(es2, 0)[0].id) === undefined);
  // id 不重复的照旧
  const es3 = S.uniquifyToolIds([H.tr.ran('Bash', { command: 'x' }, 'ok')].flat());
  H.ok('id 不重复的原样不动', /^toolu_\d+$/.test(S.toolCalls(es3, 0)[0].id) && S.toolResults(es3).has(S.toolCalls(es3, 0)[0].id));
}

// ---------------------------------------------------------------------------------------------
H.section('审查轮次：id 重复也不会记到别的变更头上（F20260929-006 / -016）');
{
  const sec = mk('secflow-gate', '- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n');
  const login = mk('login-gate-and-pwd-ui-fix', '- [x] 1.1 改 src/main/java/B.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/main/java/B.java；验：`mvn -q -o compile`\n');
  H.setConfig(h, { reviewLoop: true, reviewMaxRounds: 3 });
  const fix = (f) => H.tr.ran('Edit', { file_path: path.join(proj, f), old_string: 'a', new_string: 'b' }, 'ok');
  // 反馈里的样子：两个 id 在两个变更的审查里来回用
  H.transcript(tfile, [H.tr.user('做完归档'),
    review('chatcmpl-tool-b9a8989979ffa5ac', '代码', 'secflow-gate', 4), fix('src/main/java/A.java'),
    review('chatcmpl-tool-b9a8989979ffa5ac', '代码', 'login-gate-and-pwd-ui-fix', 3), fix('src/main/java/B.java'),
    review('chatcmpl-tool-b823d0d9ed6676b2', '复审代码', 'secflow-gate', 2), fix('src/main/java/A.java'),
    review('chatcmpl-tool-b823d0d9ed6676b2', '复审代码', 'login-gate-and-pwd-ui-fix', 1), fix('src/main/java/B.java'),
    review('chatcmpl-tool-b9a8989979ffa5ac', '复审代码', 'secflow-gate', 0)]);
  const es = entriesOf();
  const found = S.syncReviews(es, proj);
  H.ok('五次审查都认出来了', found.length === 5, found.map((r) => [r.change && r.change.name, r.issues]));
  H.ok('每次审查的结论是它自己的', found.map((r) => r.issues).join() === '4,3,2,1,0', found.map((r) => r.issues));
  S.syncReviewRounds(es, found);
  const rounds = state('review-rounds');
  const a = rounds['code|' + S.normKey(sec)];
  const b = rounds['code|' + S.normKey(login)];
  H.ok('secflow-gate：3 轮，最后 0 条，审完了', a && a.rounds === 3 && a.issues === 0 && a.done === true && !a.pendingFix, a);
  H.ok('login-gate：2 轮，最后 1 条，没审完', b && b.rounds === 2 && b.issues === 1 && !b.done, b);
  // 再读一遍（下一次收工）：不重复计
  S.syncReviewRounds(entriesOf(), S.syncReviews(entriesOf(), proj));
  const again = state('review-rounds');
  H.ok('再读一遍不重复计', again['code|' + S.normKey(sec)].rounds === 3 && again['code|' + S.normKey(login)].rounds === 2, again);
  // 归档只使用本次真人确认，不借审查结论授予许可。
  fs.appendFileSync(tfile, JSON.stringify(H.tr.user('自测通过，归档 secflow-gate')) + '\n');
  const r = H.hook(h, 'guard-commit', Object.assign(base('s-rounds'), { tool_name: 'Bash', tool_input: { command: 'git mv openspec/changes/secflow-gate openspec/changes/archive/2026-09-29-secflow-gate' } }));
  H.ok('secflow-gate 可以归档', r === null, H.reasonOf(r));
  const r2 = H.hook(h, 'guard-commit', Object.assign(base('s-rounds'), { tool_name: 'Bash', tool_input: { command: 'git mv openspec/changes/login-gate-and-pwd-ui-fix openspec/changes/archive/2026-09-29-login-gate-and-pwd-ui-fix' } }));
  H.ok('login-gate 没做完：拦，说的是它自己', r2 && r2.decision === 'block' && /变更 login-gate-and-pwd-ui-fix 还不能归档/.test(H.reasonOf(r2)) && /还有 1 项任务没打勾/.test(H.reasonOf(r2)), H.reasonOf(r2));

  // 老版本留下的状态（seen 里记的是调用的 id）：升级之后不重复计，之前漏掉的那一轮能补上
  dropState('review-rounds'); dropState('reviewed');
  const t = Date.parse(found[2].at ? new Date(found[2].at).toISOString() : '') || found[2].at;
  fs.writeFileSync(path.join(h.kit, 'state', 'review-rounds.json'), JSON.stringify({
    ['code|' + S.normKey(sec)]: { rounds: 2, seen: ['chatcmpl-tool-b9a8989979ffa5ac', 'chatcmpl-tool-b823d0d9ed6676b2'], done: false, issues: 2, pendingFix: true, at: t, born: S.changeBorn(sec), name: 'secflow-gate' },
  }));
  S.syncReviewRounds(entriesOf(), S.syncReviews(entriesOf(), proj));
  const up = state('review-rounds')['code|' + S.normKey(sec)];
  H.ok('老状态：计过的两轮不重复计，漏掉的第 3 轮补上了', up && up.rounds === 3 && up.issues === 0 && up.done === true, up);
  H.setConfig(h, { reviewLoop: false });
}

// ---------------------------------------------------------------------------------------------
H.section('审过代码之后打勾、改验法，审查照样算数（F20260928-014 / F20260929-003）');
{
  for (const n of ['review-rounds', 'reviewed', 'task-ticks']) dropState(n);
  const chg = mk('gate2', ['- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`',
    '- [ ] 6.1 开发库 admin 密级迁移：执行 .vibe/pending/gate2_dml.sql；验：查 SYS_USER 返回 admin', ''].join('\n'));
  H.write(path.join(proj, '.vibe', 'pending', 'gate2_dml.sql'), '-- dml\n');
  const tasks = path.join(chg, 'tasks.md');
  S.syncTicks(chg);
  H.transcript(tfile, [H.tr.user('审代码'), review('toolu_r1', '代码', 'gate2', 0)]);
  S.syncReviews(entriesOf(), proj);
  const rec = S.reviewRecord('code', chg);
  H.ok('审查记上了', rec && rec.done && rec.at > 0, rec);
  // 代码是审查之前写的
  const before = new Date(rec.at - 600000);
  fs.utimesSync(path.join(proj, 'src/main/java/A.java'), before, before);
  H.ok('刚审完：算审过', S.codeReviewed(chg) && S.codeReviewIssue(chg) === '');
  // 用户做完了 6.1，模型打勾；又改了一句验法。tasks.md 的修改时间比审查晚
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('- [ ] 6.1', '- [x] 6.1').replace('返回 admin', '返回 admin 一行'));
  H.ok('反馈原样：审查之后打了不改代码的任务的勾，照样算审过', S.codeReviewed(chg), S.codeReviewIssue(chg));
  // 1008 起归档还要用户说了才做：会话记录里用户最后一句说了归档
  H.transcript(tfile, [H.tr.user('审完了，归档 gate2')]);
  const r = H.hook(h, 'guard-commit', Object.assign(base('s-b1b'), { tool_name: 'Bash', tool_input: { command: 'mv openspec/changes/gate2 openspec/changes/archive/2026-09-29-gate2 && ls openspec/changes/' } }));
  H.ok('反馈原样：可以归档', r === null, H.reasonOf(r));
  // 审查之后才做的代码任务：代码没审到
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8') + '- [ ] 7.1 加导出：src/main/java/B.java；验：`mvn -q -o compile`\n');
  S.syncTicks(chg);
  fs.writeFileSync(path.join(proj, 'src/main/java/B.java'), 'class B { int x; }\n');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('- [ ] 7.1', '- [x] 7.1'));
  const issue = S.codeReviewIssue(chg);
  H.ok('审查之后又做了代码任务：说清是哪一项、哪个文件', /代码审查之后又做了 1 项任务/.test(issue) && /7\.1/.test(issue) && /B\.java/.test(issue), issue);
  H.ok('这时不算审过', !S.codeReviewed(chg));
  // 审查之前代码就写好了、只是勾打晚了（当时打勾被拦）：算审过
  const old = new Date(rec.at - 300000);
  fs.utimesSync(path.join(proj, 'src/main/java/B.java'), old, old);
  H.ok('代码是审查之前写的、勾打晚了：算审过', S.codeReviewed(chg), S.codeReviewIssue(chg));
  // 头一回见到的变更（老版本做到一半的）：不知道什么时候打的勾，当作早就打了
  dropState('task-ticks');
  fs.writeFileSync(path.join(proj, 'src/main/java/B.java'), 'class B { int y; }\n');
  H.ok('升级上来、做到一半的变更：审过的照认', S.codeReviewed(chg), S.codeReviewIssue(chg));
}

// ---------------------------------------------------------------------------------------------
H.section('验法要看到什么（F20260928-010、F20260929-015 的流水账）');
{
  const none = {};
  const has = (names) => ({ scenarioExists: (n) => names.includes(n) });
  const run = 'node "$HOME/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/usercheck_btn_removed.json --base http://127.0.0.1:8388';
  const v1 = '/see-page 场景 admin 打开用户管理页，readCount 断言 #btnUserCheck=0';
  H.ok('反馈原样："场景 admin"里的 admin 是账号：跑过别的场景文件就算', S.verifyRan(v1, [run], none), S.verifyPlan(v1, none).need);
  H.ok('真有 admin.json 这个场景：要跑的是它', !S.verifyRan(v1, [run], has(['admin'])) && S.verifyRan(v1, [run.replace('usercheck_btn_removed', 'admin')], has(['admin'])));
  const v2 = 'javac 快检该 .java；/see-page 接口场景 POST `Oa_sys_user_extend/ChangePassWord.do` 返回 iserror=true；db-crud 查 njqh_dc PASSWORD 改前后一致';
  H.ok('反馈原样："场景 POST"里的 POST 不是场景名', !/场景 POST/.test(S.verifyPlan(v2).need), S.verifyPlan(v2).need);
  H.ok('反馈原样：javac、场景、查库都跑过', S.verifyRan(v2, ['"/c/Program Files/Java/jdk1.8.0_201/bin/javac" -d out A.java', 'node x/scenario-run.js .vibe/scenarios/gate_oldpwdentry_reject.json', 'python "$HOME/.claude/skills/db-crud/scripts/db.py" query --sql "select 1"']));
  H.ok('接口场景用 .vibe 里自己的脚本验的也算', S.verifyRan(v2, ['python .vibe/tmp/0929-t13/pwdcheck.py']));
  H.ok('什么验证都没跑不算', !S.verifyRan(v2, ['git status', 'ls -la']));
  const v3 = '`node .vibe/scenarios/verify-gate.js`（用 `.vibe/login.json` 的登录态）';
  H.ok('反引号里的数据文件（.vibe/login.json）不是要跑的命令', S.verifyRan(v3, ['node .vibe/scenarios/verify-gate.js']) && !/login\.json/.test(S.verifyPlan(v3).need), S.verifyPlan(v3).need);
  const v4 = 'javac 快检 UserController.java 通过（已跑）。本次不做 aqsjy/aqbmy 对照场景 .vibe/scenarios/checklist_role_compare.json（需先执行 01c 脚本备号，改库要用户确认）';
  const p4 = S.verifyPlan(v4);
  H.ok('反馈原样：.json 不会被认成 .js 脚本', !/checklist_role_compare\.js(?!on)/.test(p4.need), p4.need);
  H.ok('反馈原样：写了"本次不做"的那一句不查，跑过 javac 就能打勾', p4.test(['"/c/Program Files/Java/jdk1.8.0_201/bin/javac" -J-Duser.language=en -d out UserController.java']), p4.need);
  H.ok('不做的那一句记了下来', p4.skipped.length === 1 && /checklist_role_compare/.test(p4.skipped[0]), p4.skipped);
  H.ok('没说不做的：场景文件要跑过', !S.verifyRan('javac 快检；对照场景 `checklist_role_compare.json`', ['javac A.java']) && S.verifyRan('javac 快检；对照场景 `checklist_role_compare.json`', ['javac A.java', 'node x/scenario-run.js .vibe/scenarios/checklist_role_compare.json']));
  H.ok('括号里说了不做也算', S.verifyPlan('`mvn -q -o compile`；对照场景 `x.json`（本次不做，要先改库）').skipped.length === 1 && S.verifyRan('`mvn -q -o compile`；对照场景 `x.json`（本次不做，要先改库）', ['mvn -q -o compile']));
  H.ok('能验的那一句照样要跑', !S.verifyRan('`mvn -q -o compile`；对照场景 `x.json`（本次不做，要先改库）', ['git status']));
  H.ok('整条验法都是"不做"：没有要查的，但记了下来', S.verifyRan('本次不做（环境起不来）', []) && S.verifyPlan('本次不做（环境起不来）').skipped.length === 1);
  H.ok('逗号后面的一句说明不连累前面的命令', S.verifyPlan('`mvn -q -o compile` 通过，不需要起服务').need.includes('mvn') && !S.verifyRan('`mvn -q -o compile` 通过，不需要起服务', ['git status']));
  H.ok('探针（playwright）算验过', S.verifyRan('/see-page 做不了（要应答文件选择框），用探针', ['node .vibe/tmp/miping/probe_pick2.js']));
}

// ---------------------------------------------------------------------------------------------
H.section('打勾：从"改完这项任务的代码之后"算（F20260928-010 ×5、F20260929-015）');
const sidTick = 's-tick';
const chg3 = mk('miping-acceptance-fix', ['- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`',
  '- [ ] 1.3 改密入口收口：src/main/java/A.java；验：javac 快检该 .java；/see-page 接口场景 POST `Oa_sys_user_extend/ChangePassWord.do` 返回 iserror=true',
  '- [ ] 2.1 增补撞库查询：src/main/java/B.java；验：/see-page 接口场景 admin 登录后 GET `Sys_user/ExportWeakPwdUsers.do` 返回 200',
  '- [ ] 3.2 审核接口角色：src/main/java/B.java；验：javac 快检；对照场景 `checklist_role_compare.json`', ''].join('\n'));
const tasks3 = path.join(chg3, 'tasks.md');
const edit = (file, from, to, sid) => H.hook(h, 'pre-edit', Object.assign(base(sid || sidTick), { tool_name: 'Edit', tool_input: { file_path: file, old_string: from, new_string: to } }));
const tickOf = (n, sid) => edit(tasks3, '- [ ] ' + n, '- [x] ' + n, sid);
fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify({ [S.normKey(chg3)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(chg3), issues: 0 } }));
const editA = H.tr.ran('Edit', { file_path: path.join(proj, 'src/main/java/A.java'), old_string: 'a', new_string: 'b' }, 'ok');
const editB = H.tr.ran('Edit', { file_path: path.join(proj, 'src/main/java/B.java'), old_string: 'a', new_string: 'b' }, 'ok');
const editTasks = H.tr.ran('Edit', { file_path: tasks3, old_string: 'x', new_string: 'y' }, 'ok');
const javac = H.tr.ran('Bash', { command: '"/c/Program Files/Java/jdk1.8.0_201/bin/javac" -d .vibe/tmp/out src/main/java/A.java' }, 'COMPILE_OK');
const scen = (name) => H.tr.ran('Bash', { command: 'node "$HOME/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/' + name + '.json --base http://127.0.0.1:8388' }, 'RESULT {"ok":true}');
{
  // 反馈原样：验法都跑过了，之后改过一次 tasks.md（提交前改了一句验法），再打勾
  H.transcript(tfile, [H.tr.user('继续，测试'), editA, javac, scen('gate_oldpwdentry_reject'), editTasks]);
  const r = tickOf('1.3');
  H.ok('反馈原样：验证之后改过 tasks.md，照样能打勾', r === null, H.reasonOf(r));
  H.ok('打勾的时间记上了', (state('task-ticks')[S.normKey(chg3)] || { tasks: {} }).tasks['id:1.3'] > 0, state('task-ticks'));
  // 连着打两项：验一次，打 1.3，再打 2.1
  H.transcript(tfile, [H.tr.user('继续，测试'), editA, editB, javac, scen('gate_oldpwdentry_reject'), scen('weakpwd_export'), H.tr.ran('Edit', { file_path: tasks3, old_string: '- [ ] 1.3', new_string: '- [x] 1.3' }, 'ok')]);
  const r2 = tickOf('2.1');
  H.ok('反馈原样：刚打完上一项的勾，接着打下一项', r2 === null, H.reasonOf(r2));
  // 验证之后又改了这项任务的代码：要重新验
  H.transcript(tfile, [H.tr.user('继续，测试'), javac, scen('weakpwd_export'), editB]);
  const r3 = tickOf('2.1');
  H.ok('验证之后又改了这项任务的代码：拦', r3 && r3.decision === 'block' && /改完 B\.java 之后还没看到它成功跑过/.test(H.reasonOf(r3)), H.reasonOf(r3));
  H.ok('提示里说了验不了的部分怎么写', /本次不做（原因）/.test(H.reasonOf(r3)), H.reasonOf(r3));
  // 改的是别的任务的文件：不影响这一项
  H.transcript(tfile, [H.tr.user('继续，测试'), editB, scen('weakpwd_export'), editA]);
  const r4 = tickOf('2.1');
  H.ok('之后改的是别的任务的文件：不影响', r4 === null, H.reasonOf(r4));
  // 命令失败不算
  H.transcript(tfile, [H.tr.user('继续，测试'), editB, H.tr.ran('Bash', { command: 'node x/scenario-run.js .vibe/scenarios/weakpwd_export.json' }, 'RESULT {"ok":false}', true)]);
  const r5 = tickOf('2.1');
  H.ok('验证命令失败了：拦', r5 && r5.decision === 'block', H.reasonOf(r5));
  // 什么都没跑
  H.transcript(tfile, [H.tr.user('继续，测试'), editB, H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  const r6 = tickOf('2.1');
  H.ok('什么验证都没跑：拦', r6 && r6.decision === 'block' && /拦截编号/.test(H.reasonOf(r6)), H.reasonOf(r6));
}

// ---------------------------------------------------------------------------------------------
H.section('放行：全自动模式不等用户，通行证按同一个文件认（F20260929-015、-002、-005、-009）');
const blockId = (r) => (H.reasonOf(r).match(/拦截编号 ([A-Z0-9]{4})/) || [])[1] || '';
const bypass = (id, why, extra, cwd) => H.node(h, path.join(h.kit, 'tools', 'feedback.js'), ['bypass', id, '--why', why].concat(extra || []), { cwd: cwd || proj });
const ranBypass = (id, out) => H.tr.ran('Bash', { command: 'node "$HOME/.claude/vibe-kit/tools/feedback.js" bypass ' + id + ' --why "…"' }, out);
{
  H.setConfig(h, { autoMode: true, kitBypass: 'ask' });
  const sid = 's-auto';
  // 全自动模式只在走 OpenSpec 流程的会话里算数：这个会话在流程里
  H.inFlow(h, sid);
  R.begin({ session_id: sid, cwd: proj });
  const n0 = records().length;
  H.transcript(tfile, [H.tr.user('全自动做完'), editB, javac]);
  const r = tickOf('3.2', sid);
  const id = blockId(r);
  H.ok('打勾被拦，带拦截编号', r && r.decision === 'block' && !!id, H.reasonOf(r));
  H.ok('全自动模式的提示：不要停下等，怎么申请放行写在提示里', /全自动模式/.test(H.reasonOf(r)) && /不要停下等我/.test(H.reasonOf(r)) && new RegExp('feedback\\.js" bypass ' + id).test(H.reasonOf(r)), H.reasonOf(r));
  const why = '对照场景要先执行 01c 脚本备号，改库不可逆要用户确认；javac 快检 UserController.java 已通过';
  const b = bypass(id, why);
  H.ok('反馈原样：全自动模式下这一类也直接放行，不等用户', b.code === 0 && /放行申请登记好了/.test(b.out) && /会直接放行/.test(b.out), b.out + b.err);
  H.ok('条件满足不了先过的，不记成套件的问题', records().length === n0, records());
  // 反馈原样：申请之后先改了一次验法（内容变了），再打勾
  H.transcript(tfile, [H.tr.user('全自动做完'), editB, javac, ranBypass(id, b.out), H.tr.ran('Edit', { file_path: tasks3, old_string: '对照场景', new_string: '角色对照场景' }, 'ok')]);
  fs.writeFileSync(tasks3, fs.readFileSync(tasks3, 'utf8').replace('对照场景 `checklist', '角色对照场景 `checklist'));
  const r2 = tickOf('3.2', sid);
  H.ok('反馈原样：中间改过验法，再打勾照样放行', r2 === null, H.reasonOf(r2));
  const st = R.stateOf({ session_id: sid });
  H.ok('放行记进了全自动报告', st.items.some((x) => x.kind === 'bypass' && /tasks\.md/.test(x.title) && /01c/.test(x.detail)), st.items);
  H.ok('放行了打勾的时间也记上', (state('task-ticks')[S.normKey(chg3)] || { tasks: {} }).tasks['id:3.2'] > 0, state('task-ticks'));
  // 30 分钟内对同一个文件的这道检查还能用
  fs.writeFileSync(tasks3, fs.readFileSync(tasks3, 'utf8') + '- [ ] 4.3 上传控件：src/main/java/B.java；验：/see-page 场景 upload_pick.json\n');
  H.write(path.join(proj, '.vibe', 'scenarios', 'upload_pick.json'), '{"steps":[]}');
  const r3 = tickOf('4.3', sid);
  H.ok('全自动模式：同一个文件 30 分钟内不用再申请', r3 === null, H.reasonOf(r3));
  // 别的文件不能用这张通行证
  const other = mk('other-change', '- [ ] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n');
  fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify(Object.assign(state('reviewed-proposal'), { [S.normKey(other)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(other), issues: 0 } })));
  const r4 = edit(path.join(other, 'tasks.md'), '- [ ] 1.1', '- [x] 1.1', sid);
  H.ok('别的文件用不了这张通行证', r4 && r4.decision === 'block', H.reasonOf(r4));
  // 确信是套件判断错了：--bug，记成问题
  const id4 = blockId(r4);
  const b4 = bypass(id4, 'mvn -q -o compile 刚跑过并且成功了（输出 BUILD SUCCESS），钩子还是说没跑过', ['--bug']);
  H.ok('加了 --bug：记成问题，也放行', b4.code === 0 && /已记下问题 F\d{8}-\d+/.test(b4.out) && records().length === n0 + 1, b4.out + b4.err);
  // 拿问题反馈的编号当拦截编号
  const b5 = bypass('F20260929-006', '想修状态文件，拿问题反馈的编号来申请放行，看看会怎么说');
  H.ok('反馈原样：拿问题编号申请，说清要用哪个编号', b5.code !== 0 && /是问题反馈的编号，不是拦截编号/.test(b5.out), b5.out);
  // 归档门槛：以前"这一类要用户确认"
  const ra = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'openspec archive miping-acceptance-fix --yes 2>&1 | tail -15' } }));
  const ida = blockId(ra);
  H.ok('归档被拦（还有任务没打勾、没审代码）', ra && ra.decision === 'block' && !!ida, H.reasonOf(ra));
  const ba = bypass(ida, '这几项任务每项都有对应的提交，当轮验证都通过了，是打勾的时候被拦才没打上', []);
  H.ok('反馈原样：归档门槛在全自动模式下也能放行', ba.code === 0 && /会直接放行/.test(ba.out), ba.out + ba.err);
  // 1008 起归档还要用户说了才做：会话记录里用户最后一句带上"归档"
  H.transcript(tfile, [H.tr.user('全自动做完，然后归档'), ranBypass(ida, ba.out)]);
  const ra2 = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'openspec archive miping-acceptance-fix --skip-specs --yes' } }));
  H.ok('命令写法变了（多了个参数），还是同一个变更：放行', ra2 === null, H.reasonOf(ra2));
  const ra3 = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'openspec archive other-change --yes' } }));
  H.ok('别的变更用不了这张通行证', ra3 && ra3.decision === 'block' && /other-change/.test(H.reasonOf(ra3)), H.reasonOf(ra3));
  // 配置里关了放行：全自动也不许
  H.setConfig(h, { kitBypass: 'off' });
  const bo = bypass(blockId(ra3), '配置里关掉了申请放行，全自动模式下试一次看看会怎么说，写够二十个字');
  H.ok('配置里关了放行：全自动模式下也不放，让它接着做别的', bo.code !== 0 && /接着做别的/.test(bo.out), bo.out);

  // 有人在的时候：还是弹框、只用一次
  H.setConfig(h, { autoMode: false, kitBypass: 'ask' });
  const sid2 = 's-ask';
  H.transcript(tfile, [H.tr.user('继续，测试'), editA, H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  fs.writeFileSync(path.join(other, 'tasks.md'), '- [ ] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/main/java/A.java；验：`mvn -q -o compile`\n');
  const q1 = edit(path.join(other, 'tasks.md'), '- [ ] 1.1', '- [x] 1.1', sid2);
  H.ok('有人在：提示还是原来那句', q1 && /确信是套件拦错了、任务因此走不下去，才按约定申请放行/.test(H.reasonOf(q1)), H.reasonOf(q1));
  const bq = bypass(blockId(q1), 'mvn -q -o compile 刚跑过并且成功了，钩子说没跑过，查了会话记录确实有这条命令');
  H.ok('有人在：申请放行会弹确认框', bq.code === 0 && /会弹确认框/.test(bq.out), bq.out);
  H.transcript(tfile, [H.tr.user('继续，测试'), editA, ranBypass(blockId(q1), bq.out)]);
  const q2 = edit(path.join(other, 'tasks.md'), '- [ ] 1.1', '- [x] 1.1', sid2);
  H.ok('有人在：再做时弹确认框', q2 && q2.hookSpecificOutput && q2.hookSpecificOutput.permissionDecision === 'ask', q2);
  const q3 = edit(path.join(other, 'tasks.md'), '- [ ] 1.2', '- [x] 1.2', sid2);
  H.ok('有人在：通行证只用一次', q3 && q3.decision === 'block', H.reasonOf(q3));
}

// ---------------------------------------------------------------------------------------------
H.section('不是问题的不记成问题（F20260929-007、F20260928-006 / -008 / -013）');
{
  const n0 = records().length;
  dropState('block-stats');
  H.transcript(tfile, [H.tr.user('继续，测试'), editB, H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  const other = path.join(changes, 'other-change', 'tasks.md');
  for (let i = 0; i < 4; i++) edit(other, '- [ ] 1.2', '- [x] 1.2', 's-stuck');
  H.ok('反馈原样：同一条理由拦了 4 次，不记成问题', records().length === n0, records());
  const stats = F.blockStats(5);
  H.ok('次数记在统计里', stats.length === 1 && stats[0].hook === 'guard-spec' && stats[0].count === 4, stats);
  F.audit('配置页兜底放行改成了"让它自己放行"', '经配置页的接口改的');
  H.ok('配置页改开关：记在开关变更里，不记成问题', F.auditList().length === 1 && records().length === n0, F.auditList());
  // 老版本留下的这两种记录：问题列表里不出现（2026-10-01 起没有本机导出了，看列表、上报用的同一个筛法 isNoise）
  F.record({ kind: '卡住', hook: 'guard-spec', source: '钩子自动记录', title: '同一个会话里被"x"拿同一条理由拦了 3 次', what: '旧记录', sig: 'old-stuck' });
  F.record({ kind: '开关变更', hook: '配置页', source: '钩子自动记录', title: '配置页打开了全自动模式', what: '旧记录', sig: '' });
  F.record({ kind: '误拦', hook: 'guard-spec', source: '模型反馈', title: '真的问题一条', what: 'x', why: 'y', sig: 'real-1' });
  const titles = F.listRecords().filter((r) => !F.isNoise(r)).map((r) => r.title).join('\n');
  H.ok('问题列表里只有真的问题', /真的问题一条/.test(titles) && !/拦了 3 次/.test(titles) && !/配置页打开了全自动模式/.test(titles), titles);
  H.ok('"拦得最多的规矩"和"放行记录"两张表的数都在', F.blockStats(20).length >= 1 && F.bypassLog(50).length >= 1, [F.blockStats(20), F.bypassLog(50).length]);
  H.ok('放行记录里有理由', F.bypassLog(50).some((p) => /01c/.test(p.why || '')), F.bypassLog(50).map((p) => p.why));
}

// ---------------------------------------------------------------------------------------------
H.section('命令：注释不是命令；没写变更名时说清查的是谁（F20260928-012、F20260929-004）');
{
  const sid = 's-cmd';
  const run = (cmd, tool) => H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: tool || 'Bash', tool_input: { command: cmd } }));
  const K = '"$HOME/.claude/vibe-kit/tools/trace.js"';
  H.ok('反馈原样：注释行里提到套件的路径，下一行 git checkout 不拦', run('# 先用 node ' + K + ' 溯源过了\ngit checkout -- src/main/java/A.java') === null);
  H.ok('行尾的注释也不算', run('git checkout -- src/main/java/A.java # 之前 node ' + K + ' 查过') === null);
  H.ok('PowerShell 的注释也不算', run('# 看过 ' + K + '\ngit checkout -- src/main/java/A.java', 'PowerShell') === null);
  H.ok('注释里写的 git push 不弹确认', run('git status # 之后再 git push') === null);
  H.ok('真的 push 要先预览再确认', (run('git status && git push origin main') || {}).decision === 'block' && /推送前先运行.*plan/.test(H.reasonOf(run('git status && git push origin main'))));
  H.ok('引号里的 # 不是注释', (() => { const r = run('echo "#x" > "$HOME/.claude/vibe-kit/config.json"'); return r && r.decision === 'block'; })());
  H.ok('真去改套件的照样拦', (() => { const r = run('rm -rf "$HOME/.claude/vibe-kit/hooks"'); return r && r.decision === 'block' && /不许改/.test(H.reasonOf(r)); })());
  H.ok('列出套件的文件再交给 xargs 删：拦', (() => { const r = run('ls "$HOME/.claude/vibe-kit/hooks" | xargs rm -f'); return r && r.decision === 'block'; })());
  H.ok('管道前面的段没提到套件、后面只读地看套件：不拦', run('git log --oneline -3 | cat - "$HOME/.claude/vibe-kit/VERSION"') === null);
  H.ok('只读地看套件的文件不拦', run('cat "$HOME/.claude/vibe-kit/VERSION" | head -1') === null);
  // 没归档的变更只剩一个时，不带名字的 openspec archive 查的是它：提示里要说
  for (const n of ['secflow-gate', 'gate2', 'miping-acceptance-fix', 'other-change']) fs.rmSync(path.join(changes, n), { recursive: true, force: true });
  const r = run('openspec archive --yes 2>&1 | tail -5');
  H.ok('反馈原样：没写变更名，提示里说清查的是哪个、为什么是它', r && r.decision === 'block' && /这条命令没写变更名，没归档的变更只有 login-gate-and-pwd-ui-fix 一个，查的是它/.test(H.reasonOf(r)), H.reasonOf(r));
  mk('another', '- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`\n');
  H.ok('没归档的有两个、没写名字：不猜，不拦', run('openspec archive --yes') === null);
}

// ---------------------------------------------------------------------------------------------
H.section('全自动模式：push、提问框不挂着；不能放行的拦截也不让它等人');
{
  H.setConfig(h, { autoMode: true, kitBypass: 'ask' });
  const sid = 's-auto2';
  H.inFlow(h, sid);
  R.begin({ session_id: sid, cwd: proj });
  H.transcript(tfile, [H.tr.user('全自动做完')]);
  const push = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'git -C . push origin main' } }));
  H.ok('全自动 push 先预览并等真人确认', push && push.decision === 'block' && /全自动模式/.test(H.reasonOf(push)) && /plan/.test(H.reasonOf(push)) && /等.*确认/.test(H.reasonOf(push)), push);
  const ask = H.hook(h, 'guard-ask', Object.assign(base(sid), { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '导出的文件名用哪种格式？', header: '文件名', options: [{ label: '带日期', description: 'x' }, { label: '不带日期', description: 'y' }] }] } }));
  H.ok('自动阶段允许澄清业务问题', ask === null);
  const kit = H.hook(h, 'pre-edit', Object.assign(base(sid), { tool_name: 'Edit', tool_input: { file_path: path.join(h.kit, 'state', 'review-rounds.json'), old_string: 'a', new_string: 'b' } }));
  H.ok('改套件的文件：照样拦，但不让它停下等人', kit && kit.decision === 'block' && /不许改/.test(H.reasonOf(kit)) && /不要停下等我/.test(H.reasonOf(kit)) && !/拦截编号/.test(H.reasonOf(kit)), H.reasonOf(kit));
  const all = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'git add -A && git commit -m "feat: x"' } }));
  H.ok('整仓 add：照样拦，不给编号，不让它等人', all && all.decision === 'block' && /不要停下等我/.test(H.reasonOf(all)) && !/拦截编号/.test(H.reasonOf(all)), H.reasonOf(all));
  const items = R.stateOf({ session_id: sid }).items;
  H.ok('报告里记了：想 push、想问的问题和选项、没让改的文件、没让跑的命令', items.some((x) => x.kind === 'hand' && /git push/.test(x.title)) && !items.some(x => x.kind === 'ask') && items.some((x) => x.kind === 'hand' && /review-rounds\.json/.test(x.title)) && items.some((x) => x.kind === 'hand' && /git add -A/.test(x.title)), items);
  // 提交里像有密码：不弹框，放行，记进报告
  H.write(path.join(proj, 'src/main/resources/app.properties'), 'db.password=Abc12345xyz\n');
  H.transcript(tfile, [H.tr.user('改好了，提交')]);
  const c = H.hook(h, 'guard-commit', Object.assign(base(sid), { tool_name: 'Bash', tool_input: { command: 'git add src/main/resources/app.properties && git commit -m "feat: 加配置"' } }));
  H.ok('提交里像有密码：不弹框，放行', c === null, c);
  H.ok('报告里记了，密码遮住了', R.stateOf({ session_id: sid }).items.some((x) => x.kind === 'secret' && /app\.properties/.test(x.detail) && !/Abc12345xyz/.test(x.detail)), R.stateOf({ session_id: sid }).items);
  // 有人在的时候照旧弹框（1008 起不走 OpenSpec 的提交要用户点头：会话记录里用户最后一句说了提交）
  H.setConfig(h, { autoMode: false });
  H.transcript(tfile, [H.tr.user('改好了，提交')]);
  const push2 = H.hook(h, 'guard-commit', Object.assign(base('s-man'), { tool_name: 'Bash', tool_input: { command: 'git push' } }));
  H.ok('有人在：push 先要求预览', push2 && push2.decision === 'block' && /推送预览/.test(H.reasonOf(push2)), push2);
  const c2 = H.hook(h, 'guard-commit', Object.assign(base('s-man'), { tool_name: 'Bash', tool_input: { command: 'git add src/main/resources/app.properties && git commit -m "feat: 加配置"' } }));
  H.ok('有人在：提交里像有密码弹确认框', c2 && c2.hookSpecificOutput && c2.hookSpecificOutput.permissionDecision === 'ask', c2);
  H.ok('有人在：提问框照常能用', H.hook(h, 'guard-ask', Object.assign(base('s-man'), { tool_name: 'AskUserQuestion', tool_input: { questions: [] } })) === null);
}

// ---------------------------------------------------------------------------------------------
H.section('开关只认配置页改的：全自动模式也算');
{
  const cfgFile = path.join(h.kit, 'config.json');
  H.setConfig(h, { autoMode: false, kitBypass: 'ask' });
  fs.writeFileSync(cfgFile, JSON.stringify(Object.assign(readJson(cfgFile), { autoApply: true })));
  const c = H.node(h, '-e', ['const c = require(' + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + ').readConfig(); console.log(JSON.stringify({ a: c.autoMode, t: c._tampered || [] }))']);
  H.ok('绕开配置页把全自动模式打开：不认', /"a":false/.test(c.out) && /autoApply/.test(c.out), c.out + c.err);
  // 老版本的封条里没有这一项：认文件里的
  const seal = path.join(h.kit, 'state', 'config-seal.json');
  const s = readJson(seal); delete s.autoMode; delete s.autoApply; fs.writeFileSync(seal, JSON.stringify(s));
  const c2 = H.node(h, '-e', ['const c = require(' + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + ').readConfig(); console.log(JSON.stringify({ a: c.autoMode, t: c._tampered || [] }))']);
  H.ok('老版本的封条里没有这一项：以前打开过的照旧', /"a":true/.test(c2.out) && /"t":\[\]/.test(c2.out), c2.out + c2.err);
  H.setConfig(h, { autoMode: false });
}

// ---------------------------------------------------------------------------------------------
H.section('收工检查：改了产物有没有记修订，不再只看会话记录末尾（F20260929-001）');
{
  for (const n of fs.readdirSync(changes)) if (n !== 'archive') fs.rmSync(path.join(changes, n), { recursive: true, force: true });
  const sid = 's-rev';
  const chg = mk('rev-change', '- [ ] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`' + '\n', { 'revisions.md': '# 修订记录\n', 'design.md': '## Context\n\n- 读过 src/main/java/A.java\n\n## Decisions\n\n- 用现有的表\n' });
  const tasks = path.join(chg, 'tasks.md');
  const revs = path.join(chg, 'revisions.md');
  const stop = (entries, said, active) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: !!active, last_assistant_message: said || '改好了，没验证：这一轮只改了文档' });
  const snap = () => H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: tfile, prompt: '看一下进度' });
  H.setConfig(h, { autoMode: false, autoCommit: 'off', autoCrossReview: false, lessons: 'off', vibeTidy: false });
  H.transcript(tfile, [H.tr.user('看一下进度')]);
  snap();
  // 几个小时之前：改了 tasks.md 的验法，修订记录是用命令追加的（会话记录里看不到"改过 revisions.md"）
  const editTasks = H.tr.ran('Edit', { file_path: tasks, old_string: 'mvn -q -o compile', new_string: 'mvn -q compile' }, 'ok');
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('mvn -q -o compile', 'mvn -q compile'));
  fs.appendFileSync(revs, '\n## 2026-09-29 00:20 · apply 做 1.1 时\n- 起因：客观。离线编不了\n- 改了：tasks.md：验法去掉 -o\n- 上层：不用改\n');
  const r1 = stop([H.tr.user('看一下进度'), editTasks, H.tr.ran('Bash', { command: 'cat >> openspec/changes/rev-change/revisions.md <<EOF\n…\nEOF' }, '')]);
  H.ok('反馈原样：修订记录是用命令追加的，不说"没有记录"', !/但没有记录/.test(H.reasonOf(r1)), H.reasonOf(r1));
  // 同一轮里过了很久再收工（全自动一轮跑几个小时）：那次编辑还在会话记录里，不再拿它说事
  const r2 = stop([H.tr.user('看一下进度'), editTasks, H.tr.ran('Bash', { command: 'git log --oneline -3' }, 'x'), H.tr.say('审查收尾做完了')], '审查收尾做完了，没验证：只改了文档');
  H.ok('反馈原样：之后的收工不再说"这一轮改了 tasks.md"', !/改了 OpenSpec 变更/.test(H.reasonOf(r2)), H.reasonOf(r2));
  // 真的改了没记：照样拦
  const design = path.join(chg, 'design.md');
  fs.writeFileSync(design, fs.readFileSync(design, 'utf8').replace('用现有的表', '新建一张表'));
  // 这次编辑是对过账之后做的（测试里会话记录的时间是往前拨过的，这里写成现在）
  const nowStamp = (list) => list.map((e) => Object.assign(e, { timestamp: new Date().toISOString() }));
  const late = nowStamp(H.tr.ran('Edit', { file_path: design, old_string: '用现有的表', new_string: '新建一张表' }, 'ok'));
  const r3 = stop([H.tr.user('看一下进度'), editTasks, late, H.tr.say('改好了')]);
  H.ok('之后又改了设计、没记修订：拦，说的是 design.md', /这一轮改了 OpenSpec 变更 rev-change 的 design\.md/.test(H.reasonOf(r3)) && /但没有记录/.test(H.reasonOf(r3)), H.reasonOf(r3));
  fs.appendFileSync(revs, '\n## 2026-09-29 02:10 · apply 做 1.1 时\n- 起因：主观。现有的表字段不够\n- 改了：design.md\n- 上层：不用改\n');
  const r4 = stop([H.tr.user('看一下进度'), editTasks, late, nowStamp(H.tr.ran('Edit', { file_path: revs, old_string: 'a', new_string: 'b' }, 'ok')), H.tr.say('记好了')], '记好了，没验证：只改了文档', true);
  H.ok('补记之后放行', !/但没有记录/.test(H.reasonOf(r4)), H.reasonOf(r4));
}

// ---------------------------------------------------------------------------------------------
H.section('全自动模式：留给用户的任务不卡住整条链；收工时交报告（F20260929-010 / -011 / -013）');
{
  for (const n of fs.readdirSync(changes)) if (n !== 'archive') fs.rmSync(path.join(changes, n), { recursive: true, force: true });
  for (const n of ['reviewed', 'reviewed-proposal', 'review-rounds', 'review-nudged', 'task-ticks']) dropState(n);
  H.setConfig(h, { autoMode: true, kitBypass: 'ask', autoCommit: 'off', autoCrossReview: true, lessons: 'off', vibeTidy: false, reviewLoop: false, autoVerify: false, autoSeePage: false });
  const sid = 's-report';
  const chg = mk('miping', ['- [x] 3.1 移除审核按钮：src/main/java/A.java；验：`mvn -q -o compile`',
    '- [ ] 3.2 审核接口角色：src/main/java/B.java；验：javac 快检；对照场景 `checklist_role_compare.json`',
    '- [ ] 3.3 备号脚本：执行 deploy/sql/01c.sql；验：查库（留给用户：改库不可逆，要用户确认）', ''].join('\n'),
  { 'revisions.md': '# 修订记录\n\n## 2026-09-28 10:00 · 写提案时\n- 起因：自动模式决定。上一轮定的事，不该出现在这一轮的报告里\n- 改了：proposal.md\n- 上层：不用改\n' });
  H.write(path.join(proj, 'deploy/sql/01c.sql'), '-- dml\n');
  H.write(path.join(proj, '.vibe', 'pending', 'miping_说明.md'), '# 说明\n');
  fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify({ [S.normKey(chg)]: { done: true, at: Date.now() - 7200000, born: S.changeBorn(chg), issues: 0 } }));
  fs.writeFileSync(path.join(h.kit, 'state', sid + '-changes.json'), JSON.stringify({ dirs: [S.normKey(chg)], at: Date.now() }));
  // 这个会话在流程里，动手做的就是这个变更（收工时只催在流程里动手做过的）；发归档命令的那个会话也在流程里
  H.inFlow(h, sid, [chg]);
  H.inFlow(h, 's-arch');
  const tasks = path.join(chg, 'tasks.md');
  const stop = (entries, said, active) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: !!active, last_assistant_message: said });
  R.begin({ session_id: sid, cwd: proj });
  // 这一轮里记的决定：标题里的日期是模型写的，常常不对（这里故意写成去年的），照样要认出来
  fs.appendFileSync(path.join(chg, 'revisions.md'), '\n## 2025-01-01 08:00 · apply 做 3.2 时\n- 起因：自动模式决定。导出的文件名格式没人定，按带日期的做\n- 改了：design.md\n- 上层：不用改\n');
  const talk = [H.tr.user('全自动把 miping 做完'), H.tr.ran('Read', { file_path: tasks }, 'x')];
  // 还有能做的任务：催它接着做，说的是能做的那一项，不是留给用户的那一项
  const r1 = stop(talk.concat([H.tr.say('3.1 做完了')]), '3.1 做完了');
  H.ok('还有能做的：催下一项，是 3.2', /继续当前范围的下一项 3\.2/.test(H.reasonOf(r1)));
  H.ok('业务疑问先问，套件执行安排只记本机', /业务疑问先 Ask/.test(H.reasonOf(r1)) && /只记本机/.test(H.reasonOf(r1)));
  // 3.2 做完了（验法里有一部分本次不做），只剩留给用户的 3.3
  fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('- [ ] 3.2', '- [x] 3.2').replace('对照场景 `checklist_role_compare.json`', '对照场景 `checklist_role_compare.json` 本次不做（要先执行 3.3 备号）'));
  R.note({ session_id: sid, cwd: proj }, { kind: 'unverified', title: '任务（miping）3.2 审核接口角色', detail: '验法里写了不做：对照场景 checklist_role_compare.json 本次不做（要先执行 3.3 备号）' });
  R.note({ session_id: sid, cwd: proj }, { kind: 'ask', title: '导出的文件名用哪种格式？', detail: '带日期 / 不带日期' });
  R.note({ session_id: sid, cwd: proj }, { kind: 'bypass', title: 'OpenSpec 产物的门槛：Edit：' + tasks, detail: '对照场景要先改库，留给用户' });
  const r2 = stop(talk.concat([H.tr.say('3.2 做完了')]), '3.2 做完了');
  H.ok('只剩留给用户的任务：有限审查，不催做 3.3', /审查点 group-3/.test(H.reasonOf(r2)) && /review.js run/.test(H.reasonOf(r2)) && !/下一项 3\.3/.test(H.reasonOf(r2)));
  // 审完了
  H.reviewPoints(h, chg);
  const rv = review('toolu_rep1', '代码', 'miping', 0);
  const r3 = stop(talk.concat(rv, [H.tr.say('审完了，问题 0 条')]), '审完了，问题 0 条');
  H.ok('反馈原样：审过了、只剩留给用户的，不催归档，交报告', /^\[vibe-kit 全自动报告\]/.test(H.reasonOf(r3)) && !/直接 \/opsx:archive/.test(H.reasonOf(r3)), H.reasonOf(r3));
  const text = H.reasonOf(r3);
  H.ok('报告说了做到哪', /miping 任务 2\/3/.test(text), text);
  H.ok('报告里有留给用户的任务、等定位置的产出', /留给你做的 \d+ 件/.test(text) && /3\.3 备号脚本/.test(text) && /miping_说明\.md/.test(text), text);
  H.ok('报告里有想问没问成的、没验证的、放行的、自己定的', /它想问你、没问成的 1 件：导出的文件名用哪种格式/.test(text) && /没验证的 1 件/.test(text) && /放行的检查 1 件/.test(text) && /它自己定的事 1 件/.test(text), text);
  H.ok('让它照七节交代（多了"库里改过的"）', /1\. 做了什么/.test(text) && /3\. 库里改过的/.test(text) && /7\. 套件问题/.test(text) && /写完就收工/.test(text), text);
  const file = (text.match(/报告在 (.+?\.md)/) || [])[1] || '';
  H.ok('报告的文件名精确到秒', /全自动报告-\d{8}-\d{6}\.md$/.test(file), file);
  H.ok('报告文件写在项目的 .vibe/reports 里', !!file && fs.existsSync(file) && S.normKey(file).startsWith(S.normKey(path.join(proj, '.vibe', 'reports')) + '/'), file);
  const body = file ? fs.readFileSync(file, 'utf8') : '';
  H.ok('报告文件各节都在', ['## 数', '## 变更做到哪', '## 留给你做的', '## 库里改过的', '## 它想问你、没问成的', '## 没验证的', '## 放行的检查', '## 它自己定的事', '## 这一轮的提交', '## 套件问题', '## AI 最后的交代'].every((t) => body.includes(t)), body);
  H.ok('报告里有这一轮记的"自动模式决定"，标题里的日期写错了也认', /起因：自动模式决定。导出的文件名格式没人定/.test(body), body);
  H.ok('上一轮记的不算', !/上一轮定的事/.test(body), body);
  // 它照着交代完，再收工：放行，它的话接在报告后面
  const final = '## 做了什么\nmiping 做到 2/3。\n## 留给你做的\n3.3 备号脚本要你执行。\n## 自己定的事\n文件名带日期。\n## 没验证的\n3.2 的对照场景。\n## 放行的检查\n打勾检查一次。\n## 套件问题\n没有。';
  const r4 = stop(talk.concat(rv, [H.tr.say('审完了'), H.tr.say(final)]), final, true);
  H.ok('交代完放行', r4 === null, H.reasonOf(r4));
  H.ok('它最后的交代接在报告后面', /## AI 最后的交代\n\n## 做了什么\nmiping 做到 2\/3/.test(fs.readFileSync(file, 'utf8')), fs.readFileSync(file, 'utf8').slice(-400));
  // 同一轮里没有新情况：不再交第二次
  const r5 = stop(talk.concat(rv, [H.tr.say(final)]), final);
  H.ok('没有新情况不再交第二次', r5 === null, H.reasonOf(r5));
  // 之后又有新情况（又放行了一次）：再交一次
  R.note({ session_id: sid, cwd: proj }, { kind: 'bypass', title: '归档门槛：openspec archive miping', detail: '留给用户的任务不影响归档' });
  const r6 = stop(talk.concat(rv, [H.tr.say('又做了一点')]), '又做了一点');
  H.ok('又有新情况：再交一次', /^\[vibe-kit 全自动报告\]/.test(H.reasonOf(r6)) && /放行的检查 2 件/.test(H.reasonOf(r6)), H.reasonOf(r6));
  // 归档门槛：留给用户的任务没做，全自动模式下说清先不归档
  const ar = H.hook(h, 'guard-commit', Object.assign(base('s-arch'), { tool_name: 'Bash', tool_input: { command: 'openspec archive miping --yes' } }));
  H.ok('归档：说清有 1 项是留给用户的、先不归档', ar && ar.decision === 'block' && /还有 1 项任务没打勾（其中 1 项是留给用户做的）/.test(H.reasonOf(ar)) && /这个变更先不归档/.test(H.reasonOf(ar)), H.reasonOf(ar));
  // 这个会话只发了归档命令、没改过变更目录里的文件：也要记到它名下，报告才认得出"已归档"
  const touched = JSON.parse(fs.readFileSync(path.join(h.kit, 'state', 's-arch-changes.json'), 'utf8')).dirs || [];
  H.ok('归档命令点到的变更记到了这个会话名下', touched.includes(S.normKey(chg)), touched);
  // 用户开口：新的一轮，报告从头记
  H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: tfile, prompt: '3.3 我执行过了，接着归档' });
  H.ok('用户开口之后报告从头记', R.stateOf({ session_id: sid }).items.length === 0 && R.stateOf({ session_id: sid }).delivered === 0, R.stateOf({ session_id: sid }));
  // 不是全自动模式：不交报告
  H.setConfig(h, { autoMode: false });
  const r7 = stop(talk.concat(rv, [H.tr.say('做完了')]), '做完了，没验证：没有改代码');
  H.ok('有人在的时候不交报告', !/全自动报告/.test(H.reasonOf(r7)), H.reasonOf(r7));
}

// ---------------------------------------------------------------------------------------------
H.section('归档之后主规格跟上了没有；规格增量要放在认得的标题下面（F20260929-014）');
{
  H.setConfig(h, { autoMode: false, autoCommit: 'off', autoCrossReview: false, lessons: 'off', vibeTidy: false, autoVerify: false });
  const sid = 's-spec';
  const arch = path.join(changes, 'archive', '2026-09-29-secret-level-compare-fix');
  const delta = ['## MODIFIED Requirements', '', '### Requirement: 密级比较', '系统 SHALL 按数值比较密级。', '', '#### Scenario: 低密看高密', '- WHEN 低密账号查高密记录', '- THEN 返回空', '', '## ADDED Requirements', '', '### Requirement: 密级为空', '系统 SHALL 把空密级当成最低。', '', '#### Scenario: 空密级', '- WHEN 记录的密级为空', '- THEN 所有人可见', ''].join('\n');
  H.write(path.join(arch, 'specs', 'secret-level-model', 'spec.md'), delta);
  H.write(path.join(arch, 'tasks.md'), '- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`' + '\n');
  H.write(path.join(proj, 'openspec', 'specs', 'secret-level-model', 'spec.md'), '# secret-level-model Specification\n\n## Requirements\n\n### Requirement: 密级比较\n旧的写法。\n\n#### Scenario: x\n- WHEN a\n- THEN b\n');
  fs.writeFileSync(path.join(h.kit, 'state', sid + '-changes.json'), JSON.stringify({ dirs: [S.normKey(path.join(changes, 'secret-level-compare-fix'))], at: Date.now() }));
  const stop = (said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, [H.tr.user('归档'), H.tr.ran('Bash', { command: 'openspec archive secret-level-compare-fix --skip-specs --yes' }, 'ok'), H.tr.say(said)]), stop_hook_active: false, last_assistant_message: said });
  const r = stop('归档好了');
  H.ok('反馈原样：用 --skip-specs 归档，主规格里没有新加的需求，提醒', /变更 secret-level-compare-fix 归档了，但主规格里没有它的这些需求：secret-level-model：密级为空/.test(H.reasonOf(r)) && /--skip-specs/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('主规格里已经有的那条不提', !/secret-level-model：密级比较/.test(H.reasonOf(r)), H.reasonOf(r));
  H.ok('每个变更只提醒一次', !/归档了，但主规格里没有/.test(H.reasonOf(stop('归档好了'))));
  // 写规格的时候就查标题
  const specFile = path.join(changes, 'new-change', 'specs', 'cap', 'spec.md');
  const write = (content) => H.hook(h, 'guard-spec', Object.assign(base('s-spec2'), { tool_name: 'Write', tool_input: { file_path: specFile, content } }));
  const bad = write('## 修改的需求\n\n### Requirement: 甲\n系统 SHALL 做甲。\n\n#### Scenario: 一\n- WHEN a\n- THEN b\n');
  H.ok('需求没放在增量标题下面：拦，说清该写哪几种标题', bad && bad.decision === 'block' && /没放在增量标题下面/.test(H.reasonOf(bad)) && /## MODIFIED Requirements/.test(H.reasonOf(bad)) && /no deltas found/.test(H.reasonOf(bad)), H.reasonOf(bad));
  H.ok('写在认得的标题下面：不拦', write(delta) === null);
}

H.done('内网反馈 0929');

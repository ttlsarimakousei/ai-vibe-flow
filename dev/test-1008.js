'use strict';
/*
 * 2026-10-07 这一批（用户用下来提的四件事，外加交接的"不问"）：
 *   归档要点头        任务全打勾、代码审过了也不归档：会话记录里用户最后一句是"归档"（或者提问框里选了归档）才让；说的是别的变更不算；不能放行
 *   提交要点头        不走 OpenSpec 的改动（这个会话没动过变更）：用户最后一句不是"提交"就拦 git commit；收工检查催它问、不催它提交。开关 plainCommit
 *   全自动只管 apply  流程分 plan / apply 两段：提需求、/opsx:propose、改提案是 plan（全自动不算数，提问框能用）；"开工"、/opsx:apply、做某项任务是 apply；
 *                     模型自己调 /opsx:apply、在 plan 那一段打勾：拦下；全自动收工不催归档，报告里写等用户自测
 *   开工时告诉用户    敲 /opsx:apply、说"开工"：systemMessage 说全自动开没开，给模型的提醒里也有一句
 *   交接的"不问"      handoverAsk = off：过线只提醒一句，不让它自己写交接记录
 * 用法：node dev/test-1008.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const S = require(path.join(H.SRC, 'kit', 'lib', 'session.js'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const QUIET = { autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', vibeTidy: false };
/** 把一个变更记成代码审过了（和 verify-gate 记的一样：时间、变更目录的出生时间） */
const markCodeReviewed = (h, dir) => { const f = path.join(h.kit, 'state', 'reviewed.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), { [S.normKey(dir)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(dir), issues: 0 } }))); };
const markProposalReviewed = (h, dir) => { const f = path.join(h.kit, 'state', 'reviewed-proposal.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), { [S.normKey(dir)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(dir), issues: 0 } }))); };
const answered = (q, a) => H.tr.ran('AskUserQuestion', { questions: [{ question: q, header: '确认', options: [{ label: a }, { label: '别的' }] }] }, 'User has answered your questions: "' + q + '"="' + a + '"');
const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));

(async () => {
  const watch = await H.watchWindows('t1008-win');

  // ---------------------------------------------------------------------------------------------
  H.section('归档：任务全打勾、代码审过了，还要我自测过、说了归档才让');
  {
    const h = H.makeHome('t1008-arch', null, QUIET);
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
      'openspec/changes/done-x/tasks.md': '- [x] 1.1 改 src/main/java/A.java；验：mvn -q compile\n- [x] 1.2 改 src/main/java/A.java；验：mvn -q compile\n',
      'openspec/changes/half-z/tasks.md': '- [x] 1.1 改 src/main/java/A.java；验：mvn -q compile\n- [ ] 1.2 改 src/main/java/A.java；验：mvn -q compile\n' });
    const doneX = path.join(proj, 'openspec', 'changes', 'done-x');
    markCodeReviewed(h, doneX);
    const tf = path.join(h.root, 'a.jsonl');
    const arch = (sid, entries, cmd) => H.hook(h, 'guard-commit', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd || 'openspec archive done-x --yes' }, transcript_path: H.transcript(tf, entries) });
    const r1 = arch('s1', [H.tr.user('做完了吗'), H.tr.say('做完了，代码也审过了')]);
    H.ok('我没说归档：拦下，让它交代怎么自测、用提问框问我', blocked(r1) && /我还没自测、还没说归档/.test(H.reasonOf(r1)) && /用提问框问我自测过了没有、能不能归档/.test(H.reasonOf(r1)), H.reasonOf(r1));
    H.ok('这一道不能申请放行（没有拦截编号）', !/拦截编号/.test(H.reasonOf(r1)), H.reasonOf(r1));
    H.ok('我说了"归档吧"：放行', arch('s1', [H.tr.user('自测没问题，归档吧')]) === null);
    H.ok('"改完 X 再归档"也算说了归档', arch('s1', [H.tr.user('把日志那行去掉，然后再归档')]) === null);
    H.ok('"先别归档"：拦', blocked(arch('s1', [H.tr.user('先别归档，我再看看')])));
    H.ok('"归档了吗"是在问，不是让它归档：拦', blocked(arch('s1', [H.tr.user('归档了吗')])));
    const r2 = arch('s1', [H.tr.user('归档 half-z')]);
    H.ok('我说的是归档别的变更：拦，说清我说的是哪个', blocked(r2) && /我说的是归档 half-z，不是它/.test(H.reasonOf(r2)), H.reasonOf(r2));
    H.ok('没点名的"归档"：放行', arch('s1', [H.tr.user('归档')]) === null);
    H.ok('钩子附在消息里的提醒不算我说的话：拦', blocked(arch('s1', [H.tr.user('[vibe-kit 提醒] 进行中的 OpenSpec 变更：done-x，等着归档\n字段名改一下')])));
    H.ok('提问框里选了"归档"：放行', arch('s1', [H.tr.user('做完了'), answered('自测过了吗，能归档吗？', '归档')]) === null);
    H.ok('提问框里选了"可以"（问题里问的是归档）：放行', arch('s1', [H.tr.user('做完了'), answered('能归档了吗？', '可以')]) === null);
    H.ok('提问框里选了"还要改"：拦', blocked(arch('s1', [H.tr.user('做完了'), answered('能归档了吗？', '还要改')])));
    H.ok('我自己敲的 /opsx:archive：放行', arch('s1', [H.tr.user('<command-name>/opsx:archive</command-name>\n<command-message>opsx:archive</command-message>\n<command-args>done-x</command-args>')]) === null);
    H.ok('我说了归档之后又说了别的（"等等，还有个问题"）：拦，得改完再问', blocked(arch('s1', [H.tr.user('归档'), H.tr.say('好'), H.tr.user('等等，还有个问题，导出少了表头')])));
    const r3 = arch('s1', [H.tr.user('归档')], 'openspec archive half-z --yes');
    H.ok('任务没全打勾的照旧拦，这种能申请放行（带拦截编号）', blocked(r3) && /还有 1 项任务没打勾/.test(H.reasonOf(r3)) && /拦截编号/.test(H.reasonOf(r3)), H.reasonOf(r3));
    // 全自动：我不在，没人说归档，就留给我
    H.setConfig(h, { autoMode: true });
    const R = require(path.join(h.kit, 'lib', 'report.js'));
    const sa = 's-auto';
    H.inFlow(h, sa, [doneX]);
    R.begin({ session_id: sa, cwd: proj });
    const r4 = arch(sa, [H.tr.user('全自动做完')]);
    H.ok('全自动：拦下，让它写进"留给你做的"、不要再试，也不让它停下等人', blocked(r4) && /收工交报告，写进"留给你做的"/.test(H.reasonOf(r4)) && /不要停下等我/.test(H.reasonOf(r4)) && !/拦截编号/.test(H.reasonOf(r4)), H.reasonOf(r4));
    H.ok('记进了全自动报告的"留给你做的"', R.stateOf({ session_id: sa }).items.some((x) => x.kind === 'hand' && /openspec archive done-x/.test(x.title)), R.stateOf({ session_id: sa }).items);
    const stop = H.hook(h, 'verify-gate', { session_id: sa, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, [H.tr.user('全自动做完'), H.tr.say('做完了')]), stop_hook_active: false, last_assistant_message: '做完了' });
    const file = (H.reasonOf(stop).match(/报告在 (.+?\.md)/) || [])[1] || '';
    const body = file ? H.read(file) || '' : '';
    H.ok('全自动收工：不催它归档', !/直接 \/opsx:archive/.test(H.reasonOf(stop)) && !/再归档/.test(H.reasonOf(stop)), H.reasonOf(stop));
    H.ok('报告里写明代码审过、等我自测后归档；让它在交代里写怎么自测', /done-x：任务 2\/2，代码审过，等用户自测后归档/.test(body) && /归档等我自测过说了再做/.test(H.reasonOf(stop)), [H.reasonOf(stop).slice(0, 300), body.slice(0, 400)]);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('提交：不走 OpenSpec 的改动，我说了提交才提交（开关 plainCommit）');
  {
    const h = H.makeHome('t1008-commit', null, Object.assign({ specGate: false }, QUIET));
    const proj = H.makeRepo(path.join(h.work, 'tool'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n', '.claude/rules/ttls-lessons-java.md': '- x\n' });
    const A = path.join(proj, 'src', 'A.java');
    const tf = path.join(h.root, 'c.jsonl');
    const editA = () => H.tr.ran('Edit', { file_path: A, old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok');
    const commit = (sid, entries, cmd, cwd) => H.hook(h, 'guard-commit', { session_id: sid, cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd || 'git add src/A.java && git commit -m "fix: 空指针"' }, transcript_path: H.transcript(tf, entries) });
    const r1 = commit('c1', [H.tr.user('修一下 A 的空指针'), editA(), H.tr.say('修好了')]);
    H.ok('我没说提交：拦下，让它交代了用提问框问我；不能放行', blocked(r1) && /不走 OpenSpec 的改动，提交之前要我点头/.test(H.reasonOf(r1)) && /用提问框问我提不提交/.test(H.reasonOf(r1)) && !/拦截编号/.test(H.reasonOf(r1)), H.reasonOf(r1));
    H.ok('我说了"提交"：放行', commit('c1', [H.tr.user('修一下 A 的空指针'), editA(), H.tr.say('修好了，提交吗？'), H.tr.user('改好了，提交')]) === null);
    H.ok('"先别提交"：拦', blocked(commit('c1', [H.tr.user('先别提交，我看看')])));
    H.ok('提问框里选了"提交"：放行', commit('c1', [H.tr.user('修一下'), editA(), answered('改好了，提交吗？', '提交')]) === null);
    H.ok('提问框里选了"还要改"：拦', blocked(commit('c1', [H.tr.user('修一下'), editA(), answered('改好了，提交吗？', '还要改')])));
    H.ok('经验规则的文件：套件自己催的，不问', commit('c1', [H.tr.user('修一下')], 'git add .claude/rules/ttls-lessons-java.md && git commit -m "docs: 更新经验规则"') === null);
    H.write(path.join(proj, 'openspec/changes/archive/2026-10-10-add-x/tasks.md'), '- [x] 1.1 完成\n');
    H.ok('提案单独确认，归档产物按实际文件提交', blocked(commit('c1', [H.tr.user('修一下')], 'git commit -m "docs: 提案 add-x"')) && commit('c1', [H.tr.user('修一下')], 'git add openspec/changes/archive/2026-10-10-add-x/tasks.md && git commit -m "docs: 归档 add-x"') === null);
    H.ok('提交信息不合规范的照旧先拦格式', /提交信息不符合公司规范/.test(H.reasonOf(commit('c1', [H.tr.user('修一下')], 'git commit -m "改了点东西"'))));
    H.setConfig(h, { plainCommit: 'auto' });
    H.ok('开关选"直接提交"：不问', commit('c1', [H.tr.user('修一下 A 的空指针'), editA(), H.tr.say('修好了')]) === null);
    H.setConfig(h, { plainCommit: 'ask' });
    // 这个会话动过 OpenSpec 变更：按提交节奏来，不问
    const po = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 改 src/A.java；验：mvn -q compile\n' });
    const tasks = path.join(po, 'openspec', 'changes', 'add-x', 'tasks.md');
    H.inFlow(h, 'c2', [path.dirname(tasks)], true, 'apply');
    H.ok('当前正在 apply：按提交节奏，不问', commit('c2', [H.tr.user('/opsx:apply add-x'), H.tr.ran('Edit', { file_path: tasks, old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, 'ok')], 'git add src/A.java && git commit -m "feat: 1.1"', po) === null);
    // 全自动（在做任务那一段）：不问
    H.setConfig(h, { autoMode: true });
    H.inFlow(h, 'c3');
    H.ok('全自动标记没有当前任务不能替普通改动授权', blocked(commit('c3', [H.tr.user('全自动做完'), editA()])));
    H.setConfig(h, { autoMode: false });
    // 收工检查：不催它提交，催它问我
    H.write(A, 'class A { int x; }\n');
    const stop = (sid, entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, entries), stop_hook_active: false, last_assistant_message: said });
    const s1 = stop('c4', [H.tr.user('修一下 A 的空指针'), editA(), H.tr.say('修好了')], '修好了');
    H.ok('收工：改了文件没提交，催它交代了用提问框问我，不是催它提交', blocked(s1) && /提交之前要我点头/.test(H.reasonOf(s1)) && /用提问框问我提不提交/.test(H.reasonOf(s1)) && !/现在提交/.test(H.reasonOf(s1)), H.reasonOf(s1));
    const s2 = stop('c5', [H.tr.user('修一下 A 的空指针'), editA(), H.tr.say('修好了，改了 A.java 的判空。提交吗？')], '修好了，改了 A.java 的判空。提交吗？');
    H.ok('它最后那句已经在问我提不提交：放行', s2 === null, H.reasonOf(s2));
    const s3 = stop('c6', [H.tr.user('修一下 A 的空指针'), editA(), answered('改好了，提交吗？', '提交'), H.tr.say('好的')], '好的');
    H.ok('我在提问框里选了提交、它却没提交就收工：照旧催它现在提交', blocked(s3) && /现在提交/.test(H.reasonOf(s3)), H.reasonOf(s3));
    const api = require(path.join(H.SRC, 'router', 'kit-api.js'));
    H.ok('开关存得进去、配置页上有', api.cleanConfig({ plainCommit: 'auto' }).plainCommit === 'auto' && api.cleanConfig({ plainCommit: 'x' }).plainCommit === 'ask' && /id="k_plainCommit"/.test(H.read(path.join(H.SRC, 'router', 'ui.html')) || ''));
    const sorted = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    H.ok('两份默认值一样，默认是先问我', sorted(api.DEFAULT_CONFIG) === sorted(S.DEFAULT_CONFIG) && S.DEFAULT_CONFIG.plainCommit === 'ask');
  }

  // ---------------------------------------------------------------------------------------------
  H.section('全自动只管 apply：写提案那一段照常问我，说了开工才算；开工时告诉我全自动开没开');
  {
    const h = H.makeHome('t1008-flow', null, Object.assign({ autoMode: true }, QUIET));
    const proj = H.makeRepo(path.join(h.work, 'erp'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n',
      'openspec/changes/add-y/tasks.md': '- [ ] 1.1 改 src/A.java；验：mvn -q compile\n',
      'openspec/changes/going-z/tasks.md': '- [x] 1.1 改 src/A.java；验：mvn -q compile\n- [ ] 1.2 改 src/A.java；验：mvn -q compile\n' });
    const tf = H.transcript(path.join(h.root, 'f.jsonl'), [H.tr.user('开始')]);
    const say = (sid, prompt) => { const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    const flow = (sid) => readJson(path.join(h.kit, 'state', sid + '-flow.json'));
    const ask = (sid) => H.hook(h, 'guard-ask', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '导出用哪种格式？', options: [{ label: 'csv' }, { label: 'xlsx' }] }] } });
    const skill = (sid, name) => H.hook(h, 'guard-ask', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: name } });
    const r1 = say('p1', '做一个导出订单的功能');
    H.ok('提了需求：在流程里，写提案那一段', flow('p1').on === true && flow('p1').stage === 'plan', flow('p1'));
    H.ok('需求提醒照有人在的说法，加一句全自动只管 apply 之后', /我确认了范围再 \/opsx:propose/.test(r1) && /全自动模式只管 apply 之后/.test(r1) && !/不用等我确认/.test(r1), r1);
    H.ok('写提案那一段：提问框能用（全自动不算数）', ask('p1') === null, ask('p1'));
    say('p2', '/opsx:propose add-y');
    H.ok('敲 /opsx:propose：写提案那一段', flow('p2').stage === 'plan', flow('p2'));
    const r2 = say('p1', '提案看过了，开工');
    H.ok('说了"开工"：做任务那一段', flow('p1').stage === 'apply', flow('p1'));
    H.ok('开工那一句：给我看的 systemMessage 说全自动开着，给模型的提醒也说了', /"systemMessage":"\[vibe-kit\] 开始 apply：全自动模式开着/.test(r2) && /现在开始 apply（做任务）：全自动模式开着/.test(r2), r2);
    H.ok('做任务那一段：提问框拦下', blocked(ask('p1')) && /全自动模式/.test(H.reasonOf(ask('p1'))));
    const r3 = say('p1', '继续');
    H.ok('说"继续"：还在做任务那一段，不再说一遍开工', flow('p1').stage === 'apply' && !/开始 apply/.test(r3), [flow('p1'), r3]);
    say('p1', '这个字段为什么这么写？');
    H.ok('问句：出了流程，记着的段不变', flow('p1').on === false && flow('p1').stage === 'apply', flow('p1'));
    say('p1', '继续');
    H.ok('"继续"接回去：还是做任务那一段', flow('p1').on === true && flow('p1').stage === 'apply', flow('p1'));
    say('p1', '提案里 X 不对，改一下');
    H.ok('说的是提案的事：回到写提案那一段，提问框又能用了', flow('p1').stage === 'plan' && ask('p1') === null, flow('p1'));
    say('p1', '把 1.1 做了');
    H.ok('"把 1.1 做了"：做任务那一段', flow('p1').stage === 'apply', flow('p1'));
    const r4 = say('p3', '/opsx:apply add-y');
    H.ok('敲 /opsx:apply：做任务那一段，告诉我全自动开着', flow('p3').stage === 'apply' && /开始 apply：全自动模式开着/.test(r4), r4);
    const r5 = say('p4', '接着做 going-z');
    H.ok('点名接着做一个已经打过勾的变更：做任务那一段，也告诉我', flow('p4').stage === 'apply' && /开始 apply：全自动模式开着/.test(r5), [flow('p4'), r5]);
    say('p5', 'add-y 的提案改一下，去掉导出');
    H.ok('点名一个没开工的变更、说的是提案：写提案那一段', flow('p5').on === true && flow('p5').stage === 'plan', flow('p5'));
    say('p6', '归档 going-z');
    H.ok('点名让它归档：不当成开工（不说"开始 apply"）', flow('p6').on === true && !/开始 apply/.test(say('p6', '归档 going-z')), flow('p6'));
    H.setConfig(h, { autoMode: false });
    const r6 = say('p7', '/opsx:apply add-y');
    H.ok('全自动关着时敲 /opsx:apply：告诉我关着', /开始 apply：全自动模式关着/.test(r6) && /现在开始 apply（做任务）：全自动模式关着/.test(r6), r6);
    H.setConfig(h, { autoMode: true });
    // 模型自己调 /opsx:apply 的技能：没说开工就拦
    const k1 = skill('p2', 'opsx:apply');
    H.ok('写提案那一段它自己调 /opsx:apply：拦下，让它把提案交代给我、问能不能开工', blocked(k1) && /还没到 apply/.test(H.reasonOf(k1)) && /用提问框问我能不能开工/.test(H.reasonOf(k1)), H.reasonOf(k1));
    H.ok('不在流程里的会话调 /opsx:apply：也拦', blocked(skill('p8', 'opsx:apply')));
    H.ok('做任务那一段调 /opsx:apply：放行', skill('p3', 'opsx:apply') === null);
    H.ok('做任务那一段它去调 /opsx:propose（下一个变更）：回到写提案那一段', skill('p3', 'opsx:propose') === null && flow('p3').stage === 'plan', flow('p3'));
    // 写提案那一段打勾：拦
    const tasksY = path.join(proj, 'openspec', 'changes', 'add-y', 'tasks.md');
    const tfTick = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('/opsx:propose add-y'), H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q compile' }, 'ok')]);
    const tick = (sid) => H.hook(h, 'pre-edit', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: tasksY, old_string: '- [ ] 1.1', new_string: '- [x] 1.1' }, transcript_path: tfTick });
    markProposalReviewed(h, path.join(proj, 'openspec', 'changes', 'add-y'));
    const t1 = tick('p2');
    H.ok('写提案那一段打勾：拦下，说我还没说开工', blocked(t1) && /我还没说开工/.test(H.reasonOf(t1)) && !/还没看到它成功跑过/.test(H.reasonOf(t1)), H.reasonOf(t1));
    say('p2', '开工');
    H.ok('说了开工再打勾：放行', tick('p2') === null, H.reasonOf(tick('p2')));
    // 做完的功能上发现的问题：先查清原因，改动小直接改，不要起一整条流程
    const r7 = say('p11', '我自测的时候发现两个弹窗的顺序反了，应该只改前端');
    H.ok('自测发现的问题（变更还没归档）：提醒先查清原因、改动小直接改、简单审一下，不当成需求', /这像是在做完的功能上发现的问题（变更还没归档）/.test(r7) && /三个文件以内/.test(r7) && /简单审一下/.test(r7) && !/这像一条需求/.test(r7), r7);
    const tfBug = H.transcript(path.join(h.root, 'b.jsonl'), [H.tr.user('我自测的时候发现两个弹窗的顺序反了，应该只改前端'), H.tr.ran('Read', { file_path: path.join(proj, 'src', 'A.java') }, 'class A {}')]);
    const propose = (tfile) => H.hook(h, 'pre-edit', { session_id: 'p11', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, 'openspec', 'changes', 'fix-popup', 'proposal.md'), content: '## Why\n\n弹窗顺序反了。\n' }, transcript_path: tfile });
    const b1 = propose(tfBug);
    H.ok('它却要新建提案：拦下，让它先查清原因、改动小直接改', blocked(b1) && /先别新建变更/.test(H.reasonOf(b1)) && /三个文件以内/.test(H.reasonOf(b1)), H.reasonOf(b1));
    const tfGo = H.transcript(path.join(h.root, 'b2.jsonl'), [H.tr.user('我自测的时候发现两个弹窗的顺序反了'), H.tr.say('要改接口，建议走提案'), H.tr.user('那就走提案'), H.tr.ran('Read', { file_path: path.join(proj, 'src', 'A.java') }, 'class A {}')]);
    H.ok('我说了走提案：这一道不拦', !/先别新建变更/.test(H.reasonOf(propose(tfGo))), H.reasonOf(propose(tfGo)));
    fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive', '2026-10-01-old-x'), { recursive: true });
    H.write(path.join(proj, 'openspec', 'changes', 'archive', '2026-10-01-old-x', 'tasks.md'), '- [x] 1.1 改 src/A.java；验：人工看\n');
    const r8 = say('p12', '测试发现导出报错了');
    H.ok('项目里有归档过的变更：先溯源，再按改动大小定', /先溯源/.test(r8) && /trace\.js/.test(r8) && /三个文件以内/.test(r8), r8);
    H.ok('明说要走提案的不提醒', !/做完的功能上发现的问题/.test(say('p13', '测试发现导出报错了，这个要改接口，走提案')));
    // 收工检查里的兜底：这一轮它自己调了技能
    const stop = (sid, entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(path.join(h.root, 's.jsonl'), entries), stop_hook_active: false, last_assistant_message: said });
    stop('p9', [H.tr.user('出个提案'), H.tr.ran('Skill', { skill: 'opsx:propose' }, 'ok'), H.tr.say('提案写好了')], '提案写好了');
    H.ok('收工时发现它调了 /opsx:propose：记成写提案那一段', flow('p9').on === true && flow('p9').stage === 'plan', flow('p9'));
    stop('p10', [H.tr.user('做吧'), H.tr.ran('Skill', { skill: 'opsx:apply' }, 'ok'), H.tr.say('做完了')], '做完了');
    H.ok('收工时发现它调了 /opsx:apply：记成做任务那一段', flow('p10').on === true && flow('p10').stage === 'apply', flow('p10'));
    // 状态栏
    const sl = (sid) => { const r = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: sid, cwd: proj, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: proj }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: proj }); return r.out.replace(/\x1b\[[0-9;]*m/g, ''); };
    H.ok('状态栏：写提案那一段写明"还在写提案，照常"', /全自动 开·这个会话在流程里，还在写提案，照常/.test(sl('p9')), sl('p9'));
    H.ok('状态栏：做任务那一段写明"在做任务"', /全自动 开·这个会话在流程里，在做任务/.test(sl('p10')), sl('p10'));
    // 约定的文字
    const gen = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
    H.ok('全自动那一节：只管做任务那一段，不归档', gen.code === 0 && /这一节只管做 OpenSpec 变更的任务那一段/.test(md) && /不归档：归档要我自测过、说了才做/.test(md) && /> 全自动模式开着：做 OpenSpec 变更的任务的时候/.test(md) && !/探索 → 提案 → 审提案 → apply/.test(md), md.slice(0, 300));
    H.ok('提交那一节：不走 OpenSpec 的改动先问我；OpenSpec 的变更按档位', /不走 OpenSpec 的改动（修 bug、改配置、改文案）：改完、验证过/.test(md) && /用提问框问我提不提交/.test(md) && /OpenSpec 的变更：一项任务（最小的一件事）完成了就直接提交/.test(md), md.slice(0, 300));
    H.ok('OpenSpec 规范：提案给我看、说了开工才 apply；我没说归档不让归档', /我说开工才 apply/.test(md) && /我没说归档的也不让/.test(md), md.slice(0, 300));
    H.setConfig(h, { plainCommit: 'auto' });
    H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    H.ok('开关选"直接提交"时约定也跟着改', /不走 OpenSpec 的改动（修 bug、改配置、改文案）：做完、验证过[^\n]*就直接提交，不用等我说/.test(H.read(path.join(h.cfg, 'CLAUDE.md')) || ''));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('审查过程不进提交：提案审完询问提交，审查未收尾不催提交');
  {
    const h = H.makeHome('t1008-rev', null, { autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', specGate: false, reviewLoop: true, reviewMaxRounds: 3 });
    const proj = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n', 'openspec/changes/add-x/tasks.md': '- [ ] 1.1 改 src/A.java；验：mvn -q compile\n' });
    const chg = path.join(proj, 'openspec', 'changes', 'add-x');
    const tf = path.join(h.root, 'r.jsonl');
    const stop = (sid, entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, entries), stop_hook_active: false, last_assistant_message: said });
    // 提案阶段：写了提案（新文件，没进 git），不催提交、也不催"新建的文件还没进 git"
    H.write(path.join(chg, 'proposal.md'), '## Why\n\n要导出。\n');
    const r1 = stop('v1', [H.tr.user('/opsx:propose add-x'), H.tr.ran('Write', { file_path: path.join(chg, 'proposal.md'), content: '## Why\n\n要导出。\n' }, 'ok'), H.tr.say('提案写好了')], '提案写好了');
    H.ok('提案阶段写了提案：不催提交（审完、说了开工再一起提交）', !/还没提交/.test(H.reasonOf(r1)) && !/还没进 git/.test(H.reasonOf(r1)), H.reasonOf(r1));
    // 开工了（打过勾）、代码审查报了问题还没复审到 0 条：改了代码也先不催提交
    fs.writeFileSync(path.join(chg, 'tasks.md'), '- [x] 1.1 改 src/A.java；验：mvn -q compile\n');
    H.write(path.join(proj, 'src', 'A.java'), 'class A { int x; }\n');
    const editA = H.tr.ran('Edit', { file_path: path.join(proj, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' }, 'ok');
    const rounds = (done) => fs.writeFileSync(path.join(h.kit, 'state', 'review-rounds.json'), JSON.stringify({ ['code|' + S.normKey(chg)]: { rounds: 1, seen: ['toolu_r1'], done, issues: 1, pendingFix: !done, at: Date.now() - 60000, born: S.changeBorn(chg) } }));
    rounds(false);
    const r2 = stop('v2', [H.tr.user('把 add-x 审出来的问题改了'), editA, H.tr.say('改好了')], '改好了');
    H.ok('审查没审完（报了问题、还没复审到 0 条）：改了代码不催提交', !/还没提交/.test(H.reasonOf(r2)), H.reasonOf(r2));
    rounds(true);
    const r3 = stop('v2', [H.tr.user('把 add-x 审出来的问题改了'), editA, H.tr.say('改好了')], '改好了');
    H.ok('审完了：照旧催提交', !!r3 && /还没提交/.test(H.reasonOf(r3)), H.reasonOf(r3));
    // 开工那一句：先把提案的产物提交一次
    const say = (sid, prompt, cfgPatch) => { if (cfgPatch) H.setConfig(h, cfgPatch); const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    H.ok('说了开工：提醒它开工前先把 proposal、specs、design、tasks、revisions 提交一次', /开工前先把这个变更的 proposal、specs、design、tasks、revisions 提交一次/.test(say('v3', '提案看过了，开工 add-x')), say('v3', '开工 add-x'));
    H.ok('"我说了才提交"那一档：不提', !/开工前先把/.test(say('v4', '开工 add-x', { autoCommit: 'off' })));
    H.setConfig(h, { autoCommit: 'task' });
    H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
    H.ok('规范里写的提交节奏：提案审完单独问，审查修复全部轮次收尾后提交', /提案写完、审完、修完后交代要点，先问我是否提交/.test(md) && /提交不等于同意开工/.test(md) && /不一轮一提交/.test(md), md.slice(0, 200));
    H.ok('交叉审查的技能也改了说法', /非 OpenSpec 的改动仍先问用户，不审一轮提交一轮/.test(H.read(path.join(h.cfg, 'skills', 'ttls-cross-review', 'SKILL.md')) || ''));
    // 打勾不攒：它说"攒着等提交时一起勾"，拦下让它现在勾（用户反馈：按阶段提交那一版之后它连勾都不打了）
    const later = '1.2 做完了，验证过了。打勾攒着等这一阶段提交时一起勾。';
    const r4 = stop('v5', [H.tr.user('接着做 add-x 的 1.2'), editA, H.tr.say(later)], later);
    H.ok('它说攒着打勾：拦下，让它现在勾', blocked(r4) && /打勾不攒/.test(H.reasonOf(r4)), H.reasonOf(r4));
    const fine = '1.2 做完了，勾也打上了，不攒着打勾。';
    const r5 = stop('v6', [H.tr.user('接着做'), H.tr.say(fine)], fine);
    H.ok('说的是"不攒着打勾"：不拦', !/打勾不攒/.test(H.reasonOf(r5)), H.reasonOf(r5));
    H.ok('OpenSpec 规范写明做完一项勾一项、打勾不攒', /做完一项勾一项，不攒到提交时一起勾/.test(md), md.slice(0, 200));
    H.setConfig(h, { autoCommit: 'phase' });
    H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root, timeout: 60000 });
    const mdp = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
    H.ok('按阶段提交那一档的约定写明打勾不攒', /打勾不攒：每项任务做完、验法跑过就勾/.test(mdp) && /一组做到一半不提交（打勾不攒，做完一项勾一项）/.test(mdp), mdp.slice(0, 200));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('归档之后出流程；审查者只读不跑编译，使用情况里记审查耗时');
  {
    const h = H.makeHome('t1008-done', null, Object.assign({ autoMode: true }, QUIET));
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n', 'openspec/changes/done-y/tasks.md': '- [x] 1.1 改 src/A.java；验：mvn -q compile\n' });
    const chg = path.join(proj, 'openspec', 'changes', 'done-y');
    const sid = 'd1';
    H.inFlow(h, sid, [chg], true, 'apply');
    const tf = path.join(h.root, 'd.jsonl');
    const sl = () => { const r = H.node(h, path.join(h.kit, 'statusline.js'), [], { input: JSON.stringify({ session_id: sid, cwd: proj, model: { display_name: 'Qwen3' }, version: '2.1.259', workspace: { current_dir: proj }, context_window: { context_window_size: 1000000, used_percentage: 30, current_usage: { input_tokens: 300000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), cwd: proj }); return r.out.replace(/\x1b\[[0-9;]*m/g, ''); };
    H.ok('变更还在：状态栏说在做任务', /在流程里，在做任务/.test(sl()), sl());
    fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true });
    fs.renameSync(chg, path.join(proj, 'openspec', 'changes', 'archive', '2026-10-07-done-y'));
    H.ok('变更归档了、收工检查还没跑：状态栏就说归档了，照常', /这个会话的变更归档了，照常/.test(sl()) && !/在做任务/.test(sl()), sl());
    H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, [H.tr.user('归档'), H.tr.ran('Bash', { command: 'openspec archive done-y --yes' }, 'ok'), H.tr.say('归档好了')]), stop_hook_active: false, last_assistant_message: '归档好了' });
    const flow = () => readJson(path.join(h.kit, 'state', sid + '-flow.json'));
    H.ok('收工时记成不在流程里', flow().on === false && /归档/.test(flow().why), flow());
    H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: '继续', transcript_path: tf });
    H.ok('再说"继续"不接回去', flow().on === false, flow());
    H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt: '/opsx:propose add-z', transcript_path: tf });
    H.ok('敲 /opsx:propose 照样进流程（写提案那一段）', flow().on === true && flow().stage === 'plan', flow());
    // 审查者的说法
    const agent = H.read(path.join(h.cfg, 'agents', 'ttls-reviewer.md')) || '';
    H.ok('审查者：不编译、不跑测试，最多读 20 个文件', /不编译、不跑测试、不起服务/.test(agent) && /最多读 20 个文件/.test(agent) && !/能跑的就跑/.test(agent), agent.slice(0, 200));
    const skill = H.read(path.join(h.cfg, 'skills', 'ttls-cross-review', 'SKILL.md')) || '';
    H.ok('技能：验证结果贴给它，它不自己跑；只核实会出错、有隐患的；写了慢的时候看哪里', /它不自己编译、不跑测试/.test(skill) && /只核实"会出错""有隐患"的/.test(skill) && /## 审查慢的时候看哪里/.test(skill), skill.slice(0, 200));
    // 审查耗时：一次审查从调用到结论 3 分钟
    const chg2 = path.join(proj, 'openspec', 'changes', 'add-z');
    H.write(path.join(chg2, 'tasks.md'), '- [x] 1.1 改 src/A.java；验：mvn -q compile\n');
    const t0 = Date.now() - 600000;
    const call = Object.assign(H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt: '模式：代码\n变更：openspec/changes/add-z/\n材料…' }, 'toolu_rev1'), { timestamp: new Date(t0).toISOString() });
    const res = Object.assign(H.tr.result('toolu_rev1', '审完了。\n结论：问题 0 条'), { timestamp: new Date(t0 + 180000).toISOString() });
    H.hook(h, 'verify-gate', { session_id: 'd2', cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, [H.tr.user('审一下 add-z 的代码'), call, res, H.tr.say('审完了，0 条')]), stop_hook_active: false, last_assistant_message: '审完了，0 条' });
    const days = readJson(path.join(h.kit, 'state', 'usage.json')).days || {};
    const sum = (k) => Object.values(days).reduce((a, d) => a + Number((d.n || {})[k] || 0), 0);
    H.ok('使用情况里记了这次审查的耗时（3 分钟）', sum('review.code') === 1 && sum('review.ms') >= 179000 && sum('review.ms') <= 181000, days);
    const U = require(path.join(h.kit, 'lib', 'usage.js'));
    const rows = U.render ? '' : '';
    void rows;
    const text = JSON.stringify(Object.values(days));
    H.ok('（记在当天的 n 里）', /review\.ms/.test(text), text.slice(0, 200));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('交接："不问"只提醒一句，不让它自己写交接记录');
  {
    const h = H.makeHome('t1008-ho', null, Object.assign({ handoverAsk: 'off', handoverPercent: 70 }, QUIET));
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    const tf = H.transcript(path.join(h.root, 'h.jsonl'), [H.tr.user('开始')]);
    const sid = 'ho1';
    // 状态栏记下的用量：过了交接线
    fs.writeFileSync(path.join(h.kit, 'state', sid + '.json'), JSON.stringify({ pct: 80, used: 800000, size: 1000000, windowSize: 1000000, at: Date.now() }));
    const say = (prompt) => { const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    const r1 = say('把 A 的判空改一下');
    H.ok('选了"不问"：只提醒过线，说清我没让交接就不要交接', /过了公司规定的交接线/.test(r1) && /我没让你交接就不要交接/.test(r1) && !/就执行 \/ttls-handover 写交接记录/.test(r1), r1);
    const stop = H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tf, [H.tr.user('把 A 的判空改一下'), H.tr.say('改好了')]), stop_hook_active: false, last_assistant_message: '改好了' });
    H.ok('收工时也不问、不让它交接', !/交接/.test(H.reasonOf(stop)), H.reasonOf(stop));
    H.setConfig(h, { handoverAsk: 'ask' });
    const r2 = say('再改一下');
    H.ok('选"问我"：照旧说收工时会用提问框问', /收工时会让你用提问框问我要不要交接/.test(r2), r2);
    H.ok('配置页上"不问"那一项写明了只提醒、我说交接才交接', /不问，只提醒；我说交接才交接/.test(H.read(path.join(H.SRC, 'router', 'ui.html')) || ''));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('2026-10-07 第二批');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

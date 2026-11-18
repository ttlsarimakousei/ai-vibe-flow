'use strict';
/*
 * 11-17 导出议题（docs/feedback-20261117.md），仓库主人同一天定的三件事：
 *   起服务不拦（#475、#482）：devserver start、spring-boot:run 这类只起服务的命令，用户没说也直接跑；跑测试照旧先问
 *   关服务要问：devserver.js stop 用户这一轮没说关，人工弹确认框，全自动拦下、服务留着；说了关（原话、提问框）直接停；stop 再 start 是重启，不管
 *   状态栏第三行改成在跑的服务（在 test-statusline-bar.js）
 * 用法：node dev/test-feedback1117.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off' };

(async () => {
  const watch = await H.watchWindows('f1117-win');
  const h = H.makeHome('f1117', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const p = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const tool = path.join(h.kit, 'tools', 'devserver.js').replace(/\\/g, '/');
  let seq = 0;
  const tp = (entries) => H.transcript(path.join(h.root, 'tr-' + (++seq) + '.jsonl'), entries);
  const bash = (sid, entries, command) => H.hook(h, 'guard-commit', { session_id: sid, hook_event_name: 'PreToolUse', cwd: p, transcript_path: tp(entries), tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-' + (++seq) });
  const decisionOf = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision) || (o && o.decision) || '';
  const reason = (o) => H.reasonOf(o);

  H.section('起服务不拦（#475、#482）');
  const start = 'node "' + tool + '" start --name backend --port 30010 -- mvn spring-boot:run';
  for (const said of ['你先启动后端+2个前端,我看看值班模块', '项目帮我重新启动过了吗,我要看了', '看看这个类是干什么的']) {
    const r = bash('s-start', [H.tr.user(said)], start);
    H.ok('说"' + said + '"：devserver start 不拦', !reason(r), reason(r));
  }
  const q = { questions: [{ question: '要不要起后端？', header: '起服务', multiSelect: false, options: [{ label: '起（backend）', description: '' }, { label: '不用', description: '' }] }] };
  const r475 = bash('s-475', [H.tr.user('项目帮我重新启动过了吗,我要看了'), ...H.tr.ran('AskUserQuestion', q, 'User has answered your questions: "要不要起后端？"="起（backend）".')], start);
  H.ok('#475 原样：提问框选了"起（backend）"之后起服务不拦', !reason(r475), reason(r475));
  const t = reason(bash('s-test', [H.tr.user('看看这个类是干什么的')], 'mvn test'));
  H.ok('跑测试照旧先问', /先用 Ask 询问是否自测或复验及范围/.test(t), t);

  H.section('关服务要用户点头');
  const stopAll = 'node "' + tool + '" stop --all';
  const r1 = bash('s-stop1', [H.tr.user('搜索按钮靠右'), H.tr.say('改好了，测过了')], stopAll);
  H.ok('用户没说关：弹确认框问', decisionOf(r1) === 'ask' && /\[vibe-kit 关服务\] 这条命令会停掉所有自己起的服务/.test(reason(r1)), r1);
  const r2 = bash('s-stop2', [H.tr.user('搜索按钮靠右')], 'node "' + tool + '" stop --name backend');
  H.ok('点了名的：说停的是哪个', /停掉服务 backend/.test(reason(r2)), reason(r2));
  for (const said of ['你关闭服务，我自己启动', '把服务都停了', '后端关掉吧']) {
    const r = bash('s-stop3', [H.tr.user(said)], stopAll);
    H.ok('用户说"' + said + '"：直接停', !reason(r), r);
  }
  for (const said of ['别关服务，我还要看', '服务关了吗']) {
    const r = bash('s-stop4', [H.tr.user(said)], stopAll);
    H.ok('用户说"' + said + '"：不算要关，照样问', decisionOf(r) === 'ask', r);
  }
  const qs = { questions: [{ question: '测完了，要不要停掉起的服务？', header: '关服务', multiSelect: false, options: [{ label: '关', description: '' }, { label: '留着', description: '' }] }] };
  const r5 = bash('s-stop5', [H.tr.user('改一下按钮'), ...H.tr.ran('AskUserQuestion', qs, 'User has answered your questions: "测完了，要不要停掉起的服务？"="关".')], stopAll);
  H.ok('提问框问关服务、选了"关"：直接停', !reason(r5), r5);
  const r6 = bash('s-stop6', [H.tr.user('改一下按钮'), ...H.tr.ran('AskUserQuestion', qs, 'User has answered your questions: "测完了，要不要停掉起的服务？"="留着".')], stopAll);
  H.ok('选了"留着"：照样问', decisionOf(r6) === 'ask', r6);
  const r7 = bash('s-stop7', [H.tr.user('改一下按钮')], 'node "' + tool + '" stop --name backend && ' + start);
  H.ok('stop 再 start 是重启：不管', !reason(r7), r7);
  const rp = H.hook(h, 'guard-commit', { session_id: 's-stopps', hook_event_name: 'PreToolUse', cwd: p, transcript_path: tp([H.tr.user('改一下按钮')]), tool_name: 'PowerShell', tool_input: { command: '& node "' + tool + '" stop --all' }, tool_use_id: 'tu-ps1' });
  H.ok('PowerShell 的 & node … stop 也认得：问', decisionOf(rp) === 'ask', rp);
  const rb = bash('s-stopb', [H.tr.user('改一下按钮')], "bash -c 'node \"" + tool + "\" stop --all'");
  H.ok('套在 bash -c 里的也认得：问（复审 R2）', decisionOf(rb) === 'ask', rb);
  const rm = bash('s-stopm', [H.tr.user('改一下按钮')], 'git commit -m "docs: 写明怎么用 node devserver.js stop"');
  H.ok('提交信息里提到 devserver stop：不算关服务', !/关服务/.test(reason(rm)), reason(rm));
  for (const said of ['关服务', '重启后端', '可以关了']) {
    const r = bash('s-stop9', [H.tr.user(said)], stopAll);
    H.ok('用户说"' + said + '"：直接停（复审 R2）', !reason(r), r);
  }
  for (const said of ['关闭系统通知', '关闭 chrome', '关闭这个项目的警告']) {
    const r = bash('s-stop10', [H.tr.user(said)], stopAll);
    H.ok('用户说"' + said + '"：不算要关服务，照样问（复审 R2）', decisionOf(r) === 'ask', r);
  }
  const r8 = bash('s-stop8', [H.tr.user('改一下按钮')], 'node "' + tool + '" status');
  H.ok('status 不管', !reason(r8), r8);

  H.section('全自动：拦下，服务留着');
  const ja = { session_id: 's-auto', cwd: p };
  H.inFlow(h, 's-auto', [], true, 'apply');
  S.setSessionAuto(ja, true, '提问框选了自动');
  const auto = S.readConfigFor(ja).autoMode === true;
  H.ok('夹具：这个会话的自动在生效', auto, S.readConfigFor(ja));
  if (auto) {
    const ra = bash('s-auto', [H.tr.user('开工')], stopAll);
    H.ok('全自动没人点：拦下，交代里写在跑的服务', decisionOf(ra) === 'deny' && /全自动：用户没说要关服务[\s\S]*留着不停[\s\S]*哪些服务在跑、端口/.test(reason(ra)), ra);
  }

  H.section('询问超时：关服务的确认框到点按不允许');
  const hookFile = path.join(h.kit, 'hooks', 'ask-timeout.js');
  const run = (input) => new Promise((resolve) => {
    const c = spawn(process.execPath, [hookFile], { cwd: p, env: H.envFor(h, { VIBE_KIT_ASK_TIMEOUT_MS: '800', VIBE_KIT_ASK_POLL_MS: '150' }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (x) => { out += x; });
    const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 已经退了 */ } }, 30000);
    c.on('close', () => { clearTimeout(timer); let o = null; try { o = out.trim() ? JSON.parse(out) : null; } catch (e) { o = { raw: out }; } resolve(o); });
    c.stdin.end(JSON.stringify(Object.assign({ session_id: 's-auto', cwd: p, hook_event_name: 'PermissionRequest', permission_mode: 'default' }, input)));
  });
  if (auto) {
    const ci = { command: stopAll, description: '停服务' };
    const o = await run({ tool_name: 'Bash', tool_input: ci, transcript_path: tp([H.tr.user('开工'), H.tr.call('Bash', ci, 'toolu_stop')]) });
    const d = (o && o.hookSpecificOutput && o.hookSpecificOutput.decision) || {};
    H.ok('到点按不允许，服务留着', d.behavior === 'deny' && /服务留着/.test(d.message || ''), o);
  }

  H.section('#472：提交后面跟着"不要推送"不算否定提交');
  const I = require(path.join(h.kit, 'lib', 'intent.js'));
  for (const s of ['git commit 不要 push', '只 git commit，不要 push', '提交，先别推送', '只提交不推送', '分功能提交代码'])
    H.ok('"' + s + '"：算让提交', I.explicit(s, 'commit') === true);
  for (const s of ['先别提交', '提交先别急', '提交前我再看看', '提交了吗'])
    H.ok('"' + s + '"：不算', I.explicit(s, 'commit') === false);
  H.ok('"git commit 不要 push"：不算让推送', I.explicit('git commit 不要 push', 'push') === false);
  H.ok('推送、归档没跟着放宽："归档先别推送"照旧不算让归档', I.explicit('归档先别推送', 'archive') === false);

  H.section('#477：提问框问"在页面上量一下"答不用，算不测');
  const q477 = { questions: [{ question: '要不要在你起的 3001 页面上量一下实际位置和个数？', header: '量一下', multiSelect: false, options: [{ label: '量', description: '' }, { label: '不用', description: '' }] }] };
  const es = [H.tr.user('搜索按钮靠右、操作按钮一行 8 个'), ...H.tr.ran('AskUserQuestion', q477, 'User has answered your questions: "要不要在你起的 3001 页面上量一下实际位置和个数？"="不用".')];
  H.ok('userDeclined(test) 认出来了', !!S.userDeclined(es.flat(), 'test'));

  H.section('#468、#470、#471、#473：壳子根跑的验证命令只算这个会话改过的仓库');
  {
    const E = require(path.join(h.kit, 'lib', 'evidence.js'));
    const shell = H.makeRepo(path.join(h.work, 'shell'), { 'README.md': '# 壳子\n', '.gitignore': '.vibe/\napi/\nweb/\nmq/\n', 'openspec/plan.md': '# 计划\n' });
    const api = H.makeRepo(path.join(shell, 'api'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    const web = H.makeRepo(path.join(shell, 'web'), { 'package.json': '{"name":"web"}\n', 'src/a.js': '1\n' });
    H.makeRepo(path.join(shell, 'mq'), { 'pom.xml': '<project/>\n', 'src/M.java': 'class M {}\n' });
    H.ok('前提：认得出是壳子', S.isShell(shell) === true && S.nestedRepos(shell).length === 3);
    const ed = { file_path: path.join(api, 'src', 'A.java'), old_string: 'class A {}', new_string: 'class A { int x; }' };
    H.write(path.join(api, 'src', 'A.java'), 'class A { int x; }\n');
    const before = (S.readState('evidence').rows || []).length;
    H.hook(h, 'after-tool', { session_id: 's-ev', cwd: shell, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-ev1', tool_input: { command: 'mvn -q -o test' }, tool_response: { stdout: 'BUILD SUCCESS', stderr: '', interrupted: false }, transcript_path: tp([H.tr.user('改一下 A'), ...H.tr.ran('Edit', ed, 'ok'), H.tr.say('跑测试')]) });
    const rows = (S.readState('evidence').rows || []).slice(before);
    H.ok('只记了改过的子项目 api 一条，没算 web、mq', rows.length === 1 && path.basename(rows[0].root) === 'api', rows.map((r) => r.root));
    H.ok('从子项目 api、从壳子根都看得到', E.commands(api).length === 1 && E.commands(shell).length >= 1);
    H.write(path.join(web, 'src', 'a.js'), '2\n');
    H.ok('别的子项目改了：api 的证据照样算', E.commands(api).length === 1);
    H.write(path.join(api, 'src', 'A.java'), 'class A { int y; }\n');
    H.ok('api 又改了：它的证据不算了', E.commands(api).length === 0);
    // 复审 R1：一条命令改过两个子项目，后来改了其中一个，从壳子根看那条命令不算了
    const ed2 = { file_path: path.join(web, 'src', 'a.js'), old_string: '2', new_string: '3' };
    H.write(path.join(web, 'src', 'a.js'), '3\n');
    const b3 = (S.readState('evidence').rows || []).length;
    H.hook(h, 'after-tool', { session_id: 's-ev3', cwd: shell, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-ev3', tool_input: { command: 'mvn -q -o verify' }, tool_response: { stdout: 'BUILD SUCCESS', stderr: '', interrupted: false }, transcript_path: tp([H.tr.user('改 A 和前端'), ...H.tr.ran('Edit', ed, 'ok'), ...H.tr.ran('Edit', ed2, 'ok'), H.tr.say('跑测试')]) });
    const r3 = (S.readState('evidence').rows || []).slice(b3);
    H.ok('改过 api、web：各记一条，同一个 cmd', r3.length === 2 && r3[0].cmd && r3[0].cmd === r3[1].cmd, r3.map((r) => r.root));
    H.ok('都没再改：壳子根看得到这条命令', E.commands(shell).includes('mvn -q -o verify'));
    H.write(path.join(web, 'src', 'a.js'), '4\n');
    H.ok('web 又改了：从壳子根看这条命令整条不算（api 那条不能单独顶着）', !E.commands(shell).includes('mvn -q -o verify'), E.commands(shell));
    const b2 = (S.readState('evidence').rows || []).length;
    H.hook(h, 'after-tool', { session_id: 's-ev2', cwd: shell, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-ev2', tool_input: { command: 'mvn -q -o test' }, tool_response: { stdout: 'BUILD SUCCESS', stderr: '', interrupted: false }, transcript_path: tp([H.tr.user('跑一下测试')]) });
    const r2 = (S.readState('evidence').rows || []).slice(b2);
    H.ok('会话没改过子项目：照旧记壳子加全部子项目的整个指纹一条', r2.length === 1 && !r2[0].cmd && S.normKey(r2[0].root) === S.normKey(shell), r2);
    H.ok('从壳子根看得到这一条', E.commands(shell).some((c) => c === 'mvn -q -o test'));
    H.write(path.join(shell, 'mq', 'src', 'M.java'), 'class M { int z; }\n');
    H.ok('哪个子项目改了这一条都不算（复审 R1 的后半）', !E.commands(shell).some((c) => c === 'mvn -q -o test'));
  }

  H.section('#476、#478：开工兄弟壳子里的变更，那个壳子加进开工范围');
  {
    const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
    const DOC = (name) => ({ ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要做。\n', ['openspec/changes/' + name + '/tasks.md']: '## 1. 实现\n\n- [ ] 1.1 改代码\n' });
    const top = path.join(h.work, 'JSSLT');
    const gw = H.makeRepo(path.join(top, 'JWJH', 'gwjh-workspace'), Object.assign({ 'README.md': '# 壳子\n', '.gitignore': '.vibe/\ngwjh/\n' }, DOC('add-hdca-cert-gateway')));
    H.makeRepo(path.join(gw, 'gwjh'), { 'pom.xml': '<project/>\n', 'src/G.java': 'class G {}\n' });
    const oa = H.makeRepo(path.join(top, 'OA', 'oa-workspace'), Object.assign({ 'README.md': '# 壳子\n', '.gitignore': '.vibe/\noa/\n' }, DOC('add-ec-cert-city-issue')));
    const oaCode = H.makeRepo(path.join(oa, 'oa'), { 'pom.xml': '<project/>\n', 'src/E.java': 'class E {}\n' });
    H.ok('前提：两个都是壳子', S.isShell(gw) && S.isShell(oa));
    H.ok('当前目录下找不到 OA 的变更，兄弟壳子里找得到', !S.allChanges(gw).some((c) => c.name === 'add-ec-cert-city-issue') && S.nearChanges(gw, '开工 add-ec-cert-city-issue').length === 1);
    const jx = { session_id: 's-cross', cwd: gw, transcript_path: tp([H.tr.user('开工 add-ec-cert-city-issue')]) };
    H.inFlow(h, 's-cross', [path.join(gw, 'openspec', 'changes', 'add-hdca-cert-gateway')], true, 'apply');
    const g = A.grant(jx, '开工 add-ec-cert-city-issue', '');
    H.ok('开工认的是 OA 壳子里的变更（不是这边动过的那个）', g.ok && g.targets.includes('add-ec-cert-city-issue') && !g.targets.includes('add-hdca-cert-gateway'), g);
    const target = path.join(oaCode, 'src', 'E.java');
    H.ok('改 OA 子项目的代码：不再拦"目标项目不在当前 apply 许可里"', !/不在当前 apply 许可里/.test(A.check(jx, target) || ''), A.check(jx, target));
    const other = path.join(gw, 'gwjh', 'src', 'G.java');
    H.ok('这边没开工的子项目照样拦，提示写明怎么开工别的壳子的变更', /不在当前 apply 许可里[\s\S]*开工 <变更名>/.test(A.check(jx, other) || ''), A.check(jx, other));
    const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
    if (R.changeOf) H.ok('review --change 也认得兄弟壳子里的变更', (R.changeOf(gw, 'add-ec-cert-city-issue') || {}).name === 'add-ec-cert-city-issue');
    H.ok('不带连字符的词、不存在的名字不乱认', S.nearChanges(gw, '开工 oa 那个').length === 0 && S.nearChanges(gw, '开工 no-such-change').length === 0);
  }

  const wins = await watch.stop();
  H.ok('桌面上没有冒出窗口', !wins.length, wins);
  H.done('11-17 起服务不拦、关服务要问');
})().catch((e) => { H.ok('出错', false, e.stack); H.done('11-17'); });

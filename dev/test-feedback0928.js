'use strict';
/*
 * 内网导出的问题反馈（vibe-kit问题汇总-OFFIC-20200413X-20260928-1519.md）里的五条，照着原样复现：
 *   F001 / F002 / F003  验法写的是自己包的脚本、括号里提到"场景"，跑过了也打不上勾
 *   F004                tasks.md 里要新建的 SQL、验法里现写的脚本被说"找不到"
 *   F005                design.md 里提到这个变更要新建的文件被说"找不到"
 */
const path = require('path');
const fs = require('fs');
const H = require('./lib/harness');

const h = H.makeHome('fb0928');
const S = require(path.join(h.kit, 'lib', 'session.js'));

H.section('验法要看到什么才算跑过');
{
  const v42 = '`node .vibe/run42.js`（串跑 /see-page 两场景，两个 RESULT ok）';
  H.ok('反馈原样：跑过 run42.js 就算', S.verifyRan(v42, ['node .vibe/run42.js']));
  H.ok('串在别的命令后面也算', S.verifyRan(v42, ['node .vibe/mkstate.js && node .vibe/run42.js']));
  H.ok('反斜杠写法也算', S.verifyRan('`node .vibe\\run42.js`（两场景）', ['node .vibe/run42.js']));
  H.ok('跑的是别的脚本不算', !S.verifyRan(v42, ['node .vibe/other.js', 'git status']));
  H.ok('什么都没跑不算', !S.verifyRan(v42, []));
  const v52 = '`node .vibe/e2e52.js`（接口层场景全 PASS，E2E52_PASS）';
  H.ok('反馈原样：e2e52.js', S.verifyRan(v52, ['node .vibe/e2e52.js && node .vibe/kbtry.js revert']));
  H.ok('没加反引号、写了 node x.js 的也以脚本为准', S.verifyRan('node .vibe/run42.js 两个场景都 ok', ['node .vibe/run42.js']));
  H.ok('没加反引号、跑的是别的不算', !S.verifyRan('node .vibe/run42.js 两个场景都 ok', ['node .vibe/run43.js']));
  H.ok('只说场景的：要 scenario-run', S.verifyRan('/see-page 场景 login', ['node "C:/u/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/login.json --base http://127.0.0.1:8080']));
  // 0929 起：只说了"场景"、没说哪一个的，.vibe 里自己的验证脚本也算；项目里真有这个名字的场景文件，才要求带场景名
  H.ok('只说场景的：.vibe 里自己的脚本也算', S.verifyRan('/see-page 场景 login', ['node .vibe/run42.js']));
  H.ok('只说场景的：.vibe 外面的脚本、git 命令不算', !S.verifyRan('/see-page 场景 login', ['node scripts/build.js', 'git status']));
  const has = { scenarioExists: (n) => n === 'login' };
  H.ok('只说场景的：有这个场景文件，场景名对不上不算', !S.verifyRan('/see-page 场景 login', ['node x/scenario-run.js .vibe/scenarios/order.json'], has));
  H.ok('只说场景的：有这个场景文件，跑的就是它', S.verifyRan('/see-page 场景 login', ['node x/scenario-run.js .vibe/scenarios/login.json'], has));
  H.ok('只说场景的：没有叫这个名字的场景文件，跑过别的场景也算', S.verifyRan('/see-page 场景 login', ['node x/scenario-run.js .vibe/scenarios/order.json']));
  H.ok('反引号里是 scenario-run 命令：脚本和场景文件都要出现', S.verifyRan('`node "$HOME/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/login.json`', ['node "C:/Users/a/.claude/vibe-kit/page/scenario-run.js" .vibe/scenarios/login.json --base http://x']));
  H.ok('反引号里是 scenario-run 命令：场景文件不对不算', !S.verifyRan('`node scenario-run.js .vibe/scenarios/login.json`', ['node scenario-run.js .vibe/scenarios/order.json']));
  H.ok('反引号里是 mvn', S.verifyRan('`mvn -q -o compile`', ['JAVA_HOME="C:/jdk8" mvn -q -o compile']));
  H.ok('反引号里是 mvn：只跑了 git 不算', !S.verifyRan('`mvn -q -o compile`', ['git diff src/main/java/A.java']));
  H.ok('反引号里是 curl', S.verifyRan('`curl -s http://127.0.0.1:8080/api/x` 返回 200', ['curl -s http://127.0.0.1:8080/api/x']));
  H.ok('不加反引号的 mvn', S.verifyRan('mvn -q compile', ['cd sub && mvn -q compile']));
  H.ok('人工看页面不查', S.verifyRan('人工看页面', []));
  H.ok('一句话的验法：跑过任何验证命令就算', S.verifyRan('按项目说明的快检', ['node .vibe/quick.js']));
  H.ok('一句话的验法：没跑过验证命令不算', !S.verifyRan('按项目说明的快检', ['git status', 'ls']));
  H.ok('反引号里只是文件名不是命令：按老规矩看工具', S.verifyRan('跑 mvn 编译，`OrderService.java` 无报错', ['mvn -q compile']));
  const plan = S.verifyPlan(v42);
  H.ok('说得清要看到什么', /run42\.js/.test(plan.need), plan.need);
  H.ok('只说场景时提示可以把命令写进验法', /反引号/.test(S.verifyPlan('/see-page 场景 login').need));
}

// ---------- 钩子整体 ----------
const proj = H.makeRepo(path.join(h.work, 'src-swfg'), { 'pom.xml': '<project/>', 'src/main/java/A.java': 'class A {}\n', 'deploy/readme.txt': 'x\n' });
const chg = path.join(proj, 'openspec', 'changes', 'secflow-gate');
const sid = 'sess-fb0928';
const tfile = path.join(h.root, 'transcript.jsonl');
const base = { session_id: sid, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse' };
H.transcript(tfile, [H.tr.user('做 secflow-gate')]);
const writeTasks = (content) => H.hook(h, 'guard-spec', Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: path.join(chg, 'tasks.md'), content } }));
const writeDesign = (content) => H.hook(h, 'guard-spec', Object.assign({}, base, { tool_name: 'Write', tool_input: { file_path: path.join(chg, 'design.md'), content } }));

H.section('tasks.md：要新建的文件、验法里的脚本（F004）');
{
  const good = ['## 1. 脚本', '', '- [ ] 1.1 写预检脚本：新建 deploy/sql/secflow-gate_precheck.sql、新建 assets/q.js；验：`node openspec/changes/secflow-gate/assets/q.js` 输出 0 行',
    '- [ ] 1.2 执行预检并写 DDL：deploy/sql/secflow-gate_precheck.sql、新建 deploy/sql/secflow-gate_ddl.sql；验：node q.js 输出 0 行',
    '- [ ] 1.3 回滚脚本：编写 deploy/sql/secflow-gate_rollback.sql；验：`mvn -q -o compile`',
    '- [ ] 2.1 执行 deploy/sql/secflow-gate_ddl.sql 之后改 src/main/java/A.java；验：`mvn -q -o compile`', ''].join('\n');
  const r = writeTasks(good);
  H.ok('声明过新建的、验法里的脚本都不拦', r === null, H.reasonOf(r));
  const bad = ['- [ ] 1.1 改 src/main/java/B.java 和 src/main/java/C.java；验：`mvn -q -o compile`', ''].join('\n');
  const r2 = writeTasks(bad);
  H.ok('真找不到、也没说新建的照样拦', r2 && r2.decision === 'block', r2);
  H.ok('同一行的两个文件合成一句', (H.reasonOf(r2).match(/在项目里找不到/g) || []).length === 1 && /B\.java、src\/main\/java\/C\.java/.test(H.reasonOf(r2)), H.reasonOf(r2));
  H.ok('提示里给了照着改的例子', /例：新建 src\/main\/java\/B\.java/.test(H.reasonOf(r2)), H.reasonOf(r2));
  const onlyVerify = ['- [ ] 1.1 改 src/main/java/A.java；验：node scripts/nope.js', ''].join('\n');
  H.ok('只有验法里的脚本不存在：写任务时不拦', writeTasks(onlyVerify) === null);
}

H.section('design.md：这个变更里声明过新建的、.vibe/pending 里的（F005）');
{
  const line = '- 交付物：secflow-gate_ddl.sql、secflow-gate_precheck.sql、secflow-gate_dml.sql、secflow-gate_rollback.sql';
  const design = ['## Context', '', '- 读过 src/main/java/A.java：现在没有流程闸门', '- 读过 pom.xml', '', '## Decisions', '', line, ''].join('\n');
  const r = writeDesign(design);
  H.ok('没声明过：拦，四个文件合成一句', r && r.decision === 'block' && (H.reasonOf(r).match(/在项目里找不到/g) || []).length === 1, H.reasonOf(r));
  // tasks.md 里声明过新建三个；第四个已经写在 .vibe/pending 里（全自动模式下产出位置没定时放那里）
  H.write(path.join(chg, 'tasks.md'), ['- [ ] 1.1 新建 deploy/sql/secflow-gate_ddl.sql、deploy/sql/secflow-gate_precheck.sql、deploy/sql/secflow-gate_dml.sql；验：人工看', ''].join('\n'));
  H.write(path.join(proj, '.vibe', 'pending', 'secflow-gate_rollback.sql'), '-- rollback\n');
  const r2 = writeDesign(design);
  H.ok('tasks.md 里声明过新建 + .vibe/pending 里已有：不拦', r2 === null, H.reasonOf(r2));
  const r3 = writeDesign(design.replace(line, line + '\n- 现有逻辑在 src/main/java/Nope.java 里'));
  H.ok('想当然写的不存在的文件照样拦', r3 && /Nope\.java/.test(H.reasonOf(r3)) && !/secflow-gate_ddl/.test(H.reasonOf(r3)), H.reasonOf(r3));
  const r4 = writeDesign(design.replace(line, '- 交付物：产出 other_new.sql'));
  H.ok('"产出"也算在说新建', r4 === null, H.reasonOf(r4));
}

H.section('打勾：跑过验法里写明的脚本就能打（F001 / F002 / F003）');
{
  const chg2 = path.join(proj, 'openspec', 'changes', 'secadmin-log-split');
  const tasks = path.join(chg2, 'tasks.md');
  const t0 = ['- [x] 1.1 改 src/main/java/A.java；验：`mvn -q -o compile`',
    '- [ ] 4.2 日志页范围提示与无权限提示：src/main/java/A.java；验：`node .vibe/run42.js`（串跑 /see-page 两场景，两个 RESULT ok）',
    '- [ ] 5.2 端到端验证场景文件：新建 .vibe/scenarios/secadmin.json；验：`node .vibe/e2e52.js`（接口层场景全 PASS，E2E52_PASS）', ''].join('\n');
  H.write(tasks, t0);
  const tick = (from, to) => H.hook(h, 'guard-spec', Object.assign({}, base, { tool_name: 'Edit', tool_input: { file_path: tasks, old_string: from, new_string: to } }));
  H.transcript(tfile, [H.tr.user('继续做 secadmin-log-split，测试'), H.tr.ran('Edit', { file_path: tasks, old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  const r0 = tick('- [ ] 4.2', '- [x] 4.2');
  H.ok('没跑过验法：拦', r0 && r0.decision === 'block', r0);
  H.ok('拦的时候说清要看到什么', /要看到的是：跑过 `node \.vibe\/run42\.js`/.test(H.reasonOf(r0)), H.reasonOf(r0));
  H.transcript(tfile, [H.tr.user('继续做 secadmin-log-split，测试'), H.tr.ran('Edit', { file_path: tasks, old_string: 'a', new_string: 'b' }, 'ok'),
    H.tr.ran('Bash', { command: 'node .vibe/mkstate.js && node .vibe/run42.js' }, 'RESULT ok\nRESULT ok'), H.tr.ran('Bash', { command: 'node .vibe/e2e52.js && node .vibe/kbtry.js revert' }, 'E2E52_PASS')]);
  const r1 = tick('- [ ] 4.2', '- [x] 4.2');
  H.ok('跑过 run42.js：4.2 能打勾', r1 === null, H.reasonOf(r1));
  const r2 = tick('- [ ] 5.2', '- [x] 5.2');
  H.ok('跑过 e2e52.js：5.2 能打勾', r2 === null, H.reasonOf(r2));
  H.transcript(tfile, [H.tr.user('测试'), H.tr.ran('Edit', { file_path: tasks, old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'node .vibe/run42.js' }, 'RESULT fail', true)]);
  const r3 = tick('- [ ] 4.2', '- [x] 4.2');
  H.ok('跑了但失败的不算', r3 && r3.decision === 'block', r3);
}

H.done('内网反馈 0928 的五条');

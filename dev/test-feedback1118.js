'use strict';
/*
 * 11-18 导出议题 #483—#489 和仓库主人的三条使用体验（docs/feedback-20261118.md）：
 *   #488  壳子不是 git 仓库、代码在子仓库里：代码审查不再把壳子根算成"缺开工基线"（以前永远 partial，复审登记不上）
 *   #489  复审时上一轮审过、这一轮没进材料、文件其实还在的：不再报成"这个文件已经删除"
 *   #484  在系统临时目录里跑的编译、测试不记成项目的验证证据（不为它算子项目的指纹）
 *   #487  plan.md 的大任务里列了兄弟壳子的变更：认出那个目录，开工范围带上它
 *   #485 顺带  Bash 改 OpenSpec 的四份需求文档（sed -i、重定向、tee、Set-Content、cp、node -e 写文件）拦下，不能申请放行
 *   实施一律自动：问"能开工吗"答"可以"这类开工也开自动；点老版本"实施（每步问我）"的照旧关着
 *   提问框到点、说开工和继续直接开自动、核验期直接重开、状态栏不显示自动开关：在 test-feedback1113-2.js、test-feedback1113.js、test-auto-1112.js、test-statusline-bar.js
 * 用法：node dev/test-feedback1118.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const QUIET = { specGate: true, autoVerify: false, autoSeePage: false, lessons: 'off', autoOnboard: false, commitMode: 'off' };

(async () => {
  const watch = await H.watchWindows('f1118-win');
  const h = H.makeHome('f1118', FROM, QUIET);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  let seq = 0;
  const tp = (entries) => H.transcript(path.join(h.root, 'tr-' + (++seq) + '.jsonl'), entries);

  H.section('#488：壳子不是 git 仓库、代码在子仓库里，壳子根不算缺开工基线');
  {
    const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
    const shell = path.join(h.work, 'ly-gsml');
    H.write(path.join(shell, 'CLAUDE.md'), '# 壳子\n');
    H.write(path.join(shell, 'openspec', 'changes', 'feat-020-survey-year', 'proposal.md'), '## Why\n\n普查年度。\n\n## What Changes\n\n- 改 trees/src/A.java、app/src/B.js\n');
    H.write(path.join(shell, 'openspec', 'changes', 'feat-020-survey-year', 'tasks.md'), '## 1. 年度\n\n- [x] 1.1 改 trees/src/A.java：加年度\n- [x] 1.2 改 app/src/B.js：加年度\n');
    const g1 = H.makeRepo(path.join(shell, 'trees'), { 'src/A.java': 'class A {}\n' });
    const g2 = H.makeRepo(path.join(shell, 'app'), { 'src/B.js': 'b\n' });
    const b1 = H.git(g1, ['rev-parse', '--short', 'HEAD']).out.trim(); const b2 = H.git(g2, ['rev-parse', '--short', 'HEAD']).out.trim();
    H.write(path.join(g1, 'src', 'A.java'), 'class A { int year; }\n'); H.write(path.join(g2, 'src', 'B.js'), 'b2\n');
    H.ok('前提：壳子不是 git 仓库，下面两个子仓库', !fs.existsSync(path.join(shell, '.git')) && S.nestedRepos(shell).length === 2);
    const change = S.allChanges(shell).find((c) => c.name === 'feat-020-survey-year');
    let m = null; let err = '';
    try { m = R.materials({ cwd: shell, mode: 'code', point: 'change', base: ['trees=' + b1, 'app=' + b2] }, change); } catch (e) { err = e.message; }
    H.ok('两个子仓库的 --base 都给了：壳子根不进"缺开工基线"，材料完整（since 20261119.0611）', !!m && !m.skipped.some((x) => /缺开工基线/.test(x.reason)), err || (m && m.skipped));
    H.ok('两个子仓库的改动都在材料里', !!m && m.items.some((x) => /trees\/src\/A\.java$/.test(x.file)) && m.items.some((x) => /app\/src\/B\.js$/.test(x.file)), m && m.items.map((x) => x.file));
    H.ok('排除说明里写明壳子不是 git 仓库、按子项目审', !!m && m.excluded.some((x) => /壳子不是 git 仓库/.test(x.reason || '')), m && m.excluded);
    let m2 = null; err = '';
    try { m2 = R.materials({ cwd: shell, mode: 'code', point: 'change', base: ['trees=' + b1] }, change); } catch (e) { err = e.message; }
    const miss = m2 ? m2.skipped.filter((x) => /缺开工基线/.test(x.reason)) : [];
    H.ok('只给了一个子仓库的基线：缺的是另一个子仓库，不是壳子根；提示里不让给壳子写 --base', miss.length === 1 && /app$/.test(miss[0].file) && !/--base \.=/.test(miss[0].reason), err || miss);
  }

  H.section('#489：复审时文件还在、只是这一轮没进材料，不报成删了');
  {
    const Sc = require(path.join(h.kit, 'lib', 'review-scope.js'));
    const cur = (text) => ({ text, root: h.work, source: path.join(h.work, 'x') });
    const prior = { files: { 'pc/Config.vue': '<template>a</template>\n', 'pc/Gone.vue': '<template>g</template>\n', 'pc/Edited.vue': '<template>e</template>\n' }, covered: ['pc/Config.vue', 'pc/Gone.vue', 'pc/Edited.vue'], issues: [], decisions: [], closed: [], round: 1 };
    const material = { currents: new Map([['pc/Edited.vue', cur('<template>e2</template>\n')]]), reread: (f) => (f === 'pc/Config.vue' ? cur('<template>a</template>\n') : null) };
    const plan = Sc.planRound(material, prior);
    const said = (f) => plan.items.filter((x) => x.file === f).map((x) => x.text).join('\n');
    H.ok('文件还在、内容没变：不说"已经删除"，算没改（since 20261119.0611）', !/已经删除/.test(said('pc/Config.vue')) && (plan.kept || []).includes('pc/Config.vue'), [said('pc/Config.vue'), plan.kept]);
    H.ok('真不在了的：照旧说已经删除', /已经删除/.test(said('pc/Gone.vue')), said('pc/Gone.vue'));
    H.ok('改过的照旧只送改动', /这次的改动/.test(said('pc/Edited.vue')), said('pc/Edited.vue'));
    // materials 给的 reread：项目里的普通文件读得出来，不在的、敏感配置读不出来
    const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
    const p = H.makeRepo(path.join(h.work, 'p489'), { 'src/A.java': 'class A {}\n', '.vibe/db-crud.ini': '[x]\n', '.gitignore': '.vibe/\n' });
    const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();
    H.write(path.join(p, 'src', 'B.java'), 'class B {}\n');
    let m = null; let err = '';
    try { m = R.materials({ cwd: p, mode: 'code', base }, null); } catch (e) { err = e.message; }
    H.ok('代码审查的材料带着 reread', !!m && typeof m.reread === 'function', err);
    if (m && m.reread) {
      H.ok('reread：项目里还在的文件读出现在的内容', /class A/.test((m.reread('src/A.java') || {}).text || ''));
      H.ok('reread：不在的文件给 null', m.reread('src/Gone.java') === null);
      H.ok('reread：敏感配置不读', m.reread('.vibe/db-crud.ini') === null);
      H.ok('reread：项目外的不读', m.reread('../outside.txt') === null);
    }
  }

  H.section('#484：系统临时目录里跑的编译、测试不记验证证据');
  {
    const E = require(path.join(h.kit, 'lib', 'evidence.js'));
    const p = H.makeRepo(path.join(h.work, 'p484'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
    const tmp = path.join(require('os').tmpdir(), 'ftcu2').replace(/\\/g, '/');
    const cmd = 'mkdir -p "' + tmp + '" && "C:/Program Files/Java/jdk1.8.0_251/bin/javac" -d "' + tmp + '" "' + tmp + '/P.java" 2>&1 | grep -c E-SafeNet';
    const j = (command) => ({ session_id: 's-484', cwd: p, tool_name: 'Bash', tool_use_id: 'tu-' + (++seq), tool_input: { command }, tool_response: { stdout: '0', stderr: '' } });
    H.ok('#484 原样：javac 编临时目录里的文件，不算验证（since 20261119.0611）', E.actual(j(cmd)) === null, E.actual(j(cmd)));
    H.ok('AppData/Local/Temp 下的写法（/c/Users/…）也认', E.actual(j('javac /c/Users/x/AppData/Local/Temp/q/A.java')) === null);
    // 复审 R1：输出写到临时目录（日志、报告、编译输出），测的还是项目：照旧记
    for (const c of ['mvn test > ' + tmp + '/m.log 2>&1', 'npm test 2>&1 | tee /tmp/o.log', 'pytest --junitxml=/tmp/r.xml', 'mvn -q compile > /tmp/x.log', 'node ' + tmp + '/prep.js && npm test']) H.ok('输出写到临时目录、测的是项目：照旧记 · ' + c, !!E.actual(j(c)), c);
    H.ok('项目里的编译照旧记', !!E.actual(j('mvn -q compile')));
    H.ok('点了项目里的文件、又用了临时目录：照旧记', !!E.actual(j('javac -d ' + tmp + ' ' + path.join(p, 'src', 'A.java').replace(/\\/g, '/'))));
    const before = (S.readState('evidence').rows || []).length;
    H.hook(h, 'after-tool', { session_id: 's-484', cwd: p, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu-484', tool_input: { command: cmd }, tool_response: { stdout: '0', stderr: '', interrupted: false }, transcript_path: tp([H.tr.user('看看加密软件影不影响编译')]) });
    H.ok('after-tool 跑完：没记证据', (S.readState('evidence').rows || []).length === before);
  }

  H.section('#487：plan.md 的大任务里列了兄弟壳子的变更，开工范围带上它');
  {
    const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
    const B = require(path.join(h.kit, 'lib', 'big-task.js'));
    const DOC = (name) => ({ ['openspec/changes/' + name + '/proposal.md']: '## Why\n\n要做。\n', ['openspec/changes/' + name + '/tasks.md']: '## 1. 实现\n\n- [ ] 1.1 改代码\n' });
    const top = path.join(h.work, 'JSSLT');
    const PLAN = '# 计划\n\n## 采砂证\n\n探索记录：explore/采砂证.md\n\n| 模块 | 变更名 | 状态 | 说明 |\n|---|---|---|---|\n| | add-hdca-cert-gateway | | |\n| | add-ec-cert-city-issue | | OA 那边的支撑 |\n';
    const gw = H.makeRepo(path.join(top, 'JWJH', 'gwjh-workspace'), Object.assign({ 'README.md': '# 壳子\n', '.gitignore': '.vibe/\ngwjh/\n', 'openspec/plan.md': PLAN, 'openspec/explore/采砂证.md': '# 采砂证\n\n## 还没定的\n\n## change: add-hdca-cert-gateway\n\n网关\n\n## change: add-ec-cert-city-issue\n\nOA\n' }, DOC('add-hdca-cert-gateway')));
    H.makeRepo(path.join(gw, 'gwjh'), { 'pom.xml': '<project/>\n', 'src/G.java': 'class G {}\n' });
    const oa = H.makeRepo(path.join(top, 'OA', 'oa-workspace'), Object.assign({ 'README.md': '# 壳子\n', '.gitignore': '.vibe/\noa/\n' }, DOC('add-ec-cert-city-issue')));
    const oaCode = H.makeRepo(path.join(oa, 'oa'), { 'pom.xml': '<project/>\n', 'src/E.java': 'class E {}\n' });
    const task = B.tasks(gw).find((t) => t.name === '采砂证');
    const far = task && task.changes.find((c) => c.name === 'add-ec-cert-city-issue');
    H.ok('大任务里 OA 那一行认出了兄弟壳子的目录（since 20261119.0611）', !!far && far.exists === true && far.far === true && S.normKey(far.dir) === S.normKey(path.join(oa, 'openspec', 'changes', 'add-ec-cert-city-issue')), far);
    const jx = { session_id: 's-487', cwd: gw, transcript_path: tp([H.tr.user('开工 add-hdca-cert-gateway')]) };
    H.inFlow(h, 's-487', [path.join(gw, 'openspec', 'changes', 'add-hdca-cert-gateway')], true, 'apply');
    const g = A.grant(jx, '开工 add-hdca-cert-gateway', '');
    H.ok('开工这边的变更：范围里也有大任务表里 OA 那个', g.ok && g.targets.includes('add-hdca-cert-gateway') && g.targets.includes('add-ec-cert-city-issue'), g);
    H.ok('改 OA 子项目的代码：不再拦"目标项目不在当前 apply 许可里"', !/不在当前 apply 许可里/.test(A.check(jx, path.join(oaCode, 'src', 'E.java')) || ''), A.check(jx, path.join(oaCode, 'src', 'E.java')));
    H.ok('兄弟壳子里找不到的行照旧当没建', B.tasks(gw)[0].changes.every((c) => c.name !== 'no-such' || !c.exists));
  }

  H.section('#485 顺带：用 Bash 改 OpenSpec 的需求文档拦下，让它用编辑工具');
  {
    const p = H.makeRepo(path.join(h.work, 'p485'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
      'openspec/changes/duty-plan/proposal.md': '## Why\n\n值班。\n', 'openspec/changes/duty-plan/design.md': '## Context\n\n- 读过 src/A.java\n', 'openspec/changes/duty-plan/tasks.md': '## 1. 值班\n\n- [ ] 1.1 改 src/A.java：值班\n', 'openspec/changes/duty-plan/revisions.md': '# 修订\n' });
    const bash = (command, ps) => H.hook(h, 'guard-commit', { session_id: 's-485', hook_event_name: 'PreToolUse', cwd: p, transcript_path: tp([H.tr.user('接着做')]), tool_name: ps ? 'PowerShell' : 'Bash', tool_input: { command }, tool_use_id: 'tu-' + (++seq) });
    const SPEC = /用 Bash 改 OpenSpec 的需求文档/;
    const hit = [
      ["sed -i 's/^- \\[ \\] /- [x] /' openspec/changes/duty-plan/tasks.md", '#485 原样：sed -i 一次全勾 tasks.md'],
      ['echo "- [x] 1.2 补" >> openspec/changes/duty-plan/tasks.md', '>> 追加到 tasks.md'],
      ['printf "x" > openspec/changes/duty-plan/design.md', '> 写 design.md'],
      ['cat .vibe/tmp/t.md | tee openspec/changes/duty-plan/proposal.md', 'tee 写 proposal.md'],
      ['cp .vibe/tmp/t.md openspec/changes/duty-plan/tasks.md', 'cp 盖上 tasks.md'],
      ["perl -pi -e 's/x/y/' openspec/changes/duty-plan/design.md", 'perl -pi 改 design.md'],
      ["node -e \"require('fs').writeFileSync('openspec/changes/duty-plan/tasks.md','x')\"", 'node -e 写 tasks.md'],
    ];
    // 复审 R5 的兜底：find -exec、通配符、.NET 写文件、here-doc 里的 python 脚本
    hit.push(
      ["find openspec/changes/duty-plan -name tasks.md -exec sed -i 's/a/b/' {} +", 'find -exec sed -i 改变更目录'],
      ["sed -i 's/a/b/' openspec/changes/duty-plan/*.md", 'sed -i 带通配符'],
      ["python3 - <<'EOF'\nopen('openspec/changes/duty-plan/tasks.md', 'w').write('x')\nEOF", 'here-doc 里的 python 写 tasks.md'],
    );
    for (const [cmd, what] of hit) { const r = bash(cmd); H.ok(what + '：拦下（since 20261119.0611）', SPEC.test(H.reasonOf(r)), H.reasonOf(r)); }
    const rnet = bash("[System.IO.File]::WriteAllText('openspec/changes/duty-plan/tasks.md', 'x')", true);
    H.ok('PowerShell [System.IO.File]::WriteAllText 写 tasks.md：拦下', SPEC.test(H.reasonOf(rnet)), H.reasonOf(rnet));
    const rps = bash('Set-Content -Path openspec/changes/duty-plan/tasks.md -Value x', true);
    H.ok('PowerShell Set-Content 写 tasks.md：拦下', SPEC.test(H.reasonOf(rps)), H.reasonOf(rps));
    const r0 = bash("sed -i 's/^- \\[ \\] /- [x] /' openspec/changes/duty-plan/tasks.md");
    H.ok('提示写明用 Edit 一项一项勾，没有拦截编号（不能申请放行）', /Edit/.test(H.reasonOf(r0)) && /做完一项勾一项/.test(H.reasonOf(r0)) && !/〔/.test(H.reasonOf(r0)), H.reasonOf(r0));
    const pass = [
      ["sed -n '1,5p' openspec/changes/duty-plan/tasks.md", 'sed -n 看 tasks.md'],
      ['grep -c "^- \\[x\\]" openspec/changes/duty-plan/tasks.md 2>&1', 'grep 数打勾'],
      ['cat openspec/changes/duty-plan/design.md > .vibe/tmp/design-copy.md', '读出来写到别处'],
      ['echo "起因：x" >> openspec/changes/duty-plan/revisions.md', '追加 revisions.md'],
      ["sed -i 's/a/b/' src/A.java", 'sed -i 改代码文件'],
    ];
    for (const [cmd, what] of pass) { const r = bash(cmd); H.ok(what + '：这道不拦', !SPEC.test(H.reasonOf(r)), H.reasonOf(r)); }
  }

  H.section('实施一律自动：问"能开工吗"答"可以"、点老选项"实施（每步问我）"');
  {
    const mk = (sid, answer, options) => {
      const p = H.makeRepo(path.join(h.work, 'p-' + sid), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n',
        'openspec/changes/c-go/proposal.md': '## Why\n\n导出。\n\n## What Changes\n\n- 改 src/A.java\n', 'openspec/changes/c-go/design.md': '## Context\n\n- 读过 src/A.java\n\n## 验收用例\n\n| 编号 | 场景 | 前置 | 步骤 | 预期 | 谁来测 | 任务 |\n|---|---|---|---|---|---|---|\n| AC-1 | 导出 | 有数据 | 调接口 | 200 | 人工 | 1 |\n',
        'openspec/changes/c-go/specs/x/spec.md': '## ADDED Requirements\n\n### Requirement: 导出\n\n系统 SHALL 导出。\n\n#### Scenario: 正常\n\n- **WHEN** 调用\n- **THEN** 成功\n', 'openspec/changes/c-go/tasks.md': '## 1. 导出\n\n- [ ] 1.1 改 src/A.java：加导出\n' });
      const d = path.join(p, 'openspec', 'changes', 'c-go');
      H.reviewPoints(h, d, 'proposal'); H.inFlow(h, sid, [d], true, 'plan');
      const q = 'c-go 的需求审过了，能开工吗？';
      const tr = tp([H.tr.user('写需求'), ...H.tr.ran('AskUserQuestion', { questions: [{ question: q, options: options.map((label) => ({ label })) }] }, 'User has answered your questions: "' + q + '"="' + answer + '". You can now continue with the user\'s answers in mind.')]);
      const r = H.hook(h, 'pre-edit', { session_id: sid, cwd: p, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(p, 'src', 'A.java'), old_string: 'class A', new_string: 'class A ' }, transcript_path: tr });
      return { r, j: { session_id: sid, cwd: p } };
    };
    const a = mk('s-go-yes', '可以', ['可以', '再看看']);
    H.ok('问"能开工吗"答"可以"：开工了，自动也开了（since 20261119.0611）', !H.reasonOf(a.r) && S.flowState(a.j).stage === 'apply' && S.sessionAuto(a.j) === true, [H.reasonOf(a.r), S.flowState(a.j).stage, S.sessionAuto(a.j)]);
    const b = mk('s-go-manual', '实施（每步问我）', ['自动实施', '实施（每步问我）', '先不实施']);
    H.ok('点了老版本的"实施（每步问我）"：开工，自动关着（用户明说的）', !H.reasonOf(b.r) && S.flowState(b.j).stage === 'apply' && S.sessionAuto(b.j) === false, [H.reasonOf(b.r), S.flowState(b.j).stage, S.sessionAuto(b.j)]);
    // 复审 R2："开始实施"后面跟着别的字的不算选了开始实施
    const C = require(path.join(h.kit, 'lib', 'session-config.js'));
    for (const [a0, w] of [['开始实施', 'on'], ['开始实施（自动）', 'on'], ['开始实施，别动数据库', 'on'], ['开始实施前先补充需求', ''], ['开始实施 方案二', ''], ['开始实施方案A', '']]) H.ok('"' + a0 + '" → ' + (w || '不算'), C.autoAnswerOf(a0) === w, C.autoAnswerOf(a0));
    // 复审 R3：同一句里先说别自动了又说开工：不开回去
    const c = mk('s-go-stop', '可以', ['可以', '再看看']);
    H.ok('前提：开着自动', S.sessionAuto(c.j) === true);
    H.hook(h, 'task-anchor', { session_id: 's-go-stop', cwd: c.j.cwd, hook_event_name: 'UserPromptSubmit', prompt: '别自动了，开工吧', transcript_path: tp([H.tr.user('别自动了，开工吧')]) });
    H.ok('"别自动了，开工吧"：自动关着，不在同一句里又开回去', S.sessionAuto(c.j) === false, S.sessionAuto(c.j));
  }

  const wins = await watch.stop();
  H.ok('桌面上没有冒出窗口', !wins.length, wins);
  H.done('11-18 议题 #484、#485、#487、#488、#489');
})().catch((e) => { H.ok('出错', false, e.stack); H.done('11-18'); });

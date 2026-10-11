'use strict';
/*
 * 内网导出的议题（vibe-kit议题汇总-20260930-175607.md，10 条）和用户自己提的六件事，照着原样复现：
 *   #1 / #6  审查提示没照约定写第一行，提案审查被记成代码审查；收工时报的条数是别的审查的
 *   #2       git -C "$r" add -A . 被当成在壳子根上整仓 add；新建的仓库第一次入仓只能整仓加
 *   #3       验法里提到结果文件（.vibe/out/…/result.json），被当成要跑的东西，跑了几十遍也打不上勾
 *   #4       验法写"同 3.1 命令 PASS"，不知道要看到什么
 *   #5       用临时 index 提交（GIT_INDEX_FILE），新文件明明加了却说没 git add
 *   #7       全自动报告说"revisions.md 里没有自动模式决定的条目"，其实有 7 条，是上一轮记的
 *   #8       会话的当前目录漂到了子项目里，壳子里定过的产出位置认不出来；占位写法（<需求编号>）不认
 *   #9       只敲了 /ttls-onboard，收工检查却催着"直接开始 /opsx:apply"
 *   用户的事：全自动模式只在走 OpenSpec 流程时算数；变更没归档之前过程文件先留着；
 *            工具的调用记录里的错定期汇总上报；提示规则去掉了；全自动报告列出改过的库
 * 用法：node dev/test-feedback0930.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('fb0930', null, { autoVerify: false, autoSeePage: false, autoCrossReview: false, autoCommit: 'off', vibeTidy: true, specGate: true, lessons: 'off' });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const state = (name) => readJson(path.join(h.kit, 'state', name + '.json'));
const dropState = (name) => { try { fs.unlinkSync(path.join(h.kit, 'state', name + '.json')); } catch (e) { /* 没有 */ } };
const hookLog = () => H.read(path.join(h.kit, 'state', 'hooks.log')) || '';
const tfile = path.join(h.root, 'transcript.jsonl');
const reviewCall = (id, prompt, issues) => [H.tr.call('Agent', { subagent_type: 'ttls-reviewer', prompt }, id), H.tr.result(id, '审完了。\n结论：问题 ' + issues + ' 条')];
const mkChange = (root, name, tasks, extra) => {
  const d = path.join(root, 'openspec', 'changes', name);
  H.write(path.join(d, 'proposal.md'), '# ' + name + '\n');
  H.write(path.join(d, 'tasks.md'), tasks);
  for (const [rel, text] of Object.entries(extra || {})) H.write(path.join(d, rel), text);
  return d;
};
const markReviewed = (dir) => fs.writeFileSync(path.join(h.kit, 'state', 'reviewed-proposal.json'), JSON.stringify(Object.assign(state('reviewed-proposal'), { [S.normKey(dir)]: { done: true, at: Date.now() - 3600000, born: S.changeBorn(dir), issues: 0 } })));

// =============================================================================================
H.section('#1 / #6 审查是审提案还是审代码：认不出的不记到代码那边');
{
  const proj = H.makeRepo(path.join(h.work, 'rev'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  const fresh = mkChange(proj, 'add-query-sql-cleanup', '- [ ] 1.1 改 src/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/A.java；验：`mvn -q -o compile`\n');
  const done = mkChange(proj, 'all-done', '- [x] 1.1 改 src/A.java；验：`mvn -q -o compile`\n');
  const half = mkChange(proj, 'half-done', '- [x] 1.1 改 src/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/A.java；验：`mvn -q -o compile`\n');
  const c = (dir) => ({ name: path.basename(dir), dir });
  H.ok('约定的第一行照旧认', S.reviewModeOf('模式：提案\n变更：x') === 'proposal' && S.reviewModeOf('模式：复审代码\n变更：x') === 'code' && S.reviewModeOf('模式：复审提案') === 'proposal');
  H.ok('议题原样："独立审一遍 OpenSpec 提案（不是审代码）"是审提案', S.reviewModeOf('你以 vibe-reviewer 身份独立审一遍 OpenSpec 提案（不是审代码）。\n变更目录：openspec/changes/add-query-sql-cleanup/') === 'proposal');
  H.ok('议题原样："复审模式：你上一轮报的 5 条已经改过"，变更一项都没打勾：是审提案', S.reviewModeOf('复审模式：你上一轮报的 5 条已经改过，确认改对了没有。', c(fresh)) === 'proposal');
  H.ok('"模式：代码"写在第二行也认', S.reviewModeOf('请帮我审一下。\n模式：代码\n变更：all-done') === 'code');
  H.ok('前几行里说了"审代码""审改动"：是审代码', S.reviewModeOf('审一下这次的代码改动，专挑想当然的。', c(half)) === 'code');
  H.ok('话里认不出、任务全打了勾：是审代码', S.reviewModeOf('帮忙过一遍。', c(done)) === 'code');
  H.ok('话里认不出、任务做了一半：不猜', S.reviewModeOf('帮忙过一遍。', c(half)) === '');
  H.ok('话里认不出、又不知道是哪个变更：不猜', S.reviewModeOf('帮忙过一遍。') === '');
  // 认不出的不记账：以前一律记成代码审查
  const sid = 's-rev';
  H.transcript(tfile, [H.tr.user('审一下'), reviewCall('toolu_r1', '帮忙过一遍。\n变更：openspec/changes/half-done/', 3)]);
  S.syncReviews(S.tailEntries(tfile, 8000000).filter((e) => e && !e.isSidechain), proj);
  H.ok('认不出审的是哪一样：两边都不记', !state('reviewed')[S.normKey(half)] && !state('reviewed-proposal')[S.normKey(half)], [state('reviewed'), state('reviewed-proposal')]);
  H.ok('流水账里留了一句，说了第一行该怎么写', /审查记账 认不出审的是提案还是代码，没记：变更 half-done，报了 3 条/.test(hookLog()) && /模式：提案 \/ 代码 \/ 复审提案 \/ 复审代码/.test(hookLog()), hookLog().slice(-400));
  const n0 = (hookLog().match(/审查记账 认不出/g) || []).length;
  S.syncReviews(S.tailEntries(tfile, 8000000).filter((e) => e && !e.isSidechain), proj);
  H.ok('同一次审查只留一次', (hookLog().match(/审查记账 认不出/g) || []).length === n0);
  // 议题 #1 原样：提案审了好几轮，提示都没照约定写；打勾时不能说"提案还没审过"，收工时不能催"代码复审"
  H.setConfig(h, { reviewLoop: true, reviewMaxRounds: 5 });
  for (const n of ['reviewed', 'reviewed-proposal', 'review-rounds', 'review-nudged']) dropState(n);
  const fix = H.tr.ran('Edit', { file_path: path.join(fresh, 'design.md'), old_string: 'a', new_string: 'b' }, 'ok');
  H.write(path.join(fresh, 'design.md'), '## Context\n\n- 读过 src/A.java\n');
  H.write(path.join(fresh, 'revisions.md'), '# 修订记录\n');
  const talk = [H.tr.user('/opsx:propose 清理查询的 SQL'),
    reviewCall('toolu_p1', '你以 vibe-reviewer 身份独立审一遍 OpenSpec 提案（不是审代码）。\n变更目录：openspec/changes/add-query-sql-cleanup/', 5), fix,
    reviewCall('toolu_p2', '复审模式：你上一轮报的 5 条已经改过，确认改对了没有。\n变更：openspec/changes/add-query-sql-cleanup/', 3), fix];
  const stop = (entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: false, last_assistant_message: said || '改好了，没验证：只改了文档' });
  const r1 = stop(talk.concat([H.tr.say('改好了')]));
  H.ok('议题 #1 原样：两轮都记在提案那边，催的是提案的第 3 轮', /第 2 轮提案审查报了 3 条问题/.test(H.reasonOf(r1)) && /模式：复审提案/.test(H.reasonOf(r1)) && !/代码审查报了/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('议题 #6 原样：报的条数是最近这一轮审查者说的（3 条）', /报了 3 条/.test(H.reasonOf(r1)) && !/报了 5 条/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('代码那边没有记录', !state('reviewed')[S.normKey(fresh)] && !Object.keys(state('review-rounds')).some((k) => k.startsWith('code|')), [state('reviewed'), Object.keys(state('review-rounds'))]);
  // 审到 0 条：提案算审过了，可以开工打勾
  const talk2 = talk.concat([reviewCall('toolu_p3', '复审：上一轮的 3 条都改了，再确认一遍。\n变更：openspec/changes/add-query-sql-cleanup/', 0)]);
  H.transcript(tfile, talk2.concat([H.tr.ran('Edit', { file_path: path.join(proj, 'src/A.java'), old_string: 'a', new_string: 'b' }, 'ok'), H.tr.ran('Bash', { command: 'mvn -q -o compile' }, 'BUILD SUCCESS')]));
  const tick = H.hook(h, 'pre-edit', { session_id: sid, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(fresh, 'tasks.md'), old_string: '- [ ] 1.1', new_string: '- [x] 1.1' } });
  H.ok('议题 #1 原样：提案审完了，第一次打勾不再说"提案还没审过"', tick === null, H.reasonOf(tick));
  H.setConfig(h, { reviewLoop: false });
}

// =============================================================================================
H.section('#2 git -C 的目录写在变量里；新建的仓库第一次入仓');
{
  // 壳子：自己是 git 仓库，下面套着几个子项目
  const shell = H.makeRepo(path.join(h.work, 'jssslt-oa'), { 'README.md': '# 壳子\n', 'workspace.yaml': 'name: oa\n', '.gitignore': 'jssslt-app/\njssslt-bpm/\nold-svc/\n' });
  const mkFresh = (name) => { const d = path.join(shell, name); fs.mkdirSync(d, { recursive: true }); H.git(d, ['init', '-q']); H.write(path.join(d, 'pom.xml'), '<project/>\n'); H.write(path.join(d, 'src/Main.java'), 'class Main {}\n'); return d; };
  mkFresh('jssslt-app'); mkFresh('jssslt-bpm');
  H.makeRepo(path.join(shell, 'old-svc'), { 'pom.xml': '<project/>\n' });
  fs.mkdirSync(path.join(shell, 'notes'), { recursive: true });
  const run = (cmd) => H.hook(h, 'guard-commit', { session_id: 's-git', cwd: shell, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } });
  const r1 = run('git -C "$r" add -A .');
  H.ok('议题原样：目录写在变量里、算不出来：不说"会提交成 gitlink"，说清是算不出是哪个仓库', r1 && r1.decision === 'block' && /目录写在变量里（"\$r"），算不出是哪个仓库/.test(H.reasonOf(r1)) && !/gitlink/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('提示里说了新仓库第一次入仓怎么写', /新建的仓库第一次入仓（还没有任何提交）可以整仓 add/.test(H.reasonOf(r1)) && /for r in a b c/.test(H.reasonOf(r1)), H.reasonOf(r1));
  const r2 = run('for r in jssslt-app jssslt-bpm; do git -C "$r" add -A .; done');
  H.ok('议题原样：循环里的取值写在命令里，两个都是还没有提交的新仓库：放行', r2 === null, H.reasonOf(r2));
  H.ok('流水账里记了是第一次入仓放行的', /新建的仓库第一次入仓（还没有提交），整仓 add 放行/.test(hookLog()), hookLog().slice(-300));
  const r3 = run('for r in jssslt-app old-svc; do\n  git -C "$r" add -A .\ndone');
  H.ok('循环里有一个是有提交的老仓库：照样拦，说的是整仓 add', r3 && r3.decision === 'block' && /会把你工作区里原来就有的改动/.test(H.reasonOf(r3)) && /新建的仓库第一次入仓（还没有任何提交）不拦/.test(H.reasonOf(r3)), H.reasonOf(r3));
  H.ok('目录写明的新仓库：整仓 add 放行', run('git -C jssslt-app add -A') === null && run('git -C jssslt-bpm add .') === null);
  const r4 = run('git add -A');
  H.ok('在壳子根上整仓 add：照旧拦，说的是 gitlink', r4 && r4.decision === 'block' && /这样 add 会把它们提交成 gitlink/.test(H.reasonOf(r4)), H.reasonOf(r4));
  const r5 = run('git -C notes add -A');
  H.ok('议题里说的漏拦：-C 指的不是仓库，git 会落到外面的壳子上：拦', r5 && r5.decision === 'block' && /gitlink/.test(H.reasonOf(r5)), H.reasonOf(r5));
  H.ok('循环里只加点名的文件：不拦', run('for r in jssslt-app old-svc; do git -C "$r" add pom.xml; done') === null);
  H.ok('用 ls-files 只加没进 git 的文件（议题里的绕法）：不拦', run('git -C "$r" ls-files -o --exclude-standard -z | git -C "$r" add --pathspec-from-file=- --pathspec-file-nul') === null);
  const r6 = run('git -C "$r" push origin main');
  H.ok('目录在变量里的 push：先预览再确认', r6 && r6.decision === 'block' && /推送前先运行.*plan/.test(H.reasonOf(r6)), r6);
}

// =============================================================================================
H.section('#3 验法里提到的结果文件不是要跑的东西');
{
  const v = '因 PC 端走 SM2 即焚密钥，用 `.vibe/tmp/add-harvest-reason-type/sm2-test.mjs` 跑接口场景，结果在 `.vibe/out/add-harvest-reason-type-sm2/result.json`';
  const plan = S.verifyPlan(v);
  H.ok('议题原样：要看到的只有那个脚本，没有 result.json', /sm2-test\.mjs/.test(plan.need) && !/result\.json/.test(plan.need), plan.need);
  H.ok('议题原样：跑过脚本就算验过', plan.test(['node "D:/gitWorkSpace/ly-slcf/rj2025015-src/.vibe/tmp/add-harvest-reason-type/sm2-test.mjs"']), plan.need);
  H.ok('脚本没跑过照样不算', !plan.test(['git status', 'ls .vibe/out']));
  const v2 = '`node .vibe/tmp/x/probe.js --out .vibe/out/x/result.json`';
  H.ok('反引号里的命令带着结果文件：只要求脚本出现在跑过的命令里', S.verifyRan(v2, ['node .vibe/tmp/x/probe.js']) && !S.verifyRan(v2, ['git status', 'cat .vibe/out/x/result.json']), S.verifyPlan(v2).need);
  H.ok('场景文件照旧要跑过', !S.verifyRan('/ttls-see-page 场景 `.vibe/scenarios/login.json`', ['node x.js']) && S.verifyRan('/ttls-see-page 场景 `.vibe/scenarios/login.json`', ['node x/scenario-run.js .vibe/scenarios/login.json']));
  H.ok('没加反引号、写着"场景跑完看 out/report.json"：不把 report 当场景名', !/场景 report/.test(S.verifyPlan('接口场景跑完看 .vibe/out/login/report.json').need), S.verifyPlan('接口场景跑完看 .vibe/out/login/report.json').need);
}

// =============================================================================================
H.section('#4 验法写"同 3.1""同上"：查的是那一项写的验法');
{
  const proj = H.makeRepo(path.join(h.work, 'same'), { 'pom.xml': '<project/>\n', 'src/No.java': 'class No {}\n', 'src/NoTest.java': 'class NoTest {}\n' });
  const tasks = ['- [x] 3.1 改序号生成：src/No.java；验：`mvn -o -Dtest=NoTest test`', '- [ ] 3.2 新增并发安全单测：src/NoTest.java；验：同 3.1 命令 PASS', '- [ ] 3.3 注释同步：src/No.java；验：同上', '- [ ] 3.4 别的：src/No.java；验：同 9.9', ''].join('\n');
  const chg = mkChange(proj, 'refine-no', tasks);
  markReviewed(chg);
  const r = S.resolveVerify('3.2 新增并发安全单测：src/NoTest.java；验：同 3.1 命令 PASS', tasks);
  H.ok('"同 3.1 命令 PASS"换成 3.1 的验法', r.ref === '3.1' && r.text === '`mvn -o -Dtest=NoTest test`', r);
  const r2 = S.resolveVerify('3.3 注释同步：src/No.java；验：同上', tasks);
  H.ok('"同上"一路找到 3.1 的验法', r2.text === '`mvn -o -Dtest=NoTest test`', r2);
  const r3 = S.resolveVerify('3.4 别的：src/No.java；验：同 9.9', tasks);
  H.ok('指的那一项找不到：照原样查', r3.ref === '' && r3.text === '同 9.9', r3);
  const r4 = S.resolveVerify('3.5 集成：src/No.java；验：`mvn -o -Dtest=NoIT verify`（环境同 3.1）', tasks);
  H.ok('自己写明了命令、顺带提了一句"环境同 3.1"：照自己的查', r4.ref === '' && /NoIT verify/.test(r4.text), r4);
  const sid = 's-same';
  const tick = (n) => H.hook(h, 'pre-edit', { session_id: sid, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(chg, 'tasks.md'), old_string: '- [ ] ' + n, new_string: '- [x] ' + n } });
  const editTest = H.tr.ran('Edit', { file_path: path.join(proj, 'src/NoTest.java'), old_string: 'a', new_string: 'b' }, 'ok');
  H.transcript(tfile, [H.tr.user('继续'), editTest, H.tr.ran('Bash', { command: 'git status' }, 'clean')]);
  const b = tick('3.2');
  H.ok('议题原样：没跑过，提示里说清是 3.1 的哪条命令', b && b.decision === 'block' && /写的验法是"同 3\.1 命令 PASS"（就是 3\.1 的验法："`mvn -o -Dtest=NoTest test`"）/.test(H.reasonOf(b)) && /要看到的是：跑过 `mvn -o -Dtest=NoTest test`/.test(H.reasonOf(b)), H.reasonOf(b));
  H.transcript(tfile, [H.tr.user('继续'), editTest, H.tr.ran('Bash', { command: 'mvn -o -Dtest=NoTest test' }, 'BUILD SUCCESS')]);
  H.ok('跑过 3.1 的那条命令：能打勾', tick('3.2') === null, H.reasonOf(tick('3.2')));
}

// =============================================================================================
H.section('#5 用临时 index 提交：新文件加在那份 index 里');
{
  const repo = H.makeRepo(path.join(h.work, 'gwjh'), { 'pom.xml': '<project/>\n', 'ui/package.json': '{ "name": "ui" }\n' });
  // 工作区里有别人没提交的改动
  fs.writeFileSync(path.join(repo, 'ui/package.json'), '{ "name": "ui", "x": 1 }\n');
  const f1 = path.join(repo, 'ui/build/check-vendor.js');
  const f2 = path.join(repo, 'ui/vendor/README.md');
  H.write(f1, 'console.log(1);\n');
  H.write(f2, '# vendor\n');
  const sid = 's-idx';
  H.transcript(tfile, [H.tr.user('提交 vendor'), H.tr.ran('Write', { file_path: f1, content: 'x' }, 'ok'), H.tr.ran('Write', { file_path: f2, content: 'x' }, 'ok')]);
  const run = (cmd) => H.hook(h, 'guard-commit', { session_id: sid, transcript_path: tfile, cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } });
  const plain = run('git commit -m "chore: 加 vendor 检查"');
  H.ok('不用临时 index、新文件没 add：照旧点名拦', plain && plain.decision === 'block' && /还没 git add/.test(H.reasonOf(plain)) && /check-vendor\.js/.test(H.reasonOf(plain)), H.reasonOf(plain));
  dropState(sid + '-newfiles-commit');
  // 真的建一份临时 index，把两个新文件加进去
  const idx = path.join(h.root, 'tmp-index');
  const env = Object.assign({}, process.env, { GIT_INDEX_FILE: idx });
  const { spawnSync } = require('child_process');
  const git = (args) => spawnSync('git', ['-C', repo].concat(args), { env, encoding: 'utf8', windowsHide: true });
  git(['read-tree', 'HEAD']);
  git(['add', 'ui/build/check-vendor.js', 'ui/vendor/README.md']);
  const r1 = run('GIT_INDEX_FILE="' + idx.replace(/\\/g, '/') + '" git commit -m "chore: 加 vendor 检查"');
  H.ok('议题原样：两个文件在临时 index 里：不说"还没 git add"', r1 === null, H.reasonOf(r1));
  const r2 = run('export GIT_INDEX_FILE="' + idx.replace(/\\/g, '/') + '"; git commit -m "chore: 加 vendor 检查"');
  H.ok('先 export 再提交：一样认', r2 === null, H.reasonOf(r2));
  // 临时 index 里少加了一个：照样点名
  const idx2 = path.join(h.root, 'tmp-index2');
  spawnSync('git', ['-C', repo, 'read-tree', 'HEAD'], { env: Object.assign({}, process.env, { GIT_INDEX_FILE: idx2 }), windowsHide: true });
  spawnSync('git', ['-C', repo, 'add', 'ui/build/check-vendor.js'], { env: Object.assign({}, process.env, { GIT_INDEX_FILE: idx2 }), windowsHide: true });
  const r3 = run('GIT_INDEX_FILE="' + idx2.replace(/\\/g, '/') + '" git commit -m "chore: 加 vendor 检查"');
  H.ok('临时 index 里漏了一个：点名的是漏的那个', r3 && r3.decision === 'block' && /ui\/vendor\/README\.md/.test(H.reasonOf(r3)) && !/check-vendor\.js/.test(H.reasonOf(r3)), H.reasonOf(r3));
  dropState(sid + '-newfiles-commit');
  const r4 = run('GIT_INDEX_FILE="$TMP_IDX" git commit -m "chore: 加 vendor 检查"');
  H.ok('临时 index 的路径算不出来：查不了，不猜', r4 === null, H.reasonOf(r4));
  const r5 = run('GIT_INDEX_FILE=/tmp/idx-$$ git read-tree HEAD && GIT_INDEX_FILE=/tmp/idx-$$ git add ui/vendor/README.md && GIT_INDEX_FILE=/tmp/idx-$$ git commit -m "chore: x"');
  H.ok('同一条命令里现建现用的临时 index：不拦', r5 === null, H.reasonOf(r5));
  // 密码检查：临时 index 里暂存的才是这次要提交的
  H.write(path.join(repo, 'src/app.properties'), 'db.password=Abc12345xyz\n');
  spawnSync('git', ['-C', repo, 'add', 'src/app.properties'], { env, windowsHide: true });
  H.transcript(tfile, [H.tr.user('提交 vendor')]);
  const r6 = run('GIT_INDEX_FILE="' + idx.replace(/\\/g, '/') + '" git commit -m "chore: 加 vendor 检查"');
  H.ok('临时 index 里有像密码的内容：照样让用户看一眼', r6 && r6.hookSpecificOutput && r6.hookSpecificOutput.permissionDecision === 'ask' && /app\.properties/.test(H.reasonOf(r6)), r6);
}

// =============================================================================================
H.section('#8 产出位置：会话的目录漂到子项目里、占位写法、没写"产出位置"四个字');
const O = require(path.join(h.kit, 'lib', 'outputs.js'));
{
  const ws = H.makeRepo(path.join(h.work, 'jssslt-oa-workspace'), { 'README.md': '# 壳子\n', '.gitignore': 'jssslt-oa/\n',
    'CLAUDE.md': '# 壳子\n\n## 项目说明（团队共享）\n\n- 代码之外的产出（DDL、说明文档）放 docs/<需求编号>/<需求编号>-<需求名>/，例如 docs/AQBM2026007/AQBM2026007-需求1-证照临期统计及短信提醒功能/\n- 产出不要放在 src/main/ 下\n- 按类别分的分析报告这类产出写到 `reports/{日期}/`\n',
    'docs/readme.txt': 'x\n' });
  const sub = H.makeRepo(path.join(ws, 'jssslt-oa'), { 'pom.xml': '<project/>\n', 'ui/package.json': '{}\n', '.gitignore': '.vibe/\n' });
  H.write(path.join(sub, '.vibe', 'project.md'), '# 项目说明\n\n- 类型：Java 后端\n- **产出位置**（用户定的）：docs/<需求编号>/<需求编号>-<需求名>/\n');
  const low = (p) => p.toLowerCase().replace(/\\/g, '/');
  const a = O.declsOf(path.join(ws, 'CLAUDE.md')).map((d) => d.pattern);
  H.ok('占位写法当通配符；例子那一段也认；"不要放在"的不认', a.includes(low(path.join(ws, 'docs')) + '/*/*-*') && a.some((p) => p.endsWith('/docs/aqbm2026007/aqbm2026007-需求1-证照临期统计及短信提醒功能')) && !a.some((p) => /src\/main/.test(p)), a);
  H.ok('"按类别分的……产出写到"里的"类别"不算否定；花括号的占位也认', a.includes(low(path.join(ws, 'reports')) + '/*'), a);
  const b = O.declsOf(path.join(sub, '.vibe', 'project.md')).map((d) => d.pattern);
  H.ok('记在子项目的项目说明里（加粗、带括号的备注）：子项目里没有 docs、壳子里有，壳子里的也算', b.includes(low(path.join(ws, 'docs')) + '/*/*-*'), b);
  const target = path.join(ws, 'docs', 'AQBM2026007', 'AQBM2026007-需求1-证照临期统计及短信提醒功能', 'ec-expiry-remind-dict.sql');
  // 会话在壳子里启动，后来当前目录成了 子项目/ui
  const sid = 's-out';
  H.hook(h, 'session-start', { session_id: sid, cwd: ws, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tfile });
  H.ok('会话开始时记下了启动目录', low(readJson(path.join(h.kit, 'state', sid + '-home.json')).dir || '') === low(ws), readJson(path.join(h.kit, 'state', sid + '-home.json')));
  H.transcript(tfile, [H.tr.user('接着做')]);
  H.setConfig(h, { autoMode: true });
  H.inFlow(h, sid);
  const write = (file, s) => H.hook(h, 'pre-edit', { session_id: s || sid, transcript_path: tfile, cwd: path.join(sub, 'ui'), hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: '-- ddl\n' } });
  const w1 = write(target);
  H.ok('议题原样：当前目录在 子项目/ui，往壳子里定过的位置写 DDL：不拦', w1 === null, H.reasonOf(w1));
  const w2 = write(path.join(ws, 'somewhere', 'a.sql'));
  H.ok('没定过的位置照样拦（全自动：先放 .vibe/pending）', w2 && w2.decision === 'block' && /放哪还没跟用户定过/.test(H.reasonOf(w2)) && /\.vibe[\\/]pending/.test(H.reasonOf(w2)), H.reasonOf(w2));
  const w3 = write(path.join(ws, 'docs', 'a.sql'));
  H.ok('docs 根上不是定过的那一层：拦', w3 && w3.decision === 'block', H.reasonOf(w3));
  // 没有会话开始的记录（老会话）：照会话记录所在的目录名认启动目录
  const enc = ws.replace(/[^A-Za-z0-9]/g, '-');
  const tf2 = path.join(h.cfg, 'projects', enc, 's-old.jsonl');
  H.transcript(tf2, [H.tr.user('接着做')]);
  H.ok('没记过启动目录：照会话记录所在的目录名认出来', low(S.sessionHome({ session_id: 's-old', cwd: path.join(sub, 'ui'), transcript_path: tf2 })) === low(ws), S.sessionHome({ session_id: 's-old', cwd: path.join(sub, 'ui'), transcript_path: tf2 }));
  H.ok('两样都没有：就用现在的目录', low(S.sessionHome({ session_id: 's-none', cwd: path.join(sub, 'ui'), transcript_path: tfile })) === low(path.join(sub, 'ui')));
  // 全自动报告写在启动目录里，不写进 子项目/ui/.vibe
  const R = require(path.join(h.kit, 'lib', 'report.js'));
  R.begin({ session_id: sid, cwd: path.join(sub, 'ui'), transcript_path: tfile });
  H.ok('全自动报告记的是启动目录', low(R.stateOf({ session_id: sid }).cwd) === low(ws), R.stateOf({ session_id: sid }).cwd);
  H.setConfig(h, { autoMode: false });
}

// =============================================================================================
H.section('#9 全自动模式只在走 OpenSpec 流程时算数');
{
  const proj = H.makeRepo(path.join(h.work, 'flow'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const chgA = mkChange(proj, 'add-ec-expiry-remind', '- [ ] 1.1 改 src/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/A.java；验：`mvn -q -o compile`\n', { 'design.md': '## Context\n\n- 读过 src/A.java\n', 'specs/x/spec.md': '## ADDED Requirements\n' });
  const chgB = mkChange(proj, 'other-window-change', '- [x] 1.1 改 src/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/A.java；验：`mvn -q -o compile`\n');
  markReviewed(chgA); markReviewed(chgB);
  H.setConfig(h, { autoMode: true });
  const prompt = (sid, text) => H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: tfile, prompt: text });
  const flow = (sid) => readJson(path.join(h.kit, 'state', sid + '-flow.json'));
  const stop = (sid, entries, said) => H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: false, last_assistant_message: said || '做完了' });
  const ask = (sid) => H.hook(h, 'guard-ask', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '要不要接着做？', options: [{ label: '要' }, { label: '不要' }] }] } });
  // 议题原样：只敲了 /ttls-onboard
  const s1 = 's-onboard';
  H.transcript(tfile, [H.tr.user('/ttls-onboard')]);
  prompt(s1, '/ttls-onboard');
  H.ok('敲 /ttls-onboard：这一轮不在流程里', flow(s1).on === false, flow(s1));
  const r1 = stop(s1, [H.tr.user('/ttls-onboard'), H.tr.ran('Read', { file_path: path.join(chgA, 'tasks.md') }, 'x'), H.tr.say('项目说明核过了')], '项目说明核过了，命令都能跑通');
  H.ok('议题原样：收工时不催"直接开始 /opsx:apply"', !/直接开始 \/opsx:apply/.test(H.reasonOf(r1)) && !/全自动模式/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('不在流程里：提问框照常能用，不出全自动报告', ask(s1) === null && !/全自动报告/.test(H.reasonOf(r1)));
  prompt(s1, '你在干嘛我不是只执行了 /ttls-onboard 吗');
  H.ok('用户问了一句：还是不在流程里', flow(s1).on === false, flow(s1));
  // 用户的原话：全自动开着，另开一个窗口做检索
  const s2 = 's-search';
  prompt(s2, '帮我查一下 EcCertificateMainController 在哪些地方被调用');
  const r2 = stop(s2, [H.tr.user('帮我查一下 EcCertificateMainController 在哪些地方被调用'), H.tr.ran('Grep', { pattern: 'EcCertificateMainController', path: proj }, 'x'), H.tr.say('查到 3 处')], '查到 3 处：……');
  H.ok('另一个窗口做检索：收工时不去接着做没做完的变更', r2 === null && flow(s2).on === false, H.reasonOf(r2));
  // 敲 /opsx:apply：在流程里
  const s3 = 's-apply';
  prompt(s3, '/opsx:apply add-ec-expiry-remind');
  H.ok('敲 /opsx:apply：进了流程，点名的变更记下了', flow(s3).on === true && (flow(s3).changes || []).includes(S.normKey(chgA)), flow(s3));
  H.ok('流程里：提问框被拦', (ask(s3) || {}).decision === 'block');
  const r3 = stop(s3, [H.tr.user('/opsx:apply add-ec-expiry-remind'), H.tr.ran('Read', { file_path: path.join(chgA, 'tasks.md') }, 'x'), H.tr.ran('Read', { file_path: path.join(chgB, 'tasks.md') }, 'x'), H.tr.say('读完了')], '读完了');
  H.ok('流程里：催的是这个会话在流程里做的那个变更', /全自动模式：我已经说了开工，add-ec-expiry-remind 的提案也审过了/.test(H.reasonOf(r3)) && !/other-window-change/.test(H.reasonOf(r3)), H.reasonOf(r3));
  // 流程里插了一句问话，再说"继续"
  prompt(s3, '这个变更为什么要加两个字段？');
  H.ok('流程里插一句问话：这一轮不在流程里', flow(s3).on === false && flow(s3).was > 0, flow(s3));
  H.ok('问话的这一轮：提问框能用', ask(s3) === null);
  prompt(s3, '继续');
  H.ok('再说"继续"：接回流程', flow(s3).on === true, flow(s3));
  prompt(s3, '3.3 我执行过了，接着归档');
  H.ok('流程里说了一句不是问句的话：还在流程里', flow(s3).on === true, flow(s3));
  prompt(s3, '/ttls-cross-review add-ec-expiry-remind');
  H.ok('流程里自己敲 /ttls-cross-review：跟上一轮一样', flow(s3).on === true);
  prompt(s3, '等等，先停一下');
  H.ok('说"等等"：出了流程', flow(s3).on === false);
  // 没在流程里的会话说"继续"：不算
  const s4 = 's-cont';
  prompt(s4, '继续');
  H.ok('从来没进过流程的会话说"继续"：不算', flow(s4).on === false, flow(s4));
  prompt(s4, '新增一个证照临期提醒的功能，要发短信');
  H.ok('提了一条要走提案的需求：进流程', flow(s4).on === true && /提了需求/.test(flow(s4).why), flow(s4));
  // 任务全打了勾、等着复审和归档的变更：点了它的名字也算进流程（端到端测出来的：第二个会话说这句话没进流程，不催也不交报告）
  const s8 = 's-named-done';
  mkChange(proj, 'a1-done', '- [x] 1.1 改 src/A.java；验：`mvn -q -o compile`\n');
  prompt(s8, '接着做：复审 a1-done 的代码，没问题就归档');
  H.ok('点了名的变更任务全打了勾、还没归档：也算进流程', flow(s8).on === true && /点了变更 a1-done/.test(flow(s8).why) && (flow(s8).changes || []).some((d) => /a1-done$/.test(d)), flow(s8));
  // /opsx:apply 没带名字：它照 OpenSpec 的步骤先跑 openspec status --change <名字>，这个变更就算它在流程里做的；只是读过 tasks.md 的不算
  const s9 = 's-apply-noname';
  prompt(s9, '/opsx:apply');
  const r9 = stop(s9, [H.tr.user('/opsx:apply'), H.tr.ran('Bash', { command: 'openspec status --change "add-ec-expiry-remind" --json' }, '{}'), H.tr.ran('Read', { file_path: path.join(chgB, 'tasks.md') }, 'x'), H.tr.say('看完了')], '看完了');
  H.ok('多个变更时无名 apply 不创建实施许可', !S.readConfigFor({ cwd: proj, session_id: s9 }).autoMode && !/我已经说了开工/.test(H.reasonOf(r9)), [H.reasonOf(r9), flow(s9)]);
  // 大白话让它出提案：它自己调了 OpenSpec 的技能、建了变更
  const s5 = 's-skill';
  prompt(s5, '看一下这个');
  H.hook(h, 'guard-ask', { session_id: s5, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'openspec-propose' } });
  H.ok('它自己调了 OpenSpec 的技能：从这时起算进了流程', flow(s5).on === true && /调了 openspec-propose/.test(flow(s5).why), flow(s5));
  const s6 = 's-newchange';
  prompt(s6, '看一下这个');
  H.hook(h, 'guard-commit', { session_id: s6, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'openspec new change add-something' } });
  H.ok('它建了变更：从这时起算进了流程', flow(s6).on === true && /建了变更/.test(flow(s6).why), flow(s6));
  // 在流程里写了变更的产物：记成这个会话做的
  const s7 = 's-touch';
  prompt(s7, '/opsx:propose 加一个临期提醒');
  H.hook(h, 'pre-edit', { session_id: s7, transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(chgB, 'revisions.md'), old_string: 'a', new_string: 'b' } });
  H.ok('流程里写了变更的产物：记成这个会话动手做的', (flow(s7).changes || []).includes(S.normKey(chgB)), flow(s7));
  // 这一轮做到一半才在配置页打开全自动：照这一轮开头定的算（开关关着的时候也记）
  H.setConfig(h, { autoMode: false });
  const s10 = 's-switch-later';
  prompt(s10, '/opsx:apply add-ec-expiry-remind');
  prompt('s-switch-later-q', '这个接口为什么返回 500？');
  H.ok('开关关着的时候也记下了这一轮在不在流程里，提问框照常能用', flow(s10).on === true && flow('s-switch-later-q').on === false && ask(s10) === null);
  H.setConfig(h, { autoMode: true });
  H.ok('做到一半才打开全自动：开头是 /opsx:apply 的那一轮算在流程里，开头是一句问话的不算', (ask(s10) || {}).decision === 'block' && ask('s-switch-later-q') === null);
  // 装这一版之前就开着的会话（没有流程记录，之后也没再开过口）：照以前的算法接过来
  const s12 = 's-old-session';
  fs.writeFileSync(path.join(h.kit, 'state', s12 + '-changes.json'), JSON.stringify({ dirs: [S.normKey(chgA)], at: Date.now() }));
  H.ok('旧会话保留变更事实但不恢复 apply 许可', ask(s12) === null && flow(s12).on === true && flow(s12).stage === 'plan' && !S.readConfigFor({ cwd: proj, session_id: s12 }).autoMode, flow(s12));
  H.ok('没动过变更的老会话：不算', ask('s-old-idle') === null && flow('s-old-idle').on === false, flow('s-old-idle'));
  prompt(s12, '继续');
  H.ok('它再开口说"继续"：接着在流程里', flow(s12).on === true, flow(s12));
  const s13 = 's-old-session2';
  fs.writeFileSync(path.join(h.kit, 'state', s13 + '-changes.json'), JSON.stringify({ dirs: [S.normKey(chgA)], at: Date.now() }));
  prompt(s13, '继续');
  H.ok('老会话头一回开口就说"继续"：也接得上', flow(s13).on === true && (flow(s13).changes || []).includes(S.normKey(chgA)), flow(s13));
  // 会话开始时的说明
  const ss = H.hook(h, 'session-start', { session_id: 's-ss', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tfile });
  H.ok('会话开始时说清了：只在走 OpenSpec 流程时算数，别的时候不要自己去接着做', /全自动模式开着，只管 OpenSpec 变更做任务的那一段/.test(H.reasonOf(ss)) && /不要自己去接着做/.test(H.reasonOf(ss)), H.reasonOf(ss).slice(0, 600));
  // 查库、查 redis 的工具：跑之前留一张条子，说这个会话算不算全自动
  const tk = () => ((readJson(path.join(h.kit, 'state', 'tool-flow.json')).byCwd || {})[S.normKey(proj)]) || {};
  H.hook(h, 'guard-commit', { session_id: s3, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'python "$HOME/.claude/skills/ttls-db-crud/scripts/db.py" --conn dev exec --sql-file .vibe/tmp/x/a.sql' } });
  H.ok('不在流程里的会话跑查库的工具：条子上写着不算全自动', tk().auto === false && tk().at > 0, tk());
  prompt(s3, '/opsx:apply add-ec-expiry-remind');
  H.hook(h, 'guard-commit', { session_id: s3, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node "$HOME/.claude/skills/ttls-redis/scripts/redis.js" --conn dev set k v' } });
  H.ok('在流程里的会话跑：条子上写着算', tk().auto === true, tk());
  H.setConfig(h, { autoMode: false });
  dropState('tool-flow');
  H.hook(h, 'guard-commit', { session_id: s3, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'python db.py --conn dev query --sql "select 1"' } });
  H.ok('全自动模式关着：不留条子', !fs.existsSync(path.join(h.kit, 'state', 'tool-flow.json')));
}

// =============================================================================================
H.section('令牌保护：整条命令只是列名字、过滤名单的不拦（议题 #9 附的流水账里被拦的三条只读命令）');
{
  // 假的令牌、假的 key：只用来占位置，看读它们的命令拦不拦
  fs.mkdirSync(path.join(h.kit, 'router-data'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlab: { token: 'TEST-MARKER-NOT-A-TOKEN' } }));
  fs.writeFileSync(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ providers: [{ name: 'x', api_key: 'TEST-MARKER-NOT-A-KEY' }] }));
  const proj = H.makeRepo(path.join(h.work, 'ro'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  H.setConfig(h, { autoMode: true });
  const sid = 's-ro';
  H.inFlow(h, sid);
  const R = require(path.join(h.kit, 'lib', 'report.js'));
  R.begin({ session_id: sid, cwd: proj });
  const run = (cmd, tool) => H.hook(h, 'guard-commit', { session_id: sid, cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool || 'Bash', tool_input: { command: cmd } });
  const blocked = (o) => !!o && (o.decision === 'block' || (!!o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny'));
  for (const c of [
    'ls -la "$HOME/.claude/vibe-kit/" 2>&1 | head -30',
    'find "$HOME/.claude/vibe-kit" -maxdepth 2 -iname "README*"',
    'find "$HOME/.claude" -maxdepth 1 -iname "*.md" 2>/dev/null',
    'ls "$HOME/.claude/vibe-kit" | grep -i readme',
    'ls ~/.claude/vibe-kit && cat ~/.claude/vibe-kit/VERSION',
    'find ~/.claude/vibe-kit/router-data -type f | sort | tail -5',
    'tree ~/.claude/vibe-kit | head -40',
  ]) { const o = run(c); H.ok('放行：' + c.slice(0, 70), o === null, H.reasonOf(o)); }
  H.ok('放行的这几条没有记成"留给你做的"', !R.stateOf({ session_id: sid }).items.some((x) => x.kind === 'hand'), R.stateOf({ session_id: sid }).items);
  // 列完接着去读的、别的能把文件读出来的写法：照样拦
  for (const c of [
    'ls ~/.claude/vibe-kit | xargs cat',
    'find ~/.claude/vibe-kit -name "*.json" | xargs grep token',
    'find ~/.claude/vibe-kit -type f -exec cat {} +',
    'cat $(ls ~/.claude/vibe-kit/secrets.json)',
    'for f in $(ls ~/.claude/vibe-kit); do cat "$HOME/.claude/vibe-kit/$f"; done',
    'ls ~/.claude/vibe-kit | while read f; do cat "$HOME/.claude/vibe-kit/$f"; done',
    'ls ~/.claude/vibe-kit | head -3; cat ~/.claude/vibe-kit/secrets.json',
    'find ~/.claude/vibe-kit -type f | sort --files0-from=-',
    'find ~/.claude/vibe-kit -type f | cpio -o',
    'find ~/.claude/vibe-kit -type f | tar -T - -cf x.tar',
    'ls ~/.claude/vibe-kit | head | bash',
    'env ls ~/.claude/vibe-kit | head',
    'grep -r token ~/.claude/vibe-kit | head',
    'head -5 ~/.claude/vibe-kit/router-data/config.json',
    'cat < ~/.claude/vibe-kit/secrets.json | head',
    'cat ~/.claude/vibe-kit/*.json | head',
    'ls ~/.claude/vibe-kit/router-data/ | head; cat ~/.claude/vibe-kit/router-data/config.json',
  ]) { const o = run(c); H.ok('照样拦：' + c.slice(0, 70), blocked(o), H.reasonOf(o) || o); }
  H.ok('PowerShell 里列完交给 Get-Content：照样拦', blocked(run('Get-ChildItem "' + h.kit + '" | Get-Content', 'PowerShell')) && run('Get-ChildItem "' + h.kit + '" | Select-Object -First 30', 'PowerShell') === null);
  H.setConfig(h, { autoMode: false });
}

// =============================================================================================
H.section('过程文件：变更没归档之前先留着');
{
  const proj = H.makeRepo(path.join(h.work, 'keep'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const chg = mkChange(proj, 'add-remind', '- [x] 1.1 改 src/A.java；验：`mvn -q -o compile`\n- [ ] 1.2 改 src/A.java；验：`mvn -q -o compile`\n');
  for (const d of ['add-remind', 'add-remind-sm2', '0930-排查', 'old-done']) H.write(path.join(proj, '.vibe', 'tmp', d, 'probe.js'), '// x\n');
  H.write(path.join(proj, '.vibe', 'out', 'add-remind-sm2', 'result.json'), '{}\n');
  H.write(path.join(proj, '.vibe', 'out', 'login', 'result.json'), '{}\n');
  fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive', '2026-09-29-old-done'), { recursive: true });
  const sid = 's-keep';
  const run = (cmd, tool, cwd, s) => H.hook(h, 'guard-commit', { session_id: s || sid, cwd: cwd || proj, hook_event_name: 'PreToolUse', tool_name: tool || 'Bash', tool_input: { command: cmd } });
  const r1 = run('rm -rf .vibe/tmp/add-remind');
  H.ok('删没归档的变更的过程文件：拦，说了归档之后套件自己清', r1 && r1.decision === 'block' && /是变更 add-remind 的过程文件，变更还没归档，先留着/.test(H.reasonOf(r1)) && /归档之后套件自己清/.test(H.reasonOf(r1)) && !/拦截编号/.test(H.reasonOf(r1)), H.reasonOf(r1));
  H.ok('里面的单个文件、以变更名开头的目录、结果目录也一样', (run('rm .vibe/tmp/add-remind/probe.js') || {}).decision === 'block' && (run('rm -rf "' + path.join(proj, '.vibe', 'tmp', 'add-remind-sm2').replace(/\\/g, '/') + '"') || {}).decision === 'block' && (run('rm -rf .vibe/out/add-remind-sm2/') || {}).decision === 'block');
  H.ok('PowerShell 的 Remove-Item 也认', (run('Remove-Item -Recurse -Force .vibe\\tmp\\add-remind', 'PowerShell') || {}).decision === 'block' && (run('Remove-Item -LiteralPath .vibe\\tmp\\add-remind\\probe.js', 'PowerShell') || {}).decision === 'block');
  H.ok('整个 tmp、用通配符删一批、find -delete：里面有变更的就拦', (run('rm -rf .vibe/tmp') || {}).decision === 'block' && (run('rm -rf .vibe/tmp/*') || {}).decision === 'block' && (run('find .vibe/tmp -name "*.js" -delete') || {}).decision === 'block' && /里有变更 add-remind 的过程文件/.test(H.reasonOf(run('rm -rf .vibe/tmp/*'))), H.reasonOf(run('rm -rf .vibe/tmp/*')));
  H.ok('别的事由的过程文件，那件事做完就删：不拦', run('rm -rf .vibe/tmp/0930-排查') === null && run('rm -rf .vibe/out/login') === null);
  H.ok('已经归档的变更的、.vibe 里别的东西、项目里的文件：不管', run('rm -rf .vibe/tmp/old-done') === null && run('rm -f .vibe/run/x.log') === null && run('rm -f target/classes/A.class') === null);
  H.ok('挪走、覆盖不管', run('mv .vibe/tmp/add-remind/probe.js .vibe/tmp/add-remind/probe2.js') === null);
  // 全自动、在流程里：流程没走完，别的事由的也先留着
  H.setConfig(h, { autoMode: true });
  const sa = 's-keep-auto';
  H.inFlow(h, sa, [chg]);
  const R = require(path.join(h.kit, 'lib', 'report.js'));
  R.begin({ session_id: sa, cwd: proj });
  const a1 = run('rm -rf .vibe/tmp/0930-排查', 'Bash', proj, sa);
  H.ok('全自动、流程没走完：别的事由的也先留着', a1 && a1.decision === 'block' && /全自动模式：OpenSpec 流程还没走完（变更 add-remind 还没归档）/.test(H.reasonOf(a1)) && /接着做下一步/.test(H.reasonOf(a1)), H.reasonOf(a1));
  H.ok('这道拦截不记成"留给用户做的"，也不说"不要停下等我"', !R.stateOf({ session_id: sa }).items.some((x) => x.kind === 'hand') && !/不要停下等我/.test(H.reasonOf(a1)), R.stateOf({ session_id: sa }).items);
  const sb = 's-keep-auto2';
  H.inFlow(h, sb, []);
  H.ok('全自动、变更还没建：也先留着', (run('rm -rf .vibe/out/login', 'Bash', proj, sb) || {}).decision === 'block');
  // 不在流程里的会话（开关开着）：只管变更的
  H.ok('开关开着、这个会话不在流程里：别的事由的照常能删', run('rm -rf .vibe/tmp/0930-排查', 'Bash', proj, 's-keep-idle') === null);
  // 归档之后：这个变更的能删了；流程走完了，别的也能删
  fs.renameSync(chg, path.join(proj, 'openspec', 'changes', 'archive', '2026-09-30-add-remind'));
  H.ok('归档之后：不拦了', run('rm -rf .vibe/tmp/add-remind', 'Bash', proj, sa) === null && run('rm -rf .vibe/tmp/0930-排查', 'Bash', proj, sa) === null);
  H.setConfig(h, { autoMode: false });
  // 归档之后套件自己清：收工时清掉已归档变更的临时目录，没归档的留着
  const chg2 = mkChange(proj, 'still-open', '- [ ] 1.1 改 src/A.java；验：`mvn -q -o compile`\n');
  H.write(path.join(proj, '.vibe', 'tmp', 'still-open', 'a.sql'), 'select 1\n');
  const stop = H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, [H.tr.user('归档'), H.tr.say('归档好了')]), stop_hook_active: false, last_assistant_message: '归档好了' });
  const has = (...p) => fs.existsSync(path.join(proj, '.vibe', ...p));
  H.ok('收工时：已归档变更的临时目录清掉了，没归档的、别的事由的留着', !has('tmp', 'add-remind') && !has('tmp', 'old-done') && has('tmp', 'still-open', 'a.sql') && has('tmp', '0930-排查'), [fs.readdirSync(path.join(proj, '.vibe', 'tmp')), H.reasonOf(stop)]);
  H.ok('以变更名开头的目录、.vibe/out 里这个变更的结果也一起清了；别的结果留着', !has('tmp', 'add-remind-sm2') && !has('out', 'add-remind-sm2') && has('out', 'login', 'result.json'), [fs.readdirSync(path.join(proj, '.vibe', 'tmp')), fs.readdirSync(path.join(proj, '.vibe', 'out'))]);
  // 归档之后接着修问题，事由还写这个变更名：归档之后才动过的目录不清（不然每次收工都被清掉）
  H.write(path.join(proj, '.vibe', 'tmp', 'add-remind', 'fix-probe.js'), '// 归档后修问题\n');
  const later = new Date(Date.now() + 5 * 60000);
  fs.utimesSync(path.join(proj, '.vibe', 'tmp', 'add-remind', 'fix-probe.js'), later, later);
  H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: tfile, stop_hook_active: false, last_assistant_message: '修好了，没验证：只是个探针' });
  H.hook(h, 'session-start', { session_id: 's-keep-next', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tfile });
  H.ok('归档之后才建的同名目录（接着修问题）：收工、下个会话开始都不清', has('tmp', 'add-remind', 'fix-probe.js'), fs.readdirSync(path.join(proj, '.vibe', 'tmp')));
  // 一个变更的名字是另一个的开头：add-x 还在做，add-x-excel 归档了
  mkChange(proj, 'add-x', '- [ ] 1.1 改 src/A.java；验：`mvn -q -o compile`\n');
  fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive', '2026-09-29-add-x-excel'), { recursive: true });
  H.write(path.join(proj, '.vibe', 'tmp', 'add-x-excel-测试', 'a.js'), '// x\n');
  H.write(path.join(proj, '.vibe', 'tmp', 'add-x-probe', 'a.js'), '// x\n');
  H.ok('目录名两边都对得上：算名字更长的那个变更的', run('rm -rf .vibe/tmp/add-x-excel-测试') === null && (run('rm -rf .vibe/tmp/add-x-probe') || {}).decision === 'block' && /变更 add-x 的过程文件/.test(H.reasonOf(run('rm -rf .vibe/tmp/add-x-probe'))), H.reasonOf(run('rm -rf .vibe/tmp/add-x-probe')));
  H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: tfile, stop_hook_active: false, last_assistant_message: '做完了，没验证：没改代码' });
  H.ok('收工时也一样：归档了的那个的清掉，还在做的那个的留着', !has('tmp', 'add-x-excel-测试') && has('tmp', 'add-x-probe', 'a.js'), fs.readdirSync(path.join(proj, '.vibe', 'tmp')));
  // 会话开始时的自动清理：没归档的变更的目录放了多少天都不清
  const tidy = require(path.join(h.kit, 'lib', 'tidy.js'));
  const old = new Date(Date.now() - 30 * 86400000);
  for (const d of ['still-open', '0930-排查']) { for (const n of fs.readdirSync(path.join(proj, '.vibe', 'tmp', d))) fs.utimesSync(path.join(proj, '.vibe', 'tmp', d, n), old, old); fs.utimesSync(path.join(proj, '.vibe', 'tmp', d), old, old); }
  const gone = tidy.cleanTmp([proj], 7, [], ['still-open']);
  H.ok('三十天没动：别的事由的清掉，没归档的变更的留着', gone.length === 1 && /0930/.test(gone[0].dir) && fs.existsSync(path.join(proj, '.vibe', 'tmp', 'still-open', 'a.sql')), gone);
  H.ok('同名的变更归档之后又建了一个：算新的那个的，不清', tidy.cleanTmp([proj], 7, ['still-open'], ['still-open']).length === 0 && fs.existsSync(path.join(proj, '.vibe', 'tmp', 'still-open')));
  void chg2;
}

// =============================================================================================
H.section('#7 全自动报告："它自己定的事"和"库里改过的"');
{
  const proj = H.makeRepo(path.join(h.work, 'rep'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', '.gitignore': '.vibe/\n' });
  const seven = Array.from({ length: 7 }, (_, i) => '## 2026-09-30 1' + i + ':00 · 探索 → 写提案\n- 起因：自动模式决定。默认按第 ' + (i + 1) + ' 种做\n- 改了：proposal.md\n- 上层：不用改\n').join('\n');
  const chg = mkChange(proj, 'add-ec-expiry-remind', '- [ ] 1.1 改 src/A.java；验：`mvn -q -o compile`\n', { 'revisions.md': '# 修订记录\n\n' + seven });
  markReviewed(chg);
  H.setConfig(h, { autoMode: true });
  const sid = 's-rep';
  H.inFlow(h, sid, [chg]);
  fs.writeFileSync(path.join(h.kit, 'state', sid + '-changes.json'), JSON.stringify({ dirs: [S.normKey(chg)], at: Date.now() }));
  const R = require(path.join(h.kit, 'lib', 'report.js'));
  R.begin({ session_id: sid, cwd: proj });
  // 查库的工具留的痕：这一轮里全自动改过的库（假用户目录的 ~/.db-crud 里）
  const jr = path.join(h.home, '.db-crud', 'journal', 'dev');
  const p2 = (n) => String(n).padStart(2, '0');
  const stampOf = (d) => d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-000';
  const entry = (kind, op, when) => { const d = path.join(jr, stampOf(when || new Date()) + '-' + kind); H.write(path.join(d, 'op.json'), JSON.stringify(Object.assign({ connection: 'dev', kind: kind.toUpperCase(), auto: true, project: proj, result: { ok: true, affected_rows: 2 } }, op))); H.write(path.join(d, 'undo.sql'), '-- x\n'); return d; };
  entry('insert', { table: 'SYS_DICT', inserted: { table: 'SYS_DICT', pk: ['ID'], ids: [["'ec_remind_1'"], ["'ec_remind_2'"]], source: '语句里写明的' } });
  entry('update', { table: 'EC_CERT', result: { ok: true, affected_rows: 3 } }, new Date(Date.now() + 1000));
  entry('create', { table: 'EC_REMIND_LOG', created: { kind: 'TABLE', name: 'EC_REMIND_LOG' }, result: { ok: true, affected_rows: 0 } }, new Date(Date.now() + 2000));
  entry('delete', { table: 'OTHER_PROJ', project: path.join(h.work, 'rev') }, new Date(Date.now() + 3000));          // 别的项目里做的
  entry('delete', { table: 'NOT_AUTO', auto: false }, new Date(Date.now() + 4000));                                   // 有人在的时候做的
  entry('delete', { table: 'LAST_NIGHT' }, new Date(Date.now() - 3 * 3600000));                                       // 这一轮之前做的
  const r = H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, [H.tr.user('继续'), H.tr.say('提案审后修订做完了')]), stop_hook_active: true, last_assistant_message: '提案审后修订做完了' });
  const text = H.reasonOf(r);
  const file = (text.match(/报告在 (.+?\.md)/) || [])[1] || '';
  const body = file ? H.read(file) || '' : '';
  H.ok('交了全自动报告', /^\[vibe-kit 全自动报告\]/.test(text) && !!body, text.slice(0, 300));
  H.ok('议题 #7 原样：这一轮没有新定的，说清以前几轮定过 7 条、在哪', /## 它自己定的事\n\n这一轮没有新定的。以前几轮定过的还在各自的 revisions\.md 里（起因：自动模式决定）：add-ec-expiry-remind 7 条。/.test(body) && !/revisions\.md 里没有/.test(body), (body.match(/## 它自己定的事[\s\S]{0,200}/) || [''])[0]);
  const db = (body.match(/## 库里改过的\n\n([\s\S]*?)\n\n## /) || [])[1] || '';
  H.ok('库里改过的：这一轮、这个项目里、全自动做的三次都列了，别的不列', (db.match(/^- /gm) || []).length === 3 && !/OTHER_PROJ|NOT_AUTO|LAST_NIGHT/.test(db), db);
  H.ok('新增的：表、几行、主键，还有删掉它的命令', /往 SYS_DICT 新增了 2 行，主键 ID：'ec_remind_1'、'ec_remind_2'。要删掉这次新增的：db\.py --conn dev exec --undo "~/.test(db), db);
  H.ok('改的：几行、改前快照和还原脚本在哪、怎么还原', /改了 EC_CERT 3 行。改前快照和还原脚本在 ~[\\/]\.db-crud[\\/]journal[\\/]dev[\\/][^\n]*-update。要还原：db\.py --conn dev exec --undo/.test(db), db);
  H.ok('建表的：还原脚本是 DROP，要用户自己执行', /建了 TABLE EC_REMIND_LOG。还原脚本（对应的 DROP，要你自己看过再执行）：~[\\/]\.db-crud[\\/][^\n]*undo\.sql/.test(db), db);
  H.ok('给模型看的短版里也有；数的那张表里有这一行', /库里改过的 3 件/.test(text) && /\| 库里改过的 \| 3 \|/.test(body), text.slice(0, 900));
  H.ok('让它照七节交代，第三节是库里改过的', /3\. 库里改过的（哪张表、几行、新增的主键、还原脚本在哪）/.test(text) && /7\. 套件问题/.test(text), text.slice(-500));
  // 这一轮新定了一条：列新的，以前的不重复列
  fs.appendFileSync(path.join(chg, 'revisions.md'), '\n## 2026-09-30 19:00 · 审后修订\n- 起因：自动模式决定。校验表达式加数字约束\n- 改了：design.md\n- 上层：不用改\n');
  R.note({ session_id: sid, cwd: proj }, { kind: 'bypass', title: '归档门槛：x', detail: 'y' });
  const r2 = H.hook(h, 'verify-gate', { session_id: sid, cwd: proj, hook_event_name: 'Stop', transcript_path: tfile, stop_hook_active: true, last_assistant_message: '又改了一处' });
  const body2 = H.read(((H.reasonOf(r2).match(/报告在 (.+?\.md)/) || [])[1]) || '') || '';
  H.ok('这一轮新定了一条：列新的那条，以前的 7 条只提一句', /校验表达式加数字约束/.test(body2) && /以前几轮定过的不重复列：add-ec-expiry-remind 7 条/.test(body2) && !/默认按第 1 种做/.test(body2), (body2.match(/## 它自己定的事[\s\S]{0,400}/) || [''])[0]);
  H.setConfig(h, { autoMode: false });
}

// =============================================================================================
H.section('工具的调用记录里的错：每天汇总一次，记成问题反馈');
{
  const T = require(path.join(h.kit, 'lib', 'toolstats.js'));
  const F = require(path.join(h.kit, 'lib', 'feedback.js'));
  const log = path.join(h.kit, 'state', 'tool-usage.jsonl');
  for (const n of ['tool-stats', 'tool-usage-pos']) dropState(n);
  const line = (o) => JSON.stringify(Object.assign({ at: Date.now(), exit: 2, ms: 900, java: 1, project: 'p' }, o)) + '\n';
  fs.writeFileSync(log, line({ tool: 'ttls-db-crud', cmd: 'query', dialect: 'dm', errors: ['SQL_ERROR:42S02:-2106'] }) + line({ tool: 'ttls-db-crud', cmd: 'query', dialect: 'dm', errors: ['SQL_ERROR:42S02:-2106'] })
    + line({ tool: 'ttls-db-crud', cmd: 'peek', dialect: 'dm', errors: ['SQL_ERROR:42S02:-2106'] }) + line({ tool: 'ttls-db-crud', cmd: 'exec', dialect: 'mysql', errors: ['BLOCKED'] , exit: 3 })
    + line({ tool: 'ttls-redis', cmd: 'get', errors: ['CONN_REFUSED'], exit: 0 }) + line({ tool: 'ttls-db-crud', cmd: 'peek', dialect: 'dm', errors: [], exit: 0 }));
  const n0 = F.listRecords().length;
  const first = T.ingest(null);
  H.ok('读进来了，还没到时候：先攒着，不记问题', first.usage === 6 && first.reported.length === 0 && F.listRecords().length === n0 && Object.keys(state('tool-stats').errs || {}).length === 2, [first, state('tool-stats').errs]);
  H.ok('被工具自己拦下的（BLOCKED）不算出错', !Object.keys(state('tool-stats').errs).some((k) => /BLOCKED/.test(k)), Object.keys(state('tool-stats').errs));
  H.ok('没满一天：不报', T.reportErrors(Date.now() + 23 * 3600000).length === 0);
  const ids = T.reportErrors(Date.now() + 25 * 3600000);
  const recs = F.listRecords().filter((r) => ids.includes(r.meta.id));
  const dm = recs.find((r) => /SQL_ERROR/.test(r.title)) || { meta: {}, text: '', title: '' };
  const rd = recs.find((r) => /CONN_REFUSED/.test(r.title)) || { meta: {}, text: '', title: '' };
  H.ok('满一天：一种错一条，类型是"工具报错"', ids.length === 2 && dm.meta['类型'] === '工具报错' && dm.meta['涉及'] === 'ttls-db-crud' && dm.title === '达梦 SQL_ERROR:42S02:-2106' && rd.meta['涉及'] === 'ttls-redis', recs.map((r) => [r.title, r.meta['类型'], r.meta['涉及']]));
  H.ok('写了次数、哪几条命令出的、这种错一般是怎么回事', /最近 25 小时出了 3 次（query 2 次、peek 1 次）/.test(dm.text) && /SQLSTATE 和厂商错误码/.test(dm.text) && /连不上/.test(rd.text), dm.text.slice(0, 500));
  H.ok('不算到任何会话头上，不带项目名', !dm.meta['会话'] && dm.meta['项目'] === '（不知道）', dm.meta);
  H.ok('报完清零，下一个周期重新攒', Object.keys(state('tool-stats').errs || {}).length === 0 && state('tool-stats').reportAt > 0, state('tool-stats'));
  const I = require(path.join(h.kit, 'lib', 'issues.js'));
  H.ok('会跟着问题上报传到 GitLab（不算"不是问题的"）', !F.isNoise(dm) && typeof I.sync === 'function');
  // 下一个周期又出了同一种错：还是那一条，后面加一句
  fs.appendFileSync(log, line({ tool: 'ttls-db-crud', cmd: 'query', dialect: 'dm', errors: ['SQL_ERROR:42S02:-2106'] }));
  T.ingest(null);
  const ids2 = T.reportErrors(Date.now() + 26 * 3600000);
  const again = F.listRecords().find((r) => r.meta.id === dm.meta.id);
  H.ok('同一种错再出现：还是那一条，次数加一，后面记了这一段出了几次', ids2.length === 1 && ids2[0] === dm.meta.id && Number(again.meta['次数']) === 2 && /## 又出现了[\s\S]*出了 1 次（query 1 次）/.test(again.text), again.text.slice(-300));
  H.ok('没有新的错：什么都不报', T.reportErrors(Date.now() + 60 * 3600000).length === 0);
}

// =============================================================================================
H.section('提示规则去掉了');
{
  H.ok('开关里没有这一项了', !('hints' in S.DEFAULT_CONFIG) && typeof S.matchHints === 'undefined');
  const api = require(path.join(H.SRC, 'router', 'kit-api.js'));
  const c = api.cleanConfig({ hints: [{ name: 'x', prompt: '表结构', say: '用查库的技能' }], autoVerify: false }, { hints: [{ name: 'old', files: '.sql', say: 'y' }] });
  H.ok('配置页保存时不再收这一项，文件里以前存的也不写回去', !('hints' in c) && c.autoVerify === false && !('hints' in api.DEFAULT_CONFIG), c);
  H.ok('配置页的默认开关和套件的一样', JSON.stringify(Object.keys(api.DEFAULT_CONFIG).sort()) === JSON.stringify(Object.keys(S.DEFAULT_CONFIG).sort()) && Object.keys(S.DEFAULT_CONFIG).every((k) => JSON.stringify(S.DEFAULT_CONFIG[k]) === JSON.stringify(api.DEFAULT_CONFIG[k])));
  // 以前的开关文件里有提示规则：用户开口、读文件时不再带提醒
  fs.writeFileSync(path.join(h.kit, 'config.json'), JSON.stringify(Object.assign(readJson(path.join(h.kit, 'config.json')), { hints: [{ name: '表结构', prompt: '表结构', files: '.sql', say: '表结构用查库的技能查' }] })));
  const proj = H.makeRepo(path.join(h.work, 'nohint'), { 'a.sql': 'select 1\n' });
  H.transcript(tfile, [H.tr.user('看一下表结构')]);
  const p = H.hook(h, 'task-anchor', { session_id: 's-hint', cwd: proj, hook_event_name: 'UserPromptSubmit', transcript_path: tfile, prompt: '看一下表结构' });
  H.ok('消息里出现了以前规则里的词：不再带提醒', !/表结构用查库的技能查/.test(H.reasonOf(p)), H.reasonOf(p));
  const sh = H.hook(h, 'source-hint', { session_id: 's-hint', cwd: proj, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(proj, 'a.sql') } });
  H.ok('读文件提醒的钩子留成了空壳：载得进来、什么都不说（老版本的自动更新装完自检要载它）', sh === null && typeof require(path.join(h.kit, 'hooks', 'source-hint.js')).handle === 'function');
  // 以前登记过读文件提醒的：同步一次就摘掉了
  const settings = path.join(h.cfg, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read|Grep|Glob', hooks: [{ type: 'command', command: 'node "' + path.join(h.kit, 'hooks', 'source-hint.js').split(path.sep).join('/') + '"' }] }, { matcher: 'Write', hooks: [{ type: 'command', command: 'node my-own-hook.js' }] }] } }, null, 2));
  const sync = H.node(h, path.join(h.kit, 'install.js'), ['--sync']);
  const after = readJson(settings);
  const post = JSON.stringify((after.hooks || {}).PostToolUse || []);
  H.ok('同步之后：读文件提醒的登记摘掉了，用户自己的钩子还在', sync.code === 0 && !/source-hint/.test(post) && /my-own-hook/.test(post), [sync.out + sync.err, post]);
  H.ok('别的钩子照常登记着（提问框那一道也管调技能）', /AskUserQuestion\|Skill\|SlashCommand/.test(JSON.stringify(after.hooks.PreToolUse)) && !!after.hooks.Stop, JSON.stringify(after.hooks).slice(0, 600));
  void os;
}

H.done('内网反馈 0930');

'use strict';
/*
 * 改名（ttls- 前缀）和并进来的两个技能：从上一版升上来会怎样。
 *   旧名字的技能、代理删掉（改过的先备份），不是套件装的同名技能不动
 *   以前单独装的 urai-db-crud、redis 删掉（先备份），urai-db-crud 自带的驱动挪进套件的驱动目录并登记
 *   会话记录里的旧名字照样认；经验规则的文件改名，旧文件里的规则并进新文件
 * 用法：node dev/test-ttls.js <上一版的 vibe-kit 目录，20260929.2205 或更早>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness');

const OLD = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(OLD, 'install.js'))) { console.log('用法：node dev/test-ttls.js <上一版的 vibe-kit 目录>'); process.exit(2); }
const OLD_VERSION = (H.read(path.join(OLD, 'kit', 'VERSION')) || '').trim();

/** 拿一份代码当安装包用：补上看页面的依赖的占位目录（安装器要看到它们才肯装） */
function asPackage(name, from) {
  const dir = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(from, dir, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(dir);
  return dir;
}
const install = (h, pkg, args) => H.node(h, path.join(pkg, 'install.js'), ['--no-router', '--no-open'].concat(args || []), { cwd: h.root, timeout: 300000 });
const lsdir = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return []; } };
// 这台电脑上用户自己装的旧技能（只读地拷一份到假用户目录里）。没有就用最小的替身，驱动那几项不测
const REAL_DBCRUD = path.join(os.homedir(), '.claude', 'skills', 'urai-db-crud');
const REAL_REDIS = path.join(os.homedir(), '.claude', 'skills', 'redis');
const HAS_REAL = fs.existsSync(path.join(REAL_DBCRUD, 'drivers')) && lsdir(path.join(REAL_DBCRUD, 'drivers')).some((n) => /\.jar$/.test(n));

(async () => {
  const oldPkg = asPackage('ttls-old', OLD);
  const newPkg = asPackage('ttls-new', H.SRC);
  console.log('    上一版 ' + OLD_VERSION + '；这台电脑上' + (HAS_REAL ? '有' : '没有') + '用户自己装的 urai-db-crud（带驱动）');

  H.section('包里的东西');
  const all = fs.readdirSync(newPkg, { recursive: true }).map((x) => String(x).replace(/\\/g, '/'));
  H.ok('安装包里没有 jar（驱动不随包带）', !all.some((f) => /\.jar$/i.test(f) && !/node_modules/.test(f)), all.filter((f) => /\.jar$/i.test(f)));
  H.ok('技能的名字都带 ttls- 前缀', JSON.stringify(lsdir(path.join(newPkg, 'claude', 'skills'))) === JSON.stringify(['ttls-cross-review', 'ttls-db-crud', 'ttls-handover', 'ttls-onboard', 'ttls-redis', 'ttls-see-page']) && JSON.stringify(lsdir(path.join(newPkg, 'claude', 'agents'))) === '["ttls-reviewer.md"]', lsdir(path.join(newPkg, 'claude', 'skills')));
  for (const n of lsdir(path.join(newPkg, 'claude', 'skills'))) {
    const t = H.read(path.join(newPkg, 'claude', 'skills', n, 'SKILL.md')) || '';
    H.ok(n + '：说明里的名字和目录一样', new RegExp('^name: ' + n + '$', 'm').test(t), t.slice(0, 200));
  }
  const texts = all.filter((f) => /^(claude|kit\/hooks|kit\/lib|kit\/tools)\/.*\.(md|js)$/.test(f) && !/CHANGELOG/.test(f)).map((f) => [f, H.read(path.join(newPkg, f)) || '']);
  const stale = texts.filter(([, t]) => /(^|[^\w.\\/-])\/(cross-review|see-page|handover|onboard)\b(?!\.md)/.test(t.replace(/改名之前叫 \/handover/g, ''))).map(([f]) => f);
  H.ok('约定、技能、钩子的提示里没有旧的斜杠命令', stale.length === 0, stale);

  H.section('从上一版升上来');
  const h = H.freshHome('ttls-up');
  const i1 = install(h, oldPkg);
  H.ok('上一版装上了，技能是旧名字', i1.code === 0 && ['cross-review', 'handover', 'onboard', 'see-page'].every((n) => fs.existsSync(path.join(h.cfg, 'skills', n, 'SKILL.md'))) && fs.existsSync(path.join(h.cfg, 'agents', 'vibe-reviewer.md')), i1.out + i1.err);
  // 用户改过其中一个；另外有用户自己的技能，和以前单独装的两个
  fs.appendFileSync(path.join(h.cfg, 'skills', 'see-page', 'SKILL.md'), '\n我自己加的一句。\n');
  H.write(path.join(h.cfg, 'skills', 'my-own', 'SKILL.md'), '---\nname: my-own\ndescription: 我自己的\n---\n');
  if (HAS_REAL) H.copyDir(REAL_DBCRUD, path.join(h.cfg, 'skills', 'urai-db-crud'));
  else { H.write(path.join(h.cfg, 'skills', 'urai-db-crud', 'scripts', 'db.py'), '# x\n'); H.write(path.join(h.cfg, 'skills', 'urai-db-crud', 'scripts', 'sqlguard.py'), '# x\n'); H.write(path.join(h.cfg, 'skills', 'urai-db-crud', 'SKILL.md'), '---\nname: urai-db-crud\n---\n'); }
  if (fs.existsSync(REAL_REDIS)) H.copyDir(REAL_REDIS, path.join(h.cfg, 'skills', 'redis'));
  else { H.write(path.join(h.cfg, 'skills', 'redis', 'assets', 'redis-client.js'), '// x\n'); H.write(path.join(h.cfg, 'skills', 'redis', 'SKILL.md'), '---\nname: redis\n---\n'); }
  H.write(path.join(h.cfg, 'rules', 'vibe-lessons-java.md'), '---\npaths:\n  - "**/*.java"\n---\n\n# 写Java时注意（几个项目的审查里都出现过）\n\n<!-- L0a1b2c 次数=3 最近=2026-09-20 类别=边界 出处=projA；projB -->\n- 分页参数为空时按第一页查，不要直接拼进 SQL\n');

  const i2 = install(h, newPkg);
  H.ok('这一版装上了', i2.code === 0, i2.out + i2.err);
  H.ok('新名字的六个技能和代理都在', ['ttls-cross-review', 'ttls-db-crud', 'ttls-handover', 'ttls-onboard', 'ttls-redis', 'ttls-see-page'].every((n) => fs.existsSync(path.join(h.cfg, 'skills', n, 'SKILL.md'))) && fs.existsSync(path.join(h.cfg, 'agents', 'ttls-reviewer.md')), lsdir(path.join(h.cfg, 'skills')));
  H.ok('旧名字的技能和代理删掉了', !['cross-review', 'handover', 'onboard', 'see-page'].some((n) => fs.existsSync(path.join(h.cfg, 'skills', n))) && !fs.existsSync(path.join(h.cfg, 'agents', 'vibe-reviewer.md')), [lsdir(path.join(h.cfg, 'skills')), lsdir(path.join(h.cfg, 'agents'))]);
  H.ok('安装器说了改名的事', /技能和代理改名了/.test(i2.out) && /\/handover → \/ttls-handover/.test(i2.out) && /vibe-reviewer → ttls-reviewer/.test(i2.out), i2.out);
  const bk = (i2.out.match(/旧技能 see-page 被改过，删除前备份在 (\S+)/) || [])[1] || '';
  H.ok('改过的那个先备份了', !!bk && /我自己加的一句/.test(H.read(path.join(bk, 'SKILL.md')) || ''), i2.out);
  H.ok('没改过的不备份、不提', !/旧技能 (handover|onboard|cross-review) 被改过/.test(i2.out), i2.out);
  H.ok('用户自己的技能没动', fs.existsSync(path.join(h.cfg, 'skills', 'my-own', 'SKILL.md')));
  H.ok('以前单独装的 urai-db-crud、redis 收走了，说了挪到哪', !fs.existsSync(path.join(h.cfg, 'skills', 'urai-db-crud')) && !fs.existsSync(path.join(h.cfg, 'skills', 'redis')) && /urai-db-crud 技能并进套件了，现在叫 ttls-db-crud/.test(i2.out) && /redis 技能并进套件了，现在叫 ttls-redis/.test(i2.out), i2.out);
  const bk2 = (i2.out.match(/urai-db-crud 技能并进套件了[^\n]*挪到了 (\S+?)（/) || [])[1] || '';
  H.ok('整个旧技能挪进了 vibe-kit/retired（不参加备份的轮转，不会被自动删）', !!bk2 && fs.existsSync(path.join(bk2, 'scripts', 'db.py')) && path.dirname(bk2) === path.join(h.kit, 'retired'), bk2);
  // 用户后来又把旧技能装回来：是用户要的，再装套件时不再收
  H.copyDir(bk2, path.join(h.cfg, 'skills', 'urai-db-crud'));
  const i2b = install(h, newPkg);
  H.ok('收过之后用户又装回来的：不再收，只提一句', i2b.code === 0 && fs.existsSync(path.join(h.cfg, 'skills', 'urai-db-crud', 'scripts', 'db.py')) && /又装回来了/.test(i2b.out), i2b.out);
  fs.rmSync(path.join(h.cfg, 'skills', 'urai-db-crud'), { recursive: true, force: true });
  if (HAS_REAL) {
    const reg = JSON.parse(H.read(path.join(h.kit, 'drivers.json')) || '{}').drivers || {};
    const jars = lsdir(path.join(REAL_DBCRUD, 'drivers')).filter((n) => /\.jar$/.test(n));
    H.ok('旧技能自带的 ' + jars.length + ' 个驱动都挪过来登记了', Object.keys(reg).length === jars.length && Object.values(reg).every((d) => d.from === 'rescue' && fs.existsSync(d.jar) && d.jar.startsWith(path.join(h.kit, 'drivers'))), reg);
    H.ok('每个驱动认对了是哪种数据库', /dm/i.test(path.basename((reg.dm || {}).jar || '')) && /mysql/i.test(path.basename((reg.mysql || {}).jar || '')) && /ojdbc/i.test(path.basename((reg.oracle || {}).jar || '')) && /kingbase/i.test(path.basename((reg.kingbase || {}).jar || '')) && /oscar/i.test(path.basename((reg.oscar || {}).jar || '')), reg);
    H.ok('安装器说了驱动挪到哪', /它自带的驱动挪到了套件的驱动目录并登记好/.test(i2.out), i2.out);
    const ls = H.node(h, path.join(h.kit, 'tools', 'drivers.js'), ['list']);
    H.ok('drivers.js list 五种都有', ls.code === 0 && (ls.out.match(/✓/g) || []).length === 5 && /从旧的 urai-db-crud 技能里挪过来的/.test(ls.out), ls.out + ls.err);
  }
  // 再装一遍：已经登记的驱动不动，不重复备份
  const i3 = install(h, newPkg);
  H.ok('再装一遍：没有什么可删的，不再提改名', i3.code === 0 && !/技能和代理改名了/.test(i3.out) && !/并进套件了/.test(i3.out), i3.out);
  const st = JSON.parse(H.read(path.join(h.cfg, 'settings.json')) || '{}');
  H.ok('钩子照常登记着', JSON.stringify(st.hooks || {}).includes('vibe-kit/hooks/'), st.hooks);
  const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
  H.ok('全局约定里是新名字', /\/ttls-see-page/.test(md) && !/[^-\w]\/(see-page|onboard|handover|cross-review)\b/.test(md), md.slice(0, 300));

  H.section('不是套件装的同名技能：不动');
  const h2 = H.freshHome('ttls-own');
  H.write(path.join(h2.cfg, 'skills', 'handover', 'SKILL.md'), '---\nname: handover\ndescription: 别的套件的交接技能\n---\n');
  H.write(path.join(h2.cfg, 'skills', 'redis', 'SKILL.md'), '---\nname: redis\ndescription: 别人写的 redis 技能，没有那个客户端\n---\n');
  H.write(path.join(h2.cfg, 'agents', 'vibe-reviewer.md'), '---\nname: vibe-reviewer\n---\n别人的\n');
  const j1 = install(h2, newPkg);
  H.ok('装上了', j1.code === 0, j1.out + j1.err);
  H.ok('别的套件的 handover 还在，说了没动它', /别的套件的交接技能/.test(H.read(path.join(h2.cfg, 'skills', 'handover', 'SKILL.md')) || '') && /handover 不是套件装的/.test(j1.out), j1.out);
  H.ok('认不出是以前那个 redis 技能的：还在', /别人写的/.test(H.read(path.join(h2.cfg, 'skills', 'redis', 'SKILL.md')) || '') && /认不出是以前的 redis 技能/.test(j1.out), j1.out);
  H.ok('别人的 vibe-reviewer 代理还在', /别人的/.test(H.read(path.join(h2.cfg, 'agents', 'vibe-reviewer.md')) || ''));

  H.section('会话记录里的旧名字照样认');
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n', 'openspec/changes/c1/tasks.md': '- [x] 1.1 改 src/A.java；验：`mvn -q compile`\n', 'openspec/changes/c1/proposal.md': '## Why\n\nx\n' });
  const c1 = path.join(proj, 'openspec', 'changes', 'c1');
  const rv = (agent, id) => [H.tr.call('Agent', { subagent_type: agent, prompt: '模式：代码\n变更：openspec/changes/c1/\n材料…' }, id), H.tr.result(id, '没有问题。\n\n结论：问题 0 条')];
  const tf = H.transcript(path.join(h.work, 't1.jsonl'), [H.tr.user('审一下')].concat(rv('vibe-reviewer', 'toolu_old1')));
  H.ok('用旧名字调的审查代理算审过', S.syncReviews(S.tailEntries(tf, 600000), proj).length === 1 && !S.codeReviewIssue(c1), S.codeReviewIssue(c1));
  fs.rmSync(path.join(h.kit, 'state', 'reviewed.json'), { force: true });
  const tf2 = H.transcript(path.join(h.work, 't2.jsonl'), [H.tr.user('审一下')].concat(rv('ttls-reviewer', 'toolu_new1')));
  H.ok('用新名字调的也算', S.syncReviews(S.tailEntries(tf2, 600000), proj).length === 1 && !S.codeReviewIssue(c1), S.codeReviewIssue(c1));
  const calls = (name) => [{ name: 'Skill', input: { skill: name } }];
  H.ok('用 Skill 调 handover、ttls-handover 都算写过交接记录', S.handoverWrittenIn(calls('handover'), '') && S.handoverWrittenIn(calls('ttls-handover'), '') && S.handoverWrittenIn(calls('/ttls-handover'), '') && !S.handoverWrittenIn(calls('ttls-onboard'), ''));
  H.ok('用户敲的斜杠命令新旧都认', S.handoverWrittenIn([], '<command-name>/handover</command-name>') && S.handoverWrittenIn([], '<command-name>/ttls-handover</command-name>'));

  H.section('经验规则的文件改名');
  const L = require(path.join(h.kit, 'lib', 'lessons.js'));
  H.ok('用户级的旧文件还没动（装的时候不碰）', fs.existsSync(path.join(h.cfg, 'rules', 'vibe-lessons-java.md')));
  const oldRule = path.join(proj, '.claude', 'rules', 'vibe-lessons-java.md');
  const newRule = path.join(proj, '.claude', 'rules', 'ttls-lessons-java.md');
  H.write(oldRule, '---\npaths:\n  - "**/*.java"\n---\n\n# 写Java时注意（这个项目的审查里反复出现过）\n\n- 手写的一条，没有编号\n\n<!-- L111111 次数=2 最近=2026-09-25 类别=边界 出处=c1 1.1；c2 2.1 -->\n- 导出接口要先判断列表为空，空的时候返回空文件\n<!-- L222222 次数=4 最近=2026-09-27 没管住=1 类别=权限 出处=c3 1.2 -->\n- 新加的接口要在权限表里登记角色\n');
  // 同事还没升级的那几天：新文件里已经有一条一样的（次数少）和一条别的
  H.write(newRule, '---\npaths:\n  - "**/*.java"\n---\n\n# 写Java时注意（这个项目的审查里反复出现过）\n\n<!-- L222222 次数=2 最近=2026-09-29 类别=权限 出处=c9 3.1 -->\n- 新加的接口要在权限表里登记角色\n<!-- L333333 次数=2 最近=2026-09-29 类别=数据库 出处=c9 3.2 -->\n- 批量更新要带上租户条件\n');
  H.git(proj, ['add', '-A']); H.git(proj, ['commit', '-q', '-m', 'docs: 规则']);
  H.ok('旧名字的文件照样受保护（不许直接改）', L.isLessonFile(oldRule) && L.isLessonFile(newRule));
  const guard = H.hook(h, 'pre-edit', { session_id: 's-ttls', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: oldRule, content: '- x\n' }, transcript_path: tf });
  H.ok('钩子拦住直接改旧名字的规则文件', guard && guard.decision === 'block' && /经验规则的文件/.test(H.reasonOf(guard)), guard);
  H.hook(h, 'session-start', { session_id: 's-ttls', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tf });
  const merged = L.readRuleFile(newRule);
  H.ok('会话开始：旧文件并进了新文件，旧文件没了', !fs.existsSync(oldRule) && merged.rules.length === 3 && merged.manual.some((l) => /手写的一条/.test(l)), [fs.existsSync(oldRule), merged]);
  const r2 = merged.rules.find((r) => r.id === 'L222222') || {};
  H.ok('两边都有的那条留一条：次数取大的，出处合起来', r2.count === 4 && r2.miss === 1 && r2.last === '2026-09-29' && r2.from.length === 2, r2);
  H.ok('用户级的也挪了', !fs.existsSync(path.join(h.cfg, 'rules', 'vibe-lessons-java.md')) && /分页参数为空/.test(H.read(path.join(h.cfg, 'rules', 'ttls-lessons-java.md')) || ''));
  const un = L.uncommitted(proj).map((x) => x.rel).sort();
  H.ok('两个文件都记着要提交（旧文件的删除也要提交）', JSON.stringify(un) === JSON.stringify(['.claude/rules/ttls-lessons-java.md', '.claude/rules/vibe-lessons-java.md']), un);
  H.ok('再来一次不重复挪', L.migrateNames(L.projectRulesDir(proj), 'project', proj) === 0);

  H.section('卸载');
  const u = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root, timeout: 120000 });
  H.ok('新名字的技能和代理收回了', u.code === 0 && !lsdir(path.join(h.cfg, 'skills')).some((n) => /^ttls-/.test(n)) && !fs.existsSync(path.join(h.cfg, 'agents', 'ttls-reviewer.md')), [u.out + u.err, lsdir(path.join(h.cfg, 'skills'))]);
  H.ok('用户自己的技能还在', fs.existsSync(path.join(h.cfg, 'skills', 'my-own', 'SKILL.md')));
  if (HAS_REAL) H.ok('驱动留着，说了', fs.existsSync(path.join(h.kit, 'drivers.json')) && lsdir(path.join(h.kit, 'drivers')).length === 5 && /数据库驱动（drivers、drivers\.json）/.test(u.out), u.out);
  H.ok('用户级的经验规则留着', fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-java.md')) && /用户级的经验规则也留着/.test(u.out), u.out);

  H.done('改名和并进来的技能');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

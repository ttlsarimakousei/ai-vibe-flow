'use strict';
/*
 * ttls- 改成 vk-（仓库主人 2026-11-04："所有skill名称ttls-全部改成vk-"、"如果不只是skill有ttls-开头的也都改成vk-开头"）：从 1301 升上来会怎样。
 *   ttls- 开头的技能、审查代理删掉，改过的先备份；不是套件装的同名技能不动；经验规则的文件 ttls-lessons-* 并进 vk-lessons-*；
 *   会话记录里、升级那一刻开着的会话里的旧名字照样认；包里、约定里没有 ttls- 了（.ttls-vfb 是别的工具的目录，不算）。
 * 用法：node dev/test-vk-names.js [上一版的 vibe-kit 目录，默认 dev/baseline/20261104.1301/vibe-kit]
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const OLD = path.resolve(process.argv[2] || path.join(__dirname, 'baseline', '20261104.1301', 'vibe-kit'));
const NAMES = ['cross-review', 'db-crud', 'handover', 'onboard', 'redis', 'see-page'];
function asPackage(name, from) {
  const dir = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(from, dir, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(dir);
  return dir;
}
const install = (h, pkg) => H.node(h, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 300000 });
const lsdir = (d) => { try { return fs.readdirSync(d).sort(); } catch (e) { return []; } };

const oldPkg = asPackage('vkn-old', OLD);
const newPkg = asPackage('vkn-new', H.SRC);

H.section('包里的东西：都是 vk- 开头，没有 ttls- 了');
{
  H.ok('技能是 vk- 开头的六个，审查代理是 vk-reviewer', JSON.stringify(lsdir(path.join(newPkg, 'claude', 'skills'))) === JSON.stringify(NAMES.map((n) => 'vk-' + n)) && JSON.stringify(lsdir(path.join(newPkg, 'claude', 'agents'))) === '["vk-reviewer.md"]', [lsdir(path.join(newPkg, 'claude', 'skills')), lsdir(path.join(newPkg, 'claude', 'agents'))]);
  for (const n of NAMES) H.ok('vk-' + n + '：SKILL.md 里的名字是 vk-' + n, new RegExp('^name: vk-' + n + '$', 'm').test(H.read(path.join(newPkg, 'claude', 'skills', 'vk-' + n, 'SKILL.md')) || ''));
  // 给模型看的东西里没有 ttls- 的名字（认旧名字的正则、讲改名的说明、技能自己的变更记录除外）
  const files = fs.readdirSync(path.join(newPkg, 'claude'), { recursive: true }).map((x) => path.join(newPkg, 'claude', String(x))).filter((f) => /\.(md|py|js)$/.test(f) && !/CHANGELOG/.test(f));
  const left = files.filter((f) => /ttls-(cross-review|see-page|handover|onboard|db-crud|redis|reviewer|lessons)/.test(H.read(f) || ''));
  H.ok('约定、规范、技能、代理里没有 ttls- 的名字', left.length === 0, left);
  H.ok('全局约定模板里是 /vk- 的命令', !/ttls-/.test(H.read(path.join(newPkg, 'claude', 'CLAUDE.md')) || ''));
}

H.section('从 1301 升上来');
const h = H.freshHome('vkn-up');
{
  const i1 = install(h, oldPkg);
  H.ok('1301 装上了，技能是 ttls- 开头', i1.code === 0 && NAMES.every((n) => fs.existsSync(path.join(h.cfg, 'skills', 'ttls-' + n, 'SKILL.md'))) && fs.existsSync(path.join(h.cfg, 'agents', 'ttls-reviewer.md')), i1.out.slice(-400) + i1.err);
  fs.appendFileSync(path.join(h.cfg, 'skills', 'ttls-see-page', 'SKILL.md'), '\n我自己加的一句。\n');
  H.write(path.join(h.cfg, 'rules', 'ttls-lessons-java.md'), '---\npaths:\n  - "**/*.java"\n---\n\n# 写Java时注意（几个项目的审查里都出现过）\n\n<!-- L0a1b2c 次数=3 最近=2026-11-01 类别=边界 出处=projA；projB -->\n- 分页参数为空时按第一页查，不要直接拼进 SQL\n');
  const i2 = install(h, newPkg);
  H.ok('这一版装上了', i2.code === 0, i2.out.slice(-600) + i2.err);
  H.ok('vk- 开头的六个技能和 vk-reviewer 都在', NAMES.every((n) => fs.existsSync(path.join(h.cfg, 'skills', 'vk-' + n, 'SKILL.md'))) && fs.existsSync(path.join(h.cfg, 'agents', 'vk-reviewer.md')), lsdir(path.join(h.cfg, 'skills')));
  H.ok('ttls- 开头的技能和代理都删了', !lsdir(path.join(h.cfg, 'skills')).some((n) => /^ttls-/.test(n)) && !fs.existsSync(path.join(h.cfg, 'agents', 'ttls-reviewer.md')), [lsdir(path.join(h.cfg, 'skills')), lsdir(path.join(h.cfg, 'agents'))]);
  H.ok('安装器说了改名：/ttls-handover → /vk-handover，ttls-reviewer → vk-reviewer', /技能和代理改名了/.test(i2.out) && /\/ttls-handover → \/vk-handover/.test(i2.out) && /\/ttls-db-crud → \/vk-db-crud/.test(i2.out) && /ttls-reviewer → vk-reviewer/.test(i2.out), i2.out);
  const bk = (i2.out.match(/旧技能 ttls-see-page 被改过，删除前备份在 (\S+)/) || [])[1] || '';
  H.ok('改过的 ttls-see-page 先备份了', !!bk && /我自己加的一句/.test(H.read(path.join(bk, 'SKILL.md')) || ''), i2.out);
  H.ok('没改过的不备份、不提', !/旧技能 ttls-(handover|onboard|cross-review|db-crud|redis) 被改过/.test(i2.out), i2.out);
  const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
  H.ok('全局约定里是 /vk- 的名字，没有 ttls-', /\/vk-/.test(md) && !/ttls-/.test(md), md.slice(0, 300));
  H.ok('用户级的经验规则：装的时候不动', fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-java.md')));
  const i3 = install(h, newPkg);
  H.ok('再装一遍：不再提改名', i3.code === 0 && !/技能和代理改名了/.test(i3.out), i3.out.slice(-400));
}

H.section('不是套件装的 ttls- 技能：不动');
{
  const h2 = H.freshHome('vkn-own');
  H.write(path.join(h2.cfg, 'skills', 'ttls-redis', 'SKILL.md'), '---\nname: ttls-redis\ndescription: 别人写的\n---\n');
  H.write(path.join(h2.cfg, 'agents', 'ttls-reviewer.md'), '---\nname: ttls-reviewer\n---\n别人的\n');
  const j1 = install(h2, newPkg);
  H.ok('装上了', j1.code === 0, j1.out.slice(-300) + j1.err);
  H.ok('别人写的 ttls-redis 还在，说了没动它、套件的叫 vk-redis', /别人写的/.test(H.read(path.join(h2.cfg, 'skills', 'ttls-redis', 'SKILL.md')) || '') && /ttls-redis 不是套件装的[\s\S]*现在叫 vk-redis/.test(j1.out), j1.out);
  H.ok('别人的 ttls-reviewer 代理还在', /别人的/.test(H.read(path.join(h2.cfg, 'agents', 'ttls-reviewer.md')) || ''));
}

H.section('经验规则的文件：ttls-lessons-* 并进 vk-lessons-*');
const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
{
  const L = require(path.join(h.kit, 'lib', 'lessons.js'));
  const oldRule = path.join(proj, '.claude', 'rules', 'ttls-lessons-java.md');
  const newRule = path.join(proj, '.claude', 'rules', 'vk-lessons-java.md');
  H.write(oldRule, '---\npaths:\n  - "**/*.java"\n---\n\n# 写Java时注意（这个项目的审查里反复出现过）\n\n<!-- L111111 次数=2 最近=2026-11-01 类别=边界 出处=c1 1.1；c2 2.1 -->\n- 导出接口要先判断列表为空，空的时候返回空文件\n');
  H.git(proj, ['add', '-A']); H.git(proj, ['commit', '-q', '-m', 'docs: 规则']);
  H.ok('旧名字的文件也认得是经验规则', L.isLessonFile(oldRule));
  const tf = H.transcript(path.join(h.work, 't0.jsonl'), [H.tr.user('看看')]);
  H.hook(h, 'session-start', { session_id: 's-vkn', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tf });
  H.ok('会话开始：项目里的挪成 vk-lessons-java.md，旧文件没了', !fs.existsSync(oldRule) && /列表为空/.test(H.read(newRule) || ''), lsdir(path.dirname(newRule)));
  H.ok('用户级的也挪了', !fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-java.md')) && /分页参数为空/.test(H.read(path.join(h.cfg, 'rules', 'vk-lessons-java.md')) || ''));
}

H.section('会话记录里、升级那一刻开着的会话里的旧名字照样认');
{
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const calls = (name) => [{ name: 'Skill', input: { skill: name } }];
  H.ok('Skill 调 ttls-handover、vk-handover 都算写过交接记录', S.handoverWrittenIn(calls('ttls-handover'), '') && S.handoverWrittenIn(calls('vk-handover'), '') && !S.handoverWrittenIn(calls('vk-onboard'), ''));
  H.ok('用户敲的 /ttls-handover、/vk-handover 都认', S.handoverWrittenIn([], '<command-name>/ttls-handover</command-name>') && S.handoverWrittenIn([], '<command-name>/vk-handover</command-name>'));
  const stop = (agent) => H.hook(h, 'review-stop', { session_id: 's-vkn', cwd: proj, hook_event_name: 'SubagentStop', agent_type: agent, agent_id: 'a' + agent, last_assistant_message: '审完了，没问题' });
  H.ok('审查代理叫 vk-reviewer：管（没写审查任务，拦下）', /没认出/.test(H.reasonOf(stop('vk-reviewer'))));
  H.ok('升级那一刻开着的会话还叫 ttls-reviewer：也管', /没认出/.test(H.reasonOf(stop('ttls-reviewer'))));
  H.ok('别的子代理不管', stop('general-purpose') === null);
  // 技能也是 vk- 开头了：模型调技能照常，调给用户敲的 /vk-* 命令照拦
  const tf = H.transcript(path.join(h.work, 't-skill.jsonl'), [H.tr.user('看看页面')]);
  const skill = (n) => H.reasonOf(H.hook(h, 'guard-ask', { session_id: 's-vkn2', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: n }, transcript_path: tf }));
  for (const n of ['vk-see-page', 'vk-db-crud', 'vk-redis', 'vk-onboard', 'vk-cross-review']) H.ok('模型调技能 ' + n + '：不当成给用户敲的命令', !/给用户敲的/.test(skill(n)), skill(n));
  for (const n of ['vk-go', 'vk-commit', 'vk-push']) H.ok('模型调命令 /' + n + '：照拦', /给用户敲的/.test(skill(n)), skill(n));
}

H.section('项目里还写着旧名字（复审第 8、9 条）');
{
  const tf = H.transcript(path.join(h.work, 't-old.jsonl'), [H.tr.user('查一下库')]);
  const skill = (n) => H.reasonOf(H.hook(h, 'guard-ask', { session_id: 's-old', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: n }, transcript_path: tf }));
  H.ok('模型用旧名字调技能（ttls-db-crud）：说新名字是 vk-db-crud', /技能改名了：ttls-db-crud 现在叫 vk-db-crud/.test(skill('ttls-db-crud')), skill('ttls-db-crud'));
  H.write(path.join(proj, '.vibe', 'project.md'), '# 项目说明\n\n- 数据库：用 /ttls-db-crud 查，脚本 ~/.claude/skills/ttls-db-crud/scripts/db.py\n- 页面：/ttls-see-page\n');
  H.write(path.join(proj, 'CLAUDE.md'), '# 团队\n\n查库用 /ttls-db-crud\n');
  const ss = H.hook(h, 'session-start', { session_id: 's-old2', cwd: proj, hook_event_name: 'SessionStart', source: 'startup', transcript_path: tf });
  const pm = H.read(path.join(proj, '.vibe', 'project.md'));
  H.ok('本机的项目说明（.vibe/project.md）：旧名字换成 vk-', /\/vk-db-crud/.test(pm) && /skills\/vk-db-crud\/scripts/.test(pm) && /\/vk-see-page/.test(pm) && !/ttls-/.test(pm), pm);
  H.ok('项目的 CLAUDE.md 跟着仓库走：不改，提一句', /ttls-db-crud/.test(H.read(path.join(proj, 'CLAUDE.md'))) && /CLAUDE\.md 里还写着旧的技能名/.test(JSON.stringify(ss)), JSON.stringify(ss).slice(0, 300));
  // 工具统计：旧名字记的并进新名字那一条
  const T = require(path.join(h.kit, 'lib', 'toolstats.js'));
  H.write(path.join(h.kit, 'state', 'tool-stats.json'), JSON.stringify({ by: { 'ttls-db-crud|query': { tool: 'ttls-db-crud', cmd: 'query', n: 3, fail: 0, ms: 300, max: 200, java: 3, daemon: 0, cached: 0, errors: {}, first: 1, last: 2 } } }));
  fs.appendFileSync(path.join(h.kit, 'state', 'tool-usage.jsonl'), JSON.stringify({ tool: 'ttls-db-crud', cmd: 'query', at: Date.now(), ms: 100, exit: 0, java: 1 }) + '\n');
  try { T.ingest({ session_id: 's-old3', cwd: proj }); } catch (e) { /* 看结果 */ }
  const by = (JSON.parse(H.read(path.join(h.kit, 'state', 'tool-stats.json')) || '{}').by) || {};
  H.ok('工具统计：ttls-db-crud 记的并进 vk-db-crud，不分成两条', !by['ttls-db-crud|query'] && by['vk-db-crud|query'] && by['vk-db-crud|query'].n === 4, by);
}

H.section('卸载');
{
  const u = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root, timeout: 120000 });
  H.ok('vk- 的技能和代理收回了', u.code === 0 && !lsdir(path.join(h.cfg, 'skills')).some((n) => /^vk-/.test(n)) && !fs.existsSync(path.join(h.cfg, 'agents', 'vk-reviewer.md')), [u.out.slice(-300) + u.err, lsdir(path.join(h.cfg, 'skills'))]);
  H.ok('用户级的经验规则留着，说的是 vk-lessons-*', fs.existsSync(path.join(h.cfg, 'rules', 'vk-lessons-java.md')) && /vk-lessons-\*\.md/.test(u.out), u.out.slice(-400));
}

H.done('ttls- 改成 vk-');

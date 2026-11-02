'use strict';
/*
 * 11-02 导出议题和问题表第 32—34 条（docs/feedback-20261102-1543.md）。
 * 用法：node dev/test-feedback1102.js [旧版的 vibe-kit 目录]（给了旧版就拿旧版跑，看哪些项不过）
 * 全在假用户目录里。
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const from = process.argv[2] ? path.resolve(process.argv[2]) : H.SRC;
const reason = (o) => H.reasonOf(o);

(async () => {
  const watch = await H.watchWindows('t1102');

  // ---------------------------------------------------------------------------------------------
  H.section('第 32 条：只说"启动OA"就直接起，不问自测范围，提示里不说人工模式');
  {
    const h = H.makeHome('t1102-start', from);
    const p = H.makeRepo(path.join(h.work, 'oa'), { '.gitignore': '.vibe/\n', 'pom.xml': '<project/>\n' });
    const tool = path.join(h.kit, 'tools', 'devserver.js').replace(/\\/g, '/');
    const start = 'node "' + tool + '" start --name oa --port auto -- mvn spring-boot:run';
    const ask = (said, command) => {
      const tf = H.transcript(path.join(h.root, 's' + Math.random().toString(36).slice(2) + '.jsonl'), [H.tr.user(said)]);
      return H.hook(h, 'guard-commit', { session_id: 's-start', hook_event_name: 'PreToolUse', cwd: p, transcript_path: tf, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-' + Math.random().toString(36).slice(2) });
    };
    for (const said of ['启动OA', '重启后端', '把OA起起来', '帮我启动 jssslt-oa'])
      H.ok('说"' + said + '"：devserver start 不拦', !reason(ask(said, start)), reason(ask(said, start)));
    const no = reason(ask('看看这个类是干什么的', start));
    H.ok('没说要起：还是先问一次', /先用 Ask 问一次要不要起/.test(no), no);
    H.ok('没说要起：提示里不说"人工模式"', !/人工模式/.test(no), no);
    H.ok('没说要起：提示说的是起服务，不让选自测范围', /没说要起服务/.test(no) && /不问范围/.test(no) && !/及范围/.test(no), no);
    const t = reason(ask('看看这个类是干什么的', 'mvn test'));
    H.ok('真跑测试：照旧问是否自测及范围', /先用 Ask 询问是否自测或复验及范围/.test(t) && !/人工模式/.test(t), t);
    // 直接起服务的命令钩子先让它改走 devserver；这几条看"问什么"那一层
    const F = require(path.join(h.kit, 'lib', 'flow-policy'));
    const issue = (command) => F.actionIssue({ session_id: 's-start', cwd: p, transcript_path: H.transcript(path.join(h.root, 'q.jsonl'), [H.tr.user('看看这个类是干什么的')]), tool_name: 'Bash', tool_input: { command }, tool_use_id: 'tu-q' });
    H.ok('又跑测试又起服务：按自测问', /询问是否自测或复验及范围/.test(issue('mvn test && mvn spring-boot:run')), issue('mvn test && mvn spring-boot:run'));
    H.ok('npm run dev 也算起服务', /没说要起服务/.test(issue('npm run dev')), issue('npm run dev'));
    H.ok('带路径的 Maven 也认得：起服务', /没说要起服务/.test(issue('"F:/apache-maven-3.8.3/bin/mvn" -s "C:/u/.m2/s.xml" spring-boot:run')), issue('"F:/apache-maven-3.8.3/bin/mvn" -s "C:/u/.m2/s.xml" spring-boot:run'));
    H.ok('gradle bootRun 也算起服务', /没说要起服务/.test(issue('./gradlew bootRun')), issue('./gradlew bootRun'));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('#269：工具规定写在点开头目录里的文件，不算产出，不拦');
  {
    const h = H.makeHome('t1102-out', from);
    const p = H.makeRepo(path.join(h.work, 'proj'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const write = (file) => {
      const tf = H.transcript(path.join(h.root, 'w' + Math.random().toString(36).slice(2) + '.jsonl'), [H.tr.user('照流程走')]);
      return H.hook(h, 'guard-output', { session_id: 's-out', hook_event_name: 'PreToolUse', cwd: p, transcript_path: tf, tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_use_id: 'tu-w' });
    };
    const inHome = path.join(h.home, '.ttls-vfb', 'collect', 'SEED', 'x-1', 'answer.md');
    H.ok('用户目录下的 .ttls-vfb/…/answer.md：不拦', !reason(write(inHome)), reason(write(inHome)));
    const inRepo = path.join(p, '.ttls-vfb', 'batches', 'b1', 'items', 'E4', 'fix-main-r1.md');
    H.ok('项目里的 .ttls-vfb/…/fix-main-r1.md：不拦', !reason(write(inRepo)), reason(write(inRepo)));
    H.ok('别的点开头目录一样：不拦', !reason(write(path.join(p, '.tool-work', 'report.md'))));
    const doc = reason(write(path.join(p, 'docs', '报告.md')));
    H.ok('普通目录的新文档照旧管', /产出位置/.test(doc) && /pending/.test(doc), doc);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 34 条：默认的 review.js 审查报的问题进经验规则，到次数变成项目规则');
  {
    const h = H.makeHome('t1102-less', from);
    const change = (n) => ['openspec/changes/' + n + '/proposal.md', '# ' + n + '\n'];
    const p = H.makeRepo(path.join(h.work, 'p'), Object.fromEntries([['.gitignore', '.vibe/\n'], ['src/A.java', 'class A {}\n'], ['src/B.java', 'class B {}\n'], ['src/C.java', 'class C {}\n'], change('chg-a'), change('chg-b'), change('chg-c'), change('chg-d')]));
    const A = path.join(p, 'src', 'A.java');
    const cmd = (args) => 'node "$HOME/.claude/vibe-kit/tools/review.js" run ' + args + ' --mode code --project "' + p.replace(/\\/g, '/') + '"';
    let seq = 0;
    const issue = (o) => Object.assign({ id: 'r1', severity: 'P1', file: 'src/A.java', line: 1, problem: '批量查询之前没判断列表是不是空的', evidence: '第 3 行直接拼 in', fix: '先判断', kind: '边界', avoid: '按一批 id 查询之前：先判断列表是不是空的' }, o);
    const report = (issues, id) => JSON.stringify({ id: id || 'run-' + (++seq), mode: 'code', status: 'completed', at: Date.now(), issues });
    const stop = (entries) => {
      const sid = 's-less-' + (++seq);
      const tf = H.transcript(path.join(h.root, sid + '.jsonl'), entries);
      return H.hook(h, 'verify-gate', { session_id: sid, hook_event_name: 'Stop', cwd: p, transcript_path: tf });
    };
    const cands = () => { try { return JSON.parse(fs.readFileSync(path.join(p, '.vibe', 'lessons', 'candidates.json'), 'utf8')); } catch (e) { return { items: [] }; } };
    const list = () => { const c = cands(); return Array.isArray(c) ? c : c.items || []; };
    const rule = () => H.read(path.join(p, '.claude', 'rules', 'ttls-lessons-java.md')) || '';
    const edit = () => H.tr.ran('Edit', { file_path: A, old_string: 'x', new_string: 'y' }, 'ok');
    const run = (args, text) => H.tr.ran('Bash', { command: cmd(args) }, text);

    stop([H.tr.user('审一下'), run('--change chg-a --point group-1', report([issue()])), edit()]);
    H.ok('第一个变更：报了、改了，进候选', list().some((c) => /先判断列表是不是空的/.test(c.text) && c.state === 'candidate'), JSON.stringify(cands()));
    H.ok('第一个变更：还不是规则', !/先判断列表是不是空的/.test(rule()), rule());
    stop([H.tr.user('审一下'), run('--change chg-b --point group-1', report([issue({ problem: '按 id 列表查询前没判断空列表' })])), edit()]);
    H.ok('另一个变更又出现：写进项目的规则文件', /先判断列表是不是空的/.test(rule()), rule() + JSON.stringify(cands()));

    const before = list().length;
    stop([H.tr.user('审一下'), run('--change chg-c --point group-1', report([issue({ problem: '订单状态没校验', avoid: '改状态之前先校验当前状态是否允许流转' })]))]);
    H.ok('报了但文件没改：不收', list().length === before, JSON.stringify(list()));
    stop([H.tr.user('审一下'), run('--change chg-c --point group-1', report([issue({ severity: 'P3', problem: '变量名可以再清楚一点', avoid: '变量名写清楚用途，别缩写成一个字母' })])), edit()]);
    H.ok('P3（建议）：不收', list().length === before, JSON.stringify(list()));
    stop([H.tr.user('审一下'), run('--change chg-c --point group-1', report([issue({ problem: '这里手滑写错了字段', avoid: '无（一次性的疏忽）' })])), edit()]);
    H.ok('写了"无"的一次性疏忽：不收', list().length === before, JSON.stringify(list()));

    // 不走 OpenSpec 的审查：结果文件里登记了处理结果
    const plain = path.join(p, '.vibe', 'reviews', 'plain', 'code.json');
    const save = (o) => H.write(plain, JSON.stringify(o));
    const rejected = { id: 'run-plain-1', mode: 'code', status: 'completed', at: Date.now(), issues: [issue({ problem: '导出没加权限判断', avoid: '导出接口都要先判断当前用户的数据权限', kind: '权限' })], decisions: [{ id: 'r1', action: 'rejected', reason: '这个接口只在内网用，确认不成立' }] };
    save(rejected);
    stop([H.tr.user('审一下'), run('--base HEAD', JSON.stringify(rejected)), edit()]);
    H.ok('登记了驳回：改过文件也不收', !list().some((c) => /数据权限/.test(c.text)), JSON.stringify(list()));
    const fixed = { id: 'run-plain-2', mode: 'code', status: 'completed', at: Date.now(), issues: [issue({ problem: '导入没校验表头', avoid: '导入文件之前先校验表头和模板是否一致', kind: '边界' })], decisions: [{ id: 'r1', action: 'fixed', reason: '加了表头校验，复验通过' }] };
    save(fixed);
    stop([H.tr.user('审一下'), run('--base HEAD', JSON.stringify(fixed))]);
    H.ok('登记了修了：会话里没看到改文件也收', list().some((c) => /校验表头/.test(c.text)), JSON.stringify(list()));
    H.ok('不走 OpenSpec 的：出处写日期和小改动', list().filter((c) => /校验表头/.test(c.text)).every((c) => (c.sources || []).some((s) => /\d{4}-\d{2}-\d{2} 小改动/.test(s.from))), JSON.stringify(list()));

    // 放后台跑、命令输出里没有结论：读结果文件
    const bg = { id: 'run-plain-3', mode: 'code', status: 'completed', at: Date.now() + 60000, issues: [issue({ problem: '分页参数没有上限', avoid: '分页接口要限制每页条数的上限', kind: '边界' })] };
    save(bg);
    stop([H.tr.user('审一下'), run('--base HEAD', '后台任务已启动'), edit()]);
    H.ok('放后台跑的：从结果文件取', list().some((c) => /每页条数/.test(c.text)), JSON.stringify(list()));

    // 同一类在几个变更里反复出现：多出一条"这一类要对照检查"
    const texts = ['日期跨年没处理', '金额为负数没处理', '超长备注没处理'];
    ['chg-a', 'chg-b', 'chg-d'].forEach((n, i) => stop([H.tr.user('审一下'), run('--change ' + n + ' --point group-2', report([issue({ file: 'src/B.java', problem: texts[i], avoid: '', kind: '想当然' })])), H.tr.ran('Edit', { file_path: path.join(p, 'src', 'B.java'), old_string: 'x', new_string: 'y' }, 'ok')]));
    H.ok('同一类在 3 个变更里出现：出一条按类别的规则', /想当然类的问题在审查里反复出现/.test(rule()), rule());

    H.setConfig(h, { lessonAuto: false });
    const n = list().length;
    stop([H.tr.user('审一下'), run('--change chg-d --point group-1', report([issue({ problem: '关着开关的问题', avoid: '关着开关时这一条不该进来' })])), edit()]);
    H.ok('"审查报的问题自动收"关着：不收', list().length === n, JSON.stringify(list()));
    H.setConfig(h, { lessonAuto: true });
    const R = require(path.join(h.kit, 'lib', 'review-runner'));
    const text = fs.readFileSync(path.join(h.kit, 'lib', 'review-runner.js'), 'utf8');
    H.ok('审查提示要求报类别和以后怎么避免', /"kind":"想当然\|/.test(text) && /"avoid":/.test(text) && typeof R.runsForLessons === 'function');
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 33 条：探索首选 IDEA 里配的 Maven、settings.xml、本地仓库、JDK');
  {
    const h = H.makeHome('t1102-idea', from);
    const fwd = (p) => p.replace(/\\/g, '/');
    const maven = (dir) => { H.write(path.join(dir, 'bin', 'mvn'), '#!/bin/sh\n'); H.write(path.join(dir, 'bin', 'mvn.cmd'), '@echo off\r\n'); return fwd(dir); };
    const M = maven(path.join(h.root, 'tools', 'apache-maven-3.8.3'));
    const settings = fwd(path.join(h.root, 'tools', 'settings-proj.xml')); H.write(settings, '<settings/>\n');
    const repo = fwd(path.join(h.root, 'tools', 'repo')); fs.mkdirSync(repo, { recursive: true });
    const jdk = fwd(path.join(h.root, 'tools', 'jdk8')); H.write(path.join(jdk, 'bin', 'javac.exe'), 'x');
    // IDE 的配置目录在假用户目录里
    const options = path.join(h.home, 'AppData', 'Roaming', 'JetBrains', 'IntelliJIdea2026.2', 'options');
    H.write(path.join(options, 'jdk.table.xml'), '<application><component name="ProjectJdkTable"><jdk version="2"><name value="1.8" /><type value="JavaSDK" /><homePath value="' + jdk + '" /></jdk><jdk version="2"><name value="py" /><type value="Python SDK" /><homePath value="' + jdk + '" /></jdk></component></application>\n');
    const pom = '<project><artifactId>demo</artifactId><parent><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent><properties><java.version>1.8</java.version></properties><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>\n';
    const general = (body) => '<project version="4"><component name="AutoImportSettings" /><component name="MavenImportPreferences"><option name="generalSettings"><MavenGeneralSettings>' + body + '</MavenGeneralSettings></option><option name="importingSettings"><MavenImportingSettings><option name="jdkForImporter" value="17" /></MavenImportingSettings></option></component></project>\n';
    const misc = '<project version="4"><component name="ProjectRootManager" version="2" languageLevel="JDK_1_8" default="true" project-jdk-name="1.8" project-jdk-type="JavaSDK" /></project>\n';
    let seq = 0;
    const project = (files, under) => H.makeRepo(path.join(under || h.work, 'p' + (++seq)), Object.assign({ '.gitignore': '.vibe/\n', 'pom.xml': pom }, files));
    const onlyNode = { VIBE_KIT_NO_ONBOARD: undefined, PATH: path.dirname(process.execPath), VIBE_KIT_IDEA_ROOTS: '' };
    const explore = (p, env) => { const r = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--force', '--dir', p], { env: Object.assign({}, onlyNode, env) }); return H.read(path.join(p, '.vibe', 'project.md')) || ('没有项目说明：' + r.out + r.err); };
    const line = (t, k) => (new RegExp('^- ' + k + '：(.*)$', 'm').exec(t) || [])[1] || '';

    const a = explore(project({ '.idea/workspace.xml': general('<option name="customMavenHome" value="' + M + '" /><option name="localRepository" value="' + repo + '" /><option name="mavenHomeTypeForPersistence" value="CUSTOM" /><option name="userSettingsFile" value="' + settings + '" />'), '.idea/misc.xml': misc }));
    const head = '"' + M + '/bin/mvn" -s "' + settings + '" "-Dmaven.repo.local=' + repo + '"';
    H.ok('快检带上 IDEA 里配的 Maven、settings.xml、本地仓库', line(a, '快检').startsWith(head + ' -q -o compile'), a);
    H.ok('全量带上', line(a, '全量').startsWith(head + ' -q'), a);
    H.ok('启动带上', line(a, '启动').startsWith(head + ' -o spring-boot:run'), a);
    H.ok('"环境"一行写明 Maven、settings.xml、本地仓库都是 IDEA 里配的', /Maven 用 IDEA 里配的：/.test(line(a, '环境')) && line(a, '环境').includes(settings) && line(a, '环境').includes(repo), line(a, '环境'));
    H.ok('"环境"一行写明 JDK 用 IDEA 里配的，带目录和 JAVA_HOME 的写法', line(a, '环境').includes('JDK 用 IDEA 里配的 1.8：' + jdk) && /--env "JAVA_HOME=/.test(line(a, '环境')), line(a, '环境'));

    const b = explore(project({ '.idea/workspace.xml': general('<option name="mavenHome" value="' + M + '" />') }));
    H.ok('老版本 IDEA 写的 mavenHome 也认', line(b, '快检').startsWith('"' + M + '/bin/mvn" -q -o compile'), b);
    H.ok('没写 settings.xml、本地仓库：不带这两个参数', !/ -s "|maven\.repo\.local/.test(line(b, '快检')), line(b, '快检'));

    const shell = path.join(h.work, 'shell'); H.write(path.join(shell, '.idea', 'workspace.xml'), general('<option name="customMavenHome" value="' + M + '" />'));
    const c = explore(project({}, shell));
    H.ok('.idea 在上一层（壳子、聚合工程）：也认', line(c, '快检').startsWith('"' + M + '/bin/mvn"'), c);

    const d = explore(project({}), { VIBE_KIT_IDEA_ROOTS: '' });
    H.ok('没有 .idea：照旧写 mvn，没有"环境"一行', line(d, '快检').startsWith('mvn -q -o compile') && !line(d, '环境'), d);

    const e = explore(project({ '.idea/workspace.xml': general('<option name="customMavenHome" value="' + fwd(path.join(h.root, 'gone')) + '" /><option name="userSettingsFile" value="' + fwd(path.join(h.root, 'gone.xml')) + '" /><option name="localRepository" value="' + fwd(path.join(h.root, 'gone-repo')) + '" />') }));
    H.ok('配的目录、文件已经不在了：不算', line(e, '快检').startsWith('mvn -q -o compile'), e);

    // IDEA 自带的 Maven
    const jb = path.join(h.root, 'JB');
    const B = maven(path.join(jb, 'IntelliJ IDEA 2026.2.3', 'plugins', 'maven-plugin', 'lib', 'maven3'));
    const f = explore(project({ '.idea/workspace.xml': general('<option name="mavenHomeTypeForPersistence" value="BUNDLED3" />') }), { VIBE_KIT_IDEA_ROOTS: jb });
    H.ok('选的是 IDEA 自带的：用自带的', line(f, '快检').startsWith('"' + B + '/bin/mvn"') && /IDEA 自带的/.test(line(f, '环境')), f);
    const g = explore(project({ '.idea/misc.xml': misc }), { VIBE_KIT_IDEA_ROOTS: jb });
    H.ok('有 .idea、没选过，PATH 和"本机环境"里都没有 Maven：用自带的', line(g, '快检').startsWith('"' + B + '/bin/mvn"'), g);
    const pathDir = path.join(h.root, 'pathbin'); H.write(path.join(pathDir, 'mvn.cmd'), '@echo off\r\n');
    const i = explore(project({ '.idea/misc.xml': misc }), { VIBE_KIT_IDEA_ROOTS: jb, PATH: path.dirname(process.execPath) + path.delimiter + pathDir });
    H.ok('有 .idea、没选过，PATH 上有 Maven：照旧写 mvn', line(i, '快检').startsWith('mvn -q -o compile'), i);

    const wrap = explore(project({ '.idea/workspace.xml': general('<option name="mavenHomeTypeForPersistence" value="WRAPPER" />'), 'mvnw.cmd': '@echo off\r\n', mvnw: '#!/bin/sh\n' }));
    H.ok('选的是 wrapper：用项目的 mvnw', /^"\.\/mvnw(\.cmd)?" -q -o compile/.test(line(wrap, '快检')), wrap);

    // 配的内容变了才重新探索；workspace.xml 只是别的地方变了不算
    const p2 = project({ '.idea/workspace.xml': general('<option name="customMavenHome" value="' + M + '" />') + '<!-- 1 -->\n' });
    explore(p2);
    const due = () => { const r = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['status', '--dir', p2, '--json'], { env: onlyNode }); try { return (JSON.parse(r.out).projects[0] || {}).due; } catch (err) { return '解析不了：' + r.out + r.err; } };
    H.ok('刚探索过：不用再跑', due() === '', due());
    H.write(path.join(p2, '.idea', 'workspace.xml'), general('<option name="customMavenHome" value="' + M + '" />') + '<!-- IDEA 开着，别的地方变了 -->\n');
    H.ok('workspace.xml 别的地方变了：不重新探索', due() === '', due());
    H.write(path.join(p2, '.idea', 'workspace.xml'), general('<option name="customMavenHome" value="' + M + '" /><option name="userSettingsFile" value="' + settings + '" />'));
    H.ok('IDEA 里换了 settings.xml：要重新探索', /IDEA 里配的/.test(due()), due());
    const again = explore(p2);
    H.ok('重新探索后命令跟着变', line(again, '快检').includes('-s "' + settings + '"'), again);

    // 这样的命令钩子还认得
    const F = require(path.join(h.kit, 'lib', 'fail-summary.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const Pol = require(path.join(h.kit, 'lib', 'flow-policy.js'));
    const cmd = head + ' -q -o compile';
    H.ok('失败摘要认得带路径的 Maven', F.kindOf(cmd) === 'Maven', F.kindOf(cmd));
    H.ok('算跑过验证', S.VERIFY_CMD.test(cmd));
    H.ok('编译不算自测', !Pol.testCommand(cmd, false));
    H.ok('带路径的 spring-boot:run 算起服务', Pol.testCommand(head + ' -o spring-boot:run', false));

    // 配置页"自动探测"：IDEA 知道的排最前面
    H.write(path.join(options, 'recentProjects.xml'), '<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="' + fwd(path.join(h.work, 'p1')) + '"><value /></entry></map></option></component></application>\n');
    const probe = path.join(h.root, 'detect.js');
    H.write(probe, 'const api = require(' + JSON.stringify(path.join(H.SRC, 'router', 'kit-api.js')) + ');console.log(JSON.stringify(api.detect(' + JSON.stringify(h.kit) + ')));');
    const det = H.node(h, probe, [], { env: { PATH: path.dirname(process.execPath), MAVEN_HOME: undefined, M2_HOME: undefined, JAVA_HOME: undefined } });
    let found = {}; try { found = JSON.parse(det.out); } catch (err) { found = {}; }
    H.ok('自动探测：IDEA 登记的 JDK 排最前面', !!found.jdks && fwd(found.jdks[0].path) === jdk, det.out + det.err);
    const fm = (found.mavens || [])[0] || {};
    H.ok('自动探测：最近打开过的项目配的 Maven 排最前面，带它的 settings.xml、本地仓库', fwd(fm.home || '') === M && fwd(fm.settings || '') === settings && fwd(fm.repo || '') === repo, det.out + det.err);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 35 条：devserver 起后端不每次拉依赖，缺的只拉缺的');
  {
    const h = H.makeHome('t1102-off', from);
    const M = require(path.join(h.kit, 'lib', 'maven-offline.js'));
    // Maven 3.9 的报错原文（2026-11-02 用真 Maven 跑出来的）
    const dep39 = '[ERROR] Failed to execute goal on project demo: Could not resolve dependencies for project com.t:demo:jar:1.0\n[ERROR] dependency: org.apache.commons:commons-text:jar:1.10.0 (compile)\n[ERROR] \tCannot access central (https://repo.maven.apache.org/maven2) in offline mode and the artifact org.apache.commons:commons-text:jar:1.10.0 has not been downloaded from it before.\n[ERROR] dependency: com.google.guava:guava:jar:31.1-jre (compile)\n[ERROR] \tCannot access central (https://repo.maven.apache.org/maven2) in offline mode and the artifact com.google.guava:guava:jar:31.1-jre has not been downloaded from it before.\n';
    const m39 = M.missingArtifacts(dep39);
    H.ok('Maven 3.9：取出缺的两个依赖，不算项目自己', m39.list.map((x) => x.coord).join() === 'org.apache.commons:commons-text:1.10.0,com.google.guava:guava:31.1-jre' && !m39.blocked, JSON.stringify(m39));
    const dep36 = '[ERROR] Failed to execute goal on project demo: Could not resolve dependencies for project com.t:demo:jar:1.0: The following artifacts could not be resolved: com.a:b:jar:1.0, com.c:d:jar:sources:2.0: Cannot access nexus (http://n/repo) in offline mode and the artifact com.a:b:jar:1.0 has not been downloaded from it before.';
    H.ok('Maven 3.6：一行里列几个，带 classifier 的也认', M.missingArtifacts(dep36).list.map((x) => x.artifact).sort().join() === 'com.a:b:1.0:jar,com.c:d:2.0:jar:sources', JSON.stringify(M.missingArtifacts(dep36)));
    H.ok('缺父 pom：不定向拉', /父 pom/.test(M.missingArtifacts('[FATAL] Non-resolvable parent POM for com.t:demo:1.0: The following artifacts could not be resolved: com.x:parent:pom:9 (absent): Cannot access central (https://x) in offline mode and the artifact com.x:parent:pom:9 has not been downloaded from it before.').blocked));
    H.ok('缺插件：不定向拉', /插件/.test(M.missingArtifacts('[ERROR] Plugin org.apache.maven.plugins:maven-resources-plugin:3.4.0 or one of its dependencies could not be resolved:\n[ERROR] \tCannot access central (https://x) in offline mode and the artifact org.apache.maven.plugins:maven-resources-plugin:jar:3.4.0 has not been downloaded from it before.').blocked));
    const c = M.fetchCommand('"F:/m a/bin/mvn" -s "C:/u/s x.xml" "-Dmaven.repo.local=D:/r" -o spring-boot:run -Dmaven.test.skip=true -pl app -am -P dev', 'com.a:b:1.0:jar');
    H.ok('拉依赖的命令：同一套 Maven、settings.xml、本地仓库、profile，不带 -o 和原来的目标', c === '"F:/m a/bin/mvn" -s "C:/u/s x.xml" "-Dmaven.repo.local=D:/r" -P dev -B dependency:get "-Dartifact=com.a:b:1.0:jar"', c);
    H.ok('不是 Maven 的命令：不拉', M.fetchCommand('node a.js -o', 'x:y:1:jar') === '');
    H.ok('没写 -o：加上', M.addOffline('mvn spring-boot:run -pl app') === 'mvn -o spring-boot:run -pl app', M.addOffline('mvn spring-boot:run -pl app'));
    H.ok('带路径、带引号的：加在 mvn 后面', M.addOffline('"F:/m a/bin/mvn" -s "s x.xml" tomcat7:run') === '"F:/m a/bin/mvn" -o -s "s x.xml" tomcat7:run', M.addOffline('"F:/m a/bin/mvn" -s "s x.xml" tomcat7:run'));
    for (const same of ['mvn -o spring-boot:run', 'mvn --offline spring-boot:run', 'mvn -U spring-boot:run', 'mvn compile', 'npm run dev', 'mvn clean && mvn spring-boot:run', 'java -jar target/a.jar'])
      H.ok('不加 -o：' + same, M.addOffline(same) === same, M.addOffline(same));

    // 假的 mvn：缺依赖时和 Maven 一样报错；dependency:get 记一笔、把依赖"放进本地仓库"；起服务时答 HTTP
    const dev = path.join(h.kit, 'tools', 'devserver.js');
    const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
    const bin = path.join(h.root, 'fakemvn');
    const log = path.join(h.root, 'mvn-calls.txt');
    const have = path.join(h.root, 'have.txt');
    H.write(path.join(bin, 'mvn.cmd'), '@node "%~dp0fake.js" %*\r\n');
    H.write(path.join(bin, 'fake.js'), [
      "const fs = require('fs');",
      "const LOG = " + JSON.stringify(log) + "; const HAVE = " + JSON.stringify(have) + ";",
      "const a = process.argv.slice(2);",
      "fs.appendFileSync(LOG, a.join(' ') + '\\n');",
      "const has = () => { try { return fs.readFileSync(HAVE, 'utf8'); } catch (e) { return ''; } };",
      "const need = process.env.FAKE_NEED || '';",
      "if (a.includes('dependency:get')) {",
      "  if (process.env.FAKE_FETCH_FAIL) { console.log('[ERROR] Could not transfer artifact'); process.exit(1); }",
      "  if (!process.env.FAKE_FETCH_USELESS) fs.appendFileSync(HAVE, (a.find((x) => x.startsWith('-Dartifact=')) || '') + '\\n');",
      "  console.log('[INFO] BUILD SUCCESS'); process.exit(0);",
      "}",
      "if (a.includes('-o') && need && !has().includes(need)) {",
      "  const kind = process.env.FAKE_KIND || 'jar';",
      "  if (kind === 'pom') console.log('[FATAL] Non-resolvable parent POM for com.t:demo:1.0: The following artifacts could not be resolved: com.x:parent:pom:9 (absent): Cannot access central (https://x) in offline mode and the artifact com.x:parent:pom:9 has not been downloaded from it before.');",
      "  else console.log('[ERROR] Failed to execute goal on project demo: Could not resolve dependencies for project com.t:demo:jar:1.0\\n[ERROR] dependency: ' + need.replace(/^(.*:)([^:]+)$/, '$1jar:$2') + ' (compile)\\n[ERROR] \\tCannot access nexus (http://n/r) in offline mode and the artifact ' + need.replace(/^(.*:)([^:]+)$/, '$1jar:$2') + ' has not been downloaded from it before.');",
      "  console.log('[INFO] BUILD FAILURE'); process.exit(1);",
      "}",
      "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('Started Demo in 0.5 seconds'));",
    ].join('\n') + '\n');
    const fwd = (p) => p.replace(/\\/g, '/');
    const mvn = '"' + fwd(path.join(bin, 'mvn')) + '"';
    const calls = () => (H.read(log) || '').trim().split(/\r?\n/).filter(Boolean);
    const reset = () => { for (const f of [log, have]) { try { fs.unlinkSync(f); } catch (e) { /* 没有 */ } } };
    const port = () => 32000 + Math.floor(Math.random() * 800);
    const start = (name, p, command, env) => H.node(h, dev, ['start', '--name', name, '--port', String(p), '--wait', '40', '--', command], { cwd: proj, timeout: 120000, env });
    const stop = () => H.node(h, dev, ['stop', '--all'], { cwd: proj, timeout: 60000 });

    reset();
    const p1 = port();
    const r1 = start('a', p1, mvn + ' -s "' + fwd(path.join(bin, 's x.xml')) + '" "-Dmaven.repo.local=' + fwd(bin) + '/r" -o spring-boot:run', { FAKE_NEED: 'com.foo:bar:1.2' });
    H.ok('pom 新加的依赖本地仓库没有：只拉它，再离线起，起来了', r1.code === 0 && /只拉这 1 个/.test(r1.out) && /起来了/.test(r1.out) && !/去掉 -o/.test(r1.out), r1.out.slice(-900));
    const c1 = calls();
    H.ok('调了三次：离线、拉那一个、再离线', c1.length === 3 && / -o /.test(c1[0]) && /dependency:get/.test(c1[1]) && /-Dartifact=com\.foo:bar:1\.2:jar/.test(c1[1]) && / -o /.test(c1[2]), c1.join(' | '));
    H.ok('拉的时候不带 -o，带着同一个 settings.xml、本地仓库', !/ -o /.test(c1[1]) && /-s /.test(c1[1]) && /-Dmaven\.repo\.local=/.test(c1[1]), c1[1]);
    const r1b = start('a', p1, mvn + ' -s "' + fwd(path.join(bin, 's x.xml')) + '" "-Dmaven.repo.local=' + fwd(bin) + '/r" -o spring-boot:run', { FAKE_NEED: 'com.foo:bar:1.2' });
    H.ok('再 start：认得是在跑的那个', r1b.code === 0 && /已经在跑/.test(r1b.out) && calls().length === 3, r1b.out.slice(-400));
    stop();

    reset();
    const p2 = port();
    const r2 = start('b', p2, mvn + ' spring-boot:run', {});
    H.ok('命令没写 -o：加上，说一声，起来了', r2.code === 0 && /加了 -o/.test(r2.out) && /起来了/.test(r2.out), r2.out.slice(-600));
    H.ok('实际跑的带 -o，没去拉任何东西', calls().length === 1 && /^-o spring-boot:run/.test(calls()[0]), calls().join(' | '));
    const r2b = start('b', p2, mvn + ' spring-boot:run', {});
    H.ok('同一条没写 -o 的命令再 start：认得是在跑的那个，不停掉重来', r2b.code === 0 && /已经在跑/.test(r2b.out) && calls().length === 1, r2b.out.slice(-500));
    stop();

    reset();
    const r3 = start('c', port(), mvn + ' -U spring-boot:run', {});
    H.ok('写了 -U：不加 -o', r3.code === 0 && !/加了 -o/.test(r3.out) && /^-U spring-boot:run/.test(calls()[0] || ''), r3.out.slice(-400) + calls().join(' | '));
    stop();

    reset();
    const r4 = start('d', port(), mvn + ' -o spring-boot:run', { FAKE_NEED: 'com.x:parent:9', FAKE_KIND: 'pom' });
    H.ok('缺父 pom：不拉，去掉 -o 再起一次', r4.code === 0 && /缺的是父 pom/.test(r4.out) && /去掉 -o 再起一次/.test(r4.out) && !calls().some((x) => /dependency:get/.test(x)), r4.out.slice(-600));
    stop();

    reset();
    const r5 = start('e', port(), mvn + ' -o spring-boot:run', { FAKE_NEED: 'com.foo:bar:1.2', FAKE_FETCH_FAIL: '1' });
    H.ok('拉不到：退回去掉 -o 再起一次', r5.code === 0 && /定向拉取没成/.test(r5.out) && /去掉 -o 再起一次/.test(r5.out), r5.out.slice(-700));
    stop();

    reset();
    const r6 = start('f', port(), mvn + ' -o spring-boot:run', { FAKE_NEED: 'com.foo:bar:1.2', FAKE_FETCH_USELESS: '1' });
    H.ok('拉了还报缺：不一直转，退回去掉 -o', r6.code === 0 && /去掉 -o 再起一次/.test(r6.out) && calls().filter((x) => /dependency:get/.test(x)).length === 1, r6.out.slice(-700) + calls().join(' | '));
    stop();
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 36 条：项目声明的驱动直接从本地仓库取，不用登记；配置页不再手动管驱动');
  {
    const h = H.makeHome('t1102-drv', from);
    const rt = H.runtime('auto');
    const repo = path.join(h.home, '.m2', 'repository');
    const inRepo = (g, a, v, ext, text) => { const f = path.join(repo, ...g.split('.'), a, v, a + '-' + v + '.' + (ext || 'jar')); H.write(f, text || 'x'); return f; };
    const scripts = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts');
    if (!rt.python) console.log('    这台电脑上没有 Python，查库这半不测');
    else {
      // 返回 { jar, from } 或 { err }
      const find = (proj, conn) => {
        const py = 'import sys,json\nsys.dont_write_bytecode=True\nsys.path.insert(0,' + JSON.stringify(scripts) + ')\nimport dbconf\ntry:\n  r=dbconf.find_driver_jar(' + JSON.stringify(conn || { dialect: 'mysql' }) + ',' + JSON.stringify(proj) + ')\n  print(json.dumps({"jar":r[0],"from":r[1]},ensure_ascii=False))\nexcept dbconf.ConfError as e:\n  print(json.dumps({"err":str(e)},ensure_ascii=False))\n';
        const r = H.run(h, rt.python, ['-c', py], { env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
        try { return JSON.parse(r.out); } catch (e) { return { err: '跑不了：' + r.out + r.err }; }
      };
      const dep = (g, a, v) => '<dependency><groupId>' + g + '</groupId><artifactId>' + a + '</artifactId>' + (v ? '<version>' + v + '</version>' : '') + '</dependency>';
      const pom = (body) => '<project><groupId>com.t</groupId><artifactId>demo</artifactId><version>1.0</version>' + body + '</project>';
      let n = 0;
      const proj = (files) => H.makeRepo(path.join(h.work, 'd' + (++n)), Object.assign({ '.gitignore': '.vibe/\n' }, files));
      const j833 = inRepo('com.mysql', 'mysql-connector-j', '8.0.33');
      inRepo('com.mysql', 'mysql-connector-j', '8.4.0');
      const r1 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.mysql', 'mysql-connector-j', '8.0.33') + '</dependencies>') }));
      H.ok('pom 写明版本：直接从本地仓库取，不用登记', r1.jar && path.resolve(r1.jar) === path.resolve(j833) && /项目 pom 声明的版本/.test(r1.from), JSON.stringify(r1));
      const r2 = find(proj({ 'pom.xml': pom('<properties><db.ver>8.0.33</db.ver></properties><dependencies>' + dep('com.mysql', 'mysql-connector-j', '${db.ver}') + '</dependencies>') }));
      H.ok('版本写成属性：也认', r2.jar && /8\.0\.33/.test(r2.jar), JSON.stringify(r2));
      // Spring Boot：版本在父 pom 一路往上的 BOM 里，父 pom 只在本地仓库
      inRepo('org.springframework.boot', 'spring-boot-starter-parent', '2.7.18', 'pom', '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>2.7.18</version></parent><artifactId>spring-boot-starter-parent</artifactId></project>');
      inRepo('org.springframework.boot', 'spring-boot-dependencies', '2.7.18', 'pom', '<project><artifactId>spring-boot-dependencies</artifactId><properties><mysql.version>8.0.33</mysql.version></properties><dependencyManagement><dependencies>' + dep('com.mysql', 'mysql-connector-j', '${mysql.version}') + '</dependencies></dependencyManagement></project>');
      const r3 = find(proj({ 'pom.xml': pom('<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version><relativePath/></parent><dependencies>' + dep('com.mysql', 'mysql-connector-j') + '</dependencies>') }));
      H.ok('Spring Boot：版本在父 pom 的 dependencyManagement 里，顺着本地仓库找到', r3.jar && /8\.0\.33/.test(r3.jar), JSON.stringify(r3));
      const r3b = find(proj({ 'pom.xml': pom('<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version><relativePath/></parent><properties><mysql.version>8.4.0</mysql.version></properties><dependencies>' + dep('com.mysql', 'mysql-connector-j') + '</dependencies>') }));
      H.ok('项目覆盖了版本属性：用项目的', r3b.jar && /8\.4\.0/.test(r3b.jar), JSON.stringify(r3b));
      inRepo('com.corp', 'corp-bom', '3', 'pom', '<project><artifactId>corp-bom</artifactId><properties><v>8.0.33</v></properties><dependencyManagement><dependencies>' + dep('com.mysql', 'mysql-connector-j', '${v}') + '</dependencies></dependencyManagement></project>');
      const r4 = find(proj({ 'pom.xml': pom('<dependencyManagement><dependencies><dependency><groupId>com.corp</groupId><artifactId>corp-bom</artifactId><version>3</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement><dependencies>' + dep('com.mysql', 'mysql-connector-j') + '</dependencies>') }));
      H.ok('版本在 import 的 BOM 里：也认', r4.jar && /8\.0\.33/.test(r4.jar), JSON.stringify(r4));
      // 多模块：连接配置在 admin 模块，驱动写在 common 模块
      const mm = proj({ 'pom.xml': pom('<packaging>pom</packaging><modules><module>admin</module><module>common</module></modules>'), 'admin/pom.xml': '<project><parent><groupId>com.t</groupId><artifactId>demo</artifactId><version>1.0</version></parent><artifactId>admin</artifactId></project>', 'common/pom.xml': '<project><parent><groupId>com.t</groupId><artifactId>demo</artifactId><version>1.0</version></parent><artifactId>common</artifactId><dependencies>' + dep('com.mysql', 'mysql-connector-j', '8.0.33') + '</dependencies></project>' });
      const r5 = find(path.join(mm, 'admin'));
      H.ok('驱动写在同一个工程的别的模块：也认', r5.jar && /8\.0\.33/.test(r5.jar), JSON.stringify(r5));
      const r6 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.mysql', 'mysql-connector-j', '5.1.49') + '</dependencies>') }));
      H.ok('声明的版本本地仓库没有：给只拉这一个的命令，不拿别的版本代替', r6.err && /dependency:get "-Dartifact=com\.mysql:mysql-connector-j:5\.1\.49"/.test(r6.err) && /不拿别的版本代替/.test(r6.err), JSON.stringify(r6));
      // IDEA 里配的本地仓库：探索记在 .vibe/onboard.json
      const ideaRepo = path.join(h.root, 'idea-repo');
      const ideaJar = path.join(ideaRepo, 'com', 'mysql', 'mysql-connector-j', '6.0.6', 'mysql-connector-j-6.0.6.jar'); H.write(ideaJar, 'x');
      const onb = (o) => JSON.stringify({ version: 1, maven: o });
      const r7 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.mysql', 'mysql-connector-j', '6.0.6') + '</dependencies>'), '.vibe/onboard.json': onb({ cmd: '"F:/m/bin/mvn" -s "C:/s.xml"', repo: ideaRepo.replace(/\\/g, '/') }) }));
      H.ok('项目在 IDEA 里配的本地仓库：先在那里找', r7.jar && path.resolve(r7.jar) === path.resolve(ideaJar), JSON.stringify(r7));
      const r8 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.mysql', 'mysql-connector-j', '7.7.7') + '</dependencies>'), '.vibe/onboard.json': onb({ cmd: '"F:/m/bin/mvn" -s "C:/s.xml"' }) }));
      H.ok('拉依赖的命令用这个项目的 Maven 和 settings.xml', r8.err && r8.err.includes('"F:/m/bin/mvn" -s "C:/s.xml" dependency:get "-Dartifact=com.mysql:mysql-connector-j:7.7.7"'), JSON.stringify(r8));
      // 版本解析不出来
      const r9 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.mysql', 'mysql-connector-j') + '</dependencies>') }));
      H.ok('版本解析不出来、本地仓库有两个版本：让写 driver_jar，不猜', r9.err && /版本解析不出来/.test(r9.err) && /driver_jar/.test(r9.err), JSON.stringify(r9));
      inRepo('com.oscar', 'oscarJDBC', '9.9');
      const r10 = find(proj({ 'pom.xml': pom('<dependencies>' + dep('com.oscar', 'oscarJDBC') + '</dependencies>') }), { dialect: 'oscar' });
      H.ok('版本解析不出来、本地仓库只有一个版本：就是它', r10.jar && /oscarJDBC-9\.9/.test(r10.jar), JSON.stringify(r10));
      // 项目没声明：老项目的驱动放在 Tomcat 的 lib 里
      const tomcat = path.join(h.root, 'tomcat'); H.write(path.join(tomcat, 'lib', 'kingbase8-8.6.0.jar'), 'x');
      H.write(path.join(h.kit, 'local.json'), JSON.stringify({ tomcats: [{ name: '9', path: tomcat }] }));
      const r11 = find(proj({ 'a.txt': 'x' }), { dialect: 'kingbase' });
      H.ok('项目没声明、驱动在 Tomcat 的 lib 里：找得到', r11.jar && /kingbase8-8\.6\.0/.test(r11.jar), JSON.stringify(r11));
      const r12 = find(proj({ 'a.txt': 'x' }), { dialect: 'dm' });
      H.ok('哪都没有：报错里不再让人去配置页', r12.err && /找不到/.test(r12.err) && /driver_jar/.test(r12.err) && !/配置页/.test(r12.err), JSON.stringify(r12));
    }
    const ui = fs.readFileSync(path.join(from, 'router', 'ui.html'), 'utf8');
    const api = fs.readFileSync(path.join(from, 'router', 'kit-api.js'), 'utf8');
    H.ok('配置页：导航叫"查库"，没有"现在用的驱动"', /<button data-tab="data">查库<\/button>/.test(ui) && !/sec-drv|现在用的驱动|drvList/.test(ui));
    H.ok('配置页的后端：手动管驱动的接口去掉了', !/api\/kit\/drivers/.test(api) && !/driversOp|runTool/.test(api));
    H.ok('各处提示不再让人去配置页"数据库驱动"', !['claude/skills/ttls-db-crud/SKILL.md', 'claude/skills/ttls-db-crud/scripts/db.py', 'claude/skills/ttls-db-crud/scripts/dbconf.py', 'claude/skills/ttls-db-crud/scripts/vibe.py', 'kit/lib/onboard.js'].some((f) => /配置页[^。\n]{0,6}数据库驱动/.test(fs.readFileSync(path.join(from, f), 'utf8'))));
  }

  const wins = await watch.stop();
  H.ok('桌面上没有多出窗口', !wins.length, wins.join('；'));
  H.done('11-02 反馈');
})().catch((e) => { console.error(e); process.exit(1); });

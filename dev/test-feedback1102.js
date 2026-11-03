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
    const inDot = path.join(h.work, '.work', 'proj2');
    H.write(path.join(inDot, '.vibe', 'project.md'), '# 项目\n');
    const docDot = reason(write(path.join(inDot, 'docs', '报告.md')));
    H.ok('项目放在点开头的目录下（不在 git 里、有项目说明）：项目里的文档照旧管', /产出位置/.test(docDot), docDot);
    H.ok('这种项目里的工具目录照旧不拦', !reason(write(path.join(inDot, '.tool-work', 'r.md'))));
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
    const fixed = { id: 'run-plain-2', mode: 'code', status: 'completed', at: Date.now() - 5000, issues: [issue({ problem: '导入没校验表头', avoid: '导入文件之前先校验表头和模板是否一致', kind: '边界' })], decisions: [{ id: 'r1', action: 'fixed', reason: '加了表头校验，复验通过' }] };
    save(fixed);
    const touch = () => { const abs = path.join(p, String(fixed.issues[0].file)); H.write(abs, (H.read(abs) || '') + '// 改过\n'); };
    touch();
    stop([H.tr.user('审一下'), run('--base HEAD', JSON.stringify(fixed))]);
    H.ok('登记了修了、文件确实动过：会话里没看到改文件也收', list().some((c) => /校验表头/.test(c.text)), JSON.stringify(list()));
    const claimed = Object.assign({}, fixed, { id: 'run-plain-4', at: Date.now() + 60000, issues: [issue({ problem: '日志里打了完整手机号', avoid: '日志里的手机号要先打码再输出', kind: '安全' })] });
    save(claimed);
    stop([H.tr.user('审一下'), run('--base HEAD', JSON.stringify(claimed))]);
    H.ok('登记了修了、文件在审查之后没动过：不收，不只听模型说修了', !list().some((c) => /先打码/.test(c.text)), JSON.stringify(list()));
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
    const text = H.read(path.join(h.cfg, 'agents', 'ttls-reviewer.md')) || '';
    H.ok('审查提示要求报类别和以后怎么避免', /\*\*kind\*\*：想当然/.test(text) && /\*\*avoid\*\*/.test(text) && typeof R.runsForLessons === 'function');
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

    H.ok('带引号的路径：说了 PowerShell 里要加 &', /PowerShell 工具里前面要加 &/.test(line(a, '环境')), line(a, '环境'));
    const Rd = require(path.join(h.kit, 'lib', 'readiness.js'));
    const p4 = project({ '.idea/workspace.xml': general('<option name="customMavenHome" value="' + M + '" />') });
    const fp1 = Rd.inspect(p4).fingerprint;
    H.ok('环境就绪的缓存：IDEA 没变，不重算', !!fp1 && Rd.inspect(p4).fingerprint === fp1, fp1);
    H.write(path.join(p4, '.idea', 'workspace.xml'), general('<option name="customMavenHome" value="' + M + '" /><option name="userSettingsFile" value="' + settings + '" />'));
    H.ok('环境就绪的缓存：IDEA 里改了配置，要重算', Rd.inspect(p4).fingerprint !== fp1);

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
    H.write(probe, 'const api = require(' + JSON.stringify(path.join(H.SRC, 'kit', 'ui', 'kit-api.js')) + ');console.log(JSON.stringify(api.detect(' + JSON.stringify(h.kit) + ')));');
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
    const c2 = M.fetchCommand('mvn -Pdev --settings=C:/s.xml -o spring-boot:run -fae', 'com.a:b:1.0:jar');
    H.ok('贴着写的 -Pdev、--settings=：也带上；-fae 不带', c2 === 'mvn -Pdev --settings=C:/s.xml -B dependency:get "-Dartifact=com.a:b:1.0:jar"', c2);
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
    const uiDir = fs.existsSync(path.join(from, 'kit', 'ui')) ? path.join(from, 'kit', 'ui') : path.join(from, 'router');
    const ui = fs.readFileSync(path.join(uiDir, 'ui.html'), 'utf8');
    const api = fs.readFileSync(path.join(uiDir, 'kit-api.js'), 'utf8');
    H.ok('配置页：导航叫"查库"，没有"现在用的驱动"', /<button data-tab="data">查库<\/button>/.test(ui) && !/sec-drv|现在用的驱动|drvList/.test(ui));
    H.ok('配置页的后端：手动管驱动的接口去掉了', !/api\/kit\/drivers/.test(api) && !/driversOp|runTool/.test(api));
    H.ok('各处提示不再让人去配置页"数据库驱动"', !['claude/skills/ttls-db-crud/SKILL.md', 'claude/skills/ttls-db-crud/scripts/db.py', 'claude/skills/ttls-db-crud/scripts/dbconf.py', 'claude/skills/ttls-db-crud/scripts/vibe.py', 'kit/lib/onboard.js'].some((f) => /配置页[^。\n]{0,6}数据库驱动/.test(fs.readFileSync(path.join(from, f), 'utf8'))));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('git 超时和预算（#250、#260—#262、#264、#270、#275—#279）');
  {
    const h = H.makeHome('t1102-git', from);
    const E = require(path.join(h.kit, 'lib', 'evidence.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const W = require(path.join(h.kit, 'lib', 'workspace.js'));
    const I = require(path.join(h.kit, 'lib', 'invocation.js'));
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n' });
    const real = (command, tool) => !!E.actual({ tool_name: tool || 'Bash', cwd: p, tool_use_id: 't', session_id: 's', tool_input: { command }, tool_response: { stdout: '' } });
    for (const c of ['python -c "import json; print(1)"', '/f/x/.venv/Scripts/python.exe -m pip install -q -r /f/x/requirements.txt --index-url http://n/simple 2>&1 | tail -8', 'tasklist 2>/dev/null | grep -i "java\\|node" | head -10', 'node -e "console.log(1)"', 'npm install', 'pnpm add vue', 'mvn dependency:get "-Dartifact=a:b:1"', '"F:/m/bin/mvn" -s "C:/s.xml" dependency:get "-Dartifact=a:b:1"', 'mvn help:effective-pom', 'curl http://localhost:1'])
      H.ok('不算验证、不算指纹：' + c.slice(0, 60), !real(c));
    for (const c of ['mvn -q -o compile', '"F:/apache-maven-3.8.3/bin/mvn" -B -s C:/Users/x/.m2/settings-tz.xml -f pom.xml -q -DskipTests compile 2>&1 | tail -8', 'mvn dependency:get -Dartifact=a:b:1 && mvn compile', 'python -m pytest', 'python test_a.py', 'node dev/test-a.js', 'npx vue-tsc --noEmit', 'npm run build', 'cmd /c mvn test', 'JAVA_HOME=/x mvn compile', 'javac A.java', '.vibe/quick.bat', 'bash .vibe/quick.sh'])
      H.ok('算验证：' + c.slice(0, 60), real(c), c);
    H.ok('PowerShell 的 & 写法也算', real('& "C:\\m\\bin\\mvn.cmd" compile', 'PowerShell'));
    H.ok('grep 参数里的工具名不算跑过验证', !S.VERIFY_CMD.test('tasklist | grep -i "java\\|node" | head'));
    H.ok('真的管道接 node 还算', S.VERIFY_CMD.test('cat a | node b.js'));

    // 不是 git 仓库、文件很多：不抛错；.venv 不算
    const plain = path.join(h.work, 'plain');
    H.write(path.join(plain, 'a.md'), '1\n');
    H.write(path.join(plain, '.venv', 'lib', 'x.py'), 'x\n');
    const f0 = W.fingerprint(plain, 'code').hash;
    H.write(path.join(plain, '.venv', 'lib', 'y.py'), 'y\n');
    H.ok('.venv 里变了：指纹不变', W.fingerprint(plain, 'code').hash === f0);
    H.write(path.join(plain, 'a.md'), '2\n');
    H.ok('项目文件变了：指纹变', W.fingerprint(plain, 'code').hash !== f0);
    const big = path.join(h.work, 'big');
    fs.mkdirSync(path.join(big, 'data'), { recursive: true });
    for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(big, 'data', 'f' + i + '.txt'), 'x');
    let fb = null; let thrown = '';
    try { fb = W.fingerprint(big, 'code'); } catch (e) { thrown = e.message; }
    H.ok('不是 git 仓库、超过上限：不抛"本机范围过大"', fb && !thrown && fb.files.length === 5000, thrown || (fb && fb.files.length));
    H.ok('结果里写明只看了前面这些', fb && fb.truncated === true);
    const before = fb && fb.hash;
    fs.writeFileSync(path.join(big, 'data', 'f0.txt'), 'changed-content');
    H.ok('超过上限也能看出前面的文件变了（按大小和修改时间）', W.fingerprint(big, 'code').hash !== before);

    // git 超时
    const CP = require('child_process');
    const orig = CP.execFileSync;
    const fresh = () => { for (const m of ['workspace.js']) delete require.cache[require.resolve(path.join(h.kit, 'lib', m))]; return require(path.join(h.kit, 'lib', 'workspace.js')); };
    let seen = 0;
    CP.execFileSync = (cmd, args, opts) => { if (cmd === 'git') { seen = opts.timeout; const e = new Error('spawnSync git ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; } return orig(cmd, args, opts); };
    const W2 = fresh();
    let code = '';
    try { I.run(() => W2.checkedGit(p, ['diff', '--name-only']), { budgetMs: 12000 }); } catch (e) { code = e.code; }
    H.ok('钩子里 git 超时：超时给的是剩下的预算，不是 5 秒', seen > 5000 && seen <= 12000, seen);
    H.ok('钩子里 git 超时：算预算用完', code === 'VIBE_HOOK_BUDGET', code);
    let swallowed = 'x';
    try { swallowed = I.run(() => W2.git(p, ['diff', '--name-only']), { budgetMs: 12000 }); } catch (e) { swallowed = e.code; }
    H.ok('预算用完不再被吞成"不是仓库"（#275）', swallowed === 'VIBE_HOOK_BUDGET', swallowed);
    W2.git(p, ['status']);
    H.ok('不在钩子里（命令行工具）：最多等一分钟', seen === 60000, seen);
    CP.execFileSync = orig;
    fresh();

    // 预算用完、git 超时每道检查只算一条
    const probe = path.join(h.root, 'slow.js');
    H.write(probe, [
      "const F = require(" + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ");",
      "const err = (m, c) => { const e = new Error(m); e.code = c; return e; };",
      "F.recordHookError('after-tool 验证证据', { cwd: 'D:/a' }, err('钩子本机检查预算用完，阶段：Git config（jssslt-bpm）；本次放行，诊断已记本机', 'VIBE_HOOK_BUDGET'));",
      "F.recordHookError('after-tool 验证证据', { cwd: 'D:/b' }, err('钩子本机检查预算用完，阶段：Git rev-parse（famous_trees）；本次放行，诊断已记本机', 'VIBE_HOOK_BUDGET'));",
      "F.recordHookError('after-tool 验证证据', { cwd: 'D:/c' }, err('spawnSync git ETIMEDOUT', 'ETIMEDOUT'));",
      "F.recordHookError('verify-gate', { cwd: 'D:/c' }, err('spawnSync git ETIMEDOUT', 'ETIMEDOUT'));",
      "F.recordHookError('verify-gate', { cwd: 'D:/c' }, new Error('别的错'));",
      "console.log(JSON.stringify(F.listRecords().map((r) => r.title)));",
    ].join('\n') + '\n');
    const out = H.node(h, probe, []);
    let titles = []; try { titles = JSON.parse(out.out); } catch (e) { titles = []; }
    H.ok('同一道检查的预算用完、git 超时只算一条', titles.filter((t) => /after-tool.*本机检查超时/.test(t)).length === 1, out.out + out.err);
    H.ok('不同的检查各算各的，别的错照旧单独记', titles.filter((t) => /verify-gate.*本机检查超时/.test(t)).length === 1 && titles.some((t) => /verify-gate.*别的错/.test(t)), out.out + out.err);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('使用情况的轮数（自审）');
  {
    const h = H.makeHome('t1102-rev', from, { reviewBudgetSeconds: 600 });
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
    const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();
    const R2 = require(path.join(h.kit, 'lib', 'review-runner.js'));
    H.write(path.join(p, 'a.js'), 'let a=2;\n');
    await H.fakeReview(R2, { cwd: p, mode: 'code', base });
    const day = H.read(path.join(h.kit, 'state', 'usage.json')) || '';
    H.ok('审一次算一轮：使用情况里不再是 0 轮', /"review\.code":\s*[1-9]/.test(day), day.slice(0, 400));
  }

  // ---------------------------------------------------------------------------------------------
  H.section('SQL 语句本身的错不再上报（用户 2026-11-02 定的）');
  {
    const h = H.makeHome('t1102-sql', from);
    const probe = path.join(h.root, 'sql.js');
    H.write(probe, [
      "const S = require(" + JSON.stringify(path.join(h.kit, 'lib', 'session.js')) + ");",
      "const T = require(" + JSON.stringify(path.join(h.kit, 'lib', 'toolstats.js')) + ");",
      "const F = require(" + JSON.stringify(path.join(h.kit, 'lib', 'feedback.js')) + ");",
      "const codes = process.argv.slice(2);",
      "const errs = {}; for (const c of codes) errs['ttls-db-crud|oracle|' + c] = { tool: 'ttls-db-crud', dialect: 'oracle', code: c, n: 3, cmds: { query: 3 } };",
      "S.writeState('tool-stats', { errs, errsSince: Date.now() - 1000 });",
      "T.reportErrors(Date.now(), 0);",
      "console.log(JSON.stringify({ titles: F.listRecords().map((r) => r.title), left: Object.keys(S.readState('tool-stats').errs || {}).length }));",
    ].join('\n') + '\n');
    const statement = ['SQL_ERROR:42S22', 'SQL_ERROR:42000', 'SQL_ERROR:42S02', 'SQL_ERROR:42703', 'SQL_ERROR:42P01', 'SQL_ERROR:42883', 'SQL_ERROR:42601', 'SQL_ERROR:42000:904', 'SQL_ERROR:42000:942', 'SQL_ERROR:42000:979', 'SQL_ERROR:42000:923', 'SQL_ERROR:42000:1790', 'SQL_ERROR:21000:1427', 'SQL_ERROR:22018', 'SQL_ERROR:99999:30482', 'SQL_ERROR:23505', 'SQL_ERROR:3F000'];
    const keep = ['SQL_ERROR:08000:17410', 'SQL_ERROR:99999:28001', 'SQL_ERROR:61000:20', 'SQL_ERROR:40001', 'CONNECT_FAILED', 'DRIVER_FAILED', 'NO_CONN', 'AUTH_FAILED', 'RUNNER_ERROR'];
    const r = H.node(h, probe, statement.concat(keep));
    let out = {}; try { out = JSON.parse(r.out); } catch (e) { out = {}; }
    const titles = out.titles || [];
    H.ok('列名、表名、语法、类型这类不上报', !statement.some((c) => titles.some((t) => t.endsWith(' ' + c))), r.out + r.err);
    H.ok('连不上、驱动、账号、工具自己出错照旧上报', keep.every((c) => titles.some((t) => t.includes(c))), r.out + r.err);
    H.ok('报完清掉，语句错误不会攒着', out.left === 0, r.out);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 37 条：第一轮几个角度同时审，后面只审修改点；没有 P1、P2 就算过；过程脚本记');
  {
    const h = H.makeHome('t1102-round', from, { reviewBudgetSeconds: 600, reviewLenses: 3 });
    const docLines = ['# Proposal', '', '## Why', '', '顶上这一行不会改：UNCHANGED-MARKER。'].concat(Array.from({ length: 30 }, (_, i) => '第 ' + i + ' 行说明，这几行都不改。'), ['', '## What Changes', '', '- 要改的这一行：第一版。']);
    const doc = docLines.join('\n') + '\n';
    const p = H.makeRepo(path.join(h.work, 'p'), { '.gitignore': '.vibe/\n', 'a.js': 'let a=1;\n', 'b.js': 'let b=1;\n' });
    const dirOf = (n) => path.join(p, 'openspec', 'changes', n);
    const fresh = (n, text) => { H.write(path.join(dirOf(n), 'proposal.md'), text || doc); return n; };
    const edit = (n, to) => H.write(path.join(dirOf(n), 'proposal.md'), doc.replace('第一版', to));
    const iss = (o) => Object.assign({ severity: 'P2', file: 'proposal.md', line: 1, problem: '默认的问题', evidence: '依据', fix: '修法' }, o);
    let answer = () => ({ issues: [] });
    const bodies = [];
    const R = require(path.join(h.kit, 'lib', 'review-runner.js'));
    const P = require(path.join(h.kit, 'lib', 'flow-policy.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const dirFor = (n) => S.allChanges(p).find((c) => c.name === n).dir;
    let planBase = () => undefined;
    const feed = (lens, scope) => { const b = { lens, scope }; bodies.push(b); return answer(b, bodies.length); };
    const go = async (n, a, extra) => { answer = a || (() => ({ issues: [] })); bodies.length = 0; return H.fakeReview(R, Object.assign({ cwd: p, change: n, mode: 'proposal', point: 'proposal' }, extra), feed); };
    const goCode = async (a) => { answer = a; bodies.length = 0; return H.fakeReview(R, { cwd: p, mode: 'code', base: planBase() }, feed); };
    const decide = (n, findings) => { const f = path.join(h.root, n + '-d.json'); H.write(f, JSON.stringify({ findings })); return R.resolve({ cwd: p, change: n, mode: 'proposal', point: 'proposal', decisions: f }); };
    const lensOf = (b) => (/只看一个角度：([^。]+)/.exec(b.scope) || [])[1] || '';
    {
      // 第一轮：三个角度同时审，同一件事合成一条
      fresh('c1');
      let r = await go('c1', (b) => {
        const l = lensOf(b);
        if (l === '事实和范围') return { issues: [iss({ severity: 'P2', problem: '验收条件没法核对，没写怎么算通过' })] };
        if (l === '场景和风险') return { issues: [iss({ severity: 'P1', problem: '验收条件没法核对，没写怎么才算通过' }), iss({ severity: 'P3', problem: '第二段的说法可以再清楚一点' })] };
        return { issues: [] };
      });
      H.ok('第一轮：3 个角度各开一个子代理', bodies.length === 3 && new Set(bodies.map(lensOf)).size === 3 && r.lenses === 3 && r.scope === 'full', { n: bodies.length, lenses: r.lenses, scope: r.scope });
      H.ok('提示按阶段：提案只审提案该管的事，实现细节不审', bodies.every((b) => /这是提案/.test(b.scope) && /不审实现细节/.test(b.scope)), bodies[0].scope);
      H.ok('提示写清 P1、P2、P3 的标准', /P3 说法、写法/.test(bodies[0].scope));
      H.ok('同一件事合成一条，留最严重的；ID 重排', r.issues.length === 2 && r.issues.find((x) => /核对/.test(x.problem)).severity === 'P1' && r.issues.map((x) => x.id).join() === 'r1,r2', r.issues);
      H.ok('P1、P2 算挡通过的：这个点没过', r.blocking === 1 && !P.settled(dirFor('c1'), 'proposal'), { blocking: r.blocking });
      H.ok('结果里写清下一步', /逐条核实/.test(r.next) && /deferred/.test(r.next), r.next);
      const log = path.join(p, '.vibe', 'reviews', 'c1', '审查记录.md');
      H.ok('过程记进审查记录：第 1 轮、每条问题', /## 第 1 轮 · proposal/.test(H.read(log) || '') && /r1 P1 proposal\.md/.test(H.read(log) || '') && /3 个角度同时审/.test(H.read(log) || ''), H.read(log));

      // 改了再审：只审修改点
      edit('c1', '第二版');
      const firstIssues = r.issues;
      const rv = decide('c1', firstIssues.map((x) => /核对/.test(x.problem) ? { id: x.id, action: 'fixed', reason: '补了验收条件，写明怎么算通过' } : { id: x.id, action: 'rejected', reason: '说法没问题，这句就是这个意思' }));
      H.ok('提案修了 P1：要再审一轮；没有跑过编译也能登记', rv.status === 'needs_review', rv);
      r = await go('c1', () => ({ issues: [] }));
      const c = bodies[0].scope;
      H.ok('第二轮：只开一个子代理，不分角度', bodies.length === 1 && !lensOf(bodies[0]) && r.scope === 'changes', { n: bodies.length, scope: r.scope });
      H.ok('第二轮：提示写明只看改对没有、改出新问题没有', /这是复审/.test(bodies[0].scope) && /没改过的内容不要审/.test(bodies[0].scope), bodies[0].scope);
      H.ok('第二轮：带上一轮修了的问题', /上一轮的问题[\s\S]*核对/.test(c), c.slice(0, 500));
      H.ok('第二轮：驳回的放在"已处理"，说了不要再报', /已处理[\s\S]*说法可以再清楚/.test(c) && !/上一轮的问题\n\n```json\n\[[^\]]*说法可以再清楚/.test(c), c.slice(0, 500));
      H.ok('第二轮：材料里有改的那一行，没有没改的内容', /第二版/.test(c) && /第一版/.test(c) && !/UNCHANGED-MARKER/.test(c), c.slice(0, 800));
      H.ok('第二轮没有问题：这个点过了', r.status === 'completed' && P.settled(dirFor('c1'), 'proposal') && r.round === 2, { status: r.status, round: r.round });
      H.ok('审查记录有第 2 轮，也有第 1 轮的处理结果', /只审修改点/.test(H.read(log)) && /## 第 2 轮/.test(H.read(log)) && /处理结果/.test(H.read(log)) && /r1 修了/.test(H.read(log)) && /不成立/.test(H.read(log)), H.read(log));

      // 只有 P3 算过
      fresh('c2');
      r = await go('c2', () => ({ issues: [iss({ severity: 'P3', problem: '这句话的说法可以再顺一点' })] }));
      H.ok('只有 P3：算过，往下走', r.status === 'completed' && r.blocking === 0 && P.settled(dirFor('c2'), 'proposal') && P.pending(dirFor('c2'), 'proposal') === '', { blocking: r.blocking, pending: P.pending(dirFor('c2'), 'proposal') });
      H.ok('只有 P3：结果里说了不用再审', /这个点过了/.test(r.next) && /不用再审/.test(r.next), r.next);
      edit('c2', '顺手改了说法');
      const r2 = decide('c2', [{ id: r.issues[0].id, action: 'fixed', reason: '顺手把这句话改顺了一点' }]);
      H.ok('P3 顺手改了：登记后不再审', r2.status === 'resolved' && P.settled(dirFor('c2'), 'proposal'), r2);

      // 没处理、文件也没改：不问模型，问题还在
      fresh('c3');
      await go('c3', () => ({ issues: [iss({ severity: 'P1', problem: '范围里漏了导出接口' })] }));
      const n3 = await go('c3', () => ({ issues: [] }));
      H.ok('没处理、文件也没改：不问模型，问题照旧算没解决', bodies.length === 0 && n3.blocking === 1 && /漏了导出/.test(n3.issues[0].problem) && !P.settled(dirFor('c3'), 'proposal'), { n: bodies.length, issues: n3.issues });

      // 复审里报到没改过的文件：不算数，也不算没审完
      H.write(path.join(dirOf('c11'), 'proposal.md'), doc);
      await go('c11', () => ({ issues: [] }));
      H.write(path.join(dirOf('c11'), 'specs', 'y', 'spec.md'), '# 规格\n\n## ADDED Requirements\n\n### Requirement: 一条\n\n#### Scenario: 场景\n- **WHEN** 甲\n- **THEN** 乙\n');
      await go('c11', () => ({ issues: [] }), { point: 'specs' });
      H.write(path.join(dirOf('c11'), 'specs', 'y', 'spec.md'), '# 规格\n\n## ADDED Requirements\n\n### Requirement: 一条\n\n#### Scenario: 场景\n- **WHEN** 甲改了\n- **THEN** 乙\n');
      r = await go('c11', () => ({ issues: [iss({ file: 'proposal.md', problem: '提案里有句话不好（这个文件没改过）' })] }), { point: 'specs' });
      H.ok('复审报到没改过的文件：不算数，不算部分覆盖', r.status === 'completed' && r.issues.length === 0 && (r.outOfScope || []).length === 1 && P.settled(dirFor('c11'), 'specs'), { status: r.status, issues: r.issues, out: r.outOfScope, skipped: r.skipped });
      // 只有换行符不一样：不算改过
      fresh('c12');
      await go('c12', () => ({ issues: [iss({ severity: 'P3', problem: '小问题' })] }));
      H.write(path.join(dirOf('c12'), 'proposal.md'), doc.replace(/\n/g, '\r\n'));
      r = await go('c12', () => ({ issues: [] }));
      H.ok('只有换行符不一样：不算改过，不发请求', bodies.length === 0 && r.noChange === true, { n: bodies.length, noChange: r.noChange });
      H.ok('文件没变：结果里说了要整份再审加 --full', /--full/.test(r.next), r.next);
      // 定过的问题一直带着
      fresh('c13');
      r = await go('c13', () => ({ issues: [iss({ problem: '第一轮就驳回的问题' })] }));
      decide('c13', [{ id: 'r1', action: 'rejected', reason: '核对过了，这个问题不成立' }]);
      edit('c13', '第二版');
      await go('c13', () => ({ issues: [iss({ problem: '第二轮冒出来的另一件事' })] }));
      H.ok('第二轮：驳回的在"已处理"里', /已处理[\s\S]*第一轮就驳回/.test(bodies[0].scope));
      edit('c13', '第三版');
      decide('c13', [{ id: 'r1', action: 'fixed', reason: '第二轮的新问题已经改了' }]);
      await go('c13', () => ({ issues: [] }));
      H.ok('第三轮：第一轮驳回的还在"已处理"里，不会再被报一遍', /已处理[\s\S]*第一轮就驳回/.test(bodies[0].scope), bodies[0].scope.slice(0, 400));

      // 驳回过的问题模型又报一遍
      fresh('c16');
      await go('c16', () => ({ issues: [iss({ problem: '验收条件没法核对，没写怎么算通过' })] }));
      decide('c16', [{ id: 'r1', action: 'rejected', reason: '第二节写了怎么算通过，不成立' }]);
      edit('c16', '第二版');
      r = await go('c16', () => ({ issues: [iss({ problem: '验收条件没法核对，没写怎么才算通过' })] }));
      H.ok('驳回过的问题模型又报一遍：不算，不挡通过', r.issues.length === 0 && (r.repeated || []).length === 1 && P.settled(dirFor('c16'), 'proposal'), { issues: r.issues, repeated: r.repeated });
      H.ok('审查记录写了又报了几条', /又报了已经定过的问题 1 条/.test(H.read(path.join(p, '.vibe', 'reviews', 'c16', '审查记录.md')) || ''));
      // 登记被拒绝：决定不能记进去
      fresh('c18');
      await go('c18', () => ({ issues: [iss({ problem: '登记的时候文件已经变了' })] }));
      edit('c18', '改了，但是登记的是驳回');
      let threw = ''; try { decide('c18', [{ id: 'r1', action: 'rejected', reason: '核对过了，这个问题不成立' }]); } catch (e) { threw = e.message; }
      const snap18 = JSON.parse(H.read(path.join(p, '.vibe', 'reviews', 'c18', 'proposal-proposal.snapshot.json')));
      H.ok('登记被拒绝（文件变了）：决定没进下一轮，也没进审查记录', /输入已变化/.test(threw) && snap18.decisions.length === 0 && !/处理结果/.test(H.read(path.join(p, '.vibe', 'reviews', 'c18', '审查记录.md')) || ''), { threw, decisions: snap18.decisions });
      // 留给后面的要点：同一个点复审之后不丢
      fresh('c14');
      await go('c14', () => ({ issues: [iss({ problem: '实现细节：重试次数要写清楚' }), iss({ problem: '验收条件没法核对' })] }));
      edit('c14', '第二版');
      decide('c14', [{ id: 'r1', action: 'deferred', reason: '重试次数归 design，这里不写' }, { id: 'r2', action: 'fixed', reason: '补了验收条件，写明了怎么算通过' }]);
      await go('c14', () => ({ issues: [] }));
      H.ok('有修了的：复审之后这个点过了', P.settled(dirFor('c14'), 'proposal'));
      H.write(path.join(dirOf('c14'), 'design.md'), '# Design\n\n## 验收用例\n\n1. 甲\n');
      await go('c14', () => ({ issues: [] }), { point: 'design' });
      H.ok('复审过的点：留给 design 的要点还在', /上游审查留给这一步的要点[\s\S]*重试次数要写清楚/.test(bodies[0].scope), bodies[0].scope.slice(0, 300));
      await go('c14', () => ({ issues: [] }), { full: true });
      await go('c14', () => ({ issues: [] }), { point: 'design', full: true });
      H.ok('整份重审之后：留给 design 的要点还在', /上游审查留给这一步的要点[\s\S]*重试次数要写清楚/.test(bodies[0].scope), bodies[0].scope.slice(0, 300));
      // 登记修了、改的是别的文件
      const spec = (n, name, text) => H.write(path.join(dirOf(n), 'specs', name, 'spec.md'), '# 规格\n\n## ADDED Requirements\n\n### Requirement: 一条\n\n#### Scenario: 场景\n- **WHEN** ' + text + '\n- **THEN** 乙\n');
      fresh('c15'); spec('c15', 'x', '甲'); spec('c15', 'y', '丙');
      r = await go('c15', () => ({ issues: [iss({ file: 'specs/x/spec.md', problem: '这一条和 y 的规格矛盾' })] }), { point: 'specs' });
      H.ok('规格有问题：报在 x 上', r.issues.length === 1 && /specs[\\/]x/.test(r.issues[0].file), r.issues);
      spec('c15', 'y', '丙改了');
      const d15 = path.join(h.root, 'c15-d.json'); H.write(d15, JSON.stringify({ findings: [{ id: 'r1', action: 'fixed', reason: '矛盾的地方改在 y 的规格里了' }] }));
      R.resolve({ cwd: p, change: 'c15', mode: 'proposal', point: 'specs', decisions: d15 });
      r = await go('c15', () => ({ issues: [] }), { point: 'specs' });
      const c15 = bodies[0].scope;
      H.ok('登记修了、改在别的文件：问题送去核对，连这个文件一起送，核对过就关了', /这一条和 y 的规格矛盾/.test(c15) && /这次没改，只核对/.test(c15) && r.status === 'completed' && r.issues.length === 0, { c: c15.slice(0, 500), status: r.status, issues: r.issues });
      fresh('c20');
      await go('c20', () => ({ issues: [iss({ problem: '说修了其实什么都没改' })] }));
      decide('c20', [{ id: 'r1', action: 'fixed', reason: '说修了，其实一个字都没有改' }]);
      r = await go('c20', () => ({ issues: [] }));
      H.ok('登记修了、什么都没改：不问模型，问题还在', bodies.length === 0 && r.blocking === 1, { n: bodies.length, blocking: r.blocking });
      // 几个角度合并、这一轮审什么（直接测函数）
      const Sc = require(path.join(h.kit, 'lib', 'review-scope.js'));
      const same = Sc.mergeIssues([[iss({ problem: '文档没有说明导入失败时的错误处理' }), iss({ problem: '文档没有说明导出失败时的错误处理' })]]);
      H.ok('同一个角度自己报的两条：不合', same.length === 2, same);
      const far = Sc.mergeIssues([[iss({ file: 'S.java', line: 12, problem: '没有判空，customer 为 null 时报空指针' })], [iss({ file: 'S.java', line: 88, problem: '没有判空，order 为 null 时报空指针' })]]);
      H.ok('不同角度、行号隔得远：不合', far.length === 2, far);
      const one = Sc.mergeIssues([[iss({ line: 12, problem: '验收条件没法核对，没写怎么算通过' })], [iss({ line: 13, severity: 'P1', problem: '验收条件没法核对，没写怎么才算通过' })]]);
      H.ok('不同角度、同一件事：合成一条，留严重的，另一个说法不丢', one.length === 1 && one[0].severity === 'P1' && /怎么算通过/.test(one[0].problem) && /怎么才算通过/.test(one[0].problem), one);
      const longText = Array.from({ length: 100 }, (_, i) => '第 ' + i + ' 行').join('\n') + '\n';
      const cur = (text) => ({ text, root: '', source: '' });
      const pr = Sc.planRound({ currents: new Map([['a.md', cur('没审到的新内容\n')], ['b.md', cur(longText)]]) }, { files: { 'b.md': longText }, covered: ['b.md'], issues: [], decisions: [], closed: [], round: 1 });
      H.ok('上一轮没审到的文件：整份送，说明了不限于改动', pr.scoped && pr.items.length === 1 && pr.items[0].file === 'a.md' && /上一轮没审到/.test(pr.items[0].note), pr.items);

      // 改动太大、--full：全量
      fresh('c6');
      await go('c6', () => ({ issues: [iss({ problem: '大改之前的问题' })] }));
      H.write(path.join(dirOf('c6'), 'proposal.md'), Array.from({ length: 40 }, (_, i) => '整个重写之后的第 ' + i + ' 行').join('\n') + '\n');
      r = await go('c6', () => ({ issues: [] }));
      H.ok('改动超过六成：按第一轮，3 个角度全量审', bodies.length === 3 && r.scope === 'full', { n: bodies.length, scope: r.scope });
      r = await go('c6', () => ({ issues: [] }), { full: true });
      H.ok('--full：整份再审一遍', bodies.length === 3 && r.scope === 'full');

      // 后面的点只审新写的
      fresh('c9');
      await go('c9', () => ({ issues: [iss({ problem: '实现细节：魔数表要写全', severity: 'P2' })] }));
      const d9 = decide('c9', [{ id: 'r1', action: 'deferred', reason: '算法细节归 design，这里不写' }]);
      H.ok('deferred：留给后面的文档，这个点算处理完，不用再审', d9.status === 'resolved' && P.settled(dirFor('c9'), 'proposal'), d9);
      H.write(path.join(dirOf('c9'), 'specs', 'x', 'spec.md'), '# 规格\n\n## ADDED Requirements\n\n### Requirement: 一条\n\n#### Scenario: 场景\n- **WHEN** 甲\n- **THEN** 乙\n');
      r = await go('c9', () => ({ issues: [] }), { point: 'specs' });
      H.ok('specs 这个点：提案是上游文档，只用来核对', /proposal\.md（上游文档/.test(bodies[0].scope) && /- specs\/x\/spec\.md(?:：|\n)/.test(bodies[0].scope) && /这是规格/.test(bodies[0].scope) && /只用来核对/.test(bodies[0].scope), bodies[0].scope.slice(0, 800));
      H.write(path.join(dirOf('c9'), 'design.md'), '# Design\n\n## 验收用例\n\n1. 甲\n');
      r = await go('c9', () => ({ issues: [] }), { point: 'design' });
      H.ok('design 第一轮：带上提案留给它的要点', /上游审查留给这一步的要点[\s\S]*魔数表要写全/.test(bodies[0].scope), bodies[0].scope.slice(0, 300));

      // 代码：第二轮只看改动
      const base = H.git(p, ['rev-parse', 'HEAD']).out.trim();
      planBase = () => base;
      H.write(path.join(p, 'a.js'), 'let a=2;\n');
      H.write(path.join(p, 'b.js'), 'let b=2;\n// B-FILE-MARKER\n');
      r = await goCode(() => ({ issues: [iss({ file: 'a.js', problem: 'a 的初值不对' })] }));
      H.ok('代码第一轮：3 个角度', bodies.length === 3 && r.scope === 'full' && /只看一个角度：(?:需求和连带影响|边界和异常|安全和假验证)/.test(bodies[0].scope), { n: bodies.length });
      const plainFirst = r.issues[0];
      H.write(path.join(p, 'a.js'), 'let a=3;\n');
      r = await goCode(() => ({ issues: [] }));
      const cc = bodies[0].scope;
      H.ok('代码第二轮：只有改过的 a.js，没有 b.js', bodies.length === 1 && r.scope === 'changes' && /let a=3/.test(cc) && !/B-FILE-MARKER/.test(cc), cc.slice(0, 400));
      H.ok('代码第二轮：带上一轮的问题；没改的文件算覆盖', cc.includes(plainFirst.problem) && r.covered.includes('b.js') && r.status === 'completed', { covered: r.covered, status: r.status });
    }

    // 次数不设上限（用户 2026-11-03 定的）：字段表里没有了，升级时从配置文件清掉
    const CF = require(path.join(h.kit, 'lib', 'config-fields.js'));
    H.ok('字段表：审查次数、文件数都没有了', ['requirementsReviewMaxRounds', 'applyReviewMaxRounds', 'reviewMaxFiles', 'reviewExecutor', 'reviewLoop', 'reviewMaxRounds'].every((name) => !CF.FIELDS.find((y) => y.name === name) && CF.REMOVED.includes(name)));

    // 定稿前按审查意见改文档：不再要求写 revisions
    const n = 'c10'; const f = path.join(dirOf(n), 'proposal.md');
    fresh(n);
    const key = S.normKey(f);
    const ask = (sid, withReview) => {
      S.writeState(sid + '-artifacts', { files: { [key]: S.artifactHash(f) }, checkedAt: 0 });
      H.write(f, doc.replace('第一版', '按意见改了 ' + sid));
      const entries = [H.tr.user('接着做')].concat(withReview ? [H.tr.ran('Bash', { command: 'node "$HOME/.claude/vibe-kit/tools/review.js" prepare --change ' + n + ' --mode proposal --point proposal' }, '{}')] : [], [H.tr.ran('Edit', { file_path: f, old_string: 'a', new_string: 'b' }, 'ok')]);
      return reason(H.hook(h, 'verify-gate', { session_id: sid, hook_event_name: 'Stop', cwd: p, transcript_path: H.transcript(path.join(h.root, sid + '.jsonl'), entries) }));
    };
    H.ok('没在审查时改了提案：照旧要写 revisions', /revisions\.md/.test(ask('rev-a', false)));
    H.ok('审查期间按意见改提案：不再要求写 revisions', !/revisions\.md 末尾追加/.test(ask('rev-b', true)), ask('rev-c', true));
    const G = fs.readFileSync(path.join(from, 'kit', 'hooks', 'guard-spec.js'), 'utf8');
    H.ok('子代理连续没交结论停了的点不再挡写下一份文档', /!policy\.halted\(art\.dir, p\)/.test(G));

    // 停了的点不卡死：全自动模式下接着打勾
    {
      const nm = 'c30'; const d = dirOf(nm); const tasks = path.join(d, 'tasks.md');
      H.write(path.join(d, 'proposal.md'), doc);
      H.write(path.join(d, 'specs', 'x', 'spec.md'), '# 规格\n\n## ADDED Requirements\n\n### Requirement: 一条\n\n#### Scenario: 场景\n- **WHEN** 甲\n- **THEN** 乙\n');
      H.write(path.join(d, 'design.md'), '# Design\n\n## 验收用例\n\n1. 甲\n');
      H.write(tasks, '## 1. 甲\n\n- [ ] 1.1 改 a.js；验：`mvn -q -o compile`\n\n## 2. 乙\n\n- [ ] 2.1 改 b.js；验：`mvn -q -o compile`\n');
      const dir = dirFor(nm); const sid = 's-stall';
      H.setConfig(h, { autoMode: true, autoApply: true }); H.inFlow(h, sid, [dir]);
      const tick = (num) => { const tf = H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user('开工')]); return reason(H.hook(h, 'pre-edit', { session_id: sid, hook_event_name: 'PreToolUse', cwd: p, transcript_path: tf, tool_name: 'Edit', tool_input: { file_path: tasks, old_string: '- [ ] ' + num, new_string: '- [x] ' + num }, tool_use_id: 'tu-' + num })); };
      const stall = (point) => { const fp = P.fingerprint(dir, point); P.begin(dir, point, point + '-x', fp); [1, 2, 3].forEach(() => P.noteFail(dir, point)); };
      H.ok('提案没审过：第一次打勾照旧拦', /提案还没审过/.test(tick('1.1')), tick('1.1'));
      ['proposal', 'specs', 'design', 'tasks'].forEach(stall);
      H.ok('需求文档都停了（子代理连续没交）：第一次打勾不再拦"提案还没审过"', !/提案还没审过/.test(tick('1.1')), tick('1.1'));
      H.ok('这时候流程能继续，但不算提案审过', S.reviewAllowed('proposal', dir) && !P.allPassed(dir, 'proposal'));
      H.write(tasks, H.read(tasks).replace('- [ ] 1.1', '- [x] 1.1'));
      H.ok('上一组还没审：打下一组的勾照旧拦', /先完成上一整组/.test(tick('2.1')), tick('2.1'));
      stall('group-1');
      H.ok('上一组停了：接着打下一组的勾，不卡死', !/先完成上一整组/.test(tick('2.1')), tick('2.1'));
      H.setConfig(h, { autoMode: false, autoApply: false });
    }
  }

  // ---------------------------------------------------------------------------------------------
  H.section('第 38 条：需求跑着不再被催去改 plan.md');
  {
    const h = H.makeHome('t1102-plan', from);
    const row = (name, status) => '| 模块 | ' + name + ' | ' + status + ' | |';
    const planOf = (rows) => ['# 计划：大需求', '', '| 模块 | 变更名 | 状态 | 说明 |', '|---|---|---|---|'].concat(rows, ['']).join('\n');
    const mk = (name, plan) => H.makeRepo(path.join(h.work, name), Object.assign({ '.gitignore': '.vibe/\n', 'openspec/changes/new-one/proposal.md': '# Proposal\n\n## Why\n\n要做一件新事。\n' }, plan));
    const stop = (p, sid) => {
      const f = path.join(p, 'openspec', 'changes', 'new-one', 'proposal.md');
      const tf = H.transcript(path.join(h.root, sid + '.jsonl'), [H.tr.user('接着做'), H.tr.ran('Edit', { file_path: f, old_string: 'a', new_string: 'b' }, 'ok')]);
      return H.hook(h, 'verify-gate', { session_id: sid, hook_event_name: 'Stop', cwd: p, transcript_path: tf });
    };
    const textOf = (o) => JSON.stringify(o || {});
    const p1 = mk('a', { 'openspec/plan.md': planOf([row('还没开始的变更', '未开始')]) });
    const o0 = stop(p1, 's-plan-1');
    H.ok('变更不在计划表里：不让模型去改 plan.md', !/在表里加一行|plan\.md/.test(textOf(o0)), textOf(o0));
    // 前面还有别的事要拦（写完 proposal 要问用户）：这一次提醒不出，等真正收工
    const o1 = stop(p1, 's-plan-1');
    H.ok('这一条不拦收工，真正收工时提醒用户一句', !(o1 && o1.decision === 'block') && /不在计划表[\s\S]*告诉 Claude 加一行/.test(textOf(o1)) && !!o1.systemMessage, textOf(o1));
    H.ok('同一个变更只提醒一次', !/不在计划表/.test(textOf(stop(p1, 's-plan-1'))));
    H.write(path.join(h.work, 'b', 'openspec', 'changes', 'archive', '2026-10-01-done-one', 'proposal.md'), '# x\n');
    const p2 = mk('b', { 'openspec/plan.md': planOf([row('done-one', '已归档 2026-10-01')]) });
    stop(p2, 's-plan-3');
    H.ok('计划里的变更都做完了：不提醒', !/不在计划表/.test(textOf(stop(p2, 's-plan-3'))), textOf(stop(p2, 's-plan-3')));
    const p3 = mk('c', {});
    stop(p3, 's-plan-5');
    H.ok('没有 plan.md：不提', !/计划表|plan\.md/.test(textOf(stop(p3, 's-plan-5'))));
    const start = H.hook(h, 'session-start', { session_id: 's-plan-6', hook_event_name: 'SessionStart', source: 'startup', cwd: p1 });
    H.ok('会话开头说实话：文件里的状态列跑 plan.js 才更新；没有用户的话不自己加行', /跑 plan\.js 才更新/.test(textOf(start)) && /不要自己往表里加行/.test(textOf(start)) && !/由钩子按实际情况维护/.test(textOf(start)), textOf(start).slice(0, 600));
  }

  const wins = await watch.stop();
  H.ok('桌面上没有多出窗口', !wins.length, wins.join('；'));
  H.done('11-02 反馈');
})().catch((e) => { console.error(e); process.exit(1); });

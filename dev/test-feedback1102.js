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

  const wins = await watch.stop();
  H.ok('桌面上没有多出窗口', !wins.length, wins.join('；'));
  H.done('11-02 反馈');
})().catch((e) => { console.error(e); process.exit(1); });

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

  const wins = await watch.stop();
  H.ok('桌面上没有多出窗口', !wins.length, wins.join('；'));
  H.done('11-02 反馈');
})().catch((e) => { console.error(e); process.exit(1); });

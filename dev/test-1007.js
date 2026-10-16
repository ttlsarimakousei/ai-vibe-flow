'use strict';
/*
 * 2026-10-07 这一批（用户用下来提的四件事）：
 *   产出不算流程      全自动开着、会话在流程里，说"帮我生成一个文件记一下""写一份接口文档"：这一轮不在流程里，放哪照常问，全自动不作数
 *   公共配置被盖掉    application.yml 里的库被 application-dev.yml 用同一个键换掉了：公共配置那一条不算开发库（redis 一样）
 *   自动挑端口        devserver --port auto：30000 到 39999，离 --avoid 的端口远，同一个服务每次同一个端口，{port} 和环境变量
 *   按阶段提交        autoCommit = phase：tasks.md 里同一个大编号的任务全打勾了才催提交
 * 用法：node dev/test-1007.js [端口，默认 18757]
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18757;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };

(async () => {
  const watch = await H.watchWindows('t1007-win');

  // ---------------------------------------------------------------------------------------------
  H.section('开口：让它出一份文档、生成一个文件记东西，不算在流程里（全自动不作数，放哪照常问）');
  {
    const h = H.makeHome('t1007-flow', null, { autoMode: true });
    const proj = H.makeRepo(path.join(h.work, 'crm'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n', 'openspec/changes/add-export/tasks.md': '- [ ] 1.1 改 src/main/java/A.java；验：mvn -q compile\n' });
    const tf = H.transcript(path.join(h.root, 'f.jsonl'), [H.tr.user('开始')]);
    const say = (sid, prompt) => { const o = H.hook(h, 'task-anchor', { session_id: sid, cwd: proj, hook_event_name: 'UserPromptSubmit', prompt, transcript_path: tf }); return o ? String(o.raw || JSON.stringify(o)) : ''; };
    const flow = (sid) => readJson(path.join(h.kit, 'state', sid + '-flow.json'));
    say('f1', '/opsx:apply add-export');
    H.ok('（敲了 /opsx:apply：在流程里）', flow('f1').on === true, flow('f1'));
    const r1 = say('f1', '帮我生成一个文件用来记录这次改动的要点');
    H.ok('在流程里让它生成一个文件记东西：这一轮不在流程里', flow('f1').on === false, flow('f1'));
    H.ok('提醒它开工前先定好放哪，是问我的说法，不是全自动的"先放 pending"', /开工前先定好放哪/.test(r1) && /用提问框问我/.test(r1) && !/pending/.test(r1), r1);
    const w = H.hook(h, 'pre-edit', { session_id: 'f1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, '改动要点.md'), content: '# 要点\n' } });
    H.ok('真要写的时候拦下问位置，不是全自动那套"不要问"', !!w && w.decision === 'block' && /放哪还没跟用户定过/.test(H.reasonOf(w)) && /用提问框问用户/.test(H.reasonOf(w)) && !/全自动模式/.test(H.reasonOf(w)), H.reasonOf(w));
    say('f1', '继续');
    H.ok('说"继续"接回流程', flow('f1').on === true, flow('f1'));
    say('f1', '写一份接口文档');
    H.ok('"写一份接口文档"也不算流程里的活', flow('f1').on === false, flow('f1'));
    say('f1', '做一个导出订单的功能');
    H.ok('"做一个导出订单的功能"照旧算需求、进流程', flow('f1').on === true, flow('f1'));
    const r2 = say('f2', '帮我做一个记录问题的 excel');
    H.ok('新会话里让它做个 excel：不当需求（不提"先探索再提案"），提醒先定放哪', flow('f2').on === false && !/这像一条需求/.test(r2) && /先定好放哪/.test(r2), [flow('f2'), r2]);
    const r3 = say('f3', '做一个文件上传功能');
    H.ok('"做一个文件上传功能"是代码的活，照旧是需求', flow('f3').on === true && /这像一条需求/.test(r3), [flow('f3'), r3]);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('后台探索：公共配置里被开发环境配置盖掉的连接不算开发库');
  {
    const D = require(path.join(H.SRC, 'kit', 'lib', 'discover.js'));
    const root = H.tempDir('t1007-scan');
    const w2 = (rel, lines) => H.write(path.join(root, rel), Array.isArray(lines) ? lines.join('\n') + '\n' : lines);
    const ds = (url) => ['spring:', '  datasource:', '    url: ' + url, '    username: u', '    password: p'];
    // m1：公共配置里的库被 application-dev.yml 用同一个键换掉
    w2('m1/pom.xml', '<project/>');
    w2('m1/src/main/resources/application.yml', ds('jdbc:mysql://10.7.7.1:3306/app'));
    w2('m1/src/main/resources/application-dev.yml', ds('jdbc:mysql://10.7.7.2:3306/app'));
    // m2：多数据源，dev 只换了 slave：master 的公共配置照算
    w2('m2/pom.xml', '<project/>');
    w2('m2/src/main/resources/application.yml', ['spring:', '  datasource:', '    dynamic:', '      datasource:', '        master:', '          url: jdbc:mysql://10.7.8.1:3306/app', '          username: u', '          password: p', '        slave:', '          url: jdbc:mysql://10.7.8.3:3306/app', '          username: u', '          password: p']);
    w2('m2/src/main/resources/application-dev.yml', ['spring:', '  datasource:', '    dynamic:', '      datasource:', '        slave:', '          url: jdbc:mysql://10.7.8.2:3306/app', '          username: u', '          password: p']);
    // m3：同一个文件里分段，on-profile: dev 那一段换掉了公共那一段
    w2('m3/pom.xml', '<project/>');
    w2('m3/src/main/resources/application.yml', ds('jdbc:mysql://10.7.9.1:3306/app').concat(['---', 'spring:', '  config:', '    activate:', '      on-profile: dev', '  datasource:', '    url: jdbc:mysql://10.7.9.2:3306/app', '    username: u', '    password: p']));
    // m4：公共配置在 resources/，开发环境的在 resources/config/（Spring 两处都读）
    w2('m4/pom.xml', '<project/>');
    w2('m4/src/main/resources/application.properties', 'spring.datasource.url=jdbc:mysql://10.7.10.1:3306/app\nspring.datasource.username=u\nspring.datasource.password=p\n');
    w2('m4/src/main/resources/config/application-dev.properties', 'spring.datasource.url=jdbc:mysql://10.7.10.2:3306/app\nspring.datasource.username=u\nspring.datasource.password=p\n');
    // m5：redis 一样
    w2('m5/pom.xml', '<project/>');
    w2('m5/src/main/resources/application.yml', ['spring:', '  redis:', '    host: 10.7.11.1', '    port: 6379']);
    w2('m5/src/main/resources/application-dev.yml', ['spring:', '  redis:', '    host: 10.7.11.2', '    port: 6379']);
    const r = D.scanDb(root).found;
    const at = (ip) => r.find((x) => x.url.includes(ip)) || {};
    H.ok('公共配置里的库被 application-dev.yml 换掉了：不算开发库，说了原因', at('10.7.7.1').devOnly === false && /被盖掉/.test(at('10.7.7.1').why) && at('10.7.7.2').devOnly === true, [at('10.7.7.1'), at('10.7.7.2')]);
    H.ok('多数据源：dev 只换了 slave，master 的公共配置照算', at('10.7.8.1').devOnly === true && at('10.7.8.3').devOnly === false && at('10.7.8.2').devOnly === true, [at('10.7.8.1'), at('10.7.8.3'), at('10.7.8.2')]);
    H.ok('同一个文件里分段的：公共那一段被 dev 那一段盖掉', at('10.7.9.1').devOnly === false && at('10.7.9.2').devOnly === true, [at('10.7.9.1'), at('10.7.9.2')]);
    H.ok('开发环境的配置在 config/ 子目录里：也认', at('10.7.10.1').devOnly === false && at('10.7.10.2').devOnly === true, [at('10.7.10.1'), at('10.7.10.2')]);
    const rd = D.scanRedis(root).found;
    const rb = (hst) => rd.find((x) => x.host === hst) || {};
    H.ok('redis 一样', rb('10.7.11.1').devOnly === false && rb('10.7.11.2').devOnly === true, [rb('10.7.11.1'), rb('10.7.11.2')]);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('起服务：--port auto 自动挑端口，离项目配置的远');
  {
    const dh = H.makeHome('t1007-dev');
    const TOOL = path.join(dh.kit, 'tools', 'devserver.js');
    const app = H.makeRepo(path.join(dh.work, 'app'), { 'pom.xml': '<project/>' });
    H.write(path.join(app, 'srv.js'), [
      "const http = require('http');",
      "require('fs').writeFileSync(require('path').join(__dirname, 'env.json'), JSON.stringify({ PORT: process.env.PORT, SERVER_PORT: process.env.SERVER_PORT, arg: process.argv[2] }));",
      "http.createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');",
    ].join('\n'));
    const tool = (args) => H.node(dh, TOOL, args, { cwd: app, timeout: 120000 });
    const lastLine = (r) => r.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const rec = (name) => readJson(path.join(app, '.vibe', 'run', name + '.json'));
    const autoArgs = (name, avoid) => ['start', '--name', name, '--port', 'auto'].concat(avoid ? ['--avoid', avoid] : []).concat(['--wait', '20', '--', 'node', 'srv.js', '{port}']);
    const s1 = tool(autoArgs('api', '8080,8081'));
    const p1 = rec('api').port;
    const envj = readJson(path.join(app, 'env.json'));
    H.ok('自动挑的端口在 30000 到 39999 里，起来了，最后一行说了是自动挑的、避开了哪些', s1.code === 0 && p1 >= 30000 && p1 <= 39999 && /^起来了：api，端口 3\d{4}（自动挑的，避开了项目配置的 8080、8081/.test(lastLine(s1)), [lastLine(s1), p1]);
    H.ok('{port} 换成了挑到的端口，环境变量 PORT、SERVER_PORT 也是它', String(envj.arg) === String(p1) && envj.PORT === String(p1) && envj.SERVER_PORT === String(p1), envj);
    const st = tool(['status']);
    H.ok('status 里标着自动挑的', /api：在跑，端口 \d+（自动挑的）/.test(st.out), st.out);
    tool(['stop', '--name', 'api']);
    const s2 = tool(autoArgs('api', '8080,8081'));
    H.ok('停了再起：还是同一个端口（场景文件里写的地址不用改）', s2.code === 0 && rec('api').port === p1, [p1, rec('api').port, lastLine(s2)]);
    tool(['stop', '--name', 'api']);
    // 那个端口被别的程序占了：换下一个
    const hold = net.createServer();
    await new Promise((resolve) => hold.listen(p1, '127.0.0.1', resolve));
    const s3 = tool(autoArgs('api', '8080,8081'));
    const p3 = rec('api').port;
    H.ok('挑到的端口被别的程序占着：换下一个，还在范围里', s3.code === 0 && p3 !== p1 && p3 >= 30000 && p3 <= 39999, [p1, p3, lastLine(s3)]);
    tool(['stop', '--all']);
    await new Promise((resolve) => hold.close(resolve));
    // 离 --avoid 的端口至少 1000
    tool(autoArgs('web'));
    const pw = rec('web').port;
    tool(['stop', '--name', 'web']);
    tool(autoArgs('web', String(pw)));
    const pw2 = rec('web').port;
    H.ok('离 --avoid 的端口至少 1000', pw2 >= 30000 && pw2 <= 39999 && Math.abs(pw2 - pw) >= 1000, [pw, pw2]);
    tool(['stop', '--all']);
    // 旧写法：指定端口照样能用
    const e1 = tool(['start', '--name', 'fixed', '--port', String(PORT), '--wait', '20', '--', 'node', 'srv.js', String(PORT)]);
    H.ok('指定端口的旧写法照样能用，最后一行不说"自动挑的"', e1.code === 0 && new RegExp('^起来了：fixed，端口 ' + PORT + '，').test(lastLine(e1)), lastLine(e1));
    tool(['stop', '--all']);
    const e0 = tool(['start', '--name', 'x', '--', 'node', 'srv.js', '1']);
    H.ok('没写 --port：说要写 auto 或者端口', e0.code === 2 && /--port auto/.test(e0.out), e0.out);
  }

  // ---------------------------------------------------------------------------------------------
  H.section('按阶段提交：tasks.md 里同一个大编号的任务全打勾了才催提交');
  {
    const ph = H.makeHome('t1007-phase', null, { autoApply: true, autoCommit: 'phase', autoVerify: false, autoSeePage: false, autoCrossReview: false, lessons: 'off', vibeTidy: false, specGate: false });
    const pp = H.makeRepo(path.join(ph.work, 'shop'), { 'pom.xml': '<project/>\n', 'src/main/java/A.java': 'class A {}\n', 'src/main/java/B.java': 'class B {}\n', 'openspec/changes/add-x/tasks.md': ['- [ ] 1.1 改 src/main/java/A.java；验：mvn -q compile', '- [ ] 1.2 改 src/main/java/B.java；验：mvn -q compile', '- [ ] 2.1 改 src/main/java/A.java；验：mvn -q compile', ''].join('\n') });
    const chg = path.join(pp, 'openspec', 'changes', 'add-x');
    const tasks = path.join(chg, 'tasks.md');
    const tfile = path.join(ph.root, 'p.jsonl');
    const sid = 's-phase';
    H.inFlow(ph, sid, [chg], true, 'apply');
    // 仓库刚建好就打勾、改文件：提交和打勾落在同一秒里，分不出先后（真用的时候提交早就在前面了）
    await H.sleep(1200);
    const sync = () => H.node(ph, '-e', ['require(' + JSON.stringify(path.join(ph.kit, 'lib', 'session.js')) + ').syncTicks(' + JSON.stringify(chg) + ')'], { cwd: pp });
    sync();
    const tick = (num) => { fs.writeFileSync(tasks, fs.readFileSync(tasks, 'utf8').replace('- [ ] ' + num, '- [x] ' + num)); sync(); return H.tr.ran('Edit', { file_path: tasks, old_string: '- [ ] ' + num, new_string: '- [x] ' + num }, 'ok'); };
    const edit = (rel, text) => { H.write(path.join(pp, rel), text); return H.tr.ran('Edit', { file_path: path.join(pp, rel), old_string: 'x', new_string: 'y' }, 'ok'); };
    const stop = (entries, said) => H.hook(ph, 'verify-gate', { session_id: sid, cwd: pp, hook_event_name: 'Stop', transcript_path: H.transcript(tfile, entries), stop_hook_active: false, last_assistant_message: said || '做完了' });
    const e1 = edit('src/main/java/A.java', 'class A { int a; }\n');
    const t11 = tick('1.1');
    const r1 = stop([H.tr.user('做 1.1'), e1, t11, H.tr.say('1.1 做完了')]);
    H.ok('1.x 还没做完（1.2 没打勾）：改了文件也不催提交', !/还没提交/.test(H.reasonOf(r1)), H.reasonOf(r1));
    const e2 = edit('src/main/java/B.java', 'class B { int b; }\n');
    const t12 = tick('1.2');
    H.reviewPoints(ph, chg);
    const r2 = stop([H.tr.user('做 1.2'), e1, t11, e2, t12, H.tr.say('1.2 做完了')]);
    H.ok('1.x 全打勾了：催提交，说的是"一个阶段一次提交"', !!r2 && r2.decision === 'block' && /还没提交/.test(H.reasonOf(r2)) && /一个阶段（tasks\.md 里同一个大编号的任务）一次提交/.test(H.reasonOf(r2)), H.reasonOf(r2));
    H.git(pp, ['add', 'src/main/java/A.java', 'src/main/java/B.java', 'openspec/changes/add-x/tasks.md']);
    H.git(pp, ['commit', '-q', '-m', 'feat: 第一阶段']);
    const r3 = stop([H.tr.user('做 1.2'), e1, t11, e2, t12, H.tr.say('提交了')]);
    H.ok('提交之后再收工：不催', !/还没提交/.test(H.reasonOf(r3)), H.reasonOf(r3));
    await H.sleep(1200);
    const e3 = edit('src/main/java/A.java', 'class A { int a; int c; }\n');
    const t21 = tick('2.1');
    H.reviewPoints(ph, chg);
    const r4 = stop([H.tr.user('做 2.1'), e3, t21, H.tr.say('2.1 做完了')]);
    H.ok('2.x 做完了（这个阶段只有一项）：催提交', !!r4 && r4.decision === 'block' && /还没提交/.test(H.reasonOf(r4)), H.reasonOf(r4));
    // 对照：每项任务提交（默认）时，改了 A.java 没提交就催
    H.setConfig(ph, { autoCommit: 'task' });
    const again = [H.tr.user('再改一下'), edit('src/main/java/A.java', 'class A { int a; int c; int d; }\n'), H.tr.say('改好了')];
    // A.java 审过之后又改了：旧审查结论失效，先复审 1.x，不能为了提交跳过审查（1014 起）
    const r5 = stop(again);
    H.ok('审过的文件又改了：先复审该组，不先催提交', !!r5 && /审查点 group-1/.test(H.reasonOf(r5)) && !/还没提交|接着提交/.test(H.reasonOf(r5)), H.reasonOf(r5));
    H.reviewPoints(ph, chg);
    const r6 = stop(again);
    H.ok('对照：每项任务提交时，改了就催，说的是"一项任务一次提交"', !!r6 && /还没提交/.test(H.reasonOf(r6)) && /一项任务一次提交/.test(H.reasonOf(r6)), H.reasonOf(r6));
    const api = require(path.join(H.SRC, 'router', 'kit-api.js'));
    H.ok('开关存得进去', api.cleanConfig({ autoCommit: 'phase' }).autoCommit === 'phase' && /value="phase"/.test(H.read(path.join(H.SRC, 'router', 'ui.html')) || ''));
    const gen = H.node(ph, path.join(ph.kit, 'install.js'), ['--sync'], { cwd: ph.root, timeout: 60000 });
    const md2 = H.read(path.join(ph.cfg, 'CLAUDE.md')) || '';
    H.ok('约定里写的是每项任务提交（开关改回 task 之后重新生成）', gen.code === 0 && /每项任务完成后按具体任务提交/.test(md2), md2.slice(0, 200));
    H.setConfig(ph, { autoCommit: 'phase' });
    H.node(ph, path.join(ph.kit, 'install.js'), ['--sync'], { cwd: ph.root, timeout: 60000 });
    const md3 = H.read(path.join(ph.cfg, 'CLAUDE.md')) || '';
    H.ok('开关是按阶段时，约定和提交节奏都写按阶段', /同一组 1\.x 完成并审修、自测后提交一次/.test(md3), md3.slice(0, 200));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('2026-10-07 这一批');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

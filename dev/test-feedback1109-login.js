'use strict';
/*
 * 问题表第 75 条（docs/feedback-20261109-2.md）：换个需求就忘了怎么启动项目、用哪个账号。
 *   1. 测试账号表 .vibe/login.json：格式、汇总不带口令、场景引用、记上次登录成功、照项目文件找候选（lib/login.js、tools/login.js）
 *   2. devserver 起来之后把这次的命令写进项目说明的"跑通的启动"一行，stop 不删；提一句账号
 *   3. 场景执行器替换 {{login.<名字>.<字段>}}，跑通了记 lastOk，口令不进输出
 *   4. 会话开始带账号汇总、壳子里子项目带跑通的启动和账号名字；用户给了账号提醒记下来
 *   5. 账号文件、登录场景写进 .vibe/tmp/ 拦一次（tmp 会被清）；.vibe 根下乱放的提示里说启动方式、账号放哪
 * 只用假项目和回环端口。参数：[旧套件目录]（拿上一版跑看多少项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const from = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const SRC = from || H.SRC;
const PWD = 'S3cret!x9';
const LOGIN = { accounts: [{ name: 'admin', user: 'admin', password: PWD, role: '超级管理员', modules: ['系统管理', '审批'], from: '用户给的' }, { name: 'bad', user: 'admin', password: 'wrong-pass', role: '错的', from: '测试' }] };
const SERVER = [
  "const http = require('http');",
  "http.createServer((q, s) => {",
  "  let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {",
  "    s.setHeader('content-type', 'application/json');",
  "    if (q.url === '/api/login') { let o = {}; try { o = JSON.parse(b); } catch (e) { o = {}; } s.end(JSON.stringify({ code: o.user === 'admin' && o.password === " + JSON.stringify(PWD) + " ? 0 : 1 })); return; }",
  "    s.end(JSON.stringify({ ok: true }));",
  "  });",
  "}).listen(Number(process.env.PORT), '127.0.0.1');",
].join('\n');

(async () => {
  const h = H.makeHome('fb1109-login', from, { autoUpdate: 'off' });
  const proj = H.makeRepo(path.join(h.work, 'app'), { '.gitignore': '.vibe/\n', 'package.json': '{"name":"fake-app"}\n', 'srv.js': SERVER + '\n' });
  const tool = (args, cwd) => H.node(h, path.join(h.kit, 'tools', 'devserver.js'), args, { cwd: cwd || proj, timeout: 120000 });
  const pm = path.join(proj, '.vibe', 'project.md');
  const runLines = (f) => ((H.read(f || pm) || '').match(/^- 跑通的启动（.*$/gm) || []);
  let L = null;
  try { L = require(path.join(h.kit, 'lib', 'login.js')); } catch (e) { L = null; }

  H.section('账号表：读、汇总、引用、记成功、检查、找候选');
  {
    H.ok('有 lib/login.js', !!L);
    const d = path.join(h.work, 'acc');
    H.write(path.join(d, '.vibe', 'login.json'), JSON.stringify({ admin: { 账号: 'admin', 密码: 'a-pass-1', 角色: '超级管理员', 模块: '系统管理、审批' }, zs: { username: 'zhangsan', password: 'z-pass-2' } }));
    H.write(path.join(d, 'sql', 'init.sql'), "INSERT INTO sys_user (id, user_name, password) VALUES (1, 'admin', 'hash');\nINSERT INTO t_order VALUES (1);\n");
    H.write(path.join(d, 'src', 'main', 'resources', 'application.yml'), 'sys:\n  user:\n    initPassword: 123456\n');
    H.write(path.join(d, 'src', 'main', 'resources', 'application-prod.yml'), 'default-password: prod-only\n');
    const f = path.join(d, '.vibe', 'login.json');
    if (L) {
      const t = L.read(f);
      H.ok('中文键名、按名字分的对象也读得出', t.ok && t.accounts.length === 2 && t.accounts[0].user === 'admin' && t.accounts[0].password === 'a-pass-1' && t.accounts[0].modules.join('|') === '系统管理|审批' && t.accounts[1].name === 'zs', t);
      const s = L.summary(f);
      H.ok('汇总列出账号、角色、模块，不带口令', /admin（超级管理员；系统管理、审批）/.test(s) && /zs（账号 zhangsan）/.test(s) && !/a-pass-1|z-pass-2/.test(s) && /不要再问用户/.test(s), s);
      const used = new Set();
      H.ok('引用换成账号表里的值', L.resolve('{{login.admin.user}}:{{login.zs.password}}', t, used) === 'admin:z-pass-2' && used.size === 2);
      let err = '';
      try { L.resolve('{{login.nobody.user}}', t); } catch (e) { err = e.message; }
      H.ok('没有这个账号：报错说有哪些', /没有叫 nobody 的账号（有：admin、zs）/.test(err), err);
      err = '';
      try { L.resolve('{{login.admin.user}}', { ok: false, file: '', accounts: [] }); } catch (e) { err = e.message; }
      H.ok('没有账号表：报错说怎么找、记在哪', /没找到测试账号表/.test(err) && /login\.js" find/.test(err), err);
      H.ok('记上次登录成功：原来的键名、别的内容不动', L.markOk(f, ['admin']) === 1 && (() => { const o = JSON.parse(H.read(f)); return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(o.admin.lastOk) && o.admin.密码 === 'a-pass-1' && !o.zs.lastOk; })(), H.read(f));
      const c = L.check(f);
      H.ok('检查：缺 from、不是 accounts 数组都说', c.some((x) => /admin 没写 from/.test(x)) && c.some((x) => /顶层要有 accounts/.test(x)), c);
      const fd = L.find(d);
      H.ok('找候选：初始化 SQL 里插用户表的、配置里的初始密码；生产配置、别的表不算', fd.seed.length === 1 && /sys_user/.test(fd.seed[0].text) && fd.config.length === 1 && /initPassword/.test(fd.config[0].text), fd);
      H.write(path.join(d, '.vibe', 'bad.json'), '{oops');
      H.ok('不是 JSON：说清', /不是合法的 JSON/.test(L.read(path.join(d, '.vibe', 'bad.json')).error));
      // 复审 1：口令没加引号的坏 JSON，Node 的报错会引出原文；汇总、命令行都不能带出来
      const bad2 = path.join(h.work, 'acc-bad', '.vibe', 'login.json');
      H.write(bad2, '{\n"user": "a",\n"password": Leak9x!q, "x": 1}\n');
      const e2 = L.read(bad2).error + L.summary(bad2) + H.node(h, path.join(h.kit, 'tools', 'login.js'), ['list'], { cwd: path.dirname(path.dirname(bad2)) }).out;
      H.ok('坏 JSON 的报错不带原文里的口令', /不是合法的 JSON/.test(e2) && !e2.includes('Leak9x'), e2);
      H.ok('从子目录往上找得到', L.findFrom(path.join(d, 'src', 'main'), 4) === f);
    }
    const cli = (a) => H.node(h, path.join(h.kit, 'tools', 'login.js'), a, { cwd: d });
    const ls = cli(['list']);
    H.ok('login.js list：列账号，不打印口令', ls.code === 0 && /admin/.test(ls.out) && /zhangsan/.test(ls.out) && !/a-pass-1|z-pass-2/.test(ls.out), ls.out + ls.err);
    const fdo = cli(['find']);
    H.ok('login.js find：按顺序列出账号表、SQL、初始密码、查库、问用户', fdo.code === 0 && /1\. 账号表/.test(fdo.out) && /sql\/init\.sql:1/.test(fdo.out) && /initPassword/.test(fdo.out) && /vk-db-crud/.test(fdo.out) && /问用户一次/.test(fdo.out) && !/a-pass-1/.test(fdo.out), fdo.out + fdo.err);
    const ck = cli(['check']);
    H.ok('login.js check：有要改的退出码 1', ck.code === 1 && /没写 from/.test(ck.out), ck.out + ck.err);
    const none = H.node(h, path.join(h.kit, 'tools', 'login.js'), ['list'], { cwd: proj });
    H.ok('没有账号表：说该建在哪', none.code === 1 && none.out.includes(path.join(proj, '.vibe', 'login.json')), none.out + none.err);
  }

  H.section('用户给了账号、说到启动：提醒记下来');
  {
    const t = H.transcript(path.join(h.root, 'ta.jsonl'), [H.tr.user('开始吧'), H.tr.say('这个页面要登录，用哪个账号？')]);
    const say = (prompt, tp) => H.reasonOf(H.hook(h, 'task-anchor', { session_id: 'ta1', cwd: proj, prompt, transcript_path: tp || t, hook_event_name: 'UserPromptSubmit' }));
    let r = say('测试账号 admin 密码 ' + PWD);
    H.ok('"账号 … 密码 …"：提醒记进这个项目的 login.json', /\[vibe-kit 账号\]/.test(r) && r.includes(path.join(proj, '.vibe', 'login.json')), r);
    r = say('用 admin/' + PWD + ' 登录试试');
    H.ok('"用 admin/… 登录"也认', /\[vibe-kit 账号\]/.test(r), r);
    r = say('admin/' + PWD);
    H.ok('上一条问了账号、只回了一对：认', /\[vibe-kit 账号\]/.test(r), r);
    r = say('admin/' + PWD, H.transcript(path.join(h.root, 'tb.jsonl'), [H.tr.user('开始吧'), H.tr.say('改好了。')]));
    H.ok('上一条没问账号：只有一对不认', !/\[vibe-kit 账号\]/.test(r), r);
    r = say('把 src/main 下的登录页改一下');
    H.ok('路径里的斜杠不当账号', !/\[vibe-kit 账号\]/.test(r), r);
    r = say('修改密码功能的用户名校验有问题');
    H.ok('说到密码功能不当账号', !/\[vibe-kit 账号\]/.test(r), r);
    // 复审 2、3、4：误报、漏报
    const none = ['views/login 登录页没样式', 'pages/login 登录页面的按钮', '密码错误，账号 admin 登不上', 'accounting 模块的 password 校验', '改一下 api/user/list 接口的登录校验'].filter((x) => /\[vibe-kit 账号\]/.test(say(x)));
    H.ok('路径 + 登录页、"密码错误"、accounting 这类不当账号', !none.length, none);
    const miss = ['用户名/密码是 admin/' + PWD, '账户 admin 密码 ' + PWD, '用 admin/admin 登录'].filter((x) => !/\[vibe-kit 账号\]/.test(say(x)));
    H.ok('"用户名/密码是 …""账户 …"、admin/admin 也认', !miss.length, miss);
    r = say('这个项目的启动方式是先起 redis，再 mvn spring-boot:run');
    H.ok('说到启动方式：提醒记进项目说明', /\[vibe-kit 启动\]/.test(r) && /跑通的启动/.test(r), r);
    const asks = ['怎么启动这个项目', '启动方式是什么？'].filter((x) => /\[vibe-kit 启动\]/.test(say(x)));
    H.ok('问怎么启动不算说了启动方式', !asks.length, asks);
  }

  H.section('tmp 里的账号、登录场景拦一次；.vibe 根下乱放的说清启动和账号放哪');
  {
    const w = (rel, content) => H.hook(h, 'guard-vibe', { session_id: 'gv1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, '.vibe', rel), content } });
    const deny = (o) => !!o && o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision === 'deny';
    let o = w('tmp/0930-登录/accounts.json', '{"admin":{"password":"x"}}');
    H.ok('tmp 里新建账号文件：拦，指到 login.json', deny(o) && /login\.json/.test(H.reasonOf(o)) && /会被清/.test(H.reasonOf(o)), o);
    o = w('tmp/0930-登录/accounts.json', '{"admin":{"password":"x"}}');
    H.ok('原样再写一次：放行', !deny(o), o);
    // 复审 10、11：名字像、内容里没有密码的不拦；没有会话号的不拦（放不了行）
    const loose = [['tmp/c2/用户故事.md', '用户可以导出订单'], ['tmp/c2/login-bug-notes.md', '登录后跳转错了'], ['tmp/c2/accounting.csv', 'a,b\n1,2']].filter(([f, c]) => deny(w(f, c)));
    H.ok('名字像账号、内容里没写密码的不拦', !loose.length, loose);
    o = H.hook(h, 'guard-vibe', { cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, '.vibe', 'tmp', 'c3', 'accounts.json'), content: '{"password":"x"}' } });
    H.ok('没有会话号：不拦', !deny(o), o);
    const scen = JSON.stringify({ steps: [{ goto: '/login' }, { fill: { label: '密码' }, value: 'x' }] });
    o = w('tmp/c1/flow.json', scen);
    H.ok('tmp 里新建登录场景：拦，指到 scenarios/', deny(o) && /scenarios/.test(H.reasonOf(o)) && /\{\{login\./.test(H.reasonOf(o)), o);
    o = w('tmp/c1/list.json', JSON.stringify({ steps: [{ goto: '/list' }, { readCount: 'tr', as: 'n' }] }));
    H.ok('不登录的场景、探针照旧放行', !deny(o) && !deny(w('tmp/c1/probe.js', 'module.exports = async () => {};')), o);
    o = w('启动说明.md', '先起 redis');
    H.ok('.vibe 根下乱放：提示里说启动方式写项目说明、账号写 login.json', deny(o) && /启动方式：写进项目说明/.test(H.reasonOf(o)) && /登录账号：写进 \.vibe\/login\.json/.test(H.reasonOf(o)), o);
    o = w('login.json', '{}');
    H.ok('login.json 本身照旧能写', !deny(o), o);
  }

  H.section('devserver：跑通的启动命令写进项目说明，stop 不删');
  try {
    const s1 = tool(['start', '--name', 'web', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js']);
    H.ok('起来了', s1.code === 0 && /起来了：web/.test(s1.out), s1.out + s1.err);
    const pmText = H.read(pm) || '';
    H.ok('没有项目说明：建一个，带自动探索的标记（探索照常往里补）', pmText.includes('<!-- vibe-kit 后台自动探索 -->'), pmText);
    const want = new RegExp('^- 跑通的启动（web，\\d{4}-\\d{2}-\\d{2}）：node "\\$HOME/\\.claude/vibe-kit/tools/devserver\\.js" start --name web --port auto --avoid 8080 --dir \'?' + proj.split(path.sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\'? --wait 30 -- node srv\\.js（上次用的端口 \\d+）$', 'm');
    H.ok('写的是这一次原样的 devserver 命令（带 --dir，照着能直接起）', want.test(pmText), pmText);
    H.ok('输出说记进了项目说明', /启动命令记进了项目说明/.test(s1.out), s1.out);
    H.ok('没有账号表：说怎么找、记在哪', /login\.js" find/.test(s1.out) && s1.out.includes(path.join(proj, '.vibe', 'login.json')), s1.out);
    H.ok('最后一行还是结果', /^起来了：web/.test(s1.out.trim().split(/\r?\n/).pop()), s1.out);
    const t1 = tool(['stop', '--name', 'web']);
    H.ok('stop 之后那一行还在', t1.code === 0 && runLines().length === 1, H.read(pm));
    const before = H.read(pm);
    const s2 = tool(['start', '--name', 'web', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js']);
    H.ok('同一条命令再起：项目说明不动、不再说', s2.code === 0 && H.read(pm) === before && !/记进了项目说明/.test(s2.out), s2.out);
    const s3 = tool(['start', '--name', 'web', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js']);
    H.ok('已经在跑：也提一句（没账号表就说怎么找）', s3.code === 0 && /已经在跑/.test(s3.out) && /login\.js" find/.test(s3.out), s3.out);
    tool(['stop', '--name', 'web']);
    const s4 = tool(['start', '--name', 'app2', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js']);
    H.ok('换个名字起同一个服务：换掉那一行，不越记越多', s4.code === 0 && runLines().length === 1 && /跑通的启动（app2，/.test(runLines()[0]), runLines());
    const s5 = tool(['start', '--name', 'web3', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--env', 'DB_PASSWORD=pp-xyz', '--env', 'MODE=dev', '--', 'node', 'srv.js']);
    H.ok('--env 里口令一类的值不写进去，别的照写', s5.code === 0 && runLines().length === 2 && /DB_PASSWORD=<口令照原来的给>/.test(H.read(pm)) && !/pp-xyz/.test(H.read(pm)) && /MODE=dev/.test(H.read(pm)), H.read(pm));
    tool(['stop', '--all']);
    // 复审 5：命令里带着的口令（password=…、--token …）也不写进去
    const s6 = tool(['start', '--name', 'web6', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js', '--spring.datasource.password=pw-in-cmd', '--token', 'tk-in-cmd']);
    H.ok('命令里的口令（password=…、--token …）不写进去', s6.code === 0 && !/pw-in-cmd|tk-in-cmd/.test(H.read(pm)) && /password=<口令照原来的给>/.test(H.read(pm)) && /--token '<口令照原来的给>'/.test(H.read(pm)), H.read(pm));
    tool(['stop', '--all']);
    // 复审 6：写下的命令拿去 Git Bash 原样跑，起的是同一个服务（带 $、空格、反斜杠的参数照样）
    const s7 = tool(['start', '--name', 'rp', '--port', 'auto', '--avoid', '8080', '--wait', '30', '--', 'node', 'srv.js', 'a$b c', 'x\\y']);
    const rl = (runLines().find((l) => /跑通的启动（rp，/.test(l)) || '').replace(/^- 跑通的启动（[^）]*）：/, '').replace(/（上次用的端口 \d+）$/, '');
    const BASH = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')].find((x) => fs.existsSync(x)) || 'bash';
    const rr = H.run(h, BASH, ['-c', rl], { cwd: h.root, timeout: 120000 });
    H.ok('写下的命令原样在 Git Bash 里跑：认出是同一个服务（已经在跑）', s7.code === 0 && !!rl && /已经在跑：rp/.test(rr.out), [rl, rr.out, rr.err]);
    tool(['stop', '--all']);

    // 人写的项目说明：放在"启动"那一行（连同下面缩进的）后面，别的不动
    const p2 = H.makeRepo(path.join(h.work, 'app-b'), { '.gitignore': '.vibe/\n', 'srv.js': SERVER + '\n' });
    const pm2 = path.join(p2, '.vibe', 'project.md');
    H.write(pm2, '# 项目说明\n\n- 类型：Node\n- 启动：npm start\n  - 先起 redis\n- 编码：UTF-8\n');
    const b1 = tool(['start', '--name', 'api', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], p2);
    const lines2 = (H.read(pm2) || '').split('\n');
    const at = lines2.findIndex((l) => /^- 跑通的启动（api，/.test(l));
    H.ok('人写的项目说明：插在"启动"和它下面缩进的那几行后面', b1.code === 0 && at === 5 && lines2[4] === '  - 先起 redis' && lines2[6] === '- 编码：UTF-8' && !(H.read(pm2) || '').includes('<!-- vibe-kit'), H.read(pm2));
    H.write(path.join(p2, '.vibe', 'login.json'), JSON.stringify(LOGIN, null, 2));
    tool(['stop', '--all'], p2);
    const b2 = tool(['start', '--name', 'api', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], p2);
    H.ok('有账号表：起来之后列出账号，不带口令', b2.code === 0 && /测试账号（/.test(b2.out) && /admin（账号|admin（超级管理员/.test(b2.out) && !b2.out.includes(PWD), b2.out);

    H.section('场景引用账号表，跑通了记上次登录成功，口令不进输出');
    const port = (H.read(pm2).match(/上次用的端口 (\d+)/) || [])[1];
    const page = path.join(SRC, 'kit', 'page', 'scenario-run.js');
    const pageOpts = { cwd: p2, timeout: 90000, env: { NODE_PATH: path.join(H.SRC, 'kit', 'page', 'node_modules') } };
    const sc = (name, steps) => { const f = path.join(p2, '.vibe', 'scenarios', name + '.json'); H.write(f, JSON.stringify({ steps })); return H.node(h, page, [f, '--base', 'http://127.0.0.1:' + port], pageOpts); };
    const loginStep = (who) => ({ request: 'POST /api/login', json: { user: '{{login.' + who + '.user}}', password: '{{login.' + who + '.password}}' }, expectStatus: 200, expectJson: 'code', equals: 0 });
    const ok1 = sc('login', [loginStep('admin')]);
    const lj = JSON.parse(H.read(path.join(p2, '.vibe', 'login.json')) || '{}');
    H.ok('引用换成真的账号，登录成功', ok1.code === 0 && /"ok":true/.test(ok1.out), ok1.out + ok1.err);
    H.ok('跑通了：admin 记上 lastOk，结果里说了', !!(lj.accounts && lj.accounts[0].lastOk) && /"logins"/.test(ok1.out), [lj, ok1.out]);
    H.ok('口令不出现在输出和结果文件里', !ok1.out.includes(PWD) && !(H.read(path.join(p2, '.vibe', 'out', 'login', 'result.json')) || '').includes(PWD), ok1.out);
    const bad = sc('bad', [loginStep('bad')]);
    const lj2 = JSON.parse(H.read(path.join(p2, '.vibe', 'login.json')) || '{}');
    H.ok('登录没成功：不记 lastOk', bad.code === 1 && !lj2.accounts[1].lastOk, bad.out);
    const miss = sc('miss', [loginStep('nobody')]);
    H.ok('没有这个账号：那一步失败，说有哪些', miss.code === 1 && /没有叫 nobody 的账号/.test(miss.out), miss.out + miss.err);
    tool(['stop', '--all'], p2);

    H.section('项目说明的编码、BOM、换行照旧；不在仓库里的目录不建');
    // 复审 7：GBK 存的项目说明，读出来是乱码，不动它
    const p3 = H.makeRepo(path.join(h.work, 'app-gbk'), { '.gitignore': '.vibe/\n', 'srv.js': SERVER + '\n' });
    const gbk = Buffer.from([0x23, 0x20, 0xcf, 0xee, 0xc4, 0xbf, 0x0a, 0x2d, 0x20, 0xc6, 0xf4, 0xb6, 0xaf, 0x3a, 0x20, 0x6e, 0x70, 0x6d, 0x0a]);
    fs.mkdirSync(path.join(p3, '.vibe'), { recursive: true });
    fs.writeFileSync(path.join(p3, '.vibe', 'project.md'), gbk);
    const g1 = tool(['start', '--name', 'g', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], p3);
    H.ok('不是 UTF-8 的项目说明：不动它', g1.code === 0 && fs.readFileSync(path.join(p3, '.vibe', 'project.md')).equals(gbk), g1.out);
    tool(['stop', '--all'], p3);
    // 复审 8：带 BOM、CRLF 的照样带着
    const p4 = H.makeRepo(path.join(h.work, 'app-bom'), { '.gitignore': '.vibe/\n', 'srv.js': SERVER + '\n' });
    fs.mkdirSync(path.join(p4, '.vibe'), { recursive: true });
    fs.writeFileSync(path.join(p4, '.vibe', 'project.md'), String.fromCharCode(0xFEFF) + '# 项目说明\r\n\r\n- 启动：npm start\r\n- 编码：UTF-8\r\n');
    const b4 = tool(['start', '--name', 'b', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], p4);
    const t4 = fs.readFileSync(path.join(p4, '.vibe', 'project.md'), 'utf8');
    H.ok('带 BOM、CRLF 的项目说明：写回去照样带着', b4.code === 0 && t4.charCodeAt(0) === 0xFEFF && /\r\n- 启动：npm start\r\n- 跑通的启动（b，[^\r\n]*\r\n- 编码：UTF-8\r\n$/.test(t4) && !/[^\r]\n/.test(t4), JSON.stringify(t4));
    tool(['stop', '--all'], p4);
    // 复审 9：不在仓库里、也不像项目的目录（桌面、下载目录）不建项目说明；像项目的（有 package.json）照写
    const plain = path.join(h.work, 'plain');
    H.write(path.join(plain, 'srv.js'), SERVER + '\n');
    const n1 = tool(['start', '--name', 'pl', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], plain);
    H.ok('不在仓库里、不像项目的目录：不建项目说明', n1.code === 0 && !fs.existsSync(path.join(plain, '.vibe', 'project.md')), n1.out);
    tool(['stop', '--all'], plain);
    H.write(path.join(plain, 'package.json'), '{"name":"plain"}\n');
    const n2 = tool(['start', '--name', 'pl', '--port', 'auto', '--wait', '30', '--', 'node', 'srv.js'], plain);
    H.ok('不在仓库里、但像项目的目录：照写', n2.code === 0 && /跑通的启动（pl，/.test(H.read(path.join(plain, '.vibe', 'project.md')) || ''), n2.out);
    tool(['stop', '--all'], plain);
  } finally { tool(['stop', '--all']); }

  H.section('会话开始：带账号汇总；壳子里子项目带跑通的启动和账号名字');
  {
    H.write(path.join(proj, '.vibe', 'login.json'), JSON.stringify(LOGIN, null, 2));
    const t = H.transcript(path.join(h.root, 'ss.jsonl'), [H.tr.user('hi')]);
    const r = H.reasonOf(H.hook(h, 'session-start', { session_id: 'ss1', cwd: proj, transcript_path: t, hook_event_name: 'SessionStart', source: 'startup' }));
    H.ok('带了账号汇总，不带口令', /测试账号（/.test(r) && /admin/.test(r) && !r.includes(PWD), r.slice(0, 1500));
    H.ok('项目说明里跑通的启动跟着带上', /跑通的启动（app2，/.test(r), r.slice(0, 1500));
    const shell = H.makeRepo(path.join(h.work, 'shell'), { 'CLAUDE.md': '# 壳子\n' });
    const sub = H.makeRepo(path.join(shell, 'backend'), { 'pom.xml': '<project/>\n' });
    H.write(path.join(sub, '.vibe', 'project.md'), '# 项目说明\n\n- 启动：mvn spring-boot:run\n- 跑通的启动（backend，2026-11-09）：node "$HOME/.claude/vibe-kit/tools/devserver.js" start --name backend --port auto -- mvn spring-boot:run（上次用的端口 31000）\n');
    H.write(path.join(sub, '.vibe', 'login.json'), JSON.stringify(LOGIN));
    const r2 = H.reasonOf(H.hook(h, 'session-start', { session_id: 'ss2', cwd: shell, transcript_path: t, hook_event_name: 'SessionStart', source: 'startup' }));
    H.ok('壳子里：子项目的项目说明路径后面带跑通的启动、账号名字', /backend[\\/]\.vibe[\\/]project\.md（跑通的启动：backend；测试账号（[^）]*login\.json）：admin、bad）/.test(r2) && !r2.includes(PWD), r2.slice(0, 2500));
  }

  H.done('第 75 条：启动方式和测试账号');
})().catch((e) => { H.ok('测试异常', false, e.stack); H.done('第 75 条：启动方式和测试账号'); });

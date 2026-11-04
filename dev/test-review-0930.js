'use strict';
/*
 * 0930 这一版发布之前做了一次全仓审查，这里是照审查报的问题改完之后的回归（别的测试里放不下的那些）：
 *   问题反馈：出错的指纹不带本机路径；工具报的毛病不算到不相干的会话头上
 *   通行证：只管申请时说的那条规矩
 *   全自动报告：两个会话同一秒开始不互相覆盖；标题里的令牌遮掉
 *   审查记账：后台通知不会配到碰巧用了同一个 id 的别的调用上；"变更："写了却对不上的不往下猜
 * 拦截类钩子的那一批在 test-guard-0930.js。
 * 用法：node dev/test-review-0930.js
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const h = H.makeHome('review0930', null, { autoVerify: false, autoSeePage: false, autoCommit: 'off', commitMode: 'off', vibeTidy: false, specGate: true });
const S = require(path.join(h.kit, 'lib', 'session.js'));
const F = require(path.join(h.kit, 'lib', 'feedback.js'));
const R = require(path.join(h.kit, 'lib', 'report.js'));
const T = require(path.join(h.kit, 'lib', 'toolstats.js'));
const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
const other = H.makeRepo(path.join(h.work, 'other-proj'), { 'pom.xml': '<project/>\n' });

H.section('出错的指纹：哪台电脑、哪个项目算出来都一样');
{
  const n0 = F.listRecords().length;
  const err = (user, pid) => { const e = new Error("EBUSY: resource busy or locked, open 'C:\\Users\\" + user + "\\proj\\.claude\\rules\\ttls-lessons-java.md." + pid + ".tmp'"); e.stack = 'Error: ' + e.message + '\n    at Object.writeFileSync (node:fs:2425:20)\n    at writeFileAtomic (C:\\Users\\' + user + '\\.claude\\vibe-kit\\lib\\lessons.js:301:8)\n    at handle (C:\\Users\\' + user + '\\.claude\\vibe-kit\\hooks\\verify-gate.js:696:21)'; return e; };
  F.recordHookError('verify-gate', { session_id: 's-a', cwd: proj }, err('zhangsan', 12345));
  F.recordHookError('verify-gate', { session_id: 's-b', cwd: other }, err('lisi', 777));
  const recs = F.listRecords().slice(0, F.listRecords().length - n0);
  H.ok('用户名、进程号不一样的同一个错：并成一条，次数是 2', recs.length === 1 && Number(recs[0].meta['次数']) === 2, recs.map((r) => [r.title, r.meta['次数'], r.meta['签名']]));
  const e2 = new Error('Cannot read properties of undefined'); e2.stack = 'TypeError: x\n    at handle (C:\\Users\\zhangsan\\.claude\\vibe-kit\\hooks\\verify-gate.js:120:3)';
  F.recordHookError('verify-gate', { session_id: 's-a', cwd: proj }, e2);
  H.ok('不同的错还是各算各的', F.listRecords().length === n0 + 2, F.listRecords().map((r) => r.title));
}

H.section('工具报的毛病：不是这个会话的项目里出的，不算到这个会话头上');
{
  const log = path.join(h.kit, 'state', 'tool-usage.jsonl');
  const line = (o) => JSON.stringify(Object.assign({ at: Date.now() }, o)) + '\n';
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, line({ tool: 'ttls-db-crud', incident: 'crash', what: "KeyError: 'rows'", detail: 'File "db.py", line 412', cmd: 'query', project: 'other-proj' }) + line({ tool: 'ttls-redis', incident: 'crash', what: 'TypeError: x is not a function', detail: 'redis.js:88', cmd: 'get', project: 'proj' }));
  const n0 = F.listRecords().length;
  T.ingest({ session_id: 's-mine', cwd: proj, transcript_path: '' });
  const recs = F.listRecords().slice(0, F.listRecords().length - n0);
  const a = recs.find((r) => /ttls-db-crud/.test(r.title));
  const b = recs.find((r) => /ttls-redis/.test(r.title));
  H.ok('别的项目里出的：记下来了，但不算这个会话的，说了是哪个项目', a && a.meta['会话'] !== 's-mine' && /项目：other-proj/.test(a.text), a && [a.meta, a.text.slice(0, 300)]);
  H.ok('这个项目里出的：算这个会话的', b && b.meta['会话'] === 's-mine', b && b.meta);
  H.ok('这个会话的"套件问题"里只有自己的那条', F.sessionRecords('s-mine').length === 1 && /ttls-redis/.test(F.sessionRecords('s-mine')[0].title), F.sessionRecords('s-mine').map((r) => r.title));
}

H.section('通行证只管申请时说的那条规矩');
{
  const pass = { id: 'AB12', hook: 'guard-spec', sig: 'sig-of-2.1', target: 'file:/p/tasks.md', reason: '[vibe-kit] 任务 2.1 的验法"对照场景 a.json"还没跑过，不能打勾。\n〔拦截编号 AB12〕' };
  H.ok('一模一样的操作再做一次：放行', !!F.pickPass([pass], 'guard-spec', 'sig-of-2.1', 'file:/p/tasks.md', '[vibe-kit] 任务 2.1 的验法"对照场景 a.json"还没跑过，不能打勾。'));
  H.ok('同一个文件、同一条规矩（另一项任务的验法没跑过）：放行', !!F.pickPass([pass], 'guard-spec', 'sig-of-2.2', 'file:/p/tasks.md', '[vibe-kit] 任务 2.2 的验法"对照场景 b.json"还没跑过，不能打勾。'));
  H.ok('同一个文件、另一条规矩（任务里有含糊词）：不放行', !F.pickPass([pass], 'guard-spec', 'sig-of-2.3', 'file:/p/tasks.md', '[vibe-kit] tasks.md 里有"后续完善"这样的话，写成决策项。'));
  H.ok('别的文件：不放行', !F.pickPass([pass], 'guard-spec', 'sig-x', 'file:/p/design.md', '[vibe-kit] 任务 2.2 的验法"对照场景 b.json"还没跑过，不能打勾。'));
  H.ok('没给拦下的原话（老的调用方式）：照以前按文件认', !!F.pickPass([pass], 'guard-spec', 'sig-x', 'file:/p/tasks.md'));
}

H.section('全自动报告：两个会话同一秒开始不互相覆盖；令牌不进报告');
{
  H.setConfig(h, { autoMode: true });
  const a = { session_id: 'aaaaaaaa-1111', cwd: proj };
  const b = { session_id: 'bbbbbbbb-2222', cwd: proj };
  R.begin(a); R.begin(b);
  // 两边的"这一轮开始的时间"调成同一秒
  const round = Math.floor(Date.now() / 1000) * 1000;
  for (const j of [a, b]) S.updateState(j.session_id + '-report', (st) => { st.round = round; return st; });
  R.note(a, { kind: 'hand', title: '没让它跑：curl -H "Authorization: Bearer glpat-abcdefghijklmnop1234" https://git.example/api', detail: '要你来' });
  R.note(b, { kind: 'hand', title: '它想执行 git push，没让做：git push origin main', detail: '推到远端要你自己来' });
  const ra = R.build(a, S.readConfig(), []); R.delivered(a, ra);
  const rb = R.build(b, S.readConfig(), []); R.delivered(b, rb);
  H.ok('两份报告是两个文件', ra.file && rb.file && ra.file !== rb.file && fs.existsSync(ra.file) && fs.existsSync(rb.file), [ra.file, rb.file]);
  H.ok('各是各的内容', /curl/.test(H.read(ra.file)) && !/git push origin/.test(H.read(ra.file)) && /git push origin/.test(H.read(rb.file)), [H.read(ra.file).slice(0, 400)]);
  H.ok('先写的那份名字照旧（日期-时间）', /全自动报告-\d{8}-\d{6}\.md$/.test(ra.file) && /全自动报告-\d{8}-\d{6}-bbbbbbbb\.md$/.test(rb.file), [ra.file, rb.file]);
  H.ok('标题里的令牌遮掉了', !/glpat-abcdefghijklmnop1234/.test(H.read(ra.file)) && /没让它跑：curl -H "Authorization: \*\*\*/.test(H.read(ra.file)), H.read(ra.file).slice(0, 900));
  R.saveFinal(a, 'A 的交代'); R.saveFinal(b, 'B 的交代');
  H.ok('交代各接各的', /A 的交代/.test(H.read(ra.file)) && !/B 的交代/.test(H.read(ra.file)) && /B 的交代/.test(H.read(rb.file)), [H.read(rb.file).slice(-200)]);
  const ra2 = R.build(a, S.readConfig(), []);
  H.ok('同一个会话同一轮再出一次：还是写它自己的那一份', ra2.file === ra.file, [ra.file, ra2.file]);
  H.setConfig(h, { autoMode: false });
}

H.done('全仓审查之后改的（0930）');

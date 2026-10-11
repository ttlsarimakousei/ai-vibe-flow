'use strict';
/* 使用情况采用持久随机标识；跨进程、改电脑名与旧议题迁移只在假用户及假 GitLab 验证，不读取真实电脑名。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/harness');
const source = process.argv[2] ? path.resolve(process.argv[2]) : H.SRC;
const json = out => { try { return JSON.parse(out.trim().split(/\r?\n/).pop()); } catch (e) { return {}; } };
const HOST = 'FAKE-private-department-computer';
const sig = crypto.createHash('sha1').update(HOST.toLowerCase()).digest('hex').slice(0, 12);
const ID = /^设备-[a-f0-9]{24}$/;
(async () => {
  const gl = await H.fakeGitlab('usage-identity-gl', 18867);
  H.ok('假 GitLab 可用', gl.up);
  const home = name => {
    const h = H.makeHome(name, source, { usageReport: 'on', sshToken: 'off' });
    const token = 'glpat-FAKE-usage-identity';
    gl.addToken(token, 'maintainer');
    H.write(path.join(h.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
    H.write(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlabToken: token }));
    return h;
  };
  const h = home('usage-identity');
  const run = (home, code, hostname = HOST) => {
    const r = H.node(home, '-e', ['require("os").hostname=()=> ' + JSON.stringify(hostname) + ';const U=require(' + JSON.stringify(path.join(home.kit, 'lib/usage.js')) + ');const I=require(' + JSON.stringify(path.join(home.kit, 'lib/issues.js')) + ');' + code], { cwd: home.root, env: gl.env, timeout: 60000 });
    return { code: r.code, value: json(r.out) };
  };
  const a = run(h, 'console.log(JSON.stringify(U.collect()));');
  H.ok('使用情况只显示随机设备标识', ID.test(a.value.host || '') && !JSON.stringify(a.value).includes(HOST));
  const b = run(h, 'console.log(JSON.stringify(U.collect()));', 'FAKE-renamed-computer');
  H.ok('新进程和改电脑名仍使用原标识', a.value.host === b.value.host && ID.test(b.value.host || ''));
  const other = run(home('usage-identity-other'), 'console.log(JSON.stringify(U.collect()));');
  H.ok('同名电脑的不同安装不会用同一个标识', ID.test(other.value.host || '') && a.value.host !== other.value.host);
  const keeps = run(h, 'console.log(JSON.stringify({keep:require(' + JSON.stringify(path.join(h.kit, 'lib/session.js')) + ').GLOBAL_STATE.test("usage-device.json")}));');
  H.ok('设备标识不被会话清理删掉', keeps.value.keep === true);
  const yesterday = new Date(Date.now() - 86400000);
  const day = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
  H.write(path.join(h.kit, 'state/usage.json'), JSON.stringify({ days: { [day]: { n: { prompt: 2 } } } }));
  const sync = () => run(h, 'I.syncUsage({force:true}).then(x=>console.log(JSON.stringify(x))).catch(()=>process.exitCode=1);');
  const first = sync();
  let issue = gl.issues().find(x => String(x.title).startsWith('[使用情况]'));
  H.ok('新议题的标题正文和日统计均不带电脑名', first.code === 0 && first.value.sent === 1 && issue && !JSON.stringify(issue).includes(HOST) && ID.test(String(issue.title).replace('[使用情况] ', '')));
  if (issue) {
    const legacy = { title: '[使用情况] ' + HOST, description: '人工附加说明保留\n| 电脑 | ' + HOST + ' |\n<!-- vibe-kit-usage-host:' + sig + '\n' };
    const api = new URL(gl.url).origin + '/api/v4/projects/77/issues/' + issue.iid;
    const changed = run(h, 'fetch(' + JSON.stringify(api) + ',{method:"PUT",headers:{"PRIVATE-TOKEN":"glpat-FAKE-usage-identity","Content-Type":"application/json"},body:' + JSON.stringify(JSON.stringify(legacy)) + '}).then(r=>r.json()).then(x=>console.log(JSON.stringify({title:x.title})));');
    H.ok('旧版议题夹具实际写入原电脑名', changed.code === 0 && changed.value.title === legacy.title);
    const file = path.join(h.kit, 'feedback/issues.json');
    const store = JSON.parse(H.read(file));
    store.usage.days = [];
    H.write(file, JSON.stringify(store));
    const migrated = sync();
    issue = gl.issues().find(x => x.iid === issue.iid);
    H.ok('原编号复用并更新电脑名标题和表格', migrated.code === 0 && migrated.value.sent === 1 && gl.issues().length === 1 && ID.test(issue.title.replace('[使用情况] ', '')) && !issue.description.includes(HOST));
    H.ok('迁移保留人工说明和已传统计', issue.description.includes('人工附加说明保留') && issue.notes.length === 2 && issue.notes[0].body.includes('| 开口 | 2 次'));
    store.usage.days = [];
    delete store.usage.iid;
    H.write(file, JSON.stringify(store));
    const recovered = sync();
    H.ok('丢编号后依旧按旧记号找回，不重复建', recovered.code === 0 && recovered.value.sent === 1 && gl.issues().length === 1);
  }
  await gl.stop();
  H.done('使用情况匿名标识');
})().catch(e => { console.log(String(e.stack || e)); H.cleanup(); process.exit(2); });

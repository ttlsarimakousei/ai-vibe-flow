'use strict';
/*
 * 验收：拿打好的两个压缩包（不是源码）走一遍用户要走的路。
 *   1. 维护的人解压第一个包，发布（先在自己电脑上装、自检，再推）
 *   2. 同事解压第一个包，双击安装
 *   3. 维护的人解压第二个包，发布
 *   4. 同事的电脑在后台发现第二个包、自己装上；装上之后新记的问题反馈建成了 issue（装之前攒下的不传）
 * 仓库是临时目录里的假 GitLab。全程盯着桌面。
 * 用法：node dev/accept-packages.js <第一个 zip> <第二个 zip> [端口，默认 18751]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/harness');

const ZIP1 = path.resolve(process.argv[2] || '');
const ZIP2 = path.resolve(process.argv[3] || '');
const PORT = Number(process.argv[4]) || 18751;
if (!fs.existsSync(ZIP1) || !fs.existsSync(ZIP2)) { console.log('用法：node dev/accept-packages.js <第一个 zip> <第二个 zip> [端口]'); process.exit(2); }
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
function filesOf(dir, rel, out) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) filesOf(dir, r, out); else if (e.isFile()) out[r] = sha(path.join(dir, r));
  }
  return out;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const json = (t) => { try { return JSON.parse(String(t).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { return null; } };
function unzip(zip, name) {
  const out = H.tempDir(name);
  require('./lib/unzip').extract(zip, out);
  return path.join(out, 'vibe-kit');
}

(async () => {
  const watch = await H.watchWindows('acc-win');
  const gl = await H.fakeGitlab('acc-gl', PORT);
  H.ok('假 GitLab 起来了', gl.up, gl.log());
  const live = Object.assign({}, gl.env, { VIBE_KIT_NO_UPDATE: undefined });
  const p1 = unzip(ZIP1, 'acc-p1');
  const p2 = unzip(ZIP2, 'acc-p2');
  const V1 = (H.read(path.join(p1, 'kit', 'VERSION')) || '').trim();
  const V2 = (H.read(path.join(p2, 'kit', 'VERSION')) || '').trim();
  console.log('    第一个包 ' + V1 + '，第二个包 ' + V2);
  H.ok('两个包版本号不同，第二个更新', /^\d{8}\.\d{4}$/.test(V1) && /^\d{8}\.\d{4}$/.test(V2) && V2 > V1, [V1, V2]);
  const a = filesOf(p1, '', {});
  const b = filesOf(p2, '', {});
  const diff = Object.keys(b).filter((k) => a[k] !== b[k]).concat(Object.keys(a).filter((k) => !(k in b)));
  // 2054 / 2055 那一对只差版本号和更新说明（专门用来试自动更新）；别的版本之间差多少个文件都正常，这里只报个数
  console.log('    两个包有 ' + diff.length + ' 个文件不一样' + (diff.sort().join() === 'kit/VERSION,更新说明.md' ? '：只差版本号和更新说明' : ''));
  H.ok('包里没有令牌、仓库地址这些运行时的文件', !Object.keys(a).some((k) => /(^|\/)(secrets\.json|gitlab\.json)$|^kit\/(state|update|feedback)\//.test(k)), Object.keys(a).filter((k) => /secrets|gitlab\.json/.test(k)));
  H.ok('包里有发布脚本、两个 bat、不转换换行的属性文件', ['publish.js', '发布到 GitLab（双击我）.bat', '安装（双击我）.bat', '.gitattributes', 'kit/.ignore', 'kit/hooks/guard-read.js', 'kit/lib/updater.js'].every((k) => k in a));

  H.section('维护的人发布第一个包');
  const MT = 'glpat-accept-maintainer-01';
  gl.addToken(MT, 'maintainer');
  const m = H.freshHome('acc-m');
  fs.mkdirSync(m.kit, { recursive: true });
  fs.writeFileSync(path.join(m.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  fs.writeFileSync(path.join(m.kit, 'secrets.json'), JSON.stringify({ gitlabToken: MT, gitlabTokenSource: 'manual' }));
  const publish = (pkg) => H.node(m, path.join(pkg, 'publish.js'), ['--no-router', '--no-open'], { cwd: pkg, timeout: 600000, env: { VIBE_KIT_NO_UPDATE: undefined } });
  const r1 = publish(p1);
  H.ok('发布成功', r1.code === 0 && r1.out.includes('已发布 ' + V1) && /自检通过/.test(r1.out), r1.out + r1.err);
  H.ok('仓库里是第一个包的版本', H.git(gl.bare, ['show', 'main:kit/VERSION']).out.trim() === V1);
  const clone = path.join(H.tempDir('acc-clone'), 'c');
  H.git(gl.root, ['-c', 'core.autocrlf=true', 'clone', '-q', gl.bare, clone]);
  const c = filesOf(clone, '', {});
  const bad = Object.keys(a).filter((k) => a[k] !== c[k]).concat(Object.keys(c).filter((k) => !(k in a)));
  H.ok('仓库里的 ' + Object.keys(a).length + ' 个文件和压缩包里的一字不差', !bad.length && Object.keys(a).length > 300, bad.slice(0, 8));

  H.section('同事装第一个包');
  const u = H.freshHome('acc-u');
  fs.mkdirSync(path.join(u.kit, 'feedback'), { recursive: true });
  const inst = H.node(u, path.join(p1, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 300000 });
  H.ok('装上了', inst.code === 0 && inst.out.includes('这个安装包的版本：' + V1) && (H.read(path.join(u.kit, 'VERSION')) || '').trim() === V1, inst.out + inst.err);
  fs.writeFileSync(path.join(u.kit, 'gitlab.json'), JSON.stringify({ repo: gl.url }));
  // 同事以前单独装过查库的技能（0930 起并进套件，自动更新时要把它收掉）
  const RENAMED = V2 > '20260929.2205' && V1 <= '20260929.2205';
  if (RENAMED) for (const f of ['SKILL.md', 'scripts/db.py', 'scripts/sqlguard.py']) H.write(path.join(u.cfg, 'skills', 'urai-db-crud', f), '# 以前单独装的\n');
  H.node(u, '-e', ['require(' + JSON.stringify(path.join(u.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '出错', hook: 'verify-gate', title: '验收时记的一条', what: 'x', sig: 'sig-accept-1' }) + ')'], { cwd: u.root });
  const up = (args) => { const r = H.node(u, path.join(u.kit, 'lib', 'updater.js'), args, { cwd: u.root, timeout: 600000, env: Object.assign({}, live) }); return Object.assign(r, { json: json(r.out) }); };
  const c1 = up(['check']);
  H.ok('检查：和仓库里一样，走的是 SSH', c1.json && c1.json.lastCheckOk && c1.json.remote === V1 && !c1.json.differs && c1.json.route === 'ssh', c1.out + c1.err);

  H.section('维护的人发布第二个包，同事的电脑自己更新');
  const r2 = publish(p2);
  H.ok('发布成功', r2.code === 0 && r2.out.includes('已发布 ' + V2) && r2.out.includes('上一版是 ' + V1), r2.out + r2.err);
  // 到了检查的时间：会话开始的钩子甩出后台进程
  const sf = path.join(u.kit, 'state', 'update.json');
  fs.writeFileSync(sf, JSON.stringify(Object.assign(readJson(sf), { lastCheckAt: 0, lastKickAt: 0 })));
  const t0 = Date.now();
  const hk = H.node(u, path.join(u.kit, 'hooks', 'session-start.js'), [], { cwd: u.root, env: Object.assign({}, live), input: JSON.stringify({ session_id: 's-acc', cwd: u.root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(u.root, 'none.jsonl') }) });
  H.ok('钩子马上返回', hk.code === 0 && Date.now() - t0 < 5000, hk.err);
  let done = false;
  for (let i = 0; i < 360 && !done; i++) { await H.sleep(500); done = (H.read(path.join(u.kit, 'VERSION')) || '').trim() === V2 && !fs.existsSync(path.join(u.kit, 'update', 'lock.json')); }
  const st = readJson(sf);
  H.ok('后台装上了第二个包', done && st.lastApplied && st.lastApplied.from === V1 && st.lastApplied.to === V2, [st, H.read(path.join(u.kit, 'update', 'update.log'))]);
  const inst2 = filesOf(path.join(u.kit, 'hooks'), '', {});
  const want = filesOf(path.join(p2, 'kit', 'hooks'), '', {});
  H.ok('装上的钩子和第二个包里的一字不差', Object.keys(want).every((k) => want[k] === inst2[k]), Object.keys(want).filter((k) => want[k] !== inst2[k]));
  H.ok('看页面用的依赖也在', fs.existsSync(path.join(u.kit, 'page', 'node_modules', 'playwright-core', 'package.json')));
  if (V2 > '20260929.2205') {
    const sk = fs.readdirSync(path.join(u.cfg, 'skills')).sort();
    H.ok('自动更新之后：技能是 ttls- 开头的六个' + (RENAMED ? '，旧名字的、以前单独装的都收掉了' : ''), JSON.stringify(sk.filter((n) => /^ttls-/.test(n))) === JSON.stringify(['ttls-cross-review', 'ttls-db-crud', 'ttls-handover', 'ttls-onboard', 'ttls-redis', 'ttls-see-page']) && sk.every((n) => /^(ttls|openspec)-/.test(n)), sk); // 2026-10-17 起还装自带 OpenSpec 的 openspec-* 技能
    H.ok('审查代理是 ttls-reviewer', fs.existsSync(path.join(u.cfg, 'agents', 'ttls-reviewer.md')) && !fs.existsSync(path.join(u.cfg, 'agents', 'vibe-reviewer.md')), fs.readdirSync(path.join(u.cfg, 'agents')));
    const md = H.read(path.join(u.cfg, 'CLAUDE.md')) || '';
    H.ok('全局约定里的斜杠命令换成了新名字', /\/ttls-see-page/.test(md) && /\/ttls-handover/.test(md) && !/(^|[^\w.\\/-])\/(cross-review|see-page|handover|onboard)\b/.test(md), (md.match(/[^\n]*\/(cross-review|see-page|handover|onboard)\b[^\n]*/g) || []).slice(0, 3));
    const perm = (readJson(path.join(u.cfg, 'settings.json')).permissions || {});
    H.ok('自动更新之后：放行里补上了 PowerShell，push 的确认还在', (perm.allow || []).includes('PowerShell') && (perm.ask || []).includes('Bash(git push:*)'), perm);
    H.ok('包里、装好的套件里都没有 jar（驱动不随包带）', !Object.keys(b).some((k) => /\.jar$/i.test(k) && !/node_modules\//.test(k)) && !fs.existsSync(path.join(u.kit, 'drivers')), Object.keys(b).filter((k) => /\.jar$/i.test(k)));
    if (RENAMED) {
      const log = H.read(path.join(u.kit, 'update', 'update.log')) || '';
      // 0930 起收掉的旧技能整个挪进 vibe-kit/retired/<名字>-<时间>/，不放进会被轮转清掉的备份目录
      const ret = path.join(u.kit, 'retired');
      const bk = fs.existsSync(ret) ? fs.readdirSync(ret, { recursive: true }).map(String).filter((n) => /^urai-db-crud-[^\\/]+[\\/]scripts[\\/]db\.py$/.test(n)) : [];
      H.ok('以前单独装的查库技能整个挪进 retired 留着了，原处没了', bk.length >= 1 && !fs.existsSync(path.join(u.cfg, 'skills', 'urai-db-crud')), [bk, log.slice(-600)]);
    }
  }
  const line = H.node(u, path.join(u.kit, 'statusline.js'), [], { input: '{}' });
  H.ok('状态栏说"已更新到 ' + V2 + '"', line.out.includes('已更新到 ' + V2), line.out);
  // 装上第二个包之后又记了一条。下一次钩子：把它传上去
  await H.sleep(1100);
  H.node(u, '-e', ['require(' + JSON.stringify(path.join(u.kit, 'lib', 'feedback.js')) + ').record(' + JSON.stringify({ kind: '出错', hook: 'verify-gate', title: '升级之后记的一条', what: 'y', sig: 'sig-accept-2' }) + ')'], { cwd: u.root });
  fs.writeFileSync(sf, JSON.stringify(Object.assign(readJson(sf), { lastKickAt: 0 })));
  H.node(u, path.join(u.kit, 'hooks', 'session-start.js'), [], { cwd: u.root, env: Object.assign({}, live), input: JSON.stringify({ session_id: 's-acc2', cwd: u.root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(u.root, 'none.jsonl') }) });
  let sent = false;
  for (let i = 0; i < 120 && !sent; i++) { await H.sleep(500); sent = gl.issues().some((x) => /升级之后记的一条/.test(x.title)) && !fs.existsSync(path.join(u.kit, 'update', 'lock.json')); }
  H.ok('升级之后记的问题反馈建成了 issue（令牌是用 SSH 申请的）', sent && readJson(path.join(u.kit, 'secrets.json')).gitlabTokenSource === 'ssh', gl.issues().map((x) => x.title));
  // 第一个包还没有"装好时记下从什么时候开始传"（20260929.2205 才有）：它装着的时候记的那一条算存量，不传
  if (V1 < '20260929.2205') H.ok('装第二个包之前攒下的不传（存量推送去掉了）', !gl.issues().some((x) => /验收时记的一条/.test(x.title)), gl.issues().map((x) => x.title));

  gl.stop();
  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('验收：两个压缩包');
})().catch((e) => { console.log('出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

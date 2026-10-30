'use strict';
/*
 * 问题表第 22 条（自动模式根本不自动）查到的几条路，改完不能再回来（2026-10-30，docs/feedback-20261030.md 的 A1—A3）：
 *   迁移标记        defaults-1017-migration 不在长期保留的名单里，3 天后被会话清理删掉，之后每次更新都把两个自动模式关掉（审核 P01、Codex C08）
 *   标记已经丢了的  装之前已经是 20261018.0051 或更新的版本：补写标记，不动用户的开关；真从更老的版本升上来照旧迁移一次
 *   状态文件的寿命  代码里每个固定名字的状态文件，要么在 GLOBAL_STATE（长期保留），要么在 DISPOSABLE_STATE（可以清）
 *   钩子自检        config.json 读不懂时不写回空配置（P11）；路由拉不起来要认出来、切回命令方式（P36）；路由在跑却收不到，连着两轮才切
 *   中途改需求文档  做任务时只有 proposal.md、specs 变了才退回人工；改 design、tasks 不退，收工报告里列出来
 * 用法：node dev/test-auto-mode-kept.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRC = FROM || H.SRC;
const ago = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t); };
const json = (f) => { try { return JSON.parse(H.read(f)) || {}; } catch (e) { return null; } };

// ---------------------------------------------------------------------------------------------
H.section('迁移标记长期保留；丢了的按装之前的版本号认，不再改用户的开关');
{
  const pkg = (() => { if (!FROM) return H.makePackage('tamk-pkg', '20261030.1200'); const d = path.join(H.tempDir('tamk-pkg'), 'vibe-kit'); H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git'); H.stubDeps(d); return d; })();
  const u = H.freshHome('tamk-mig');
  const install = () => H.node(u, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000 });
  const cfgFile = path.join(u.kit, 'config.json');
  const setCfg = (patch) => H.write(cfgFile, JSON.stringify(Object.assign(json(cfgFile) || {}, patch), null, 2));
  const marker = path.join(u.kit, 'state', 'defaults-1017-migration.json');
  const i1 = install();
  H.ok('装好了，写了迁移标记', i1.code === 0 && fs.existsSync(marker), i1.out.slice(-600));
  // 用户在配置页开了两个自动、提交方式改成自动、压缩线 85
  setCfg({ autoApply: true, autoMode: true, autoRequirements: true, commitMode: 'auto', autoCompactPercent: 85 });
  ago(marker, 8 * 86400000);
  const r = H.node(u, '-e', ['require(' + JSON.stringify(path.join(u.kit, 'lib', 'session.js')) + ').cleanState(3)']);
  H.ok('会话清理（3 天）不删迁移标记', r.code === 0 && fs.existsSync(marker), r.err);
  // 20261030 以前的版本已经把它删掉了：装之前的版本是新的，就认"迁过了"
  try { fs.unlinkSync(marker); } catch (e) { /* 上一步没删掉 */ }
  const i2 = install();
  const c2 = json(cfgFile) || {};
  H.ok('标记丢了、装着的已经是新版：两个自动、提交方式、压缩线都不动', i2.code === 0 && c2.autoApply === true && c2.autoRequirements === true && c2.commitMode === 'auto' && c2.autoCompactPercent === 85 && !/改回了新的默认值/.test(i2.out), [c2, i2.out.slice(-600)]);
  H.ok('补写了迁移标记，记着按哪个版本认的', fs.existsSync(marker) && /recoveredFrom/.test(H.read(marker) || ''), H.read(marker));
  // 真从带迁移的那一版（20261018.0051）之前升上来：照旧强制改一次
  try { fs.unlinkSync(marker); } catch (e) { /* 没有 */ }
  H.write(path.join(u.kit, 'VERSION'), '20261017.0243\n');
  const i3 = install();
  const c3 = json(cfgFile) || {};
  H.ok('从 20261017.0243 升上来：照旧改成新默认值、关两个自动', i3.code === 0 && c3.autoApply === false && c3.commitMode === 'off' && c3.autoCompactPercent === 70 && /改回了新的默认值/.test(i3.out), [c3, i3.out.slice(-600)]);
}

// ---------------------------------------------------------------------------------------------
H.section('状态文件的寿命：固定名字的要么长期保留，要么写明可以清');
{
  const h = H.makeHome('tamk-life', FROM);
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const names = new Set();
  const scan = (dir) => {
    let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') scan(p); continue; }
      if (!/\.js$/.test(e.name)) continue;
      const t = fs.readFileSync(p, 'utf8');
      for (const m of t.matchAll(/(?:readState|writeState|updateState|stateFile|clearState)\(\s*'([a-z0-9-]+)'/g)) names.add(m[1] + '.json');
      for (const m of t.matchAll(/path\.join\([^)\n]*'state'\s*,\s*'([A-Za-z0-9._-]+)'\s*\)/g)) names.add(m[1]);
    }
  };
  scan(SRC); // kit、router、技能脚本、根上的 install.js、publish.js
  const D = Array.isArray(S.DISPOSABLE_STATE) ? S.DISPOSABLE_STATE : [];
  const loose = [...names].filter((f) => !(S.GLOBAL_STATE && S.GLOBAL_STATE.test(f)) && !D.includes(f) && !D.includes(f.replace(/\.json$/, '')));
  H.ok('扫到的固定名字不少于 30 个（扫描本身没坏）', names.size >= 30, [...names]);
  H.ok('每个都在 GLOBAL_STATE 或 DISPOSABLE_STATE 里', D.length > 0 && loose.length === 0, loose);
  H.ok('迁移标记在长期保留的名单里', !!(S.GLOBAL_STATE && S.GLOBAL_STATE.test('defaults-1017-migration.json')));
}

// ---------------------------------------------------------------------------------------------
H.section('钩子自检：读不懂配置不写回；路由拉不起来要认出来；收不到钩子连着两轮才切命令方式');
{
  const h = H.makeHome('tamk-hh', FROM, { hookTransport: 'http', autoApply: true, autoRequirements: true, commitMode: 'auto' });
  const cfgFile = path.join(h.kit, 'config.json');
  const settings = path.join(h.cfg, 'settings.json');
  const child = path.join(h.root, 'hh.js');
  // 假的路由管理：端口由测试给，ensureRunning 照真的那样不抛错、起不来返回 error
  H.write(path.join(h.kit, 'router', 'service.js'), "module.exports = { portOf: () => Number(process.env.TAMK_PORT), ensureRunning: async () => process.env.TAMK_ENSURE || 'error' };\n");
  H.write(child, [
    "'use strict';",
    'const net = require("net");',
    'const HH = require(' + JSON.stringify(path.join(h.kit, 'lib', 'hook-health.js')) + ');',
    '(async () => {',
    '  let srv = null;',
    '  if (process.env.TAMK_LISTEN) await new Promise((r) => { srv = net.createServer((s) => s.destroy()).listen(Number(process.env.TAMK_PORT), "127.0.0.1", r); });',
    '  const out = await HH.check({ session_id: "s-hh", transcript_path: process.env.TAMK_TR, prompt: "再改一下" });',
    '  if (srv) srv.close();',
    '  console.log(JSON.stringify({ out }));',
    '})().catch((e) => { console.log(JSON.stringify({ err: String(e && e.stack || e) })); });',
  ].join('\n'));
  const freePort = () => { const r = require('child_process').spawnSync(process.execPath, ['-e', 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();})'], { encoding: 'utf8', windowsHide: true }); return Number(String(r.stdout).trim()); };
  const port = freePort();
  const register = () => { H.write(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'http', url: 'http://127.0.0.1:' + port + '/vibe-kit/hook/guard-commit' }] }] } }, null, 2)); ago(settings, 2 * 3600000); };
  const tr = (name) => H.transcript(path.join(h.root, name + '.jsonl'), [H.tr.user('改一下'), H.tr.ran('Bash', { command: 'echo hi' }, 'hi'), H.tr.say('改好了'), H.tr.user('再改一下')]);
  const check = (env) => { const r = H.node(h, child, [], { env: Object.assign({ TAMK_PORT: String(port) }, env), timeout: 120000 }); try { return JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { return { err: r.out + r.err }; } };

  // 1. 路由没在跑、拉不起来（ensureRunning 返回 error，不抛错）
  register();
  const c1 = check({ TAMK_TR: tr('t1') });
  const cfg1 = json(cfgFile) || {};
  H.ok('路由拉不起来：说拉不起来，不说"已经拉起来了"', /拉不起来/.test(c1.out || '') && !/已经在后台把路由拉起来了/.test(c1.out || ''), c1);
  H.ok('拉不起来就切回命令方式，别的开关都在', cfg1.hookTransport === 'command' && cfg1.autoApply === true && cfg1.commitMode === 'auto', cfg1);

  // 2. config.json 读不懂：不写回（以前写回一份只有 hookTransport 的，用户的开关全没了）
  H.write(cfgFile, '{ "autoApply": true, "commitMode": "auto",');
  register();
  const c2 = check({ TAMK_TR: tr('t2') });
  H.ok('config.json 读不懂：原样留着，不写回空配置', H.read(cfgFile) === '{ "autoApply": true, "commitMode": "auto",', [H.read(cfgFile), c2]);
  H.ok('读不懂时说清楚没切成、用户怎么手动切', /没成功/.test(c2.out || '') && /读不懂/.test(c2.out || ''), c2);

  // 3. 路由在跑、钩子却没到：第一轮只重新登记，第二轮才切
  H.write(cfgFile, JSON.stringify({ hookTransport: 'http', autoApply: true, autoRequirements: true, commitMode: 'auto', autoUpdate: 'off', issueUpload: 'off' }, null, 2));
  register();
  const c3 = check({ TAMK_TR: tr('t3'), TAMK_LISTEN: '1' });
  H.ok('收不到钩子的第一轮：重新登记，不切方式', /下一轮还收不到就切回命令方式/.test(c3.out || '') && (json(cfgFile) || {}).hookTransport === 'http', [c3, json(cfgFile)]);
  register(); // 下一轮：重新登记是在上一轮做的，这一轮的调用在它之后
  const c4 = check({ TAMK_TR: tr('t4'), TAMK_LISTEN: '1' });
  const cfg4 = json(cfgFile) || {};
  H.ok('连着第二轮还收不到：切回命令方式，开关都在', /连着两轮/.test(c4.out || '') && cfg4.hookTransport === 'command' && cfg4.autoApply === true && cfg4.commitMode === 'auto', [c4, cfg4]);

  // 4. 路由在跑、收不到钩子、config.json 又正好读不懂（审核 P11 的原样场景）：切换时不能把它写成只有 hookTransport 的空配置
  const bad = '{ "autoApply": true, "commitMode": "auto", ';
  H.write(cfgFile, bad);
  for (const name of ['t5', 't6']) { register(); check({ TAMK_TR: tr(name), TAMK_LISTEN: '1' }); }
  H.ok('读不懂的 config.json 连着两轮都没被写回空配置', H.read(cfgFile) === bad, H.read(cfgFile));
}

// ---------------------------------------------------------------------------------------------
H.section('做任务时改需求文档：只有 proposal、specs 变了才退回人工；改 design、tasks 不退，记进收工报告');
{
  const h = H.makeHome('tamk-scope', FROM, { autoApply: true });
  const proj = H.makeRepo(path.join(h.work, 'proj'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  const dir = path.join(proj, 'openspec', 'changes', 'c1');
  H.write(path.join(dir, 'proposal.md'), '# 导出订单\n\n## Why\n\n要导出。\n');
  H.write(path.join(dir, 'design.md'), '# 设计\n\n- 导出放在 A.java\n');
  H.write(path.join(dir, 'tasks.md'), '## 1. 导出\n\n- [ ] 1.1 A.java 加导出方法\n- [ ] 1.2 加按钮\n');
  H.write(path.join(dir, 'specs', 'export', 'spec.md'), '## ADDED Requirements\n\n### Requirement: 导出\n\n能导出订单。\n');
  const S = require(path.join(h.kit, 'lib', 'session.js'));
  const A = require(path.join(h.kit, 'lib', 'apply-scope.js'));
  const j = { session_id: 's-scope', cwd: proj, transcript_path: H.transcript(path.join(h.root, 'scope.jsonl'), [H.tr.user('开工 c1')]) };
  S.setFlow(j, true, '测试', 'apply');
  const g = A.grant(j, '开工 c1', '', {});
  H.ok('开工范围登记上了', g && g.ok && A.valid(j).ok, g);
  const design = path.join(dir, 'design.md');
  A.prepareEdit(j, design);
  H.write(design, H.read(design) + '- 导出用 POI 写 xlsx\n');
  H.ok('补了 design：范围照旧有效（不退回人工）', A.valid(j).ok, A.valid(j));
  const tasks = path.join(dir, 'tasks.md');
  A.prepareEdit(j, tasks);
  H.write(tasks, H.read(tasks).replace('1.2 加按钮', '1.2 页面加导出按钮'));
  H.ok('改了 tasks 的措辞：范围照旧有效', A.valid(j).ok, A.valid(j));
  const rep = S.readState('s-scope-report');
  H.ok('改过的 design、tasks 记进了收工报告', (rep.items || []).filter((x) => x.kind === 'docEdit').length === 2, rep.items);
  const proposal = path.join(dir, 'proposal.md');
  H.write(proposal, H.read(proposal) + '\n还要能按日期筛选。\n');
  const v = A.valid(j);
  H.ok('改了 proposal 里的要求：范围作废，说清楚是需求本身变了', !v.ok && /需求本身/.test(v.reason || ''), v);
  // 20261030 以前登记的范围（没有 req）：照旧按整套文档比
  S.updateState('s-scope-flow', (s) => { s.applyScope = { at: Date.now(), dirs: { [S.normKey(dir)]: { hash: A.planHash(dir) } }, roots: [S.normKey(proj)] }; });
  H.ok('老的范围记录：没改时有效', A.valid(j).ok);
  H.write(design, H.read(design) + '- 再补一句\n');
  H.ok('老的范围记录：改了 design 照旧算变了（不悄悄放宽老记录）', !A.valid(j).ok);
}

H.done('自动模式不会被悄悄关掉（问题表第 22 条）');

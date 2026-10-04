'use strict';
/*
 * 安装、升级、同步、卸载：这一版新加的东西装得对不对（经验规则的文件、开关默认值、"自动记忆"那一项环境变量）。
 * 用真的 install.js 往假的用户目录里装（--no-router，不起路由）。
 * 用法：node dev/test-install-0928.js [上一版解压出来的 vibe-kit 目录]   给了就多测一遍"从上一版升级"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness');

const OLD = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'install.js')) ? process.argv[2] : '';
const ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
function freshHome(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vkt-' + name + '-'));
  const home = path.join(root, 'home');
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  return { root, home, cfg, kit: path.join(cfg, 'vibe-kit') };
}
const roots = [];
const install = (h, src, args) => H.node(h, path.join(src, 'install.js'), (args || []).concat(['--no-router', '--no-open']), { cwd: h.root, timeout: 180000 });
const settings = (h) => JSON.parse(H.read(path.join(h.cfg, 'settings.json')) || '{}');
const manifest = (h) => JSON.parse(H.read(path.join(h.kit, 'installed.json')) || '{}');
const config = (h) => JSON.parse(H.read(path.join(h.kit, 'config.json')) || '{}');
const setCfg = (h, patch) => fs.writeFileSync(path.join(h.kit, 'config.json'), JSON.stringify(Object.assign(config(h), patch), null, 2));

H.section('全新安装');
const h = freshHome('inst'); roots.push(h.root);
{
  const r = install(h, H.SRC);
  H.ok('装上了', r.code === 0 && /\[OK\] 技能/.test(r.out), r.out + r.err);
  H.ok('说了自动记忆已关掉', /自动记忆.*已关掉/.test(r.out), r.out);
  H.ok('经验库和工具都在', fs.existsSync(path.join(h.kit, 'lib', 'lessons.js')) && fs.existsSync(path.join(h.kit, 'tools', 'lesson.js')));
  H.ok('环境变量写进去了', settings(h).env && settings(h).env[ENV] === '1', settings(h).env);
  H.ok('记成自己加的（卸载时收回）', manifest(h).env && manifest(h).env[ENV] === '1', manifest(h));
  // 3-18：PowerShell 也放行，默认模式下不再一条条弹确认；push 照样由钩子要确认
  const perm = settings(h).permissions || {};
  H.ok('放行里有 PowerShell，记成套件加的', (perm.allow || []).includes('PowerShell') && (manifest(h).allow || []).includes('PowerShell'), [perm, manifest(h).allow]);
  const c = config(h);
  H.ok('新开关的默认值', c.lessons === 'on' && c.lessonThreshold === 2 && c.lessonMaxPerGroup === 10 && c.lessonMaxChars === 120 && c.lessonPromote === 'ask' && c.autoMemory === 'off', c);
  const hash = JSON.parse(H.read(path.join(h.kit, 'state', 'kit-hash.json')) || '{}');
  H.ok('代码指纹里有新文件', hash.files && hash.files['lib/lessons.js'] && hash.files['tools/lesson.js'], Object.keys(hash.files || {}));
  H.ok('审查技能里有"经验"那一节', /审完之后：经验/.test(H.read(path.join(h.cfg, 'skills', 'ttls-cross-review', 'SKILL.md')) || ''));
  H.ok('审查代理会报"以后怎么避免"', /以后怎么避免\*\*：一句话/.test(H.read(path.join(h.cfg, 'agents', 'ttls-reviewer.md')) || ''));
  H.ok('审查代理会报类别', /类别\*\*：想当然/.test(H.read(path.join(h.cfg, 'agents', 'ttls-reviewer.md')) || ''));
  const md = H.read(path.join(h.cfg, 'CLAUDE.md')) || '';
  H.ok('全局约定没有因为经验规则变长（不往每个请求里加字）', !/lesson\.js|经验规则/.test(md), md.slice(0, 200));
  const help = H.node(h, path.join(h.kit, 'tools', 'lesson.js'), ['help']);
  H.ok('工具能跑', help.code === 0 && /经验规则/.test(help.out), help.out + help.err);
  const drift = H.hook(Object.assign({}, h, { kit: h.kit }), 'session-start', { session_id: 's-inst', cwd: h.root, hook_event_name: 'SessionStart', source: 'startup', transcript_path: path.join(h.root, 'none.jsonl') });
  H.ok('会话开始不报"套件代码被改过"', !/套件自己的代码和安装时不一样/.test(H.reasonOf(drift)), H.reasonOf(drift));
}

H.section('配置页改开关（走 --sync）');
{
  setCfg(h, { autoMemory: 'on' });
  const r = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root });
  H.ok('改成不管它：环境变量去掉了', r.code === 0 && !(settings(h).env && ENV in settings(h).env) && !(ENV in (manifest(h).env || {})), r.out + JSON.stringify(settings(h).env));
  H.ok('别的环境变量还在', settings(h).env && settings(h).env.JAVA_TOOL_OPTIONS, settings(h).env);
  setCfg(h, { autoMemory: 'off' });
  const r2 = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root });
  H.ok('改回关掉：又加上了', r2.code === 0 && settings(h).env[ENV] === '1' && manifest(h).env[ENV] === '1', r2.out);
  const r3 = H.node(h, path.join(h.kit, 'install.js'), ['--sync'], { cwd: h.root });
  H.ok('再同步一次：settings.json 不变', /全局约定没有变化/.test(r3.out) && !/settings\.json 里的钩子/.test(r3.out), r3.out);
}

H.section('用户自己设过这一项的：不动');
{
  const u = freshHome('inst-user'); roots.push(u.root);
  fs.writeFileSync(path.join(u.cfg, 'settings.json'), JSON.stringify({ env: { [ENV]: '0' }, permissions: { allow: ['PowerShell'] } }, null, 2));
  const r = install(u, H.SRC);
  H.ok('装上了', r.code === 0, r.out + r.err);
  H.ok('用户的值没动', settings(u).env[ENV] === '0', settings(u).env);
  H.ok('没记成自己加的', !(ENV in (manifest(u).env || {})), manifest(u));
  H.ok('说了没动它', /你自己设了/.test(r.out), r.out);
  H.ok('自己放行过 PowerShell 的：不重复加，不记成套件加的', settings(u).permissions.allow.filter((x) => x === 'PowerShell').length === 1 && !(manifest(u).allow || []).includes('PowerShell'), [settings(u).permissions, manifest(u).allow]);
  const un = H.node(u, path.join(u.kit, 'install.js'), ['--uninstall'], { cwd: u.root });
  H.ok('卸载后用户的值还在', un.code === 0 && settings(u).env && settings(u).env[ENV] === '0', un.out + JSON.stringify(settings(u)));
  H.ok('卸载后自己放行的 PowerShell 还在', ((settings(u).permissions || {}).allow || []).includes('PowerShell'), settings(u));
}

if (OLD) {
  H.section('从上一版升级');
  const g = freshHome('inst-up'); roots.push(g.root);
  // 上一版的副本没带看页面的依赖：拷一份到临时目录，在那里建几个空目录让它的安装器过得去（不往留存的副本里加东西）
  const oldPkg = path.join(g.root, 'old-pkg');
  H.copyDir(OLD, oldPkg);
  for (const d of ['pixelmatch', 'pngjs', 'playwright', 'playwright-core']) fs.mkdirSync(path.join(oldPkg, 'kit', 'page', 'node_modules', d), { recursive: true });
  const r0 = install(g, oldPkg);
  H.ok('上一版装上了', r0.code === 0, r0.out + r0.err);
  H.ok('上一版没有这一项环境变量', !(settings(g).env && ENV in settings(g).env));
  setCfg(g, { reviewLoop: true, reviewMaxRounds: 4 });
  fs.mkdirSync(path.join(g.kit, 'feedback'), { recursive: true });
  fs.writeFileSync(path.join(g.kit, 'feedback', 'keep.md'), 'x');
  const r = install(g, H.SRC);
  H.ok('升级成功', r.code === 0, r.out + r.err);
  H.ok('用户改过的开关还在', config(g).reviewLoop === true && config(g).reviewMaxRounds === 4, config(g));
  H.ok('问题反馈还在', fs.existsSync(path.join(g.kit, 'feedback', 'keep.md')));
  H.ok('自动记忆关掉了', settings(g).env[ENV] === '1', settings(g).env);
  H.ok('版本号是新的', (H.read(path.join(g.kit, 'VERSION')) || '').trim() === (H.read(path.join(H.SRC, 'kit', 'VERSION')) || '').trim());
  // 老的开关文件里没有新开关：钩子按默认值算
  const L = require(path.join(g.kit, 'lib', 'lessons.js'));
  const st = L.settings();
  H.ok('开关文件里没有新开关时按默认值', st.mode === 'on' && st.threshold === 2 && st.maxPerGroup === 10 && st.promote === 'ask', st);
}

H.section('卸载');
{
  fs.mkdirSync(path.join(h.cfg, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(h.cfg, 'rules', 'ttls-lessons-java.md'), '---\npaths:\n  - "**/*.java"\n---\n\n- 一条用户级规则\n');
  fs.writeFileSync(path.join(h.cfg, 'rules', 'mine.md'), '- 用户自己的规则\n');
  fs.mkdirSync(path.join(h.kit, 'lessons'), { recursive: true });
  fs.writeFileSync(path.join(h.kit, 'lessons', 'index.json'), '{"projects":{},"lessons":[]}');
  const r = H.node(h, path.join(h.kit, 'install.js'), ['--uninstall'], { cwd: h.root });
  H.ok('卸载成功', r.code === 0 && /已卸载/.test(r.out), r.out + r.err);
  H.ok('环境变量收回了', !(settings(h).env && ENV in settings(h).env), settings(h));
  H.ok('套件加的 PowerShell 放行收回了', !(((settings(h).permissions || {}).allow || []).includes('PowerShell')), settings(h));
  H.ok('用户级经验规则留着，并且说了', fs.existsSync(path.join(h.cfg, 'rules', 'ttls-lessons-java.md')) && /用户级的经验规则也留着/.test(r.out), r.out);
  H.ok('用户自己的规则没动', fs.existsSync(path.join(h.cfg, 'rules', 'mine.md')));
  H.ok('跨项目的经验记录留着', fs.existsSync(path.join(h.kit, 'lessons', 'index.json')));
  H.ok('代码删掉了', !fs.existsSync(path.join(h.kit, 'lib')) && !fs.existsSync(path.join(h.kit, 'tools')));
}

for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (e) { /* 删不掉的留给下次 */ } }
H.done('安装、升级、卸载');

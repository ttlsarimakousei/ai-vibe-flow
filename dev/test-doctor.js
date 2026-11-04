'use strict';
/*
 * K3 M05（2026-11-01，docs/feedback-20261101.md）：总体检 tools/doctor.js 和第一次使用的说明。
 *   刚装好的电脑：没有 [坏]，退出码 0；每一项都有结果，--json 能解析
 *   弄坏一样报一样，说清怎么改，有 [坏] 时退出码 1：文件载不进、settings.json 坏了、钩子没登记、令牌规则没了、更新装坏了、代码被改过
 *   该知道的报 [注意]：放松了保护的开关、固定在这一版、端口被别的安装的路由占着
 *   不打印令牌、key，不改文件、不留进程
 *   第一次使用的说明：全新安装后第一个会话说一次，压缩后不说，升级的不说
 * 用法：node dev/test-doctor.js [旧版的 vibe-kit 目录]（给了就拿旧版的安装包跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? path.resolve(process.argv[2]) : null;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } };
const V = '20261101.0900';
const V2 = '20261102.0900';

function pkgOf(name, version) {
  if (!FROM) return H.makePackage(name, version);
  const dir = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(FROM, dir, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(dir);
  fs.writeFileSync(path.join(dir, 'kit', 'VERSION'), version + '\n');
  return dir;
}
const pkg = pkgOf('doc-pkg', V);
const pkg2 = pkgOf('doc-pkg2', V2);
/** 全新的一台电脑：用真的安装器装（不带路由） */
function machine(name) {
  const h = H.freshHome(name);
  const r = H.node(h, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  H.ok('（' + name + ' 装上了）', r.code === 0, r.out + r.err);
  h.doctor = (args, cwd) => H.node(h, path.join(h.kit, 'tools', 'doctor.js'), args || [], { cwd: cwd || h.root, timeout: 180000 });
  h.checks = () => { const d = h.doctor(['--json']); try { return Object.assign(JSON.parse(d.out.trim().split(/\r?\n/).pop()), { code: d.code }); } catch (e) { return { checks: [], code: d.code, raw: d.out + d.err }; } };
  h.item = (name2) => (h.checks().checks || []).find((x) => x.name === name2) || {};
  return h;
}
const settingsOf = (h) => path.join(h.cfg, 'settings.json');
const patchSettings = (h, fn) => { const s = readJson(settingsOf(h)); fn(s); fs.writeFileSync(settingsOf(h), JSON.stringify(s, null, 2)); };
const setState = (h, name, obj) => { const f = path.join(h.kit, 'state', name + '.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
const setCfg = (h, patch) => { const f = path.join(h.kit, 'config.json'); fs.writeFileSync(f, JSON.stringify(Object.assign(readJson(f), patch), null, 2)); };
/** 看一个目录下的文件名和修改时间，用来确认体检没改东西（日志、用量这类钩子才写的不算） */
const snapshot = (dir) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); const st = fs.statSync(f); if (st.isDirectory()) { if (n !== 'node_modules') walk(f); } else out[f] = st.mtimeMs + ':' + st.size; } }; walk(dir); return out; };

(async () => {
  const watch = await H.watchWindows('doc-win');
  H.ok('盯窗口的脚本起来了', watch.ready);

  H.section('刚装好的电脑：没有 [坏]，每一项都有结果');
  {
    const h = machine('doc-ok');
    const before = snapshot(h.kit);
    const t = h.doctor();
    H.ok('工具在，退出码 0', t.code === 0, t.out + t.err);
    H.ok('说了套件版本，最后说结论', t.out.includes(V) && /(都正常|能用，有 \d+ 项要知道)/.test(t.out), t.out);
    const j = h.checks();
    H.ok('--json 能解析，ok 是真', j.ok === true && j.version === V, j);
    const names = (j.checks || []).map((c) => c.name);
    H.ok('每一项都有结果', ['环境', '套件文件', '随包依赖', 'Claude Code 设置', '自动更新', '工具', '开关', '代码指纹', '问题上报', '状态目录', '当前项目'].every((n) => names.includes(n)), names);
    H.ok('没有自己出错的项', !(j.checks || []).some((c) => c.level === '没查成'), j.checks);
    H.ok('不再有模型路由这一项', !names.includes('模型路由'), names);
    const after = snapshot(h.kit);
    // 跑状态栏时它自己记的缓存不算
    const changed = Object.keys(after).filter((f) => after[f] !== before[f] && !/hooks\.log|update\.log|changes-cache|diag\.json/.test(f)); // diag.json：机器忙、等锁久了诊断模块记一笔
    H.ok('体检不改套件目录里的文件', changed.length === 0, changed);
  }

  H.section('弄坏一样报一样，说清怎么改，退出码 1');
  {
    const h = machine('doc-bad');
    const expectBad = (title, name, re) => {
      const j = h.checks();
      const it = (j.checks || []).find((x) => x.name === name) || {};
      H.ok(title, j.code === 1 && j.ok === false && it.level === '坏' && re.test(it.text) && !!it.fix, [j.code, it, j.raw]);
    };
    // 载不进的库
    const lib = path.join(h.kit, 'lib', 'zz-broken.js');
    fs.writeFileSync(lib, 'throw new Error("故意写坏的");\n');
    expectBad('库文件载不进：说是哪一个', '套件文件', /zz-broken\.js/);
    fs.unlinkSync(lib);
    const good = fs.readFileSync(settingsOf(h), 'utf8');
    fs.writeFileSync(settingsOf(h), '{ 写坏了');
    expectBad('settings.json 读不懂', 'Claude Code 设置', /读不懂/);
    fs.writeFileSync(settingsOf(h), good);
    patchSettings(h, (s) => { delete s.hooks; });
    expectBad('钩子没登记', 'Claude Code 设置', /没有登记/);
    fs.writeFileSync(settingsOf(h), good);
    patchSettings(h, (s) => { s.permissions.deny = (s.permissions.deny || []).filter((d) => !/secrets\.json/.test(d)); });
    expectBad('令牌保护的规则没了', 'Claude Code 设置', /令牌/);
    fs.writeFileSync(settingsOf(h), good);
    setState(h, 'update', { failed: { version: V2, from: V, times: 1, at: Date.now() + 60000, rolledBack: false, why: '测试' } });
    expectBad('更新装坏了、没装回去', '自动更新', /没装好/);
    setState(h, 'update', {});
    setState(h, 'kit-drift', { list: ['hooks/guard-read.js（改过）'], at: Date.now() });
    expectBad('代码和安装时不一样', '代码指纹', /guard-read/);
    setState(h, 'kit-drift', { list: [], at: Date.now() });
    const ok = h.checks();
    H.ok('都改回去：又是退出码 0', ok.code === 0 && ok.ok === true, ok.checks && ok.checks.filter((c) => c.level === '坏'));
  }

  H.section('该知道的报 [注意]，退出码还是 0');
  {
    const h = machine('doc-note');
    // 放松保护的开关只认配置页、安装器写的：封条要一起写
    setCfg(h, { specGate: false });
    setState(h, 'config-seal', { at: Date.now() });
    const c = h.item('开关');
    H.ok('放松了保护的开关：说是哪几个；不再有"允许改套件""让它自己放行"（2026-11-04 去掉）', c.level === '注意' && /提案检查关着/.test(c.text) && !/改套件|自己放行/.test(c.text), c);
    setCfg(h, { specGate: true, updatePin: V });
    setState(h, 'config-seal', { at: Date.now() });
    setState(h, 'update', { remoteVersion: V2 });
    const u = h.item('自动更新');
    H.ok('固定在这一版：说了，还说怎么取消', u.level === '注意' && u.text.includes('固定在 ' + V) && /取消固定/.test(u.fix), u);
    H.ok('退出码 0', h.checks().code === 0);
    setCfg(h, { updatePin: '' });
  }

  H.section('不打印令牌、key');
  {
    const h = machine('doc-secret');
    const TOKEN = 'glpat-doctor-secret-token-1234';
    const KEY = 'sk-doctor-model-key-5678';
    fs.writeFileSync(path.join(h.kit, 'secrets.json'), JSON.stringify({ gitlabToken: TOKEN, gitlabTokenSource: 'manual' }));
    H.write(path.join(h.kit, 'router-data', 'config.json'), JSON.stringify({ providers: [{ apiKey: KEY }] }));
    const t = h.doctor();
    const j = h.doctor(['--json']);
    H.ok('输出里没有令牌、key', !(t.out + t.err + j.out + j.err).includes(TOKEN) && !(t.out + t.err + j.out + j.err).includes(KEY), t.out);
    H.ok('只说有令牌', /有令牌/.test(t.out), t.out);
  }

  H.section('跑体检的目录：git 仓库、.vibe 忽略');
  {
    const h = machine('doc-proj');
    const repo = H.makeRepo(path.join(h.root, 'work', 'shop'), { 'pom.xml': '<project/>\n' });
    const t = JSON.parse(h.doctor(['--json'], repo).out.trim().split(/\r?\n/).pop());
    const p = t.checks.find((c) => c.name === '当前项目');
    H.ok('.vibe/ 没被忽略：提醒', p.level === '注意' && /\.vibe/.test(p.text), p);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.vibe/\n');
    const t2 = JSON.parse(h.doctor(['--json'], repo).out.trim().split(/\r?\n/).pop());
    H.ok('忽略了：好，说了项目名', t2.checks.find((c) => c.name === '当前项目').level === '好' && /shop/.test(t2.checks.find((c) => c.name === '当前项目').text), t2.checks.find((c) => c.name === '当前项目'));
  }

  H.section('第一次使用的说明：全新安装后第一个会话说一次');
  {
    const h = machine('doc-hi');
    const repo = H.makeRepo(path.join(h.root, 'work', 'p'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
    const start = (source) => H.reasonOf(H.hook(h, 'session-start', { hook_event_name: 'SessionStart', session_id: 'sess-hi', cwd: repo, source, transcript_path: '' }, { spawn: true }));
    const c0 = start('compact');
    H.ok('压缩后的不说', !/第一次用 vibe-kit/.test(c0), c0);
    const c1 = start('startup');
    H.ok('新开的会话说一次：斜杠命令、被拦了怎么办、体检命令', /第一次用 vibe-kit/.test(c1) && /\/vk-fix/.test(c1) && /doctor\.js/.test(c1), c1);
    const c2 = start('startup');
    H.ok('下一个会话不再说', !/第一次用 vibe-kit/.test(c2), c2);
    const u = H.node(h, path.join(pkg2, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
    H.ok('（升到新版）', u.code === 0, u.out + u.err);
    const c3 = start('startup');
    H.ok('升级的不说', !/第一次用 vibe-kit/.test(c3), c3);
  }

  await H.sleep(300);
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('总体检和第一次使用的说明' + (FROM ? '，拿 ' + FROM + ' 跑' : ''));
})().catch((e) => { H.ok('测试脚本出错', false, e && e.stack); H.done('总体检和第一次使用的说明'); });

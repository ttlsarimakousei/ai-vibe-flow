'use strict';
/*
 * 总体检（K3 M05，2026-11-01）：一条命令看套件装得对不对、现在哪里不对、怎么改。用户和模型都能跑：
 *   node "$HOME/.claude/vibe-kit/tools/doctor.js" [--json]
 * 每项一行：[好] [注意]（能用，但要知道）[坏]（有东西不工作，后面写着怎么改）[没查成]（这一项自己出错了，不算坏）。有 [坏] 时退出码是 1。
 * 只读：不连外网、不改配置和代码、不留进程（载文件在一个用完就退的子进程里）。
 * 令牌、key 只说有没有，不读内容，输出再过一遍遮盖（硬规矩 6）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('../lib/session');
const R = require('../lib/redact');

const { KIT, CFG_DIR, readState, readConfig } = S;
const good = (text) => ({ level: '好', text });
const warn = (text, fix) => ({ level: '注意', text, fix });
const bad = (text, fix) => ({ level: '坏', text, fix });
const INSTALL_AGAIN = '重新运行安装包（新包装在原来的上面，开关和配置都留着）';
const run = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 8000 }, opts || {}));
const firstLine = (s) => String(s || '').trim().split(/\r?\n/)[0] || '';
const readJson = (f) => { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); };
const version = () => { try { return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim(); } catch (e) { return ''; } };

/** 环境：Node、git、Claude Code */
function env() {
  const major = parseInt(process.versions.node, 10);
  if (major < 18) return bad('Node 是 ' + process.versions.node + '，套件要 18 以上', '升级 Node');
  const git = run('git', ['--version']);
  if (git.status !== 0) return bad('找不到 git：自动更新、提交检查都要用它', '装上 git，让命令行里能直接敲 git');
  const cc = run('claude', ['--version'], { shell: process.platform === 'win32' });
  const ccv = cc.status === 0 ? firstLine(cc.stdout) : '';
  const text = 'Node ' + process.versions.node + '，' + firstLine(git.stdout) + (ccv ? '，Claude Code ' + ccv : '');
  if (!ccv) return warn(text + '，命令行里找不到 claude', '用桌面版可以不管；用命令行的话把 claude 加进 PATH');
  return good(text);
}
/** 钩子、库、状态栏载不载得进：在子进程里载，载坏了不影响体检自己 */
function files() {
  const script = [
    "const fs = require('fs'); const path = require('path'); const kit = " + JSON.stringify(KIT) + ';',
    "for (const d of ['lib', 'hooks']) for (const f of fs.readdirSync(path.join(kit, d))) if (/[.]js$/.test(f)) { try { require(path.join(kit, d, f)); } catch (e) { console.log('载不进 ' + d + '/' + f + '：' + String(e.message).split('\\n')[0]); process.exit(3); } }",
    "const r = require(path.join(kit, 'lib', 'entry-check.js')).check(); if (!r.ok) { console.log(r.why); process.exit(3); } console.log('ok');",
  ].join('\n');
  const a = run(process.execPath, ['-e', script], { timeout: 60000 });
  if (a.status !== 0) return bad('套件的文件有问题：' + (firstLine(a.stdout) || firstLine(a.stderr) || '自检没跑完'), INSTALL_AGAIN);
  const st = run(process.execPath, [path.join(KIT, 'statusline.js')], { input: '{}', timeout: 30000 });
  if (st.status !== 0) return bad('状态栏跑不出来：' + firstLine(st.stderr), INSTALL_AGAIN);
  const ver = version();
  if (!ver) return bad('没有版本号（kit/VERSION），可能装到一半断了', INSTALL_AGAIN);
  return good('套件 ' + ver + '，钩子、库、状态栏都载得进，行为自检过了');
}
/** 随包依赖：照依赖清单核对（打包时生成的，从源码装的没有） */
function deps() {
  const D = require('../lib/deps');
  const man = D.read(KIT);
  if (!man) return good('这一份没有依赖清单（不是从安装包装的），不查');
  const c = D.check(KIT, man);
  if (c.missing.length || c.mismatched.length) return bad('随包依赖不全：' + c.missing.concat(c.mismatched).slice(0, 5).join('、'), INSTALL_AGAIN);
  const gaps = D.nodeGaps(man);
  if (gaps.length) return warn('这台电脑的 Node 是 ' + process.versions.node + '：' + gaps.map((g) => g.label + '要 Node ' + g.node + '，' + g.without).join('；'), '要用这些就升级 Node，套件别的功能不受影响');
  return good('随包依赖都在，版本对得上');
}
/** settings.json：钩子登记了没有、令牌保护的规则在不在、状态栏 */
function settings() {
  const f = path.join(CFG_DIR, 'settings.json');
  let s;
  try { s = readJson(f); } catch (e) { return bad(f + (e.code === 'ENOENT' ? ' 不存在' : ' 读不懂（JSON 写坏了）') + '，钩子都不会生效', e.code === 'ENOENT' ? INSTALL_AGAIN : '先把这个文件改对，再' + INSTALL_AGAIN); }
  const n = Object.values(s.hooks || {}).flat().flatMap((g) => (g && g.hooks) || []).filter((h) => /vibe-kit[\\/]hooks[\\/]/.test(String((h && h.command) || ''))).length;
  if (!n) return bad('settings.json 里没有登记套件的钩子，所有检查都不生效', INSTALL_AGAIN);
  const deny = (s.permissions && Array.isArray(s.permissions.deny) ? s.permissions.deny : []).map(String);
  const lost = [['secrets.json', '令牌'], ['router-data', '模型的 key']].filter(([k]) => !deny.some((d) => d.includes(k))).map((x) => x[1]);
  if (lost.length) return bad('settings.json 里"不许读' + lost.join('、') + '"的权限规则没了', INSTALL_AGAIN);
  const line = s.statusLine && String(s.statusLine.command || '').includes('statusline.js');
  const text = '登记了 ' + n + ' 个钩子，令牌保护的规则在';
  return line ? good(text) : warn(text + '，状态栏不是套件的', '你自己配的可以不管；要套件的状态栏，把 settings.json 的 statusLine 删掉再' + INSTALL_AGAIN);
}
/** 自动更新：只看状态文件，不连网 */
function update() {
  const u = require('../lib/updater').status();
  if (u.broken) return bad('新版 ' + u.broken.version + ' 没装好，也没能装回上一版 ' + (u.broken.from || ''), INSTALL_AGAIN);
  if (u.refused) return bad('新版 ' + u.refused.version + ' 装不上：' + (u.refused.why || ''), '把电脑上的问题改好，6 小时内会再试，或者在配置页"更新和上报"点"立即更新"');
  if (u.pin) return warn('固定在 ' + u.pin + '，不自动更新' + (u.differs ? '（仓库里是 ' + u.remote + '）' : ''), '要更新，到配置页"更新和上报"点"取消固定"');
  if (u.failed && u.differs) return warn('新版 ' + u.failed.version + ' 没装上' + '：' + (u.failed.why || ''), '详情在配置页"更新和上报"');
  if (u.mode === 'off') return warn('自动更新关着', '要开到配置页"更新和上报"');
  if (u.lastCheckAt && !u.lastCheckOk) return warn('上次检查更新没成功：' + (u.lastError || ''), '到配置页"更新和上报"点"测试连接"');
  if (u.differs) return good('装着 ' + u.installed + '，仓库里是 ' + u.remote + (u.hold === 'wait' ? '，等尝鲜组先试' : u.hold === 'flag' ? '，尝鲜组报了有问题，先不装' : u.hold === 'skip' ? '，跳过了这一版' : ''));
  return good(u.remote ? '和仓库里一样（' + u.remote + '）' : '还没查过更新');
}
/** 自带的 OpenSpec、看页面用的浏览器 */
function tools() {
  const O = require('../lib/openspec');
  const i = O.info();
  const spec = O.usable() ? 'OpenSpec ' + i.version + '（套件自带）' : '';
  const miss = [];
  if (!spec) miss.push(i ? 'OpenSpec 要 Node ' + i.node + '，这台电脑不够，会退回用项目自己装的' : '自带的 OpenSpec 不在');
  const edge = [process.env.PROBE_BROWSER_PATH].concat(['ProgramFiles(x86)', 'ProgramFiles'].map((k) => (process.env[k] ? path.join(process.env[k], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''))).filter(Boolean);
  const hasEdge = process.platform !== 'win32' || edge.some((p) => fs.existsSync(p));
  if (!hasEdge) miss.push('找不到系统的 Edge，看页面用不了');
  if (miss.length) return warn((spec ? spec + '；' : '') + miss.join('；'), '不用这些功能可以不管；Edge 装在别处的，设环境变量 PROBE_BROWSER_PATH');
  return good(spec + '，看页面用系统的 Edge');
}
/** 放松了保护的开关 */
function config() {
  try { readJson(path.join(KIT, 'config.json')); } catch (e) { if (e.code !== 'ENOENT') return bad('config.json 读不懂，开关都按默认算', '到配置页"套件开关"保存一次，或者把文件改对'); }
  const c = readConfig();
  const loose = [];
  if (c.kitLock === false) loose.push('允许 Claude 改套件');
  if (c.kitBypass === 'auto') loose.push('被拦住时让它自己放行');
  if (c.specGate === false) loose.push('提案检查关着');
  if (c.commitCheck === false) loose.push('提交检查关着');
  return loose.length ? warn('放松了保护：' + loose.join('、'), '是你自己开的可以不管；改回去在配置页"套件开关"') : good('保护的开关都是默认的');
}
/** 套件自己的代码和安装时记的指纹比（会话开始的钩子比的，这里看结果） */
function drift() {
  const d = readState('kit-drift');
  if (d.list && d.list.length) return bad('套件的代码和安装时不一样：' + d.list.slice(0, 3).join('、') + (d.list.length > 3 ? ' 等 ' + d.list.length + ' 个' : ''), INSTALL_AGAIN);
  return good('套件的代码和安装时一样');
}
/** 问题上报：只说条数、通不通，令牌只说有没有 */
function issues() {
  const i = require('../lib/issues').summary();
  const G = require('../lib/gitlab').publicSettings();
  const base = '记下 ' + i.total + ' 条问题，上报了 ' + i.uploaded + ' 条';
  if (!i.on) return warn(base + '，问题上报关着', '要开到配置页"更新和上报"');
  if (i.lastError) return warn(base + '，最近一次没传成：' + i.lastError, '到配置页"更新和上报"点"测试连接"');
  return good(base + (G.tokenSet ? '，有令牌' : '，没有令牌（要建 issue 时用 SSH 申请）'));
}
/** 状态目录写得了吗、攒了多少 */
function state() {
  const d = path.join(KIT, 'state');
  try { fs.accessSync(d, fs.constants.W_OK); } catch (e) { return bad(d + ' 写不了：状态记不下来，检查会放行', '查这个目录的权限，或者杀毒软件有没有拦'); }
  let size = 0;
  let count = 0;
  const walk = (p, depth) => { for (const n of fs.readdirSync(p)) { const f = path.join(p, n); let st; try { st = fs.statSync(f); } catch (e) { continue; } if (st.isDirectory()) { if (depth < 2) walk(f, depth + 1); } else { size += st.size; count++; } } };
  walk(d, 0);
  const mb = Math.round(size / 1048576);
  if (mb > 200) return warn('状态目录有 ' + mb + ' MB（' + count + ' 个文件），偏大', '告诉维护的人，记一条问题反馈');
  return good('状态目录写得了，' + count + ' 个文件');
}
/** 最近 7 天的本机诊断（lib/diag.js）：钩子预算用完、锁等待 */
function diag() {
  const r = require('../lib/diag').recent(7);
  const sum = (o) => Object.values(o || {}).reduce((a, v) => ({ n: a.n + v.n, total: a.total + v.total, max: Math.max(a.max, v.max) }), { n: 0, total: 0, max: 0 });
  const sec = (ms) => (Math.round(ms / 100) / 10) + ' 秒';
  const parts = [];
  const budget = r['钩子预算'] || {};
  const lock = sum(r['锁等待']);
  if (lock.n) parts.push('等锁超过 0.2 秒 ' + lock.n + ' 次，最长 ' + sec(lock.max));
  const stops = Object.entries(budget).sort((a, b) => b[1].n - a[1].n);
  const n = stops.reduce((a, x) => a + x[1].n, 0);
  if (n) parts.unshift('钩子预算用完 ' + n + ' 次（最多的停在"' + stops[0][0] + '"，这些次检查放行了）');
  if (!parts.length) return good('最近 7 天没有要说的（只记本机，不上报）');
  const text = '最近 7 天：' + parts.join('；');
  return n ? warn(text, '次数多的话记一条问题反馈，把这一行带上') : good(text);
}
/** 跑体检的这个目录：是不是项目、OpenSpec 初始化了没有、.vibe 忽略了没有 */
function project() {
  const cwd = process.cwd();
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (top.status !== 0) {
    if (S.isShell && S.isShell(cwd)) return good('当前目录是壳子（' + path.basename(cwd) + '），子项目各管各的');
    return good('当前目录不是 git 仓库，项目这一项不查');
  }
  const root = firstLine(top.stdout);
  const notes = [path.basename(root)];
  notes.push(fs.existsSync(path.join(root, 'openspec')) ? 'OpenSpec 初始化过' : 'OpenSpec 没初始化（第一次用时自动做）');
  notes.push(fs.existsSync(path.join(root, '.vibe', 'project.md')) ? '有项目说明' : '还没有项目说明（后台自动探索）');
  const ig = run('git', ['check-ignore', '-q', '.vibe/x'], { cwd: root });
  if (ig.status === 1) return warn(notes.join('，') + '，.vibe/ 没被 git 忽略', '.gitignore 里加一行 .vibe/，别把过程文件提交上去');
  return good(notes.join('，'));
}

const CHECKS = [['环境', env], ['套件文件', files], ['随包依赖', deps], ['Claude Code 设置', settings], ['自动更新', update], ['工具', tools], ['开关', config], ['代码指纹', drift], ['问题上报', issues], ['状态目录', state], ['本机诊断', diag], ['当前项目', project]];

async function examine() {
  const out = [];
  for (const [name, fn] of CHECKS) {
    let r;
    try { r = await fn(); } catch (e) { r = { level: '没查成', text: firstLine(e && e.message) }; }
    out.push({ name, level: r.level, text: R.text(String(r.text || '')), fix: R.text(String(r.fix || '')) });
  }
  return out;
}

if (require.main === module) {
  examine().then((list) => {
    const broken = list.filter((x) => x.level === '坏').length;
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: !broken, version: version(), host: os.platform(), checks: list }));
    else {
      console.log('vibe-kit 体检（套件 ' + (version() || '没有版本号') + '）\n');
      for (const x of list) console.log('[' + x.level + '] ' + x.name + '：' + x.text + (x.fix ? '\n      怎么办：' + x.fix : ''));
      const noted = list.filter((x) => x.level === '注意').length;
      console.log('\n' + (broken ? broken + ' 项有问题，照上面的"怎么办"改。' : noted ? '能用，有 ' + noted + ' 项要知道。' : '都正常。'));
    }
    process.exitCode = broken ? 1 : 0;
  }).catch((e) => { console.log('体检出错：' + firstLine(e && e.message)); process.exitCode = 2; });
}
module.exports = { examine, CHECKS };

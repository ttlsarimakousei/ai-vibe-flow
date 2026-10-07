'use strict';
/*
 * vibe-kit 安装脚本。一次装好两样东西：
 *   套件：约定、规范、技能、审查代理、钩子、状态栏、看页面的执行器，装进 ~/.claude
 *   模型路由：在后台启动（没有窗口，任务栏里没有东西），登录后自动启动，最后自己验证配置页打得开
 *   node install.js             安装或更新（从安装包目录运行）。--no-open 不自动打开配置页；
 *                               --no-router 不装、不更新路由（以前装过的路由原样留着、照常运行，卸载时照样停它）
 *   node install.js --sync      只根据 ~/.claude/vibe-kit 里的约定、规范和本机环境（local.json）重新生成全局约定
 *   node install.js --uninstall 卸载（你自己加的规范文件和备份会留着）
 * 原则：先检查后动手，settings.json 读不懂、全局 CLAUDE.md 不是 UTF-8，就什么都不动；只添加不删改；要覆盖你改过的东西之前先备份（只留最近 20 份）；
 * 装了什么记在 installed.json 里，卸载时只收回自己加的；你删掉的权限和环境变量，升级时不再补回来。
 * 目录复制是自己写的递归：Node 22 自带的递归 cpSync 碰到带中文的路径会直接崩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = __dirname;
const FROM_PACKAGE = fs.existsSync(path.join(SRC, 'claude')) && fs.existsSync(path.join(SRC, 'kit'));
// 从安装包运行：装进 CLAUDE_CONFIG_DIR 或 ~/.claude。装进去的那份（~/.claude/vibe-kit/install.js）：用户目录就是它上一层，
// 不看环境变量——配置页保存时由路由调它，路由可能是登录时拉起来的，那时的环境变量和用户开 Claude Code 的终端不一样
const CLAUDE = FROM_PACKAGE ? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) : path.dirname(SRC);
const KIT = path.join(CLAUDE, 'vibe-kit');
const BEGIN = '<!-- vibe-kit:begin 这两行标记之间的内容是生成的。要改请改 ~/.claude/vibe-kit 里的 CLAUDE.md 或 rules/*.md，然后运行 node ~/.claude/vibe-kit/install.js --sync -->';
const END = '<!-- vibe-kit:end -->';
const BLOCK_RE = /^<!-- vibe-kit:begin[^\n]*-->\r?\n[\s\S]*?^<!-- vibe-kit:end -->[ \t]*\r?\n?/gm;
const SKILLS = ['ttls-onboard', 'ttls-see-page', 'ttls-cross-review', 'ttls-handover', 'ttls-db-crud', 'ttls-redis'];
const AGENTS = ['ttls-reviewer.md'];
// 改名之前套件自己装的（名字太普通，会和别人的套件撞）：装这一版时删掉
const OLD_SKILLS = ['onboard', 'see-page', 'cross-review', 'handover'];
const OLD_AGENTS = ['vibe-reviewer.md'];
// 并进套件之前单独装的技能：认得出是它才收。urai-db-crud 自带的驱动先挪进套件的驱动目录
const skillName = (d) => { try { return (/^name:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8')) || [])[1] || ''; } catch (e) { return ''; } };
const isDbCrud = (d) => (fs.existsSync(path.join(d, 'scripts', 'db.py')) && fs.existsSync(path.join(d, 'scripts', 'sqlguard.py'))) || /^(urai-)?db-crud$/.test(skillName(d));
const ABSORBED = [
  { name: 'urai-db-crud', now: 'ttls-db-crud', is: isDbCrud, drivers: true },
  { name: 'db-crud', now: 'ttls-db-crud', is: isDbCrud, drivers: true },
  // 名字叫 redis 的技能别人也可能有：SKILL.md 里的名字是 redis、带着那个直连客户端的才算
  { name: 'redis', now: 'ttls-redis', is: (d) => skillName(d) === 'redis' && (fs.existsSync(path.join(d, 'assets', 'redis-client.js')) || /redis-client\.js/.test((() => { try { return fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'); } catch (e) { return ''; } })())) },
];
const HOOK_MARK = 'vibe-kit/hooks/';
// 走 HTTP 的钩子打到路由的这个路径上：http://127.0.0.1:<端口>/vibe-kit/hook/<名字>
const HOOK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/vibe-kit\/hook\//i;
let mode = process.argv.includes('--uninstall') ? 'uninstall' : (process.argv.includes('--sync') ? 'sync' : 'install');
// 装进去的那份 install.js 旁边没有安装包，不带参数运行就当成 --sync
if (mode === 'install' && !FROM_PACKAGE) mode = 'sync';
const NO_ROUTER = process.argv.includes('--no-router');

// 做到一半出错（文件只读、被占用、没有权限、磁盘满）：不甩一屏英文堆栈，用中文说清出了什么事、现在是什么状态、怎么办
function explainCrash(e) {
  const code = e && e.code;
  const what = mode === 'uninstall' ? '卸载' : mode === 'sync' ? '重新生成全局约定' : '安装';
  const why = code === 'EPERM' || code === 'EACCES' ? '没有权限写这个文件（文件是只读的，或者被别的程序占着：杀毒软件、编辑器、正在运行的 Claude Code）'
    : code === 'EBUSY' ? '文件被别的程序占着'
      : code === 'ENOSPC' ? '磁盘满了'
        : code === 'ENOENT' ? '找不到文件（安装包不完整，或者没解压就在压缩包里运行了）'
          : String((e && e.message) || e);
  console.log('');
  console.log('  [X] ' + what + '做到一半出错了：' + why);
  if (e && e.path) console.log('      出错的文件：' + e.path);
  console.log('      现在的状态：可能只做了一部分，套件的文件可能新旧混在一起。');
  console.log('      怎么办：关掉占着文件的程序（正在运行的 Claude Code、打开着这些文件的编辑器），去掉上面那个文件的只读属性，再运行一次' + (mode === 'uninstall' ? '卸载' : '安装') + '——重新运行会把没做完的补上。');
  console.log('      还不行，把这几行和下面这行原始错误一起发给维护套件的人：');
  console.log('      ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
  process.exit(1);
}
process.on('uncaughtException', explainCrash);
process.on('unhandledRejection', explainCrash);

const STAMP = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); })();
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; } };

// 目标可能带只读属性（从只读共享、版本库检出拷来的），先放开再覆盖
function copyFile(s, d) {
  try { fs.chmodSync(d, 0o644); } catch (e) { /* 目标不存在 */ }
  fs.copyFileSync(s, d);
  try { fs.chmodSync(d, 0o644); } catch (e) { /* 忽略 */ }
}
/** skip：这一层不拷的名字 */
function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skip && skip.includes(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else if (st.isFile()) copyFile(s, d);
  }
}
/**
 * 删掉一个目录或文件，删完核对：还在就报错（force 会把一部分删不掉的情况悄悄吞掉，提示却说删了）。
 * 只读的文件先放开再删
 */
function removeDir(p) {
  if (!fs.existsSync(p)) return;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) {
    // 带只读属性的文件（从只读共享拷来的）：放开再删一次
    const unlock = (q) => { try { const st = fs.lstatSync(q); fs.chmodSync(q, 0o666); if (st.isDirectory()) for (const n of fs.readdirSync(q)) unlock(path.join(q, n)); } catch (e2) { /* 放不开 */ } };
    unlock(p);
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  if (fs.existsSync(p)) throw Object.assign(new Error('删不掉：' + p), { code: 'EBUSY', path: p });
}
/** 同上，删不掉也不报错（清旧备份这种删不掉也不碍事的） */
function removeDirQuiet(p) { try { removeDir(p); } catch (e) { /* 下次再说 */ } }
// 收掉的技能挪到这里（不参加备份的轮转，不会被自动删）
const RETIRED = path.join(KIT, 'retired');
/**
 * 把一个技能目录整个挪走（同一个盘上改名，要么全挪走、要么一点没动）。挪不走（被占着）返回 ''，原样留着，不删一半。
 * keep 为真时挪进 retired/（留着以后找得回来），不然挪进一个临时目录再删掉
 */
function moveAway(dir, name, keep) {
  fs.mkdirSync(RETIRED, { recursive: true });
  const to = path.join(RETIRED, (keep ? '' : '.trash-') + name + '-' + STAMP);
  try { fs.renameSync(dir, to); } catch (e) { return ''; }
  if (!keep) removeDirQuiet(to);
  return to;
}
/** 目录里所有文件（含子目录里的）的相对路径 */
function listFiles(dir, rel, out) {
  for (const name of fs.readdirSync(path.join(dir, rel))) {
    // Python 自己留的缓存不算技能的内容：有没有它都不算"技能被改过"
    if (name === '__pycache__' || /\.pyc$/i.test(name)) continue;
    const r = rel ? path.join(rel, name) : name;
    const st = fs.statSync(path.join(dir, r));
    if (st.isDirectory()) listFiles(dir, r, out); else if (st.isFile()) out.push(r);
  }
  return out;
}
/** 两个目录里的文件一个不多、一个不少，内容逐字节相同。有一边不存在就算不同 */
function sameDir(a, b) {
  try {
    const fa = listFiles(a, '', []).sort();
    const fb = listFiles(b, '', []).sort();
    return fa.length === fb.length && fa.every((f, i) => f === fb[i] && same(path.join(a, f), path.join(b, f)));
  } catch (e) { return false; }
}
/** 备份到 KIT/backup/<时间>/<sub>，sub 带上相对位置，同名文件不会互相覆盖 */
function backup(target, sub) {
  if (!fs.existsSync(target)) return '';
  const to = path.join(KIT, 'backup', STAMP, sub);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(target).isDirectory()) copyDir(target, to); else copyFile(target, to);
  // 打个标记：轮转时只清安装器自己的备份
  try { fs.writeFileSync(path.join(KIT, 'backup', STAMP, INSTALLER_MARK), ''); } catch (e) { /* 写不了就按内容认 */ }
  pruneBackups();
  return to;
}
// 配置页每保存一次开关都会重新生成全局约定、备份一次，只增不减会越攒越多：安装器的备份按时间只留最近这么多份（这一次的也算一份）
const KEEP_BACKUPS = 20;
// 安装器备份的只有这几样。转码工具 to-utf8 的备份（你项目里的源文件）在 backup/to-utf8/ 下（老版本直接放在 backup/<时间>/ 下），那些不归这里清
const INSTALLER_BACKUP = ['settings.json', 'CLAUDE.md', 'skills', 'agents', 'vibe-kit'];
const INSTALLER_MARK = '.installer';
function isInstallerBackup(dir) {
  try {
    if (fs.existsSync(path.join(dir, INSTALLER_MARK))) return true;
    const names = fs.readdirSync(dir);
    if (!names.length || !names.every((n) => INSTALLER_BACKUP.includes(n))) return false;
    // 老版本没打标记：转码工具的备份也可能恰好叫 CLAUDE.md、settings.json（那是你项目里的文件），看内容认——
    // 安装器备份的是带套件约定块的全局约定、Claude Code 的设置；认不准的留着
    return names.every((n) => {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) return true;
      const t = fs.readFileSync(p, 'utf8');
      return n === 'settings.json' ? /"(hooks|permissions|statusLine|env)"\s*:/.test(t) : t.includes('vibe-kit:begin');
    });
  } catch (e) { return false; }
}
function pruneBackups() {
  const root = path.join(KIT, 'backup');
  let old;
  try { old = fs.readdirSync(root); } catch (e) { return; }
  old = old.filter((d) => d !== STAMP && /^\d{8}-\d{6}$/.test(d) && isInstallerBackup(path.join(root, d))).sort();
  for (const d of old.slice(0, Math.max(0, old.length - (KEEP_BACKUPS - 1)))) removeDirQuiet(path.join(root, d));
}

// ---------- settings.json：开工前先读懂它，读不懂就什么都不动 ----------
const SETTINGS = path.join(CLAUDE, 'settings.json');
function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  let raw = fs.readFileSync(SETTINGS, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return {};
  let s;
  try { s = JSON.parse(raw); } catch (e) { console.log('  [X] ' + SETTINGS + ' 不是合法的 JSON（' + e.message + '）。什么都没动，修好后再运行一次'); process.exit(1); }
  const bad = !isObj(s) || ['hooks', 'permissions', 'env'].some((k) => s[k] !== undefined && !isObj(s[k]));
  if (bad) { console.log('  [X] ' + SETTINGS + ' 的结构不对（顶层或 hooks / permissions / env 不是对象）。什么都没动，修好后再运行一次'); process.exit(1); }
  return s;
}
const MANIFEST = path.join(KIT, 'installed.json');
/**
 * installed.json：allow / ask / env 是自己加进 settings.json、现在还在的（卸载时只收回这些）；
 * known 是装过的各个版本带过的全部条目，不管当时是自己加的还是你本来就有。升级时 known 里有、settings.json 里没有的，是你删掉或挪走的，不再补；
 * router 是这次装没装路由（卸载时只有装了才去停）。老版本写的没有 known 和 router
 */
function readManifest() {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { /* 没装过或者坏了：当成没有 */ }
  if (!isObj(m)) m = {};
  const arr = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string') : []);
  const known = isObj(m.known) ? m.known : {};
  return Object.assign({}, m, { allow: arr(m.allow), ask: arr(m.ask), deny: arr(m.deny), env: isObj(m.env) ? Object.assign({}, m.env) : {}, known: { allow: arr(known.allow), ask: arr(known.ask), deny: arr(known.deny), env: arr(known.env) } });
}
function saveManifest(man) { fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2) + '\n'); }
/**
 * 不许模型读的两处：secrets.json（GitLab 的令牌）、router-data/（配好的模型和 key）。写成 Claude Code 权限规则认的路径：
 * 套件在用户目录下面的写成 ~/…；不在的（CLAUDE_CONFIG_DIR 指到了别处）写成 //盘符/…。
 * 这管的是 Read、Grep、Glob 这些工具；用命令读（cat、Get-Content）由钩子 guard-commit 拦
 */
function secretDenyRules() {
  const posix = (p) => p.split(path.sep).join('/');
  const rel = path.relative(os.homedir(), KIT);
  let base;
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) base = '~/' + posix(rel);
  else { const abs = posix(path.resolve(KIT)); base = '/' + (/^[A-Za-z]:/.test(abs) ? '/' + abs[0].toLowerCase() + abs.slice(2) : abs); }
  return ['Read(' + base + '/secrets.json)', 'Read(' + base + '/router-data/**)'];
}

/** 路由监听的端口（router-data/config.json 里的 listen.port，默认 15730）：HTTP 钩子打到这里 */
function routerPort() {
  try { let t = fs.readFileSync(path.join(KIT, 'router-data', 'config.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); const p = Number((JSON.parse(t).listen || {}).port); return p > 0 && p < 65536 ? Math.round(p) : 15730; } catch (e) { return 15730; }
}
/**
 * 钩子怎么跑（配置页"钩子运行方式"，config.json 的 hookTransport）：
 *   auto（默认）装了路由就走 HTTP，没装走命令；http 固定走 HTTP（没装路由时还是走命令）；command 固定走命令。
 * HTTP：改文件、跑命令、提问框、读文件提醒、收工检查这五个高频钩子由路由在工作线程里跑，不用每次起一个 node 进程（每次省零点几秒）。
 * 会话开始、用户开口两个钩子一直走命令：它们负责把路由拉起来、检查 HTTP 钩子有没有生效（路由不在时 HTTP 钩子一律放行）
 */
function hookTransport() {
  const want = kitConfig().hookTransport;
  if (want === 'command') return 'command';
  // 路由程序得是认得钩子请求的版本（--no-router 时留着的可能是老版本）
  let canHttp = false;
  try { canHttp = fs.readFileSync(path.join(KIT, 'router', 'router.js'), 'utf8').includes('/vibe-kit/hook/') && fs.existsSync(path.join(KIT, 'lib', 'hook-host.js')) && fs.existsSync(path.join(KIT, 'lib', 'hook-worker.js')); } catch (e) { canHttp = false; }
  return canHttp ? 'http' : 'command';
}
const isOurHook = (h) => isObj(h) && (String(h.command || '').includes(HOOK_MARK) || (h.type === 'http' && HOOK_URL.test(String(h.url || ''))));
/**
 * 卸载时替用户点一次"断开"：在配置页点过"接上"的，settings.json 的 ANTHROPIC_BASE_URL 指着这个路由，卸载停了路由，不改回去 Claude Code 就连不上了。
 * 按配置页"接上"时记下的（router-data/claude-link.json）恢复原来的地址，去掉占位的 token。返回说明，没指着这个路由返回空串
 */
const PLACEHOLDER_TOKEN = 'vibe-kit-router';
function unlinkRouter(s) {
  const env = isObj(s.env) ? s.env : null;
  if (!env || !env.ANTHROPIC_BASE_URL) return '';
  const port = routerPort();
  let isRouter = false;
  try { const u = new URL(String(env.ANTHROPIC_BASE_URL)); isRouter = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname.toLowerCase()) && String(u.port || 80) === String(port); } catch (e) { /* 不是网址 */ }
  if (!isRouter) return '';
  const memoFile = path.join(KIT, 'router-data', 'claude-link.json');
  // 不是配置页"接上"改的（没有记录）：可能是你自己配的（比如以前别的路由也用这个端口），不替你改，只提醒
  if (!fs.existsSync(memoFile)) { unlinkRouter.note = 'settings.json 里的 ANTHROPIC_BASE_URL 还指着 ' + env.ANTHROPIC_BASE_URL + '（不是配置页"接上"改的，没动它）。路由停了，Claude Code 会连不上：改回原来的网关地址，或者删掉这一项'; return ''; }
  let memo = {};
  try { memo = JSON.parse(fs.readFileSync(memoFile, 'utf8')) || {}; } catch (e) { /* 读不懂：当原来没有设置 */ }
  const prev = memo.prevBaseUrl ? String(memo.prevBaseUrl) : '';
  if (prev) env.ANTHROPIC_BASE_URL = prev; else delete env.ANTHROPIC_BASE_URL;
  if (env.ANTHROPIC_AUTH_TOKEN === PLACEHOLDER_TOKEN) delete env.ANTHROPIC_AUTH_TOKEN;
  try { fs.unlinkSync(memoFile); } catch (e) { /* 没有 */ }
  return prev ? 'Claude Code 连的地址已恢复成接上路由之前的 ' + prev : 'Claude Code 连路由的设置（ANTHROPIC_BASE_URL）已去掉，接上路由之前没有设置这一项';
}
/**
 * Claude Code 自带的"自动记忆"：模型自己往 ~/.claude/projects/<项目>/memory/ 里记东西，索引每个请求都带着，条数不受套件控制；
 * 它的说明文字也每个请求都占系统提示（实测 2.1.120 占 1.2 万字符，2.1.259 占 2300 字符）。套件有自己的经验规则（lib/lessons.js），
 * 默认把它关掉：在 settings.json 的 env 里写 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1（2.1.120、2.1.259、2.1.283 实测都认）。
 * 这一项跟着配置页的开关走（config.json 的 autoMemory：off 关掉 / on 不管它）：
 *   off：settings.json 里没有就加上，记成自己加的（卸载时收回）；你自己写了别的值就不动
 *   on ：是自己加的就去掉；你自己写的不动
 * 已经记下的记忆文件不删，只是不再加载。要重新打开 Claude Code 才生效。返回 added / removed / kept / user / none
 */
const AUTO_MEMORY_ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
function applyAutoMemory(s, man) {
  const off = kitConfig().autoMemory !== 'on';
  const env = isObj(s.env) ? s.env : {};
  const cur = env[AUTO_MEMORY_ENV];
  const ours = cur !== undefined && man.env[AUTO_MEMORY_ENV] !== undefined && String(cur) === String(man.env[AUTO_MEMORY_ENV]);
  if (off) {
    if (cur === undefined) { env[AUTO_MEMORY_ENV] = '1'; s.env = env; man.env[AUTO_MEMORY_ENV] = '1'; return 'added'; }
    if (ours) return 'kept';
    delete man.env[AUTO_MEMORY_ENV];
    return 'user';
  }
  if (ours) { delete env[AUTO_MEMORY_ENV]; if (Object.keys(env).length) s.env = env; else delete s.env; delete man.env[AUTO_MEMORY_ENV]; return 'removed'; }
  return cur === undefined ? 'none' : 'user';
}
function autoMemoryNote(r) {
  if (r === 'added') console.log('  [OK] Claude Code 自带的"自动记忆"已关掉（套件用经验规则代替它；已经记下的记忆文件没删）。重新打开 Claude Code 后生效；想用回它，在配置页"经验规则"里改');
  else if (r === 'removed') console.log('  [OK] Claude Code 自带的"自动记忆"已恢复。重新打开 Claude Code 后生效');
  else if (r === 'user') console.log('  [!] settings.json 里你自己设了 ' + AUTO_MEMORY_ENV + '，没动它');
}
/**
 * 自动压缩的窗口（config.json 的 autoCompactPercent，默认 90；0 = 不管，照 Claude Code 自己的）。
 * 2.1.259 这类新版本，没设窗口时不按用量自己压缩，要等接口报"请求太长"才补救；内网网关、内网模型的报错它认不出，
 * 上下文一直涨，过了 100% 也不压缩（2026-10-01 用户遇到的，真的 Claude Code 加假模型实测过）。设了之后它在"窗口 − 3.3 万"处压缩。
 * 窗口 = 上下文上限 × 百分比 + 3.3 万，钳到 10 万到 96 万（和 lib/session.js 的 autoCompactWindowOf 一样的算法；为什么最大 96 万见那里）。
 * 写在 settings.json 的 autoCompactWindow（Claude Code 自己的设置，2.1.120、2.1.259 都认）。这一项归配置页管：
 * 在 Claude Code 里用 /autocompact 改过的，下次保存开关、升级时换回配置页算出来的值。
 * 关掉（填 0）、卸载时，只收回自己写的那个值（installed.json 的 autoCompactWindow 记着）；装之前你自己设过的，记在 autoCompactWindowOrig，收回时还给你。
 * 返回 set / kept / removed / none
 */
function autoCompactWindow() {
  const c = kitConfig();
  const p = c.autoCompactPercent === undefined ? 90 : Number(c.autoCompactPercent);
  if (!(p > 0)) return 0;
  const limit = Number(c.contextLimitTokens) > 0 ? Number(c.contextLimitTokens) : 1000000;
  return Math.max(100000, Math.min(960000, Math.round(limit * Math.min(p, 95) / 100) + 33000));
}
function applyAutoCompact(s, man, remove) {
  const want = remove ? 0 : autoCompactWindow();
  const cur = s.autoCompactWindow;
  const ours = man.autoCompactWindow !== undefined && cur === man.autoCompactWindow;
  if (want) {
    if (cur !== undefined && man.autoCompactWindow === undefined && man.autoCompactWindowOrig === undefined) man.autoCompactWindowOrig = cur;
    man.autoCompactWindow = want;
    if (cur === want) return 'kept';
    s.autoCompactWindow = want;
    return 'set';
  }
  delete man.autoCompactWindow;
  const orig = man.autoCompactWindowOrig;
  delete man.autoCompactWindowOrig;
  if (ours) { if (orig !== undefined) s.autoCompactWindow = orig; else delete s.autoCompactWindow; return 'removed'; }
  return 'none';
}
function autoCompactNote(r, s) {
  const w = s && s.autoCompactWindow;
  if (r === 'set') console.log('  [OK] 自动压缩：上下文用到约 ' + Math.round((w - 33000) / 1000) + 'k token 时，Claude Code 自己压缩（settings.json 的 autoCompactWindow=' + w + '）。新开的会话生效；开着的会话在 Claude Code 里敲 /autocompact ' + w + ' 马上生效');
  else if (r === 'removed') console.log(s && s.autoCompactWindow !== undefined ? '  [OK] 自动压缩的窗口换回了你装套件之前设的 ' + s.autoCompactWindow : '  [OK] 自动压缩的窗口去掉了，照 Claude Code 自己的');
  const env = s && isObj(s.env) ? s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW : undefined;
  if (env !== undefined && (r === 'set' || r === 'kept')) console.log('  [!] settings.json 的 env 里你自己设了 CLAUDE_CODE_AUTO_COMPACT_WINDOW=' + env + '，Claude Code 以它为准，配置页的"自动压缩线"不起作用');
}
/**
 * Claude Code 自带的"自动模式"（auto mode，和套件的"全自动模式"是两回事）。2.1.284 起，没配权限模式的会话默认进它：
 * 有风险的命令（node -e、curl 这类）先发给一个分类模型审，系统提示有 14 万字符；经网关用的话每条这样的命令多一次请求、算用量，
 * 分类模型答得不合格式就重试，最多十次，然后把命令拦下（2026-10-05 在 2.1.289 上用假网关实测：套件的端到端测试因此挂了 31 项）。
 * 内网的模型当不了这个分类器，所以套件默认把它关掉：在 settings.json 里写 permissions.disableAutoMode = "disable"
 * （2.1.289 实测：会话照以前的普通模式起，也不再弹"要不要把自动模式设成默认"；2.1.120、2.1.259 不认识这一项，照常用，设置文件不受影响）。
 * 跟着配置页的开关走（config.json 的 ccAutoMode：off 关掉 / on 不管它），规矩和"自动记忆"一样：
 *   off：没有就加上，记成自己加的（installed.json 的 disableAutoMode，卸载时收回）；你自己写了别的值就不动；
 *        你自己把 defaultMode 设成了 auto 的，是你选的，不加，提醒一句
 *   on ：是自己加的就去掉；你自己写的不动
 * 命令行带 --dangerously-skip-permissions、自己配了 defaultMode 的不受影响。返回 added / removed / kept / user / user-auto / none
 */
function applyCcAutoMode(s, man, remove) {
  const off = !remove && kitConfig().ccAutoMode !== 'on';
  const perms = isObj(s.permissions) ? s.permissions : {};
  const cur = perms.disableAutoMode;
  const ours = cur !== undefined && man.disableAutoMode !== undefined && cur === man.disableAutoMode;
  const drop = () => { delete perms.disableAutoMode; if (Object.keys(perms).length) s.permissions = perms; else delete s.permissions; delete man.disableAutoMode; };
  if (off) {
    if (perms.defaultMode === 'auto') { if (ours) drop(); else delete man.disableAutoMode; return 'user-auto'; }
    if (cur === undefined) { perms.disableAutoMode = 'disable'; s.permissions = perms; man.disableAutoMode = 'disable'; return 'added'; }
    if (ours) return 'kept';
    delete man.disableAutoMode;
    return 'user';
  }
  if (ours) { drop(); return 'removed'; }
  delete man.disableAutoMode;
  return cur === undefined ? 'none' : 'user';
}
function ccAutoModeNote(r) {
  if (r === 'added') console.log('  [OK] Claude Code 自带的"自动模式"已关掉（2.1.284 起没配权限模式时默认进它：有风险的命令先发给分类模型审，经网关每条多一次大请求，内网的模型当不了这个分类器）。会话照以前的普通模式起；想用它，在配置页"保护"里改。重新打开 Claude Code 后生效');
  else if (r === 'removed') console.log('  [OK] 不再关着 Claude Code 自带的"自动模式"，照 Claude Code 自己的默认。重新打开 Claude Code 后生效');
  else if (r === 'user-auto') console.log('  [!] settings.json 里你自己把 permissions.defaultMode 设成了 auto，没动它。提醒：经网关用自动模式，有风险的命令每条多一次带 14 万字符系统提示的请求；分类模型答得不合格式，命令会被拦下');
}
/** hooksOnly：只重新登记钩子（--sync 时用），不碰状态栏、权限；跟着配置页的开关走的三项照样管："自动记忆"那一项环境变量、自动压缩的窗口、关掉 Claude Code 自带的自动模式 */
function mergeSettings(s, remove, hooksOnly) {
  const before = JSON.stringify(s);
  const kitPath = (rel) => path.join(KIT, rel).split(path.sep).join('/');
  const hook = (file) => ({ type: 'command', command: 'node "' + kitPath('hooks/' + file) + '"' });
  const transport = hookTransport();
  const port = routerPort();
  const fast = (name) => (transport === 'http' ? { type: 'http', url: 'http://127.0.0.1:' + port + '/vibe-kit/hook/' + name } : hook(name + '.js'));
  const OURS = {
    // 改文件的三个检查（套件文件不许改、编码保护、OpenSpec 门槛）合成一个入口 pre-edit：一次编辑只起一个进程（或只发一次请求）
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [fast('pre-edit')] }, { matcher: 'Bash|PowerShell', hooks: [fast('guard-commit')] }, { matcher: 'AskUserQuestion|Skill|SlashCommand', hooks: [fast('guard-ask')] },
      // 搜文件内容：范围里有放令牌、放模型 key 的地方就拦（权限规则管不到"对着上级目录搜"）
      { matcher: 'Grep', hooks: [fast('guard-read')] }],
    // 读文件时提醒（提示规则）2026-09-30 去掉了，不再登记；这一项留着空的，是为了把以前登记过的摘掉
    PostToolUse: [],
    // 用户开口的钩子，Claude Code 默认只等 30 秒（官方文档：UserPromptSubmit 上命令钩子的默认超时从 600 秒降到了 30 秒），到点就结束它、丢掉输出。
    // 开工前拉代码在这个钩子里：连远端最多 15 秒，合并做到一半又不能被结束（会留下 index.lock 和改了一半的工作区），所以写明等 300 秒
    UserPromptSubmit: [{ hooks: [Object.assign(hook('task-anchor.js'), { timeout: 300 })] }],
    SessionStart: [{ hooks: [hook('session-start.js')] }],
    Stop: [{ hooks: [fast('verify-gate')] }],
  };
  // 钩子：先把自己以前加的摘掉（按单个钩子摘，不连累同一组里别人的钩子；命令方式、HTTP 方式的都认），再加新的。重复安装不会越加越多
  s.hooks = s.hooks || {};
  for (const ev of Object.keys(OURS)) {
    const groups = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    const kept = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const rest = g.hooks.filter((h) => !isOurHook(h));
      if (rest.length) kept.push(Object.assign({}, g, { hooks: rest }));
    }
    s.hooks[ev] = remove ? kept : kept.concat(OURS[ev]);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (!remove) mergeSettings.transport = transport;
  if (hooksOnly) {
    // --sync（配置页保存开关时走这里）：自动记忆的开关也跟着走
    const man0 = readManifest();
    const am = applyAutoMemory(s, man0);
    const ac = applyAutoCompact(s, man0, false);
    const manBefore = JSON.stringify(man0.disableAutoMode);
    const cm = applyCcAutoMode(s, man0, false);
    if (JSON.stringify(s) !== before) { backup(SETTINGS, 'settings.json'); fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n'); console.log('  [OK] settings.json 里的钩子' + (am === 'added' || am === 'removed' ? '、自动记忆的设置' : '') + (ac === 'set' || ac === 'removed' ? '、自动压缩的窗口' : '') + (cm === 'added' || cm === 'removed' ? '、Claude Code 自带的自动模式' : '') + '已更新'); }
    if (am === 'added' || am === 'removed' || ac !== 'kept' || manBefore !== JSON.stringify(man0.disableAutoMode)) { try { saveManifest(man0); } catch (e) { /* 记不了：卸载时这一项就留着 */ } }
    if (am === 'added' || am === 'removed') autoMemoryNote(am);
    autoCompactNote(ac, s);
    if (cm === 'added' || cm === 'removed') ccAutoModeNote(cm);
    return null;
  }

  // 状态栏：你已经配过别的就不动
  const mine = isObj(s.statusLine) && String(s.statusLine.command || '').includes('vibe-kit/statusline.js');
  if (remove) { if (mine) delete s.statusLine; }
  // refreshInterval：没有新消息的时候也 30 秒刷新一次（今天的用量、全自动开没开，在配置页改了也跟着变）
  else if (!s.statusLine || mine) s.statusLine = { type: 'command', command: 'node "' + kitPath('statusline.js') + '"', refreshInterval: 30 };
  else console.log('  [!] 你已经配了别的状态栏，没有覆盖。想用这个，把 settings.json 里的 statusLine 删掉再装一次');

  const man = readManifest();
  if (!remove) {
    const frag = JSON.parse(fs.readFileSync(path.join(FROM_PACKAGE ? SRC : KIT, 'settings.fragment.json'), 'utf8'));
    const union = (a, b) => a.concat(b.filter((x) => !a.includes(x)));
    const perms = isObj(s.permissions) ? s.permissions : {};
    const listed = (x) => ['allow', 'ask', 'deny'].some((k) => Array.isArray(perms[k]) && perms[k].includes(x));
    for (const k of ['allow', 'ask']) {
      const want = (isObj(frag.permissions) && Array.isArray(frag.permissions[k])) ? frag.permissions[k] : [];
      const have = Array.isArray(perms[k]) ? perms[k] : [];
      // 以前装过的条目现在不在了，是你删掉或挪走的（比如把 push 的确认挪到了 deny），不再补；已经写在别的列表里的也不加。只加新版新增的
      const add = want.filter((x) => !have.includes(x) && !man.known[k].includes(x) && !man[k].includes(x) && !listed(x));
      if (add.length) { perms[k] = have.concat(add); s.permissions = perms; }
      // "自己加的"只算现在还在的：你删掉之后又自己加回来的归你，卸载时不收
      man[k] = man[k].filter((x) => have.includes(x)).concat(add);
      man.known[k] = union(man.known[k], want);
    }
    // 令牌和模型的 key 不给模型读。规矩和上面一样：你删掉的不再补，卸载时只收回自己加的
    {
      const want = secretDenyRules();
      const have = Array.isArray(perms.deny) ? perms.deny : [];
      const add = want.filter((x) => !have.includes(x) && !man.known.deny.includes(x) && !man.deny.includes(x));
      if (add.length) { perms.deny = have.concat(add); s.permissions = perms; }
      man.deny = man.deny.filter((x) => have.includes(x)).concat(add);
      man.known.deny = union(man.known.deny, want);
    }
    const fragEnv = isObj(frag.env) ? frag.env : {};
    for (const k of Object.keys(fragEnv)) {
      const env = isObj(s.env) ? s.env : {};
      if (env[k] !== undefined) continue;
      // 装过、现在没了：是你删的，不补，也不再算自己加的
      if (man.known.env.includes(k) || man.env[k] !== undefined) { delete man.env[k]; continue; }
      env[k] = fragEnv[k]; s.env = env; man.env[k] = fragEnv[k];
    }
    man.known.env = union(man.known.env, Object.keys(fragEnv));
    mergeSettings.autoMemory = applyAutoMemory(s, man);
    mergeSettings.autoCompact = applyAutoCompact(s, man, false);
    mergeSettings.ccAutoMode = applyCcAutoMode(s, man, false);
  } else {
    // 路由要停了：先把 Claude Code 连路由的设置改回去
    mergeSettings.unlinked = unlinkRouter(s);
    // 只收回清单里记着是自己加的；env 只在值没被你改过时才删。
    // 令牌（secrets.json）和模型的 key（router-data）卸载时留着不删：那两条"不许读"的规则也留着，不然卸完之后 Read、Grep 就能读到它们
    const secretsLeft = ['secrets.json', 'router-data'].some((n) => fs.existsSync(path.join(KIT, n)));
    const keepDeny = secretsLeft ? secretDenyRules() : [];
    for (const k of ['allow', 'ask', 'deny']) {
      if (s.permissions && Array.isArray(s.permissions[k])) {
        s.permissions[k] = s.permissions[k].filter((x) => !man[k].includes(x) || (k === 'deny' && keepDeny.includes(x)));
        if (!s.permissions[k].length) delete s.permissions[k];
      }
    }
    mergeSettings.keptDeny = keepDeny.filter((x) => s.permissions && Array.isArray(s.permissions.deny) && s.permissions.deny.includes(x));
    applyCcAutoMode(s, man, true);
    if (s.permissions && !Object.keys(s.permissions).length) delete s.permissions;
    for (const k of Object.keys(man.env)) if (s.env && s.env[k] === man.env[k]) delete s.env[k];
    if (s.env && !Object.keys(s.env).length) delete s.env;
    applyAutoCompact(s, man, true);
  }
  if (JSON.stringify(s) !== before) {
    const bak = backup(SETTINGS, 'settings.json');
    fs.mkdirSync(CLAUDE, { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    console.log('  [OK] settings.json 已更新' + (bak ? '（原文件备份在 ' + bak + '）' : ''));
  }
  return man;
}

// ---------- 全局约定：基础约定 + 启用的规范，写进 CLAUDE.md 的标记块 ----------
/** 本机环境（local.json，在路由配置页里填，或者手改）→ 全局约定里的一节。每台机器不一样，所以不放进任何仓库 */
function localSection() {
  let l;
  try { let t = fs.readFileSync(path.join(KIT, 'local.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); l = JSON.parse(t); } catch (e) { return ''; }
  const pairs = (a) => (Array.isArray(a) ? a : []).filter((p) => p && p.name && p.path);
  const lines = [];
  const jdks = pairs(l.jdks);
  for (const j of jdks) lines.push('- JDK ' + j.name + '：`' + j.path + '`' + (l.defaultJdk && String(l.defaultJdk) === String(j.name) ? '（没有特别说明时用这个）' : ''));
  if (jdks.length > 1) lines.push('- 换 JDK 跑命令：只在那一条命令前面设 JAVA_HOME 和 PATH（Git Bash：`JAVA_HOME="<目录>" PATH="<目录>/bin:$PATH" mvn …`），不要改系统环境变量');
  // Maven 可以有好几套；上一版只有一套，存在 maven 里
  let mavens = (Array.isArray(l.mavens) ? l.mavens : []).filter((m) => m && m.name && (m.home || m.settings || m.repo));
  if (!mavens.length && isObj(l.maven) && (l.maven.home || l.maven.settings || l.maven.repo)) mavens = [Object.assign({ name: '默认' }, l.maven)];
  for (const m of mavens) {
    const mv = [m.home && '安装目录 `' + m.home + '`', m.settings && 'settings.xml `' + m.settings + '`', m.repo && '本地仓库 `' + m.repo + '`'].filter(Boolean);
    lines.push('- Maven ' + m.name + '：' + mv.join('；') + (mavens.length > 1 && l.defaultMaven && String(l.defaultMaven) === String(m.name) ? '（没有特别说明时用这一套）' : ''));
  }
  if (mavens.length) lines.push('- 用某一套 Maven 跑命令：`"<安装目录>/bin/mvn" -s "<settings.xml>" "-Dmaven.repo.local=<本地仓库>" …`；那一套里没填的项就不带对应的参数，没填安装目录就直接用 `mvn`');
  for (const t of pairs(l.tomcats)) lines.push('- Tomcat ' + t.name + '：`' + t.path + '`');
  if (l.notes && String(l.notes).trim()) lines.push('- 其他：' + String(l.notes).trim().split(/\r?\n/).join('；'));
  if (!lines.length) return '';
  return '## 本机环境\n\n这台机器上的开发环境，是我配好的。要用 JDK、Maven、Tomcat 时直接用这里的路径，不要满硬盘找；这里没有的再问我。项目说明（.vibe/project.md）里写了用哪个版本的，以项目说明为准。\n\n' + lines.join('\n');
}
/** 提交规范里"什么时候提交"那一句，跟着配置页的开关走（config.json 的 autoCommit）。改了开关要重新生成全局约定，配置页保存时会自动做 */
const AUTO_COMMIT_TEXT = {
  task: '- 一项任务（最小的一件事）完成了就直接提交，不用等我说。"完成"的标准有两条：验证过（快检过了，该看的页面看过了）；提交前自己把这一项的 diff 过了一遍（git diff -- <这一项改的文件>：有没有调试代码、误改、漏改、和这项任务无关的改动）。做了一半的、验证没过的不要提交。\n- 换个模型审代码（/ttls-cross-review 的代码模式）不是每项任务都做：整个变更的任务全部完成之后审一次（提案在 apply 之前另审一次）；审出来的问题修掉并验证过，再单独提交一次（类型用 fix）。',
  phase: '- 不走提案的小改动：做完、验证过（快检过了，该看的页面看过了）、自己把 diff 过了一遍，就直接提交，不用等我说。OpenSpec 的变更按阶段提交：tasks.md 里同一个大编号的任务（1.x、2.x……）全部完成、验证过，就把这一组的改动提交一次，信息写这一组做了什么（例：feat: 订单导出的数据层）；一组做到一半不提交。最后一组做完、换个模型审过代码之后，审出来的问题修掉并验证过，再单独提交一次（类型用 fix）。做了一半的、验证没过的不要提交。',
  change: '- 不走提案的小改动：做完、验证过、自己把 diff 过了一遍，就直接提交，不用等我说。OpenSpec 的变更：全部任务做完、交叉审查过之后提交一次，中途不提交。做了一半的、验证没过的不要提交。',
  off: '- 我让你提交时才提交。',
};
/** 约定里"页面用 /ttls-see-page 看一眼"那一句，跟着"改了页面文件没看页面 → 拦一次"的开关走（config.json 的 autoSeePage）。关掉 = 不自动起服务看页面，用户让看时再看 */
const SEE_PAGE_TEXT = {
  on: '，页面用 /ttls-see-page 看一眼',
  off: '。页面的改动不用自己起服务去看，我让你看的时候再用 /ttls-see-page；没看就明说没验证',
};
/** OpenSpec 规范里讲页面验证的两处，也跟着"看页面"开关走 */
const SEE_PAGE_SPEC_TEXT = {
  on: '规格里的"当……则……"场景，凡是能在页面上看到结果的，用 /ttls-see-page 照着跑一遍；结果在接口返回里的，写成接口场景（request + expectJson）跑。',
  off: '页面上的结果不用自己起服务去看：页面任务的验法写"验：人工看页面"，做完交代时说明页面没看、等我看。结果在接口返回里的，写成 /ttls-see-page 的接口场景（request + expectJson，不开浏览器）跑。',
};
const PAGE_VERIFY_TEXT = { on: '<命令或 /ttls-see-page 场景>', off: '<命令>（页面上的写"人工看页面"）' };
/** OpenSpec 规范里的"提交节奏"，跟着自动提交开关走（和提交规范那一节说的一致） */
const COMMIT_RHYTHM_TEXT = {
  task: '提案写好提交一次 `docs: 提案 <名字>`；apply 每完成一项任务提交一次（代码和打勾的 tasks.md 不在一个仓库时各提各的）；修订：改过的产物和 revisions.md 一起 `docs: 修订 <名字>：<一句话原因>`；归档连同 plan.md `docs: 归档 <名字>`。',
  phase: '提案写好提交一次 `docs: 提案 <名字>`；写 tasks.md 时把任务按阶段分组（大编号一组：数据层、接口、页面……，一组三五项）；apply 按阶段提交：一组的任务全部打勾时提交一次（代码和打勾的 tasks.md 不在一个仓库时各提各的），一组做到一半不提交；修订：改过的产物和 revisions.md 一起 `docs: 修订 <名字>：<一句话原因>`；归档连同 plan.md `docs: 归档 <名字>`。',
  change: '提案写好提交一次 `docs: 提案 <名字>`；apply 中途不提交，全部任务做完、审过代码之后，代码和打勾的 tasks.md 各在自己的仓库提交一次；修订：改过的产物和 revisions.md 一起 `docs: 修订 <名字>：<一句话原因>`；归档连同 plan.md `docs: 归档 <名字>`。',
  off: '我让你提交时才提交（提案、代码、修订、归档都一样），提交信息照这个写：`docs: 提案 <名字>`、`docs: 修订 <名字>：<一句话原因>`、`docs: 归档 <名字>`。',
};
function kitConfig() {
  try { let t = fs.readFileSync(path.join(KIT, 'config.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t) || {}; } catch (e) { return {}; }
}
function autoCommitMode() { const m = kitConfig().autoCommit; return AUTO_COMMIT_TEXT[m] ? m : 'task'; }
function seePageMode() { return kitConfig().autoSeePage === false ? 'off' : 'on'; }
/** OpenSpec 规范里"审几轮"那一句，跟着"多轮审查"的开关走（reviewLoop / reviewMaxRounds）；全自动模式下轮数用完自己定 */
function reviewModeText() {
  const c = kitConfig();
  if (!c.reviewLoop) return '每种各审一轮，审过就不再跑；审出的问题逐条核实，成立的改掉并验证，不成立的在 revisions.md 记一句为什么。';
  const n = Math.min(5, Math.max(1, Number(c.reviewMaxRounds) || 3));
  return '多轮审查开着：每一轮审出问题并改了之后，再让 ttls-reviewer 审改动点（只给它上一轮的问题清单和这次改过的文件），直到它报"结论：问题 0 条"，最多 ' + n + ' 轮；问题核实下来全都不成立的，在 revisions.md 逐条记下理由就算处理完。' + n + ' 轮之后仍有问题，' + (c.autoMode ? '按"全自动模式"一节的原则自己定。' : '停下来用提问框问我怎么办，不要自己定。');
}
/** 全自动模式（autoMode）开着时，OpenSpec 规范末尾多出的一节 */
const AUTO_MODE_TEXT = [
  '### 全自动模式（已开）',
  '',
  '这一节只管走 OpenSpec 流程的时候：我敲了 /opsx:…、提了要走提案的需求、让你接着做某个变更、让你接着交接记录做。这时我不在，这一节和前面的约定、技能里的说法有出入的，以这一节为准：前面凡是写"问我""用提问框问""停下来告诉我""让我来定""等我"的地方，都照下面的做。',
  '',
  '别的时候（我问问题、让你检索、跑别的技能）我在，这一节不作数：照前面的约定来，做完我交代的那件事就收工。工作区里有没做完的变更，不是你自己去接着做、去开工的理由。',
  '',
  '- 不问我，不等我。提问框用不了（会被拦下，你想问的会记进报告）。缺信息：能查的查（代码、库、接口、日志、文档）；查不到的选影响面最小的做法，记进 revisions.md（起因：自动模式决定）。',
  '- 进入 OpenSpec 的流程后一路做完：探索 → 提案 → 审提案 → apply（每项任务：做 → 跑验法 → 打勾 → 提交）→ 审代码 → 归档。收工钩子每一步会催你往下走。',
  '- 改库不用等我确认：照 /ttls-db-crud 的两步走，第一步看清影响面，没问题就带确认串执行。它只做留得下备份的（改、删留改前快照和还原脚本，新增记下表和主键，建表、加列记下对应的 DROP），执行完把它打印的留痕目录写进交代；它说备份不了、不执行的（没有 WHERE、没有主键、删表、清空……），不要绕，留给我。',
  '- 要我动手的事不做，也不等：查库的工具不肯执行的改库操作、改 redis 里的数据、改公共配置、动 git 历史、push、要账号密码、钩子说要我定的非 UTF-8 文件。在那项任务后面加上"（留给用户：原因）"，不打勾，接着做不依赖它的任务。一个变更只剩这种任务时，它不归档，做下一个；都做完了就收工。',
  '- 验证：能验的都要验。验法里有现在验不了的部分（要我先动手、要我看页面）：把那一部分写成"……本次不做（原因）"，能验的照样跑，跑过了再打勾。/ttls-see-page 的场景文件做不了的操作，写一个探针脚本放 .vibe/tmp/<变更名>/ 里跑，它算验过。',
  '- 过程文件（.vibe/tmp、.vibe/out 里的脚本、草稿、结果）在流程走完之前都留着，不要删：变更归档之后套件自己清。',
  '- 被检查拦下：照提示能改的先改。改不了、条件现在满足不了的，照提示末尾的命令申请放行，再做一次那一步，不用等我；确信是套件判断错了，命令末尾加 --bug。提示里没带拦截编号的（改套件、读令牌、结束路由进程、非 UTF-8 文件、整仓 add）不能放行：这一步不做，换个做法，或者留给我。',
  '- 同一个问题换了三种办法还不通：这一项先放下，接着做别的，写进最后的交代。',
  '- 多轮审查用完轮数仍有问题：选影响面最小的方案，宁可少做一个边角功能也不能破坏现有功能；不用 hack 绕过验证、不注释掉测试、不放宽校验；定了的方案验证过再提交；结论和理由记进 revisions.md。',
  '- 不要自己开新的变更、不要顺手做需求之外的事。',
  '- 代码之外的产出（DDL 脚本、说明文档、分析报告）：项目说明的"产出位置"里有的照着放；没有的先放 .vibe/pending/。',
  '{{AUTO_HANDOVER}}',
  '- 收工时套件会给你这一轮的报告（放行了什么、你想问没问成的、留给我做的、库里改过的、没验证的），照它写最后的交代，分七节：做了什么、留给你做的、库里改过的、自己定的事、没验证的、放行的检查、套件问题。',
].join('\n');
/** 全自动模式里"到交接线怎么办"那一句，跟着"全自动模式下到交接线自动写交接记录"的开关走（autoHandover） */
const AUTO_HANDOVER_TEXT = {
  on: '- 上下文到交接线：先 /ttls-handover 写交接记录，写完接着做手头的事，不要收工、不要停下等我；快到网关上限才停下。',
  off: '- 上下文到交接线：不用写交接记录，接着做（靠 Claude Code 自己的压缩）；快到网关上限才停下。',
};
/** 全自动模式开着时，约定最前面的一句：后面哪些话不作数 */
const AUTO_TOP_TEXT = '> 全自动模式开着：走 OpenSpec 流程的时候（我敲了 /opsx:…、提了要走提案的需求、让你接着做某个变更）我不在，下面凡是写"问我""用提问框问""停下来告诉我""让我来定""等我"的地方，都照最后"全自动模式（已开）"一节做。别的时候我在，照常来。';
/** 约定和规范里的占位符换成按开关生成的文字 */
function fill(text) {
  const c = kitConfig();
  const see = seePageMode();
  let commit = AUTO_COMMIT_TEXT[autoCommitMode()];
  if (see === 'off') commit = commit.split('（快检过了，该看的页面看过了）').join('（快检过了）');
  const auto = c.autoMode ? AUTO_MODE_TEXT.split('{{AUTO_HANDOVER}}').join(AUTO_HANDOVER_TEXT[c.autoHandover === false ? 'off' : 'on']) : '';
  return text.split('{{AUTO_COMMIT}}').join(commit).split('{{SEE_PAGE}}').join(SEE_PAGE_TEXT[see])
    .split('{{SEE_PAGE_SPEC}}').join(SEE_PAGE_SPEC_TEXT[see]).split('{{PAGE_VERIFY}}').join(PAGE_VERIFY_TEXT[see])
    .split('{{COMMIT_RHYTHM}}').join(COMMIT_RHYTHM_TEXT[autoCommitMode()])
    .split('{{REVIEW_MODE}}').join(reviewModeText()).split('{{AUTO_MODE}}').join(auto)
    .split('{{AUTO_TOP}}').join(c.autoMode ? AUTO_TOP_TEXT : '').replace(/\n{3,}/g, '\n\n').trim();
}
function buildBlock() {
  const base = fill(fs.readFileSync(path.join(KIT, 'CLAUDE.md'), 'utf8').trim());
  const rulesDir = path.join(KIT, 'rules');
  const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => /\.md$/i.test(f) && !f.startsWith('_')).sort() : [];
  const parts = [base].concat(rules.map((f) => fill(fs.readFileSync(path.join(rulesDir, f), 'utf8').trim())));
  const local = localSection();
  if (local) parts.push(local);
  return { text: BEGIN + '\n' + parts.join('\n\n') + '\n' + END + '\n', rules };
}
const GLOBAL_MD = path.join(CLAUDE, 'CLAUDE.md');
/**
 * 全局 CLAUDE.md 按 UTF-8 严格解码（开头的 BOM 会去掉）。解不开的返回 { text: null, lines: 出问题的行号 }：
 * 多半是用 cmd 的 echo 往里追加过中文（那是 GBK），按 UTF-8 读再写回会把这些中文全变成替换字符，而且恢复不了
 */
function readGlobalMd() {
  if (!fs.existsSync(GLOBAL_MD)) return { text: '' };
  const buf = fs.readFileSync(GLOBAL_MD);
  const utf8 = (b) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return null; } };
  const text = utf8(buf);
  if (text !== null) return { text };
  const lines = [];
  for (let i = 0, start = 0, no = 1; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    if (utf8(buf.subarray(start, i)) === null) lines.push(no);
    start = i + 1; no++;
  }
  return { text: null, lines };
}
/** 全局 CLAUDE.md 不是 UTF-8：说清楚是哪几行、怎么转、现在是什么状态 */
function explainNotUtf8(state) {
  const lines = readGlobalMd().lines || [];
  const tool = FROM_PACKAGE ? path.join(SRC, 'kit', 'tools', 'to-utf8.js') : path.join(KIT, 'tools', 'to-utf8.js');
  console.log('  [X] ' + GLOBAL_MD + ' 不是 UTF-8 编码' + (lines.length ? '（第 ' + lines.slice(0, 10).join('、') + (lines.length > 10 ? ' 等' : '') + ' 行）' : '') + '，多半是用 cmd 的 echo 往里追加过中文。按 UTF-8 读再写回，这些中文会全变成乱码而且恢复不了，所以没有写它。');
  console.log('      先把它转成 UTF-8：用记事本打开，上面这几行显示不对的中文重新输入一遍，再"另存为"、编码选 UTF-8；整个文件都是 GBK 的，也可以运行 node "' + tool + '" "' + GLOBAL_MD + '" 一次转好。');
  console.log('      ' + state);
}
/** 标记必须顶格独占一行才算数。第一个块原地替换，多余的块删掉，一个都没有才追加到末尾；块外的内容一个字不动。文件不是 UTF-8 就什么都不写，返回 null */
function writeGlobalMd(block) {
  const file = GLOBAL_MD;
  const cur = readGlobalMd().text;
  if (cur === null) return null;
  let n = 0;
  let next = cur.replace(BLOCK_RE, () => ((n++ === 0 && block !== null) ? block : ''));
  if (n === 0 && block !== null) next = cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (cur.trim() ? '\n' : '') + block;
  if (next === cur) return false;
  backup(file, 'CLAUDE.md');
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

// ---------- 主流程 ----------
console.log('');
console.log('vibe-kit：' + (mode === 'install' ? '安装 / 更新' : mode === 'sync' ? '重新生成全局约定' : '卸载') + '  →  ' + CLAUDE);
if (mode === 'install') {
  const verOf = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim(); } catch (e) { return ''; } };
  const pkg = verOf(path.join(SRC, 'kit', 'VERSION'));
  const had = verOf(path.join(KIT, 'VERSION'));
  console.log('  这个安装包的版本：' + (pkg || '（没有版本号）') + (had ? (had === pkg ? '（和现在装着的一样，重装一遍）' : '；现在装着的是 ' + had) : (fs.existsSync(path.join(KIT, 'installed.json')) ? '；现在装着的那一版没有版本号' : '；这台电脑还没装过')));
}

if (mode === 'uninstall') {
  const s = readSettings();
  if (readGlobalMd().text === null) { explainNotUtf8('卸载没做：什么都没动，套件还装着、照常工作。转好之后再运行一次卸载。'); process.exit(1); }
  const man = readManifest();
  writeGlobalMd(null);
  mergeSettings(s, true);
  for (const n of SKILLS) {
    const d = path.join(CLAUDE, 'skills', n);
    if (!fs.existsSync(d)) continue;
    // 逐个文件和装进去的原样比：改过任何一个文件、自己加过文件（比如配方），或者是你自己的同名技能，先整目录备份再删
    if (!sameDir(d, path.join(KIT, 'pristine', 'skills', n))) console.log('  [!] 技能 ' + n + ' 被改过，删除前备份在 ' + backup(d, 'skills/' + n));
    if (!moveAway(d, n, false)) removeDir(d);
  }
  for (const n of AGENTS) {
    const f = path.join(CLAUDE, 'agents', n);
    if (!fs.existsSync(f)) continue;
    if (!same(f, path.join(KIT, 'pristine', 'agents', n))) console.log('  [!] 审查代理 ' + n + ' 被改过，删除前备份在 ' + backup(f, 'agents/' + n));
    fs.unlinkSync(f);
  }
  // 从改名之前的版本直接卸载：旧名字的技能也是套件装的，一起收回
  removeOldNames();
  const finish = () => {
    // 基础约定你改过（和装进去的原样不一样）：删之前先备份
    const kitMd = path.join(KIT, 'CLAUDE.md');
    if (fs.existsSync(kitMd) && !same(kitMd, path.join(KIT, 'pristine', 'CLAUDE.md'))) console.log('  [!] 你改过 ' + kitMd + '，删除前备份在 ' + backup(kitMd, 'vibe-kit/CLAUDE.md'));
    // results：老版本看页面的执行器没写 --out 时把结果放在这里
    // update：自动更新从仓库拉下来的暂存处和日志
    for (const n of ['page', 'hooks', 'tools', 'lib', 'router', 'state', 'pristine', 'results', 'update', '.ignore', 'statusline.js', 'CLAUDE.md', 'installed.json', 'settings.fragment.json', 'VERSION', 'install.js']) removeDir(path.join(KIT, n));
    console.log('  [OK] 已卸载：约定块、钩子、状态栏、技能，以及安装时加的权限和环境变量都收回了。');
    if (mergeSettings.unlinked) console.log('  [OK] 在配置页点过"接上"：' + mergeSettings.unlinked + '（替你点了一次"断开"）。');
    if (unlinkRouter.note && hadRouter) console.log('  [!] ' + unlinkRouter.note + '。');
    console.log('  留着没删的：你自己的规范文件、本机环境（local.json）、开关（config.json）、数据库驱动（drivers、drivers.json）、路由的数据（router-data，里面有配好的模型和 key）、问题反馈（feedback）、跨项目的经验记录（lessons）、GitLab 的仓库地址和令牌（gitlab.json、secrets.json）、以前单独装的技能（retired）和备份，都在 ' + KIT);
    if (['secrets.json', 'router-data'].some((n) => fs.existsSync(path.join(KIT, n)))) {
      console.log('  [!] 令牌（secrets.json）和模型的 key（router-data）还在，套件卸了之后它们不再受保护：挡命令读取的钩子已经没了。'
        + (mergeSettings.keptDeny && mergeSettings.keptDeny.length ? 'settings.json 里那两条"不许读"的规则留着（挡 Read、Grep 工具）。' : '')
        + '不再用这台电脑上的套件了，就把这两处删掉：' + path.join(KIT, 'secrets.json') + '、' + path.join(KIT, 'router-data'));
    }
    // 经验规则是你攒下来的，Claude Code 自己会加载它们，和套件装没装无关：留着
    try { const rd = path.join(CLAUDE, 'rules'); const n = fs.readdirSync(rd).filter((f) => /^(ttls|vibe)-lessons-.*\.md$/i.test(f)).length; if (n) console.log('  用户级的经验规则也留着（' + rd + ' 里的 ttls-lessons-*.md，' + n + ' 个文件）：Claude Code 自己会按文件类型加载，不想要就手动删掉。各个项目里的 .claude/rules/ttls-lessons-*.md 跟着仓库走，没有动'); } catch (e) { /* 没有规则目录 */ }
    process.exit(0);
  };
  // 路由：装的时候装了（installed.json 里 router: true；老版本没记，就看程序目录在不在）才去停、取消登录后自动启动，而且只停这一份安装自己的
  const hadRouter = man.router === true || (man.router === undefined && fs.existsSync(path.join(KIT, 'router', 'service.js')));
  if (!hadRouter) finish();
  else {
    stopOwnRouter(man.router === true).then((r) => {
      if (r.error) console.log('  [!] 停路由时出错：' + r.error);
      else console.log('  [OK] 模型路由' + (r.stopped ? '已停止' : r.foreign ? '没有停：端口 ' + r.port + ' 上在跑的不是这一份安装的路由' : r.unsure ? '没有停：认不出端口 ' + r.port + ' 上在跑的是不是这一份安装的路由' : '本来没在运行') + (r.autostartRemoved ? '，登录后自动启动已取消' : ''));
    }).catch((e) => console.log('  [!] 停路由时出错：' + (e && e.message))).then(finish);
  }
}

/**
 * 改名之前的技能和代理：是套件装的（上次安装留的原样里有它）就删掉，你改过的先备份；不是套件装的（你自己的同名技能）不动。
 * 要在换掉"上次安装的原样"（pristine）之前调：靠它认是不是套件装的
 */
function removeOldNames() {
  const gone = [];
  for (const n of OLD_SKILLS) {
    const d = path.join(CLAUDE, 'skills', n);
    if (!fs.existsSync(d)) continue;
    const was = path.join(KIT, 'pristine', 'skills', n);
    if (!fs.existsSync(was)) { console.log('  [!] ' + d + ' 不是套件装的（你自己的同名技能），没有动它。套件的这个技能现在叫 ttls-' + n); continue; }
    if (!sameDir(d, was)) console.log('  [!] 旧技能 ' + n + ' 被改过，删除前备份在 ' + backup(d, 'skills/' + n));
    // 整个目录一步挪走再删：删到一半被占着的话，留下的半截目录 Claude Code 还会列出来
    if (!moveAway(d, n, false)) { console.log('  [!] ' + d + ' 被别的程序占着，这次没删掉（下次装的时候再删）'); continue; }
    gone.push('/' + n + ' → /ttls-' + n);
  }
  for (const n of OLD_AGENTS) {
    const f = path.join(CLAUDE, 'agents', n);
    if (!fs.existsSync(f)) continue;
    const was = path.join(KIT, 'pristine', 'agents', n);
    if (!fs.existsSync(was)) { console.log('  [!] ' + f + ' 不是套件装的，没有动它。套件的审查代理现在叫 ttls-reviewer'); continue; }
    if (!same(f, was)) console.log('  [!] 旧的审查代理 ' + n + ' 被改过，删除前备份在 ' + backup(f, 'agents/' + n));
    fs.unlinkSync(f);
    gone.push(n.replace(/\.md$/, '') + ' → ttls-reviewer');
  }
  return gone;
}
/**
 * 并进套件之前单独装的技能（urai-db-crud、redis）：整个目录挪进 vibe-kit/retired/（不参加备份的轮转，不会被自动删）。
 * urai-db-crud 自带的驱动先挪进套件的驱动目录并登记：不然升级完就连不上库了（这一版起驱动不随包带）。
 * 只收一次：收过之后用户又装回来的（installed.json 的 absorbed 里记着），是用户要的，不再收，只提一句
 */
function removeAbsorbed(man) {
  const out = [];
  const done = isObj(man.absorbed) ? man.absorbed : {};
  for (const x of ABSORBED) {
    const d = path.join(CLAUDE, 'skills', x.name);
    if (!fs.existsSync(d)) continue;
    let mine = false;
    try { mine = x.is(d); } catch (e) { mine = false; }
    if (!mine) { console.log('  [!] ' + d + ' 认不出是以前的 ' + x.name + ' 技能，没有动它'); continue; }
    if (done[x.name]) { console.log('  [!] 以前单独装的 ' + x.name + ' 技能又装回来了（上次已经并进套件，叫 ' + x.now + '）。这次没有动它；不要了就删掉 ' + d); continue; }
    let moved = [];
    if (x.drivers) {
      try { moved = require(path.join(KIT, 'lib', 'drivers.js')).rescueFrom(d); } catch (e) { console.log('  [!] 旧技能自带的驱动没挪成（' + ((e && e.message) || e) + '）。旧技能整个留在 ' + RETIRED + ' 里，驱动在它的 drivers 目录下，可以在配置页"数据库驱动"里选'); }
    }
    const to = moveAway(d, x.name, true);
    if (!to) { console.log('  [!] ' + d + ' 被别的程序占着，这次没挪走（下次装的时候再挪）'); continue; }
    done[x.name] = { at: Date.now(), to };
    out.push({ name: x.name, now: x.now, backup: to, drivers: moved });
  }
  man.absorbed = done;
  return out;
}

if (mode === 'install') {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) { console.log('  [X] Node 版本太低（' + process.versions.node + '），需要 18 以上'); process.exit(1); }
  for (const dep of ['pixelmatch', 'pngjs', 'playwright', 'playwright-core']) {
    if (!fs.existsSync(path.join(SRC, 'kit', 'page', 'node_modules', dep))) { console.log('  [X] 安装包不完整：缺 kit/page/node_modules/' + dep + '。重新拷一份完整的包'); process.exit(1); }
  }
  const s = readSettings();
  // 全局 CLAUDE.md 不是 UTF-8：和 settings.json 读不懂一样，什么都不动。装一半、约定写不进去，比不装还乱
  if (readGlobalMd().text === null) { explainNotUtf8(fs.existsSync(MANIFEST) ? '这次什么都没动：现在装着的还是之前那一版，照常工作。转好之后再运行一次安装。' : '这次什么都没动，套件还没装上。转好之后再运行一次安装。'); process.exit(1); }
  fs.mkdirSync(KIT, { recursive: true });
  // 版本号（VERSION）最后写：装到一半被结束（关机、注销）的话，版本号还是旧的，自动更新下次会接着重装；
  // 先写的话，技能、约定、钩子登记都还是旧的，却已经显示"已是最新"，一直到下一版
  copyDir(path.join(SRC, 'kit'), KIT, ['VERSION']);
  for (const f of ['install.js', 'settings.fragment.json']) copyFile(path.join(SRC, f), path.join(KIT, f));
  // 路由的程序目录整个换新（数据在 router-data，不在这里），免得留下上一版的旧文件。
  // --no-router 不拷、不动：以前装过的路由原样留着（Claude Code 可能正连着它，删了就用不了），照常运行
  if (!NO_ROUTER && fs.existsSync(path.join(SRC, 'router'))) { removeDir(path.join(KIT, 'router')); copyDir(path.join(SRC, 'router'), path.join(KIT, 'router')); }
  if (NO_ROUTER && fs.existsSync(path.join(KIT, 'router', 'service.js'))) {
    console.log('  [!] --no-router：以前装的模型路由没有更新，原样留着、照常运行（' + path.join(KIT, 'router') + '）。不想要它了，先在配置页点"断开"，再运行卸载');
    console.log('      配置页也还是旧的：这一版新加的开关、"数据库驱动"那一页要等路由更新之后才有；在旧配置页上保存开关，新加的几个开关会回到默认值');
  }
  // 套件代码的指纹：会话开始时比一遍，被改过的告诉模型和你、记一条问题反馈（算法和 kit/lib/session.js 的 kitCodeHashes 一样）
  {
    const files = {};
    const add = (rel) => { try { files[rel] = require('crypto').createHash('sha1').update(fs.readFileSync(path.join(KIT, rel))).digest('hex'); } catch (e) { /* 读不了 */ } };
    for (const d of ['hooks', 'lib', 'tools', 'page']) { let es = []; try { es = fs.readdirSync(path.join(KIT, d), { withFileTypes: true }); } catch (e) { continue; } for (const e of es) if (e.isFile() && /\.js$/i.test(e.name)) add(d + '/' + e.name); }
    if (fs.existsSync(path.join(KIT, 'statusline.js'))) add('statusline.js');
    fs.mkdirSync(path.join(KIT, 'state'), { recursive: true });
    fs.writeFileSync(path.join(KIT, 'state', 'kit-hash.json'), JSON.stringify({ files, at: Date.now() }));
    try { fs.unlinkSync(path.join(KIT, 'state', 'kit-drift.json')); } catch (e) { /* 没有 */ }
  }
  const cfgFile = path.join(KIT, 'config.json');
  // 默认开关只写在 kit/lib/session.js 一处（配置页后端 router/kit-api.js 里的那份由测试核对是不是一样）
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify(require(path.join(SRC, 'kit', 'lib', 'session.js')).DEFAULT_CONFIG, null, 2) + '\n');
  // "维护套件的电脑"2026-10-01 起写死在代码里（kit/lib/gitlab.js），不再是开关：老版本写进 config.json 的那一项去掉，别人打开文件也看不到
  else {
    try {
      const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
      if (cur && typeof cur === 'object' && cur.maintainerHosts !== undefined) { delete cur.maintainerHosts; fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n'); }
    } catch (e) { /* 读不懂就不动：配置页保存一次也会去掉 */ }
  }
  // 问题上报从什么时候算起：头一回装上带问题上报的版本的这一刻，以前攒下的不传（20260929 起去掉了存量推送）。
  // 不在这里记的话要等第一次上报时才记，装好之后、第一次上报之前记的问题会被当成"以前攒下的"，永远传不上去
  const issueStore = path.join(KIT, 'feedback', 'issues.json');
  if (!fs.existsSync(issueStore)) { try { fs.mkdirSync(path.dirname(issueStore), { recursive: true }); fs.writeFileSync(issueStore, JSON.stringify({ since: Math.floor(Date.now() / 1000) * 1000, map: {} })); } catch (e) { /* 记不了：第一次上报时再记 */ } }
  // 封条（三个放松保护的开关只认配置页、安装器改的，见 kit/lib/session.js 的 readConfig）：还没有的，按现在文件里的记一份——
  // 以前在配置页关掉过禁改的，升级后照旧；已经有封条的不动
  const sealFile = path.join(KIT, 'state', 'config-seal.json');
  if (!fs.existsSync(sealFile)) {
    try { const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); fs.mkdirSync(path.dirname(sealFile), { recursive: true }); fs.writeFileSync(sealFile, JSON.stringify({ kitLock: cur.kitLock !== false, kitBypass: ['ask', 'auto', 'off'].includes(cur.kitBypass) ? cur.kitBypass : 'ask', autoMode: cur.autoMode === true, at: Date.now() })); } catch (e) { /* 记不了就按安全的值算 */ }
  } else {
    // 老版本的封条里没有全自动模式这一项：按现在文件里的补上（以前在配置页打开过的，升级后照旧）
    try {
      const seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
      if (seal && seal.autoMode === undefined) { const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); seal.autoMode = cur.autoMode === true; fs.writeFileSync(sealFile, JSON.stringify(seal)); }
    } catch (e) { /* 补不了就认文件里的 */ }
  }
  // 基础约定：你改过装进去的那份，就先备份再覆盖
  const kitMd = path.join(KIT, 'CLAUDE.md');
  if (fs.existsSync(kitMd) && !same(kitMd, path.join(SRC, 'claude', 'CLAUDE.md')) && !same(kitMd, path.join(KIT, 'pristine', 'CLAUDE.md'))) console.log('  [!] 你改过 ' + kitMd + '，覆盖前备份在 ' + backup(kitMd, 'vibe-kit/CLAUDE.md'));
  copyFile(path.join(SRC, 'claude', 'CLAUDE.md'), kitMd);
  // 规范：你自己加的文件不动；你启用了的模板不会被空模板盖回来；你加下划线停用的也不会被重新拷回来
  const rulesDst = path.join(KIT, 'rules');
  fs.mkdirSync(rulesDst, { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'claude', 'rules'))) {
    const twin = f.startsWith('_') ? f.slice(1) : '_' + f;
    const twinPath = path.join(rulesDst, twin);
    if (fs.existsSync(twinPath)) {
      // 同名的另一种状态已经在了：是你自己启用、停用或改过的就尊重它；只是上一版装进去、你没碰过的模板，就换成这一版
      if (!same(twinPath, path.join(KIT, 'pristine', 'rules', twin))) continue;
      fs.unlinkSync(twinPath);
    }
    const d = path.join(rulesDst, f);
    if (fs.existsSync(d) && !same(d, path.join(SRC, 'claude', 'rules', f)) && !same(d, path.join(KIT, 'pristine', 'rules', f))) console.log('  [!] 你改过规范 ' + f + '，覆盖前备份在 ' + backup(d, 'vibe-kit/rules/' + f));
    copyFile(path.join(SRC, 'claude', 'rules', f), d);
  }
  // 技能和代理：已有同名的而且内容不同（你自己的或改过的），先备份。技能目录逐个文件比，
  // 和这一版、和上次装的原样（pristine）都对不上（改过任何一个文件、加了自己的配方都算），就整目录备份
  for (const n of SKILLS) {
    const d = path.join(CLAUDE, 'skills', n);
    if (fs.existsSync(d) && !sameDir(d, path.join(SRC, 'claude', 'skills', n)) && !sameDir(d, path.join(KIT, 'pristine', 'skills', n))) console.log('  [!] 已有同名技能 ' + n + '（你自己的，或者改过里面的文件），原目录备份在 ' + backup(d, 'skills/' + n));
    // 整个目录一步挪走再换新的：删到一半被占着，会留下新旧混在一起的半截目录
    if (fs.existsSync(d) && !moveAway(d, n, false)) removeDir(d);
    copyDir(path.join(SRC, 'claude', 'skills', n), d);
  }
  fs.mkdirSync(path.join(CLAUDE, 'agents'), { recursive: true });
  for (const n of AGENTS) {
    const d = path.join(CLAUDE, 'agents', n);
    if (fs.existsSync(d) && !same(d, path.join(SRC, 'claude', 'agents', n)) && !same(d, path.join(KIT, 'pristine', 'agents', n))) console.log('  [!] 已有同名代理 ' + n + '，原文件备份在 ' + backup(d, 'agents/' + n));
    copyFile(path.join(SRC, 'claude', 'agents', n), d);
  }
  // 改名之前的、并进来之前单独装的：删掉。要在换掉 pristine 之前做
  const renamed = removeOldNames();
  const man0 = readManifest();
  const absorbed = removeAbsorbed(man0);
  // 留一份原样的副本，下次更新和卸载时用来判断你有没有改过
  removeDir(path.join(KIT, 'pristine'));
  copyDir(path.join(SRC, 'claude'), path.join(KIT, 'pristine'));
  console.log('  [OK] 技能：' + SKILLS.map((n) => '/' + n).join('  ') + '；审查代理：ttls-reviewer');
  if (renamed.length) console.log('  [OK] 技能和代理改名了（加了 ttls- 前缀，免得和别的套件撞名）：' + renamed.join('，') + '。旧名字的已经删掉');
  for (const a of absorbed) {
    console.log('  [OK] 以前单独装的 ' + a.name + ' 技能并进套件了，现在叫 ' + a.now + '。旧的挪到了 ' + a.backup + '（不会被自动删）');
    if (a.drivers.length) console.log('       它自带的驱动挪到了套件的驱动目录并登记好：' + a.drivers.map((u) => u.name + ' ' + path.basename(u.jar)).join('、'));
  }
  const man = mergeSettings(s, false);
  console.log('  [OK] 钩子：编码保护、提交检查、令牌保护、打断后提醒、会话开始带上项目说明和交接记录、收工检查'
    + (mergeSettings.transport === 'http' ? '。改文件、跑命令、收工这几个检查在模型路由里跑（HTTP 方式，不用每次起进程）' : ''));
  autoMemoryNote(mergeSettings.autoMemory);
  autoCompactNote(mergeSettings.autoCompact, s);
  ccAutoModeNote(mergeSettings.ccAutoMode);
  // 这一份安装里有没有路由程序（这次装的，或者 --no-router 时以前装的还留着）：卸载时有才去停
  man.router = fs.existsSync(path.join(KIT, 'router', 'service.js'));
  man.absorbed = man0.absorbed;
  saveManifest(man);
  // 都装好了，最后写版本号
  copyFile(path.join(SRC, 'kit', 'VERSION'), path.join(KIT, 'VERSION'));
}

/** 模型路由：用刚拷进去的新文件在后台重新启动，设好登录后自动启动，再自己验证一遍配置页打得开 */
function httpGet(url) {
  return new Promise((resolve) => {
    const r = require('http').get(url, { timeout: 3000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('timeout', () => r.destroy());
    r.on('error', () => resolve({ status: 0, body: '' }));
  });
}
function openInBrowser(url) {
  try {
    const { spawn } = require('child_process');
    const sys32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
    const cmdExe = fs.existsSync(path.join(sys32, 'cmd.exe')) ? path.join(sys32, 'cmd.exe') : 'cmd';
    const c = process.platform === 'win32' ? spawn(cmdExe, ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch (e) { /* 打不开就让用户自己开 */ }
}
/** 两个路径是不是同一个文件：按真实路径比，目录联接、大小写不同都算同一个 */
function samePath(a, b) {
  const real = (p) => { const d = path.dirname(path.resolve(p)); let r = d; try { r = fs.realpathSync.native(d); } catch (e) { /* 不存在就按原样比 */ } return path.join(r, path.basename(p)); };
  const x = real(a);
  const y = real(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
/**
 * 停这一份安装自己的路由，取消它的登录后自动启动。端口按它 router-data 里的配置；还要确认端口上那个路由用的正是这份配置
 * （/api/state 里的 configPath）：别的安装（另一个用户目录、测试目录）的路由就算在同一个端口上也不停。
 * trusted：installed.json 明确记着装了路由，端口上的路由认不出是谁的（没有 configPath）时也停
 */
async function stopOwnRouter(trusted) {
  const out = { stopped: false, foreign: false, unsure: false, autostartRemoved: false, port: 0, error: '' };
  const svcFile = path.join(KIT, 'router', 'service.js');
  if (!fs.existsSync(svcFile)) return out;
  let svc;
  try { svc = require(svcFile); } catch (e) { out.error = '读不了 ' + svcFile + '：' + e.message; return out; }
  out.port = typeof svc.portOf === 'function' ? svc.portOf() : 15730;
  const st = await httpGet('http://127.0.0.1:' + out.port + '/api/state');
  if (st.status) {
    let cfg = '';
    try { cfg = String(JSON.parse(st.body).configPath || ''); } catch (e) { /* 认不出 */ }
    const mine = cfg ? samePath(cfg, path.join(KIT, 'router-data', 'config.json')) : trusted;
    if (!mine) { if (cfg) out.foreign = true; else out.unsure = true; }
    else {
      const r = await svc.stop();
      if (!r || !r.ok) { out.error = (r && r.reason) || ('停不掉端口 ' + out.port + ' 上的路由'); return out; }
      out.stopped = !!r.wasRunning;
    }
  }
  try { out.autostartRemoved = !!svc.disableAutostart().removed; } catch (e) { /* 取消不了就算了 */ }
  return out;
}
async function setupRouter(svc) {
  // 上一版安装包把路由装在 ~/.claude/model-router。在那里配过模型的话搬过来，别让人白填一遍
  const oldDir = path.join(CLAUDE, 'model-router');
  try {
    if (fs.existsSync(path.join(oldDir, 'config.json')) && !fs.existsSync(svc.CONFIG)) { fs.mkdirSync(svc.DATA_DIR, { recursive: true }); copyFile(path.join(oldDir, 'config.json'), svc.CONFIG); console.log('  [OK] 上一版装在 ' + oldDir + ' 的路由配置已经搬到 ' + svc.DATA_DIR); }
    const oldJs = path.join(oldDir, 'router.js');
    if (fs.existsSync(oldJs) && /const VERSION = '3\./.test(fs.readFileSync(oldJs, 'utf8'))) console.log('  [!] ' + oldDir + ' 是上一版安装包留下的，现在不用了，可以整个删掉');
  } catch (e) { /* 搬不了就让用户在配置页里重新填 */ }
  await svc.stop();
  const r = await svc.start();
  if (!r.ok) { console.log('  [X] 模型路由没启动：' + r.reason); return; }
  const base = 'http://127.0.0.1:' + r.port;
  const page = await httpGet(base + '/ui');
  if (page.status === 200 && page.body.includes('模型路由')) console.log('  [OK] 模型路由 v' + r.version + ' 已在后台运行，没有窗口。配置页（已验证能打开）：' + base + '/ui');
  else console.log('  [X] 路由起来了，但配置页打不开（' + base + '/ui 返回 ' + page.status + '）。看 ' + path.join(svc.DATA_DIR, 'router.out.log'));
  // 上次装的时候设好了登录后自动启动、现在"启动"文件夹里那个文件却没了：是用户删的，记下来，不再加回来
  const man = readManifest();
  if (man.autostart === true && typeof svc.autostartOn === 'function' && !svc.autostartOn() && typeof svc.refuseAutostart === 'function') svc.refuseAutostart('"启动"文件夹里的 vibe-kit-router.vbs 被删掉了');
  const a = svc.enableAutostart();
  console.log(a.ok ? '  [OK] 登录后自动在后台启动，同样没有窗口（' + a.file + '）'
    : a.refused ? '  [OK] ' + a.reason + '。不要紧：打开 Claude Code 时发现路由没在跑，会悄悄把它拉起来'
      : '  [!] 没能设置登录后自动启动：' + a.reason + '。不要紧：打开 Claude Code 时发现路由没在跑，会悄悄把它拉起来');
  try { man.autostart = !!a.ok; saveManifest(man); } catch (e) { /* 记不下：下次按没设过算 */ }
  let usable = 0;
  try { usable = (JSON.parse((await httpGet(base + '/health')).body).providers || []).length; } catch (e) { /* 当成没有 */ }
  if (!usable) {
    console.log('  还没有配模型。两步：① 在配置页"添加模型"（网关地址和 key）；② 点页面最上面的"接上"，让 Claude Code 走这个路由。');
    if (!process.argv.includes('--no-open')) { openInBrowser(base + '/ui'); console.log('  配置页已经帮你在浏览器里打开了。'); }
  }
}

function finishInstall() {
if (!fs.existsSync(path.join(KIT, 'CLAUDE.md'))) { console.log('  [X] 还没安装过。到安装包目录里运行 node install.js'); process.exit(1); }
// --sync（配置页保存开关、本机环境也走这里）：全局 CLAUDE.md 不是 UTF-8 就什么都不动
if (mode === 'sync' && readGlobalMd().text === null) { explainNotUtf8('这次什么都没动：开关和本机环境已经存下了，但全局约定和钩子登记还是上次生成的，套件其余部分照常工作。转好之后运行 node "' + path.join(KIT, 'install.js') + '" --sync。'); process.exit(1); }
const block = buildBlock();
const changed = writeGlobalMd(block.text);
if (changed === null) { explainNotUtf8('全局约定没写进去；其余部分（钩子、技能、审查代理、状态栏、权限）都已经就位。转好之后运行 node "' + path.join(KIT, 'install.js') + '" --sync 补上。'); process.exitCode = 1; }
else console.log('  [OK] 全局约定' + (changed ? '已写入' : '没有变化') + '；启用的规范：' + (block.rules.length ? block.rules.join('，') : '（无）'));
// 钩子跑的方式（HTTP / 命令）、自动记忆的开关改了之后，settings.json 里的登记要跟着变
if (mode === 'sync') mergeSettings(readSettings(), false, true);
const tail = () => {
  console.log('');
  console.log('  加规范、改约定：改 ' + KIT + ' 里的 CLAUDE.md 或 rules/*.md（文件名不以下划线开头的才生效），再运行 node "' + path.join(KIT, 'install.js') + '" --sync');
  console.log('  已经开着的 Claude Code 不用重开，也不用 /clear：钩子立刻生效；约定和技能变了的部分，在你下一次发消息时由钩子带给它。');
};
const svcFile = path.join(KIT, 'router', 'service.js');
if (mode !== 'install' || NO_ROUTER || !fs.existsSync(svcFile)) return tail();
setupRouter(require(svcFile)).catch((e) => console.log('  [X] 模型路由没装好：' + ((e && e.message) || e))).then(tail);
}
if (mode !== 'uninstall') finishInstall();

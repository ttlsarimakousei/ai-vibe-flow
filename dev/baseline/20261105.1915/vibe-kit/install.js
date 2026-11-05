'use strict';
/*
 * vibe-kit 安装脚本：约定、规范、技能、审查代理、钩子、状态栏、看页面的执行器，装进 ~/.claude。
 *   node install.js             安装或更新（从安装包目录运行）。以前装过模型路由的，手动安装装完当场收回（lib/router-retire.js）；
 *                               自动更新时等新代码第一次跑 session-start 再收：自检不过装回旧版时路由还在
 *   node install.js --sync      只根据 ~/.claude/vibe-kit 里的约定、规范、你的补充（user/）和本机环境（local.json）重新生成全局约定
 *   node install.js --uninstall 卸载（你自己加的规范文件和备份会留着）
 * 原则：先检查后动手，settings.json 读不懂、全局 CLAUDE.md 不是 UTF-8，就什么都不动；只添加不删改；要覆盖你改过的东西之前先备份（只留最近 20 份），
 * 覆盖过的在配置页提示一次；你自己的约定和规范放 vibe-kit/user/，从不覆盖，以前直接改过套件约定、规范的，升级时挪进去（F8）；
 * 装了什么记在 installed.json 里，卸载时只收回自己加的；你删掉的权限和环境变量，升级时不再补回来。
 * 目录复制是自己写的递归：Node 22 自带的递归 cpSync 碰到带中文的路径会直接崩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = __dirname;
const FROM_PACKAGE = fs.existsSync(path.join(SRC, 'claude')) && fs.existsSync(path.join(SRC, 'kit'));
// 从安装包运行：装进 CLAUDE_CONFIG_DIR 或 ~/.claude。装进去的那份（~/.claude/vibe-kit/install.js）：用户目录就是它上一层，
// 不看环境变量——配置页保存时调它，配置页的环境变量和用户开 Claude Code 的终端可能不一样
const CLAUDE = FROM_PACKAGE ? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) : path.dirname(SRC);
const KIT = path.join(CLAUDE, 'vibe-kit');
// 新版删掉了的套件文件（相对 vibe-kit 目录）：装新版时把旧版留下的删掉。2026-10-28：IDEA 起服务、合并推送整条去掉；2026-11-03：路由、IDEA MCP
const DROPPED_FILES = ['lib/idea-run.js', 'lib/merge-push.js', 'tools/merge-push.js', 'lib/idea-mcp.js', 'lib/idea-tools.js', 'lib/hook-host.js', 'lib/hook-worker.js', 'lib/hook-health.js', 'lib/router-smoke.js'];
const BEGIN = '<!-- vibe-kit:begin 这两行标记之间的内容是生成的。自己的约定写在 ~/.claude/vibe-kit/user/ 里的 .md（更新不碰），然后运行 node ~/.claude/vibe-kit/install.js --sync -->';
const END = '<!-- vibe-kit:end -->';
const BLOCK_RE = /^<!-- vibe-kit:begin[^\n]*-->\r?\n[\s\S]*?^<!-- vibe-kit:end -->[ \t]*\r?\n?/gm;
const SKILLS = ['vk-onboard', 'vk-see-page', 'vk-cross-review', 'vk-handover', 'vk-db-crud', 'vk-redis'];
const AGENTS = ['vk-reviewer.md'];
/** 一个目录里套件的斜杠命令文件（vk-*.md）；目录不在返回空 */
function kitCommands(dir) { try { return fs.readdirSync(dir).filter((f) => /^vk-[\w-]+\.md$/i.test(f)).sort(); } catch (e) { return []; } }
// 改名之前套件自己装的：装这一版时删掉。没前缀的（名字太普通，会和别人的套件撞，0929 改的）；ttls- 开头的（2026-11-04 改成 vk-，仓库主人定的）
const OLD_SKILLS = ['onboard', 'see-page', 'cross-review', 'handover', 'ttls-onboard', 'ttls-see-page', 'ttls-cross-review', 'ttls-handover', 'ttls-db-crud', 'ttls-redis'];
const OLD_AGENTS = ['vibe-reviewer.md', 'ttls-reviewer.md'];
/** 旧名字现在叫什么：去掉旧前缀，加上 vk- */
const nowName = (n) => 'vk-' + String(n).replace(/^ttls-/, '').replace(/^vibe-/, '').replace(/\.md$/, '');
// 并进套件之前单独装的技能：认得出是它才收。urai-db-crud 自带的驱动先挪进套件的驱动目录
const skillName = (d) => { try { return (/^name:\s*(\S+)\s*$/m.exec(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8')) || [])[1] || ''; } catch (e) { return ''; } };
const isDbCrud = (d) => (fs.existsSync(path.join(d, 'scripts', 'db.py')) && fs.existsSync(path.join(d, 'scripts', 'sqlguard.py'))) || /^(urai-)?db-crud$/.test(skillName(d));
const ABSORBED = [
  { name: 'urai-db-crud', now: 'vk-db-crud', is: isDbCrud, drivers: true },
  { name: 'db-crud', now: 'vk-db-crud', is: isDbCrud, drivers: true },
  // 名字叫 redis 的技能别人也可能有：SKILL.md 里的名字是 redis、带着那个直连客户端的才算
  { name: 'redis', now: 'vk-redis', is: (d) => skillName(d) === 'redis' && (fs.existsSync(path.join(d, 'assets', 'redis-client.js')) || /redis-client\.js/.test((() => { try { return fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'); } catch (e) { return ''; } })())) },
];
const HOOK_MARK = 'vibe-kit/hooks/';
// 老版本走 HTTP 的钩子登记成这个地址：升级时认出来摘掉
const HOOK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/vibe-kit\/hook\//i;
let mode = process.argv.includes('--uninstall') ? 'uninstall' : (process.argv.includes('--sync') ? 'sync' : 'install');
// 装进去的那份 install.js 旁边没有安装包，不带参数运行就当成 --sync
if (mode === 'install' && !FROM_PACKAGE) mode = 'sync';
// 退出码（自动更新 lib/updater.js 照着它判断）：1 装到一半出错；
// REFUSED 什么都没动（settings.json 读不懂、全局约定不是 UTF-8、Node 太老）：装回上一版也没用，不算装坏（审核 P43）
const REFUSED = 4;

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
/** 先写临时文件再改名（审核 P03）：两次 --sync 重叠、写到一半断电，settings.json、全局 CLAUDE.md 不会只剩半截 */
function writeAtomic(file, text) {
  // 是符号链接的（有人把 settings.json 链到别处统一管）：写穿链接，不改名（改名会把链接换成普通文件，复审 U-R15）
  try { if (fs.lstatSync(file).isSymbolicLink()) { fs.writeFileSync(file, text); return; } } catch (e) { /* 还没有这个文件 */ }
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.writeFileSync(file, text); } finally { try { fs.unlinkSync(tmp); } catch (x) { /* 已经没了 */ } } }
}
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
  try { s = JSON.parse(raw); } catch (e) { console.log('  [X] ' + SETTINGS + ' 不是合法的 JSON（' + e.message + '）。什么都没动，修好后再运行一次'); process.exit(REFUSED); }
  const bad = !isObj(s) || ['hooks', 'permissions', 'env'].some((k) => s[k] !== undefined && !isObj(s[k]));
  if (bad) { console.log('  [X] ' + SETTINGS + ' 的结构不对（顶层或 hooks / permissions / env 不是对象）。什么都没动，修好后再运行一次'); process.exit(REFUSED); }
  return s;
}
const MANIFEST = path.join(KIT, 'installed.json');
// 这台电脑以前没装过：装完留个记号，第一个会话说一次怎么用（K3 M05）。升级的不说
const FIRST_INSTALL = !fs.existsSync(MANIFEST);
/**
 * installed.json：allow / ask / env 是自己加进 settings.json、现在还在的（卸载时只收回这些）；
 * known 是装过的各个版本带过的全部条目，不管当时是自己加的还是你本来就有。升级时 known 里有、settings.json 里没有的，是你删掉或挪走的，不再补；
 * router 恒为假（路由 2026-11-03 删了）：装回旧版时旧的安装器读它，不把路由装回来。老版本写的没有 known 和 router
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

const isOurHook = (h) => isObj(h) && (String(h.command || '').includes(HOOK_MARK) || (h.type === 'http' && HOOK_URL.test(String(h.url || ''))));
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
 * 自动压缩的窗口（config.json 的 autoCompactPercent，默认 70；0 = 不管，照 Claude Code 自己的）。
 * 2.1.259 这类新版本，没设窗口时不按用量自己压缩，要等接口报"请求太长"才补救；内网网关、内网模型的报错它认不出，
 * 上下文一直涨，过了 100% 也不压缩（2026-10-01 用户遇到的，真的 Claude Code 加假模型实测过）。设了之后它在"窗口 − 3.3 万"处压缩。
 * 窗口 = 上下文上限 × 百分比 + 3.3 万，钳到 10 万到 96 万（2.1.259 实测窗口设到 97.7 万以上，还没压缩就先报 Prompt is too long）。
 * 写在 settings.json 的 autoCompactWindow（Claude Code 自己的设置，2.1.120、2.1.259 都认）。这一项归配置页管：
 * 在 Claude Code 里用 /autocompact 改过的，下次保存开关、升级时换回配置页算出来的值。
 * 关掉（填 0）、卸载时，只收回自己写的那个值（installed.json 的 autoCompactWindow 记着）；装之前你自己设过的，记在 autoCompactWindowOrig，收回时还给你。
 * 返回 set / kept / removed / none
 */
function autoCompactWindow() {
  const c = kitConfig();
  const p = c.autoCompactPercent === undefined ? 70 : Number(c.autoCompactPercent);
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
/**
 * 系统里（Windows 的用户级、机器级环境变量，注册表里存着的那份）设的值，没设返回 ''。不看 process.env：自动更新可能是 Claude Code
 * 的钩子拉起来的，那时的环境变量里已经是 settings.json 的值了。测试用 VIBE_KIT_SYSTEM_<名字> 顶替，不碰真的注册表
 */
function systemEnv(name) {
  const over = process.env['VIBE_KIT_SYSTEM_' + name];
  if (over !== undefined) return over;
  if (process.platform !== 'win32') return '';
  const reg = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
  // reg.exe 按控制台代码页输出（中文系统是 GBK）
  const decode = (b) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { try { return new TextDecoder('gbk').decode(b); } catch (x) { return ''; } } };
  // 用户级的同名变量盖过机器级的，所以先看用户级
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const r = require('child_process').spawnSync(fs.existsSync(reg) ? reg : 'reg', ['query', key, '/v', name], { windowsHide: true, timeout: 10000 });
      if (r.status !== 0 || !r.stdout) continue;
      const m = new RegExp('^\\s*' + name + '\\s+REG_(EXPAND_)?SZ\\s*(.*?)\\s*$', 'mi').exec(decode(r.stdout));
      if (m) return m[1] ? m[2].replace(/%([^%]+)%/g, (x, k) => (process.env[k] !== undefined ? process.env[k] : x)) : m[2];
    } catch (e) { /* 读不了就当没设 */ }
  }
  return '';
}
/** 系统的 JAVA_TOOL_OPTIONS 加上套件要的几项：-Dxxx= 这种同名的系统里已经写了的不加（你的设置为准） */
function javaToolOptions(sys, kit) {
  const s = String(sys || '').trim();
  if (!s) return kit;
  const have = new Set(s.split(/\s+/).map((t) => t.split('=')[0]));
  const add = String(kit).split(/\s+/).filter((t) => t && !have.has(t.split('=')[0]));
  return add.length ? s + ' ' + add.join(' ') : s;
}
/** hooksOnly：只重新登记钩子（--sync 时用），不碰状态栏、权限；跟着配置页的开关走的三项照样管："自动记忆"那一项环境变量、自动压缩的窗口、关掉 Claude Code 自带的自动模式 */
function mergeSettings(s, remove, hooksOnly) {
  const before = JSON.stringify(s);
  const kitPath = (rel) => path.join(KIT, rel).split(path.sep).join('/');
  const hook = (file) => ({ type: 'command', command: 'node "' + kitPath('hooks/' + file) + '"' });
  const fast = (name) => hook(name + '.js');
  const OURS = {
    // 改文件的三个检查（套件文件不许改、编码保护、OpenSpec 门槛）合成一个入口 pre-edit：一次编辑只起一个进程（或只发一次请求）
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [fast('pre-edit')] }, { matcher: 'Bash|PowerShell|mcp__.*', hooks: [fast('guard-commit')] }, { matcher: 'AskUserQuestion|Skill|SlashCommand|Agent|Task', hooks: [fast('guard-ask')] },
      // 搜文件内容：范围里有放令牌、放模型 key 的地方就拦（权限规则管不到"对着上级目录搜"）
      { matcher: 'Grep', hooks: [fast('guard-read')] }],
    // 读文件时提醒（提示规则）2026-09-30 去掉了。以前这里还有一个空的 PostToolUse 键，被下面那个同名键盖掉、从来没起作用（审核 P07），删了：
    // 以前登记过的读文件提醒照样摘得掉，靠的是登记时按套件的钩子文件名整个替换
    // 用户开口的钩子，Claude Code 默认只等 30 秒（官方文档：UserPromptSubmit 上命令钩子的默认超时从 600 秒降到了 30 秒），到点就结束它、丢掉输出。
    // 开工前拉代码在这个钩子里：连远端最多 15 秒，合并做到一半又不能被结束（会留下 index.lock 和改了一半的工作区），所以写明等 300 秒
    UserPromptSubmit: [{ hooks: [Object.assign(hook('task-anchor.js'), { timeout: 300 })] }],
    SessionStart: [{ hooks: [hook('session-start.js')] }],
    PostToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write|MultiEdit', hooks: [fast('after-tool')] }],
    PostToolUseFailure: [{ matcher: 'Bash|PowerShell', hooks: [fast('after-tool')] }],
    Stop: [{ hooks: [fast('verify-gate')] }],
    SubagentStop: [{ hooks: [fast('review-stop')] }],
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
  if (hooksOnly) {
    // --sync（配置页保存开关时走这里）：自动记忆的开关也跟着走
    const man0 = readManifest();
    const am = applyAutoMemory(s, man0);
    const ac = applyAutoCompact(s, man0, false);
    const manBefore = JSON.stringify(man0.disableAutoMode);
    const cm = applyCcAutoMode(s, man0, false);
    if (JSON.stringify(s) !== before) { backup(SETTINGS, 'settings.json'); writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n'); console.log('  [OK] settings.json 里的钩子' + (am === 'added' || am === 'removed' ? '、自动记忆的设置' : '') + (ac === 'set' || ac === 'removed' ? '、自动压缩的窗口' : '') + (cm === 'added' || cm === 'removed' ? '、Claude Code 自带的自动模式' : '') + '已更新'); }
    if (am === 'added' || am === 'removed' || ac !== 'kept' || manBefore !== JSON.stringify(man0.disableAutoMode)) { try { saveManifest(man0); } catch (e) { /* 记不了：卸载时这一项就留着 */ } }
    if (am === 'added' || am === 'removed') autoMemoryNote(am);
    autoCompactNote(ac, s);
    if (cm === 'added' || cm === 'removed') ccAutoModeNote(cm);
    return null;
  }

  // 状态栏：你已经配过别的就不动
  const mine = isObj(s.statusLine) && String(s.statusLine.command || '').includes('vibe-kit/statusline.js');
  if (remove) { if (mine) delete s.statusLine; }
  // refreshInterval：没有新消息的时候也 10 秒刷新一次（步骤条、自动开没开，实测 2.1.120、2.1.289 都准）
  else if (!s.statusLine || mine) s.statusLine = { type: 'command', command: 'node "' + kitPath('statusline.js') + '"', refreshInterval: 10 };
  else console.log('  [!] 你已经配了别的状态栏，没有覆盖。想用这个，把 settings.json 里的 statusLine 删掉再装一次');

  const man = readManifest();
  if (!remove) {
    const frag = JSON.parse(fs.readFileSync(path.join(FROM_PACKAGE ? SRC : KIT, 'settings.fragment.json'), 'utf8'));
    const union = (a, b) => a.concat(b.filter((x) => !a.includes(x)));
    const perms = isObj(s.permissions) ? s.permissions : {};
    const listed = (x) => ['allow', 'ask', 'deny'].some((k) => Array.isArray(perms[k]) && perms[k].includes(x));
    for (const k of ['allow', 'ask']) {
      const want = (isObj(frag.permissions) && Array.isArray(frag.permissions[k])) ? frag.permissions[k] : [];
      let have = Array.isArray(perms[k]) ? perms[k] : [];
      // 新版不要了、清单里记着是套件自己加的、现在还在的：收回。20261030 起去掉了 push 的确认规则 Bash(git push:*)
      // （用户 2026-10-30 定的：push 只留钩子这一道确认，不再说了推送还弹 Claude Code 的确认框）。你自己加回来的、挪到别处的不在清单里，不动
      const drop = man[k].filter((x) => !want.includes(x) && have.includes(x));
      if (drop.length) {
        have = have.filter((x) => !drop.includes(x));
        if (have.length) perms[k] = have; else delete perms[k];
        s.permissions = perms;
        // 是套件收回的，不是你删的：从"装过的"记录里也去掉。装回老版本时（它还没有 guard-push）照它的规矩重新加上（复审 S6）
        man.known[k] = man.known[k].filter((x) => !drop.includes(x));
        console.log('  [OK] 收回了套件以前加的权限规则：' + drop.join('、') + (drop.includes('Bash(git push:*)') ? '（推送只留套件这一道确认，说了推送不再弹 Claude Code 的确认框）' : ''));
      }
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
    const fragEnv = isObj(frag.env) ? Object.assign({}, frag.env) : {};
    // JAVA_TOOL_OPTIONS 不盖系统里已有的（用户 2026-10-30 定的，F8）：settings.json 的 env 会替掉 Claude Code 里跑的命令看到的系统值，
    // 所以系统里设了的，写进去的是"系统的值 + 套件要加的、系统里没写的那几项"。还是套件自己写的那个值（你没改过）就跟着系统重新算；你改过的不动
    if (typeof fragEnv.JAVA_TOOL_OPTIONS === 'string') {
      const sys = systemEnv('JAVA_TOOL_OPTIONS').trim();
      const want = javaToolOptions(sys, fragEnv.JAVA_TOOL_OPTIONS);
      fragEnv.JAVA_TOOL_OPTIONS = want;
      const env = isObj(s.env) ? s.env : {};
      const cur = env.JAVA_TOOL_OPTIONS;
      const ours = cur !== undefined && man.env.JAVA_TOOL_OPTIONS !== undefined && cur === man.env.JAVA_TOOL_OPTIONS;
      const fresh = cur === undefined && !man.known.env.includes('JAVA_TOOL_OPTIONS') && man.env.JAVA_TOOL_OPTIONS === undefined;
      if (ours && cur !== want) { env.JAVA_TOOL_OPTIONS = want; s.env = env; man.env.JAVA_TOOL_OPTIONS = want; }
      if (sys && ((ours && cur !== want) || fresh)) mergeSettings.javaOpts = '系统里设了 JAVA_TOOL_OPTIONS=' + sys + '：settings.json 里写的是它' + (want === sys ? '（套件要的几项它都写了，没再加）' : '再加上套件要的 ' + want.slice(sys.length).trim()) + '，没盖掉你的';
    }
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
    writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + '\n');
    console.log('  [OK] settings.json 已更新' + (bak ? '（原文件备份在 ' + bak + '）' : ''));
  }
  return man;
}

// ---------- 全局约定：基础约定 + 启用的规范，写进 CLAUDE.md 的标记块 ----------
/** 本机环境（local.json，在配置页里填，或者手改）→ 全局约定里的一节。每台机器不一样，所以不放进任何仓库 */
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
/**
 * 提交规范里"什么时候提交"那几句，跟着配置页的"提交方式"走（config.json 的 commitMode：off 关 / ask 询问 / auto 自动，用户 2026-10-17 定的，
 * 人工和自动都用；以前的 autoCommit、plainCommit 并进来了）。改了要重新生成全局约定，配置页保存时会自动做。
 */
const COMMIT_MODE_TEXT = {
  off: '- 提交方式是"关"：不自动提交，也不问；用户说了"提交"再提交，这一轮里分几笔提交都算这一句。',
  ask: '- 提交方式是"询问"：做完一件完整的事（勾完一项任务、审查修复收尾、需求文档定稿、普通修改做完并验证过）用 Ask 问"提交 / 还要改"，用户选了提交再提交；Apply 自动时用户不在，先不提交，记进报告。',
  auto: '- 提交方式是"自动"：做完一件完整的事（快检过了，该看的页面看过了）就提交，一件事一笔；做到一半、审查没收尾不提交。',
};
const SEE_PAGE_TEXT = { on: '，页面按已准备的验收场景验证', off: '；页面只在用户要求时验证' };
const SEE_PAGE_SPEC_TEXT = { on: '自动阶段按验收用例验证接口和页面；人工阶段先 Ask，用户放弃后继续，不记待办。', off: '页面由用户决定是否验证；人工阶段的接口自测也先 Ask。' };
const PAGE_VERIFY_TEXT = { on: '<命令或验收场景及预期>', off: '<命令或人工验收步骤及预期>' };
const PROPOSAL_COMMIT = '同一套 proposal、specs、design、tasks 和用例写完审过，定稿后按提交方式一起提交一次 docs: 提案 <名字>（全自动下关、询问都不提交也不问）。开着自动且用户没限定只写需求时，定稿后直接 apply；其他情况用 Ask 给出 apply 选项。';
const COMMIT_RHYTHM_TEXT = PROPOSAL_COMMIT + ' 实施按提交方式提交；归档、验收节点单独保留，用户说了推送才 push。';
function kitConfig() {
  try { let t = fs.readFileSync(path.join(KIT, 'config.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t) || {}; } catch (e) { return {}; }
}
function commitMode() { const m = kitConfig().commitMode; return COMMIT_MODE_TEXT[m] ? m : 'off'; }
function seePageMode() { return kitConfig().autoSeePage === false ? 'off' : 'on'; }
// 审查不设次数上限（用户 2026-11-03 定的）
function reviewModeText() {
  return '子代理 vk-reviewer 审，第一轮按材料大小 1～3 个，只看这次需求碰到的地方，后面只审改过的地方。自动核验、修改、复验，没有 P1、P2 就算过；子代理连续 3 次没交结论就停止催，不算通过。人工审查、自测或复验先 Ask，用户这一轮已经要求过的直接做。';
}
const AUTO_MODE_TEXT = '### 自动执行范围\n\n需求自动和 Apply 自动分别由本轮提醒给出。需求先有用户描述、探索现状并沟通未决问题，满足条件才自动写，四份写完审修一次整套；Apply 按已授权范围做，这个 change 的任务全部做完审修一次，所有 change 做完全面自测。业务疑问先 Ask，不猜需求。只做当前范围，不自行开下一变更；需要用户的账号、归档或 push 许可时仍要 Ask。审查执行、服务起停和诊断留在本机，不写团队 tasks。';
const AUTO_TOP_TEXT = '> 自动模式按会话开（用户敲 /vk-auto 或说"这个需求自动做"，只对那个会话有效）；开没开、在哪一段生效以本轮提醒为准。人工模式先 Ask 是否审查、自测或复验，用户放弃后直接继续，不留未审查或未测试记录。';
/** 约定和规范里的占位符换成按开关生成的文字 */
function fill(text) {
  const c = kitConfig();
  const see = seePageMode();
  let commit = COMMIT_MODE_TEXT[commitMode()];
  if (see === 'off') commit = commit.split('（快检过了，该看的页面看过了）').join('（快检过了）');
  const auto = c.autoRequirements || c.autoApply ? AUTO_MODE_TEXT : '';
  return text.split('{{AUTO_COMMIT}}').join(commit).split('{{SEE_PAGE}}').join(SEE_PAGE_TEXT[see])
    .split('{{SEE_PAGE_SPEC}}').join(SEE_PAGE_SPEC_TEXT[see]).split('{{PAGE_VERIFY}}').join(PAGE_VERIFY_TEXT[see])
    .split('{{COMMIT_RHYTHM}}').join(COMMIT_RHYTHM_TEXT)
    .split('{{REVIEW_MODE}}').join(reviewModeText()).split('{{AUTO_MODE}}').join(auto)
    .split('{{AUTO_TOP}}').join(AUTO_TOP_TEXT).replace(/\n{3,}/g, '\n\n').trim();
}
// ---------- 你自己的约定和规范：~/.claude/vibe-kit/user/，安装器从不覆盖（F8，用户 2026-10-30 定的） ----------
// 以前照 README 直接改 vibe-kit 里的 CLAUDE.md、rules/*.md，自动更新装新版时被覆盖、只留备份（审核报告 H 节）。现在：
//   user/*.md（文件名不以下划线开头的）接在套件的约定和规范后面，一起生成进全局约定；
//   user/remove.txt 一行一句：套件的约定、规范里和这一行一字不差（不算行首行尾的空格）的那一行，生成时去掉。// 开头的行是说明；
//   以前直接改过套件文件的，升级时和上次装的原样（pristine）比：新加的内容挪进 user/migrated-<文件名>.md，删掉、改掉的原句记进 remove.txt
const USER_DIR = path.join(KIT, 'user');
const USER_REMOVE = path.join(USER_DIR, 'remove.txt');
/** 读成文本：去掉开头的 BOM，换行统一成 LF（用记事本改过的文件是 CRLF）。读不了返回 '' */
const readMd = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'); } catch (e) { return ''; } };
function userFiles() { try { return fs.readdirSync(USER_DIR).filter((f) => /\.md$/i.test(f) && !f.startsWith('_') && fs.statSync(path.join(USER_DIR, f)).isFile()).sort(); } catch (e) { return []; } }
function removedLines() { return new Set(readMd(USER_REMOVE).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))); }
const dropLines = (text, drop) => (drop.size ? text.split('\n').filter((l) => !drop.has(l.trim())).join('\n') : text);
const SENT_BY_HOOK = /^<!--\s*vibe-kit:钩子送\s*-->\s*/;
function buildBlock() {
  const drop = removedLines();
  // 去两遍：模板里的原句（升级时挪来的是这种），换完占位符之后的句子（你从生成的全局约定里抄的是这种）
  const kitPart = (f) => dropLines(fill(dropLines(readMd(f), drop)), drop).replace(/\n{3,}/g, '\n\n').trim();
  const base = kitPart(path.join(KIT, 'CLAUDE.md'));
  const rulesDir = path.join(KIT, 'rules');
  const rules = fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => /\.md$/i.test(f) && !f.startsWith('_')).sort() : [];
  const mine = userFiles();
  // remove.txt 只管套件的规范（上次装的原样里有的）；rules/ 里你自己以前加的文件和 user/ 一样不受影响。认不出（没有原样）就当套件的
  const kitRule = (f) => !fs.existsSync(path.join(KIT, 'pristine', 'rules')) || fs.existsSync(path.join(KIT, 'pristine', 'rules', f));
  // 开头标着"钩子送"的套件规范不进全局约定（J4：每个请求都带太贵），填好占位符单独写成 hook-rules.md，进 OpenSpec 流程时由钩子送（lib/stage-rules.js）
  const hooked = (f) => kitRule(f) && SENT_BY_HOOK.test(readMd(path.join(rulesDir, f)));
  const hookRules = rules.filter(hooked).map((f) => kitPart(path.join(rulesDir, f)).replace(SENT_BY_HOOK, '').trim()).join('\n\n');
  const parts = [base].concat(rules.filter((f) => !hooked(f)).map((f) => (kitRule(f) ? kitPart(path.join(rulesDir, f)) : fill(readMd(path.join(rulesDir, f)))))).concat(mine.map((f) => fill(readMd(path.join(USER_DIR, f)))));
  const local = localSection();
  if (local) parts.push(local);
  return { text: BEGIN + '\n' + parts.filter(Boolean).join('\n\n') + '\n' + END + '\n', rules, mine, hookRules };
}
/**
 * 两份文本按行比（最长公共子序列），行尾的空格不算。返回 [['=' | '+' | '-', 行], …]：+ 是 b 里新加的，- 是 a 里有、b 里没了的。
 * 太大的（几千行对几千行）不比，返回 null
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4000000) return null;
  const x = a.map((l) => l.trimEnd());
  const y = b.map((l) => l.trimEnd());
  const L = [];
  for (let i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push(['=', b[j]]); i++; j++; } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ops.push(['+', b[j]]); j++; } else { ops.push(['-', a[i]]); i++; }
  }
  return ops;
}
// 只有符号的行（表格的 |---|、分隔线、空的列表符号）和代码块的开头结尾（```、```bash）不记进 remove.txt：
// 去一句会把所有文件里的同样一行都去掉，表格、代码块就散了
const STRUCTURAL = /^(?:[\s`~\-*_#>|=:+.]*|`{3,}.*|~{3,}.*)$/;
/**
 * 你改过的一份套件文件（原样 was、你改的 cur）：挑出新加的内容（added，接在后面能照样生效的一段文本，每段前面带上它所在那一节的标题）
 * 和删掉、改掉的原句（removed）。比不了返回 null
 */
function editsOf(was, cur) {
  const ops = diffLines(was.split('\n'), cur.split('\n'));
  if (!ops) return null;
  const hunks = [];
  let heading = '';
  let run = null;
  let lastHead = '';
  for (const [op, line] of ops) {
    if (op === '+') { if (!run) run = { heading, lines: [] }; run.lines.push(line); if (/^#{1,6}\s/.test(line)) heading = line; continue; }
    if (run) { hunks.push(run); run = null; }
    if (op === '=' && /^#{1,6}\s/.test(line)) heading = line;
  }
  if (run) hunks.push(run);
  const parts = [];
  for (const h of hunks) {
    const lines = h.lines.slice();
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) continue;
    // 新加的不是一整节（不以标题开头）：带上它原来所在那一节的标题，挪到后面还看得出是补哪一节的；同一节接连几段只带一次
    const head = h.heading && !/^#{1,6}\s/.test(lines[0]) && h.heading !== lastHead ? h.heading + '\n' : '';
    if (head) lastHead = h.heading;
    parts.push(head + lines.join('\n'));
  }
  const removed = [];
  for (const [op, line] of ops) { const t = line.trim(); if (op === '-' && t && !STRUCTURAL.test(t) && !removed.includes(t)) removed.push(t); }
  return { added: parts.join('\n\n'), removed };
}
/** 新加的内容写进 user/migrated-<名字>.md：已经有这个文件（上次升级挪过）就接在后面；同样的内容已经在里面了（装到一半重来）不重复写。返回写到哪 */
function writeMigrated(rel, text) {
  const f = path.join(USER_DIR, 'migrated-' + path.basename(rel));
  const old = readMd(f);
  if (old.includes(text)) return f;
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(f, (old.trim() ? old.trimEnd() + '\n\n' : '') + text + '\n');
  return f;
}
const REMOVE_HEAD = '// 每行一句：套件的全局约定、规范里和这一行一字不差（不算行首行尾的空格）的那一行，生成全局约定时去掉。\n'
  + '// 以 // 开头的是说明。只管套件自带的约定和规范，这个目录里你自己的 .md 不受影响。改完运行 node "' + path.join(KIT, 'install.js') + '" --sync\n';
/** 删掉、改掉的原句并进 user/remove.txt（已经在里面的不重复） */
function addRemovals(lines) {
  const have = removedLines();
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return 0;
  fs.mkdirSync(USER_DIR, { recursive: true });
  const old = readMd(USER_REMOVE);
  fs.writeFileSync(USER_REMOVE, (old.trim() ? old.trimEnd() + '\n' : REMOVE_HEAD) + add.join('\n') + '\n');
  return add.length;
}
/** 这次安装要在配置页上提示一次的事（覆盖了你改过的文件、挪了你的补充）：装完写进 state/install-done.json 的 notice */
const noticeItems = [];
/**
 * 升级前：你改过套件的约定或规范（rel 是 CLAUDE.md、rules/<名字>.md，和这一版、和上次装的原样都对不上），先备份，
 * 再把改了什么挪进 user/（新加的进 migrated-<名字>.md，删掉改掉的进 remove.txt），然后照常换成这一版
 */
function keepEdits(rel) {
  const cur = path.join(KIT, rel);
  const was = path.join(KIT, 'pristine', rel);
  const now = path.join(SRC, 'claude', rel);
  if (!fs.existsSync(cur) || same(cur, now) || same(cur, was)) return;
  const d = fs.existsSync(was) ? editsOf(readMd(was), readMd(cur)) : null;
  // 只差空白、换行符：不算改过
  if (d && !d.added && !d.removed.length) return;
  const bak = backup(cur, 'vibe-kit/' + rel);
  const name = rel === 'CLAUDE.md' ? '全局约定 ' + rel : '规范 ' + rel;
  if (!d) {
    console.log('  [!] 你改过' + name + '，但上次装的原样不在（或者文件太大），认不出改了哪些，没法替你挪：原文件备份在 ' + bak + '，把你加的内容挑出来放进 ' + USER_DIR + ' 里的 .md，再运行 --sync');
    noticeItems.push('你改过' + name + '，认不出改了哪些，这次换成了新版。原文件备份在 ' + bak + '：把你加的内容挑出来放进 ' + USER_DIR + ' 里的 .md，再运行 --sync');
    return;
  }
  const said = [];
  if (d.added) said.push('新加的内容挪到了 ' + writeMigrated(rel, d.added));
  if (d.removed.length) { addRemovals(d.removed); said.push('删掉、改掉的 ' + d.removed.length + ' 句原文记进了 ' + USER_REMOVE + '（生成时照样去掉）'); }
  const nowLines = new Set(readMd(now).split('\n').map((l) => l.trim()));
  const gone = d.removed.filter((l) => !nowLines.has(l));
  console.log('  [OK] 你改过' + name + '：' + said.join('；') + '，照样生效，以后更新不再碰。原文件备份在 ' + bak);
  if (gone.length) console.log('  [!] 你删掉、改掉的这几句，新版里换了说法，没法替你去掉，看一眼新版要不要也去掉：' + gone.slice(0, 5).join(' / '));
  noticeItems.push('你改过' + name + '：' + said.join('；') + '，照样生效，以后更新不再碰。原文件备份在 ' + bak + (gone.length ? '。其中 ' + gone.length + ' 句新版换了说法，没法替你去掉，看一眼新版' : ''));
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
  writeAtomic(file, next);
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
  // 套件的斜杠命令（vk-*）：改过的先备份再删
  for (const n of kitCommands(path.join(KIT, 'pristine', 'commands'))) {
    const f = path.join(CLAUDE, 'commands', n);
    if (!fs.existsSync(f)) continue;
    if (!same(f, path.join(KIT, 'pristine', 'commands', n))) console.log('  [!] 命令 /' + n.replace(/\.md$/, '') + ' 被改过，删除前备份在 ' + backup(f, 'commands/' + n));
    fs.unlinkSync(f);
  }
  // 从改名之前的版本直接卸载：旧名字的技能也是套件装的，一起收回
  removeOldNames();
  // 自带的 OpenSpec 生成的命令和技能（清单里记着的）
  for (const rel of Array.isArray(man.openspec) ? man.openspec : []) { try { fs.unlinkSync(path.join(CLAUDE, rel)); } catch (e) { /* 已经没了 */ } }
  const finish = async () => {
    // 还没收回的路由（升级之后没开过 Claude Code）：卸载时一起收
    try { const Rt = require(path.join(KIT, 'lib', 'router-retire.js')); if (Rt.pending()) { const r = await Rt.run(); for (const n of r.notes) console.log('  [OK] ' + n); } } catch (e) { console.log('  [!] 路由没收回：' + (e && e.message)); }
    // 基础约定你改过（和装进去的原样不一样）：删之前先备份
    const kitMd = path.join(KIT, 'CLAUDE.md');
    if (fs.existsSync(kitMd) && !same(kitMd, path.join(KIT, 'pristine', 'CLAUDE.md'))) console.log('  [!] 你改过 ' + kitMd + '，删除前备份在 ' + backup(kitMd, 'vibe-kit/CLAUDE.md'));
    // results：老版本看页面的执行器没写 --out 时把结果放在这里
    // update：自动更新从仓库拉下来的暂存处和日志
    for (const n of ['page', 'openspec', 'hooks', 'tools', 'lib', 'ui', 'router', 'state', 'pristine', 'results', 'update', '.ignore', 'statusline.js', 'CLAUDE.md', 'installed.json', 'settings.fragment.json', 'VERSION', 'install.js', 'deps.json', 'hook-rules.md']) removeDir(path.join(KIT, n));
    console.log('  [OK] 已卸载：约定块、钩子、状态栏、技能，以及安装时加的权限和环境变量都收回了。');
    console.log('  留着没删的：你自己的约定和规范（user/，还有 rules/ 里你自己加的）、本机环境（local.json）、开关（config.json）、数据库驱动（drivers、drivers.json）、问题反馈（feedback）、跨项目的经验记录（lessons）、GitLab 的仓库地址和令牌（gitlab.json、secrets.json）、以前单独装的技能（retired）和备份，都在 ' + KIT);
    if (['secrets.json', 'router-data'].some((n) => fs.existsSync(path.join(KIT, n)))) {
      console.log('  [!] 令牌（secrets.json）和模型的 key（router-data）还在，套件卸了之后它们不再受保护：挡命令读取的钩子已经没了。'
        + (mergeSettings.keptDeny && mergeSettings.keptDeny.length ? 'settings.json 里那两条"不许读"的规则留着（挡 Read、Grep 工具）。' : '')
        + '不再用这台电脑上的套件了，就把这两处删掉：' + path.join(KIT, 'secrets.json') + '、' + path.join(KIT, 'router-data'));
    }
    // 经验规则是你攒下来的，Claude Code 自己会加载它们，和套件装没装无关：留着
    try { const rd = path.join(CLAUDE, 'rules'); const n = fs.readdirSync(rd).filter((f) => /^(vk|ttls|vibe)-lessons-.*\.md$/i.test(f)).length; if (n) console.log('  用户级的经验规则也留着（' + rd + ' 里的 vk-lessons-*.md，' + n + ' 个文件）：Claude Code 自己会按文件类型加载，不想要就手动删掉。各个项目里的 .claude/rules/vk-lessons-*.md 跟着仓库走，没有动'); } catch (e) { /* 没有规则目录 */ }
    process.exit(0);
  };
  finish();
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
    if (!fs.existsSync(was)) { console.log('  [!] ' + d + ' 不是套件装的（你自己的同名技能），没有动它。套件的这个技能现在叫 ' + nowName(n)); continue; }
    if (!sameDir(d, was)) console.log('  [!] 旧技能 ' + n + ' 被改过，删除前备份在 ' + backup(d, 'skills/' + n));
    // 整个目录一步挪走再删：删到一半被占着的话，留下的半截目录 Claude Code 还会列出来
    if (!moveAway(d, n, false)) { console.log('  [!] ' + d + ' 被别的程序占着，这次没删掉（下次装的时候再删）'); continue; }
    gone.push('/' + n + ' → /' + nowName(n));
  }
  for (const n of OLD_AGENTS) {
    const f = path.join(CLAUDE, 'agents', n);
    if (!fs.existsSync(f)) continue;
    const was = path.join(KIT, 'pristine', 'agents', n);
    if (!fs.existsSync(was)) { console.log('  [!] ' + f + ' 不是套件装的，没有动它。套件的审查代理现在叫 vk-reviewer'); continue; }
    if (!same(f, was)) console.log('  [!] 旧的审查代理 ' + n + ' 被改过，删除前备份在 ' + backup(f, 'agents/' + n));
    fs.unlinkSync(f);
    gone.push(n.replace(/\.md$/, '') + ' → ' + nowName(n));
  }
  return gone;
}
/**
 * 并进套件之前单独装的技能（urai-db-crud、redis）：整个目录挪进 vibe-kit/retired/（不参加备份的轮转，不会被自动删）。
 * urai-db-crud 自带的驱动先挪进套件的驱动目录并登记：不然升级完就连不上库了（这一版起驱动不随包带）。
 * 只收一次：收过之后用户又装回来的（installed.json 的 absorbed 里记着），是用户要的，不再收，只提一句
 */
/**
 * 自带的 OpenSpec（用户 2026-10-17 定的集成）：用它生成 /opsx:* 命令和 openspec-* 技能，装成用户级（~/.claude/commands/opsx、~/.claude/skills），
 * 所有项目都能用，不用各自 openspec init。已有同名、又不是上次装的（你自己的）先备份。上次装了、这次没有的删掉。
 * Node 版本不够（1.14.3 要 20.19）时不装，上次装的也收回：用你自己装的、项目里初始化好的 OpenSpec。返回这次装的文件（相对 ~/.claude）
 */
function installOpenSpec(prev) {
  const before = Array.isArray(prev.openspec) ? prev.openspec : [];
  const drop = (keep) => { for (const rel of before) if (!keep.includes(rel)) { try { fs.unlinkSync(path.join(CLAUDE, rel)); } catch (e) { /* 已经没了 */ } } };
  let O = null; try { O = require(path.join(KIT, 'lib', 'openspec.js')); } catch (e) { O = null; }
  if (!O) return before;
  const r = O.installClaudeFiles(CLAUDE, (rel, to) => { if (!before.includes(rel)) console.log('  [!] 已有同名的 ' + rel + '（你自己的），原文件备份在 ' + backup(to, rel)); });
  if (!r.ok) { drop([]); console.log('  [!] 没装套件自带的 OpenSpec：' + r.why); return []; }
  drop(r.files);
  console.log('  [OK] OpenSpec ' + r.version + '（套件自带）：' + O.WORKFLOWS.map((w) => '/opsx:' + w).join('  ') + '。项目里没初始化的，第一次用时自动建 openspec/');
  return r.files;
}
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
      try { moved = require(path.join(KIT, 'lib', 'drivers.js')).rescueFrom(d); } catch (e) { console.log('  [!] 旧技能自带的驱动没挪成（' + ((e && e.message) || e) + '）。旧技能整个留在 ' + RETIRED + ' 里，驱动在它的 drivers 目录下，可以用 drivers.js use <jar 的路径> 登记'); }
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
  if (major < 18) { console.log('  [X] Node 版本太低（' + process.versions.node + '），需要 18 以上'); process.exit(REFUSED); }
  // 随包的依赖（K1-6）：按依赖清单 kit/deps.json（打包时生成）核对每个包在不在、版本对不对；这台电脑的 Node 用不了哪个组件，照清单里各组件的要求说清楚
  // （看页面的 Playwright 要 20，自带的 OpenSpec 要 20.19，Codex C16）。没有清单的（直接从源码装、本地恢复包里没带它）照以前写死的检查
  let D = null;
  let depMan = null;
  try { D = require(path.join(SRC, 'kit', 'lib', 'deps.js')); depMan = D.read(path.join(SRC, 'kit')); } catch (e) { depMan = null; }
  if (depMan) {
    const c = D.check(path.join(SRC, 'kit'), depMan);
    if (c.missing.length || c.mismatched.length) {
      console.log('  [X] 安装包不完整：' + [c.missing.length ? '缺 ' + c.missing.slice(0, 5).map((r) => 'kit/' + r).join('、') + (c.missing.length > 5 ? ' 等 ' + c.missing.length + ' 个包' : '') : '', c.mismatched.length ? '和依赖清单对不上 ' + c.mismatched.slice(0, 3).map((r) => 'kit/' + r).join('、') : ''].filter(Boolean).join('；') + '。重新拷一份完整的包');
      process.exit(1);
    }
    const gaps = D.nodeGaps(depMan);
    const top = gaps.map((g) => g.min).filter(Boolean).sort((a, b) => (D.satisfies(a, '>=' + b) ? 1 : -1)).pop();
    if (gaps.length) console.log('  [!] 这台电脑的 Node 是 ' + process.versions.node + '：' + gaps.map((g) => g.label + '要 Node ' + g.node + '，' + g.without).join('；') + (top ? '。要用就把 Node 升到 ' + top + ' 以上' : ''));
  } else {
    if (major < 20) console.log('  [!] 这台电脑的 Node 是 ' + process.versions.node + '：套件能装，但看页面（/vk-see-page）要 Node 20 以上，用不了；要看页面就把 Node 升到 20 以上');
    for (const dep of ['pixelmatch', 'pngjs', 'playwright-core']) {
      if (!fs.existsSync(path.join(SRC, 'kit', 'page', 'node_modules', dep))) { console.log('  [X] 安装包不完整：缺 kit/page/node_modules/' + dep + '。重新拷一份完整的包'); process.exit(1); }
    }
    if (!fs.existsSync(path.join(SRC, 'kit', 'openspec', 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'))) { console.log('  [X] 安装包不完整：缺自带的 OpenSpec（kit/openspec/node_modules）。重新拷一份完整的包'); process.exit(1); }
  }
  const s = readSettings();
  // 全局 CLAUDE.md 不是 UTF-8：和 settings.json 读不懂一样，什么都不动。装一半、约定写不进去，比不装还乱
  if (readGlobalMd().text === null) { explainNotUtf8(fs.existsSync(MANIFEST) ? '这次什么都没动：现在装着的还是之前那一版，照常工作。转好之后再运行一次安装。' : '这次什么都没动，套件还没装上。转好之后再运行一次安装。'); process.exit(REFUSED); }
  fs.mkdirSync(KIT, { recursive: true });
  // 版本号（VERSION）最后写：装到一半被结束（关机、注销）的话，版本号还是旧的，自动更新下次会接着重装；
  // 先写的话，技能、约定、钩子登记都还是旧的，却已经显示"已是最新"，一直到下一版
  // 自带的 OpenSpec、看页面的依赖整个换新：换版本时不留上一版的旧文件（拷贝只覆盖，新旧文件混在一起会坏）
  removeDirQuiet(path.join(KIT, 'openspec'));
  removeDirQuiet(path.join(KIT, 'page', 'node_modules'));
  // user/ 是你自己的约定和规范：安装包里就算带了也不拷（打包时也查）
  copyDir(path.join(SRC, 'kit'), KIT, ['VERSION', 'user']);
  // 新版删掉了的文件：拷贝不会删，旧版留下的要清掉（自检会挨个载 lib 下的每个文件）。hooks 下的文件不删（AGENTS.md 硬规矩第 11 条）
  for (const rel of DROPPED_FILES) { try { fs.unlinkSync(path.join(KIT, rel)); } catch (e) { /* 没有 */ } }
  for (const f of ['install.js', 'settings.fragment.json']) copyFile(path.join(SRC, f), path.join(KIT, f));
  // 套件代码的指纹：会话开始时比一遍，被改过的告诉模型和你、记一条问题反馈（算法和 kit/lib/session.js 的 kitCodeHashes 一样）
  {
    const files = {};
    const add = (rel) => { try { files[rel] = require('crypto').createHash('sha1').update(fs.readFileSync(path.join(KIT, rel))).digest('hex'); } catch (e) { /* 读不了 */ } };
    for (const d of ['hooks', 'lib', 'tools', 'page', 'ui']) { let es = []; try { es = fs.readdirSync(path.join(KIT, d), { withFileTypes: true }); } catch (e) { continue; } for (const e of es) if (e.isFile() && /\.js$/i.test(e.name)) add(d + '/' + e.name); }
    if (fs.existsSync(path.join(KIT, 'statusline.js'))) add('statusline.js');
    fs.mkdirSync(path.join(KIT, 'state'), { recursive: true });
    fs.writeFileSync(path.join(KIT, 'state', 'kit-hash.json'), JSON.stringify({ files, at: Date.now() }));
    try { fs.unlinkSync(path.join(KIT, 'state', 'kit-drift.json')); } catch (e) { /* 没有 */ }
  }
  const cfgFile = path.join(KIT, 'config.json');
  // 默认开关只写在 kit/lib/config-fields.js 一处
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify(require(path.join(SRC, 'kit', 'lib', 'session.js')).DEFAULT_CONFIG, null, 2) + '\n');
  // "维护套件的电脑"2026-10-01 起写死在代码里（kit/lib/gitlab.js），不再是开关：老版本写进 config.json 的那一项去掉，别人打开文件也看不到
  else {
    try {
      const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
      if (cur && typeof cur === 'object' && cur.maintainerHosts !== undefined) { delete cur.maintainerHosts; fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n'); }
    } catch (e) { /* 读不懂就不动：配置页保存一次也会去掉 */ }
  }
  // 2026-10-14 一次性迁移：本次新装和旧版升级都关闭两阶段自动；后续同步保留用户选择。
  const migrationFile = path.join(KIT, 'state', 'workflow-v2-migration.json');
  // config.json \u8BFB\u4E0D\u61C2\uFF1A\u8FD9\u6B21\u4E0D\u8FC1\u79FB\u3001\u4E0D\u5199\u6807\u8BB0\uFF0C\u5F80\u4E0B\u7167\u5E38\u88C5\u5B8C\uFF082026-10-17 \u5BA1\u6838\u95EE\u9898 10\uFF1A\u539F\u6765\u5728\u8FD9\u91CC\u629B\u9519\uFF0C\u88C5\u4E86\u4E00\u534A\u5C31\u9000\u51FA\uFF0C\u81EA\u52A8\u66F4\u65B0\u6BCF\u6B21\u90FD\u5931\u8D25\uFF09\u3002
  // \u8BFB\u4E0D\u61C2\u7684\u914D\u7F6E\u94A9\u5B50\u6309\u9ED8\u8BA4\u503C\u7B97\uFF0C\u4E24\u4E2A\u81EA\u52A8\u672C\u6765\u5C31\u662F\u5173\u7684
  let migrateCfg = null;
  if (!fs.existsSync(migrationFile)) { try { const v = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('\u4E0D\u662F\u5BF9\u8C61'); migrateCfg = v; } catch (e) { console.log('  [!] config.json \u8BFB\u4E0D\u61C2\uFF0C\u8FD9\u6B21\u6CA1\u6709\u5173\u95ED\u4E24\u4E2A\u81EA\u52A8\u6A21\u5F0F\uFF1B\u5728\u914D\u7F6E\u9875\u4FDD\u5B58\u4E00\u6B21\u4F1A\u91CD\u5199\u8FD9\u4E2A\u6587\u4EF6\uFF0C\u4E0B\u6B21\u66F4\u65B0\u518D\u5173'); } }
  // \u6709\u4F1A\u8BDD\u6B63\u5728 Apply \u81EA\u52A8\u5E72\u6D3B\uFF08\u8FDB\u7A0B\u8FD8\u5728\uFF09\uFF1A\u8FD9\u6B21\u5148\u4E0D\u5173\uFF0C\u514D\u5F97\u5B83\u4E2D\u9014\u53D8\u6210\u4EBA\u5DE5\u3001\u505C\u5728\u63D0\u95EE\u6846\u4E0A\uFF1B\u4E0B\u6B21\u6CA1\u6709\u5728\u8DD1\u7684\u81EA\u52A8\u4F1A\u8BDD\u65F6\u7684\u66F4\u65B0\u518D\u5173\uFF08\u7528\u6237 2026-10-17 \u5B9A\u7684\uFF09
  const busyAutoCount = () => { try { return Object.values(JSON.parse(fs.readFileSync(path.join(KIT, 'state', 'work-sessions.json'), 'utf8'))).filter((r) => { if (!r || !r.pid) return r && Date.now() - (Number(r.at) || 0) < 30 * 60000; try { process.kill(r.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }).length; } catch (e) { return 0; } };
  const busyAuto = migrateCfg && migrateCfg.autoApply ? busyAutoCount() : 0;
  if (busyAuto) { console.log('  [!] \u6709 ' + busyAuto + ' \u4E2A\u4F1A\u8BDD\u6B63\u5728 Apply \u81EA\u52A8\u5E72\u6D3B\uFF0C\u8FD9\u6B21\u5148\u4E0D\u5173\u95ED\u4E24\u4E2A\u81EA\u52A8\u6A21\u5F0F\uFF0C\u7B49\u4E0B\u6B21\u6CA1\u6709\u5728\u8DD1\u7684\u81EA\u52A8\u4F1A\u8BDD\u65F6\u7684\u66F4\u65B0\u518D\u5173'); migrateCfg = null; }
  if (migrateCfg) {
    const cur = migrateCfg;
    Object.assign(cur, { autoMode: false, autoRequirements: false, autoApply: false });
    fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n');
    const sealFile = path.join(KIT, 'state', 'config-seal.json');
    let oldSeal = {}; try { oldSeal = JSON.parse(fs.readFileSync(sealFile, 'utf8')); } catch (e) { /* 没有旧封条时保护项采用安全默认值 */ }
    fs.mkdirSync(path.dirname(sealFile), { recursive: true });
    fs.writeFileSync(sealFile, JSON.stringify(Object.assign({}, oldSeal, { autoMode: false, autoApply: false, autoRequirements: false, at: Date.now() })));
    fs.writeFileSync(migrationFile, JSON.stringify({ at: Date.now() }));
    console.log('  [OK] 两阶段自动模式已关闭，任务进度保留；需要时在配置页重新开启');
  }
  // 2026-10-17 晚上（用户定的）：升到这一版时强制改成新的默认值，不管你之前选的是什么；只改一次（记在 defaults-1017-migration.json），之后保留你的选择。
  //   自动压缩线 70%、到了交接线之后"不问，只提醒"、提交方式"关"、去掉旧 autoResume；需求自动和 Apply 自动关闭。
  //   有会话正在 Apply 自动干活时，两个自动模式这次先不关（和上面一样），别的照改；下次没在跑的时候再关
  const forceFile = path.join(KIT, 'state', 'defaults-1017-migration.json');
  let forced = {}; try { forced = JSON.parse(fs.readFileSync(forceFile, 'utf8')) || {}; } catch (e) { forced = {}; }
  // 标记没了、装之前已经是 20261018.0051（第一版带这次迁移）或更新的：迁移早就做过，标记是 20261030 以前被会话清理误删的
  // （它不在 GLOBAL_STATE 里，审核 P01）。补写标记，不再动用户的配置——以前每次更新都把两个自动模式关掉，就是这里
  if (!forced.defaults && !forced.autoOff) {
    let prev = ''; try { prev = fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').replace(/^﻿/, '').trim(); } catch (e) { prev = ''; }
    if (/^\d{8}\.\d{4}$/.test(prev) && prev >= '20261018.0051') {
      forced = { defaults: Date.now(), autoOff: Date.now(), recoveredFrom: prev };
      try { fs.mkdirSync(path.dirname(forceFile), { recursive: true }); fs.writeFileSync(forceFile, JSON.stringify(forced)); } catch (e) { /* 写不了：下次照样按版本号认 */ }
    }
  }
  if (!forced.defaults || !forced.autoOff) {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('不是对象'); }
    catch (e) { cur = null; console.log('  [!] config.json 读不懂，这次没改成新的默认值；在配置页保存一次会重写这个文件，下次更新再改'); }
    if (cur) {
      const said = [];
      if (!forced.defaults) {
        Object.assign(cur, { autoCompactPercent: 70, handoverAsk: 'off', commitMode: 'off' });
        delete cur.autoResume;
        forced.defaults = Date.now();
        said.push('自动压缩线 70%、到了交接线之后只提醒不问、提交方式"关"（你说提交才提交）');
      }
      const busy = !forced.autoOff && cur.autoApply ? busyAutoCount() : 0;
      if (!forced.autoOff && busy) console.log('  [!] 有 ' + busy + ' 个会话正在 Apply 自动干活，这次先不关两个自动模式，等下次没在跑的自动会话时的更新再关');
      else if (!forced.autoOff) {
        Object.assign(cur, { autoMode: false, autoRequirements: false, autoApply: false });
        const sealFile = path.join(KIT, 'state', 'config-seal.json');
        let oldSeal = {}; try { oldSeal = JSON.parse(fs.readFileSync(sealFile, 'utf8')); } catch (e) { /* 没有旧封条时保护项采用安全默认值 */ }
        fs.mkdirSync(path.dirname(sealFile), { recursive: true });
        fs.writeFileSync(sealFile, JSON.stringify(Object.assign({}, oldSeal, { autoMode: false, autoApply: false, autoRequirements: false, at: Date.now() })));
        forced.autoOff = Date.now();
        said.push('需求自动和 Apply 自动关闭');
      }
      fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n');
      fs.mkdirSync(path.dirname(forceFile), { recursive: true });
      fs.writeFileSync(forceFile, JSON.stringify(forced));
      if (said.length) console.log('  [OK] 这一版把几项开关改回了新的默认值：' + said.join('；') + '。要别的在配置页改，之后的更新不再动');
    }
  }
  // 2026-11-02（用户定的，问题表第 29—31 条）：自动自测、自动验证页面、后台自动探索、提案打勾归档的门槛不再是开关，自动审核上限固定 20，
  // 到交接线先写交接记录取消。配置里以前存的值清掉一次（配置页上已经改不回来了）；之后手写的还认
  {
    const fx = path.join(KIT, 'state', 'fixed-switch-migration.json');
    if (!fs.existsSync(fx)) {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = null; } catch (e) { cur = null; }
      if (cur) {
        const { FIXED, REMOVED } = require(path.join(SRC, 'kit', 'lib', 'config-fields.js'));
        const had = FIXED.concat(REMOVED || []).filter((k) => k in cur);
        for (const k of had) delete cur[k];
        try {
          if (had.length) fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n');
          fs.mkdirSync(path.dirname(fx), { recursive: true });
          fs.writeFileSync(fx, JSON.stringify({ at: Date.now(), removed: had }));
        } catch (e) { /* 写不了：下次更新再清 */ }
      }
    }
  }
  // 2026-10-31（用户定的，问题表第 28 条）：自动模式改成每个会话一个开关（/vk-auto），配置里旧的两个开关（需求自动、Apply 自动）清掉一次。
  // 升级这一刻正在走流程的会话（一天之内动过）原来开着自动的：给它补一个会话开关（开），升级不打断正在自动干活的会话
  {
    const f31 = path.join(KIT, 'state', 'auto-session-migration.json');
    if (!fs.existsSync(f31)) {
      let cur = null;
      try { cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = null; } catch (e) { cur = null; }
      if (cur) {
        const was = cur.autoApply === true || cur.autoRequirements === true || (cur.autoMode === true && cur.autoApply === undefined);
        let carried = 0;
        if (was) {
          const sd = path.join(KIT, 'state');
          let names = []; try { names = fs.readdirSync(sd).filter((n) => /-flow\.json$/.test(n)); } catch (e) { names = []; }
          for (const n of names) {
            try {
              const st = JSON.parse(fs.readFileSync(path.join(sd, n), 'utf8'));
              if (!st || !st.on || Date.now() - (Number(st.at) || 0) > 86400000) continue;
              const sw = path.join(sd, n.replace(/-flow\.json$/, '-auto-switch.json'));
              if (!fs.existsSync(sw)) { fs.writeFileSync(sw, JSON.stringify({ on: true, at: Date.now(), by: '升级前配置里开着自动' })); carried++; }
            } catch (e) { /* 读不懂的会话不管 */ }
          }
        }
        if ('autoApply' in cur || 'autoRequirements' in cur || 'autoMode' in cur) {
          delete cur.autoApply; delete cur.autoRequirements; delete cur.autoMode;
          try { fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2) + '\n'); } catch (e) { /* 写不了：下次更新再清 */ }
        }
        try { fs.mkdirSync(path.dirname(f31), { recursive: true }); fs.writeFileSync(f31, JSON.stringify({ at: Date.now(), was, carried })); } catch (e) { /* 写不了：下次再做一遍，结果一样 */ }
        console.log('  [OK] 自动模式改成每个会话一个开关：要自动的会话里敲 /vk-auto（或者说"这个需求自动做"），/vk-auto off 关；配置页上不再有两个自动开关'
          + (carried ? '。正在自动干活的 ' + carried + ' 个会话照旧开着' : ''));
      }
    }
  }
  // 问题上报从什么时候算起：头一回装上带问题上报的版本的这一刻，以前攒下的不传（20260929 起去掉了存量推送）。
  // 不在这里记的话要等第一次上报时才记，装好之后、第一次上报之前记的问题会被当成"以前攒下的"，永远传不上去
  const issueStore = path.join(KIT, 'feedback', 'issues.json');
  if (!fs.existsSync(issueStore)) { try { fs.mkdirSync(path.dirname(issueStore), { recursive: true }); fs.writeFileSync(issueStore, JSON.stringify({ since: Math.floor(Date.now() / 1000) * 1000, map: {} })); } catch (e) { /* 记不了：第一次上报时再记 */ } }
  // 封条（全自动的开关只认配置页、安装器改的，见 kit/lib/session-config.js 的 readConfigRaw）：还没有的，按现在文件里的记一份；已经有封条的不动
  const sealFile = path.join(KIT, 'state', 'config-seal.json');
  if (!fs.existsSync(sealFile)) {
    try { const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); fs.mkdirSync(path.dirname(sealFile), { recursive: true }); fs.writeFileSync(sealFile, JSON.stringify({ autoMode: cur.autoMode === true, at: Date.now() })); } catch (e) { /* 记不了就按安全的值算 */ }
  } else {
    // 老版本的封条里没有全自动模式这一项：按现在文件里的补上（以前在配置页打开过的，升级后照旧）
    try {
      const seal = JSON.parse(fs.readFileSync(sealFile, 'utf8'));
      if (seal && seal.autoMode === undefined) { const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); seal.autoMode = cur.autoMode === true; fs.writeFileSync(sealFile, JSON.stringify(seal)); }
    } catch (e) { /* 补不了就认文件里的 */ }
  }
  // 你自己的约定和规范放 user/：第一次装（或者升到带这个目录的版本）时建好，放一份说明。之后安装器不再碰这个目录（除了下面挪你改过的内容进来）
  if (!fs.existsSync(USER_DIR)) {
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(path.join(USER_DIR, '说明.txt'), '这个目录放你自己的约定和规范，更新套件从不覆盖、卸载也留着。\n'
        + '- 这里的 .md 文件（文件名不以下划线开头的）按文件名顺序接在套件的约定和规范后面，一起写进全局约定 ~/.claude/CLAUDE.md。每个字都是每个请求的成本，写短。\n'
        + '- 套件约定、规范里有你不要的句子：把那一句原样抄进这里的 remove.txt，一行一句，生成时去掉。\n'
        + '- 改完运行一次 node "' + path.join(KIT, 'install.js') + '" --sync（配置页保存开关时也会顺带生成）。\n'
        + '- 以前直接改过 vibe-kit 里的 CLAUDE.md、rules/*.md 的，升级时认出你改了什么：新加的挪进这里的 migrated-<文件名>.md，删掉、改掉的原句记进 remove.txt。\n');
    } catch (e) { /* 建不了：下面挪内容时再建 */ }
  }
  // 基础约定：你改过装进去的那份，先备份，改了什么挪进 user/，再换成这一版
  const kitMd = path.join(KIT, 'CLAUDE.md');
  keepEdits('CLAUDE.md');
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
    // 你改过的套件规范：先备份，改了什么挪进 user/，再换成这一版
    keepEdits('rules/' + f);
    copyFile(path.join(SRC, 'claude', 'rules', f), path.join(rulesDst, f));
  }
  // 技能和代理：已有同名的而且内容不同（你自己的或改过的），先备份。技能目录逐个文件比，
  // 和这一版、和上次装的原样（pristine）都对不上（改过任何一个文件、加了自己的配方都算），就整目录备份
  for (const n of SKILLS) {
    const d = path.join(CLAUDE, 'skills', n);
    // 技能、审查代理、命令照旧整个换成这一版（用户 2026-10-30 定的），改过的先备份，配置页提示一次
    if (fs.existsSync(d) && !sameDir(d, path.join(SRC, 'claude', 'skills', n)) && !sameDir(d, path.join(KIT, 'pristine', 'skills', n))) {
      const bak = backup(d, 'skills/' + n);
      console.log('  [!] 已有同名技能 ' + n + '（你自己的，或者改过里面的文件），原目录备份在 ' + bak);
      noticeItems.push('技能 ' + n + ' 你改过（或者加了文件），这次换成了新版。原目录备份在 ' + bak);
    }
    // 整个目录一步挪走再换新的：删到一半被占着，会留下新旧混在一起的半截目录
    if (fs.existsSync(d) && !moveAway(d, n, false)) removeDir(d);
    copyDir(path.join(SRC, 'claude', 'skills', n), d);
  }
  fs.mkdirSync(path.join(CLAUDE, 'agents'), { recursive: true });
  for (const n of AGENTS) {
    const d = path.join(CLAUDE, 'agents', n);
    if (fs.existsSync(d) && !same(d, path.join(SRC, 'claude', 'agents', n)) && !same(d, path.join(KIT, 'pristine', 'agents', n))) {
      const bak = backup(d, 'agents/' + n);
      console.log('  [!] 已有同名代理 ' + n + '，原文件备份在 ' + bak);
      noticeItems.push('审查代理 ' + n + ' 你改过，这次换成了新版。原文件备份在 ' + bak);
    }
    copyFile(path.join(SRC, 'claude', 'agents', n), d);
  }
  // 套件的斜杠命令（/vk-go、/vk-commit、/vk-push、/vk-archive、/vk-review、/vk-test、/vk-fix，用户 2026-10-30 定的）：装成用户级命令，
  // 敲了钩子直接认成许可，和说中文并存。同名的你自己的、改过的，先备份
  const cmds = kitCommands(path.join(SRC, 'claude', 'commands'));
  // 上一版装过、这一版没有的命令：没改过就收回（改过的留着，算你的）
  for (const n of kitCommands(path.join(KIT, 'pristine', 'commands'))) {
    const f = path.join(CLAUDE, 'commands', n);
    if (!cmds.includes(n) && fs.existsSync(f) && same(f, path.join(KIT, 'pristine', 'commands', n))) fs.unlinkSync(f);
  }
  if (cmds.length) fs.mkdirSync(path.join(CLAUDE, 'commands'), { recursive: true });
  for (const n of cmds) {
    const d = path.join(CLAUDE, 'commands', n);
    if (fs.existsSync(d) && !same(d, path.join(SRC, 'claude', 'commands', n)) && !same(d, path.join(KIT, 'pristine', 'commands', n))) {
      const bak = backup(d, 'commands/' + n);
      console.log('  [!] 已有同名命令 /' + n.replace(/\.md$/, '') + '，原文件备份在 ' + bak);
      noticeItems.push('命令 /' + n.replace(/\.md$/, '') + ' 你改过（或者是你自己的同名命令），这次换成了套件的。原文件备份在 ' + bak);
    }
    copyFile(path.join(SRC, 'claude', 'commands', n), d);
  }
  if (cmds.length) console.log('  [OK] 斜杠命令：' + cmds.map((n) => '/' + n.replace(/\.md$/, '')).join('  ') + '（敲了直接算你的许可，和说中文一样）');
  // 改名之前的、并进来之前单独装的：删掉。要在换掉 pristine 之前做
  const renamed = removeOldNames();
  const man0 = readManifest();
  const absorbed = removeAbsorbed(man0);
  // 留一份原样的副本，下次更新和卸载时用来判断你有没有改过
  removeDir(path.join(KIT, 'pristine'));
  copyDir(path.join(SRC, 'claude'), path.join(KIT, 'pristine'));
  console.log('  [OK] 技能：' + SKILLS.map((n) => '/' + n).join('  ') + '；审查代理：vk-reviewer');
  if (renamed.length) console.log('  [OK] 技能和代理改名了（统一 vk- 开头）：' + renamed.join('，') + '。旧名字的已经删掉');
  for (const a of absorbed) {
    console.log('  [OK] 以前单独装的 ' + a.name + ' 技能并进套件了，现在叫 ' + a.now + '。旧的挪到了 ' + a.backup + '（不会被自动删）');
    if (a.drivers.length) console.log('       它自带的驱动挪到了套件的驱动目录并登记好：' + a.drivers.map((u) => u.name + ' ' + path.basename(u.jar)).join('、'));
  }
  const openspecFiles = installOpenSpec(man0);
  const man = mergeSettings(s, false);
  man.openspec = openspecFiles;
  console.log('  [OK] 钩子：编码保护、提交检查、令牌保护、打断后提醒、会话开始核对项目说明和当前事实、收工检查');
  autoMemoryNote(mergeSettings.autoMemory);
  autoCompactNote(mergeSettings.autoCompact, s);
  ccAutoModeNote(mergeSettings.ccAutoMode);
  if (mergeSettings.javaOpts) { console.log('  [OK] ' + mergeSettings.javaOpts + '。改了系统里的值，下次更新时跟着重新算'); noticeItems.push(mergeSettings.javaOpts); }
  man.router = false;
  man.absorbed = man0.absorbed;
  saveManifest(man);
  // 版本号挪到安装收尾、全局约定写完之后再写（审核 P03）：以前在这里写，后面写约定的时候被打断，
  // 版本号已经是新的，自动更新就不再重装
}

async function finishInstall() {
if (!fs.existsSync(path.join(KIT, 'CLAUDE.md'))) { console.log('  [X] 还没安装过。到安装包目录里运行 node install.js'); process.exit(1); }
// --sync（配置页保存开关、本机环境也走这里）：全局 CLAUDE.md 不是 UTF-8 就什么都不动
if (mode === 'sync' && readGlobalMd().text === null) { explainNotUtf8('这次什么都没动：开关和本机环境已经存下了，但全局约定和钩子登记还是上次生成的，套件其余部分照常工作。转好之后运行 node "' + path.join(KIT, 'install.js') + '" --sync。'); process.exit(1); }
const block = buildBlock();
try { if (block.hookRules) writeAtomic(path.join(KIT, 'hook-rules.md'), block.hookRules + '\n'); else fs.rmSync(path.join(KIT, 'hook-rules.md'), { force: true }); } catch (e) { console.log('  [!] 进流程时送的规范（hook-rules.md）没写成：' + e.message); }
const changed = writeGlobalMd(block.text);
if (changed === null) { explainNotUtf8('全局约定没写进去；其余部分（钩子、技能、审查代理、状态栏、权限）都已经就位。转好之后运行 node "' + path.join(KIT, 'install.js') + '" --sync 补上。'); process.exitCode = 1; }
else console.log('  [OK] 全局约定' + (changed ? '已写入' : '没有变化') + '；启用的规范：' + (block.rules.length ? block.rules.join('，') : '（无）') + (block.mine.length ? '；你的补充（user/）：' + block.mine.join('，') : ''));
// 自动记忆的开关改了之后，settings.json 里的登记要跟着变
if (mode === 'sync') mergeSettings(readSettings(), false, true);
// 都装好了（约定也写了），最后写版本号
if (mode === 'install') {
  copyFile(path.join(SRC, 'kit', 'VERSION'), path.join(KIT, 'VERSION'));
  // 装完了记一笔：自动更新据此知道"装坏了、没装回去"之后有没有人重新装好过（复审 U-R3）。
  // notice：这次覆盖了你改过的东西、挪了你的补充，配置页提示一次（点"知道了"记下 noticeSeen）。自动更新时安装的输出只进日志，你看不到。
  // 上次的还没看过就并进来（最多留 20 条），不会被这一次盖掉
  try {
    const doneFile = path.join(KIT, 'state', 'install-done.json');
    const version = fs.readFileSync(path.join(SRC, 'kit', 'VERSION'), 'utf8').trim();
    let prev = {}; try { prev = JSON.parse(fs.readFileSync(doneFile, 'utf8')) || {}; } catch (e) { prev = {}; }
    const unseen = isObj(prev.notice) && Array.isArray(prev.notice.items) && !(Number(prev.noticeSeen) >= Number(prev.notice.at)) ? prev.notice.items.map(String) : [];
    const items = unseen.concat(noticeItems.filter((x) => !unseen.includes(x))).slice(-20);
    const rec = { version, at: Date.now() };
    if (items.length) rec.notice = { at: rec.at, version, items };
    fs.mkdirSync(path.join(KIT, 'state'), { recursive: true });
    writeAtomic(doneFile, JSON.stringify(rec));
    if (FIRST_INSTALL) writeAtomic(path.join(KIT, 'state', 'welcome.json'), JSON.stringify({ pending: true, at: rec.at }));
  } catch (e) { /* 记不了：状态栏可能多报一次装坏 */ }
}
const tail = () => {
  console.log('');
  console.log('  加规范、改约定：写在 ' + USER_DIR + ' 里的 .md（更新不碰；要去掉套件约定里的某一句，原样抄进那里的 remove.txt），再运行 node "' + path.join(KIT, 'install.js') + '" --sync');
  console.log('  钩子、约定和技能：已经开着的 Claude Code 不用重开，也不用 /clear。钩子立刻生效；约定和技能变了的部分，在你下一次发消息时由钩子带给它。开关在配置页改：敲 /vk-config。MCP 登记按上面的提示重新打开 Claude Code。');
};
// 手动安装：装完当场收回路由。自动更新不在这里收（VIBE_KIT_AUTO_UPDATE）：更新器还要自检，不过要装回旧版，等新代码第一次跑 session-start
if (mode === 'install' && !process.env.VIBE_KIT_AUTO_UPDATE) {
  try {
    const r = await require(path.join(KIT, 'lib', 'router-retire.js')).run();
    for (const n of r.notes) console.log('  [OK] ' + n);
    if (r.errors.length) console.log('  [!] 模型路由这次没收完，下次打开 Claude Code 再试：' + r.errors[0]);
  } catch (e) { console.log('  [!] 模型路由这次没收完，下次打开 Claude Code 再试：' + ((e && e.message) || e)); }
}
tail();
}
if (mode !== 'uninstall') finishInstall().catch((e) => { console.error('  [X] 安装收尾失败：' + e.message); process.exitCode = 1; });

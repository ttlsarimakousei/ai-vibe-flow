'use strict';
/*
 * 配置页的后端（lib/config-page.js 载它）："本机环境""套件开关"几页。
 *   本机环境 → ~/.claude/vibe-kit/local.json   各版本 JDK、Maven、Tomcat 在这台机器上的位置。保存后重新生成全局约定，Claude 每个会话都能看到
 *   套件开关 → ~/.claude/vibe-kit/config.json  自动验证、自动看页面、自动交叉审查、交接阈值
 *   问题反馈 → ~/.claude/vibe-kit/feedback/    只读：列表，每条带着上报了没有（记录由套件的钩子和 tools/feedback.js 写）。在"更新和上报"那一页显示
 *   更新和上报 → ~/.claude/vibe-kit/gitlab.json（仓库地址）、secrets.json（令牌，从不原样回给页面）；
 *                连 GitLab 的事（测试连接、检查更新、上报、导出）都起一个进程跑套件的 lib/updater.js，不在配置页的进程里等
 * 这些文件只在本机，不进任何仓库。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Worker } = require('worker_threads');

// 开关字段表（K1-4）：装好的在 ../lib，源码里在 ../kit/lib。默认值、清洗都从它来
const CF = (() => { for (const d of ['lib', 'kit/lib']) { const f = path.join(__dirname, '..', d, 'config-fields.js'); if (fs.existsSync(f)) return require(f); } throw new Error('找不到开关字段表 config-fields.js，重新运行安装包'); })();
const { DEFAULT_CONFIG } = CF;
const EMPTY_LOCAL = { jdks: [], defaultJdk: '', mavens: [], defaultMaven: '', tomcats: [], notes: '' };

function readJson(file, fallback) {
  try { let t = fs.readFileSync(file, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return Object.assign({}, fallback, JSON.parse(t)); } catch (e) { return Object.assign({}, fallback); }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const str = (x) => String(x == null ? '' : x).trim();
// 路径：资源管理器的"复制文件地址"复制出来的两头带着引号，粘进来照样认
const pathStr = (x) => str(x).replace(/^["']+|["']+$/g, '').trim();
function cleanLocal(x) {
  const pairs = (a) => (Array.isArray(a) ? a : []).map((p) => ({ name: str(p && p.name), path: pathStr(p && p.path) })).filter((p) => p.name && p.path);
  // Maven 可以配好几套（不同的 settings.xml、本地仓库、版本），每套一个名字；三个路径至少填一个
  let mavens = (Array.isArray(x && x.mavens) ? x.mavens : []).map((m) => ({ name: str(m && m.name), home: pathStr(m && m.home), settings: pathStr(m && m.settings), repo: pathStr(m && m.repo) })).filter((m) => m.name && (m.home || m.settings || m.repo));
  // 上一版只有一套，存在 maven 里：搬过来
  const old = (x && x.maven) || {};
  if (!mavens.length && (str(old.home) || str(old.settings) || str(old.repo))) mavens = [{ name: '默认', home: str(old.home), settings: str(old.settings), repo: str(old.repo) }];
  const jdks = pairs(x && x.jdks);
  const pick = (want, list) => (list.find((i) => i.name === want) ? want : (list[0] ? list[0].name : ''));
  return { jdks, defaultJdk: pick(str(x && x.defaultJdk), jdks), mavens, defaultMaven: pick(str(x && x.defaultMaven), mavens), tomcats: pairs(x && x.tomcats), notes: str(x && x.notes).slice(0, 2000) };
}
/** 清洗配置。base 是"不合法时用什么"：不给就是默认值；保存时给文件里现在的值，传进来的乱写的项保持原样，不会被改回默认 */
/** 自带的 OpenSpec 是哪一版、这台电脑能不能用（Node 版本够不够）。"套件说明"页上显示 */
function openspecInfo(kitDir) {
  try { const O = require(path.join(kitDir, 'lib', 'openspec.js')); const i = O.info(); return i ? { version: i.version, node: i.node, usable: O.usable() } : null; } catch (e) { return null; }
}
/**
 * 安装（自动更新也算）时覆盖了你改过的约定、规范、技能，或者把你改的内容挪进了 user/（F8，用户 2026-10-30 定的"配置页提示一次"）。
 * 安装器写在 state/install-done.json 的 notice 里；你点了"知道了"（noticeSeen 不早于这条）就不再给。没有返回 null
 */
function installNotice(kitDir) {
  const d = readJson(path.join(kitDir, 'state', 'install-done.json'), {});
  const n = d.notice;
  if (!n || typeof n !== 'object' || !Array.isArray(n.items) || !n.items.length || Number(d.noticeSeen) >= Number(n.at)) return null;
  return { at: Number(n.at) || 0, version: str(n.version), items: n.items.slice(-20).map((x) => str(x).slice(0, 600)) };
}
function cleanConfig(x, base) {
  const c = Object.assign({}, DEFAULT_CONFIG, base && typeof base === 'object' ? base : {});
  // 提示规则 2026-09-30 去掉了；维护套件的电脑 2026-10-01 起写死在套件的 lib/gitlab.js 里（不给别的电脑看到）：文件里以前存的不再写回去
  delete c.hints;
  delete c.maintainerHosts;
  CF.applyFields(c, x);
  // 只有旧名 autoMode、没有 autoApply 时按 autoMode 算，和钩子的 readConfig 同一条规则（2026-10-17 审核建议 19：原来钩子按开着、配置页显示关着）
  if (x && !Object.prototype.hasOwnProperty.call(x, 'autoApply') && typeof x.autoMode === 'boolean') c.autoApply = x.autoMode;
  c.autoMode = c.autoApply;
  // 上下文快满时怎么办（J2）：页面上的两项改了才写回文件里存的四项；页面给的值都从这四项算
  const before = CF.contextView(base && typeof base === 'object' ? Object.assign({}, DEFAULT_CONFIG, base) : DEFAULT_CONFIG);
  const [fa, fp] = CF.VIEW_FIELDS;
  const action = CF.accept(fa, x && x.contextAction);
  const percent = CF.accept(fp, x && x.contextPercent);
  if ((action !== undefined && action !== before.contextAction) || (percent !== undefined && percent !== before.contextPercent)) Object.assign(c, CF.contextFromView(action === undefined ? before.contextAction : action, percent === undefined ? before.contextPercent : percent));
  return Object.assign(c, CF.contextView(c));
}

// ---------- 自动探测 ----------
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch (e) { return []; } };
function jdkVersion(home) {
  try { const m = fs.readFileSync(path.join(home, 'release'), 'utf8').match(/JAVA_VERSION="([^"]+)"/); if (m) return m[1]; } catch (e) { /* 老 JDK 没有这个文件 */ }
  const m = path.basename(home).match(/(\d+(?:[._]\d+)*)/);
  return m ? m[1] : '';
}
const jdkMajor = (v) => { const m = String(v).match(/^1\.(\d+)/) || String(v).match(/^(\d+)/); return m ? m[1] : ''; };
function detect(kitDir) {
  const home = os.homedir();
  // IDEA 里配的最准（问题表第 33 条）：登记的 JDK、最近打开过的项目配的 Maven 和 settings.xml、本地仓库，排在最前面
  let idea = { mavens: [], jdks: [] };
  try { idea = require(path.join(kitDir, 'lib', 'idea-config.js')).machine(); } catch (e) { /* 老版本没有、读不了 */ }
  const isJdk = (d) => exists(path.join(d, 'bin', 'javac.exe')) || exists(path.join(d, 'bin', 'javac'));
  const found = new Map();
  const addJdk = (d) => { if (d && isJdk(d) && !found.has(d.toLowerCase())) found.set(d.toLowerCase(), d); };
  for (const j of idea.jdks) addJdk(j.home);
  for (const k of Object.keys(process.env)) if (/^(JAVA|JDK)[\w]*HOME$/i.test(k)) addJdk(process.env[k]);
  const roots = ['C:\\Program Files\\Java', 'C:\\Program Files (x86)\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Zulu', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\BellSoft', 'C:\\Java', 'D:\\Java', 'D:\\jdk', 'D:\\tools', 'D:\\soft', 'D:\\software', 'D:\\dev', 'D:\\develop', path.join(home, '.jdks'), '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const r of roots) for (const d of subdirs(r)) { addJdk(d); addJdk(path.join(d, 'Contents', 'Home')); }
  const jdks = [...found.values()].map((p) => { const v = jdkVersion(p); return { name: jdkMajor(v) || path.basename(p), path: p, version: v }; });

  const isMaven = (d) => exists(path.join(d, 'bin', 'mvn.cmd')) || exists(path.join(d, 'bin', 'mvn'));
  const mvnHomes = new Map();
  const addMaven = (d) => { d = String(d || '').replace(/[\\/]+$/, ''); if (d && isMaven(d) && !mvnHomes.has(d.toLowerCase())) mvnHomes.set(d.toLowerCase(), d); };
  for (const m of idea.mavens) addMaven(m.home);
  addMaven(process.env.MAVEN_HOME); addMaven(process.env.M2_HOME);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) if (dir && (exists(path.join(dir, 'mvn.cmd')) || exists(path.join(dir, 'mvn')))) addMaven(path.dirname(dir));
  for (const r of ['C:\\Program Files', 'D:\\Program Files', 'C:\\Program Files\\Apache Software Foundation', 'D:\\tools', 'D:\\soft', 'D:\\software', 'D:\\dev', 'D:\\develop', 'D:\\', 'C:\\', '/opt', '/usr/local']) for (const d of subdirs(r)) if (/maven/i.test(path.basename(d))) addMaven(d);
  const repoOf = (settings) => { try { const m = fs.readFileSync(settings, 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(/<localRepository>\s*([^<]+?)\s*<\/localRepository>/); if (m) return m[1]; } catch (e) { /* 读不了 */ } return ''; };
  const userSettings = exists(path.join(home, '.m2', 'settings.xml')) ? path.join(home, '.m2', 'settings.xml') : '';
  const mavens = [...mvnHomes.values()].map((h) => {
    const fromIdea = idea.mavens.find((m) => m.home.toLowerCase() === h.toLowerCase()) || {};
    const settings = fromIdea.settings || userSettings || (exists(path.join(h, 'conf', 'settings.xml')) ? path.join(h, 'conf', 'settings.xml') : '');
    const v = (path.basename(h).match(/(\d+(?:\.\d+)+)/) || [])[1] || path.basename(h);
    return { name: v, home: h, settings, repo: fromIdea.repo || (settings && repoOf(settings)) || (exists(path.join(home, '.m2', 'repository')) ? path.join(home, '.m2', 'repository') : '') };
  });

  const tomcats = [];
  const addTomcat = (d) => { if (d && (exists(path.join(d, 'bin', 'catalina.bat')) || exists(path.join(d, 'bin', 'catalina.sh')))) { const m = path.basename(d).match(/(\d+)(?:\.\d+)*/); if (!tomcats.find((t) => t.path === d)) tomcats.push({ name: m ? m[1] : path.basename(d), path: d }); } };
  addTomcat(process.env.CATALINA_HOME);
  for (const r of ['C:\\Program Files\\Apache Software Foundation', 'D:\\tools', 'D:\\soft', 'D:\\software', 'D:\\dev', 'D:\\develop', 'D:\\', 'C:\\']) for (const d of subdirs(r)) if (/tomcat/i.test(path.basename(d))) addTomcat(d);
  return { jdks, mavens, tomcats };
}

/**
 * 重新生成全局约定、重新登记钩子。用户目录按套件所在的位置定（kitDir 的上一层），不看这个进程自己的环境变量
 */
function sync(kitDir) {
  return new Promise((resolve) => {
    const script = path.join(kitDir, 'install.js');
    if (!fs.existsSync(script)) return resolve({ ok: false, output: '还没装 vibe-kit：已经保存了，但要装了套件才会生效' });
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: path.dirname(path.resolve(kitDir)) });
    // 配置页是 detached 起的、没有控制台：不写 windowsHide 的话，每保存一次配置桌面上就弹一个 node 窗口
    execFile(process.execPath, [script, '--sync'], { timeout: 30000, env, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, output: String(stdout || '') + String(stderr || '') }));
  });
}

function liveSessions(kitDir) {
  const out = [];
  try {
    const dir = path.join(kitDir, 'state');
    // 状态栏记的每个会话的用量：升级前的会话在 state/<会话号>.json，之后的在 state/session/<会话号>/context.json（K1-3）
    const files = fs.readdirSync(dir).filter((f) => /\.json$/.test(f) && f !== 'reviewed.json' && f !== 'gateway.json' && !/-hints\.json$/.test(f)).map((f) => ({ id: f.replace(/\.json$/, ''), file: path.join(dir, f) }));
    try { const sd = path.join(dir, 'session'); for (const sid of fs.existsSync(sd) ? fs.readdirSync(sd) : []) files.push({ id: sid, file: path.join(sd, sid, 'context.json') }); } catch (e) { /* 没有会话目录 */ }
    for (const x of files) {
      let s; try { s = JSON.parse(fs.readFileSync(x.file, 'utf8')); } catch (e) { continue; }
      if (!s || !(s.used > 0) || !(Date.now() - s.at < 2 * 3600000)) continue;
      out.push({ id: x.id.slice(0, 8), used: s.used, windowSize: s.windowSize || 0, cwd: String(s.cwd || ''), at: s.at });
    }
  } catch (e) { /* 还没有 */ }
  return out.sort((a, b) => b.at - a.at).slice(0, 8);
}

/**
 * 给配置页的"选目录"弹窗列目录。网页自己拿不到硬盘上的完整路径（浏览器的限制），后端就跑在本机，由它来列。
 * 只列名字，不读文件内容；接口只接受本机连接。顺手标出当前目录是不是一个 JDK / Maven / Tomcat，免得选错层级。
 */
function browse(dir, wantFile) {
  const fileRe = /\.xml$/i;
  const home = os.homedir();
  if (!dir) {
    const roots = [];
    if (process.platform === 'win32') { for (let c = 67; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; if (exists(d)) roots.push({ name: d, path: d, dir: true }); } }
    else roots.push({ name: '/', path: '/', dir: true });
    roots.push({ name: '我的用户目录', path: home, dir: true });
    return { dir: '', parent: '', entries: roots, marks: {} };
  }
  const abs = path.resolve(dir);
  let list = [];
  try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { throw new Error('打不开这个目录：' + abs); }
  const entries = [];
  for (const e of list) {
    if (e.name[0] === '$' || e.name === 'System Volume Information') continue;
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(abs, e.name)).isDirectory(); } catch (err) { continue; } }
    if (isDir) entries.push({ name: e.name, path: path.join(abs, e.name), dir: true });
    else if (wantFile && fileRe.test(e.name)) entries.push({ name: e.name, path: path.join(abs, e.name), dir: false });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  const has = (...p) => exists(path.join(abs, ...p));
  const up = path.dirname(abs);
  return { dir: abs, parent: up === abs ? '' : up, entries: entries.slice(0, 500),
    marks: { jdk: has('bin', 'javac.exe') || has('bin', 'javac'), maven: has('bin', 'mvn.cmd') || has('bin', 'mvn'), tomcat: has('bin', 'catalina.bat') || has('bin', 'catalina.sh'), repo: has('org') && has('com') } };
}

/** 工作线程里实际执行的那几件事（kit-worker.js 调它） */
function runOp(op, a) {
  if (op === 'readiness') { const f = path.join(a.kitDir, 'lib', 'readiness.js'); return require(f).inspect(a.project); }
  if (op === 'browse') return browse(a.dir, a.file);
  if (op === 'detect') return detect(a.kitDir);
  if (op === 'lessons') return lessonsOp(a);
  throw new Error('没有这个操作：' + op);
}

// ---------- 工作线程 ----------
/*
 * 选目录、自动探测、读驱动的登记表都是同步的文件操作，碰到断开的网络盘、很慢的磁盘会卡住几十秒。和接口在同一个线程里的话，
 * 这段时间所有请求都跟着卡住。所以放到一个工作线程里做；主线程只等 8 秒，超时就结束这个线程（下次重新建一个），告诉页面"超时"。
 * 被卡住的那个线程要等系统调用自己返回才会真正退出，但已经不挡任何东西了。
 */
const WORKER_FILE = path.join(__dirname, 'kit-worker.js');
const WORKER_TIMEOUT_MS = 8000;
let worker = null;
let seq = 0;
const pending = new Map();
function dropWorker(reason) {
  const w = worker;
  worker = null;
  if (w) { w.removeAllListeners(); w.on('error', () => {}); w.terminate().catch(() => {}); }
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  pending.clear();
}
function getWorker() {
  if (worker) return worker;
  const w = new Worker(WORKER_FILE);
  w.unref(); // 不因为它让配置页退不掉
  w.on('message', (m) => { const p = pending.get(m && m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error)); });
  w.on('error', (e) => { if (worker === w) dropWorker('后台线程出错：' + ((e && e.message) || e)); });
  w.on('exit', () => { if (worker === w) dropWorker('后台线程意外退出了，请再试一次'); });
  worker = w;
  return w;
}
function inWorker(op, args, what) {
  // 没带工作线程的脚本（只拷了 kit-api.js）就照旧在这里做
  if (!fs.existsSync(WORKER_FILE)) return Promise.resolve().then(() => runOp(op, args));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(what + '超时：8 秒还没做完（多半是碰到了断开的网络盘或很慢的磁盘），已经放弃。' + (what === '列目录' ? '换个目录再试' : '过一会儿再试一次')));
      dropWorker('前面的操作卡住了（多半是断开的网络盘），已经放弃，请再试一次');
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { getWorker().postMessage({ id, op, args }); } catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

async function handle(method, url, body, kitDir) {
  if (method === 'POST' && url === '/api/kit/readiness') { const project = pathStr(body && body.project); if (!project || !path.isAbsolute(project)) throw new Error('填写项目完整路径'); return inWorker('readiness', { kitDir, project }, '核对环境'); }
  if (method === 'POST' && url === '/api/kit/browse') return inWorker('browse', { dir: pathStr(body && body.dir), file: !!(body && body.file) }, '列目录');
  const localFile = path.join(kitDir, 'local.json');
  const configFile = path.join(kitDir, 'config.json');
  const installed = fs.existsSync(path.join(kitDir, 'install.js'));
  if (method === 'GET' && url === '/api/kit') {
    const config = cleanConfig(readJson(configFile, DEFAULT_CONFIG));
    // 文件里放松了保护、封条里没有（不是经配置页、安装器改的）：钩子按安全的值算，这里提醒用户核对后保存一次
    const seal = readJson(path.join(kitDir, 'state', 'config-seal.json'), {});
    const tampered = [];
    if (config.kitLock === false && seal.kitLock !== false) tampered.push('关掉"禁止 Claude 自己改套件"');
    if (config.kitBypass === 'auto' && seal.kitBypass !== 'auto') tampered.push('兜底放行"让它自己放行"');
    for (const [k, label] of [['autoRequirements', '需求自动模式'], ['autoApply', 'Apply 自动模式']]) if (config[k] === true && seal[k] === false) tampered.push('打开“' + label + '”');
    return { installed, kitDir, local: cleanLocal(readJson(localFile, EMPTY_LOCAL)), config, tampered, openspec: openspecInfo(kitDir), notice: installNotice(kitDir) };
  }
  // 安装时覆盖了你改过的东西、挪了你的补充（安装器写在 state/install-done.json 的 notice）：页面上点"知道了"之后不再提示
  if (method === 'POST' && url === '/api/kit/notice') {
    const f = path.join(kitDir, 'state', 'install-done.json');
    const d = readJson(f, {});
    if (d.notice && d.notice.at) { d.noticeSeen = Number(d.notice.at) || Date.now(); writeJson(f, d); }
    return { ok: true };
  }
  if (method === 'GET' && url === '/api/kit/sessions') return { sessions: liveSessions(kitDir) };
  if (method === 'GET' && url === '/api/kit/detect') return inWorker('detect', { kitDir }, '自动探测');
  if (method === 'POST' && url === '/api/kit/local') { writeJson(localFile, cleanLocal(body)); const r = await sync(kitDir); return { ok: true, synced: r.ok, output: r.output }; }
  // 只改传进来的字段：在文件里现有的配置上合并，再整体清洗。页面上"离开输入框就自动保存"的那几项只传它自己管的，
  // 别的开关不会被页面打开时的旧值改回去。有的开关要重新生成全局约定、重新登记钩子才生效（全自动模式、钩子跑的方式、自动记忆），所以保存后同步一次
  if (method === 'POST' && url === '/api/kit/config') {
    const inc = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const { cur, c } = mergeConfig(kitDir, inc);
    // 封条：三个放松保护的开关（关掉禁改、自动放行、全自动模式）只认这里和安装器改的，钩子拿它对照（见套件 lib/session.js 的 readConfig）
    try { fs.mkdirSync(path.join(kitDir, 'state'), { recursive: true }); fs.writeFileSync(path.join(kitDir, 'state', 'config-seal.json'), JSON.stringify({ kitLock: c.kitLock !== false, kitBypass: c.kitBypass, autoMode: c.autoApply === true, autoApply: c.autoApply === true, autoRequirements: c.autoRequirements === true, at: Date.now() })); } catch (e) { /* 记不了就按安全的值算 */ }
    auditLog(kitDir, cur, c);
    const r = await sync(kitDir);
    return { ok: true, synced: r.ok, output: r.output, config: c };
  }
  // 问题反馈：列表，每条带着上报了没有（对上的议题编号和链接）。2026-10-01 起在"更新和上报"那一页显示；导出汇总、清空去掉了：
  // 问题都自动上报成议题，维护的人在那台电脑上导出议题就行
  if (method === 'GET' && url === '/api/kit/feedback') {
    const fb = loadFeedback(kitDir);
    if (!fb) return { dir: path.join(kitDir, 'feedback'), records: [], missing: true };
    const recs = fb.listRecords();
    {
      // 列表里只列套件的问题。不算问题的（老版本自动记的"拦了 3 次"、配置页上改开关）不列
      const real = fb.isNoise ? recs.filter((r) => !fb.isNoise(r)) : recs;
      let upOf = () => null;
      try { const is = loadIssues(kitDir); if (is && is.uploadState) upOf = is.uploadState(); } catch (e) { /* 老版本没有 */ }
      const label = (h) => ((fb.BYPASSABLE[h] || {}).label || h || '').replace(/（.*$/, '');
      const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n) + '…' : t; };
      return {
        dir: fb.DIR,
        records: real.slice(0, 200).map((r) => ({ id: r.meta.id, time: r.meta['时间'], updated: r.meta['更新'], kind: r.meta['类型'], hook: r.meta['涉及'], source: r.meta['来源'], bypass: r.meta['放行'], count: Number(r.meta['次数']) || 1, title: r.title, project: r.meta['项目'], upload: upOf(r) })),
        passes: fb.bypassLog ? fb.bypassLog(30).map((p) => ({ at: p.at, hook: p.hook, label: label(p.hook), action: clip(p.action, 90), why: clip(fb.redact(p.why), 200), uses: p.uses || 0, fid: p.fid || '' })) : [],
        stats: fb.blockStats ? fb.blockStats(15).map((x) => ({ hook: x.hook, label: label(x.hook), count: x.count, sessions: (x.sessions || []).length, at: x.at, example: clip(x.example, 160) })) : [],
        audit: fb.auditList ? fb.auditList().slice(0, 20) : [],
        tools: toolUsage(kitDir),
      };
    }
  }
  // 更新和上报
  if (/^\/api\/kit\/remote(\/|\?|$)/.test(url)) return remote(method, url, body, kitDir);
  // 经验规则：各项目和用户级现在生效的规则、候选、等确认升用户级的。升用户级、删、改字只有这里能做（命令行工具里没有，模型做不了）
  if (url === '/api/kit/lessons' && method === 'GET') return inWorker('lessons', { kitDir, action: 'list' }, '读经验规则');
  if (method === 'POST' && /^\/api\/kit\/lessons\/(promote|dismiss|edit|remove|add|promote-candidate)$/.test(url)) {
    return inWorker('lessons', { kitDir, action: url.split('/').pop(), id: str(body && body.id), scope: body && body.scope === 'user' ? 'user' : 'project', root: str(body && body.root), text: str(body && body.text), group: str(body && body.group), ext: str(body && body.ext) }, '改经验规则');
  }
  throw new Error('没有这个接口');
}
// ---------- 更新和上报 ----------
/** 套件里管 GitLab、更新、上报的那几份代码（每次现读：装了新版不用重启配置页）。老版本没有的返回 null */
function loadRemote(kitDir) {
  const lib = path.join(kitDir, 'lib');
  if (!fs.existsSync(path.join(lib, 'updater.js')) || !fs.existsSync(path.join(lib, 'gitlab.js'))) return null;
  for (const m of ['updater.js', 'issues.js', 'gitlab.js', 'feedback.js', 'session.js']) { try { delete require.cache[require.resolve(path.join(lib, m))]; } catch (e) { /* 没载入过 */ } }
  return { gl: require(path.join(lib, 'gitlab.js')), up: require(path.join(lib, 'updater.js')), is: require(path.join(lib, 'issues.js')), session: require(path.join(lib, 'session.js')) };
}
/** 起一个进程跑套件的 lib/updater.js <命令>，把它写出来的那一行 JSON 拿回来。没有窗口 */
function runKit(kitDir, args, timeoutMs) {
  return new Promise((resolve) => {
    const script = path.join(kitDir, 'lib', 'updater.js');
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: path.dirname(path.resolve(kitDir)) });
    execFile(process.execPath, [script].concat(args), { timeout: timeoutMs, env, windowsHide: true, cwd: kitDir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let j = null;
      try { j = JSON.parse(line); } catch (e) { /* 不是 JSON */ }
      if (j && typeof j === 'object') return resolve(j);
      resolve({ ok: false, failed: true, why: err && err.killed ? '等了 ' + Math.round(timeoutMs / 1000) + ' 秒还没结果，先停了' : '没跑出结果' + (err ? '：' + String(err.message).split('\n')[0].slice(0, 200) : ''), detail: String(stderr || '').slice(0, 500) });
    });
  });
}
function remoteView(r, light) {
  const cfg = r.session.readConfig();
  const out = { settings: r.gl.publicSettings(), update: r.up.status(), maintainer: r.gl.isMaintainer(), version: r.up.installedVersion(), config: { autoUpdate: r.up.modeOf(cfg), updateCheckHours: r.up.hoursOf(cfg), updateEarly: cfg.updateEarly === true, issueUpload: cfg.issueUpload === 'off' ? 'off' : 'on', sshToken: cfg.sshToken === 'off' ? 'off' : 'auto', usageReport: cfg.usageReport === 'off' ? 'off' : 'on' } };
  if (!light) out.issues = Object.assign(r.is.summary(), { lastExport: r.is.lastExport() });
  return out;
}
async function remote(method, url, body, kitDir) {
  const r = loadRemote(kitDir);
  if (!r) return { missing: true };
  const p = url.replace(/^\/api\/kit\/remote/, '').replace(/\?.*$/, '');
  if (method === 'GET' && p === '') return remoteView(r, false);
  // 页面隔几秒来问一次进度：只给更新的情况，不去数问题反馈
  if (method === 'GET' && p === '/status') return remoteView(r, true);
  if (method === 'GET' && p === '/usage/preview') return Object.assign({ usage: await runKit(kitDir, ['usage-preview'], 60000) }, remoteView(loadRemote(kitDir), true));
  if (method !== 'POST') throw new Error('没有这个接口');
  if (p === '/settings') {
    // 令牌：没传就不动；传空串是清掉。填了什么都不回给页面，只说有没有、遮过的样子
    const x = {};
    for (const k of ['repo', 'sshRepo', 'branch']) if (body && body[k] !== undefined) x[k] = str(body[k]);
    if (body && body.token !== undefined) x.token = str(body.token);
    if (body && typeof body.verifyCert === 'boolean') x.verifyCert = body.verifyCert;
    r.gl.saveSettings(x);
    return Object.assign({ ok: true }, remoteView(loadRemote(kitDir), true));
  }
  if (p === '/test') return Object.assign({ test: await runKit(kitDir, ['diagnose'], 120000) }, remoteView(loadRemote(kitDir), true));
  if (p === '/mint') return Object.assign({ mint: await runKit(kitDir, ['mint'], 90000) }, remoteView(loadRemote(kitDir), true));
  if (p === '/check') { const c = await runKit(kitDir, ['check'], 600000); return Object.assign({ check: c }, remoteView(loadRemote(kitDir), true)); }
  // 固定在这一版、跳过这一版（K2）：版本号由这里定（固定的是装着的，跳过的是仓库里现在的），页面只说开还是关。
  // 不用重新生成全局约定，只改配置
  if (p === '/pin' || p === '/skip') {
    const on = !!(body && body.on);
    const u = r.up.status();
    if (on && r.up.lockHeld()) throw new Error('后台正在检查或更新，等它跑完再点');
    let inc;
    if (p === '/pin') {
      if (on && u.broken) throw new Error('这一版没装好，不能固定。先重新运行安装包，或者等后台装回上一版');
      if (on && !u.installed) throw new Error('这台电脑上的套件没有版本号，不能固定');
      inc = { updatePin: on ? u.installed : '' };
    } else {
      if (on && !(u.differs && u.remote)) throw new Error('仓库里的和装着的一样，没有可跳过的版本');
      inc = { updateSkip: on ? u.remote : '' };
    }
    const { cur, c } = mergeConfig(kitDir, inc);
    auditLog(kitDir, cur, c);
    return Object.assign({ ok: true }, remoteView(loadRemote(kitDir), true));
  }
  if (p === '/apply') {
    // 固定着的不装：页面上按钮是灰的，这里再挡一次
    const pinned = r.up.status().pin;
    if (pinned) return Object.assign({ started: false, why: '固定在 ' + pinned + '，不更新。要更新先点"取消固定"' }, remoteView(r, true));
    // 更新进程独立于配置页，甩到后台，页面自己隔几秒来问进度
    if (r.up.lockHeld()) return Object.assign({ started: false, why: '已经有一个在跑了' }, remoteView(r, true));
    r.up.spawnBackground(['apply']);
    return Object.assign({ started: true }, remoteView(r, true));
  }
  if (p === '/issues/sync') return Object.assign({ sync: await runKit(kitDir, ['issues-sync'], 300000) }, remoteView(loadRemote(kitDir), false));
  // 导出：只把开放中的议题合成一份 .md 交给页面，由浏览器下载，本机不存；页面交给浏览器之后再调 /issues/close 关掉这一批
  if (p === '/issues/export') {
    if (!r.gl.isMaintainer()) throw new Error('只有维护套件的那台电脑能导出议题');
    const e = await runKit(kitDir, ['issues-export'], 600000);
    return Object.assign({ export: e }, remoteView(loadRemote(kitDir), false));
  }
  if (p === '/issues/close') {
    if (!r.gl.isMaintainer()) throw new Error('只有维护套件的那台电脑能关掉议题');
    const iids = (Array.isArray(body && body.iids) ? body.iids : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
    const name = str(body && body.name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '').slice(0, 80);
    // 没有问题议题（只有使用情况）也调一次：记下"这一次导出交出去了"，下次导出的使用情况从这里算起
    if (!iids.length && !name) throw new Error('没说关哪几条');
    const c = await runKit(kitDir, ['issues-close', iids.length ? iids.join(',') : '-'].concat(name ? ['--name', name] : []), 600000);
    return Object.assign({ close: c }, remoteView(loadRemote(kitDir), false));
  }
  // 使用情况：今天攒到的、要传的是什么样子（给用户看一眼，心里有数）；立即把过完了的日子传上去
  if (p === '/usage/preview') return Object.assign({ usage: await runKit(kitDir, ['usage-preview'], 60000) }, remoteView(loadRemote(kitDir), true));
  if (p === '/usage/sync') return Object.assign({ usageSync: await runKit(kitDir, ['usage-sync'], 300000) }, remoteView(loadRemote(kitDir), false));
  throw new Error('没有这个接口');
}

/** 经验规则的几个操作（在工作线程里跑：项目可能在断开的网络盘上）。做完都返回最新的全貌，页面直接重画 */
function lessonsOp(a) {
  const ls = loadLessons(a.kitDir);
  if (!ls) return { missing: true, user: [], projects: [], pending: [], settings: {} };
  if (a.action === 'list') return ls.overview();
  let r = { ok: false, msg: '没有这个操作' };
  if (a.action === 'promote') r = ls.promoteUser(a.id);
  else if (a.action === 'dismiss') r = ls.dismissUser(a.id);
  else if (a.action === 'edit' || a.action === 'remove') {
    // 项目级的只许动记录里有的项目（配置页上列出来的那些），不接受任意路径
    if (a.scope !== 'user' && !ls.overview().projects.some((p) => p.root === a.root)) throw new Error('不认识这个项目：' + a.root);
    r = ls.editRule(a.scope, a.root, a.id, a.action === 'remove' ? null : a.text);
  } else if (a.action === 'add' || a.action === 'promote-candidate') {
    // 人加的（K3 M11）：项目级的只许写配置页能选到的项目，不接受任意路径
    if ((a.action === 'promote-candidate' || a.scope !== 'user') && !ls.projectChoices().some((p) => p.root === a.root)) throw new Error('不认识这个项目：' + a.root);
    r = a.action === 'add' ? ls.addByHand(a) : ls.promoteCandidate(a.root, a.id);
  }
  if (!r.ok) throw new Error(r.msg || '没做成');
  return Object.assign({ ok: true, done: a.action, file: r.file || '' }, ls.overview());
}
/** 套件里管经验规则的那一份代码（每次现读：装了新版不用重启配置页）。没装套件、老版本没有的返回 null */
function loadLessons(kitDir) {
  const f = path.join(kitDir, 'lib', 'lessons.js');
  if (!fs.existsSync(f)) return null;
  for (const m of ['lessons.js', 'session.js']) { try { delete require.cache[require.resolve(path.join(kitDir, 'lib', m))]; } catch (e) { /* 没载入过 */ } }
  return require(f);
}
/**
 * 放松保护的开关（关掉禁改、改成自动放行、打开全自动）被改了：记一笔（state/config-audit.json），配置页"套件开关"那一页最下面能看到。
 * 配置页是用户点的，但接口也可能被绕过检查的程序调到——事后能看到是什么时候改的。
 * 以前记在问题反馈里：那是用户自己点的，不是套件的问题，导出的汇总里全是这种就没法看了
 */
/**
 * 在文件里现有的配置上合并传进来的字段、整体清洗、写回。返回改之前和改之后的。
 * 拿锁写，免得几个页面同时写互相盖掉。拿不到锁照样写（老版本的套件没有 state-store）
 */
function mergeConfig(kitDir, inc) {
  const configFile = path.join(kitDir, 'config.json');
  let lock = null;
  try { lock = require(path.join(kitDir, 'lib', 'state-store.js')).acquire(configFile + '.lock', { waitMs: 3000 }); } catch (e) { lock = null; }
  try {
    const cur = cleanConfig(readJson(configFile, DEFAULT_CONFIG));
    const c = cleanConfig(Object.assign({}, cur, inc), cur);
    // 页面上的两项（J2）不存：文件里只有算它们用的四项，手改那四项才算数
    const saved = Object.assign({}, c);
    for (const f of CF.VIEW_FIELDS) delete saved[f.name];
    writeJson(configFile, saved);
    return { cur, c };
  } finally { if (lock) lock.release(); }
}
function auditLog(kitDir, before, after) {
  const changed = [];
  if (before.kitLock !== false && after.kitLock === false) changed.push('关掉了"禁止 Claude 自己改套件"');
  if (before.kitLock === false && after.kitLock !== false) changed.push('打开了"禁止 Claude 自己改套件"');
  if (before.kitBypass !== after.kitBypass) changed.push('被拦住时的放行改成了"' + ({ ask: '问我', auto: '让它自己放行', off: '不许放行' }[after.kitBypass] || after.kitBypass) + '"');
  for (const [k, label] of [['autoRequirements', '需求自动模式'], ['autoApply', 'Apply 自动模式']]) if (before[k] !== after[k]) changed.push((after[k] ? '打开了' : '关掉了') + label);
  if (!changed.length) return;
  try {
    const fb = loadFeedback(kitDir);
    if (fb && fb.audit) fb.audit('配置页' + changed.join('、'), '经配置页的接口改的。不是你自己点的，说明有程序调了配置页的接口。');
  } catch (e) { /* 记不了不影响保存 */ }
}
/** 查库、查 redis 的工具用得怎么样：{ stats, hints }。老版本没有的返回空的 */
function toolUsage(kitDir) {
  const f = path.join(kitDir, 'lib', 'toolstats.js');
  if (!fs.existsSync(f)) return { stats: [], hints: [] };
  try {
    for (const m of ['toolstats.js', 'session.js', 'feedback.js']) { try { delete require.cache[require.resolve(path.join(kitDir, 'lib', m))]; } catch (e) { /* 没载入过 */ } }
    const ts = require(f);
    ts.ingest(null);
    return { stats: ts.stats(30), hints: ts.hints() };
  } catch (e) { return { stats: [], hints: [] }; }
}
/** 套件里记问题反馈的那一份代码（每次现读：装了新版不用重启配置页）。没装套件、老版本没有的返回 null */
function loadFeedback(kitDir) {
  const f = path.join(kitDir, 'lib', 'feedback.js');
  if (!fs.existsSync(f)) return null;
  for (const m of ['feedback.js', 'session.js']) { try { delete require.cache[require.resolve(path.join(kitDir, 'lib', m))]; } catch (e) { /* 没载入过 */ } }
  return require(f);
}
/** 套件里管上报的那一份代码（问题列表要标上报了没有）。老版本没有的返回 null */
function loadIssues(kitDir) {
  const f = path.join(kitDir, 'lib', 'issues.js');
  if (!fs.existsSync(f)) return null;
  for (const m of ['issues.js', 'gitlab.js', 'feedback.js', 'session.js']) { try { delete require.cache[require.resolve(path.join(kitDir, 'lib', m))]; } catch (e) { /* 没载入过 */ } }
  return require(f);
}

module.exports = { handle, detect, browse, runOp, sync, cleanLocal, cleanConfig, DEFAULT_CONFIG, EMPTY_LOCAL };

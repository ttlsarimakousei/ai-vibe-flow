'use strict';
/*
 * 数据库驱动（JDBC 的 jar）。ttls-db-crud 连库要用。
 *
 * 驱动不随安装包带：达梦、神通、金仓、Oracle 的驱动是厂商的，只限内部用。每台电脑自己备：
 *   配置页"数据库驱动"那一页："自动搜索"按"本机环境"里配的 Maven 本地仓库找；每种数据库那一行后面的"换驱动"自己选一个 jar
 *   命令行：node tools/drivers.js auto / scan / use <jar> / list
 *
 * 放在哪：
 *   ~/.claude/vibe-kit/drivers.json      登记表：每种数据库的多个版本和默认 jar。Python 按当前项目声明选择，旧格式仍能读取
 *   ~/.claude/vibe-kit/drivers/          选中的 jar 拷一份放这里（Maven 仓库被清了也不受影响）
 * 这两样装新版、卸载都不删。
 *
 * 认一个 jar 是哪种数据库的驱动：看 jar 里有没有那个驱动类，不只看文件名（公司私服上厂商驱动的名字五花八门）。
 * 到仓库里找的时候不是每个 jar 都打开：常见坐标下面的都打开看；别处的，名字像驱动（带 jdbc、driver、connector，或者认得的名字）才打开。
 *
 * 自动登记挑哪一个（auto）：
 *   1. 项目的 pom 里写明了版本的那一个（它和项目实际连的库对得上：Oracle 11.2 的库用太新的驱动连不上）
 *   2. 查库用的 JDK 加载得了的里面最新的（ojdbc11 要 Java 11，默认 JDK 是 8 的话加载不了）
 * 用户在配置页里去掉的那一种，后台自动探索不再登记回来；用户自己点"自动搜索"、自己选 jar 的照常登记。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// 和套件别的库一样，按自己所在的位置定套件目录（lib 的上一层），不看环境变量
const KIT = path.join(__dirname, '..');
const REGISTRY = path.join(KIT, 'drivers.json');
const STORE = path.join(KIT, 'drivers');

// 和 ttls-db-crud 的 scripts/dbconf.py 里的 DIALECT_INFO 对着：加一种数据库两边都要加
const DIALECTS = {
  dm: { name: '达梦', url: 'jdbc:dm:', names: [/dm\d*-?jdbc-?driver/i, /^dm\d*\.jar$/i, /dameng/i], classes: ['dm/jdbc/driver/DmDriver.class'] },
  oscar: { name: '神通', url: 'jdbc:oscar:', names: [/oscar/i, /shentong/i], classes: ['com/oscar/Driver.class'] },
  mysql: { name: 'MySQL', url: 'jdbc:mysql:', names: [/mysql-connector/i, /mysql.*jdbc/i], classes: ['com/mysql/cj/jdbc/Driver.class', 'com/mysql/jdbc/Driver.class'] },
  oracle: { name: 'Oracle', url: 'jdbc:oracle:', names: [/ojdbc/i], classes: ['oracle/jdbc/OracleDriver.class', 'oracle/jdbc/driver/OracleDriver.class'] },
  kingbase: { name: '人大金仓', url: 'jdbc:kingbase8:', names: [/kingbase/i, /^kes[-_]?jdbc/i], classes: ['com/kingbase8/Driver.class', 'com/kingbase/Driver.class'] },
  // 连接串写成 jdbc:postgresql 的（金仓也常这么配）要 PostgreSQL 的驱动，金仓的驱动不认这个前缀。SQL 的写法仍按金仓走
  postgresql: { name: 'PostgreSQL', url: 'jdbc:postgresql:', names: [/postgresql/i, /^pgjdbc/i], classes: ['org/postgresql/Driver.class'] },
};
// Maven 仓库里这些坐标下面常放着驱动：先看这里，几十毫秒就有结果；公司私服上换了坐标的靠后面的整仓扫描
const KNOWN_DIRS = ['mysql/mysql-connector-java', 'com/mysql/mysql-connector-j', 'com/oracle', 'com/oracle/database/jdbc', 'com/oracle/ojdbc', 'oracle', 'com/dameng', 'com/dm', 'dm', 'cn/com/kingbase', 'com/kingbase8', 'com/kingbase', 'kingbase', 'com/oscar', 'com/shentong', 'oscar', 'cn/com/oscar', 'org/postgresql'];
// 名字里带这些的也打开看一眼（私服上改过名的：dm-jdbc-8.1.jar、kes-jdbc.jar）
const LOOKS_LIKE_DRIVER = /jdbc|driver|connector/i;

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const unquotePath = (p) => String(p == null ? '' : p).trim().replace(/^["']+|["']+$/g, '').trim();
const abs0 = (p) => path.resolve(String(p));
const samePath = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();

// ---------- 读 jar（zip）：只要文件清单和清单文件，自己解析，不引第三方库 ----------
/** jar 里的文件清单：{ 名字: { method, csize, size, offset } }。不是 zip、读不了返回 null */
function zipEntries(buf) {
  const EOCD = 0x06054b50;
  let p = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === EOCD) { p = i; break; }
  if (p < 0) return null;
  const total = buf.readUInt16LE(p + 10);
  let off = buf.readUInt32LE(p + 16);
  const out = {};
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return n ? out : null;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    out[name] = { method, csize, size, offset: local };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function zipRead(buf, e) {
  if (!e || e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const raw = buf.slice(start, start + e.csize);
  try { return e.method === 0 ? raw : e.method === 8 ? zlib.inflateRawSync(raw) : null; } catch (err) { return null; }
}
const MAX_JAR = 64 * 1024 * 1024;
/**
 * 看一个 jar：是哪种数据库的驱动、什么版本。
 * 返回 { ok, dialect, driverClass, version, size, why }。不是驱动的 ok 为 false，why 里说原因
 */
function inspect(jar) {
  let st;
  try { st = fs.statSync(jar); } catch (e) { return { ok: false, why: '文件不存在：' + jar }; }
  if (!st.isFile()) return { ok: false, why: '不是文件：' + jar };
  if (!/\.jar$/i.test(jar)) return { ok: false, why: '不是 jar 文件：' + path.basename(jar) };
  if (st.size > MAX_JAR) return { ok: false, why: '文件太大（' + Math.round(st.size / 1048576) + ' MB），不像是驱动' };
  let buf;
  try { buf = fs.readFileSync(jar); } catch (e) { return { ok: false, why: '读不了：' + e.message }; }
  const entries = zipEntries(buf);
  if (!entries) return { ok: false, why: '打不开（不是一个完整的 jar）：' + path.basename(jar) };
  let dialect = '';
  let cls = '';
  for (const k of Object.keys(DIALECTS)) {
    const hit = DIALECTS[k].classes.find((c) => entries[c]);
    if (hit) { dialect = k; cls = hit.replace(/\.class$/, '').split('/').join('.'); break; }
  }
  if (!dialect) return { ok: false, size: st.size, why: '里面没有达梦、神通、MySQL、Oracle、人大金仓、PostgreSQL 的驱动类：' + path.basename(jar) };
  // 驱动类是按哪个版本的 Java 编的（class 文件第 7、8 字节，52 = Java 8）：比查库用的 JDK 新就加载不了
  let java = 0;
  try { const c = zipRead(buf, entries[cls.split('.').join('/') + '.class']); if (c && c.length > 8 && c.readUInt32BE(0) === 0xCAFEBABE) java = Math.max(0, c.readUInt16BE(6) - 44); } catch (e) { java = 0; }
  // 版本：Maven 的目录结构（…/<版本>/<名字>-<版本>.jar）里目录名就是版本；不是的话看清单文件，再不行看文件名。
  // 清单里的 Specification-Version 是 JDBC 规范的版本（4.2 这种），不是驱动的版本，不用它
  let version = '';
  const base = path.basename(abs0(jar));
  const parent = path.basename(path.dirname(abs0(jar)));
  if (/^\d/.test(parent) && base.toLowerCase().includes(parent.toLowerCase())) version = parent;
  if (!version) {
    const mf = zipRead(buf, entries['META-INF/MANIFEST.MF']);
    const t = mf ? mf.toString('utf8') : '';
    for (const h of ['Implementation-Version', 'Bundle-Version']) {
      const m = new RegExp('^' + h + '\\s*:\\s*(.+)$', 'im').exec(t);
      const v = m && /\d+(?:\.\d+)+[\w.-]*/.exec(m[1]);
      if (v) { version = v[0]; break; }
    }
  }
  if (!version) { const m = /[-_](\d+(?:\.\d+)+[\w.-]*?)\.jar$/i.exec(base); if (m) version = m[1]; }
  return { ok: true, dialect, driverClass: cls, version: version.slice(0, 40), size: st.size, java };
}

// ---------- 登记表 ----------
function readRaw() {
  try {
    let t = fs.readFileSync(REGISTRY, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return isObj(j) ? j : {};
  } catch (e) { return {}; }
}
function readRegistry() {
  const d = isObj(readRaw().drivers) ? readRaw().drivers : {};
  const out = {};
  for (const k of Object.keys(DIALECTS)) if (isObj(d[k]) && typeof d[k].jar === 'string' && d[k].jar) out[k] = d[k];
  return out;
}
/** 旧表的一条就是一个候选；新表同一种数据库保留多个版本，jar 表示默认。 */
function variants(rec) {
  const list = rec && Array.isArray(rec.versions) ? rec.versions : (rec && rec.jar ? [rec] : []);
  return list.filter((x) => isObj(x) && typeof x.jar === 'string' && x.jar).map((x) => { const v = Object.assign({}, x); delete v.versions; return v; });
}
/** 用户在配置页里去掉过的那几种数据库：后台自动探索不再自动登记回来 */
function removedByUser() {
  const r = readRaw().removed;
  return isObj(r) ? Object.keys(r).filter((k) => DIALECTS[k]) : [];
}
function writeRegistry(drivers, removed) {
  fs.mkdirSync(KIT, { recursive: true });
  const keep = removed || (isObj(readRaw().removed) ? readRaw().removed : {});
  for (const k of Object.keys(keep)) if (drivers[k]) delete keep[k];
  const tmp = REGISTRY + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 2, note: '每种数据库可登记多个版本；jar 是默认，项目声明版本时按项目选择。', drivers, removed: keep }, null, 2) + '\n');
  try { fs.renameSync(tmp, REGISTRY); } catch (e) { fs.writeFileSync(REGISTRY, fs.readFileSync(tmp)); try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ } }
}
/**
 * 读登记表、改、写回这一段独占着做（Codex 审核 C10）：配置页、后台探索、命令行几个进程同时登记时，以前各读各的旧表再写回，
 * 后写的盖掉先写的，登记的版本、默认版本、"用户去掉过"的标记会丢。锁 5 秒拿不到照旧做（不能因为锁把登记卡死），记一行日志
 */
function locked(fn) {
  let lock = null;
  try { lock = require('./state-store').acquire(REGISTRY + '.lock', { waitMs: 5000 }); } catch (e) { lock = null; }
  if (!lock) { try { require('./session').hookLog('drivers 登记表的锁 5 秒没拿到，照旧写'); } catch (e) { /* 记不了就算了 */ } }
  try { return fn(); } finally { if (lock) lock.release(); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

/**
 * 用这个 jar。先认它是哪种数据库的驱动（dialect 给了就必须对得上），拷进套件的驱动目录，登记。
 * from：maven（Maven 仓库里找到的）、manual（自己选的）、rescue（从旧技能的 drivers 目录里挪过来的）
 */
function use(jar, o) {
  const opt = o || {};
  // 资源管理器的"复制文件地址"复制出来的路径两头带着引号
  const abs = path.resolve(unquotePath(jar));
  const info = inspect(abs);
  if (!info.ok) return { ok: false, msg: info.why };
  if (opt.dialect && opt.dialect !== info.dialect) return { ok: false, msg: '这是' + DIALECTS[info.dialect].name + '的驱动，不是' + ((DIALECTS[opt.dialect] || {}).name || opt.dialect) + '的：' + path.basename(abs) };
  fs.mkdirSync(STORE, { recursive: true });
  let dst = path.join(STORE, path.basename(abs));
  // 已经在驱动目录里的就地用；同名不同内容的，新的带上版本号另存，不盖掉旧的（别的数据库可能还登记着它）
  if (!samePath(path.dirname(abs), STORE)) {
    if (fs.existsSync(dst) && sha1(dst) !== sha1(abs)) dst = path.join(STORE, path.basename(abs, '.jar') + '-' + sha1(abs).slice(0, 8) + '.jar');
    if (!fs.existsSync(dst)) fs.copyFileSync(abs, dst);
  }
  const entry = { jar: dst, from: opt.from || 'manual', source: abs, version: info.version, driverClass: info.driverClass, size: info.size, java: info.java || 0, at: Date.now() };
  locked(() => {
    const reg = readRegistry();
    const list = variants(reg[info.dialect]).filter((x) => !samePath(x.jar, dst));
    list.push(entry);
    const def = opt.keepDefault && reg[info.dialect] ? Object.assign({}, reg[info.dialect]) : entry;
    reg[info.dialect] = Object.assign({}, def, { versions: list });
    writeRegistry(reg);
  });
  const jdk = jdkMajor();
  const warn = info.java && jdk && info.java > jdk ? '。★ 这个驱动要 Java ' + info.java + ' 以上，"本机环境"里默认的 JDK 是 ' + jdk + '：查库会加载不了它，换一个老一点的驱动，或者把默认的 JDK 换成新的' : '';
  return { ok: true, dialect: info.dialect, name: DIALECTS[info.dialect].name, jar: dst, version: info.version, java: info.java || 0, msg: DIALECTS[info.dialect].name + '的驱动登记好了：' + path.basename(dst) + (info.version ? '（' + info.version + '）' : '') + warn };
}
/** 不用了：从登记表里去掉，并记下"用户去掉过"。jar 留在驱动目录里不删（别的数据库没登记它、你想删就自己删） */
function remove(dialect, jar) { return locked(() => removeLocked(dialect, jar)); }
function removeLocked(dialect, jar) {
  const reg = readRegistry();
  if (!reg[dialect]) return { ok: false, msg: '这种数据库没有登记驱动：' + dialect };
  if (jar) {
    if (!variants(reg[dialect]).some((x) => samePath(x.jar, jar))) return { ok: false, msg: '这个版本没有登记，其他版本没动。' };
    const list = variants(reg[dialect]).filter((x) => !samePath(x.jar, jar));
    if (list.length) {
      const def = list.find((x) => samePath(x.jar, reg[dialect].jar)) || list[0];
      reg[dialect] = Object.assign({}, def, { versions: list });
      writeRegistry(reg);
      return { ok: true, msg: '已去掉这个版本，其他版本保留。' };
    }
  }
  delete reg[dialect];
  const removed = isObj(readRaw().removed) ? readRaw().removed : {};
  removed[dialect] = Date.now();
  writeRegistry(reg, removed);
  return { ok: true, msg: (DIALECTS[dialect] || {}).name + '的驱动从登记表里去掉了。后台自动探索不会再自动登记它；要用的时候点"自动搜索"，或者点这一行的"选驱动"自己选一个 jar。' };
}
/** 查库用的 JDK 是 Java 几（"本机环境"里默认的那个，读它的 release 文件）。不知道返回 0 */
function jdkMajor() {
  try {
    const l = readLocal();
    const jdks = (Array.isArray(l.jdks) ? l.jdks : []).filter((j) => isObj(j) && j.path);
    const def = jdks.find((j) => String(j.name) === String(l.defaultJdk)) || jdks[0];
    if (!def) return 0;
    let v = '';
    try { v = (/^JAVA_VERSION\s*=\s*"?([^"\r\n]+)/m.exec(fs.readFileSync(path.join(String(def.path), 'release'), 'utf8')) || [])[1] || ''; } catch (e) { v = ''; }
    if (!v) v = String(def.name || '');
    const m = /^(?:1\.)?(\d+)/.exec(v.trim());
    return m ? Number(m[1]) : 0;
  } catch (e) { return 0; }
}

// ---------- Maven 本地仓库 ----------
function readLocal() {
  try { let t = fs.readFileSync(path.join(KIT, 'local.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); const j = JSON.parse(t); return isObj(j) ? j : {}; } catch (e) { return {}; }
}
function repoOfSettings(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(/<localRepository>\s*([^<]+?)\s*<\/localRepository>/);
    if (!m) return '';
    return m[1].replace(/\$\{user\.home\}/g, os.homedir()).replace(/\$\{env\.([A-Za-z0-9_]+)\}/g, (x, n) => process.env[n] || x);
  } catch (e) { return ''; }
}
/**
 * 这台电脑上的 Maven 本地仓库：[{ dir, from }]。
 * 先看配置页"本机环境"里配的每一套 Maven（填了本地仓库的用它，只填了 settings.xml 的读里面的 localRepository），
 * 再看用户目录的 ~/.m2/settings.xml 和默认的 ~/.m2/repository。不存在的目录不算
 */
function mavenRepos() {
  const out = [];
  const add = (dir, from) => {
    if (!dir) return;
    const abs = path.resolve(unquotePath(dir));
    try { if (!fs.statSync(abs).isDirectory()) return; } catch (e) { return; }
    if (!out.some((x) => samePath(x.dir, abs))) out.push({ dir: abs, from });
  };
  const l = readLocal();
  let mavens = Array.isArray(l.mavens) ? l.mavens.filter(isObj) : [];
  if (!mavens.length && isObj(l.maven)) mavens = [Object.assign({ name: '默认' }, l.maven)];
  for (const m of mavens) {
    const tag = '本机环境里的 Maven ' + (m.name || '');
    if (m.repo) add(m.repo, tag);
    else if (m.settings) add(repoOfSettings(unquotePath(m.settings)), tag + ' 的 settings.xml');
    else if (m.home) add(repoOfSettings(path.join(unquotePath(m.home), 'conf', 'settings.xml')), tag + ' 的 conf/settings.xml');
  }
  add(repoOfSettings(path.join(os.homedir(), '.m2', 'settings.xml')), '~/.m2/settings.xml');
  add(path.join(os.homedir(), '.m2', 'repository'), '默认位置');
  return out;
}

/** 版本号比大小：一段一段按数字比，数字一样再按字母比 */
function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.\-_]/);
  const pb = String(b || '').split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || ''; const y = pb[i] || '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN; const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue; }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
const nameLooksLike = (file) => { for (const k of Object.keys(DIALECTS)) if (DIALECTS[k].names.some((r) => r.test(file))) return k; return ''; };

/**
 * 在几个目录里找驱动。o: { dirs: [{dir, from}], budgetMs（默认 25 秒）, maxDepth（默认 10）,
 *   enough: [数据库…]（这几种在常见位置里都找到了就不再整仓扫：后台自动探索用，配置页上的"找一遍"不给） }
 * 返回 { found: { 数据库: [{ jar, version, size, from, mtime, java }]（新的在前） }, scanned: 看了多少个目录, timedOut, dirs }
 * 常见坐标下面的 jar 都打开看里面有没有驱动类；别处的先看名字像不像，像的才打开：一个大仓库也只要几秒
 */
function scan(o) {
  const opt = o || {};
  const dirs = (opt.dirs && opt.dirs.length ? opt.dirs : mavenRepos()).map((d) => (typeof d === 'string' ? { dir: d, from: '指定的目录' } : d));
  const budget = Number(opt.budgetMs) > 0 ? Number(opt.budgetMs) : 25000;
  const maxDepth = Number(opt.maxDepth) > 0 ? Number(opt.maxDepth) : 10;
  const t0 = Date.now();
  const found = {};
  const seen = new Set();
  let scanned = 0;
  let timedOut = false;
  const consider = (file, from, known) => {
    const key = file.toLowerCase();
    if (seen.has(key)) return;
    const base = path.basename(file);
    if (!/\.jar$/i.test(base) || /-(sources|javadoc|tests?)\.jar$/i.test(base)) return;
    if (!known && !nameLooksLike(base) && !LOOKS_LIKE_DRIVER.test(base)) return;
    seen.add(key);
    const info = inspect(file);
    if (!info.ok) return;
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { mtime = 0; }
    (found[info.dialect] = found[info.dialect] || []).push({ jar: file, version: info.version, size: info.size, from, mtime, java: info.java || 0 });
  };
  const walk = (dir, depth, from, known) => {
    if (timedOut) return;
    if (Date.now() - t0 > budget) { timedOut = true; return; }
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    scanned++;
    for (const e of ents) {
      if (e.isFile()) { if (/\.jar$/i.test(e.name)) consider(path.join(dir, e.name), from, known); continue; }
      if (e.isDirectory() && depth < maxDepth && e.name[0] !== '.') walk(path.join(dir, e.name), depth + 1, from, known);
    }
  };
  for (const d of dirs) for (const k of KNOWN_DIRS) walk(path.join(d.dir, k), 0, d.from, true);
  const enough = Array.isArray(opt.enough) && opt.enough.length && opt.enough.every((k) => (found[k] || []).length);
  if (!enough) for (const d of dirs) walk(d.dir, 0, d.from);
  for (const k of Object.keys(found)) found[k].sort((a, b) => cmpVersion(b.version, a.version) || b.mtime - a.mtime);
  return { found, scanned, timedOut, ms: Date.now() - t0, dirs };
}

/**
 * 找到的几个里挑哪一个。prefer: [{ artifactId, version }]（项目的 pom 里写明的）；jdk：查库用的 JDK 是 Java 几（0 = 不知道）。
 *   项目的 pom 里写明的那个版本 → JDK 加载得了的里面最新的 → 都加载不了就拿最新的（登记时会提醒）
 * 不知道 JDK 是几的时候按 Java 8 算：按 8 编的驱动哪个 JDK 都加载得了
 */
function pick(list, prefer, jdk) {
  if (!list || !list.length) return null;
  for (const p of prefer || []) {
    const want = (String(p.artifactId) + '-' + String(p.version) + '.jar').toLowerCase();
    const hit = list.find((x) => path.basename(x.jar).toLowerCase() === want);
    if (hit) return Object.assign({ why: '项目的 pom 里写的就是这个版本' }, hit);
  }
  const limit = jdk || 8;
  const fits = list.filter((x) => !x.java || x.java <= limit);
  return fits[0] || list[0];
}
/**
 * 自动找、自动登记：每种还没登记驱动的数据库（only 给了就只管那几种，force 为真时已经登记的也换）。挑哪一个见 pick。
 * byUser 为真（用户自己在配置页上点的）：他去掉过的那几种也照常登记；不然跳过它们。
 * 返回 { used: [...], kept, missing: [还是没有的], skipped: [用户去掉过、这次没登记的], scan }
 */
function auto(o) {
  const opt = o || {};
  const r = scan(Object.assign({}, opt, { enough: opt.quick && opt.only && opt.only.length ? opt.only : null }));
  const reg = readRegistry();
  const removed = opt.byUser ? [] : removedByUser();
  const jdk = jdkMajor();
  const used = [];
  const kept = [];
  const skipped = [];
  for (const k of Object.keys(DIALECTS)) {
    if (opt.only && opt.only.length && !opt.only.includes(k)) continue;
    const has = reg[k] && fs.existsSync(reg[k].jar);
    if (has && !opt.force) {
      kept.push(k);
      for (const x of (r.found[k] || []).slice(0, 20)) use(x.jar, { dialect: k, from: 'maven', keepDefault: true });
      continue;
    }
    if (removed.includes(k)) { skipped.push(k); continue; }
    const best = pick(r.found[k], opt.prefer, jdk);
    if (!best) continue;
    const u = use(best.jar, { dialect: k, from: 'maven' });
    if (u.ok) used.push(Object.assign({ source: best.jar, why: best.why || '' }, u));
    for (const x of (r.found[k] || []).slice(0, 20)) if (!samePath(x.jar, best.jar)) use(x.jar, { dialect: k, from: 'maven', keepDefault: true });
  }
  const now = readRegistry();
  const missing = Object.keys(DIALECTS).filter((k) => (!opt.only || !opt.only.length || opt.only.includes(k)) && !(now[k] && fs.existsSync(now[k].jar)));
  return { used, kept, missing, skipped, scan: r };
}
/**
 * 项目的 pom 里写明了版本的数据库驱动：[{ artifactId, version }]。版本写成 ${xxx.version} 的到同一个 pom、根 pom 的 <properties> 里找。
 * 版本交给父 pom（Spring Boot）管、pom 里没写的拿不到
 */
function projectDrivers(root) {
  const out = [];
  const poms = [];
  const walk = (dir, depth) => {
    if (depth > 3 || poms.length >= 40) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isFile() && e.name === 'pom.xml') poms.push(path.join(dir, e.name));
      else if (e.isDirectory() && !/^(\.|node_modules$|target$|build$|dist$|src$)/.test(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(String(root || '.')), 0);
  const texts = poms.map((f) => { try { return fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, ''); } catch (e) { return ''; } });
  const prop = (name) => { for (const t of texts) { const m = new RegExp('<' + name.replace(/[.$]/g, '\\$&') + '>\\s*([^<\\s]+)\\s*</').exec(t); if (m) return m[1]; } return ''; };
  for (const t of texts) {
    const re = /<dependency>([\s\S]*?)<\/dependency>/g;
    let m;
    while ((m = re.exec(t))) {
      const a = (/<artifactId>\s*([^<\s]+)\s*</.exec(m[1]) || [])[1] || '';
      let v = (/<version>\s*([^<\s]+)\s*</.exec(m[1]) || [])[1] || '';
      if (!a || !v || !(nameLooksLike(a + '.jar') || LOOKS_LIKE_DRIVER.test(a))) continue;
      const p = /^\$\{([^}]+)\}$/.exec(v);
      if (p) v = prop(p[1]);
      if (v && !/[${]/.test(v) && !out.some((x) => x.artifactId === a && x.version === v)) out.push({ artifactId: a, version: v });
    }
  }
  return out;
}

/**
 * 旧技能（urai-db-crud）自带的驱动：删旧技能之前挪过来。那种数据库还没登记驱动的才登记，已经登记的不动。
 * 返回挪了哪些
 */
function rescueFrom(skillDir) {
  const out = [];
  const dir = path.join(skillDir, 'drivers');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.jar$/i.test(n)); } catch (e) { return out; }
  for (const n of names) {
    const info = inspect(path.join(dir, n));
    if (!info.ok) continue;
    const reg = readRegistry();
    if (reg[info.dialect] && fs.existsSync(reg[info.dialect].jar)) continue;
    const u = use(path.join(dir, n), { dialect: info.dialect, from: 'rescue' });
    if (u.ok) out.push(u);
  }
  return out;
}

/** 给配置页和命令行：每种数据库现在用的是哪个驱动 */
function status() {
  const reg = readRegistry();
  const list = Object.keys(DIALECTS).map((k) => {
    const r = reg[k];
    const ok = !!(r && fs.existsSync(r.jar));
    return { dialect: k, name: DIALECTS[k].name, url: DIALECTS[k].url, ok, jar: r ? r.jar : '', file: r ? path.basename(r.jar) : '', version: r ? r.version || '' : '', from: r ? r.from || '' : '', source: r ? r.source || '' : '', at: r ? r.at || 0 : 0, size: r ? r.size || 0 : 0, java: r ? r.java || 0 : 0, lost: !!(r && !ok), versions: variants(r).map((x) => Object.assign({}, x, { file: path.basename(x.jar), ok: fs.existsSync(x.jar), default: samePath(x.jar, r.jar) })) };
  });
  return { drivers: list, store: STORE, registry: REGISTRY, repos: mavenRepos(), jdk: jdkMajor(), removed: removedByUser() };
}

module.exports = { DIALECTS, KIT, REGISTRY, STORE, zipEntries, inspect, readRegistry, variants, removedByUser, jdkMajor, use, remove, mavenRepos, repoOfSettings, cmpVersion, scan, pick, auto, projectDrivers, rescueFrom, status };

'use strict';
/*
 * .vibe/ 里只放套件长期要用的东西；模型的临时脚本、草稿一件事一个目录：事由是变更名的留到变更归档（归档后这里自己清），别的做完就删。
 *
 *   .vibe/project.md、handover.md、login.json      项目说明、交接记录、账号
 *   .vibe/cp.txt、javac.args、*baseline*、*.args    快检的中间文件（/ttls-onboard 建的；别的名字要先写进项目说明）
 *   .vibe/scenarios/、out/、design/                 看页面的场景、结果、设计图
 *   .vibe/run/                                      tools/devserver.js 记着起过的服务、它们的日志
 *   .vibe/pending/                                  全自动模式下放哪还没定的产出（等用户定，不自动删）
 *   .vibe/lessons/                                  经验规则的候选（还没到次数、不进上下文的；lib/lessons.js）
 *   .vibe/reports/                                  全自动模式每一轮的报告（套件写的，lib/report.js）
 *   .vibe/tmp/<事由>/                               临时脚本、草稿、一次性数据：一件事一个目录
 *
 * 写文件时（pre-edit 调 vibeCheck）：往 .vibe 里新建上面以外的文件就拦下，告诉它放哪。
 * 会话开始、收工时（session-start、verify-gate 调 cleanTmp）：.vibe/tmp/、.vibe/out/ 下的目录，是某个已归档变更的（那件事做完了；
 *   归档之后又动过的不算），或者 .vibe/tmp/ 下 tmpKeepDays 天（默认 7，0 = 不自动删；只在会话开始时看）里一个文件都没动过的，删掉。
 *   还没归档的变更的目录不清。
 * 变更没归档之前模型自己去删它的过程文件：hooks/guard-commit.js 拦下（keepIssue）。
 * 已经堆在 .vibe 里的旧文件：tools/vibe-tidy.js 列出来，--apply 挪进 .vibe/tmp/<日期>-整理/（不直接删，过几天没人要才清掉）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { normKey, CFG_DIR, updateState } = require('./session');

// 后面三项是 0930 加的：查库的连接配置、探测缓存、表结构缓存（以前的名字带 urai-）；查 redis 的连接配置；后台自动探索的记录和锁
const ROOT_KEEP = /^(project\.md|handover\.md|login\.json|cp\.txt|javac\.args|[^/]*baseline[^/]*|[^/]*\.args|classpath[^/]*\.txt|(urai-)?db-crud\.(ini|env\.json|cache\.json)|redis\.json|connections-retired\.json|onboard\.(json|lock))$/i;
// run/：devserver.js 记着起过的服务和它们的日志；lessons/：经验规则的候选（tools/lesson.js 记的）
const DIR_KEEP = new Set(['scenarios', 'out', 'design', 'pending', 'run', 'lessons', 'reports', 'reviews']);

/** 路径里 .vibe 这一段的位置：返回 { vibeDir, rel }（rel 是 .vibe 里面的相对路径，正斜杠） */
function vibePart(file) {
  const parts = path.resolve(file).split(path.sep);
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf('.vibe');
  if (i < 1) return null;
  return { vibeDir: parts.slice(0, i + 1).join(path.sep), rel: parts.slice(i + 1).join('/') };
}
/** 项目说明里提到过的 .vibe 下的文件（长期要用、写明了用途的） */
function mentionedInNotes(vibeDir, rel) {
  try {
    const t = fs.readFileSync(path.join(vibeDir, 'project.md'), 'utf8').replace(/\\/g, '/').toLowerCase();
    return t.includes('.vibe/' + rel.toLowerCase());
  } catch (e) { return false; }
}
/** 这个 .vibe 里的文件放得对不对。返回 '' 或者一个说明（哪里不对） */
function misplaced(vibeDir, rel) {
  if (!rel) return '';
  const segs = rel.split('/');
  if (segs.length === 1) return ROOT_KEEP.test(segs[0]) || mentionedInNotes(vibeDir, rel) ? '' : 'root';
  const top = segs[0].toLowerCase();
  if (DIR_KEEP.has(top)) return '';
  if (top === 'tmp') return segs.length >= 3 ? '' : 'tmp-root';
  return mentionedInNotes(vibeDir, rel) ? '' : 'other';
}

/** 写文件时查：往 .vibe 里新建了不该放在那里的文件，返回拦下的话；放对了返回 null */
function vibeCheck(j) {
  if (!j || j.tool_name !== 'Write') return null;
  const cwd = path.resolve(j.cwd || process.cwd());
  let f = String((j.tool_input && j.tool_input.file_path) || '');
  if (!f) return null;
  if (!path.isAbsolute(f)) f = path.resolve(cwd, f);
  const v = vibePart(f);
  if (!v || fs.existsSync(f)) return null;
  const why = misplaced(v.vibeDir, v.rel);
  if (!why) return null;
  const show = (p) => { const r = path.relative(cwd, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p; };
  const tmpEx = show(path.join(v.vibeDir, 'tmp', '<事由>', path.basename(f)));
  return '[vibe-kit .vibe 整理] ' + show(f) + (why === 'tmp-root' ? ' 直接放在 .vibe/tmp 下了，要按事由分目录' : ' 不是套件用的文件，不要直接放在 .vibe 里') + '（.vibe 只放项目说明、交接记录、账号、快检的中间文件、看页面的场景和结果）。\n'
    + '- 临时的脚本、草稿、一次性数据：放 ' + tmpEx + '，一件事一个目录（做 OpenSpec 变更时事由就写变更名，否则写日期加一两个词，比如 .vibe/tmp/0924-导出排查/）。事由是变更名的留着别删，变更归档之后套件自己清；别的事由，那件事做完就把整个目录删掉，七天没动的也会自动清掉。\n'
    + '- 快检要长期用的中间文件：先在项目说明（.vibe/project.md）里写明它的路径和用途，再建。\n'
    + '- 要交给人的产出（报告、DDL、说明）不放 .vibe，放项目说明"产出位置"里定好的地方。';
}

// ---------- 项目里的过程文件（备份、日志、临时文件） ----------
/*
 * 过程文件一律放 .vibe/tmp/<事由>/，不放进项目目录。怎么认：
 *   名字一看就是的：A.java.bak、A.java.orig、x.old、build.log、x.tmp、A_bak.java、A.bak.java、"A - 副本.java"、"A (2).java"、x~
 *   旁边有原文件才算的：A_old.java、A-backup.js、A备份.sql（旁边有 A.java、A.js、A.sql 才是备份；drop_old.sql、数据备份.sql 是正经名字）
 *   目录：bak/、backup/、备份/、副本/、tmp/、temp/、src_bak/ 这类，而且不是项目原来就有的（git 里没有跟踪着的文件）；
 *     代码目录（src、views、common……）下面的不算（com/demo/backup/ 是业务包名），那里只按文件名判断
 * 改文件前不用另存备份：已提交的 git 里有，没提交的先复制到 .vibe/tmp/<事由>/。
 * 拦错了（比如测试要用的样例日志文件）：同一个文件原样再做一次就放行，在过程目录里的按目录算（记在 state/<会话>-process.json）。
 */
const PROCESS_NAME = /(\.(bak|backup|orig|old|tmp|temp|swp|log|dump|hprof)\d*|~|[-_.](bak|orig)\d*(\.[\w]+)?)$|\s-\s(副本|copy)(\s\(\d+\))?(\.[\w]+)?$|\s\(\d+\)\.[\w]+$|^copy of /i;
const COPY_SUFFIX = /^(.+?)(?:[-_.](?:backup|old)\d*|\s*(?:副本|备份))(\.[\w]+)?$/i;
const PROCESS_DIR = /^(bak|backups?|备份|副本|tmp|temp)$/i;
// 代码目录：到了这些目录下面，backup、temp 多半是业务包名、页面目录（com/demo/backup/、views/system/backup/、common/temp/），只按文件名判断
const CODE_SEGS = new Set(['src', 'main', 'java', 'kotlin', 'scala', 'groovy', 'resources', 'webapp', 'web-inf', 'views', 'view', 'components', 'component', 'pages', 'page', 'layouts', 'templates', 'api', 'controller', 'controllers', 'service', 'services', 'module', 'modules', 'lib', 'libs', 'app', 'com', 'org', 'net', 'cn', 'io', 'common', 'utils', 'util', 'domain', 'model', 'models', 'entity', 'dto', 'vo', 'mapper', 'dao', 'store', 'router', 'routes', 'assets', 'static', 'public', 'test', 'tests']);
const isProcessName = (name) => PROCESS_NAME.test(String(name || ''));
/** 这个文件（或目录）是不是过程文件：名字一看就是的，或者 A_old.java 这种、旁边有原文件 A.java 的 */
function isProcessFile(file) {
  const abs = path.resolve(String(file || ''));
  const name = path.basename(abs);
  if (isProcessName(name)) return true;
  const m = COPY_SUFFIX.exec(name);
  return !!m && fs.existsSync(path.join(path.dirname(abs), m[1] + (m[2] || '')));
}
/** 这个路径在不在某个 .vibe 目录里（那里放什么过程文件都行） */
const inVibe = (file) => /(^|[\\/])\.vibe([\\/]|$)/.test(String(file || ''));
const processMsg = (show) => '[vibe-kit 过程文件] ' + show + ' 看起来是过程文件（备份、日志、临时文件），不要放在项目里：放 .vibe/tmp/<事由>/（一件事一个目录；事由是变更名的留到变更归档，别的做完就删）。改文件之前不用另存备份：已提交的 git 里有，没提交的先复制到 .vibe/tmp/<事由>/。'
  + '确实是项目要用的（比如测试要读的样例日志文件），原样再做一次就行。';
const inTemp = (p) => { const k = normKey(p); return [require('os').tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).map(normKey).some((t) => k === t || k.startsWith(t + '/')); };
/**
 * 这个文件属于哪个项目：往上最近的 git 仓库，或者有项目说明（.vibe/project.md）的目录；都没有的，在当前目录下（当前目录不在临时目录里）就算当前目录。
 * ~/.claude 里的、临时目录里又不在任何仓库或项目里的（草稿），不算项目，返回 ''
 */
function projectRootOf(file, cwd) {
  const abs = path.resolve(String(file || ''));
  if (normKey(abs).startsWith(normKey(CFG_DIR) + '/')) return '';
  let d = path.dirname(abs);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, '.git')) || fs.existsSync(path.join(d, '.vibe', 'project.md'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (!cwd || inTemp(cwd)) return '';
  const c = path.resolve(cwd);
  const r = path.relative(c, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? c : '';
}
/** 这个目录下 git 里有没有跟踪着的文件（有 = 项目原来就有的目录）。查不了 git 的（不是仓库）：目录已经存在就算有 */
function hasTracked(root, dir) {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '--', path.relative(root, dir).split(path.sep).join('/') + '/'], { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return !!out.trim();
  } catch (e) { return fs.existsSync(dir); }
}
/**
 * file 在项目根目录 root 下的这段路径里，第一个是过程目录（bak/、backup/、tmp/、src_bak/……）、又不是项目原来就有的：返回它的绝对路径，没有返回 ''。
 * asDir：file 本身也当目录看（cp 到一个目录里）。cache：同一次检查里查过的目录不再问 git
 */
function processDirOf(file, root, asDir, cache) {
  const rel = path.relative(root, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const segs = rel.split(path.sep);
  if (!asDir) segs.pop();
  let d = root;
  let inCode = false;
  for (const s of segs) {
    d = path.join(d, s);
    if (s.toLowerCase() === '.vibe') return '';
    if (inCode) continue;
    if (CODE_SEGS.has(s.toLowerCase())) { inCode = true; continue; }
    if (!PROCESS_DIR.test(s) && !isProcessFile(d)) continue;
    const k = normKey(d);
    let own = cache && cache.has(k) ? cache.get(k) : undefined;
    if (own === undefined) { own = fs.existsSync(d) && hasTracked(root, d); if (cache) cache.set(k, own); }
    if (!own) return d;
  }
  return '';
}
// 构建输出、工具目录：里面的日志、临时文件是构建和工具自己生成的，下次构建就清掉，不管
const SKIP_DIRS = new Set(['target', 'build', 'dist', 'out', 'node_modules', '.git', '.idea', '.vscode', '.gradle', '.next', '.nuxt', 'coverage']);
function inBuildDir(file, root) {
  const rel = path.relative(root, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).slice(0, -1).some((s) => SKIP_DIRS.has(s.toLowerCase()));
}
/**
 * 这个路径是不是项目里的过程文件（本身是，或者在过程目录里）：是的返回 { show, key }，不是返回 null。asDir 同上。
 * show 是要显示的路径；key 是"只拦一次"记的东西：在过程目录里的记那个目录（它坚持要用这个目录，里面的文件都不再拦）
 */
function processPath(file, cwd, asDir) {
  const abs = path.resolve(cwd || process.cwd(), String(file || ''));
  if (inVibe(abs)) return null;
  const root = projectRootOf(abs, cwd);
  if (!root || inBuildDir(abs, root)) return null;
  const dir = isProcessFile(abs) ? '' : processDirOf(abs, root, asDir);
  if (!dir && !isProcessFile(abs)) return null;
  const r = path.relative(cwd || root, abs);
  return { show: (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs).split(path.sep).join('/'), key: dir || abs };
}
/** 目录里还没进 git（也没被忽略）的过程文件：git add 这个目录会把它们一起带上。返回要显示的路径（最多 8 个） */
function untrackedProcessIn(dir, cwd) {
  let out = '';
  try { out = execFileSync('git', ['--no-optional-locks', '-C', dir, '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return []; }
  const found = [];
  const cache = new Map();
  for (const rel of out.split('\0').filter(Boolean)) {
    const abs = path.join(dir, rel);
    if (inVibe(abs)) continue;
    const root = projectRootOf(abs, cwd);
    if (!root || inBuildDir(abs, root)) continue;
    if (!isProcessFile(abs) && !processDirOf(abs, root, false, cache)) continue;
    const r = path.relative(cwd || dir, abs);
    found.push((r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs).split(path.sep).join('/'));
    if (found.length >= 8) break;
  }
  return found;
}
/** 拦错了就原样再做一次放行：同一个会话里同一个路径（或目录）只拦一次。返回 true = 这次该拦 */
function blockOnce(sid, file) {
  if (!sid) return true;
  const k = normKey(file);
  let first = true;
  const saved = updateState(sid + '-process', (s) => { const list = Array.isArray(s.files) ? s.files : []; if (list.includes(k)) { first = false; return s; } return { files: list.concat(k).slice(-200), at: Date.now() }; });
  // 记不下"拦过这一个"就放行：不然每次都拦，"原样再做一次就放行"这条路走不通
  if (saved === null) return false;
  return first;
}
/** 用 Write 往项目里（.vibe 以外）新建过程文件：拦下，告诉它放哪 */
function processCheck(j) {
  if (!j || j.tool_name !== 'Write') return null;
  const cwd = path.resolve(j.cwd || process.cwd());
  let f = String((j.tool_input && j.tool_input.file_path) || '');
  if (!f) return null;
  if (!path.isAbsolute(f)) f = path.resolve(cwd, f);
  if (fs.existsSync(f)) return null;
  const p = processPath(f, cwd, false);
  if (!p || !blockOnce(j.session_id, p.key)) return null;
  return processMsg(p.show);
}

/** 目录里最新的一个文件的修改时间（最多看 2000 个） */
function newestMtime(dir) {
  let newest = 0; let n = 0;
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (++n > 2000) return;
      const p = path.join(d, e.name);
      try { const st = fs.statSync(p); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (err) { /* 刚被删 */ }
      if (e.isDirectory() && depth < 8) walk(p, depth + 1);
    }
  };
  try { newest = fs.statSync(dir).mtimeMs; } catch (e) { return 0; }
  walk(dir, 0);
  return newest;
}
/**
 * 这个过程文件目录是哪个变更的：名字就是变更名，或者以"变更名-""变更名_""变更名."开头（add-x-sm2 是 add-x 的）。
 * names 是变更名（小写）。几个都对得上取最长的那个：add-x 和 add-x-excel 两个变更，add-x-excel-测试 是后一个的
 */
function changeOwner(dirName, names) {
  const n = String(dirName || '').toLowerCase();
  let best = '';
  for (const c of names || []) if (c && c.length > best.length && (n === c || n.startsWith(c + '-') || n.startsWith(c + '_') || n.startsWith(c + '.'))) best = c;
  return best;
}
/**
 * 清掉做完了的过程文件目录。roots 是各个项目根目录，看它们的 .vibe/tmp 和 .vibe/out。返回删掉的 [{ dir, why }]。
 *   已归档变更的（archivedNames；名字就是变更名、或者以变更名开头）：删掉。since 是 { 变更名（小写）: 什么时候归档的 }——
 *     归档之后又动过的目录不清：那是后来的事（归档后修问题，事由还写这个变更名），留给下面的"多少天没动"。
 *   .vibe/tmp 里 keepDays 天没动过的：删掉（0 = 不按天数清）。.vibe/out 是看页面的结果，不按天数清。
 *   还没归档的变更的（activeNames）：留到归档（用户 2026-09-30 定的），放了多少天都不清。
 * 一个目录两边都对得上（同名的变更归档之后又建了一个；add-x 归档了、add-x-excel 还在做）：看哪边对得上的名字更长，一样长算没归档的
 */
function cleanTmp(roots, keepDays, archivedNames, activeNames, since) {
  const out = [];
  const archived = (archivedNames || []).map((x) => String(x).toLowerCase());
  const active = (activeNames || []).map((x) => String(x).toLowerCase());
  const days = Number(keepDays);
  const dead = days > 0 ? Date.now() - days * 86400000 : 0;
  const seen = new Set();
  for (const r of roots) {
    for (const top of ['tmp', 'out']) {
      const base = path.join(r, '.vibe', top);
      const k = normKey(base);
      if (seen.has(k)) continue;
      seen.add(k);
      let es = [];
      try { es = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (e) { continue; }
      for (const e of es) {
        const d = path.join(base, e.name);
        const mine = changeOwner(e.name, active);
        const done = changeOwner(e.name, archived);
        if (mine && mine.length >= done.length) continue;
        let why = '';
        let mtime = -1;
        if (done) {
          const at = since ? Number(since[done]) || 0 : 0;
          if (at) mtime = newestMtime(d);
          if (!at || mtime <= at + 60000) why = '变更 ' + (e.name.toLowerCase() === done ? e.name : done) + ' 已归档';
        }
        if (!why && top === 'tmp' && dead && (mtime >= 0 ? mtime : newestMtime(d)) < dead) why = days + ' 天没动过';
        if (!why) continue;
        try { fs.rmSync(d, { recursive: true, force: true }); out.push({ dir: d, why }); } catch (err) { /* 有文件被占用，下次再清 */ }
      }
    }
  }
  return out;
}
/** .vibe 里放得不对的旧文件（整理工具、会话开始时的提醒用）：[{ file, rel }] */
function clutter(root) {
  const vibeDir = path.join(root, '.vibe');
  const out = [];
  let es = [];
  try { es = fs.readdirSync(vibeDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    const rel = e.name;
    if (e.isDirectory()) {
      if (DIR_KEEP.has(rel.toLowerCase()) || rel.toLowerCase() === 'tmp' || mentionedInNotes(vibeDir, rel)) continue;
      out.push({ file: path.join(vibeDir, rel), rel: rel + '/' });
    } else if (misplaced(vibeDir, rel)) out.push({ file: path.join(vibeDir, rel), rel });
  }
  return out;
}

module.exports = { vibePart, misplaced, vibeCheck, cleanTmp, changeOwner, clutter, newestMtime, PROCESS_NAME, isProcessName, isProcessFile, inVibe, projectRootOf, inBuildDir, processDirOf, processPath, untrackedProcessIn, blockOnce, processMsg, processCheck };

'use strict';
/*
 * 项目和变更：壳子和子项目、OpenSpec 变更目录、列变更、归档过的变更、.vibe 进 .gitignore。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const { readState, updateState, normKey } = require('./session-state');

// 找子目录时跳过的：构建产物、依赖。docs、templates 这类名字不跳过：子项目恰好叫这个名字时也要认得出来
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', 'logs']);

/** 不以点开头、也不是构建产物的子目录 */
function subdirs(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name[0] !== '.' && !SKIP_DIRS.has(e.name)).map((e) => path.join(d, e.name)); } catch (e) { return []; }
}

/** 这个目录自己就是一个装代码的项目：有构建文件、源码目录或 IDE 工程文件 */
const PROJECT_MARKS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'composer.json', 'Gemfile', 'CMakeLists.txt', '.classpath', '.project', 'src', 'web/WEB-INF', 'WebRoot/WEB-INF', 'WebContent/WEB-INF'];

function looksLikeProject(dir) {
  try {
    if (PROJECT_MARKS.some((m) => fs.existsSync(path.join(dir, m)))) return true;
    return fs.readdirSync(dir).some((n) => /\.(iml|sln|csproj)$/i.test(n));
  } catch (e) { return false; }
}

/** .gitmodules 里登记的子模块：那是 git 自己管的嵌套，git add -A 处理得了，不算"套着的子项目" */
function submodulePaths(root) {
  try { return (fs.readFileSync(path.join(root, '.gitmodules'), 'utf8').match(/^\s*path\s*=\s*(.+)$/gm) || []).map((l) => path.resolve(root, l.replace(/^\s*path\s*=\s*/, '').trim()).toLowerCase()); } catch (e) { return []; }
}

/**
 * 公司的项目结构：外面一层给 AI 用的壳子（放 openspec、文档、.claude），里面是项目的各个子项目，子项目各是独立的 git 仓库、装代码。
 * 返回 dir 下面套着的子项目目录（直接子目录里带 .git 的，登记为子模块的不算）。壳子外面还可以再套一层（有 workspace.yaml 的），那种情况多看一层。
 * 判断看的是实际结构，不依赖某个标志文件：没有 workspace.yaml 的壳子一样认得出来。
 */
function nestedRepos(dir) {
  const out = [];
  try {
    const start = path.resolve(dir || process.cwd());
    const deep = fs.existsSync(path.join(start, 'workspace.yaml'));
    const subs = submodulePaths(start);
    let budget = 200;
    for (const a of subdirs(start)) {
      if (--budget < 0) break;
      if (fs.existsSync(path.join(a, '.git')) && !subs.includes(a.toLowerCase())) out.push(a);
      if (deep) for (const b of subdirs(a)) { if (--budget < 0) break; if (fs.existsSync(path.join(b, '.git')) && !subs.includes(b.toLowerCase())) out.push(b); }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/**
 * 是不是壳子：外面再套了一层（有 workspace.yaml）；或者下面套着子项目、自己不是装代码的项目、而且自己有点东西（是 git 仓库，或放着 openspec / .claude / CLAUDE.md）。
 * 普通的单个项目（有 pom.xml、package.json、src 这些）就算下面有别的 git 仓库也不是壳子。
 */
function isShell(dir) {
  try {
    const d = path.resolve(dir || process.cwd());
    if (fs.existsSync(path.join(d, 'workspace.yaml'))) return true;
    if (looksLikeProject(d)) return false;
    const hasOwn = ['.git', 'openspec', '.claude', 'CLAUDE.md'].some((n) => fs.existsSync(path.join(d, n)));
    return hasOwn && nestedRepos(d).length > 0;
  } catch (e) { return false; }
}

/**
 * 找 openspec/changes 目录。
 *   当前目录自己有 openspec：就用它，不往上找（普通的单个项目 openspec 就在自己目录里，上级目录里的不是它的）；
 *     它要是壳子，再看直接子目录（外面再套了一层的多看一层），子项目自己有 openspec 的也算上
 *   当前目录没有 openspec：往上找，但只认两种上级——套着自己的壳子，或者自己所在仓库的根（openspec 一般放在仓库根）；
 *     碰到别的目录就停，不把上级目录里不相干的 openspec 算进来
 */
function changeRoots(dir) {
  const out = [];
  const add = (d) => { const c = path.join(d, 'openspec', 'changes'); if (!out.includes(c) && fs.existsSync(c)) out.push(c); };
  try {
    const start = path.resolve(dir || process.cwd());
    const deep = fs.existsSync(path.join(start, 'workspace.yaml'));
    const own = fs.existsSync(path.join(start, 'openspec'));
    if (own) add(start);
    if (own || isShell(start)) {
      let budget = 300;
      for (const a of subdirs(start)) { if (--budget < 0) break; add(a); if (deep) for (const b of subdirs(a)) { if (--budget < 0) break; add(b); } }
    }
    if (!own) {
      let d = start;
      let leftRepo = fs.existsSync(path.join(start, '.git'));
      for (let i = 0; i < 4 && !out.length; i++) {
        const up = path.dirname(d);
        if (up === d) break;
        const shellOfMine = fs.existsSync(path.join(up, 'workspace.yaml')) || nestedRepos(up).some((r) => r.toLowerCase() === d.toLowerCase());
        if (!shellOfMine && leftRepo) break;
        add(up);
        if (fs.existsSync(path.join(up, '.git'))) leftRepo = true;
        d = up;
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/**
 * 这项任务留给用户做（要改库、要账号密码、要 push）：任务行里写了"（留给用户：原因）"。全自动模式下它不做也不等，
 * 接着做别的；剩下的全是这种，就算能做的都做完了
 */
const TASK_DEFER = /[（(]\s*(?:留给用户|等用户|待用户|需用户|要用户)[^（）()]*[）)]/;

const isDeferredTask = (line) => TASK_DEFER.test(String(line || ''));

/** 所有没归档的变更（含任务已全部打勾的），最近动过的排前面。waiting 是没打勾的里面留给用户的那几项，next 是下一项能做的 */
function listChanges(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) {
    try {
      for (const name of fs.readdirSync(changes)) {
        if (name === 'archive') continue;
        const tasks = path.join(changes, name, 'tasks.md');
        if (!fs.existsSync(tasks)) continue;
        const text = fs.readFileSync(tasks, 'utf8');
        const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
        const open = (text.match(/^\s*[-*]\s*\[ \]\s*.*$/gm) || []).map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, '').trim());
        const waiting = open.filter(isDeferredTask);
        const next = open.find((l) => !isDeferredTask(l)) || '';
        out.push({ name, dir: path.join(changes, name), done, todo: open.length, waiting: waiting.length, waitingList: waiting.map((l) => l.slice(0, 80)), total: done + open.length, next: next.slice(0, 60), mtime: fs.statSync(tasks).mtimeMs });
      }
    } catch (e) { /* 这个目录读不了就跳过 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 还有没打勾任务的变更 */
const activeChanges = (dir) => listChanges(dir).filter((c) => c.todo > 0);

/**
 * .vibe 一出现就进 .gitignore：找到它所在的 git 仓库的根，.gitignore 里没有就追加。不是 git 仓库就不管。
 * 追加的内容只用英文：.gitignore 可能是 GBK 的，掺进 UTF-8 的中文会把它弄成两种编码混着。换行符跟着原文件走。
 * 传进来的是 .vibe 里面（或者就是 .vibe）的任意一个路径。
 */
function ensureVibeIgnored(p) {
  try {
    const parts = path.resolve(p).split(path.sep);
    const i = parts.lastIndexOf('.vibe');
    if (i < 1) return false;
    let d = parts.slice(0, i).join(path.sep) || path.sep;
    let root = '';
    for (let n = 0; n < 12; n++) { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } const up = path.dirname(d); if (up === d) break; d = up; }
    if (!root) return false;
    const file = path.join(root, '.gitignore');
    let text = '';
    try { text = fs.readFileSync(file, 'latin1'); } catch (e) { /* 还没有这个文件 */ }
    // 已经有了就不再加：.vibe、.vibe/、/.vibe/、.vibe/*、.vibe/**、**/.vibe/ 都算；文件开头可能带 BOM（按 latin1 读是 ï»¿）
    if (/^[ \t]*\/?(?:\*\*\/)?\.vibe(?:\/(?:\*\*?)?)?[ \t]*\r?$/m.test(text.replace(/^\xEF\xBB\xBF/, ''))) return false;
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    fs.appendFileSync(file, (text && !/\n$/.test(text) ? eol : '') + '# vibe-kit local files (project notes, page scenarios, handover notes) - do not commit' + eol + '.vibe/' + eol, 'latin1');
    return true;
  } catch (e) { return false; }
}

// ===================== OpenSpec 提案的门槛 =====================
// 提案、规格、设计、任务写得含糊，模型到了写代码的时候就只能猜，猜出来的东西藏在代码里比写在文档里更难发现。
// 这里是确定性的检查（脚本做，不花 token），供 guard-spec（写产物时）和 verify-gate（收工时）用。
// 原则：只判这次新加、改过的行，老变更里以前写的不追究，打勾（[ ] → [x]）不算改。

/** changes/ 下进行中的变更名（不含 archive） */
function changeNames(changesDir) {
  try { return fs.readdirSync(changesDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive' && e.name[0] !== '.').map((e) => e.name); } catch (e) { return []; }
}

/** archive/ 下最近 days 天归档的变更（按日期从早到晚）；days 为 0 表示全部 */
function archivedChanges(changesDir, days) {
  const dead = days > 0 ? Date.now() - days * 86400000 : 0;
  const out = [];
  try { for (const n of fs.readdirSync(path.join(changesDir, 'archive'))) { const m = n.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/); if (m && Date.parse(m[1]) >= dead) out.push({ name: m[2], date: m[1] }); } } catch (e) { /* 没有 archive */ }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ===================== 审查记录 =====================
// 只记"真审了"：vk-reviewer 的调用有结果、不是报错、结果里有"结论：问题 N 条"。
// 模式按审查提示的第一行"模式：提案 / 代码 / 复审提案 / 复审代码"认（老写法第一句"审提案"也认）；变更按提示里点名的认，没点名的不记到任何变更头上。
// 提案审过记在 reviewed-proposal，代码审过记在 reviewed。记录里带变更目录的创建时间：同名变更归档后重建，不继承以前的"审过"。
function changeBorn(dir) { try { const st = fs.statSync(dir); return Math.round(st.birthtimeMs || st.ctimeMs || 0); } catch (e) { return 0; } }

/** 当前目录能看到的所有变更（含还没有 tasks.md 的），给"提示里点名的是哪个变更"用 */
function allChanges(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) for (const name of changeNames(changes)) out.push({ name, dir: path.join(changes, name) });
  return out;
}

/** 当前目录能看到的、已经归档的变更的名字（不带日期） */
function archivedNames(dir) {
  const out = [];
  for (const changes of changeRoots(dir)) for (const a of archivedChanges(changes, 0)) if (!out.includes(a.name)) out.push(a.name);
  return out;
}

/**
 * 已归档的变更各是什么时候归档的：{ 名字（小写）: 时间 }。OpenSpec 的归档目录名只带日期，目录自己的时间又是归档之前的（挪目录不改它的时间），
 * 所以由钩子记"第一次看到它归档了"的时间（state/archived-seen.json）。清过程文件时拿它比：归档之后又动过的目录是后来的事
 * （归档后修问题，事由还写这个变更名），不清。同名的归档过几次，取最近的一次
 */
function archivedSince(dir) {
  const out = {};
  try {
    const found = [];
    for (const changes of changeRoots(dir)) for (const a of archivedChanges(changes, 0)) found.push({ key: normKey(path.join(changes, 'archive', a.date + '-' + a.name)), name: a.name.toLowerCase() });
    if (!found.length) return out;
    const now = Date.now();
    let st = readState('archived-seen');
    if (found.some((f) => !st[f.key])) {
      st = updateState('archived-seen', (o) => {
        for (const f of found) if (!o[f.key]) o[f.key] = now;
        const keys = Object.keys(o);
        if (keys.length > 3000) for (const k of keys.sort((a, b) => o[a] - o[b]).slice(0, keys.length - 2000)) delete o[k];
      }) || st;
    }
    for (const f of found) { const t = Number(st[f.key]) || now; if (!out[f.name] || t > out[f.name]) out[f.name] = t; }
  } catch (e) { /* 记不了：当成刚归档的 */ }
  return out;
}

module.exports = { subdirs, looksLikeProject, nestedRepos, isShell, changeRoots, TASK_DEFER, isDeferredTask, listChanges, activeChanges, ensureVibeIgnored, changeNames, archivedChanges, changeBorn, allChanges, archivedNames, archivedSince };

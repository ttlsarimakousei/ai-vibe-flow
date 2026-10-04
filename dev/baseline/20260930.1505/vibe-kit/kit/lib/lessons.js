'use strict';
/*
 * 经验规则：审查里反复出现的问题，沉淀成 Claude Code 自己会按需加载的规则（.claude/rules/ 下带 paths 的文件）。
 *
 * 整条路：
 *   审查确认成立的问题 → 主模型用 tools/lesson.js add 记一句话 → 先进候选（不进上下文）
 *   → 同一条在不同的变更里出现到门槛（默认 2 次）→ 升成项目级规则，写进出问题的文件所在仓库的 .claude/rules/ttls-lessons-<类型>.md
 *   → 同一条在两个不同的项目里都成了规则、又不含项目特有的名字 → 列为"可以升用户级"，用户在配置页点了才写进 ~/.claude/rules/
 *
 * 放在哪：
 *   候选             <仓库>/.vibe/lessons/candidates.json          只在本机，不进上下文，不进仓库
 *   项目级规则       <仓库>/.claude/rules/ttls-lessons-<类型>.md   跟着仓库提交，同事的 Claude 也能看到
 *   跨项目的记录     ~/.claude/vibe-kit/lessons/index.json         只在本机
 *   用户级规则       ~/.claude/rules/ttls-lessons-<类型>.md        只在本机，所有项目生效
 *
 * 规则文件就是"生效规则"的唯一来源：每条规则上面有一行注释记着编号、次数、最近一次、出处（单独一行的注释 Claude Code 不会送进上下文，
 * 2.1.120 / 2.1.259 / 2.1.283 实测）。人可以直接改字、删行；没有编号注释的行当作手写的，这里不动它。
 * 编号用文字的指纹，不用流水号：几个人各自加规则、再合并，不会撞号。
 *
 * 上下文怎么控制：规则全部带 paths（读到这类文件才加载，一个会话一次）；每条限长；每组限条数，满了挤掉次数最少、最久没再出现的，退回候选；
 * 规则里提到的类、文件、表在项目里找不到了就退役；生效之后又被审出来两次的标成"没管住"。
 * 开关和数都在 config.json：lessons（on / collect / off）、lessonThreshold、lessonMaxPerGroup、lessonMaxChars、lessonPromote（ask / auto）、lessonAuto。
 *
 * 自动收（开关 lessonAuto，默认开）：不靠模型自觉。收工时脚本从会话记录里取出审查者报的每一条问题（位置、问题、类别、严重程度），
 * 报了之后那个文件确实改过的才算数（按证据认，不让模型说了算）。收下来的问题两种办法归并：
 *   说的是同一件事（文字相近、类别一样）：当成同一条经验，在不同的变更里出现到门槛就变成规则，和模型记的走同一条路
 *   同一类（同一种文件、同一个类别）在好几个变更里反复出现：出一条"这一类要对照检查"的规则，带上最近的几个例子
 * 自动出来的规则在注释里标着"自动"，措辞是审查者的原话，配置页里能改能删。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { KIT, CFG_DIR, normKey, readConfig, ensureVibeIgnored, updateState, readState } = require('./session');

const USER_RULES_DIR = path.join(CFG_DIR, 'rules');
const STORE = path.join(KIT, 'lessons');
const INDEX_FILE = path.join(STORE, 'index.json');
const FILE_RE = /^ttls-lessons-([a-z0-9][\w.-]*)\.md$/i;
// 改名之前的文件名（20260929 及之前的版本写的）。碰到就并进新名字的文件里，旧文件删掉，见 migrateNames
const OLD_FILE_RE = /^vibe-lessons-([a-z0-9][\w.-]*)\.md$/i;
const SAME = 0.72;   // 相似到这个程度：当成同一条
const NEAR = 0.38;   // 到这个程度：列出来让模型自己认
const HEADER = '<!-- vibe-kit 经验规则：审查里反复出现的问题沉淀下来的，读到对应类型的文件时 Claude Code 会自动带上。新增、合并、退役由套件的 lesson.js 做；人可以直接改字、删行（删一条要连它上面那行注释一起删）；没有编号注释的行当作手写的，工具不动。Claude 不能直接改这个文件。 -->';
const KINDS = ['想当然', '没做到规格', '边界', '连带影响', '项目约定', '假验证', '前端交互', '权限', '数据库', '提案没说清', '其他'];

const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const oneLine = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const metaSafe = (s) => oneLine(s).replace(/--+>?/g, '-').replace(/<!-+/g, '').replace(/[=]/g, '＝');

function settings(cfg) {
  const c = cfg || readConfig();
  const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : d; };
  return {
    mode: ['on', 'collect', 'off'].includes(c.lessons) ? c.lessons : 'on',
    threshold: num(c.lessonThreshold, 2, 1, 5),
    maxPerGroup: num(c.lessonMaxPerGroup, 10, 3, 30),
    maxChars: num(c.lessonMaxChars, 120, 40, 300),
    promote: c.lessonPromote === 'auto' ? 'auto' : 'ask',
    auto: c.lessonAuto !== false,
  };
}

// ---------- 分组：一种文件类型一个规则文件 ----------
// paths 一个模式一行，不用花括号：2.1.217 之前花括号多了会让 Claude Code 启动时卡住
const GROUPS = {
  java: { title: 'Java', paths: ['**/*.java'] },
  sql: { title: 'SQL 和 Mapper', paths: ['**/*.xml', '**/*.sql'] },
  web: { title: '前端', paths: ['**/*.vue', '**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx', '**/*.html', '**/*.css', '**/*.scss', '**/*.less'] },
  spec: { title: '提案、设计、任务', paths: ['openspec/**/*.md', '**/openspec/**/*.md'] },
};
const WEB_EXT = new Set(['vue', 'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css', 'scss', 'less']);
function groupOf(file) {
  const f = String(file || '').replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '');
  const e = ((f.match(/\.([A-Za-z0-9]+)$/) || [])[1] || '').toLowerCase();
  if (!e) return '';
  if (/(^|\/)openspec\//i.test(f) && e === 'md') return 'spec';
  if (e === 'java') return 'java';
  if (e === 'xml' || e === 'sql') return 'sql';
  if (WEB_EXT.has(e)) return 'web';
  return /^[a-z0-9]{1,8}$/.test(e) ? 'other-' + e : '';
}
function groupInfo(key) {
  if (GROUPS[key]) return GROUPS[key];
  const m = /^other-([a-z0-9]{1,8})$/.exec(String(key || ''));
  return m ? { title: '.' + m[1] + ' 文件', paths: ['**/*.' + m[1]] } : null;
}
const ruleFileOf = (dir, group) => path.join(dir, 'ttls-lessons-' + group + '.md');
const projectRulesDir = (root) => path.join(root, '.claude', 'rules');

/** 这个路径是不是经验规则的文件（项目级、用户级的规则文件，或者 .vibe/lessons 里的候选）：模型不能直接改，只能通过 lesson.js */
function isLessonFile(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (/(^|\/)\.vibe\/lessons(\/|$)/i.test(s)) return true;
  const base = path.basename(s);
  return /(^|\/)\.claude\/rules\/(?:[^/]+\/)*(?:ttls|vibe)-lessons-[^/]*\.md$/i.test(s) || ((FILE_RE.test(base) || OLD_FILE_RE.test(base)) && normKey(path.dirname(path.resolve(s))) === normKey(USER_RULES_DIR));
}

// ---------- 找项目 ----------
function git(root, args, opts) {
  return execFileSync('git', ['--no-optional-locks', '-C', root].concat(args), Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, opts || {}));
}
/** 这个文件属于哪个仓库：往上最近的带 .git 的目录；不在任何仓库里的，往上最近的有项目说明的目录；都没有返回 '' */
function repoRootOf(file, cwd) {
  const abs = path.resolve(cwd || process.cwd(), String(file || '').replace(/:\d+(?::\d+)?$/, ''));
  if (normKey(abs) === normKey(CFG_DIR) || normKey(abs).startsWith(normKey(CFG_DIR) + '/')) return '';
  let d = abs;
  try { if (!fs.statSync(abs).isDirectory()) d = path.dirname(abs); } catch (e) { d = path.dirname(abs); }
  let notes = '';
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (!notes && fs.existsSync(path.join(d, '.vibe', 'project.md'))) notes = d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return notes;
}
const isGitRepo = (root) => fs.existsSync(path.join(root, '.git'));
/** 仓库里所有文件的文件名（不带扩展名）：判断规则里的词是不是这个项目特有的名字。查不了返回 null */
function fileStems(root) {
  if (!isGitRepo(root)) return null;
  try {
    const set = new Set();
    for (const args of [['ls-files', '-z'], ['ls-files', '-o', '--exclude-standard', '-z']]) for (const f of git(root, args).split('\0')) { if (!f || /^(\.claude|\.vibe|openspec)\//i.test(f)) continue; const b = f.split('/').pop(); set.add(b.replace(/\.[^.]+$/, '')); set.add(b); }
    return set;
  } catch (e) { return null; }
}
// 搜名字时不看这些目录：规则文件自己、提案文档里提到不算"项目里还有"
const NOT_CODE = [':(exclude).claude', ':(exclude)openspec', ':(exclude).vibe'];
const IDENT = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
// 技术栈里的通用词：出现在文件名里也不算项目特有（index、main、config 这类）
const COMMON = new Set(['index', 'main', 'config', 'utils', 'util', 'test', 'tests', 'readme', 'build', 'pom', 'package', 'application', 'common', 'base', 'mapper', 'service', 'controller', 'entity', 'model', 'null', 'true', 'false', 'select', 'insert', 'update', 'delete', 'where', 'from', 'foreach', 'mybatis', 'spring', 'java', 'list', 'string', 'date', 'props', 'emit', 'null', 'undefined', 'json', 'html', 'http', 'https', 'axios', 'vuex', 'pinia', 'router', 'store', 'style', 'template', 'script', 'async', 'await', 'promise', 'transactional']);
/** 规则文字里这个项目特有的名字：和仓库里某个文件同名的词，或者带下划线、在仓库里搜得到的词（表名、字段名） */
function projectNames(text, root) {
  const words = [...new Set(String(text || '').match(IDENT) || [])].filter((w) => !COMMON.has(w.toLowerCase()));
  if (!words.length || !root) return [];
  const stems = fileStems(root);
  const out = [];
  for (const w of words.slice(0, 12)) {
    if (stems && stems.has(w)) { out.push(w); continue; }
    if (!/_/.test(w) || !isGitRepo(root)) continue;
    try { git(root, ['grep', '-q', '-w', '-F', '-e', w, '--', '.'].concat(NOT_CODE), { timeout: 5000 }); out.push(w); } catch (e) { /* 搜不到，或者搜不了 */ }
  }
  return out;
}
/** 这些名字现在还在不在项目里（一个都不在了 = 规则过时了）。查不了的当成还在 */
function namesAlive(names, root) {
  if (!names || !names.length) return true;
  const stems = fileStems(root);
  if (!stems) return true;
  for (const w of names) {
    if (stems.has(w)) return true;
    try { git(root, ['grep', '-q', '-w', '-F', '-e', w, '--', '.'].concat(NOT_CODE), { timeout: 5000 }); return true; } catch (e) { if (e && e.status !== 1) return true; }
  }
  return false;
}

// ---------- 像不像同一条 ----------
function tokensOf(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z_][a-z0-9_]+/g) || []) out.add(w);
  for (const seg of t.replace(/[^一-龥]+/g, ' ').split(' ')) {
    if (!seg) continue;
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}
function similarity(a, b) {
  const A = tokensOf(a);
  const B = tokensOf(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}
const idOf = (text, taken) => {
  const h = crypto.createHash('sha1').update([...tokensOf(text)].sort().join('|')).digest('hex');
  for (let n = 6; n <= 12; n += 2) { const id = 'L' + h.slice(0, n); if (!taken || !taken.has(id)) return id; }
  return 'L' + h.slice(0, 12);
};

// ---------- 规则文件：读、写 ----------
function parseFrontPaths(front) {
  const out = [];
  const lines = front.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^paths\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest) { for (const p of rest.replace(/^\[|\]$/g, '').split(',')) { const v = p.trim().replace(/^["']|["']$/g, ''); if (v) out.push(v); } continue; }
    for (let k = i + 1; k < lines.length; k++) { const it = /^\s+-\s*(.+)$/.exec(lines[k]); if (!it) break; out.push(it[1].trim().replace(/^["']|["']$/g, '')); }
  }
  return out;
}
function parseMeta(s) {
  const m = { count: 1, last: '', miss: 0, kind: '', names: [], from: [], auto: '' };
  // 出处在最后，里面可以有空格；前面的都是 键=值，用空格分开
  const at = s.indexOf(' 出处=');
  const head = at >= 0 ? s.slice(0, at) : s;
  if (at >= 0) m.from = s.slice(at + 4).split(/[；;]/).map((x) => x.trim()).filter(Boolean);
  for (const kv of head.split(/\s+/)) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === '次数') m.count = Math.max(1, parseInt(v, 10) || 1);
    else if (k === '最近') m.last = v;
    else if (k === '没管住') m.miss = Math.max(0, parseInt(v, 10) || 0);
    else if (k === '类别') m.kind = v;
    else if (k === '自动') m.auto = v;
    else if (k === '名字') m.names = v.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return m;
}
/**
 * 读一个规则文件：{ exists, paths, title, manual: 手写的行（原样）, rules: [{ id, text, count, last, miss, kind, names, from }] }。
 * 有编号注释、下面紧跟着一条 "- …" 的是工具管的规则；别的行（标题和说明注释除外）都当手写的，原样留着
 */
function readRuleFile(file) {
  const out = { exists: false, paths: [], title: '', manual: [], rules: [] };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  out.exists = true;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');
  let body = text;
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) { out.paths = parseFrontPaths(text.slice(4, end)); body = text.slice(text.indexOf('\n', end + 1) + 1); }
  }
  const lines = body.split('\n');
  let pending = null;
  for (const l of lines) {
    const t = l.trim();
    if (/^<!--\s*vibe-kit 经验规则/.test(t)) continue;
    const mm = /^<!--\s*(L[0-9a-f]{6,12})\s+(.*?)\s*-->$/.exec(t);
    if (mm) { if (pending) out.manual.push(pending.raw); pending = { id: mm[1], meta: parseMeta(' ' + mm[2]), raw: l }; continue; }
    if (pending) {
      if (!t) continue;
      const b = /^[-*]\s+(.+)$/.exec(t);
      if (b) { out.rules.push(Object.assign({ id: pending.id, text: b[1].trim() }, pending.meta)); pending = null; continue; }
      // 注释下面不是规则（被人改过）：注释丢掉，这一行按手写的留着
      pending = null;
    }
    if (!out.title && /^#\s+\S/.test(t)) { out.title = t; continue; }
    if (t) out.manual.push(l.replace(/\s+$/, ''));
  }
  return out;
}
function defaultTitle(scope, group) {
  const info = groupInfo(group) || { title: group };
  const what = group === 'spec' ? '写提案、设计、任务时注意' : '写' + info.title + '时注意';
  return '# ' + what + (scope === 'user' ? '（几个项目的审查里都出现过）' : '（这个项目的审查里反复出现过）');
}
function renderRuleFile(data, scope, group) {
  const info = groupInfo(group) || { paths: [] };
  const paths = data.paths && data.paths.length ? data.paths : info.paths;
  const L = ['---', 'paths:'].concat(paths.map((p) => '  - "' + p + '"'), ['---', HEADER, '', data.title || defaultTitle(scope, group), '']);
  if (data.manual.length) { L.push(...data.manual); L.push(''); }
  for (const r of data.rules) {
    const meta = [r.id, '次数=' + (r.count || 1), '最近=' + (r.last || today())];
    if (r.miss) meta.push('没管住=' + r.miss);
    if (r.kind) meta.push('类别=' + metaSafe(r.kind).replace(/\s/g, ''));
    if (r.auto) meta.push('自动=' + metaSafe(r.auto).replace(/\s/g, ''));
    if (r.names && r.names.length) meta.push('名字=' + r.names.map((n) => metaSafe(n).replace(/[\s,]/g, '')).join(','));
    if (r.from && r.from.length) meta.push('出处=' + r.from.slice(-4).map(metaSafe).join('；'));
    L.push('<!-- ' + meta.join(' ') + ' -->');
    L.push('- ' + oneLine(r.text));
  }
  return L.join('\n').replace(/\n+$/, '') + '\n';
}
/**
 * 先写临时文件再改名过去，别的会话不会读到写了一半的。
 * 临时文件名带进程号、线程号和一段随机数：HTTP 方式下两个会话的钩子在同一个进程的两个线程里跑，只带进程号会撞。
 * 改名不成（杀毒、索引正占着）多试几次；一直不成就抛出来，不退回去直接覆盖着写（那不是一步到位的，别人会读到半截）
 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let tid = 0;
  try { tid = require('worker_threads').threadId || 0; } catch (e) { tid = 0; }
  const tmp = file + '.' + process.pid + '-' + tid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    let last = null;
    for (let i = 0; i < 6; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) { last = e; try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch (e2) { /* 等不了就直接再试 */ } }
    }
    throw last;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* 没有临时文件 */ }
    throw e;
  }
}
/**
 * 读一个本机的记录文件（候选、审查问题、跨项目的记录）。没有这个文件返回 null。
 * 文件在、却读不懂（被人改坏了、磁盘出过错）：把它改名留着（<名字>.bad），当成没有。
 * 不能当成空的直接写回去：那样攒下的全没了，连坏掉之前的样子都找不回来
 */
function readStore(file) {
  let t;
  try { t = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  try { const j = JSON.parse(t); if (j && typeof j === 'object') return j; } catch (e) { /* 读不懂 */ }
  if (!t.trim()) return null;
  try { fs.renameSync(file, file + '.bad'); } catch (e) { /* 留不下来也不能挡着后面的事 */ }
  return null;
}
/** 写规则文件。一条规则都没有、也没有手写的内容：删掉文件（空文件留着还会被加载） */
function writeRuleFile(file, data, scope, group) {
  if (!data.rules.length && !data.manual.length) { try { fs.unlinkSync(file); } catch (e) { /* 本来就没有 */ } return false; }
  writeFileAtomic(file, renderRuleFile(data, scope, group));
  return true;
}
const bulletsOf = (data) => data.rules.length + data.manual.filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
const charsOf = (data) => data.rules.reduce((n, r) => n + r.text.length, 0) + data.manual.reduce((n, l) => n + l.trim().length, 0);
/** 超过上限：挤掉次数最少、最久没再出现的（keep 这一条不挤）。返回被挤掉的 */
function squeeze(data, st, keep) {
  const out = [];
  const over = () => bulletsOf(data) > st.maxPerGroup || charsOf(data) > st.maxPerGroup * st.maxChars;
  while (over()) {
    const cand = data.rules.filter((r) => r.id !== keep).sort((a, b) => (a.count - b.count) || String(a.last).localeCompare(String(b.last)));
    if (!cand.length) break;
    data.rules = data.rules.filter((r) => r !== cand[0]);
    out.push(cand[0]);
  }
  return out;
}
const sortRules = (data) => { data.rules.sort((a, b) => (b.count - a.count) || String(b.last).localeCompare(String(a.last))); };

/**
 * 规则文件改名（vibe-lessons-*.md → ttls-lessons-*.md）。目录里还有旧名字的文件：并进新名字的文件里，旧文件删掉。
 * 同事还没升级的那几天两种名字可能同时在（他的旧版套件还会往旧名字里写）：同一条（编号一样，或者文字差不多）留一条，
 * 次数取大的、出处合起来。scope 是 project 时两个文件都记下来，收工检查会催提交（旧文件的删除也要提交）。
 * 返回挪了几个文件。挪不了（只读、被占用）就留着旧的，下次再试
 */
function migrateNames(dir, scope, root) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  let n = 0;
  for (const name of names) {
    const m = OLD_FILE_RE.exec(name);
    if (!m) continue;
    const group = m[1].toLowerCase();
    const oldFile = path.join(dir, name);
    const newFile = ruleFileOf(dir, group);
    try {
      const old = readRuleFile(oldFile);
      const cur = readRuleFile(newFile);
      const data = cur.exists ? cur : { exists: true, paths: old.paths, title: old.title, manual: [], rules: [] };
      if (!data.title) data.title = old.title;
      if (!data.paths.length) data.paths = old.paths;
      for (const l of old.manual) if (!data.manual.some((x) => x.trim() === l.trim())) data.manual.push(l);
      for (const r of old.rules) {
        const same = data.rules.find((q) => q.id === r.id) || data.rules.find((q) => similarity(q.text, r.text) >= SAME);
        if (!same) { data.rules.push(r); continue; }
        same.count = Math.max(same.count || 1, r.count || 1);
        same.miss = Math.max(same.miss || 0, r.miss || 0);
        if (String(r.last) > String(same.last)) same.last = r.last;
        same.from = [...new Set((same.from || []).concat(r.from || []))].slice(-4);
        same.names = [...new Set((same.names || []).concat(r.names || []))];
      }
      sortRules(data);
      writeRuleFile(newFile, data, scope === 'user' ? 'user' : 'project', group);
      fs.unlinkSync(oldFile);
      if (scope !== 'user' && root) { noteWritten(newFile, root); noteWritten(oldFile, root); }
      n++;
    } catch (e) { /* 这一个挪不了，留着 */ }
  }
  return n;
}
function listRuleFiles(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names.sort()) { const m = FILE_RE.exec(n); if (m) out.push({ group: m[1].toLowerCase(), file: path.join(dir, n) }); }
  return out;
}

// ---------- 候选（只在本机） ----------
const candidatesFile = (root) => path.join(root, '.vibe', 'lessons', 'candidates.json');
function readCandidates(root) {
  const j = readStore(candidatesFile(root));
  return j && Array.isArray(j.items) ? j.items : [];
}
const MAX_CANDIDATES = 200;
const MAX_AUTO_CANDIDATES = 120;
/** 用户在配置页里删掉的（以后不再出） */
const removedByUser = (c) => !!c && c.state === 'retired' && (c.byUser === true || /配置页里删掉/.test(String(c.why || '')));
function writeCandidates(root, items) {
  // 候选太多时先丢自动收的、只出现过一次的、最老的。"用户删过"的记录和模型手记的不能被自动收的挤掉：
  // 自动收几乎每条新问题都新建一个候选，几十个变更之后就满了
  let list = items.slice();
  const newest = (a, b) => String(b.last).localeCompare(String(a.last));
  const auto = list.filter((c) => c.auto && !removedByUser(c)).sort((a, b) => (distinctChanges(b.sources) - distinctChanges(a.sources)) || newest(a, b));
  if (auto.length > MAX_AUTO_CANDIDATES) { const drop = new Set(auto.slice(MAX_AUTO_CANDIDATES)); list = list.filter((c) => !drop.has(c)); }
  if (list.length > MAX_CANDIDATES) {
    const keep = list.filter(removedByUser);
    const rest = list.filter((c) => !removedByUser(c)).sort(newest).slice(0, Math.max(0, MAX_CANDIDATES - keep.length));
    list = keep.concat(rest);
  }
  const f = candidatesFile(root);
  writeFileAtomic(f, JSON.stringify({ version: 1, items: list }, null, 1) + '\n');
  try { ensureVibeIgnored(f); } catch (e) { /* 加不上不影响记录 */ }
}
const changeOf = (from) => oneLine(from).split(' ')[0].toLowerCase();
const distinctChanges = (sources) => new Set((sources || []).map((s) => changeOf(s.from)).filter(Boolean)).size;

// ---------- 跨项目的记录（只在本机） ----------
function readIndex() {
  const j = readStore(INDEX_FILE);
  return j ? { projects: j.projects && typeof j.projects === 'object' ? j.projects : {}, lessons: Array.isArray(j.lessons) ? j.lessons : [] } : { projects: {}, lessons: [] };
}
function writeIndex(idx) { writeFileAtomic(INDEX_FILE, JSON.stringify(idx, null, 1) + '\n'); }
function noteProject(idx, root) { idx.projects[normKey(root)] = { root, name: path.basename(root), at: Date.now() }; }
/** 项目里升成了规则：记进跨项目的记录。两个不同的项目里都有、又不含项目特有的名字 → 待确认（lessonPromote 是 auto 就直接升） */
function indexPromotion(root, rule, st) {
  const idx = readIndex();
  noteProject(idx, root);
  let it = idx.lessons.map((l) => ({ l, s: similarity(l.text, rule.text) })).filter((x) => x.s >= SAME).sort((a, b) => b.s - a.s).map((x) => x.l)[0];
  if (!it) { it = { id: idOf(rule.text, new Set(idx.lessons.map((l) => l.id))), text: rule.text, group: rule.group, kind: rule.kind || '', projects: {}, state: 'seen', at: Date.now() }; idx.lessons.push(it); }
  it.projects[normKey(root)] = { root, id: rule.id, at: Date.now(), names: (rule.names || []).length };
  let note = '';
  const clean = Object.values(it.projects).every((p) => !p.names);
  if (it.state === 'seen' && Object.keys(it.projects).length >= 2 && clean) {
    it.state = 'pending';
    it.at = Date.now();
    note = '这一条在 ' + Object.keys(it.projects).length + ' 个项目里都成了规则，已列为"可以升成用户级"，等用户在配置页确认。';
  }
  if (idx.lessons.length > 500) idx.lessons = idx.lessons.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 500);
  writeIndex(idx);
  if (it.state === 'pending' && st.promote === 'auto') { const r = promoteUser(it.id, st); if (r.ok) note = '这一条在几个项目里都成了规则，已经升成用户级（' + r.file + '）。'; }
  return note;
}
const pendingUser = () => readIndex().lessons.filter((l) => l.state === 'pending');

/** 升成用户级：写进 ~/.claude/rules/。只给配置页（用户点的）和 lessonPromote=auto 用，命令行工具里没有这一条 */
function promoteUser(id, st0) {
  migrateNames(USER_RULES_DIR, 'user');
  const st = st0 || settings();
  const idx = readIndex();
  const it = idx.lessons.find((l) => l.id === id);
  if (!it) return { ok: false, msg: '没有这一条：' + id };
  const group = groupInfo(it.group) ? it.group : 'other-txt';
  const file = ruleFileOf(USER_RULES_DIR, group);
  const data = readRuleFile(file);
  const dup = data.rules.find((r) => similarity(r.text, it.text) >= SAME);
  if (!dup) {
    const count = Object.keys(it.projects).length;
    data.rules.push({ id: idOf(it.text, new Set(data.rules.map((r) => r.id))), text: it.text, count, last: today(), miss: 0, kind: it.kind || '', names: [], from: Object.values(it.projects).map((p) => path.basename(p.root)) });
  }
  const out = squeeze(data, st, dup ? dup.id : data.rules[data.rules.length - 1].id);
  sortRules(data);
  writeRuleFile(file, data, 'user', group);
  it.state = 'user';
  it.at = Date.now();
  writeIndex(idx);
  return { ok: true, file, squeezed: out.map((r) => r.text) };
}
function dismissUser(id) {
  const idx = readIndex();
  const it = idx.lessons.find((l) => l.id === id);
  if (!it) return { ok: false, msg: '没有这一条：' + id };
  it.state = 'dismissed';
  it.at = Date.now();
  writeIndex(idx);
  return { ok: true };
}

// ---------- 规则文件改了之后：记下来，收工检查催一次提交 ----------
function noteWritten(file, root) {
  try { updateState('lesson-commit', (o) => { const files = o.files && typeof o.files === 'object' ? o.files : {}; files[normKey(file)] = { file, repo: root, at: Date.now() }; for (const k of Object.keys(files)) if (Date.now() - (files[k].at || 0) > 30 * 86400000) delete files[k]; return { files }; }); } catch (e) { /* 记不了就不催 */ }
}
/**
 * 改过、还没提交的项目级规则文件：[{ file, repo, rel }]。已经提交了的、文件没了的、被 .gitignore 忽略的（只在本机）、
 * 不在 git 仓库里的，顺手从记录里去掉。under 给了就只看这个目录之下（或者包着这个目录）的仓库
 */
function uncommitted(under) {
  const rec = readState('lesson-commit');
  const files = rec.files && typeof rec.files === 'object' ? rec.files : {};
  const out = [];
  const drop = [];
  const u = under ? normKey(under) : '';
  for (const k of Object.keys(files)) {
    const f = files[k];
    if (!f || !f.file || !f.repo) { drop.push(k); continue; }
    const r = normKey(f.repo);
    if (u && !(r === u || r.startsWith(u + '/') || u.startsWith(r + '/'))) continue;
    if (!isGitRepo(f.repo)) { drop.push(k); continue; }
    const rel = path.relative(f.repo, f.file).split(path.sep).join('/');
    try {
      let ignored = false;
      try { git(f.repo, ['check-ignore', '-q', '--', rel]); ignored = true; } catch (e) { ignored = false; }
      if (ignored) { drop.push(k); continue; }
      const s = git(f.repo, ['status', '--porcelain', '--', rel]).trim();
      if (!s) { drop.push(k); continue; }
      out.push({ file: f.file, repo: f.repo, rel });
    } catch (e) { /* 查不了：这次不催，记录留着 */ }
  }
  if (drop.length) { try { updateState('lesson-commit', (o) => { const fs2 = (o.files && typeof o.files === 'object') ? o.files : {}; for (const k of drop) delete fs2[k]; return { files: fs2 }; }); } catch (e) { /* 忽略 */ } }
  return out;
}
function ignoredByGit(root, file) {
  if (!isGitRepo(root)) return false;
  try { git(root, ['check-ignore', '-q', '--', path.relative(root, file).split(path.sep).join('/')]); return true; } catch (e) { return false; }
}

// ---------- 记一条 ----------
const HEDGE = /(尽量|视情况|酌情|适当地?|可能需要|一般来说|原则上|必要时)/;
/** 约定、项目 CLAUDE.md 里已经有差不多的话了：返回那句话 */
function alreadyInConventions(text, root) {
  const files = [path.join(CFG_DIR, 'CLAUDE.md')];
  if (root) files.push(path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md'));
  for (const f of files) {
    let t = '';
    try { t = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const l of t.split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(.{8,})$/.exec(l);
      if (m && similarity(m[1], text) >= SAME) return { file: f, line: oneLine(m[1]).slice(0, 80) };
    }
  }
  return null;
}
/** 项目里现在生效的规则（所有分组）+ 候选 + 用户级规则，带上各自在哪 */
function loadAll(root) {
  migrateNames(projectRulesDir(root), 'project', root);
  migrateNames(USER_RULES_DIR, 'user');
  const project = [];
  for (const rf of listRuleFiles(projectRulesDir(root))) { const d = readRuleFile(rf.file); for (const r of d.rules) project.push({ where: 'project', group: rf.group, file: rf.file, rule: r }); }
  const user = [];
  for (const rf of listRuleFiles(USER_RULES_DIR)) { const d = readRuleFile(rf.file); for (const r of d.rules) user.push({ where: 'user', group: rf.group, file: rf.file, rule: r }); }
  return { project, user, candidates: readCandidates(root) };
}
/**
 * 记一条经验。o: { file, when, do, text, from, kind, same, isNew, cwd }
 * 返回 { status, msg, ... }：
 *   rejected 写法不合要求；near 有相近的、要模型自己认（加 --same <编号> 或 --new 再来一次）；
 *   candidate 进了候选；promoted 升成了规则；hit 这条已经是规则了、这次又犯了；off 功能关着
 */
function add(o, cfg) {
  const st = settings(cfg);
  if (st.mode === 'off') return { status: 'off', msg: '经验规则关着（配置页"经验规则"里可以打开），这次没有记。' };
  const cwd = o.cwd || process.cwd();
  const text = oneLine(o.text || [o.when, o.do].map(oneLine).filter(Boolean).join('：'));
  const from = oneLine(o.from);
  if (!o.file) return { status: 'rejected', msg: '要写出问题的文件（--file）：用它来定这条经验属于哪个项目、读到哪类文件时带上。' };
  if (!from) return { status: 'rejected', msg: '要写出处（--from "<变更名> <任务号>"；不走提案的小改动写日期加一两个词）：同一条在不同的变更里出现过才会变成规则。' };
  if (text.length < 8) return { status: 'rejected', msg: '太短了：写清"什么情况下（--when）"和"要怎么做（--do）"。' };
  if (text.length > st.maxChars) return { status: 'rejected', msg: '太长了（' + text.length + ' 字，最多 ' + st.maxChars + ' 字）：一条规则一句话，只留"什么情况下、要怎么做"，原因和经过不用写。' };
  if (/<!--|-->|^#|\n/.test(text)) return { status: 'rejected', msg: '规则里不要带注释符号、标题符号。' };
  const hedge = HEDGE.exec(text);
  if (hedge) return { status: 'rejected', msg: '"' + hedge[1] + '"这种话写进规则没有用：写成能照着做的，什么情况下、具体怎么做。' };
  const group = groupOf(o.file);
  if (!group) return { status: 'rejected', msg: '从 ' + o.file + ' 看不出是哪类文件（要带扩展名）。' };
  const root = repoRootOf(o.file, cwd);
  if (!root) return { status: 'rejected', msg: o.file + ' 不在任何项目里（往上找不到 git 仓库，也没有项目说明）：--file 写出问题的那个文件。' };
  const conv = alreadyInConventions(text, root);
  if (conv) return { status: 'rejected', msg: '约定里已经有差不多的话了（' + conv.file + '："' + conv.line + '"），不用再记。约定里写了还犯的，说明光写不够：用 --checkable 说明怎么用脚本查出来，转给改套件的人。' };

  const all = loadAll(root);
  const taken = new Set(all.project.map((x) => x.rule.id).concat(all.user.map((x) => x.rule.id), all.candidates.map((c) => c.id)));
  const pool = all.project.map((x) => ({ kind: 'project', id: x.rule.id, text: x.rule.text, ref: x }))
    .concat(all.user.map((x) => ({ kind: 'user', id: x.rule.id, text: x.rule.text, ref: x })))
    .concat(all.candidates.filter((c) => c.state !== 'retired').map((c) => ({ kind: 'candidate', id: c.id, text: c.text, ref: c })));
  // 用户在配置页里删掉过的：不再记回来
  const gone = all.candidates.filter(removedByUser).find((c) => similarity(c.text, text) >= SAME || (c.alt && similarity(c.alt, text) >= SAME));
  if (gone && !o.same) return { status: 'rejected', msg: '这一条用户在配置页里删过（' + gone.id + '："' + gone.text + '"），不再记。觉得确实该有这条规则，在交代里告诉用户，由用户决定。' };
  let target = null;
  if (o.same) {
    target = pool.find((p) => p.id.toLowerCase() === String(o.same).toLowerCase());
    if (!target) return { status: 'rejected', msg: '没有编号是 ' + o.same + ' 的规则或候选。node lesson.js list 能看到现有的。' };
  } else {
    const scored = pool.map((p) => ({ p, s: similarity(p.text, text) })).sort((a, b) => b.s - a.s);
    if (scored.length && scored[0].s >= SAME) target = scored[0].p;
    else if (!o.isNew) {
      const near = scored.filter((x) => x.s >= NEAR).slice(0, 3);
      if (near.length) {
        return { status: 'near', near: near.map((x) => ({ id: x.p.id, text: x.p.text, kind: x.p.kind })),
          msg: '已有相近的：\n' + near.map((x) => '  ' + x.p.id + '  ' + (x.p.kind === 'candidate' ? '候选' : x.p.kind === 'user' ? '用户级规则' : '项目规则') + '  ' + x.p.text).join('\n')
            + '\n说的是同一件事：原样再执行一次，末尾加 --same <编号>。不是同一件事：末尾加 --new。' };
      }
    }
  }
  const src = { from, at: today() };

  // 已经是生效的规则、这次还是犯了：记一次"没管住"
  if (target && (target.kind === 'project' || target.kind === 'user')) {
    const x = target.ref;
    const data = readRuleFile(x.file);
    const r = data.rules.find((q) => q.id === x.rule.id);
    if (r) {
      const seen = new Set((r.from || []).map(changeOf));
      if (!seen.has(changeOf(from))) { r.count = (r.count || 1) + 1; r.miss = (r.miss || 0) + 1; r.from = (r.from || []).concat(from).slice(-4); }
      r.last = today();
      sortRules(data);
      writeRuleFile(x.file, data, target.kind, x.group);
      if (target.kind === 'project') noteWritten(x.file, root);
      return { status: 'hit', id: r.id, file: x.file, miss: r.miss || 0, scope: target.kind,
        msg: '这条已经是' + (target.kind === 'user' ? '用户级' : '项目') + '规则了（' + r.id + '："' + r.text + '"），这次还是犯了：已记一次"没管住"（共 ' + (r.miss || 0) + ' 次）。'
          + ((r.miss || 0) >= 2 ? '写了规则还反复犯，光靠规则管不住：交代里告诉用户，建议改成脚本检查。' : '')
          + (target.kind === 'project' ? commitHint(root, x.file) : '') };
    }
  }

  const items = all.candidates;
  let cand = target && target.kind === 'candidate' ? items.find((c) => c.id === target.id) : null;
  if (!cand) {
    cand = { id: idOf(text, taken), text, group, kind: KINDS.includes(o.kind) ? o.kind : oneLine(o.kind).slice(0, 12), file: path.relative(root, path.resolve(cwd, String(o.file).replace(/:\d+(?::\d+)?$/, ''))).split(path.sep).join('/'), sources: [], first: today(), last: today(), state: 'candidate' };
    items.push(cand);
  }
  if (!cand.sources.some((s) => changeOf(s.from) === changeOf(from))) cand.sources.push(src);
  cand.last = today();
  if (cand.state === 'evicted') cand.state = 'candidate';
  const n = distinctChanges(cand.sources);
  try { const idx = readIndex(); noteProject(idx, root); writeIndex(idx); } catch (e) { /* 记不了不影响 */ }

  if (n < st.threshold || st.mode === 'collect') {
    writeCandidates(root, items);
    return { status: 'candidate', id: cand.id, count: n, root,
      msg: '已记下（' + cand.id + '，第 ' + n + ' 次）。' + (st.mode === 'collect' ? '现在只收集、不生成规则（配置页"经验规则"里可以打开）。' : '同样的问题在别的变更里再出现 ' + (st.threshold - n) + ' 次，就会变成这个项目的规则。') };
  }

  // 升成项目规则
  const file = ruleFileOf(projectRulesDir(root), cand.group);
  const data = readRuleFile(file);
  // 顺手退掉过时的：规则里提到的名字在项目里一个都找不到了
  const stale = data.rules.filter((r) => r.names && r.names.length && !namesAlive(r.names, root));
  data.rules = data.rules.filter((r) => !stale.includes(r));
  const rule = { id: cand.id, text: cand.text, count: n, last: today(), miss: 0, kind: cand.kind || '', names: projectNames(cand.text, root), from: cand.sources.map((s) => s.from).slice(-4), group: cand.group };
  data.rules.push(rule);
  const squeezed = squeeze(data, st, rule.id);
  sortRules(data);
  writeRuleFile(file, data, 'project', cand.group);
  noteWritten(file, root);
  let rest = items.filter((c) => c !== cand);
  for (const r of squeezed) rest.push({ id: r.id, text: r.text, group: cand.group, kind: r.kind || '', file: '', sources: (r.from || []).map((f) => ({ from: f, at: r.last })), first: r.last, last: r.last, state: 'evicted' });
  for (const r of stale) rest.push({ id: r.id, text: r.text, group: cand.group, kind: r.kind || '', file: '', sources: [], first: r.last, last: today(), state: 'retired', why: '规则里提到的 ' + r.names.join('、') + ' 在项目里找不到了' });
  writeCandidates(root, rest);
  let note = '';
  try { note = indexPromotion(root, rule, st); } catch (e) { note = ''; }
  const info = groupInfo(cand.group);
  return { status: 'promoted', id: rule.id, file, root, squeezed: squeezed.map((r) => r.text), stale: stale.map((r) => r.text),
    msg: '第 ' + n + ' 次出现，已升成这个项目的规则（' + rule.id + '）：' + file + '。以后读到 ' + info.paths.slice(0, 3).join('、') + (info.paths.length > 3 ? ' 等' : '') + ' 的文件时会自动带上。'
      + (squeezed.length ? '这一组满了，挤掉了 ' + squeezed.length + ' 条最久没再出现的（退回候选）。' : '')
      + (stale.length ? '顺手退掉了 ' + stale.length + ' 条过时的（提到的类、文件、表已经不在了）。' : '')
      + (note ? note : '') + commitHint(root, file) };
}
function commitHint(root, file) {
  if (!isGitRepo(root)) return '';
  const rel = path.relative(root, file).split(path.sep).join('/');
  if (ignoredByGit(root, file)) return '\n这个仓库的 .gitignore 忽略了它，规则只在本机生效；要让同事的 Claude 也看到，让用户在 .gitignore 里放开 .claude/rules/。';
  return '\n规则文件跟着仓库走：git -C "' + root + '" add "' + rel + '"，提交信息写"docs: 更新经验规则"（和这次的修复分开提交）。';
}

// ---------- 审查报的问题：自动收、自动归并 ----------
const findingsFile = (root) => path.join(root, '.vibe', 'lessons', 'findings.json');
const FIELD_NAMES = ['位置', '问题', '什么情况下会出错', '严重程度', '类别', '以后怎么避免'];
const FIELD = /^\s*(?:[-*•]|\d+[.)、])?\s*\**\s*(位置|问题|什么情况下会出错|严重程度|类别|以后怎么避免)(?:（[^）]*）|\([^)]*\))?\s*\**\s*[:：]\s*\**\s*(.*?)\s*$/;
// "以后怎么避免"写的是这些开头的：一次性的疏忽，换个任务不会再犯，不收。
// 只看开头："无（一次性疏忽）""不适用，笔误"也算；整句才算的话，这几个字会被当成规则的文字收进去
const NO_AVOID = /^(无|没有|暂无|不适用|不用|不需要|一次性|n\/?a|none|[-—–]+)(?=$|[\s，,。.；;：:（(、])/i;
// 自动归并没有人来认"是不是同一件事"：门槛要靠近"当成同一条"的那条线。
// 短的中文句子里"之前""先按"这类套话占比高，0.45 会把"先按主键去重"和"先按主键排序"并成一条
const AUTO_NEAR = 0.62;
const MAX_FINDINGS = 400;
/** 位置那一栏里的文件：取第一个；括号里的说明、行号（:45、:45-60、#L45、第 45 行、45~60 行）去掉 */
function fileOfWhere(where) {
  let s = String(where || '').split(/[、，；;]|,\s/)[0].replace(/\x60/g, '').trim();
  s = s.replace(/[（(][^（）()]*[）)]?/g, ' ').trim();
  s = s.replace(/\s*第\s*\d+(?:\s*[-~～到至]\s*\d+)?\s*行.*$/, '').replace(/#L\d+(?:-L?\d+)?$/i, '');
  s = s.replace(/[:：]\s*\d+(?:\s*[-~～:：,]\s*\d+)*\s*行?\s*$/, '').replace(/\s+\d+(?:\s*[-~～]\s*\d+)?\s*行?\s*$/, '');
  return s.trim().replace(/^["']+|["']+$/g, '');
}
/**
 * 从审查者的回复里取出一条条问题：[{ where, file, problem, when, severity, kind, avoid }]。
 * 认的是审查代理约定的写法：每条有"位置""问题""什么情况下会出错""严重程度""类别""以后怎么避免"几行；写成表格的也认。
 * 几个字段谁先谁后都行：一条里同一个字段出现第二次，就是下一条开始了。缺"位置"或者缺"问题"的那一条不收。
 * avoid 是"以后怎么避免"那一句：没写是 ''，写了"无"是 '无'
 */
function parseFindings(text) {
  const out = [];
  let cur = null;
  const fresh = () => ({ where: '', file: '', problem: '', when: '', severity: '', kind: '', avoid: '', has: new Set() });
  const close = () => { if (cur && cur.where && cur.file && cur.problem) { delete cur.has; out.push(cur); } cur = null; };
  const put = (name, raw) => {
    const v = String(raw || '').replace(/^[\x60*\s]+|[\x60*\s]+$/g, '');
    if (!cur || cur.has.has(name) || (name === '位置' && cur.has.size && cur.where)) { close(); cur = fresh(); }
    cur.has.add(name);
    if (name === '位置') { cur.where = v; cur.file = fileOfWhere(v); }
    else if (name === '问题') cur.problem = oneLine(v);
    else if (name === '什么情况下会出错') cur.when = oneLine(v);
    else if (name === '严重程度') cur.severity = (/会出错|有隐患|建议/.exec(v) || [''])[0];
    else if (name === '类别') cur.kind = KINDS.find((k) => v.includes(k)) || oneLine(v).slice(0, 12);
    else if (name === '以后怎么避免') cur.avoid = NO_AVOID.test(oneLine(v)) ? '无' : oneLine(v);
  };
  let cols = null;        // 表格：每一列是哪个字段
  for (const l of String(text || '').split(/\r?\n/)) {
    const t = l.trim();
    if (/^\|.*\|$/.test(t)) {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim().replace(/^\*+|\*+$/g, ''));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      const names = cells.map((c) => FIELD_NAMES.find((n) => c.replace(/（[^）]*）|\([^)]*\)/g, '').trim() === n) || '');
      if (names.includes('位置') && names.includes('问题')) { close(); cols = names; continue; }
      if (cols) { close(); cur = fresh(); cells.forEach((c, i) => { if (cols[i] && c) put(cols[i], c); }); close(); }
      continue;
    }
    cols = null;
    const m = FIELD.exec(l);
    if (m) put(m[1], m[2]);
  }
  close();
  return out;
}
function readFindings(root) {
  const j = readStore(findingsFile(root));
  return j ? { items: Array.isArray(j.items) ? j.items : [], cats: j.cats && typeof j.cats === 'object' ? j.cats : {} } : { items: [], cats: {} };
}
function writeFindings(root, data) {
  let items = data.items;
  if (items.length > MAX_FINDINGS) items = items.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_FINDINGS);
  const f = findingsFile(root);
  writeFileAtomic(f, JSON.stringify({ version: 1, items, cats: data.cats }, null, 1) + '\n');
  try { ensureVibeIgnored(f); } catch (e) { /* 加不上不影响记录 */ }
}
function findingsSummary(root) {
  const d = readFindings(root);
  const by = {};
  for (const x of d.items) { const k = x.group + '|' + (x.kind || '其他'); const o = by[k] || (by[k] = { group: x.group, kind: x.kind || '其他', n: 0, changes: new Set(), last: '' }); o.n++; o.changes.add(String(x.change).toLowerCase()); if (String(x.day) > o.last) o.last = x.day; }
  return { total: d.items.length, by: Object.values(by).map((o) => ({ group: o.group, kind: o.kind, n: o.n, changes: o.changes.size, last: o.last })).sort((a, b) => b.changes - a.changes || b.n - a.n) };
}
/** 在候选和规则里记一次"这个变更里出现过"。和 add 走同一条路，差别是没有人来认相近的：相近又同类的直接当成同一条 */
function addAuto(root, st, o) {
  const text = oneLine(o.text).slice(0, st.maxChars);
  if (text.length < 6 || /<!--|-->/.test(text)) return { status: 'skipped' };
  if (alreadyInConventions(text, root)) return { status: 'skipped' };
  const all = loadAll(root);
  const taken = new Set(all.project.map((x) => x.rule.id).concat(all.user.map((x) => x.rule.id), all.candidates.map((c) => c.id)));
  // 退役的也拿来比：用户在配置页里删掉的那一条，下次收到差不多的问题不能又出一遍
  const pool = all.project.map((x) => ({ where: 'project', id: x.rule.id, text: x.rule.text, kind: x.rule.kind || '', group: x.group, ref: x }))
    .concat(all.user.map((x) => ({ where: 'user', id: x.rule.id, text: x.rule.text, kind: x.rule.kind || '', group: x.group, ref: x })))
    .concat(all.candidates.filter((c) => c.state !== 'retired' || removedByUser(c)).map((c) => ({ where: removedByUser(c) ? 'removed' : 'candidate', id: c.id, text: c.text, alt: c.alt || '', kind: c.kind || '', group: c.group, ref: c })));
  // 同一个问题两次审出来，一次有"以后怎么避免"、一次没有，文字差得远：把"问题"那一句（also、alt）也拿来比，取最像的
  const also = oneLine(o.also || '');
  const sim = (p) => Math.max(similarity(p.text, text), also ? similarity(p.text, also) : 0, p.alt ? similarity(p.alt, text) : 0, p.alt && also ? similarity(p.alt, also) : 0);
  const hit = pool.map((p) => ({ p, s: sim(p) })).filter((x) => x.s >= SAME || (x.s >= AUTO_NEAR && x.p.group === o.group && (!x.p.kind || !o.kind || x.p.kind === o.kind))).sort((a, b) => b.s - a.s)[0];
  const target = hit ? hit.p : null;
  if (target && target.where === 'removed') return { status: 'removed', id: target.id };
  if (target && target.where !== 'candidate') {
    // 已经是规则了、这个变更里又被审出来：记一次"没管住"
    const data = readRuleFile(target.ref.file);
    const r = data.rules.find((q) => q.id === target.id);
    if (!r) return { status: 'skipped' };
    if ((r.from || []).map(changeOf).includes(changeOf(o.from))) return { status: 'known', id: r.id };
    r.count = (r.count || 1) + 1; r.miss = (r.miss || 0) + 1; r.last = today(); r.from = (r.from || []).concat(o.from).slice(-4);
    sortRules(data);
    writeRuleFile(target.ref.file, data, target.where, target.ref.group);
    if (target.where === 'project') noteWritten(target.ref.file, root);
    return { status: 'hit', id: r.id, text: r.text, miss: r.miss };
  }
  const items = all.candidates;
  let cand = target ? items.find((c) => c.id === target.id) : null;
  if (!cand) { cand = { id: idOf(text, taken), text, alt: also, group: o.group, kind: o.kind || '', file: o.rel || '', sources: [], first: today(), last: today(), state: 'candidate', auto: true }; items.push(cand); }
  // 以前收的时候审查者没写"以后怎么避免"，存的是"问题"那一句；这次写了：换成能照着做的这一句
  else if (cand.auto && !cand.alt && also) { cand.alt = cand.text; cand.text = text; }
  if (!cand.sources.some((s) => changeOf(s.from) === changeOf(o.from))) cand.sources.push({ from: o.from, at: today() });
  cand.last = today();
  if (cand.state === 'evicted') cand.state = 'candidate';
  const n = distinctChanges(cand.sources);
  if (n < st.threshold || st.mode === 'collect') { writeCandidates(root, items); return { status: 'candidate', id: cand.id, count: n }; }
  const file = ruleFileOf(projectRulesDir(root), cand.group);
  const data = readRuleFile(file);
  const rule = { id: cand.id, text: cand.text, count: n, last: today(), miss: 0, kind: cand.kind || '', names: projectNames(cand.text, root), from: cand.sources.map((s) => s.from).slice(-4), group: cand.group, auto: cand.auto ? '具体' : '' };
  data.rules.push(rule);
  const squeezed = squeeze(data, st, rule.id);
  sortRules(data);
  writeRuleFile(file, data, 'project', cand.group);
  noteWritten(file, root);
  const rest = items.filter((c) => c !== cand);
  for (const r of squeezed) rest.push({ id: r.id, text: r.text, group: cand.group, kind: r.kind || '', file: '', sources: (r.from || []).map((f) => ({ from: f, at: r.last })), first: r.last, last: r.last, state: 'evicted', auto: !!r.auto });
  writeCandidates(root, rest);
  try { indexPromotion(root, rule, st); } catch (e) { /* 记不了不影响 */ }
  return { status: 'promoted', id: rule.id, text: rule.text, file, count: n };
}
/** 同一类（同一种文件、同一个类别）在好几个变更里反复出现：出一条、或者更新那条"这一类要对照检查"的规则 */
// 编号按"哪一组、哪一类"定，不按文字：例子换了还是同一条。只用十六进制的字符（读规则文件时编号按这个认）
const categoryId = (group, kind) => 'L' + crypto.createHash('sha1').update('auto|' + group + '|' + kind).digest('hex').slice(0, 8);
/** 记一笔"这一类的规则出过了 / 被人删了"（记在本机的 findings.json 的 cats 里） */
function noteCategory(root, group, kind, patch) {
  const d = readFindings(root);
  const k = group + '|' + kind;
  d.cats[k] = Object.assign({}, d.cats[k] || {}, patch);
  writeFindings(root, d);
}
function categoryRule(root, st, group, kind, items0) {
  // 带着口令被遮过的那几条不拿来当例子
  const items = items0.filter((x) => !x.secret);
  const changes = [...new Set(items.map((x) => String(x.change).toLowerCase()))];
  const need = Math.max(3, st.threshold + 1);
  if (changes.length < need || st.mode === 'collect' || !kind || kind === '其他') return null;
  const id = categoryId(group, kind);
  // 文字里不放个数：个数是各人电脑上自己数的，每来一条就变，提交上去同事之间来回改同一行
  const head = kind + '类的问题在审查里反复出现，写完对照这一类自查。例如：';
  const recent = items.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const ex = [];
  const seenText = [];
  for (const x of recent) {
    const p = oneLine(x.problem).replace(/[。；;]+$/, '');
    if (!p || seenText.some((s) => similarity(s, p) >= AUTO_NEAR)) continue;
    const next = ex.concat(p.length > 36 ? p.slice(0, 35) + '…' : p);
    if ((head + next.join('；')).length > Math.max(st.maxChars, 80)) break;
    ex.push(next[next.length - 1]);
    seenText.push(p);
    if (ex.length >= 3) break;
  }
  if (!ex.length) return null;
  const text = head + ex.join('；');
  const file = ruleFileOf(projectRulesDir(root), group);
  const data = readRuleFile(file);
  const old = data.rules.find((r) => r.id === id);
  const cands = readCandidates(root);
  const cat = readFindings(root).cats[group + '|' + kind] || {};
  if (!old) {
    // 被人删过的不再出：在配置页里删的（退役记录、cats 里记着），或者直接在规则文件里把那一行删了的
    // （以前出过、现在文件里没有，又不是因为这一组满了被挤出去的）
    if (cat.removed || cands.some((c) => c.id === id && c.state === 'retired')) return null;
    if (cat.made && !cands.some((c) => c.id === id && c.state === 'evicted')) { noteCategory(root, group, kind, { removed: today() }); return null; }
  } else {
    // 人改过字的（改了之后不再标着"自动"）：是人的了，不动它
    if (old.auto !== '类别') return null;
    // 已经有了：文字不换（例子只在第一次出的时候写）。多出来好几个变更才更新一次次数，不是每来一条就改一次文件
    if (changes.length - (old.count || 0) < 3) return null;
    old.count = changes.length; old.last = today(); old.from = [...new Set(recent.map((x) => x.change))].slice(0, 4);
    sortRules(data);
    writeRuleFile(file, data, 'project', group);
    noteWritten(file, root);
    return { id, text: old.text, file, fresh: false, count: changes.length };
  }
  const from = [...new Set(recent.map((x) => x.change))].slice(0, 4);
  data.rules.push({ id, text, count: changes.length, last: today(), miss: 0, kind, names: [], from, auto: '类别' });
  noteCategory(root, group, kind, { made: today() });
  const squeezed = squeeze(data, st, id);
  sortRules(data);
  writeRuleFile(file, data, 'project', group);
  noteWritten(file, root);
  if (squeezed.length) { const rest = readCandidates(root); for (const r of squeezed) rest.push({ id: r.id, text: r.text, group, kind: r.kind || '', file: '', sources: (r.from || []).map((f) => ({ from: f, at: r.last })), first: r.last, last: r.last, state: 'evicted', auto: !!r.auto }); writeCandidates(root, rest); }
  return { id, text, file, fresh: true, count: changes.length };
}
/**
 * 审查之后在变更的 revisions.md 里被写成"不成立"的意见（模型核对过、驳回了的）：返回那几行。
 * 这样的意见不收：同一个文件因为别的问题改过，不等于这一条也成立
 */
function rejectedLines(cwd, source) {
  const name = String(source || '').split(' ')[0];
  if (!name || /^\d{4}-\d{2}-\d{2}$/.test(name)) return [];
  const out = [];
  const { changeRoots } = require('./session');
  for (const changes of changeRoots(cwd)) {
    const dirs = [path.join(changes, name)];
    try { for (const n of fs.readdirSync(path.join(changes, 'archive'))) if (n.toLowerCase().endsWith('-' + name.toLowerCase())) dirs.push(path.join(changes, 'archive', n)); } catch (e) { /* 没有 archive */ }
    for (const d of dirs) {
      let t = '';
      try { t = fs.readFileSync(path.join(d, 'revisions.md'), 'utf8'); } catch (e) { continue; }
      for (const l of t.split(/\r?\n/)) if (/不成立|驳回|不采纳|误报|不属实/.test(l)) out.push(oneLine(l));
    }
  }
  return out;
}
/**
 * 自动收审查报的问题。o: { reviews（lib/session.js 的 reviewsIn 给的，带审查者的原话 text）, edits: [{ file, pos }]（会话里改成功了的文件和位置）, cwd }
 * 只收：点名了变更的审查；严重程度是"会出错""有隐患"的；报了之后那个文件确实改过的。
 * 返回 { stored: 新收了几条, promoted: [升成规则的], category: [按类别出的规则], hit: [已经是规则、又被审出来的] }
 */
function autoCollect(o, cfg) {
  const st = settings(cfg);
  const out = { stored: 0, promoted: [], category: [], hit: [] };
  if (st.mode === 'off' || !st.auto) return out;
  const cwd = path.resolve(o.cwd || process.cwd());
  const edits = (o.edits || []).map((e) => { const abs = path.resolve(cwd, String(e.file)); return { key: normKey(abs), abs, pos: e.pos }; });
  const touched = new Map();      // 项目根 → { data, fresh: [新收的] }
  // 审查者写的路径可能是相对子项目的：当前目录下找不到，就到会话里改过的文件里找结尾对得上的。
  // 对得上好几个不同的文件（壳子里两个后端都改过 UserService.java）：分不清是哪个，这一条不收
  const locate = (file) => {
    const f = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!f || !/\.[A-Za-z0-9]+$/.test(f)) return '';
    const abs = path.resolve(cwd, f);
    if (fs.existsSync(abs)) return abs;
    const tail = '/' + f.toLowerCase();
    const hits = [...new Map(edits.filter((e) => e.key.endsWith(tail)).map((e) => [e.key, e])).values()];
    return hits.length === 1 ? hits[0].abs : '';
  };
  // 口令、key 不能跟着审查者的原话进规则文件（规则文件是要提交的）：遮过之后和原来不一样的，就是带着的
  let redact = (s) => s;
  try { redact = require('./feedback.js').redact; } catch (e) { /* 老版本没有 */ }
  const SECRET_LIKE = /(?:password|passwd|pwd|secret|token|apikey|api[-_]key|access[-_]?key|密码|口令|密钥|令牌)\s*(?:=|:|：|是|为)\s*["']?[^\s"'，。；]{4,}/i;
  const hasSecret = (s) => !!s && (redact(s) !== s || SECRET_LIKE.test(s));
  const rejected = new Map();
  for (const r of o.reviews || []) {
    const source = r && (r.change ? r.change.name : r.source);
    if (!r || !source || !(r.issues > 0) || !r.text) continue;
    if (!rejected.has(source)) rejected.set(source, rejectedLines(cwd, source));
    for (const f of parseFindings(r.text)) {
      if (f.severity === '建议') continue;
      if (f.avoid === '无') continue;                // 审查者说了：一次性的疏忽，换个任务不会再犯
      const abs = locate(f.file);
      if (!abs) continue;
      const key = normKey(abs);
      if (!edits.some((e) => e.key === key && e.pos > r.pos)) continue;       // 报了之后没改过：不算数
      // 模型核对过、在 revisions.md 里写了"不成立"的：不算数
      if (rejected.get(source).some((l) => similarity(l, f.problem) >= 0.3)) continue;
      const group = groupOf(abs);
      const root = repoRootOf(abs, cwd);
      if (!group || !root) continue;
      if (!touched.has(root)) touched.set(root, { data: readFindings(root), fresh: [] });
      const t = touched.get(root);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const id = 'F' + crypto.createHash('sha1').update([String(source).toLowerCase(), rel.toLowerCase(), [...tokensOf(f.problem)].sort().join('|')].join('\n')).digest('hex').slice(0, 10);
      if (t.data.items.some((x) => x.id === id)) continue;
      // 规则的文字：审查者写了"以后怎么避免"、又是能照着做的一句话，就用它；不然用"问题"那一句
      const avoid = f.avoid && f.avoid.length >= 8 && f.avoid.length <= st.maxChars && !HEDGE.test(f.avoid) && !/<!--|-->|^#/.test(f.avoid) ? f.avoid : '';
      const secret = hasSecret(f.problem) || hasSecret(f.avoid) || hasSecret(f.when);
      const item = { id, change: source, file: rel, group, kind: f.kind || '其他', problem: redact(f.problem).slice(0, 200), when: redact(f.when).slice(0, 200), avoid: secret ? '' : avoid, severity: f.severity || '', mode: r.mode === 'proposal' ? '提案' : '代码', day: today(), at: Date.now() };
      if (secret) item.secret = true;
      t.data.items.push(item);
      t.fresh.push(item);
      out.stored++;
    }
  }
  for (const [root, t] of touched) {
    if (!t.fresh.length) continue;
    writeFindings(root, t.data);
    try { const idx = readIndex(); noteProject(idx, root); writeIndex(idx); } catch (e) { /* 记不了不影响 */ }
    const failed = [];
    for (const x of t.fresh) {
      if (x.secret) continue;          // 带着口令的只留在本机的记录里（已经遮过），不进候选、不进规则
      try {
        const a = addAuto(root, st, { text: x.avoid || x.problem, also: x.avoid ? x.problem : '', group: x.group, kind: x.kind, rel: x.file, from: x.change });
        if (a.status === 'promoted') out.promoted.push(a);
        else if (a.status === 'hit') out.hit.push(a);
      } catch (e) { failed.push(x.id); out.error = String((e && e.message) || e); }
    }
    // 没记成的（规则文件被占着、只读）：从"收过了"的记录里拿掉，下次收工再来一遍
    if (failed.length) { try { const d = readFindings(root); d.items = d.items.filter((x) => !failed.includes(x.id)); writeFindings(root, d); t.data = d; out.stored -= failed.length; } catch (e) { /* 拿不掉：这几条就漏了 */ } }
    const pairs = new Set(t.fresh.filter((x) => !failed.includes(x.id)).map((x) => x.group + '|' + x.kind));
    for (const p of pairs) {
      const [group, kind] = p.split('|');
      try {
        const c = categoryRule(root, st, group, kind, readFindings(root).items.filter((x) => x.group === group && x.kind === kind));
        if (c) out.category.push(c);
      } catch (e) { out.error = String((e && e.message) || e); }
    }
  }
  return out;
}

/** 退役一条项目规则（模型发现规则写错了、过时了）：从规则文件里去掉，记进候选（状态 retired，带原因） */
function retire(id, why, cwd, rootHint) {
  const root = rootHint || repoRootOf(path.join(cwd || process.cwd(), '_'), cwd) || '';
  if (!root) return { ok: false, msg: '当前目录不在任何项目里。进到项目目录里再执行。' };
  migrateNames(projectRulesDir(root), 'project', root);
  for (const rf of listRuleFiles(projectRulesDir(root))) {
    const data = readRuleFile(rf.file);
    const r = data.rules.find((q) => q.id.toLowerCase() === String(id).toLowerCase());
    if (!r) continue;
    data.rules = data.rules.filter((q) => q !== r);
    writeRuleFile(rf.file, data, 'project', rf.group);
    noteWritten(rf.file, root);
    const items = readCandidates(root);
    items.push({ id: r.id, text: r.text, group: rf.group, kind: r.kind || '', file: '', sources: [], first: r.last, last: today(), state: 'retired', why: oneLine(why).slice(0, 200) });
    writeCandidates(root, items);
    return { ok: true, file: rf.file, text: r.text, msg: '已退役 ' + r.id + '："' + r.text + '"。' + commitHint(root, rf.file) };
  }
  return { ok: false, msg: '这个项目的规则里没有 ' + id + '（用户级规则只能由用户在配置页里删）。' };
}
/** 查过时的规则（提到的名字在项目里找不到了）。apply 为真就退掉 */
function tidy(cwd, apply, rootHint) {
  const root = rootHint || repoRootOf(path.join(cwd || process.cwd(), '_'), cwd) || '';
  if (!root) return { ok: false, stale: [], msg: '当前目录不在任何项目里。' };
  migrateNames(projectRulesDir(root), 'project', root);
  const stale = [];
  for (const rf of listRuleFiles(projectRulesDir(root))) {
    const data = readRuleFile(rf.file);
    const dead = data.rules.filter((r) => r.names && r.names.length && !namesAlive(r.names, root));
    if (!dead.length) continue;
    for (const r of dead) stale.push({ id: r.id, text: r.text, names: r.names, file: rf.file });
    if (!apply) continue;
    data.rules = data.rules.filter((r) => !dead.includes(r));
    writeRuleFile(rf.file, data, 'project', rf.group);
    noteWritten(rf.file, root);
    const items = readCandidates(root);
    for (const r of dead) items.push({ id: r.id, text: r.text, group: rf.group, kind: r.kind || '', file: '', sources: [], first: r.last, last: today(), state: 'retired', why: '规则里提到的 ' + r.names.join('、') + ' 在项目里找不到了' });
    writeCandidates(root, items);
  }
  return { ok: true, root, stale, applied: !!apply };
}

// ---------- 给配置页、list 用 ----------
function fileView(rf, scope) {
  const d = readRuleFile(rf.file);
  return { group: rf.group, title: (groupInfo(rf.group) || {}).title || rf.group, file: rf.file, scope, paths: d.paths, manual: d.manual.filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '')), chars: charsOf(d),
    rules: d.rules.map((r) => ({ id: r.id, text: r.text, count: r.count, last: r.last, miss: r.miss || 0, kind: r.kind || '', from: r.from || [], names: r.names || [], auto: r.auto || '' })) };
}
function projectView(root) {
  migrateNames(projectRulesDir(root), 'project', root);
  return { root, name: path.basename(root), exists: fs.existsSync(root), files: listRuleFiles(projectRulesDir(root)).map((rf) => fileView(rf, 'project')),
    candidates: readCandidates(root).map((c) => ({ id: c.id, text: c.text, group: c.group, kind: c.kind || '', count: distinctChanges(c.sources), last: c.last, state: c.state || 'candidate', why: c.why || '', from: (c.sources || []).map((s) => s.from), auto: !!c.auto })),
    findings: findingsSummary(root) };
}
function overview(cfg) {
  migrateNames(USER_RULES_DIR, 'user');
  const st = settings(cfg);
  const idx = readIndex();
  const projects = Object.values(idx.projects).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30).map((p) => projectView(p.root)).filter((p) => p.exists && (p.files.length || p.candidates.length));
  return { settings: st, userDir: USER_RULES_DIR, user: listRuleFiles(USER_RULES_DIR).map((rf) => fileView(rf, 'user')), projects,
    pending: idx.lessons.filter((l) => l.state === 'pending').map((l) => ({ id: l.id, text: l.text, group: l.group, kind: l.kind || '', projects: Object.values(l.projects).map((p) => path.basename(p.root)) })) };
}
/** 配置页里删一条、改一条的字（用户级、项目级都行；项目级的改了要提交，记下来由收工检查催） */
function editRule(scope, root, id, newText, st0) {
  const st = st0 || settings();
  const dir = scope === 'user' ? USER_RULES_DIR : projectRulesDir(root);
  migrateNames(dir, scope === 'user' ? 'user' : 'project', root);
  for (const rf of listRuleFiles(dir)) {
    const data = readRuleFile(rf.file);
    const r = data.rules.find((q) => q.id === id);
    if (!r) continue;
    if (newText === null) {
      data.rules = data.rules.filter((q) => q !== r);
      // 项目规则被人删了：记下来，免得下次收到差不多的问题又出一遍。
      // 不看它现在还标不标着"自动"：改过字的不标了，可它还是从审查里来的，删了照样会再冒出来
      if (scope !== 'user' && root) {
        const items = readCandidates(root).filter((c) => c.id !== r.id);
        items.push({ id: r.id, text: r.text, group: rf.group, kind: r.kind || '', file: '', sources: [], first: r.last, last: today(), state: 'retired', why: '在配置页里删掉的', byUser: true, auto: !!r.auto });
        writeCandidates(root, items);
        // 按类别出的那种：编号是按"哪一组、哪一类"算的，对得上就记一笔"这一类删过"
        const kind = KINDS.find((k) => categoryId(rf.group, k) === r.id);
        if (kind) noteCategory(root, rf.group, kind, { removed: today() });
      }
    } else {
      const t = oneLine(newText);
      if (t.length < 8 || t.length > st.maxChars) return { ok: false, msg: '一条规则 8 到 ' + st.maxChars + ' 个字。' };
      if (/<!--|-->/.test(t)) return { ok: false, msg: '规则里不要带注释符号。' };
      r.text = t;
      // 人改过措辞：不再算自动的（按类别出的那种之后也不再被脚本改写）
      r.auto = '';
    }
    writeRuleFile(rf.file, data, scope === 'user' ? 'user' : 'project', rf.group);
    if (scope !== 'user') noteWritten(rf.file, root);
    return { ok: true, file: rf.file };
  }
  return { ok: false, msg: '没有这一条：' + id };
}

module.exports = { settings, GROUPS, KINDS, groupOf, groupInfo, isLessonFile, migrateNames, parseFindings, autoCollect, readFindings, findingsSummary, findingsFile, repoRootOf, projectNames, namesAlive, tokensOf, similarity, idOf, readRuleFile, renderRuleFile, writeRuleFile, listRuleFiles, squeeze,
  readCandidates, candidatesFile, readIndex, pendingUser, promoteUser, dismissUser, noteWritten, uncommitted, add, retire, tidy, overview, projectView, editRule, USER_RULES_DIR, STORE, SAME, NEAR, projectRulesDir, ruleFileOf };

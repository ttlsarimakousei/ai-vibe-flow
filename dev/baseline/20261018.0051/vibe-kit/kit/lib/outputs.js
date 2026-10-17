'use strict';
/*
 * 代码之外的产出（DDL 脚本、说明文档、分析报告、表格……）放哪：开工前跟用户定好，不能由模型自己挑地方。
 *
 * 用户定好的位置记在项目说明（.vibe/project.md）里；团队也可以写在项目的 CLAUDE.md 里。两种写法都认：
 *   ## 产出位置                     - 产出位置：
 *   - DDL 脚本：sql/ddl/              - DDL 脚本：sql/ddl/        （缩进的子项）
 *   - 分析报告：D:\报告\               - 功能说明：docs/功能说明/
 * 路径可以相对项目根目录，可以是绝对路径，也可以带 *（比如 **\/README.md）。
 *
 * 什么算"确认过"：
 *   1. 会话开始时（或者这个会话第一次改那个文件之前）就记在里面的位置；
 *   2. 用户这次会话里亲口说过、在提问框里选过的路径（包括“仓库根目录 文件名”和结构化答案，只取选中的答案）。
 * 模型在会话里自己往项目说明里加一条、却没问过用户的，不算：防止它自己给自己批准。
 * 只管新建的文件（改已有的文件不是在选位置），只管文档、SQL、表格这几类；openspec、.vibe、.claude、临时目录、
 * README 之类，源码目录里的 .sql（迁移脚本、测试数据），代码目录（resources、test、public、static、assets、i18n……）里的所有文件，
 * 技能工程、文档工程里的文档（那就是工程本身）都不管。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normKey, readState, updateState, CFG_DIR, expandHome, tailEntries, isUserTurn, isTaskNote, textOf, toolCalls, toolResults, isShell, nestedRepos, sessionHome } = require('./session');

const OUTPUT_TYPES = [
  { re: /\.sql$/i, label: 'SQL / DDL 脚本' },
  { re: /\.(md|markdown|txt|docx?|pdf|rtf)$/i, label: '文档（说明、报告）' },
  { re: /\.(xlsx?|csv)$/i, label: '表格' },
  { re: /\.pptx?$/i, label: '演示文稿' },
];
function outputTypeOf(file) {
  const t = OUTPUT_TYPES.find((x) => x.re.test(String(file || '')));
  return t ? t.label : '';
}

const EXEMPT_DIRS = new Set(['openspec', '.vibe', '.claude', '.github', '.gitlab', '.idea', '.vscode', 'node_modules', '.git', 'skills', 'commands', 'agents', 'target', 'dist', 'build', 'out']);
const EXEMPT_NAMES = /^(readme|changelog|changes|license|licence|contributing|claude|agents|skill|security|notice|authors)(\.[^/]*)?$/i;
const SQL_CODE_DIRS = new Set(['src', 'resources', 'migration', 'migrations', 'flyway', 'liquibase']);
// 代码目录：里面的 txt、csv、md（banner.txt、测试数据、国际化文案、静态文件）是代码的一部分，程序要读，不是给人看的产出
const CODE_DIRS = new Set(['resources', 'test', 'tests', '__tests__', 'public', 'static', 'assets', 'webapp', 'web-inf', 'i18n', 'locales', 'locale', 'lang', 'mapper', 'mappers', 'migration', 'migrations', 'flyway', 'liquibase', 'fixtures', 'testdata', 'test-data', 'mock', 'mocks']);

/** 往上找最近的一份项目说明 .vibe/project.md */
function nearestProjectMd(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    const f = path.join(d, '.vibe', 'project.md');
    if (fs.existsSync(f)) return f;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}
/** 项目说明里写的工程类型（"- 类型：技能工程。…"） */
function projectTypeOf(dir) {
  const f = nearestProjectMd(dir);
  if (!f) return '';
  try { const m = fs.readFileSync(f, 'utf8').match(/^\s*[-*]?\s*类型\s*[:：]\s*([^\r\n]*)/m); return m ? m[1] : ''; } catch (e) { return ''; }
}
function gitRoot(dir) {
  let d = dir;
  for (let i = 0; i < 12; i++) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}
function under(k, dirKey) { return !!dirKey && (k === dirKey || k.startsWith(dirKey.replace(/\/$/, '') + '/')); }

/** 最近一层存在的目录（要写的目录可能还没建） */
function existingDir(file) {
  let d = path.dirname(file);
  while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
  return d;
}
/** 不归这里管的：临时目录里的草稿、~/.claude、openspec / .vibe / .claude 这类目录、README 之类、源码目录里的 .sql、技能和文档工程的文档 */
function exempt(file) {
  const k = normKey(file);
  const tmps = [os.tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).map(normKey);
  // 临时目录里、又不在任何仓库或项目里的，是草稿（比如拼一个临时 SQL 交给命令行跑）
  if (tmps.some((t) => under(k, t)) && !gitRoot(existingDir(file)) && !nearestProjectMd(existingDir(file))) return true;
  if (under(k, normKey(CFG_DIR))) return true;
  // 目录名按仓库里的相对路径看（D:\test\项目\docs\报告.md 的 test 不算代码目录）；不在仓库里的按整个路径看
  const root = gitRoot(existingDir(file));
  const rel = root ? normKey(file).slice(normKey(root).length).replace(/^\/+/, '') : '';
  const segs = (rel || k).split('/');
  const name = segs[segs.length - 1];
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => EXEMPT_DIRS.has(s))) return true;
  if (EXEMPT_NAMES.test(name)) return true;
  if (dirs.some((s) => CODE_DIRS.has(s))) return true;
  if (/\.sql$/i.test(name) && dirs.some((s) => SQL_CODE_DIRS.has(s))) return true;
  if (/\.(md|markdown|txt)$/i.test(name) && /技能|文档/.test(projectTypeOf(path.dirname(file)))) return true;
  return false;
}

// ---------- 记下来的位置 ----------
/**
 * 这个文件可能适用的"产出位置"记录：从文件所在目录、当前目录、会话的启动目录往上，每一层的 .vibe/project.md、CLAUDE.md、.claude/CLAUDE.md。
 * 启动目录是壳子的，壳子里各个子项目的项目说明也算（产出放在壳子里、位置记在某个子项目的项目说明里）
 */
function declFiles(file, cwd, home) {
  const out = [];
  const seen = new Set();
  const add = (f) => { const k = normKey(f); if (seen.has(k)) return; seen.add(k); if (fs.existsSync(f)) out.push(f); };
  if (home) { try { if (isShell(home)) for (const r of nestedRepos(home)) add(path.join(r, '.vibe', 'project.md')); } catch (e) { /* 认不出就不算 */ } }
  for (const start of [path.dirname(file), cwd, home].filter(Boolean)) {
    let d = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      add(path.join(d, '.vibe', 'project.md'));
      add(path.join(d, 'CLAUDE.md'));
      add(path.join(d, '.claude', 'CLAUDE.md'));
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return out.filter((f) => !under(normKey(f), normKey(CFG_DIR)));
}
/** 记录文件里的路径相对哪个目录：项目说明相对项目根目录（.vibe 的上一层），CLAUDE.md 相对它所在的项目 */
function baseOf(declFile) {
  const d = path.dirname(declFile);
  return /^\.(vibe|claude)$/i.test(path.basename(d)) ? path.dirname(d) : d;
}
/** 套着这个目录的壳子（往上最多两层） */
function shellsAbove(dir) {
  const k = normKey(dir);
  const list = [];
  let d = path.resolve(dir);
  for (let i = 0; i < 2; i++) {
    const up = path.dirname(d);
    if (up === d) break;
    try { if (isShell(up) && nestedRepos(up).some((r) => under(k, normKey(r)))) list.push(up); } catch (e) { /* 认不出就不算 */ }
    d = up;
  }
  return list;
}
const PATHISH = /[A-Za-z]:[\\/][^\s，,、；;）)]*|~?[\w.\-一-龥*]*[\\/][\w.\-一-龥*\\/ ]*[\w.\-一-龥*\\/]|[\w.\-一-龥*]+[\\/]/g;
// 路径里的占位写法（docs/<需求编号>/<需求编号>-<需求名>/、{模块}、【日期】）当通配符：每个需求一个目录的约定就是这么写的（议题 #8）
const PLACEHOLDER = /<[^<>\s\\/]{1,20}>|\{[^{}\s\\/]{1,20}\}|【[^【】\s\\/]{1,20}】/g;
/** 一句话里的路径（不是"名字：路径"那种一条一条的记录）：引号括着的；没括的只认带斜杠、中间没空格的，末尾的"下、里、目录"不算 */
function loosePaths(text0) {
  const text = String(text0 || '').replace(PLACEHOLDER, '*');
  const quoted = [...text.matchAll(/[`"“]([^`"”]+)[`"”]/g)].map((m) => m[1].trim()).filter((x) => /[\\/]/.test(x));
  if (quoted.length) return quoted;
  const found = text.match(/(?:[A-Za-z]:[\\/]|~[\\/])?[\w.\-*一-龥]+(?:[\\/][\w.\-*一-龥]+)*[\\/]?/g) || [];
  return found.filter((x) => /[\\/]/.test(x)).map((x) => x.replace(/([\\/])(?:下面|里面|目录下|目录里|目录|里头|下|里|中)$/, '$1'));
}
/** 一条记录里的路径（反引号、引号去掉，括号里的备注去掉，顿号分号分开的多个都要） */
function pathsIn(text0) {
  const text = String(text0 || '').replace(PLACEHOLDER, '*');
  // 反引号、引号括起来的就是完整的路径（可以带空格）
  const quoted = [...String(text || '').matchAll(/[`"“]([^`"”]+)[`"”]/g)].map((m) => m[1].trim()).filter((x) => /[\\/]|^[\w.\-一-龥*]+$/.test(x));
  if (quoted.length) return quoted;
  const s = String(text || '').replace(/['‘’]/g, ' ').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
  if (!s) return [];
  const found = s.match(PATHISH);
  if (found && found.length) return found.map((x) => x.trim()).filter(Boolean);
  // 没有斜杠的：整条就是一个目录名（"docs"）
  return /^[\w.\-一-龥*]+$/.test(s) ? [s] : [];
}
/** 解析"产出位置"一节：返回 [{ label, pattern }]，pattern 是绝对路径（正斜杠、小写），带 * 的是通配 */
function parseDecls(text, base) {
  const out = [];
  let shells = null;
  const addItem = (item, loose) => {
    const m = loose ? null : String(item).match(/^([^:：]{1,40}?)\s*[:：]\s*(.+)$/);
    const label = m && !/[\\/]/.test(m[1]) ? m[1].trim() : '';
    const rest = m && !/[\\/]/.test(m[1]) ? m[2] : String(item);
    for (const p of (loose ? loosePaths(rest) : pathsIn(rest))) {
      let q = expandHome(p);
      const isAbs = /^[A-Za-z]:[\\/]/.test(q) || /^[\\/]/.test(q);
      // 相对路径相对哪：记录文件所在的项目。记录写在子项目里、子项目外面套着壳子的，壳子里的同一个相对位置也算
      // （议题 #8：产出放在壳子的 docs/ 里，"产出位置"却记在子项目的项目说明里）。子项目自己有这个目录、壳子里没有的，只算子项目的
      const froms = [base];
      if (!isAbs) {
        const first = q.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.')[0] || '';
        const mine = !!first && !first.includes('*') && fs.existsSync(path.join(base, first));
        if (!shells) shells = shellsAbove(base);
        for (const sh of shells) if (!mine || fs.existsSync(path.join(sh, first))) froms.push(sh);
      }
      for (const from of froms) {
        const abs = isAbs ? q : path.join(from, q);
        const pattern = abs.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
        if (pattern && !out.some((o) => o.pattern === pattern)) out.push({ label, pattern });
      }
    }
  };
  // 没用"产出位置"这四个字、但说的就是这件事的一行："代码之外的产出放 docs/…""DDL、说明文档这类产出写到 …"
  const LOOSE = /产出[^\n。；;]{0,24}?(?:放在|放到|放进|放|存在|存到|存放在|存放|写到|写在|写进|归到|归档到|统一到)\s*(.+)$/;
  const NEGATED = /不要|(?<![类分区特个级识差辨鉴])别|不能|不得|不许|不准|不可|不应|禁止|严禁|勿/;
  let mode = 0; // 1：在"## 产出位置"这一节里；2：在"- 产出位置："这一条的缩进子项里
  let headLevel = 0;
  let parentIndent = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s*(.*)$/);
    if (h) {
      if (/产出位置/.test(h[2])) { mode = 1; headLevel = h[1].length; } else if (mode === 2 || (mode === 1 && h[1].length <= headLevel)) mode = 0;
      continue;
    }
    const li = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (mode === 2) {
      if (li && li[1].length > parentIndent) { addItem(li[2].trim()); continue; }
      if (!line.trim()) continue;
      mode = 0;
    }
    if (mode === 1) { if (li) addItem(li[2].trim()); continue; }
    if (li) {
      // "**产出位置**（用户定的）：…"：加粗的记号、名字后面括号里的备注不算内容
      const t = li[2].trim().replace(/^(\*\*|__)\s*(产出位置[^*_]{0,20}?)\s*(\*\*|__)/, '$2');
      const pm = t.match(/^产出位置\s*(?:[（(][^）)]*[）)])?\s*[:：]?\s*(.*)$/);
      if (pm) { mode = 2; parentIndent = li[1].length; if (pm[1].trim()) addItem(pm[1].trim()); continue; }
    }
    const lm = line.match(LOOSE);
    // "产出不要放在 src/ 下"是在说不许放哪，不是定位置
    if (lm && /[\\/]/.test(lm[1]) && !NEGATED.test(line.slice(0, line.length - lm[1].length))) addItem(lm[1].trim(), true);
  }
  return out;
}
function declsOf(declFile) {
  try { return parseDecls(fs.readFileSync(declFile, 'utf8'), baseOf(declFile)); } catch (e) { return []; }
}
function globRe(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}
function matches(file, pattern) {
  const k = normKey(file);
  // 带通配的：写的是文件就按文件比；写的是目录（docs/*/*-*），目录里面的文件都算
  if (pattern.includes('*')) return globRe(pattern).test(k) || globRe(pattern.replace(/\/$/, '') + '/**').test(k);
  return under(k, pattern);
}

// ---------- 这个会话开始时就有的记录（模型在会话里自己加的不算） ----------
const stateKey = (sid) => String(sid) + '-outputs';
/** 记下这份记录文件现在的内容（这个会话里第一次见到它、或者第一次要改它之前）。之后再加的条目不算已确认 */
function snapshot(sid, declFile) {
  if (!sid || !declFile) return;
  const k = normKey(declFile);
  const st = readState(stateKey(sid));
  if (st.files && st.files[k]) return;
  const decls = fs.existsSync(declFile) ? declsOf(declFile).map((d) => d.pattern) : [];
  updateState(stateKey(sid), (o) => { o.files = o.files || {}; if (!o.files[k]) o.files[k] = { decls, at: Date.now() }; o.at = Date.now(); });
}
function trustedPatterns(sid, files) {
  const out = [];
  for (const f of files) {
    if (!sid) { out.push(...declsOf(f).map((d) => d.pattern)); continue; }
    snapshot(sid, f);
    const rec = ((readState(stateKey(sid)).files) || {})[normKey(f)];
    out.push(...(rec && Array.isArray(rec.decls) ? rec.decls : declsOf(f).map((d) => d.pattern)));
  }
  return out;
}

// ---------- 用户这次会话里说过的位置 ----------
/** 用户说的话：每条用户消息，加上提问框里用户的回答。后台任务做完的通知（子代理写的话）不算 */
function userTexts(entries) {
  const out = [];
  for (const e of entries) if (isUserTurn(e) && !isTaskNote(e)) out.push(textOf(e));
  const res = toolResults(entries);
  for (const c of toolCalls(entries)) if (c.name === 'AskUserQuestion' && res.has(c.id) && !res.get(c.id).error) {
    const pos = res.get(c.id).pos;
    const voice = require('./session').lastUserVoice(entries.slice(0, pos + 1));
    if (voice && voice.kind === 'answer' && voice.pos === pos) out.push(...voice.answers.map((a) => a.a).filter((a) => !/^(?:不要|不放|取消|先别|还没|未定)/.test(a.trim())));
  }
  return out;
}
const normText = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentioned(texts, file, roots) {
  const all = normText(texts.join('\n'));
  if (!all) return false;
  const dir = path.dirname(file);
  const cands = new Set([normText(dir), normText(file)]);
  for (const r of roots) {
    if (!r) continue;
    const rel = path.relative(r, dir);
    // #58：根目录下的文件没有相对目录，用户选的“仓库根目录 文件名”也要识别。
    if (!rel) {
      const name = escRe(normText(path.basename(file)));
      if (new RegExp('(?:仓库|项目)?根目录[\\s：:，,`"“]*' + name + '(?=$|[\\s`"”。，,；;])', 'i').test(all)) return true;
    }
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { cands.add(normText(rel)); cands.add(normText(path.join(rel, path.basename(file)))); }
  }
  for (const c0 of cands) {
    const c = c0.replace(/\/$/, '');
    if (!c) continue;
    if (c.includes('/')) { if (all.includes(c)) return true; continue; }
    // 单独一个目录名：得像是在说目录（前后是路径符号、引号，或者跟着"目录、文件夹、下、里"）
    const re = new RegExp('(^|[\\s"\'“‘`(（/：:])' + escRe(c) + '(/|[\\s"\'”’`)）]*(目录|文件夹|下面|里面|下|里|中))', 'i');
    if (re.test(all)) return true;
  }
  return false;
}

/** 同一个目录里已经有两个以上同类文件（项目里现成的同类位置，仓库根目录不算） */
function establishedDir(file, root) {
  const dir = path.dirname(file);
  if (root && normKey(dir) === normKey(root)) return false;
  const ext = path.extname(file).toLowerCase();
  try { return fs.readdirSync(dir).filter((n) => path.extname(n).toLowerCase() === ext).length >= 2; } catch (e) { return false; }
}

/**
 * 要新建的这个文件放的位置确认过吗。返回 null（不用管、或者确认过了）或者 { type, file, root, projectMd, auto, pending }
 */
function outputCheck(j, cfg) {
  if (!j || j.tool_name !== 'Write') return null;
  const cwd = path.resolve(j.cwd || process.cwd());
  let f = String((j.tool_input && j.tool_input.file_path) || '');
  if (!f) return null;
  if (!path.isAbsolute(f)) f = path.resolve(cwd, f);
  const type = outputTypeOf(f);
  if (!type || fs.existsSync(f) || exempt(f)) return null;
  // 要写的目录可能还不存在：从最近一层存在的上级目录找它所在的仓库
  const root = gitRoot(existingDir(f)) || gitRoot(cwd) || cwd;
  // 会话的启动目录：模型单独 cd 到子项目里之后，cwd 往上找不到壳子里各处记的位置（议题 #8）
  const home = sessionHome(j);
  const files = declFiles(f, cwd, home);
  if (trustedPatterns(j.session_id, files).some((p) => matches(f, p))) return null;
  const entries = j.transcript_path ? tailEntries(j.transcript_path, 600000) : [];
  const pm = nearestProjectMd(path.dirname(f)) || nearestProjectMd(home) || nearestProjectMd(cwd);
  const roots = [root, cwd, home, pm ? path.dirname(path.dirname(pm)) : ''];
  if (mentioned(userTexts(entries), f, roots)) return null;
  const auto = !!(cfg && cfg.autoMode);
  if (auto && establishedDir(f, root)) return null;
  return { type, file: f, root, projectMd: pm || path.join(root, '.vibe', 'project.md'), auto, pending: path.join(root, '.vibe', 'pending', path.basename(f)), cwd };
}

module.exports = { outputTypeOf, exempt, declFiles, parseDecls, declsOf, matches, snapshot, trustedPatterns, userTexts, mentioned, establishedDir, outputCheck, nearestProjectMd };

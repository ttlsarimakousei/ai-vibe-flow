'use strict';
/*
 * Stop 钩子：模型说"做完了"准备收工时，用脚本确定性地检查这一轮有没有漏掉该做的事。漏了就拦一次，把该做的事告诉它。
 * 判断全在本机脚本里做，不花 token：
 *   1. 改了代码，但最后一次修改之后没成功跑过像验证的命令        → 让它跑快检（开关 autoVerify）
 *   2. 改了页面文件，但之后没跑过页面场景                        → 让它按 /ttls-see-page 跑一遍（开关 autoSeePage）
 *   3. 这一轮把某个 OpenSpec 变更的最后一项任务打了勾，代码还没审过 → 让它 /ttls-cross-review（开关 autoCrossReview；每个变更催一次）
 *   4. 这一轮改过的文件在 git 里还没提交                          → 让它提交（开关 autoCommit：task / change / off；每一轮只提一次）
 *   4b. 这个会话里新建、还没进 git 的文件，项目里留下的备份、日志 → 要交的提交，临时的删掉（开关 vibeTidy；同一批只提一次，说做完了再提一次）
 *   4c. 说了是套件的问题却没记问题反馈 → 让它记；做完了、这个会话记过套件问题 → 交代里单独列"套件问题"（lib/feedback.js）
 *   4d. 审查报了问题、处理过了，却没记经验 → 让它挑"还会再犯"的记下来；经验规则文件改了没提交 → 让它提交（开关 lessons，lib/lessons.js）
 *   5. OpenSpec 产物：改了没记录、提案里的能力没有规格、设计写了没读过的文件、提案写好没审、变更不在 plan.md 里、
 *      归档之后主规格（openspec/specs/）里没有这个变更的需求（开关 specGate）
 *   6. 多轮审查（开关 reviewLoop）、全自动模式催进度和收工时的报告（开关 autoMode，lib/report.js）、到交接线问一句（handoverAsk）
 * 审查记录只认"真审了"：这一轮（包括被拦之后的续跑）里的 ttls-reviewer 调用，有结果、不是报错、带"结论：问题 N 条"的才记，
 *   模式看提示第一行"模式：提案 / 代码 / 复审…"，变更看提示里点名的。催过和审过分开记。
 * 只算改成功了的修改、成功跑完的命令。每件事每一轮最多拦一次；被拦之后的续跑里只再查一件事：拦下之后又改了代码却没验证。
 * 项目说明（被改文件所在项目的 .vibe/project.md）里标了"快检：不适用""看页面：不适用"的，不催。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { atHome, FLOW_SKILL, setFlow, flowTouch, flowChanges, tailEntries, textOf, listChanges, readConfig, readConfigFor, readState, writeState, updateState, blockOut, lastUsageTokens, contextPercent, nearGatewayLimit, artifactOf, STAGE, artifactHash, artifactFiles, normKey, proposalCapabilities, hookLog, VERIFY_CMD, sectionOf, pathTokens, pathExists, projectReads, nestedRepos, planSummary, planUnlisted, turnStart, toolCalls, toolResults, syncReviews, pendingReviewsIn, taskNotes, allChanges, mentionsChange, archivedNames, archivedSince, proposalReviewed, codeReviewed, codeReviewIssue, changeBorn, sessionStartMs, reviewMax, syncReviewRounds, reviewExhaustedText, sessionChanges, handoverWrittenIn, cli } = require('../lib/session');
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }
let tidy = null;
try { tidy = require('../lib/tidy.js'); } catch (e) { /* 老版本没有 */ }
let feedback = null;
try { feedback = require('../lib/feedback.js'); } catch (e) { /* 老版本没有 */ }
let lessons = null;
try { lessons = require('../lib/lessons.js'); } catch (e) { /* 老版本没有 */ }

const PAGE =/\.(vue|jsx|tsx|html?|css|scss|sass|less|styl)$/i;
const CODE = /\.(java|kt|groovy|js|mjs|cjs|ts|py|go|cs|xml|sql)$/i;
const SAID_UNVERIFIED = /没有?验证|未验证|无法验证|没法验证|验证不了/;
const SAID_NO_PAGE = /没有?看页面|不影响(页面|显示|界面|样式)|页面(没|未)验|无法(打开|启动)/;
// 全自动模式下"卡住了、要人定"的明确说法；"等你回来定的事"是交代里的固定标题，不算
const SAID_STUCK = /卡住了|卡在|无法继续|做不下去|进行不下去|需要你(来)?(决定|确认|定)|需要用户(决定|确认)|等你回来(决定|再定)|不可逆/;
const RESOLVED = /(已|已经)(解决|修复|修好|搞定|处理好?|排除)|解决了|修好了|搞定了|处理好了/;
/**
 * 按分句看：前面带否定的（"没有不可逆的操作""不需要你确认"）不算；这一分句、或者紧跟着的下一分句开头说了已经解决的
 * （"之前卡在编译上、已解决"）不算。"卡在权限上，其他问题已解决"照样算卡住
 */
function saidStuck(text) {
  const s = String(text || '').replace(/等你回来定的事/g, '');
  for (const seg of s.split(/[。！？!?\n；;]/)) {
    const parts = seg.split(/[，,、]/);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const re = new RegExp(SAID_STUCK.source, 'g');
      let m;
      while ((m = re.exec(p))) {
        if (/(没有|没|不涉及|不存在|不会|不是|并非|无|未|不)\S{0,6}$/.test(p.slice(0, m.index))) continue;
        if (RESOLVED.test(p) || RESOLVED.test((parts[i + 1] || '').trim().slice(0, 6))) continue;
        return true;
      }
    }
  }
  return false;
}

function repoRootOf(file) {
  let d = path.dirname(path.resolve(file));
  for (let i = 0; i < 14; i++) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}
/** 不是源码：openspec、.vibe、.claude、node_modules 里的；仓库根下 docs/ 里的（com/acme/doc/DocService.java 这种不算） */
function nonSource(file) {
  if (/(^|[\\/])(openspec|\.vibe|\.claude|node_modules)[\\/]/i.test(file)) return true;
  const root = repoRootOf(file);
  const rel = root ? path.relative(root, path.resolve(file)).split(path.sep).join('/') : '';
  return /^docs?\//i.test(rel);
}
/**
 * 被改文件所在项目的项目说明：从文件所在目录往上找（到仓库根为止）本机的 .vibe/project.md，
 * 和项目 CLAUDE.md 里团队共享的"项目说明（团队共享）"一节，两份合起来看
 */
const notesCache = new Map();
const readCached = (f) => { if (notesCache.has(f)) return notesCache.get(f); let t = null; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { /* 没有 */ } notesCache.set(f, t); return t; };
function projectNotesFor(file) {
  let d = path.dirname(path.resolve(file));
  let local = null;
  let team = null;
  for (let i = 0; i < 10 && (local === null || team === null); i++) {
    if (local === null) local = readCached(path.join(d, '.vibe', 'project.md'));
    if (team === null) { const t = readCached(path.join(d, 'CLAUDE.md')); if (t && /^#{1,3}\s*项目说明（团队共享）/m.test(t)) team = sectionOf(t, /项目说明（团队共享）/).join('\n'); }
    if (fs.existsSync(path.join(d, '.git')) && !fs.existsSync(path.join(path.dirname(d), '.vibe', 'project.md'))) break;
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  return [local, team].filter(Boolean).join('\n');
}
const notApplicable = (notes, key) => new RegExp('^\\s*[-*]?\\s*(?:' + key + ')\\s*[:：]\\s*不适用', 'm').test(notes);

/** 这些文件里，哪些在 git 看来还没提交。按仓库分组各问一次 git（不抢 IDE 的 index 锁）；被忽略的文件 git 不会列出来 */
function gitStatus(root, rel) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '--'].concat(rel.slice(0, 60)), { encoding: 'utf8', timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}
async function uncommitted(files) {
  const byRoot = new Map();
  for (const f of files) {
    const root = repoRootOf(f);
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root).add(path.relative(root, path.resolve(f)).split(path.sep).join('/'));
  }
  const out = [];
  await Promise.all([...byRoot].map(async ([root, rel]) => {
    const s = await gitStatus(root, [...rel]);
    // 只算已跟踪文件的改动；新建的（??）由下面的"新建、没进 git 的文件"那一条单独说
    const n = s === null ? 0 : s.split('\n').filter((l) => l.trim() && !l.startsWith('??')).length;
    if (n) out.push({ root, count: n });
  }));
  return out;
}

/**
 * 新建了、还没进 git 的文件，和留在项目里的过程文件：
 *   它这个会话里用 Write 新建、现在还是"未跟踪"的：要交的提交（git 不会自动带上新文件），为了测试临时加的（测试页面、调试接口）做完了删掉；
 *   这个会话里在项目里冒出来的备份、日志、临时文件、备份目录（不管是写的、cp 的还是重定向出来的）：删掉或挪进 .vibe/tmp/<事由>/。
 *     看两处：git 里"未跟踪"的；改过的文件旁边的（被 .gitignore 忽略了、git status 看不到的备份也算，git 跟踪着的不算）。
 * 同一批只提一次；它说"做完了"的时候，还留着的再提一次（收尾）。返回要说的话，没有返回空串
 */
const SAID_DONE = /完成|做完|搞定|已修复|修好了|都好了|已经好了|全部通过|收工|交付|\bdone\b|finished|completed/i;
// "还没完成""未做完"不算
const saidDone = (t) => SAID_DONE.test(t || '') && !/(没|未|尚未|还没|没有)(能)?(完成|做完|搞定|修好)|not (yet )?(done|finished|completed)/i.test(t || '');
function porcelainUntracked(root) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : String(stdout || '').split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))));
  });
}
/**
 * 套件问题（lib/feedback.js）：
 *   它说了"是钩子 / 套件的问题"，这个会话却一条问题反馈都没记：让它记一条（每个会话一次），用户会收走交给改套件的人；
 *   它说做完了，这个会话记过套件问题（它记的、钩子自动记的），交代里没有"套件问题"一节：让它单独列出来（同一批只提一次）
 */
const SAID_KIT_BUG = /(钩子|套件|vibe-kit)(本身|自己)?的(问题|bug|缺陷|毛病)|(钩子|套件)(拦错|误拦|有 ?bug|有缺陷|出错|坏了)|是(钩子|套件)(的)?(bug|问题)/i;
function kitIssueTodo(j, lastSaid) {
  if (!feedback || !j.session_id) return '';
  const said = String(lastSaid || '');
  const recs = feedback.sessionRecords(j.session_id);
  if (SAID_KIT_BUG.test(said) && !/(不是|并非|不算|没有)(钩子|套件)/.test(said) && !recs.some((r) => /模型反馈|申请放行/.test(r.meta['来源'] || ''))) {
    const k = j.session_id + '-kitissue-ask';
    if (!readState(k).at) {
      writeState(k, { at: Date.now() });
      return '你说了是套件（钩子、技能、工具）的问题：先记一条问题反馈，用户会收走交给改套件的人——node "$HOME/.claude/vibe-kit/tools/feedback.js" add --kind <误拦/漏拦/卡住/出错/提示不清> --hook <哪道检查> --title "一句话" --what "套件原话、当时在做什么" --why "查证过什么、为什么认为是套件的问题"。记完再交代，交代里单独列"套件问题"一节。';
    }
  }
  if (!recs.length || !saidDone(said) || /套件问题/.test(said)) return '';
  const sig = recs.map((r) => r.meta.id + ':' + r.meta['次数']).sort().join('|');
  const key = j.session_id + '-kitissues';
  if (readState(key).sig === sig) return '';
  writeState(key, { sig, at: Date.now() });
  return '收尾：这个会话记下了 ' + recs.length + ' 条套件问题（' + recs.slice(0, 6).map((r) => r.meta.id + ' ' + r.title).join('；') + (recs.length > 6 ? ' 等' : '') + '）。交代里单独列一节"套件问题"，逐条写：现象、影响了什么、怎么处理的（等我 / 申请放行 / 换了做法）、编号。';
}

/*
 * 经验沉淀（lib/lessons.js，开关 lessons）：
 *   开着"审查报的问题自动收"（lessonAuto，默认开）时脚本自己收，下面这一条不催。关着的时候：
 *   这个会话里有一次审查报了问题、之后也处理了（改了东西），却既没用 lesson.js 记过、也没说"没有需要沉淀的经验"：
 *   拦一次，让它挑"换个任务还会再犯"的各记一句话。每次审查只催一次；复审那几轮不催；审查意见还没处理的先不催。
 *   项目级的规则文件（.claude/rules/ttls-lessons-*.md）改了还没提交：催一次提交（跟着自动提交的开关走），同一批最多催两次。
 */
const SAID_NO_LESSON = /(没有|没|无|不)(什么)?(需要|要|可以?|值得)?(沉淀|记下来|记录)的?(经验|教训)|没有?可沉淀|无需沉淀|不需要沉淀/;
function lessonTodo(j, cfg, entries, reviews, lastSaid) {
  if (!lessons || !j.session_id || lessons.settings(cfg).mode === 'off') return '';
  // 开着"审查报的问题自动收"：脚本自己收，不催它记。两条路同时走，它记的和脚本收的说的是同一件事、文字又不一样，会各成一条
  if (lessons.settings(cfg).auto) return '';
  const first = (reviews || []).filter((r) => r.issues > 0 && !r.recheck && r.pos >= 0);
  if (!first.length) return '';
  const key = j.session_id + '-lessons';
  const st = readState(key);
  const seen = new Set(Array.isArray(st.reviews) ? st.reviews : []);
  const calls = toolCalls(entries, 0);
  const res = toolResults(entries);
  const okCall = (c) => { const x = res.get(c.id); return !!x && !x.error; };
  const ask = [];
  let changed = false;
  for (const r of first) {
    // 老版本记的是调用的 id（会重复）：对得上、又不比上次记的新，才当成催过的
    if (seen.has(r.key) || (seen.has(r.raw) && (r.at || 0) <= (st.at || 0))) continue;
    const after = calls.filter((c) => c.i > r.pos);
    // 审查意见还没动手处理：先不催，等它改完
    if (!after.some((c) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && okCall(c))) continue;
    const recorded = after.some((c) => /^(Bash|PowerShell)$/.test(c.name) && okCall(c) && /lesson\.js["']?\s+(add|none)\b/.test(String(c.input.command || '')));
    const said = SAID_NO_LESSON.test(String(lastSaid || '')) || entries.slice(r.pos + 1).some((e) => e && e.type === 'assistant' && SAID_NO_LESSON.test(textOf(e)));
    seen.add(r.key);
    changed = true;
    if (!recorded && !said) ask.push(r);
  }
  if (changed) writeState(key, Object.assign({}, st, { reviews: [...seen].slice(-50), at: Date.now() }));
  if (!ask.length) return '';
  const names = [...new Set(ask.map((r) => (r.change ? '变更 ' + r.change.name : '这次改动')))].join('、');
  return names + ' 的审查报了问题，你也处理了。其中"换个任务还会再犯"的（这个项目特有的坑、这类技术的坑），各记一条经验，一条一句话：node "$HOME/.claude/vibe-kit/tools/lesson.js" add --file <出问题的文件> --when "<什么情况下>" --do "<要怎么做>" --from "<变更名> <任务号>"（写法和例子看 lesson.js help）。笔误、漏看这类一次性的疏忽不用记；一条都没有就说一句"没有需要沉淀的经验"。';
}
function lessonCommitTodo(j, cfg, turnId, changes) {
  if (!lessons || !j.session_id || lessons.settings(cfg).mode === 'off') return '';
  const mode = ['task', 'change', 'off'].includes(cfg.autoCommit) ? cfg.autoCommit : 'task';
  if (mode === 'off') return '';
  if (mode === 'change' && changes().some((c) => c.todo > 0)) return '';
  const list = lessons.uncommitted(j.cwd || process.cwd());
  if (!list.length) return '';
  const key = j.session_id + '-lessons';
  const st = readState(key);
  if (turnId ? st.commitTurn === turnId : j.stop_hook_active) return '';
  const sig = list.map((x) => normKey(x.file)).sort().join('|');
  const times = st.commitSig === sig ? (st.commitTimes || 0) : 0;
  if (times >= 2) return '';
  writeState(key, Object.assign({}, st, { commitTurn: turnId || 'x', commitSig: sig, commitTimes: times + 1, at: Date.now() }));
  return '经验规则文件更新了，还没提交：' + list.map((x) => path.basename(x.repo) + ' 的 ' + x.rel).join('、') + '。规则跟着仓库走，同事的 Claude 才看得到：进到对应的仓库（git -C <目录>），只 git add 这个文件，提交信息写"docs: 更新经验规则"，和代码的修复分开提交。';
}

/** 这些文件里 git 跟踪着的（相对 root 的路径，正斜杠）。查不了 git 的返回 null */
function lsTracked(root, rels) {
  return new Promise((resolve) => {
    if (!rels.length) return resolve(new Set());
    execFile('git', ['--no-optional-locks', '-C', root, 'ls-files', '-z', '--'].concat(rels.slice(0, 200)), { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : new Set(String(stdout || '').split('\0').filter(Boolean))));
  });
}
async function leftoverTodo(j, entries, cfg, lastSaid, changes, start) {
  if (!j.session_id || !tidy) return '';
  const cwd = path.resolve(j.cwd || process.cwd());
  const res = toolResults(entries);
  const ok = (c) => res.has(c.id) && !res.get(c.id).error;
  const all = toolCalls(entries).filter(ok);
  const turn = all.filter((c) => c.i >= start);
  const done = saidDone(lastSaid);
  // 这一轮没写文件、没跑命令（比如只回答了一个问题）：不查，壳子里挨个仓库 git status 要好几秒。
  // 只有它说"做完了"、而且还没做过收尾检查时才查（"任务结束后没帮我清掉"就是这一刻）
  if (!turn.some((c) => /^(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell)$/.test(c.name)) && (!done || readState(j.session_id + '-leftover').final)) return '';
  const written = new Map();   // 这个会话里用 Write 写过的文件
  const dirs = new Set();      // 改过、写过的文件所在的目录：旁边留下的备份（被 .gitignore 忽略了、git status 看不到的）也要看
  // 只查这一轮碰过的仓库（改过文件的、命令里点了名的）；说"做完了"的时候把这个会话碰过的都查一遍
  const roots = new Set();
  for (const c of all) {
    if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) continue;
    const f = String(c.input.file_path || c.input.notebook_path || '');
    if (!f || /(^|[\\/])\.(vibe|claude)[\\/]/.test(f)) continue;
    const abs = path.resolve(cwd, f);
    const now = c.i >= start;
    if (now || done) { dirs.add(path.dirname(abs)); const r = repoRootOf(abs); if (r) roots.add(r); }
    if (/^(Write|NotebookEdit)$/.test(c.name) && fs.existsSync(abs)) written.set(normKey(abs), abs);
  }
  // 命令可能在当前目录的仓库、或者命令里点了名的子项目里生成文件（cp 出来的备份、重定向出来的日志）；收尾时看这个会话所有的命令
  const cmds = (done ? all : turn).filter((c) => /^(Bash|PowerShell)$/.test(c.name)).map((c) => String(c.input.command || '').replace(/\\/g, '/').toLowerCase());
  if (cmds.length || done) {
    const own = repoRootOf(path.join(cwd, '_'));
    if (own) roots.add(own);
    const text = cmds.join('\n');
    for (const r of nestedRepos(cwd)) {
      const b = path.basename(r).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (text.includes(normKey(r)) || new RegExp('(^|[\\s/"\'=])' + b + '([\\s/"\';&|)]|$)').test(text)) roots.add(r);
    }
  }
  const since = sessionStartMs(j.transcript_path) || 0;
  // 这个会话里冒出来的：用户自己原来就有的不算。修改时间、创建时间取晚的——Windows 上 Copy-Item、copy 复制出来的文件保留原文件的修改时间，创建时间才是复制那一刻
  const fresh = (abs) => { if (!since) return false; try { const s = fs.statSync(abs); return Math.max(s.mtimeMs, s.birthtimeMs || 0) >= since - 2000; } catch (e) { return false; } };
  const newFiles = [];
  const proc = new Map();      // 过程文件、过程目录：key → { abs, dir }
  const dirCache = new Map();
  await Promise.all([...roots].slice(0, 10).map(async (root) => {
    for (const rel of await porcelainUntracked(root)) {
      const abs = path.join(root, rel);
      const k = normKey(abs);
      if (/\/\.(vibe|claude)\//.test(k) || tidy.inBuildDir(abs, root)) continue;
      const mine = written.has(k);
      if (tidy.isProcessFile(abs)) { if (mine || fresh(abs)) proc.set(k, { abs, dir: false }); continue; }
      const d = tidy.processDirOf(abs, root, false, dirCache);
      if (d) { if (mine || fresh(abs)) proc.set(normKey(d), { abs: d, dir: true }); continue; }
      if (mine) newFiles.push(abs);
    }
  }));
  // 改过的文件旁边：A.java 旁边的 A.java.bak、A_old.java（git 忽略了的也算），git 跟踪着的不算
  const near = new Map();
  for (const d of [...dirs].slice(0, 40)) {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of es) {
      // 隐藏文件（.A.java.swp 这种）多半是用户开着的编辑器的，不管
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      const k = normKey(abs);
      if (proc.has(k) || !tidy.isProcessFile(abs) || !fresh(abs)) continue;
      const root = repoRootOf(abs) || tidy.projectRootOf(abs, cwd);
      if (!root || tidy.inBuildDir(abs, root)) continue;
      if (!near.has(root)) near.set(root, []);
      near.get(root).push(abs);
    }
  }
  await Promise.all([...near].map(async ([root, list]) => {
    const rels = list.map((f) => path.relative(root, f).split(path.sep).join('/'));
    const tracked = fs.existsSync(path.join(root, '.git')) ? await lsTracked(root, rels) : new Set();
    if (!tracked) return;
    list.forEach((f, i) => { if (!tracked.has(rels[i])) proc.set(normKey(f), { abs: f, dir: false }); });
  }));
  const procList = [...proc.values()];
  const key = j.session_id + '-leftover';
  const st = readState(key);
  // 收尾查过、干干净净：记下来，之后只回答问题、嘴上又说"做完了"的轮次不再挨个仓库查
  if (!newFiles.length && !procList.length) { if (done && !st.final) writeState(key, Object.assign({}, st, { final: true, at: Date.now() })); return ''; }
  const sig = newFiles.map(normKey).concat([...proc.keys()]).sort().join('|');
  let final = false;
  if (st.sig === sig) { if (!done || st.final) return ''; final = true; }
  writeState(key, { sig, final: final || done, at: Date.now() });
  const rel = (f) => { const r = path.relative(cwd, f); return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f).split(path.sep).join('/'); };
  const show = (list) => { const s = list.map((x) => typeof x === 'string' ? rel(x) : rel(x.abs) + (x.dir ? '/' : '')); return s.slice(0, 8).join('、') + (s.length > 8 ? ' 等 ' + s.length + ' 个' : ''); };
  const parts = [];
  if (procList.length) parts.push('项目里留下了过程文件（备份、日志、临时文件）：' + show(procList) + '。删掉，或者挪进 .vibe/tmp/<事由>/；不要留在项目里，也不要提交。是程序运行时自己生成的（比如上传目录、运行日志），不用动，说一句就行。');
  if (newFiles.length) {
    const mode = ['task', 'change', 'off'].includes(cfg.autoCommit) ? cfg.autoCommit : 'task';
    const midChange = mode === 'change' && changes().some((c) => c.todo > 0);
    if (mode === 'off') parts.push('你这个会话里新建、还没进 git 的文件：' + show(newFiles) + '。为了测试临时加的（测试页面、调试接口、测试数据），这件事做完了就删掉，别留在项目里；要交的留着，等我提交。');
    else parts.push('你这个会话里新建的这些文件还没进 git：' + show(newFiles) + '（git 不会自动带上新文件）。是这件事要交的，git add 后' + (midChange ? '跟着整个变更一起提交' : '提交') + '；是为了测试临时加的（测试页面、调试接口、测试数据），这件事做完了就删掉，别留在项目里；还要接着用的，说一句留着干什么。');
  }
  hookLog('verify-gate leftover ' + (final ? 'final ' : '') + 'new=' + newFiles.length + ' proc=' + procList.length);
  return (final ? '收尾：这件事做完了，下面这些还留着。' : '') + parts.join('\n');
}

/** 这一轮动过的变更不在 plan.md 里（中途加的新功能最容易漏记）：每个变更提醒一次加一行；不属于这个大需求的不用管 */
function planUnlistedTodo(touched) {
  const out = [];
  updateState('plan-unlisted', (st) => {
    for (const [k, a] of touched) {
      if (st[k]) continue;
      const osDir = path.join(a.root, 'openspec');
      const unlisted = planUnlisted(osDir);
      if (!unlisted || !unlisted.includes(a.name)) continue;
      st[k] = Date.now();
      out.push('变更 ' + a.name + ' 不在 ' + path.join(osDir, 'plan.md') + ' 里。它属于这个大需求（包括中途加的新功能）就在表里加一行，放在合适的位置，说明里写清是中途加的和起因；不属于这个大需求就不用管。');
    }
  });
  return out;
}
/** 设计只能写读过的东西：这一轮新写的 design.md，Context（现状）里列的文件，会话记录里得真的读过至少一个 */
function designGroundingTodo(calls, isEdit, fileOf, snapFiles, allCalls) {
  const out = [];
  const seen = new Set();
  for (const c of calls) {
    if (!isEdit(c)) continue;
    const art = artifactOf(fileOf(c));
    if (!art || art.kind !== 'design' || seen.has(art.dir)) continue;
    seen.add(art.dir);
    if (Object.prototype.hasOwnProperty.call(snapFiles, normKey(fileOf(c)))) continue;
    let text = ''; try { text = fs.readFileSync(fileOf(c), 'utf8'); } catch (e) { continue; }
    const roots = [art.root].concat(nestedRepos(art.root));
    const listed = [...new Set(sectionOf(text, /^##\s*(Context|背景|现状)/i).flatMap((l) => pathTokens(l)).filter((t) => pathExists(t, roots)))];
    if (!listed.length) continue;
    const reads = projectReads(allCalls).map((p) => p.toLowerCase().replace(/\\/g, '/'));
    const base = (t) => path.basename(t.replace(/[\\/]+$/, '')).toLowerCase();
    if (!listed.some((t) => { const b = base(t); return reads.some((r) => r.includes(b)); })) out.push('变更 ' + art.name + ' 的设计 Context 里说读了 ' + listed.slice(0, 4).join('、') + '，但这个会话里没有读过它们的记录（Read、带路径的 Grep、cat / Get-Content 都算）。设计只能写读过的东西：现在去读，读完对照实际情况修正设计，改了要在 revisions.md 记一条。');
  }
  return out;
}
/** 提案写好（proposal、specs、tasks 齐了）、还没开工、还没审过：催它按提案模式审一遍，每个变更最多催两轮。审查还在后台跑的（busy）不催 */
function proposalReviewTodo(touched, busy) {
  const out = [];
  for (const [key, a] of touched) {
    const dir = a.dir;
    if (proposalReviewed(dir) || (busy && busy(dir, 'proposal'))) continue;
    const has = (n) => fs.existsSync(path.join(dir, n));
    let specs = false;
    try { specs = fs.readdirSync(path.join(dir, 'specs')).length > 0; } catch (e) { /* 无 */ }
    if (!(has('proposal.md') && has('tasks.md') && specs)) continue;
    try { if (/^\s*[-*]\s*\[[xX]\]/m.test(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'))) continue; } catch (e) { continue; }
    if (!has('design.md')) { out.push('变更 ' + a.name + ' 缺 design.md。我们的规矩：每个提案都要有设计，Context 一节列出探索时读过的文件、表、接口，Decisions 写为什么这么做。补上再审。'); continue; }
    let asked = 0;
    updateState('reviewed-proposal', (st) => { const prev = st[key] && typeof st[key] === 'object' ? st[key] : {}; asked = prev.asked || 0; if (asked < 2) st[key] = Object.assign({}, prev, { asked: asked + 1, at: Date.now(), born: changeBorn(dir) }); });
    if (asked >= 2) continue;
    out.push('变更 ' + a.name + ' 的提案写好了。apply 之前先按 /ttls-cross-review 的提案模式审一遍：用 Agent 调 ttls-reviewer（run_in_background 传 false，等它的结论），提示第一行写"模式：提案"，第二行写变更目录 ' + dir + '，让它读 proposal、specs、design、tasks 和它们提到的代码，专挑想当然的、没说清的、场景漏的、任务不可验证或太大的、上下文对不齐的。成立的改掉并在 revisions.md 记录，再交代结果。');
  }
  return out;
}
/**
 * 链路要对齐，改了要有记录。需求 → 规格 → 设计 → 任务 → 代码是一条链：后面一环发现问题改了产物，上面的每一环都要看一遍要不要跟着改，并在 revisions.md 记下。
 * 什么算"修订"：用户开口时记过指纹的产物现在内容变了（打勾不算）；同一轮里写了后面的产物又回头改前面的。有修订、修订记录却没跟上，拦一次（每轮一次）。
 * 修订记录跟上了没有：这一轮用工具改过 revisions.md，或者它的内容和记指纹时不一样了（用命令追加的、会话记录里已经看不到的那次编辑也算）。
 * 对上了就把指纹换成现在的、记下对账的时间：全自动模式一轮能跑几个小时，之后的收工检查不再拿对过账的旧编辑说事——
 * 以前只在会话记录末尾那一段里找"改过 revisions.md"，几小时前记过的找不到，就说"这一轮改了 tasks.md 没记录"（问题反馈 F20260929-001）
 */
function revisionTodo(j, calls, isEdit, fileOf, turnId) {
  const skey = String(j.session_id || 'unknown') + '-artifacts';
  const snap = readState(skey);
  const files = snap.files || {};
  const checkedAt = Number(snap.checkedAt) || 0;
  const revised = new Map();
  let maxStage = 0;
  const writtenThisTurn = new Set();
  let recorded = false;
  const dirs = new Map();
  for (const c of calls) {
    if (!isEdit(c)) continue;
    if (checkedAt && c.at && c.at <= checkedAt) continue;
    const art = artifactOf(fileOf(c));
    if (!art) continue;
    dirs.set(normKey(art.dir), art.dir);
    const key = normKey(fileOf(c));
    if (art.kind === 'revisions') { recorded = true; continue; }
    const stage = STAGE[art.kind] || 0;
    const inSnap = Object.prototype.hasOwnProperty.call(files, key);
    const changedSinceSnap = inSnap && artifactHash(fileOf(c)) !== files[key];
    const modifiesExisting = inSnap || writtenThisTurn.has(key) || c.name !== 'Write';
    const upstream = stage < maxStage && modifiesExisting;
    if (changedSinceSnap || upstream) revised.set(key, { art, why: changedSinceSnap ? '改了内容' : '写了后面的产物之后又回头改它' });
    writtenThisTurn.add(key);
    maxStage = Math.max(maxStage, stage);
  }
  if (!recorded) for (const r of revised.values()) { const f = path.join(r.art.dir, 'revisions.md'); const h = artifactHash(f); if (h && h !== files[normKey(f)]) { recorded = true; break; } }
  if (!revised.size || recorded) {
    if (dirs.size) {
      for (const d of dirs.values()) for (const f of artifactFiles(d)) files[normKey(f)] = artifactHash(f);
      writeState(skey, Object.assign({}, snap, { files, checkedAt: Date.now() }));
    }
    return '';
  }
  const key = String(j.session_id || 'unknown') + '-revision';
  if (turnId && readState(key).turnId === turnId) return '';
  if (!turnId && j.stop_hook_active) return '';
  writeState(key, { turnId, at: Date.now() });
  const list = [...revised.values()];
  const names = [...new Set(list.map((r) => r.art.rel))].join('、');
  hookLog('verify-gate revision ' + list[0].art.name + ' ' + names);
  return '这一轮改了 OpenSpec 变更 ' + list[0].art.name + ' 的 ' + names + '（' + list[0].why + '），但没有记录。改产物要做两件事：\n'
    + '1. 往上对齐：改了 tasks 就看 design、specs、proposal 要不要跟着改；改了 design 就看 specs、proposal；改了 specs 就看 proposal。颗粒度要一致，不改的要说得出理由。\n'
    + '2. 在 ' + list[0].art.dir + '/revisions.md 末尾追加一条（没有就新建）：\n'
    + '## <日期 时间> · <在哪一步发现的，比如：apply 做 2.3 时>\n'
    + '- 起因：主观 / 客观 / 用户要求 / 需求变化 / 审查 / 自动模式决定 之一，加一句具体的（比如：客观，order 表没有 status 字段，设计里假设有）\n'
    + '- 改了：<文件>：<改了什么>\n'
    + '- 上层：<哪些跟着改了；哪些不用改，原因>\n'
    + '记完再收工。';
}
/** 提案里列的能力都要有对应的规格文件（提案写完、tasks 也有了之后才查） */
function capabilityTodo(touched) {
  const out = [];
  for (const [, a] of touched) {
    try {
      if (!fs.existsSync(path.join(a.dir, 'tasks.md')) || !fs.existsSync(path.join(a.dir, 'proposal.md'))) continue;
      const missing = proposalCapabilities(fs.readFileSync(path.join(a.dir, 'proposal.md'), 'utf8')).filter((cap) => !fs.existsSync(path.join(a.dir, 'specs', cap, 'spec.md')));
      if (missing.length) out.push('变更 ' + a.name + ' 的提案里列了能力 ' + missing.join('、') + '，但没有对应的 specs/<能力>/spec.md。每个能力都要有规格（每条需求带 WHEN/THEN 场景），补上；能力名和 specs 下的目录名要一模一样。');
    } catch (e) { /* 读不了就不查 */ }
  }
  return out;
}

/**
 * 上下文过了交接线：这一轮说完之后，让 Claude 用它自带的提问框（AskUserQuestion）问用户一句"现在交接吗"。
 * 选了"再做一会儿"，要再涨 10 个百分点才会再问；压缩之后（会话开始钩子清掉记录）重新问。快到网关实测上限时单独再问一次。
 */
/** 上下文用了多少：用量取状态栏刚记下的数（没有就从会话记录里算），百分比按现在的配置算。没有用量返回 null */
function usageOf(j, cfg, entries) {
  const st = readState(j.session_id);
  const fresh = !!st.at && Date.now() - st.at < 6 * 3600000;
  const used = (fresh && st.used) || lastUsageTokens(entries);
  if (!used) return null;
  const { size, pct } = contextPercent(used, fresh ? st.windowSize : 0, cfg);
  return { used, size, pct: Math.round(pct), line: Number(cfg.handoverPercent) || 70, gw: nearGatewayLimit(used) };
}
const tok = (n) => (n >= 1000000 ? String(Math.round(n / 100000) / 10) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));
function handoverQuestion(j, cfg, entries, wroteHo) {
  if ((cfg.handoverAsk || 'ask') === 'off' || cfg.autoMode || !j.session_id) return '';
  const u = usageOf(j, cfg, entries);
  if (!u) return '';
  const { used, size, pct, line, gw } = u;
  if (!gw && pct < line) return '';
  const key = j.session_id + '-handover';
  const asked = readState(key);
  // 这一轮刚写过交接记录（用户自己说了"交接一下"也算）：不再问，涨 10 个百分点之后再说
  if (wroteHo) { writeState(key, Object.assign({}, asked, { askedAtPct: pct }, gw ? { gwAsked: true } : {}, { at: Date.now() })); return ''; }
  if (gw ? asked.gwAsked : (asked.askedAtPct != null && pct < asked.askedAtPct + 10)) return '';
  writeState(key, Object.assign({}, asked, gw ? { gwAsked: true } : { askedAtPct: pct }, { at: Date.now() }));
  const why = gw
    ? '这个会话的请求快到内网网关能接受的大小了（上次大约 ' + tok(gw.limitTokens) + ' token 时被网关直接拒绝，撞上之后这个会话就发不出去了）'
    : '上下文已经用了 ' + pct + '%（' + tok(used) + ' / ' + tok(size) + '），过了 ' + line + '% 的交接线';
  return '[vibe-kit 交接] ' + why + '。现在只做一件事：调用 AskUserQuestion 工具问我，不要说别的话。\n'
    + '问题："' + (gw ? '快到网关的请求大小上限了' : '上下文已用 ' + pct + '%') + '，现在交接吗？"；header："交接"；两个选项：\n'
    + '  1. label "现在交接"，description "写好交接记录；然后我输入 /clear，再说一句继续，新会话就接着干"\n'
    + '  2. label "再做一会儿"，description "' + (gw ? '有风险：撞上上限后这个会话就发不出去了' : '再涨 10% 时再问') + '"\n'
    + '我选"现在交接"：执行 /ttls-handover 写交接记录，写完只回我一句"交接记录写好了。输入 /clear，然后说一句"继续"，新会话会先读交接记录再接着干"。\n'
    + '我选"再做一会儿"：什么都不用做，直接结束这一轮。\n'
    + '（如果你没有 AskUserQuestion 这个工具，就用一句话直接问我。）';
}
const under = (file, dir) => { const f = normKey(file); const d = normKey(dir); return f === d || f.startsWith(d + '/'); };

/**
 * 多轮审查（开关 reviewLoop，最多 reviewMaxRounds 轮）：一轮审查报了问题、之后改了东西，就催它再审改动点；报"问题 0 条"才算审完。
 * 每次审查调用只计一次（记下调用 id）；同一轮里最多催一次。只看这份会话记录里出现过的审查（别的项目、别的会话没审完的不管）。
 * 审查意见都不成立、之后只在这个变更的 revisions.md 里记了理由的，算处理完（lib/session.js 的 syncReviewRounds）。
 * 轮数用完还有问题：不管改没改，问用户一次（全自动按原则自己定），记成审完；之后出现新的审查才开始新一轮计数。
 */
function reviewLoopTodo(j, cfg, entries, reviews, turnId) {
  if (!cfg.reviewLoop) return [];
  const max = reviewMax(cfg);
  const out = [];
  const mark = [];
  for (const { key, rec, change, fixed } of syncReviewRounds(entries, reviews)) {
    if (rec.done || !rec.pendingFix) continue;
    if (Date.now() - (rec.at || 0) > 7 * 86400000) continue;
    const kind = key.startsWith('proposal|') ? 'proposal' : 'code';
    const name = kind === 'proposal' ? '提案' : '代码';
    if (rec.rounds >= max) { out.push(reviewExhaustedText(rec, kind, cfg, change.name)); mark.push([key, { done: true, exhausted: true }]); continue; }
    if (!fixed) continue;
    if (turnId ? rec.nudgedTurn === turnId : j.stop_hook_active) continue;
    out.push('变更 ' + change.name + ' 的第 ' + rec.rounds + ' 轮' + name + '审查报了 ' + rec.issues + ' 条问题、你也改了。多轮审查开着：再让 ttls-reviewer 审一遍改动点（第 ' + (rec.rounds + 1) + ' 轮，最多 ' + max + ' 轮）：提示第一行写"模式：复审' + name + '"，第二行写"变更：' + change.name + '"，只给它上一轮的问题清单和这次改过的文件，让它确认改对了没有、有没有改出新问题。它报"结论：问题 0 条"才算审完；上一轮的问题有不成立的，在 revisions.md 记下理由。');
    mark.push([key, { nudgedTurn: turnId || 'x' }]);
  }
  if (mark.length) updateState('review-rounds', (st) => { for (const [k, v] of mark) if (st[k]) Object.assign(st[k], v); });
  return out;
}
/**
 * 全自动模式（开关 autoMode）：用户不在，流程也要往下走。收工时看这个会话动过的变更（壳子里 git pull 下来的同事的变更不算）到了哪一步，该干什么就催一句：
 *   提案审过了还没开工 → 直接 apply；做了一半停下 → 接着做下一项；全做完没审代码 → 审；审出的问题还没处理 → 处理；审过了 → 归档。
 * 它已经明说卡住、要人定的不催。循环保护：同一轮里再次收工，只有有进展（打勾数增加）才再催，没进展就放行。快到网关上限也不催。
 */
const HAND_TIP = '改库照查库技能的两步走，不用等我确认（它留改前快照和还原脚本、记下新增的主键）。要我动手的事（查库的工具说备份不了的改库操作、改 redis、要账号密码、push）不做也不等：在那项任务后面加上"（留给用户：原因）"，不打勾，接着做不依赖它的。';
function autoModeTodo(j, cfg, entries, lastSaid, turnId, changes, busy) {
  if (!cfg.autoMode) return [];
  if (saidStuck(lastSaid)) return [];
  const used = lastUsageTokens(entries);
  if (used && nearGatewayLimit(used)) return [];
  // 只催这个会话在流程里动手做过的变更：只是读过它的 tasks.md、话里提到过名字的不催
  // （另开一个窗口做检索，收工时不能自己去接着做别的窗口正在做的变更）
  const flow = flowChanges(j);
  const mine = sessionChanges(j.session_id, entries, changes).filter((c) => flow.includes(normKey(c.dir)));
  if (!mine.length) return [];
  const skey = String(j.session_id || 'unknown') + '-auto';
  const st = readState(skey);
  // 这个会话碰过的变更挨个看：头一个还有事可做的，催它往下走。能做的都做完了、只剩留给用户的那个变更，放着，看下一个
  for (const c of mine) {
    const key = normKey(c.dir);
    const prev = st[key] || {};
    const left = c.todo - (c.waiting || 0);
    let msg = '';
    if (left > 0 && c.done === 0) { if (proposalReviewed(c.dir)) msg = '全自动模式：' + c.name + ' 的提案审过了，不用问我，直接开始 /opsx:apply，一项一项做到全部打勾（每项：做 → 跑验法 → 打勾 → 提交）。' + HAND_TIP; }
    else if (left > 0) msg = '全自动模式：' + c.name + ' 还有 ' + left + ' 项没做完，不用问我，接着做下一项：' + c.next + '。' + HAND_TIP;
    else if (c.done > 0) {
      const loop = readState('review-rounds')['code|' + key];
      const loopOpen = cfg.reviewLoop && loop && !loop.done;
      const cr = codeReviewIssue(c.dir);
      // 代码审查还在后台跑：等它的结论（通知到了会接着一轮），不催
      if (busy && busy(c.dir, 'code')) msg = '';
      else if (cr) msg = '全自动模式：' + c.name + ' 能做的任务都做完了，' + cr + '。成立的问题修掉并验证' + (c.waiting ? '。' : '，再归档。');
      else if (loopOpen) msg = '全自动模式：' + c.name + ' 的代码审查报了 ' + (loop.issues || 0) + ' 条问题还没处理：成立的改掉并验证（改完收工检查会催复审），不成立的在 revisions.md 逐条记下理由（起因：审查）' + (c.waiting ? '。' : '；处理完再归档。');
      else if (!c.waiting) msg = '全自动模式：' + c.name + ' 任务全部完成、代码审过了，不用问我，直接 /opsx:archive ' + c.name + ' 归档（规格要同步就同步）。归档完就收工，收工时套件会给你一份这一轮的报告，照着交代。';
    }
    if (!msg) continue;
    // 循环保护：同一轮里再次收工，只有有进展（打勾数增加）才再催，没进展就看下一个变更
    if (j.stop_hook_active && !(prev.turnId === turnId && c.done > prev.doneAtNudge)) continue;
    st[key] = { doneAtNudge: c.done, turnId, at: Date.now() };
    writeState(skey, st);
    return [msg];
  }
  return [];
}
/**
 * 全自动模式收工：这一轮的情况（留给用户的、想问没问成的、没验证的、放行的、自己定的）合成一份报告，交给它照着交代。
 * 同一轮里交一次；交过之后又有新情况的再交，最多三次。只有提交、别的什么都没有的，写好报告文件、不拦。
 * 交过之后的收工：把它最后说的话接到报告后面
 */
function autoReport(j, cfg, entries, lastSaid, changes) {
  if (!cfg.autoMode || !report || !j.session_id) return '';
  const st = report.stateOf(j);
  const fresh = st.items.length > st.deliveredCount;
  if (st.delivered && (!fresh || st.times >= 3)) { report.saveFinal(j, lastSaid); return ''; }
  let mine = [];
  try { mine = sessionChanges(j.session_id, entries, changes); } catch (e) { mine = []; }
  const r = report.build(j, cfg, mine);
  if (r.empty) return '';
  const c = r.counts;
  const worth = mine.length || c.archived || c.hand || c.db || c.asks || c.unverified || c.bypass || c.secrets || c.decisions || c.kit;
  if (!worth) { report.delivered(j, r); report.saveFinal(j, lastSaid); return ''; }
  report.delivered(j, r);
  hookLog('verify-gate 全自动报告 ' + r.file + ' 留给用户=' + c.hand + ' 改库=' + c.db + ' 想问=' + c.asks + ' 没验证=' + c.unverified + ' 放行=' + c.bypass);
  return '[vibe-kit 全自动报告] 这一轮的情况套件记下来了' + (r.file ? '，报告在 ' + r.file : '') + '：\n' + r.brief + '\n'
    + '现在写最后的交代，照下面的顺序，一节一个小标题，没有的写"没有"。上面列的照实写，你知道而套件没记到的补上：\n'
    + '1. 做了什么（哪个变更、做到第几项、归档了没有）\n'
    + '2. 留给你做的（查库的工具说备份不了、没执行的改库操作，要改 redis 的，要账号密码的，push，放哪还没定的产出，要你看一眼的页面）\n'
    + '3. 库里改过的（哪张表、几行、新增的主键、还原脚本在哪）\n'
    + '4. 自己定的事（没问就定了的，各写一句理由）\n'
    + '5. 没验证的（哪一项、为什么没验）\n'
    + '6. 放行的检查（哪道检查、理由）\n'
    + '7. 套件问题（编号和一句话）\n'
    + '写完就收工，不要再做别的。';
}
/**
 * 归档之后主规格跟上了没有：这个会话碰过、现在已经在 archive 里的变更，它的规格增量（specs/<能力>/spec.md 里 ADDED / MODIFIED 的需求）
 * 在主规格 openspec/specs/<能力>/spec.md 里找得到吗。用 --skip-specs 归档、或者手工 mv 归档的，主规格不会自己更新，
 * 以前没有任何提醒（问题反馈 F20260929-014）。每个变更提醒一次
 */
function archivedSpecTodo(j) {
  if (!j.session_id) return [];
  const known = (readState(String(j.session_id) + '-changes').dirs) || [];
  if (!known.length) return [];
  const skey = String(j.session_id) + '-archived-spec';
  const told = readState(skey);
  const out = [];
  let dirty = false;
  for (const k of known) {
    if (told[k] || fs.existsSync(k)) continue;
    const name = path.basename(k);
    const changesDir = path.dirname(k);
    let hit = '';
    try { hit = fs.readdirSync(path.join(changesDir, 'archive')).filter((n) => n.toLowerCase() === name.toLowerCase() || n.toLowerCase().endsWith('-' + name.toLowerCase())).sort().pop() || ''; } catch (e) { hit = ''; }
    if (!hit) continue;
    told[k] = Date.now();
    dirty = true;
    const arch = path.join(changesDir, 'archive', hit);
    const missing = [];
    let caps = [];
    try { caps = fs.readdirSync(path.join(arch, 'specs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { caps = []; }
    for (const cap of caps) {
      let delta = '';
      try { delta = fs.readFileSync(path.join(arch, 'specs', cap, 'spec.md'), 'utf8'); } catch (e) { continue; }
      let main = '';
      try { main = fs.readFileSync(path.join(path.dirname(changesDir), 'specs', cap, 'spec.md'), 'utf8'); } catch (e) { main = ''; }
      const have = new Set((main.match(/^###\s+Requirement:\s*(.+)$/gim) || []).map((l) => l.replace(/^###\s+Requirement:\s*/i, '').trim().toLowerCase()));
      let mode = '';
      for (const l of delta.split(/\r?\n/)) {
        const h = l.match(/^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements/i);
        if (h) { mode = h[1].toUpperCase(); continue; }
        if (/^##\s/.test(l)) { mode = ''; continue; }
        const r = l.match(/^###\s+Requirement:\s*(.+)$/i);
        if (r && (mode === 'ADDED' || mode === 'MODIFIED') && !have.has(r[1].trim().toLowerCase())) missing.push(cap + '：' + r[1].trim());
      }
    }
    if (missing.length) out.push('变更 ' + name + ' 归档了，但主规格里没有它的这些需求：' + missing.slice(0, 6).join('；') + (missing.length > 6 ? ' 等 ' + missing.length + ' 条' : '') + '。用了 --skip-specs、或者手工挪目录归档的，主规格不会自己更新。照归档目录 ' + arch + ' 里 specs/<能力>/spec.md 的内容，把这些需求（连同它们的场景）并进 openspec/specs/<能力>/spec.md（没有这个文件就新建，开头写 "# <能力> Specification" 和 "## Requirements"），提交信息写"docs: 同步规格 ' + name + '"。归档目录不要改。');
  }
  if (dirty) writeState(skey, told);
  return out;
}
/**
 * 全自动模式的交接（有人在的时候由 handoverQuestion 问）：
 *   快到网关的请求上限：让它写交接记录然后停下——撞上了这个会话就发不出去了，全自动也得停（每个会话说一次；说过、写过之后别的也不催了，让它停）
 *   过了交接线（开关 autoHandover）：还有活要接着干时，先写一份交接记录再接着做（会话断了能接上）；每涨 10 个百分点说一次
 * 返回 { stop: 拦下要说的话（只说这一件）, quiet: 让它停、别的都不催, line: 附在别的待办后面的一句 }
 */
function autoHandover(j, cfg, entries, wroteHo) {
  const out = { stop: '', quiet: false, line: '' };
  if (!cfg.autoMode || !j.session_id) return out;
  const u = usageOf(j, cfg, entries);
  if (!u) return out;
  const key = j.session_id + '-handover';
  const h = readState(key);
  if (u.gw) {
    out.quiet = true;
    if (!h.gwStop && !wroteHo) {
      writeState(key, Object.assign({}, h, { gwStop: true, at: Date.now() }));
      out.stop = '[vibe-kit 交接] 这个会话的请求快到内网网关能接受的大小了（上次大约 ' + tok(u.gw.limitTokens) + ' token 时被网关直接拒绝，撞上了这个会话就发不出去了）。全自动模式也得停：现在执行 /ttls-handover 写交接记录（没提交的、没审的、下一步都写清楚），写完就停下，交代里说清停下的原因，等我回来开新会话接着做。';
    }
    return out;
  }
  if (u.pct < u.line || cfg.autoHandover === false) return out;
  if (wroteHo) { writeState(key, Object.assign({}, h, { autoAtPct: u.pct, at: Date.now() })); return out; }
  if (h.autoAtPct != null && u.pct < h.autoAtPct + 10) return out;
  out.line = '另外，上下文已经用了 ' + u.pct + '%（' + tok(u.used) + ' / ' + tok(u.size) + '），过了 ' + u.line + '% 的交接线：先执行 /ttls-handover 写一份交接记录（万一会话断了能接上），写完接着做上面的事，不要停下等我。';
  out.mark = () => writeState(key, Object.assign({}, readState(key), { autoAtPct: u.pct, at: Date.now() }));
  return out;
}

async function handle(j) {
  // HTTP 方式下工作线程一直在，上一次读到的项目说明可能已经改过了
  notesCache.clear();
  const cfg = readConfigFor(j);
  // 收工检查管的都是项目级的事（变更、审查、报告）：照会话的启动目录来，不照现在所在的目录（模型单独 cd 过就变了，议题 #8）
  j = atHome(j);
  const cwd = j.cwd || process.cwd();
  const sid = String(j.session_id || 'unknown');
  // 收工的时候也看一眼要不要检查更新、上报问题（全自动模式下用户好几个小时不开口，只有这里会经过）
  try { require('../lib/updater.js').kick('收工'); } catch (e) { /* 老版本没有，或者甩不出去：不影响收工 */ }
  // 查库、查 redis 的工具自己报的毛病：读进来记成问题反馈（算这个会话的，交代里的"套件问题"会列出来）
  try { require('../lib/toolstats.js').ingest(j); } catch (e) { /* 读不了不影响收工 */ }
  const entries = j.transcript_path ? tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain) : [];
  const { start, turnId, prompt } = turnStart(entries);
  const calls = toolCalls(entries, start);
  const results = toolResults(entries.slice(start));
  const failed = (c) => { const r = results.get(c.id); return !!(r && r.error); };
  // 全自动模式只在走 OpenSpec 流程时算开着。用户开口时定过一次（task-anchor）；这一轮里它自己调了 OpenSpec 的技能的，
  // 调的那一刻也记了（guard-ask）。这里兜底再看一遍这一轮的调用：那两处没经过（钩子走的是老的登记）也认得出
  if (cfg.autoSwitch && !cfg.autoMode) {
    const viaSkill = calls.find((c) => /^(Skill|SlashCommand)$/.test(c.name) && !failed(c) && FLOW_SKILL.test(String(c.input.skill || c.input.command || c.input.name || '')));
    if (viaSkill) { setFlow(j, true, '调了 OpenSpec 的技能'); cfg.autoMode = true; hookLog('全自动模式 这个会话进了 OpenSpec 流程：这一轮调了 OpenSpec 的技能'); }
  }
  // 在流程里动手做过的变更：收工时只催这几个往下走。算动手的：写过它的产物、打过勾；openspec 命令、技能的参数里点了它的名
  // （/opsx:apply 没带名字，它照 OpenSpec 的步骤先跑 openspec status --change <名字>）。只是读过它的 tasks.md 不算：那可能是别的窗口在做的
  if (cfg.autoMode) {
    try {
      const named = [];
      for (const c of calls) {
        if (failed(c)) continue;
        if (/^(Edit|Write|MultiEdit)$/.test(c.name)) { const a = artifactOf(String(c.input.file_path || '')); if (a) flowTouch(j, a.dir); continue; }
        if (/^(Bash|PowerShell)$/.test(c.name) && /\bopenspec\b/i.test(String(c.input.command || ''))) named.push(String(c.input.command || ''));
        else if (/^(Skill|SlashCommand)$/.test(c.name)) named.push(JSON.stringify(c.input || {}));
      }
      if (named.length) for (const ch of allChanges(cwd)) if (named.some((t) => mentionsChange(t, ch.name))) flowTouch(j, ch.dir);
    } catch (e) { /* 记不了：不催这个变更，不影响收工 */ }
  }
  // 全自动模式快到网关上限：只让它写交接记录然后停，别的都不催（再干下去撞上了，这个会话就发不出去了）
  const wroteHo = handoverWrittenIn(calls, prompt, failed);
  const ah = autoHandover(j, cfg, entries, wroteHo);
  if (ah.stop) return blockOut('Stop', ah.stop);
  if (ah.quiet) return null;
  const unavailable = (c) => { const r = results.get(c.id); return !!(r && r.error && /No such tool available/i.test(r.text)); };
  const lastSaid = String(j.last_assistant_message || '') || textOf([...entries].reverse().find((e) => e.type === 'assistant') || {});
  const fileOf = (c) => String(c.input.file_path || c.input.notebook_path || '');
  const isEdit = (c) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && !failed(c) && !!fileOf(c);
  const isSource = (c, re) => isEdit(c) && re.test(fileOf(c)) && !nonSource(fileOf(c));
  const lastIndex = (pred) => { for (let i = calls.length - 1; i >= 0; i--) if (pred(calls[i])) return i; return -1; };
  const ranAfter = (idx, re) => calls.slice(idx + 1).some((c) => /^(Bash|PowerShell)$/.test(c.name) && !unavailable(c) && !failed(c) && re.test(String(c.input.command || '')));
  const names = (list) => [...new Set(list.map((c) => path.basename(fileOf(c))))].slice(0, 5).join('、');
  let changesMemo = null;
  const changes = () => changesMemo || (changesMemo = listChanges(cwd));
  const todo = [];

  // 做完了的审查先记下来，后面的判断都看记录。前台跑的结论在 tool_result 里；后台跑的（2.1.259 起 Agent 默认在后台）结论在后来的通知里，
  // 通知常常到下一轮才来，所以看整段会话记录，同一次审查只记一次
  const reviews = syncReviews(entries, cwd);
  // 审查报的问题自动收（开关 lessonAuto）：报了之后那个文件确实改过的才收。同样的问题在几个变更里反复出现就变成规则，不靠模型自觉去记
  try {
    if (lessons && lessons.autoCollect && cfg.lessonAuto !== false && reviews.some((r) => r.issues > 0 && (r.change || r.source))) {
      const all = toolCalls(entries, 0);
      const res = toolResults(entries);
      const edits = all.filter((c) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name) && (c.input.file_path || c.input.notebook_path) && res.get(c.id) && !res.get(c.id).error).map((c) => ({ file: String(c.input.file_path || c.input.notebook_path), pos: c.i }));
      const got = lessons.autoCollect({ reviews, edits, cwd }, cfg);
      if (got.stored) hookLog('verify-gate 自动收了 ' + got.stored + ' 条审查报的问题' + (got.promoted.length ? '，升成规则 ' + got.promoted.map((x) => x.id).join('、') : '') + (got.category.length ? '，按类别出的规则 ' + got.category.map((x) => x.id).join('、') : ''));
    }
  } catch (e) { hookLog('verify-gate 自动收审查问题出错（不拦）：' + ((e && e.message) || e)); if (feedback) feedback.recordHookError('verify-gate（自动收审查问题）', j, e); }
  // 发出去了、还在后台跑的审查：这时候别再催它审一遍（催了它会再开一个）
  const pending = pendingReviewsIn(toolCalls(entries, 0), toolResults(entries), allChanges(cwd), taskNotes(entries));
  const busy = (dir, mode) => pending.some((p) => p.mode === mode && p.change && normKey(p.change.dir) === normKey(dir));

  // 这一轮的小状态：每件事每轮最多拦一次；续跑里只看"拦下之后又改了代码"
  const gkey = sid + '-gate';
  const gate = readState(gkey);
  // 一整轮太长（全自动长跑），会话记录末尾那一段里找不到这一轮的开头（turnId 为空）：续跑就当是同一轮，不重复拦
  const sameTurn = turnId ? gate.turnId === turnId : !!j.stop_hook_active;
  let specChecked = sameTurn ? !!gate.specChecked : false;
  const codeEdits = calls.filter((c) => isSource(c, CODE));
  const codeNeedingCheck = (cfg.autoVerify ? codeEdits.filter((c) => !notApplicable(projectNotesFor(fileOf(c)), '快检|验证')) : []);
  const pageEdits = cfg.autoSeePage ? calls.filter((c) => isSource(c, PAGE) && !notApplicable(projectNotesFor(fileOf(c)), '看页面|页面')) : [];
  const verifyIssue = () => {
    const last = codeNeedingCheck.length ? calls.indexOf(codeNeedingCheck[codeNeedingCheck.length - 1]) : -1;
    if (last >= 0 && !ranAfter(last, VERIFY_CMD) && !SAID_UNVERIFIED.test(lastSaid)) return '这一轮改了代码（' + names(codeNeedingCheck) + '），最后一次修改之后没有成功跑过验证。按项目说明（.vibe/project.md）里的快检命令验一下，把这一轮改过的文件一起传；确实没法验，就明说"没验证"和原因。';
    return '';
  };
  if (!j.stop_hook_active) {
    const v = verifyIssue();
    if (v) todo.push(v);
    const lp = pageEdits.length ? calls.indexOf(pageEdits[pageEdits.length - 1]) : -1;
    if (lp >= 0 && !ranAfter(lp, /scenario-run/) && !SAID_NO_PAGE.test(lastSaid)) todo.push('这一轮改了页面文件（' + names(pageEdits) + '），还没在浏览器里看过。按 /ttls-see-page 的做法跑一遍受影响的页面：已有场景文件就直接重跑，没有就写一个最小的；以执行器读到的值和页面结构为准，不必读截图。这次改动确实不影响页面显示，就说明原因。');
  } else if (sameTurn && codeNeedingCheck.length > (gate.codeEditsAtBlock || 0)) {
    // 续跑：拦下之后又改了代码（常见于审查之后的修复），没验证就再说一次
    const v = verifyIssue();
    if (v) todo.push('拦下之后你又改了代码。' + v);
  }

  // 交叉审查：这一轮亲手把变更的最后一项任务打了勾、代码还没审过的，催一次（只记"催过"和做完的时间，"审过"要看到真的审查）
  if (cfg.autoCrossReview) {
    const edited = calls.filter(isEdit).map(fileOf);
    const fresh = changes().filter((c) => c.todo === 0 && c.done > 0 && edited.some((f) => under(f, c.dir)) && !codeReviewed(c.dir) && !busy(c.dir, 'code'));
    const toNudge = [];
    if (fresh.length) updateState('review-nudged', (st) => {
      for (const c of fresh) {
        const k = normKey(c.dir);
        const prev = st[k];
        if (prev && (!prev.born || Math.abs(prev.born - changeBorn(c.dir)) <= 2000)) continue;
        st[k] = { at: Date.now(), born: changeBorn(c.dir) };
        toNudge.push(c);
      }
    });
    if (toNudge.length) todo.push('OpenSpec 变更 ' + toNudge.map((c) => c.name).join('、') + ' 的任务已全部打勾。归档之前按 /ttls-cross-review 的代码模式审一遍：用 Agent 调 ttls-reviewer（run_in_background 传 false，等它的结论），提示第一行写"模式：代码"，写上变更名，前端后端的改动都给它；成立的问题修掉并验证，再交代结果。');
  }

  // 提交：这一轮自己改成功的文件（.vibe、.claude 里的不算）在 git 里还是没提交的状态。每一轮只提一次
  const mode = ['task', 'change', 'off'].includes(cfg.autoCommit) ? cfg.autoCommit : 'task';
  if (mode !== 'off' && j.session_id !== undefined) {
    const mine = [...new Set(calls.filter(isEdit).map(fileOf).filter((f) => !/(^|[\\/])\.(vibe|claude)[\\/]/.test(f)))];
    const ckey = sid + '-commit';
    const once = turnId ? readState(ckey).turnId !== turnId : !j.stop_hook_active;
    const midChange = mode === 'change' && changes().some((c) => c.todo > 0);
    if (mine.length && once && !midChange) {
      const dirty = await uncommitted(mine);
      if (dirty.length) {
        writeState(ckey, { turnId, at: Date.now() });
        const where = dirty.map((d) => path.basename(d.root) + '（' + d.count + ' 个文件）').join('、');
        const how = '先自己把 diff 过一遍（有没有调试代码、误改、漏改），然后进到对应的仓库（git -C <目录>），只 git add 你这一轮改的和新建的文件（新建的 git 不会自动带上；不用 -A、.、-u，也不用 commit -a），一项任务一次提交，信息按"类型: 内容"写（例：feat: 新增修改页面）；只提交不 push';
        if (todo.length) todo.push('验证过了就接着提交，不用等我说：' + how + '。验证没过、还没做完的先不提交。');
        else todo.push('这一轮改过的文件还没提交：' + where + '。已经做完并且验证过的，现在提交：' + how + '。还没做完、验证没过的先不提交，说明原因就行。');
      }
    }
  }

  // 新建了、没进 git 的文件（要交的提交，测试用的删掉），项目里留下的过程文件（备份、日志）：同一批只提一次，说"做完了"时再提一次（开关 vibeTidy）
  if (cfg.vibeTidy !== false) { try { const lo = await leftoverTodo(j, entries, cfg, lastSaid, changes, start); if (lo) todo.push(lo); } catch (e) { hookLog('verify-gate leftover 出错（不拦）：' + ((e && e.message) || e)); if (feedback) feedback.recordHookError('verify-gate（收尾：新文件和过程文件）', j, e); } }

  // 套件问题：说了是套件的问题却没记；做完了，交代里没列这个会话记下的套件问题
  try { const kt = kitIssueTodo(j, lastSaid); if (kt) todo.push(kt); } catch (e) { if (feedback) feedback.recordHookError('verify-gate（套件问题）', j, e); }

  // 经验沉淀：审查报了问题、处理过了，却没记经验；经验规则文件改了还没提交
  try { const lt = lessonTodo(j, cfg, entries, reviews, lastSaid); if (lt) todo.push(lt); } catch (e) { hookLog('verify-gate lessons 出错（不拦）：' + ((e && e.message) || e)); if (feedback) feedback.recordHookError('verify-gate（经验沉淀）', j, e); }
  try { const lc = lessonCommitTodo(j, cfg, turnId, changes); if (lc) todo.push(lc); } catch (e) { hookLog('verify-gate lesson-commit 出错（不拦）：' + ((e && e.message) || e)); if (feedback) feedback.recordHookError('verify-gate（经验规则提交）', j, e); }

  // 提案的门槛：改了产物要记录、提案里的能力要有规格、设计只能写读过的、提案写好先审、变更要在计划表里（每件事每轮最多一次）
  if (cfg.specGate !== false) {
    const touched = new Map();
    for (const c of calls) { if (!isEdit(c)) continue; const a = artifactOf(fileOf(c)); if (a && a.kind !== 'revisions') touched.set(normKey(a.dir), a); }
    const rv = revisionTodo(j, calls, isEdit, fileOf, turnId);
    if (rv) todo.push(rv);
    if (touched.size && !specChecked) {
      const before = todo.length;
      todo.push(...capabilityTodo(touched));
      const snapFiles = (readState(sid + '-artifacts').files) || {};
      todo.push(...designGroundingTodo(calls, isEdit, fileOf, snapFiles, toolCalls(entries, 0)));
      if (!j.stop_hook_active) todo.push(...proposalReviewTodo(touched, busy));
      if (todo.length > before) specChecked = true;
    }
    if (touched.size) todo.push(...planUnlistedTodo(touched));
    try { todo.push(...archivedSpecTodo(j)); } catch (e) { hookLog('verify-gate 查归档后的主规格出错（不拦）：' + ((e && e.message) || e)); }
  }
  // 大需求的计划（openspec/plan.md）：归档、打勾之后状态列跟着变
  try { planSummary(cwd); } catch (e) { /* 没有计划就算了 */ }
  // 归档了的变更，它的过程文件（.vibe/tmp、.vibe/out 里变更名开头的目录）现在清掉：归档之前不让模型自己删（guard-commit 的 keepIssue），归档之后也不用它动手。
  // 归档之后又动过的不清（归档后接着修问题，事由还写这个变更名的）
  if (cfg.vibeTidy !== false && tidy && tidy.changeOwner) {
    try {
      const gone = tidy.cleanTmp([cwd].concat(nestedRepos(cwd)), 0, archivedNames(cwd), allChanges(cwd).map((c) => c.name), archivedSince(cwd));
      if (gone.length) hookLog('verify-gate 归档了的变更的过程文件清掉了：' + gone.map((g) => g.dir).join(' | '));
    } catch (e) { /* 清不了，下次会话开始再清 */ }
  }
  // 记下这个会话碰过的变更：开口时的进度行、全自动推进只认这些（会话记录很长时，早先碰过的不在末尾那一段里）
  if (calls.some((c) => /openspec/i.test(fileOf(c) + ' ' + String(c.input.command || '')))) { try { sessionChanges(j.session_id, entries, changes()); } catch (e) { /* 记不了不影响收工 */ } }
  // 多轮审查
  todo.push(...reviewLoopTodo(j, cfg, entries, reviews, turnId));
  // 全自动模式：别的事都了了，看流程走到哪一步，催它往下走
  if (!todo.length) todo.push(...autoModeTodo(j, cfg, entries, lastSaid, turnId, changes(), busy));
  // 全自动模式过了交接线：还有活要干，先写一份交接记录
  if (todo.length && ah.line) { todo.push(ah.line); ah.mark(); }

  if (todo.length) {
    writeState(gkey, { turnId, codeEditsAtBlock: codeNeedingCheck.length, specChecked, at: Date.now() });
    return blockOut('Stop', '[vibe-kit 收工检查] ' + todo.join('\n'));
  }
  // 全自动模式收工：把这一轮的报告交给它，照着交代
  try { const rp = autoReport(j, cfg, entries, lastSaid, changes()); if (rp) return blockOut('Stop', rp); } catch (e) { hookLog('verify-gate 全自动报告出错（不拦）：' + ((e && e.message) || e)); if (feedback) feedback.recordHookError('verify-gate（全自动报告）', j, e); }
  // 验证的事都没落下，再看要不要问一句交接（两件事不挤在一起说）
  const ask = handoverQuestion(j, cfg, entries, wroteHo);
  if (ask) return blockOut('Stop', ask);
  return null;
}

module.exports = { handle };
if (require.main === module) cli(handle);

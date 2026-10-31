'use strict';
/*
 * OpenSpec 提案的门槛：含糊说法、提到的文件在不在、tasks/specs/design 的检查、验法认法、会话记录里读过哪些文件。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nestedRepos, changeRoots, listChanges } = require('./session-projects');
const { normKey } = require('./session-state');

/**
 * 含糊词：出现在产物里就是"留到以后再说"。按整句短语认，不按单字（"之后再次打开"不算）。
 * 同一行里已经写了默认怎么做的（决策项）不算；引号里的不算（那是在引用这个词，或者是业务上的状态名）。
 * "待确认""待确定""待补充"也可能是业务状态名：只认当前词的状态枚举、代码映射和操作条件，不放过同一行其它未定事项。
 */
const HEDGE_WORDS = ['待定', '待商榷', '待讨论', '待完善', '后续完善', '后续补充', '后续再说', '后续再定', '后续再议', '后续再补', '后续再看', '后面再说', '后面再定', '后面再补', '后面再看', '以后再说', '以后再定', '以后再补', '以后再做', '以后再看', '之后再说', '之后再定', '之后再补', '之后再做', '之后再看', '开发阶段再', '开发阶段确定', '开发阶段补充', '开发阶段完善', '开发时再', '实现时再', '编码时再', '视情况', '看情况', '暂不考虑', '暂不确定', '暂不处理', '另行讨论', '另行确定', '另行处理', '细节略', 'tbd', 'tbc', 'to be determined', 'to be decided', 'to be defined', 'decide later', 'figure out later'];

const HEDGE_SOFT = ['待确定', '待确认', '待补充'];

const DECIDED = /默认(按|用|取|为|走|是|值|[:：])|先按|暂按|按(?![钮键])[^，。；]{1,24}(做|处理|实现|来)/;

/** 第 i 个字符在不在引号里："" '' `` “” ‘’ 「」 『』 */
function quotedAt(line, i) {
  const pairs = { '“': '”', '‘': '’', '「': '」', '『': '』' };
  const stack = [];
  for (let k = 0; k < i; k++) {
    const ch = line[k];
    if (stack.length && ch === stack[stack.length - 1]) { stack.pop(); continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === '"' || ch === '`' || (ch === "'" && !/\w/.test(line[k - 1] || ''))) stack.push(ch);
  }
  return stack.length > 0;
}

const SOFT_BEFORE = /(变为|改为|置为|设为|变成|改成|转为|状态为|状态是|状态：|状态:)\s*$/;

const SOFT_AFTER = /^\s*(状态|态|的(客户|订单|数据|记录|单据|申请|用户|资料|列表))/;

/** 当前词是否是明确的状态值；不能因为一行有“状态”就放过整行。 */
function stateValueAt(line, i, word) {
  const before = line.slice(0, i), after = line.slice(i + word.length);
  if (SOFT_BEFORE.test(before) || SOFT_AFTER.test(after)) return true;
  // 状态（待确认 / 已确认 / 退回）：必须是枚举中的独立项，不能是“待确认后再补验法”。
  const open = Math.max(before.lastIndexOf('（'), before.lastIndexOf('('));
  if (open >= 0 && /状态\s*$/.test(before.slice(0, open))) {
    const end = after.search(/[）)]/);
    if (end >= 0) {
      const values = (before.slice(open + 1) + word + after.slice(0, end)).split(/\s*[/、,，]\s*/);
      if (values.length > 1 && values.every(v => /^[\w\u4e00-\u9fff]{1,16}$/.test(v.trim())) && /(?:^|[/、,，])\s*$/.test(before.slice(open + 1)) && /^\s*(?:[/、,，]|$)/.test(after.slice(0, end))) return true;
    }
  }
  // SUBMITTED 的中文标签，或 Markdown 枚举表的一格。
  if (/`[A-Z][A-Z0-9_]*`\s*[（(]\s*$/.test(before) && /^\s*[）)]/.test(after)) return true;
  if (/\|\s*`?[A-Z][A-Z0-9_]*`?\s*\|\s*$/.test(before) && /^\s*\|/.test(after)) return true;
  // “开始确认（仅待确认）”明确限定操作适用状态。
  return /(?:操作|按钮|查看|确认|审批|提交|编辑|退回)[^，。；;（）()]{0,32}[（(]\s*仅\s*$/.test(before) && /^\s*[）)]/.test(after);
}

function hedgeHit(line) {
  const low = line.toLowerCase();
  for (const w of HEDGE_WORDS) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) if (!quotedAt(line, i)) return w;
  }
  for (const w of HEDGE_SOFT) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) {
      if (quotedAt(line, i) || stateValueAt(line, i, w)) continue;
      return w;
    }
  }
  return '';
}

function findHedges(text, isAdded) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    const hit = hedgeHit(l);
    if (hit && !DECIDED.test(l)) out.push({ line: i + 1, word: hit, text: l.trim().slice(0, 70) });
  });
  return out;
}

/** openspec/changes/<名字>/ 下的产物：proposal / design / tasks / spec（specs/**.md）/ revisions；archive 里的不算 */
function artifactOf(file) {
  try {
    if (!file) return null;
    const abs = path.resolve(String(file)).split(path.sep).join('/');
    const m = abs.match(/^(.*)\/openspec\/changes\/([^/]+)\/(.+)$/i);
    if (!m || m[2].toLowerCase() === 'archive') return null;
    const rel = m[3];
    const kind = /^proposal\.md$/i.test(rel) ? 'proposal' : /^design\.md$/i.test(rel) ? 'design' : /^tasks\.md$/i.test(rel) ? 'tasks' : /^revisions\.md$/i.test(rel) ? 'revisions' : /^specs\/.+\.md$/i.test(rel) ? 'spec' : '';
    if (!kind) return null;
    return { kind, name: m[2], root: m[1], dir: m[1] + '/openspec/changes/' + m[2], rel };
  } catch (e) { return null; }
}

/** 产物在链路上的位置：需求 → 规格 → 设计 → 任务。改了前面的，后面的要跟着看 */
const STAGE = { proposal: 1, spec: 2, design: 3, tasks: 4 };

const CODE_EXT = /\.(?:java|kt|groovy|scala|xml|vue|jsx?|tsx?|mjs|cjs|sql|ya?ml|json|properties|html?|css|scss|less|py|go|cs|rs|php|rb|md|sh|bat|ps1|cmd|gradle|txt|csv|ftl|jsp|xlsx?)$/i;

const SRC_ROOTS = /^(?:\.{1,2}[\\/])?(?:src|web|app|apps|lib|libs|config|conf|resources|static|public|pages|views|components|api|server|client|frontend|backend|db|sql|scripts?|tests?|docs?|WebRoot|WebContent|main|java|mapper|service|controller|dao|entity|model|utils?)\b/i;

// 路径里允许中文（sql/v2_订单.sql、docs/说明.md）
const PC = String.raw`[\w.\-一-龥]`;

const PATH_LIKE = new RegExp(String.raw`(?:[A-Za-z]:)?(?:\.{1,2}[\\/])?(?:${PC}+[\\/])+${PC}+[\\/]?|[\w\-一-龥]+\.(?:java|kt|vue|jsx?|tsx?|sql|xml|ya?ml|json|properties|py|go|cs|html?|css|scss|less|md|sh|bat|ps1|ftl|jsp)(?![\w])`, 'g');

/**
 * 一行里像文件路径的词：带扩展名的文件名，或者 src/… 这类源码路径。URL、纯数字（3/7）、WHEN/THEN 这类不算。
 * 前端的 @/views/x.vue 按 src/views/x.vue 算；以 / 开头的源码路径（/src/views/x.vue）也认，/api/v2/orders 这种接口地址不算
 */
function pathTokens(line) {
  const s = String(line || '').replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/(^|[\s(（'"“:：])@\//g, '$1src/').replace(/[<>{}$*`]/g, ' ');
  const out = [];
  const re = new RegExp(PATH_LIKE.source, 'g');
  let m;
  while ((m = re.exec(s))) {
    const t = m[0].replace(/[.,;:，。；：)]+$/, '');
    if (!/[A-Za-z一-龥]/.test(t)) continue;
    const slash = /[\\/]/.test(t);
    if (s[m.index - 1] === '/' && !(slash && CODE_EXT.test(t) && SRC_ROOTS.test(t))) continue;
    if (slash ? (CODE_EXT.test(t.replace(/[\\/]+$/, '')) || SRC_ROOTS.test(t) || /^[A-Za-z]:/.test(t)) : CODE_EXT.test(t)) out.push(t);
  }
  return out;
}

const WALK_SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'out', 'logs', '.vibe', '.idea']);

/** 在 root 下找叫 name 的文件：不限深度（最多 30 层），每个根目录单独一份预算。返回 'found' | 'none' | 'unknown'（预算用完了还没找到） */
function findFile(root, name, depth, budget) {
  let es = [];
  try { es = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return 'none'; }
  const want = name.toLowerCase();
  for (const e of es) {
    if (budget.n-- <= 0) return 'unknown';
    if (e.isFile() && e.name.toLowerCase() === want) return 'found';
  }
  if (depth <= 0) return 'none';
  let res = 'none';
  for (const e of es) {
    if (!e.isDirectory() || WALK_SKIP.has(e.name) || e.name[0] === '.') continue;
    const r = findFile(path.join(root, e.name), name, depth - 1, budget);
    if (r === 'found') return 'found';
    if (r === 'unknown') res = 'unknown';
    if (budget.n <= 0) return 'unknown';
  }
  return res;
}

/**
 * 这几个根目录（壳子根、各子项目、当前目录）底下所有文件的文件名（小写）：同一次检查只建一次（按传进来的 roots 数组记，
 * 每次调用的数组是新的，HTTP 方式下不会拿到上一次的）。git 仓库用 git ls-files（已跟踪 + 没忽略的新文件），很快；
 * 不是仓库的目录才走一遍（有预算和 3 秒时限），走到里面的子仓库也改用 ls-files，不重复走。建不全的 complete = false
 */
const INDEX_CACHE = new WeakMap();

function nameIndex(roots) {
  if (INDEX_CACHE.has(roots)) return INDEX_CACHE.get(roots);
  const names = new Set();
  let complete = true;
  const deadline = Date.now() + 3000;
  const done = new Set();
  const lsFiles = (r) => {
    try {
      for (const args of [['ls-files', '-z'], ['ls-files', '-o', '--exclude-standard', '-z']]) {
        const out = execFileSync('git', ['--no-optional-locks', '-C', r].concat(args), { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const f of out.split('\0')) if (f) names.add(f.split('/').pop().toLowerCase());
      }
      return true;
    } catch (e) { return false; }
  };
  let budget = 20000;
  const walk = (d, depth) => {
    if (budget <= 0 || Date.now() > deadline) { complete = false; return; }
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (--budget <= 0) { complete = false; return; }
      if (e.isFile()) { names.add(e.name.toLowerCase()); continue; }
      if (!e.isDirectory() || WALK_SKIP.has(e.name) || e.name[0] === '.' || depth <= 0) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, '.git'))) { const k = normKey(sub); if (!done.has(k)) { done.add(k); if (!lsFiles(sub)) walk(sub, depth - 1); } continue; }
      walk(sub, depth - 1);
    }
  };
  for (const r0 of roots) {
    const r = path.resolve(r0);
    const k = normKey(r);
    if (done.has(k)) continue;
    done.add(k);
    if (fs.existsSync(path.join(r, '.git')) && lsFiles(r)) {
      // 仓库里套着的子仓库（壳子），ls-files 看不到：一层层找出来单独 ls-files
      for (const sub of nestedRepos(r)) { const ks = normKey(sub); if (!done.has(ks)) { done.add(ks); if (!lsFiles(sub)) walk(sub, 30); } }
      continue;
    }
    walk(r, 30);
  }
  // .vibe 里的文件（场景、放哪还没定的产出 pending、临时脚本）不进 git，上面都看不到：每个根目录的 .vibe 单独走一遍（小预算）
  let vibeBudget = 3000;
  const walkVibe = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (--vibeBudget <= 0) return;
      if (e.isFile()) names.add(e.name.toLowerCase());
      else if (e.isDirectory() && depth > 0 && e.name !== 'node_modules') walkVibe(path.join(d, e.name), depth - 1);
    }
  };
  const vibeDirs = new Map();
  for (const r0 of roots) {
    const r = path.resolve(r0);
    vibeDirs.set(normKey(r), path.join(r, '.vibe'));
    try { if (fs.existsSync(path.join(r, '.git'))) for (const sub of nestedRepos(r)) vibeDirs.set(normKey(sub), path.join(sub, '.vibe')); } catch (e) { /* 找不了子项目就只看根目录的 */ }
  }
  for (const d of vibeDirs.values()) walkVibe(d, 5);
  const idx = { names, complete };
  INDEX_CACHE.set(roots, idx);
  return idx;
}

/**
 * 路径在这几个根目录（壳子根、各子项目、当前目录）之下存在吗；只有文件名的就查文件名索引。
 * 找不全（项目太大、超时）的当成存在：宁可漏拦也不误拦
 */
function pathExists(token, roots) {
  const t = String(token).replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:/.test(t)) return fs.existsSync(t);
  if (/[\\/]/.test(t)) return roots.some((r) => fs.existsSync(path.join(r, t)));
  const idx = nameIndex(roots);
  return idx.names.has(t.toLowerCase()) || !idx.complete;
}

/** 一节的内容行（从标题到下一个同级或更高级标题） */
function sectionOf(text, headingRe) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const l of lines) {
    if (/^#{1,3}\s/.test(l)) { if (inside) break; inside = headingRe.test(l); continue; }
    if (inside) out.push(l);
  }
  return out;
}

/** 只看这次新加、改过的行：老内容不追究；打勾不算改。返回 isAdded(行号从 0) */
const normTicks = (t) => String(t || '').replace(/^(\s*[-*]\s*)\[[xX]\]/gm, '$1[ ]');

function addedLines(oldText, newText) {
  const pool = new Map();
  for (const l of normTicks(oldText).split(/\r?\n/)) pool.set(l, (pool.get(l) || 0) + 1);
  const added = new Set();
  normTicks(newText).split(/\r?\n/).forEach((l, i) => { const n = pool.get(l) || 0; if (n > 0) pool.set(l, n - 1); else added.add(i); });
  return (i) => added.has(i);
}

const VAGUE_TASK = /^(联调|完善|优化|收尾|善后|补充|调整|其他|其它|测试|自测|验证|检查|确认|沟通|对接|处理|整理|清理|重构|修改|更新|实现|开发|编码|写代码|完成|部署|上线)(相关)?(细节|逻辑|功能|代码|问题|一下|工作|页面|接口)?$/;

/**
 * tasks.md：每项任务要写清改哪个文件、做什么；不许"联调、完善"这种。
 * 用户 2026-10-17 定的：任务清单只放实现任务，不写"验：<命令>"；测试、审查、验收不写成任务，写进 design.md 的"验收用例"一节。
 * 只查新写的行：已经写了这些任务的老变更照常打勾、走完
 */
const NOT_A_TASK = ['review', 'review-fix', 'user', 'prepare', 'test'];

function checkTasks(text, isAdded) {
  const issues = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    const m = l.match(/^\s*[-*]\s*\[[ xX]\]\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(.+)$/);
    if (!m) return;
    const body = m[1].trim();
    const n = i + 1;
    if (NOT_A_TASK.includes(require('./task-types').kind(l))) { issues.push('第 ' + n + ' 行"' + body.slice(0, 40) + '"是测试、审查或验收，不写进任务清单：测试和验收写进 design.md 的"验收用例"一节（' + CASE_EXAMPLE + '），审查进度套件自己记。任务清单只写要做的实现'); return; }
    if (VAGUE_TASK.test(body.replace(/[\s，,。.：:；;、]/g, ''))) issues.push('第 ' + n + ' 行"' + body.slice(0, 40) + '"太笼统：写清楚改哪个文件、做什么');
    if (!pathTokens(body).length) issues.push('第 ' + n + ' 行没写改哪个文件（路径或文件名）："' + body.slice(0, 50) + '"');
  });
  return issues;
}

const CASE_EXAMPLE = '一条一行，例：| AC-1 | 查询订单：没有订单 | 测试库里用户 1 没有订单 | 调 GET /orders?uid=1 | 返回 []，状态码 200 | Claude：curl http://localhost:8080/orders?uid=1 | 1 |';

/**
 * 规格：每条 Requirement 至少一个四井号的 Scenario，场景里要有 WHEN 和 THEN；需求要放在 OpenSpec 认得的增量标题下面
 * （## ADDED / MODIFIED / REMOVED / RENAMED Requirements），不然归档时它认不出来，报 no deltas found（问题反馈 F20260929-014）
 */
const DELTA_HEAD = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;

function checkSpec(text, isAdded) {
  const issues = [];
  const lines = String(text || '').split(/\r?\n/);
  let req = null;
  let section = '';
  let loose = 0;
  lines.forEach((l, i) => {
    if (/^##\s/.test(l)) { section = DELTA_HEAD.test(l.trim()) ? 'delta' : 'other'; return; }
    if (/^###\s+Requirement:/i.test(l) && section !== 'delta' && (!isAdded || isAdded(i)) && !loose) loose = i + 1;
  });
  if (loose) issues.push('第 ' + loose + ' 行的需求没放在增量标题下面：变更里的规格是增量，需求要写在 "## ADDED Requirements"（新加的）、"## MODIFIED Requirements"（改现有的，整条需求连场景重写一遍）、"## REMOVED Requirements"（删掉的）下面，标题照这个英文写。不然归档时 OpenSpec 认不出来（no deltas found），主规格不会更新');
  const flush = () => { if (req && req.added && req.scenarios === 0) issues.push('第 ' + req.line + ' 行的需求"' + req.name + '"没有场景：下面至少要有一个 #### Scenario:，带 WHEN / THEN'); req = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mine = !isAdded || isAdded(i);
    const r = l.match(/^###\s+Requirement:\s*(.+)$/i);
    if (r) { flush(); req = { name: r[1].trim(), line: i + 1, scenarios: 0, added: mine }; continue; }
    if (/^##\s/.test(l)) { flush(); continue; }
    if (/^###\s+Scenario:/i.test(l) && mine) issues.push('第 ' + (i + 1) + ' 行：Scenario 要用四个井号（####），三个井号 openspec 不认');
    const sc = l.match(/^####\s+Scenario:\s*(.*)$/i);
    if (!sc) continue;
    if (req) req.scenarios++;
    if (!mine) continue;
    let hasWhen = false, hasThen = false;
    for (let k = i + 1; k < lines.length && !/^#{2,4}\s/.test(lines[k]); k++) { if (/\bWHEN\b/i.test(lines[k])) hasWhen = true; if (/\bTHEN\b/i.test(lines[k])) hasThen = true; }
    if (!hasWhen || !hasThen) issues.push('第 ' + (i + 1) + ' 行的场景"' + sc[1].trim() + '"缺 ' + [!hasWhen ? 'WHEN' : '', !hasThen ? 'THEN' : ''].filter(Boolean).join(' 和 '));
  }
  flush();
  return issues;
}

// 这一行是在说"要新建文件"。"编写、产出"这类说法也算：弱一些的模型被拦下之后常常换个词重写，却不写"新建"两个字
const NEW_FILE = /(新建|新增|新写|新加|创建|生成|编写|撰写|起草|产出|落盘|建立|新文件|待建|new\s+file|create)/i;

const tokenKey = (t) => String(t || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

/**
 * 这个变更里声明过要新建的路径：同一个变更的产物（proposal、design、tasks、specs）里说过一次"新建 x"就够了，
 * 别处再提到 x（写全路径或者只写文件名）不用每一行都写"新建"。extraText 是这次正要写进去的内容。返回判断函数
 */
function declaredNew(changeDir, extraText) {
  const set = new Set();
  const add = (text) => {
    for (const l of String(text || '').split(/\r?\n/)) {
      if (!NEW_FILE.test(l)) continue;
      for (const t of pathTokens(l)) { const k = tokenKey(t); if (k) { set.add(k); set.add(k.split('/').pop()); } }
    }
  };
  add(extraText);
  if (changeDir) for (const f of artifactFiles(changeDir)) { if (/(^|[\\/])revisions\.md$/i.test(f)) continue; try { add(fs.readFileSync(f, 'utf8')); } catch (e) { /* 读不了就不算 */ } }
  return (token) => { const k = tokenKey(token); return set.has(k) || set.has(k.split('/').pop()); };
}

/** 一行里提到、又找不到的路径合成一句话（同一行好几个文件不再各说一遍） */
function missingPathIssue(lineNo, tokens) {
  return '第 ' + lineNo + ' 行提到的 ' + tokens.join('、') + ' 在项目里找不到。是这次要新建的：在这一行里写上"新建"两个字（例：新建 ' + tokens[0] + '）；是项目里已有的：写全相对路径（从项目根目录算），读过的才能写';
}

/** 设计：提到的路径要真实存在（新建的写明"新建"，或者这个变更里别处声明过新建）；新写的设计 Context（现状）一节不能空 */
function checkDesign(text, isAdded, roots, isNew, isDeclared) {
  const issues = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => {
    if (isAdded && !isAdded(i)) return;
    if (NEW_FILE.test(l)) return;
    const missing = [...new Set(pathTokens(l).filter((t) => !(isDeclared && isDeclared(t)) && !pathExists(t, roots)))];
    if (missing.length) issues.push(missingPathIssue(i + 1, missing));
  });
  if (isNew) {
    const ctx = sectionOf(text, /^##\s*(Context|背景|现状)/i).filter((l) => l.trim() && !/^\s*<!--/.test(l));
    if (ctx.length < 2) issues.push('Context（现状）一节太空：列出探索时读过的文件、表、接口和发现，这是设计的依据');
    // 验收用例写在设计里（用户 2026-10-17 定的）：需求和设计阶段写完给用户看，Claude 自测、用户验收都照它做。只查新写的设计，老变更不追究
    // 到下一个二级标题为止：一条用例一个"### AC-1"小标题的写法也认
    const cases = []; let inCases = false;
    for (const l of String(text || '').split(/\r?\n/)) { if (/^#{1,2}\s/.test(l)) { if (inCases) break; inCases = /^##\s*验收用例/.test(l); continue; } if (inCases) cases.push(l); }
    const tableRows = cases.filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
    const count = Math.max(0, tableRows - 1) + cases.filter((l) => /^\s*[-*]\s+\S/.test(l) || /^###\s+\S/.test(l)).length;
    if (count < 1 || !/预期/.test(cases.join('\n'))) issues.push('缺"## 验收用例"一节，或者一条用例都没有、没写预期。每条写：对应的场景、前置数据和环境、步骤、预期、谁来测（Claude 自动跑的写清命令、接口或页面场景；要人看的写"人工"）、对应第几组任务。表头：| 编号 | 对应场景 | 前置数据和环境 | 步骤 | 预期 | 谁来测 | 任务组 |，' + CASE_EXAMPLE);
  }
  return issues;
}

/** 模板里的占位注释还留着 */
function leftoverPlaceholders(text, isAdded) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l, i) => { if ((!isAdded || isAdded(i)) && /<!--/.test(l)) out.push(i + 1); });
  return out;
}

/** 提案里列的能力（New / Modified Capabilities 下的 `名字`） */
function proposalCapabilities(text) {
  const out = [];
  let inside = false;
  for (const l of String(text || '').split(/\r?\n/)) {
    if (/^##\s/.test(l)) { inside = /^##\s*Capabilities/i.test(l); continue; }
    if (!inside) continue;
    const m = l.match(/^\s*[-*]\s*`([^`<>]+)`/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** 一个变更目录下的所有产物文件 */
function artifactFiles(changeDir) {
  const out = [];
  for (const n of ['proposal.md', 'design.md', 'tasks.md', 'revisions.md']) { const f = path.join(changeDir, n); if (fs.existsSync(f)) out.push(f); }
  const walk = (d, depth) => { if (depth > 3) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (/\.md$/i.test(e.name)) out.push(p); } };
  walk(path.join(changeDir, 'specs'), 0);
  return out;
}

/**
 * 像验证的命令：构建、编译、测试、脚本这些工具出现在"命令的位置"上，或者跑了 .vibe/ 里的脚本。
 * 只看命令位置，是为了不把 git diff src/main/java/… 里的 java 当成跑过 java。
 * 命令前面可以有：临时环境变量（JAVA_HOME="…" mvn，选 JDK 的惯用写法）、PowerShell 的调用符 &、cmd /c、timeout N、env、call 这类包装，以及带引号的路径。
 */
const VERIFY_TOOLS = 'mvn|mvnw|gradle|gradlew|javac|java|npm|pnpm|yarn|npx|node|vue-tsc|tsc|eslint|pytest|python3?|py|go|dotnet|curl|make|ant|openspec';

const VERIFY_ASSIGN = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+`;

const VERIFY_WRAP = String.raw`(?:cmd(?:\.exe)?\s+\/c\s+"?|timeout\s+\S+\s+|time\s+|env\s+|call\s+|winpty\s+|&\s*)`;

const VERIFY_RE = new RegExp(
  String.raw`(?:^|&&|\|\||[;|(\n])\s*(?:(?:${VERIFY_ASSIGN}|${VERIFY_WRAP})\s*)*(?:"[^"\n]*[\\/]|[^\s"]*[\\/])?(?:${VERIFY_TOOLS})(?:\.cmd|\.bat|\.exe|\.sh)?"?(?:\s|$)`
  + '|' + String.raw`\.vibe[\\/]\S*\.(?:bat|cmd|sh|ps1|js)`, 'i');

// 不算验证的：openspec 自己的命令（status、list、show…）、套件自己的工具（devserver、feedback…）。看页面的 scenario-run 算
const NOT_VERIFY_SEG = /^\s*(?:openspec(?:\.cmd)?\s|openspec$|node(?:\.exe)?\s+["']?[^"'\s]*vibe-kit[\\/]+(?:tools|lib|hooks)[\\/])/i;

/** 这条命令算不算跑过验证：去掉 openspec、套件自己的工具那几段，剩下的里有构建、编译、测试、脚本 */
const VERIFY_CMD = {
  test(cmd) {
    const rest = String(cmd || '').split(/&&|\|\||[;\n]/).filter((s) => !NOT_VERIFY_SEG.test(s)).join('\n');
    return VERIFY_RE.test(rest);
  },
};

/** 任务行：- [ ] 1.2 做什么；按任务编号认（行尾加了"（已完成）"也认得），没有编号的按去掉行尾括号后的文字认 */
const TASK_LINE = /^(\s*[-*]\s*)\[([ xX])\]\s*(.*)$/;

function taskKey(body) {
  const m = String(body).match(/^(\d+(?:\.\d+)*)[.)、]?(?=\s|$)/);
  if (m) return 'id:' + m[1];
  return 'tx:' + String(body).replace(/\s*[（(][^（）()]*[）)]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 这次编辑把哪些任务从 [ ] 打成了 [x]：返回打勾后的那些行 */
function tickedLines(oldText, newText) {
  const wasOpen = new Set();
  for (const l of String(oldText || '').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] === ' ') wasOpen.add(taskKey(m[3].trim())); }
  const out = [];
  for (const l of String(newText || '').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] !== ' ' && wasOpen.has(taskKey(m[3].trim()))) out.push(m[3].trim()); }
  return out;
}

/** 任务行里写的验法（"验：…"），没有返回 '' */
function verifyPartOf(taskLine) {
  const m = String(taskLine || '').match(/(?:验|验证|验收|检验|核对)\s*[:：]\s*(.+)$/);
  return m ? m[1].trim() : '';
}

/**
 * 验法写的是"同 3.1 命令 PASS""见 2.1""同上"：指的是另一项任务的验法，换成那一项写的（议题 #4：照字面查，
 * 只能认成"跑过任何一条验证命令"，模型不知道到底要它跑哪条）。tasksText 是 tasks.md 的全文。
 * 返回 { text: 要查的验法, ref: 指向的任务编号（没有指向别的任务就是 ''）}；指向的那一项找不到、没写验法的，照原样查。
 * 自己已经写明了命令的不换
 */
const VERIFY_REF = /(?:^|[\s，,；;（(])(?:同|见|参见|参照|沿用|复用|按|与|和)\s*(?:任务|第)?\s*(\d+(?:\.\d+)+)/;

const VERIFY_ABOVE = /^\s*(?:同上|同前|同上一项|同上一条|同上条)/;

function resolveVerify(taskLine, tasksText) {
  const own = verifyPartOf(taskLine);
  const lines = String(tasksText || '').split(/\r?\n/).map((l) => l.match(TASK_LINE)).filter(Boolean).map((m) => m[3].trim());
  let text = own;
  let ref = '';
  let cur = taskKey(String(taskLine || '').trim());
  for (let depth = 0; depth < 4; depth++) {
    // 自己写明了命令的（反引号里一条带空格的命令）照自己的查：后面顺带提一句"环境同 3.1"不算指向别的任务
    if (/`[^`\n]*\S\s+\S[^`\n]*`/.test(text)) break;
    const m = text.match(VERIFY_REF);
    const above = !m && VERIFY_ABOVE.test(text);
    if (!m && !above) break;
    const at = lines.findIndex((b) => taskKey(b) === cur);
    const hit = m ? lines.find((b) => taskKey(b) === 'id:' + m[1]) : (at > 0 ? lines[at - 1] : '');
    const v = hit ? verifyPartOf(hit) : '';
    if (!hit || !v || taskKey(hit) === cur) break;
    ref = (taskKey(hit).match(/^id:(.+)$/) || [])[1] || '上一项';
    text = v;
    cur = taskKey(hit);
  }
  return { text, ref };
}

/**
 * 这条验法跑过了吗：在这些命令里找。/ttls-see-page 的场景要跑过 scenario-run 且带场景名；其他的看验法里提到的工具（mvn、node、curl…）有没有出现在命令里。
 * 验法写成一句话（"按项目说明的快检"）、没提到任何工具的：跑过任何像验证的命令就算。写的是"人工…""用户…"的不查（那是要人看的），返回 true。
 */
// 验法里提到的工具：路径、文件名里的不算（src/main/java/…、OrderService.java 里的 java）
const TOOL_WORDS = /(?<![\\/.\w-])(mvn|mvnw|gradle|gradlew|javac|java|npm|pnpm|yarn|npx|node|vue-tsc|tsc|eslint|pytest|python3?|py|go|dotnet|curl|make|ant|openspec)(?![\\/.\w-])/ig;

/** 这些工具有没有出现在命令的位置上（不是出现在参数、文件名里：Copy-Item 里的 py、Constant.java 里的 ant 都不算） */
function toolAtCommandPos(cmd, tools) {
  const alt = tools.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
  const re = new RegExp(String.raw`(?:^|&&|\|\||[;|(\n])\s*(?:(?:${VERIFY_ASSIGN}|${VERIFY_WRAP})\s*)*(?:"[^"\n]*[\\/]|[^\s"]*[\\/])?(?:${alt})(?:\.cmd|\.bat|\.exe|\.sh)?"?(?:\s|$)`, 'i');
  return re.test(cmd);
}

// 验法里写明要跑的脚本、场景文件（带不带路径都算）
const FILE_IN_CMD = /[^\s"'`，。；、（）()=]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py|json)(?![\w.])/ig;

// 跑出来的结果文件（.vibe/out/…/result.json、out/report.json）：那是验证的产物，不是要跑的东西。验法里提到它是在说"结果看这里"，
// 不能要求命令里出现它——脚本自己往那里写，命令行上没有这个名字，跑了几十遍也打不上勾（议题 #3）
const OUTPUT_JSON = /(?:^|[\\/])(?:out|output|outputs|results?|reports?)[\\/][^\s]*\.json$|(?:^|[\\/])(?:result|results|report|output|summary)(?:[-_.][\w-]+)?\.json$/i;

const isOutputJson = (p) => OUTPUT_JSON.test(String(p || '').replace(/["'`]/g, ''));

// 没加反引号、但前面带着"用什么跑"的脚本：node x.js、bash x.sh、./x.sh
const RUN_SCRIPT = /(?:^|[\s"'(（])(?:(?:node|bash|sh|python3?|py|powershell|pwsh|call)\s+|\.[\\/])"?([^\s"'`，。；、（）()]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py))(?![\w.])/ig;

// .vibe 里的脚本（探针、自己包的验证脚本）。结尾要卡住：checklist.json 不能认成 checklist.js（问题反馈 F20260929-015）
const VIBE_SCRIPT = /\.vibe[\\/][^\s"'`，。；、（）()]+\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)(?![\w.])/ig;

const SCRIPT_NAME = /\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)$/i;

// 这一句说的是"不做"：这一句里写的东西不查，打勾时记下来（全自动模式写进报告）
const SKIP_CLAUSE = /(不做|不跑|不验|不测|不执行|不用跑|不用验|不用做|跳过|不适用|无需|不需要|不涉及|做不了|跑不了|验不了|没法验|无法验|留给用户|等用户|待用户|需用户|要用户)/;

const HUMAN_CLAUSE = /^\s*(人工|用户|你|我)/;

// 不带 ttls- 前缀的 see-page 也认：改名之前写的 tasks.md 里，验法写的是旧名字
const SCENE_WORD = /(?:ttls-)?see-page|scenario-run|场景/i;

// 只说了"场景"、没说哪一个：这些都算真去验了——场景执行器、.vibe 里的脚本、探针、直接调接口
const SCENE_LIKE = /scenario-run|\.vibe[\\/]\S*\.(?:bat|cmd|sh|ps1|js|mjs|cjs|py)\b|playwright|(?:^|[\s;&|(])curl(?:\.exe)?\s/i;

/**
 * 这条验法要看到什么才算跑过：返回 { need: 给模型看的一句（要看到什么）, skipped: 验法里明说不做的那几句, test(跑过的命令) }。
 * 验法按 ；。，和换行 分成几句，一句一句看（反引号里的命令、括号里的说明不拆）：
 *   写的是"人工…""用户…"的：要人看，不查。
 *   说了"不做、跳过、不适用、等用户"的（括号里说的也算）：这一句里写的东西不查，记在 skipped 里。
 *   写明了的（必须都跑过）：反引号里的命令（里面的脚本、场景文件都在跑过的命令里出现，或者里面的工具出现在命令的位置上）；
 *     反引号里单独一个脚本名；"node x.js"".vibe/x.bat"这种脚本；写了 xxx.json 的场景、或者叫得出名字而且真有这个场景文件的。
 *     反引号里单独一个 .json 只有是场景文件（路径里带 scenario、前面说了"场景"）才算；.vibe/login.json 这种数据文件、接口地址、类名不算。
 *   没写明的（没有写明的那种时，跑过其中一样就行）：只说了 /ttls-see-page、场景（场景执行器、.vibe 里的脚本、探针、curl 都算）；
 *     提到的工具（mvn、javac、node…）出现在命令的位置上。
 *   什么都认不出来（"按项目说明的快检"）：跑过任何像验证的命令就算。
 * opts.scenarioExists(名字)：项目里有没有叫这个名字的场景文件。"场景 admin 打开用户管理页"里的 admin 是账号不是场景名，
 * 以前拿"场景"后面那个词当场景名去对，跑过了也打不上勾（问题反馈 F20260928-010）
 */
function verifyPlan(verifyText, opts) {
  const v = String(verifyText || '').trim();
  const o = opts || {};
  if (HUMAN_CLAUSE.test(v)) return { need: '', skipped: [], test: () => true };
  const low = (x) => String(x).replace(/\\/g, '/').toLowerCase();
  const names = (x) => [...new Set((String(x).match(FILE_IN_CMD) || []).filter((t) => !isOutputJson(t)).map((t) => path.basename(low(t))))];
  const hasAll = (list) => (cs) => list.every((n) => cs.some((c) => low(c).includes(n)));
  // 反引号里的、括号里的先拿出来，换成记号，再分句
  const quoted = [];
  const notes = [];
  let masked = v.replace(/`([^`\n]+)`/g, (m, q) => { quoted.push(q.trim()); return '\u0001' + (quoted.length - 1) + '\u0002'; });
  masked = masked.replace(/（[^（）]*）|\([^()]*\)/g, (m) => { notes.push(m); return '\u0003' + (notes.length - 1) + '\u0004'; });
  const strong = [];
  const weak = [];
  const skipped = [];
  let human = 0;
  for (const part of masked.split(/[；;。，,\n]/)) {
    if (!part.trim()) continue;
    const own = part.replace(/\u0003\d+\u0004/g, ' ');
    const plain = own.replace(/\u0001\d+\u0002/g, ' ');
    const note = (part.match(/\u0003(\d+)\u0004/g) || []).map((x) => notes[Number(x.slice(1, -1))]).join(' ').replace(/\u0001(\d+)\u0002/g, (m, i) => quoted[Number(i)]);
    const mine = (own.match(/\u0001(\d+)\u0002/g) || []).map((x) => quoted[Number(x.slice(1, -1))]);
    const text = own.replace(/\u0001(\d+)\u0002/g, (m, i) => '`' + quoted[Number(i)] + '`').trim();
    if (HUMAN_CLAUSE.test(plain)) { human++; continue; }
    if (SKIP_CLAUSE.test(plain) || SKIP_CLAUSE.test(note)) { skipped.push((text + note).slice(0, 80)); continue; }
    const before = strong.length;
    for (const q of mine) {
      if (!/\s/.test(q)) {
        // 单独一个词：脚本名要跑过；.json 是场景文件才要跑过；别的（类名、接口地址、数据文件）不是命令
        const base = path.basename(low(q));
        if (SCRIPT_NAME.test(base)) { if (!/^scenario-run\./.test(base)) strong.push({ show: '`' + q + '`', test: hasAll([base]) }); continue; }
        if (/\.json$/i.test(base) && !isOutputJson(q) && (/scenario/i.test(low(q)) || SCENE_WORD.test(plain) || (o.scenarioExists && o.scenarioExists(base.replace(/\.json$/i, ''))))) strong.push({ show: '场景 ' + base, test: hasAll([base]) });
        continue;
      }
      const files = names(q);
      if (files.length) { strong.push({ show: '`' + q + '`', test: hasAll(files) }); continue; }
      const tools = [...new Set((q.match(TOOL_WORDS) || []).map((t) => t.toLowerCase()))].filter((t) => toolAtCommandPos(q, [t]));
      if (tools.length) strong.push({ show: '`' + q + '`', test: (cs) => cs.some((c) => toolAtCommandPos(c, tools)) });
    }
    const scripts = [];
    let m;
    const re = new RegExp(RUN_SCRIPT.source, 'ig');
    while ((m = re.exec(plain))) scripts.push(path.basename(low(m[1])));
    for (const x of plain.match(VIBE_SCRIPT) || []) scripts.push(path.basename(low(x)));
    const own2 = [...new Set(scripts)].filter((n) => !/^scenario-run\./.test(n));
    if (own2.length) strong.push({ show: '脚本 ' + own2.join('、'), test: hasAll(own2) });
    if (strong.length > before) continue;
    if (SCENE_WORD.test(plain)) {
      const byFile = ((plain.match(/[^\s"'`，。；、（）()=]*\.json(?![\w.])/g) || []).filter((t) => !isOutputJson(t)).map((t) => (t.match(/([\w.\-]+)\.json$/) || [])[1] || '').filter(Boolean))[0] || '';
      const byWord = (plain.match(/场景\s*[:：]?\s*([\w.\-]+)/) || [])[1] || '';
      const name = byFile || (byWord && o.scenarioExists && o.scenarioExists(byWord.replace(/\.json$/i, '')) ? byWord : '');
      if (name) strong.push({ show: '场景 ' + name, test: (cs) => cs.some((c) => low(c).includes(name.toLowerCase())) });
      else weak.push({ show: '/ttls-see-page 的场景（scenario-run.js），或者 .vibe 里你自己的验证脚本、探针', test: (cs) => cs.some((c) => SCENE_LIKE.test(c)), scene: true });
      continue;
    }
    // 技能工程的快检（tools/skills-check.js）
    if (/skills-check/i.test(plain)) { strong.push({ show: 'skills-check.js', test: (cs) => cs.some((c) => /skills-check/i.test(c)) }); continue; }
    const tools = [...new Set((plain.match(TOOL_WORDS) || []).map((t) => t.toLowerCase()))];
    if (tools.length) weak.push({ show: tools.join(' 或 ') + ' 的命令', test: (cs) => cs.some((c) => toolAtCommandPos(c, tools)) });
  }
  if (strong.length) return { need: '跑过 ' + strong.map((w) => w.show).join('、'), skipped, test: (cs) => strong.every((w) => w.test(cs)) };
  if (weak.length) {
    const hint = weak.some((w) => w.scene) ? '；验法其实是你自己包的脚本的，把那条命令用反引号写进验法里' : '';
    return { need: '跑过 ' + weak.map((w) => w.show).join('，或者 ') + hint, skipped, test: (cs) => weak.some((w) => w.test(cs)) };
  }
  // 整条验法都是"人工看""不做"：没有要查的
  if (human || skipped.length) return { need: '', skipped, test: () => true };
  return { need: '跑过任何一条验证命令（编译、测试、快检脚本、场景）', skipped, test: (cs) => cs.some((c) => VERIFY_CMD.test(c)) };
}

function verifyRan(verifyText, commands, opts) { return verifyPlan(verifyText, opts).test(commands || []); }

/**
 * 交接记录过期了：写完它之后，有变更归档了、或者有变更的任务全部打勾了——说明那件事后来做完了（比如全自动模式挂了一夜），
 * 第二天照它"下一步"接着做会重做。返回过期原因，没过期返回 null。
 */
/** 交接记录里提到了这个变更名吗（整词：add-order 不算提到了 add-order-v2） */
function mentionsChange(text, name) {
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\w-])' + esc + '($|[^\\w-])').test(String(text || ''));
}

/**
 * 只看交接记录里提到的变更：别人的变更被 git pull 下来归档了，不算这份交接过期。交接记录里一个变更名都没提的，判断不了，当没过期。
 */
function handoverStale(file, dir) {
  try {
    const m = fs.statSync(file).mtimeMs;
    const text = readTextFileRaw(file);
    for (const changes of changeRoots(dir)) {
      const arch = path.join(changes, 'archive');
      let names = [];
      try { names = fs.readdirSync(arch); } catch (e) { continue; }
      for (const n of names.sort().reverse()) {
        let t = 0; try { t = fs.statSync(path.join(arch, n)).mtimeMs; } catch (e) { continue; }
        const name = n.replace(/^\d{4}-\d{2}-\d{2}-/, '');
        if (t > m && mentionsChange(text, name)) return '变更 ' + name + ' 已归档';
      }
    }
    for (const c of listChanges(dir)) if (c.todo === 0 && c.done > 0 && c.mtime > m && mentionsChange(text, c.name)) return '变更 ' + c.name + ' 的任务已全部完成';
  } catch (e) { /* 读不了就当没过期 */ }
  return null;
}

function readTextFileRaw(f) { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; } catch (e) { return ''; } }

module.exports = { HEDGE_WORDS, hedgeHit, findHedges, artifactOf, STAGE, pathTokens, pathExists, sectionOf, normTicks, addedLines, checkTasks, checkSpec, NEW_FILE, declaredNew, missingPathIssue, checkDesign, leftoverPlaceholders, proposalCapabilities, artifactFiles, VERIFY_CMD, TASK_LINE, taskKey, tickedLines, verifyPartOf, resolveVerify, toolAtCommandPos, verifyPlan, verifyRan, mentionsChange, handoverStale, readTextFileRaw };

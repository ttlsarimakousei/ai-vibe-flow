'use strict';
/*
 * 审查记录：登记、代码审过没有、本会话碰过的变更、交接文件读写。审查结论由 review-runner.js 入账（子代理交，SubagentStop），不再认会话记录里的结论行。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const { nestedRepos, changeBorn } = require('./session-projects');
const { textOf, isUserTurn, toolCalls, READ_CMD } = require('./session-transcript');
const { readState, updateState, normKey } = require('./session-state');
const { pathTokens, TASK_LINE, taskKey } = require('./session-proposal');

/** 读一条审查记录（键做了大小写归一化；兼容老版本直接用原样路径当键、值是时间数字的写法）；同名变更重建过的当没有 */
function reviewRecord(kind, dir) {
  const st = readState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed');
  const key = normKey(dir);
  let rec = st[key];
  if (rec === undefined) for (const k of Object.keys(st)) if (normKey(k) === key) { rec = st[k]; break; }
  if (rec === undefined || rec === null) return null;
  if (typeof rec === 'number') rec = { at: rec, done: true, legacy: true };
  if (rec.born && changeBorn(dir) && Math.abs(rec.born - changeBorn(dir)) > 2000) return null;
  return rec;
}

/**
 * 记一次审查。at 是结论送到的时间（不用记的这一刻：要拿它和任务打勾的时间比）。
 * 同一次审查（记账键一样）只记一次；比已经记着的那次更早的不覆盖（后台审查的结论可能晚到）
 */
function recordReview(kind, dir, issues, reviewKey, at, counted) {
  const key = normKey(dir);
  const born = changeBorn(dir);
  const when = at || Date.now();
  let fresh = false;
  updateState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => {
    const prev = o[key] && typeof o[key] === 'object' ? o[key] : {};
    if (prev.done && prev.born === born && ((reviewKey && prev.key === reviewKey) || (prev.at && when < prev.at))) return o;
    o[key] = Object.assign({}, prev, { done: true, at: when, born, issues, key: reviewKey });
    for (const field of ['id', 'resolved', 'resolvedAt', 'resolvedFingerprint', 'decisions', 'fingerprint', 'proposalHash', 'materialInputs', 'reportFile', 'executor', 'covered', 'partial']) delete o[key][field];
    fresh = true;
    return o;
  });
  // 使用情况：新记上的一次审查（提案、代码，报"问题 0 条"的另数）
  if (fresh && !counted) { try { const U = require('./usage.js'); U.bump('review.' + (kind === 'proposal' ? 'proposal' : 'code')); if (Number(issues) === 0) U.bump('review.clean'); } catch (e) { /* 数不了就算了 */ } }
  return fresh;
}

/** 提案审过了吗 */
function proposalReviewed(dir) { const r = reviewRecord('proposal', dir); return !!(r && r.done && (!r.proposalHash || r.proposalHash === require('./apply-scope').planHash(dir)) && require('./review-runner').inputsCurrent(r.materialInputs)); }

/** 流程能否继续：完整审查，或者每个点都有结果了（子代理连续没交结论停了的不再自动审，这里再拦就卡死，没过的写在报告里） */
function reviewAllowed(kind, dir) { return require('./flow-policy').allDone(dir, kind) || (kind === 'proposal' ? proposalReviewed(dir) : codeReviewed(dir)); }

/**
 * 每项任务是什么时候打的勾（state/task-ticks.json，按变更目录记）。"代码审过了吗"要用：审查之后才打勾的任务，它的代码审到了没有。
 * 每次调用拿 tasks.md 对一遍：打了勾、还没记时间的，记成现在——头一回见到这个变更的记成 0（不知道什么时候打的，当作早就打了）；
 * 勾去掉了的，记录删掉。justTicked 是这次编辑正要打勾的任务（编辑还没落盘，先记上）。返回 { 任务键: 时间 }
 */
function syncTicks(changeDir, justTicked) {
  const k = normKey(changeDir);
  const born = changeBorn(changeDir);
  const now = Date.now();
  const ticked = new Set();
  try { for (const l of fs.readFileSync(path.join(changeDir, 'tasks.md'), 'utf8').split(/\r?\n/)) { const m = l.match(TASK_LINE); if (m && m[2] !== ' ') ticked.add(taskKey(m[3].trim())); } } catch (e) { /* 还没有 tasks.md */ }
  const fresh = new Set((justTicked || []).map((t) => taskKey(String(t).trim())));
  let out = {};
  const prev = readState('task-ticks')[k];
  const same = prev && (!prev.born || !born || Math.abs(prev.born - born) <= 2000);
  const known = same ? (prev.tasks || {}) : {};
  const next = {};
  for (const t of ticked) next[t] = known[t] !== undefined ? known[t] : (same ? now : 0);
  // 正要打勾的：编辑落盘之前先记上；一分钟内记的、盘上还没勾的先留着（编辑可能正在路上）
  for (const t of fresh) if (next[t] === undefined) next[t] = known[t] !== undefined ? known[t] : now;
  for (const t of Object.keys(known)) if (next[t] === undefined && now - known[t] < 60000) next[t] = known[t];
  out = next;
  const changed = !same || Object.keys(next).length !== Object.keys(known).length || Object.keys(next).some((t) => known[t] !== next[t]);
  if (changed) updateState('task-ticks', (st) => { st[k] = { born, tasks: next, at: now }; });
  return out;
}

/** 任务行里写的要改的文件（"验：…"之前的部分），在这几个根目录下找得到的：返回绝对路径。.vibe、openspec 里的不算代码 */
function taskCodeFiles(taskLine, roots) {
  const body = String(taskLine || '').split(/(?:验|验证|验收|检验|核对)\s*[:：]/)[0];
  const out = [];
  for (const t of pathTokens(body)) {
    const p = String(t).replace(/[\\/]+$/, '');
    if (!/[\\/]/.test(p) || /(^|[\\/])(\.vibe|\.claude|openspec)([\\/]|$)/i.test(p)) continue;
    const hits = /^[A-Za-z]:/.test(p) ? [p] : roots.map((r) => path.join(r, p));
    for (const f of hits) { try { if (fs.statSync(f).isFile()) { out.push(f); break; } } catch (e) { /* 不在这个根目录下 */ } }
  }
  return out;
}

/** 变更目录（…/openspec/changes/<名字>）所在的项目根，和它下面的各个子项目 */
function projectRootsOf(changeDir) {
  const root = path.resolve(changeDir, '..', '..', '..');
  let nested = [];
  try { nested = nestedRepos(root); } catch (e) { nested = []; }
  return [root].concat(nested);
}

/**
 * 这次审查没审到的任务：审查之后才打的勾，而且任务行里写的文件在审查之后改过。返回 [{ task, files }]。
 * 审查之后只是补打了勾（代码早就写好了、当时打勾被拦）、或者打勾的是不改代码的任务（执行脚本、改库），审查照样算数——
 * 以前拿 tasks.md 的修改时间比，打个勾、改一句验法，审过的就变成"没审过"（问题反馈 F20260928-014、F20260929-003）
 */
function unreviewedAfter(dir, rec) {
  const at = (rec && rec.at) || 0;
  const ticks = syncTicks(dir);
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8'); } catch (e) { return []; }
  const out = [];
  let roots = null;
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(TASK_LINE);
    if (!m || m[2] === ' ') continue;
    const body = m[3].trim();
    if (['review', 'review-fix', 'user'].includes(require('./task-types').kind(l))) continue;
    if (!((ticks[taskKey(body)] || 0) > at + 1000)) continue;
    roots = roots || projectRootsOf(dir);
    const late = taskCodeFiles(body, roots).filter((f) => { try { return fs.statSync(f).mtimeMs > at + 1000; } catch (e) { return false; } });
    if (late.length) out.push({ task: body.slice(0, 60), files: late });
  }
  return out;
}

/**
 * 代码审过了吗：要有一次真的代码审查，而且审查之后没有再做新的代码任务（见 unreviewedAfter）。老版本留下的记录（只有时间）照认。
 */
function codeReviewed(dir) {
  const r = reviewRecord('code', dir);
  if (!r) return false;
  if (r.fingerprint) return (r.resolvedFingerprint || r.fingerprint) === require('./workspace').fingerprint(dir, 'code').hash;
  if (r.legacy) return true;
  return unreviewedAfter(dir, r).length === 0;
}

/** 归档、催审查时说的话：没审过，还是审过之后又做了任务。审过了返回空串 */
function codeReviewIssue(dir) {
  const P = require('./flow-policy');
  if (P.allPassed(dir, 'code')) return '';
  // 每个审查点都审过了或者停了（第 26 条）：停了的不再挡（复审 V8：以前归档要求全部通过，到上限的点又不能再自动审，两头堵住）；没解决的写在收工报告里，归档本来就要用户点头
  try { const ps = P.points(dir, 'code'); if (ps.length && ps.every((p) => P.settled(dir, p) || P.halted(dir, p))) return ''; } catch (e) { /* 算不了照下面的老规矩 */ }
  const r = reviewRecord('code', dir);
  if (!r) return '还没做过代码审查（/vk-cross-review 的代码模式，前端后端都在内；审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
  if (r.fingerprint && !codeReviewed(dir)) return '代码或任务验法在审查后变更，需要针对变更部分复验和补审；仅打勾不会触发重复审查。';
  if (r.legacy) return '';
  const late = unreviewedAfter(dir, r);
  if (!late.length) return '';
  const rel = (f) => path.basename(f);
  return '代码审查之后又做了 ' + late.length + ' 项任务，这部分代码没审到：' + late.slice(0, 3).map((x) => '"' + x.task.slice(0, 30) + '"（' + x.files.slice(0, 2).map(rel).join('、') + '）').join('；') + '。再按 /vk-cross-review 的代码模式审一遍这几项的改动（审查提示第一行写"模式：代码"，第二行写"变更：' + path.basename(dir) + '"）';
}

/** 会话记录里有没有接着交接记录干：读过 .vibe/handover.md，或者用户说了"接着上一个会话的交接记录继续" */
function handoverReadIn(entries) {
  for (const e of entries) if (isUserTurn(e) && /接着上一个会话的交接记录继续/.test(textOf(e))) return true;
  return toolCalls(entries, 0).some((c) => (c.name === 'Read' && /(^|[\\/])\.vibe[\\/]handover\.md$/i.test(String(c.input.file_path || ''))) || (/^(Bash|PowerShell)$/.test(c.name) && /(?:^|[\s"'\\/])handover\.md/i.test(String(c.input.command || '')) && READ_CMD.test(String(c.input.command || ''))));
}

/** 这一段调用里写过交接记录吗：用户敲了 /vk-handover（改名之前叫 /handover）、用 Skill 调了它、写了 .vibe/handover.md */
function handoverWrittenIn(calls, prompt, failed) {
  if (/<command-name>\s*\/?(?:vk-|ttls-)?handover\s*<\/command-name>/.test(String(prompt || ''))) return true;
  return calls.some((c) => !(failed && failed(c)) && ((c.name === 'Skill' && /^\/?(?:vk-|ttls-)?handover$/i.test(String(c.input.skill || c.input.command || ''))) || (/^(Write|Edit|MultiEdit)$/.test(c.name) && /(^|[\\/])\.vibe[\\/]handover\.md$/i.test(String(c.input.file_path || '')))));
}

module.exports = { reviewRecord, recordReview, proposalReviewed, reviewAllowed, syncTicks, taskCodeFiles, projectRootsOf, unreviewedAfter, codeReviewed, codeReviewIssue, handoverReadIn, handoverWrittenIn };

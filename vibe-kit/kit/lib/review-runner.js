'use strict';
/*
 * 审查脚本（用户 2026-11-03 定的：审查全部用子代理 ttls-reviewer，和主会话同模型）。脚本不发请求，只备材料、算修改点、记账：
 *   prepare：算这一轮审什么（第一轮 2～3 个角度，后面只审修改点），每个角度写一份范围文件，输出每个子代理的提示。输入没变就复用同一个任务，已交的角度不重开。
 *   submit：子代理最后一条回复由 hooks/review-stop.js（SubagentStop）交到这里，角度交齐才合并入账；JSON 不对回 block 让子代理重写，同一角度最多 2 次。
 * 没有次数上限、文件上限，不收敛也不停。只有子代理连续 3 次拿不到结论才不再催，也不算通过（flow-policy.js 的 halted）。
 * 二进制、超 4MB、敏感文件记 uncovered，状态仍是 completed：不然这个点永远过不了。诊断不写材料原文和审查意见。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./session');
const W = require('./workspace');
const R = require('./redact');
const store = require('./state-store');
const Sc = require('./review-scope');
const secretFile = (f) => /(^|[\\/])(secrets\.json|router-data|\.env(?:\.[^/]*)?|db-crud\.ini|redis\.json|login\.json)([\\/]|$)/i.test(f);
function changeOf(cwd, name) { return name ? S.allChanges(cwd).find((c) => c.name.toLowerCase() === String(name).toLowerCase()) : null; }
// 不带变更名的审查按"项目 + 基线"算一次审查（#211：以前只按项目算，前一次不相干的审查把累计预算占掉了，这次一开始就超时）
function jobKey(cwd, name, mode, point, base) { const c = changeOf(cwd, name); const b = !c && base ? '|' + [].concat(base).filter(Boolean).join(',') : ''; return W.hash((c ? S.normKey(c.dir) : W.rootOf(cwd).toLowerCase() + b) + '|' + mode + (point ? '|' + point : '')).slice(0, 24); }
function baseline(j, dirs) {
  const cwd = j.cwd || process.cwd();
  S.updateState('work-baselines', (o) => {
    for (const dir of dirs) {
      const key = S.normKey(dir); if (o[key]) continue;
      const roots = S.projectRootsOf(dir);
      o[key] = { at: Date.now(), session: j.session_id, repos: roots.map((root) => ({ root, ref: W.git(root, ['rev-parse', 'HEAD']).trim(), dirtyFiles: W.git(root, ['status', '--porcelain', '-z']).split('\0').filter(Boolean).map((l) => l.slice(3)) })).filter((r) => r.ref) };
    }
  });
}
/** 设计现状中的路径只是探索依据；明确写“审查材料：”才额外读取，其它章节沿用当前引用。 */
function proposalReferences(rows) {
  const references = new Set(), context = new Set(), required = new Set();
  for (const row of rows) {
    let contextDepth = 0;
    for (const line of row.text.split(/\r?\n/)) {
      const heading = line.match(/^\s*(#{1,6})\s+(.+)/);
      if (heading && row.file === 'design.md') {
        if (contextDepth && heading[1].length <= contextDepth) contextDepth = 0;
        if (/^(?:Context\b|现状|背景)/i.test(heading[2])) contextDepth = heading[1].length;
      }
      const explicit = line.match(/(?:^|\s|[-*])审查材料\s*[:：]\s*(.*)/);
      const selected = explicit ? S.pathTokens(explicit[1]) : [];
      for (const ref of selected) required.add(ref);
      for (const ref of S.pathTokens(line)) {
        // 随提案交付的材料始终检查，不因写在 Context 而漏读。
        if (contextDepth && !selected.includes(ref) && !/^(?:\.\/)?(?:assets|references)\//.test(ref) && !/^openspec\/changes\/[^/]+\/(?:assets|references)\//.test(ref)) context.add(ref);
        else references.add(ref);
      }
    }
  }
  return { references, required, contextOnly: [...context].filter(ref => !references.has(ref)) };
}
function materials(opts, change) {
  const items = [], skipped = [], uncovered = [], excluded = [], bases = [], files = new Set(), inputs = new Map(), currents = new Map(); let contextOnly = [];
  // current：这个文件现在的内容，下一轮拿来比改了什么（代码的 text 还带着基线差异）；role：只用来核对、不审它本身的材料；note：范围文件里给子代理看的一句话
  const add = (file, text, root, source, role, current, note) => {
    if (files.has(file)) return;
    files.add(file);
    const chunks = []; let chunk = '', line = 1, start = 1;
    // 先遮整份文本再切片，避免凭据字面值跨片后漏掉模式匹配。
    for (const row of R.material(text).split(/(?<=\n)/)) {
      if (chunk && chunk.length + row.length > 40000) { chunks.push({ text: chunk, startLine: start }); chunk = ''; start = line; }
      for (let i = 0; i < row.length; i += 40000) { if (i) { chunks.push({ text: chunk, startLine: start }); chunk = ''; start = line; } chunk += row.slice(i, i + 40000); }
      line += (row.match(/\n/g) || []).length;
    }
    if (chunk || !chunks.length) chunks.push({ text: chunk, startLine: start });
    chunks.forEach((c, i) => items.push(Object.assign({ file, root, source: source || path.resolve(root, file), text: c.text, startLine: c.startLine, part: i + 1, parts: chunks.length }, role ? { role } : {})));
    currents.set(file, { text: R.material(current === undefined ? text : current), root, source: source || path.resolve(root, file), role, note });
  };
  const load = (file, root, label, allowMissing) => {
    const skip = (reason) => { uncovered.push({ file: label, reason }); return null; };
    if (secretFile(file)) return skip('敏感配置不进审查材料');
    const checked = W.pathStatus(file, root);
    if (!checked.safe) return skip(checked.reason);
    if (checked.missing) return allowMissing ? { missing: true, text: '' } : skip('材料不可读');
    if (checked.stat.size > 4 * 1024 * 1024) return skip('单文件超过 4MB');
    try {
      const bytes = fs.readFileSync(file); if (bytes.includes(0)) return skip('二进制材料未覆盖');
      const text = new (require('util').TextDecoder)('utf8', { fatal: true }).decode(bytes);
      if (opts.mode === 'proposal' && change && /^(?:assets|references)[\\/]/.test(path.relative(change.dir, file))) inputs.set(S.normKey(file), { file: path.resolve(file), root: path.resolve(root), hash: W.hash(bytes) });
      return { text };
    }
    catch (e) { return skip('材料不可读或不是 UTF-8 文本'); }
  };
  const artifacts = () => {
    const rows = [];
    for (const f of S.artifactFiles(change.dir).filter((f) => !/revisions\.md$/.test(f))) { const label = path.relative(change.dir, f).replace(/\\/g, '/'); const loaded = load(f, change.dir, label); if (loaded) rows.push({ file: label, text: loaded.text }); }
    return rows;
  };
  if (opts.mode === 'proposal') {
    if (!change) throw new Error('提案审查需要有效变更名');
    const rows = artifacts().filter(r => !opts.point || require('./flow-policy').pointFiles(change.dir, opts.point).some(f => S.normKey(f) === S.normKey(path.resolve(change.dir, r.file))));
    // 后面的点只审新写的文档，前面的只用来核对是否对齐（问题表第 37 条）
    const upstream = (f) => ['proposal', 'specs', 'design', 'tasks'].includes(opts.point) && !(opts.point === 'specs' ? /^specs[\\/]/.test(f) : f === opts.point + '.md');
    for (const row of rows) add(row.file, row.text, change.dir, undefined, upstream(row.file) ? '上游文档' : undefined);
    const art = { dir: change.dir, name: change.name, root: W.rootOf(change.dir) };
    const issues = rows.flatMap((r) => r.file === 'revisions.md' ? [] : require('./proposal-files').issuesIn(r.text, art));
    if (issues.length) throw new Error('提案材料交付检查未通过：' + issues.join('；'));
    const roots = S.projectRootsOf(change.dir); const refs = proposalReferences(rows); contextOnly = refs.contextOnly;
    for (const ref of refs.references) {
      const local = ref.replace(/^\.\//, '');
      if (/^(?:assets|references)\//.test(local) || local.startsWith('openspec/changes/' + change.name + '/')) {
        const f = path.resolve(/^(?:assets|references)\//.test(local) ? change.dir : art.root, local);
        const label = path.relative(change.dir, f).replace(/\\/g, '/');
        if (S.artifactOf(f) && !/^(?:assets|references)\//.test(label)) continue;
        const loaded = load(f, change.dir, label); if (loaded) add(label, loaded.text, change.dir, f, '参考材料');
        continue;
      }
      let found = false;
      for (const root of roots) {
        const f = path.resolve(root, ref);
        if (!S.underDir(f, root) || S.underDir(f, change.dir) || /[\\/]\.vibe[\\/]/.test(f) || !fs.existsSync(f)) continue;
        found = true;
        if (!refs.required.has(ref) && fs.lstatSync(f).isDirectory() && S.underDir(S.realish(f), S.realish(root))) break; // 普通目录引用只是范围说明。
        const label = path.relative(opts.cwd, f).replace(/\\/g, '/'); const loaded = load(f, root, label);
        if (loaded) add(label, loaded.text, root, f, '参考材料');
        break;
      }
      if (!found && refs.required.has(ref)) skipped.push({ file: ref, reason: '明确指定的审查材料不存在或不在项目范围内；核对路径后再审' });
    }
  } else {
    const roots = change ? S.projectRootsOf(change.dir) : [W.rootOf(opts.cwd)];
    const saved = change && S.readState('work-baselines')[S.normKey(change.dir)];
    // --base 可以写几次：<仓库相对路径>=<提交> 指定某个仓库的基线（#189：壳子带两个子项目，只有一个值时对每个仓库都用它，
    // 在没有这个提交的仓库里整轮报"审查基线不是本地提交"）。不带等号的值只用在认得它的仓库上，其余仓库用开工时登记的基线
    const given = [].concat(opts.base || []).filter(Boolean).map(String);
    const pairs = given.filter((b) => /=/.test(b)).map((b) => { const at = b.lastIndexOf('='); return { root: W.rootOf(path.resolve(opts.cwd, b.slice(0, at))), ref: b.slice(at + 1) }; });
    const bare = given.filter((b) => !/=/.test(b));
    const isCommit = (root, ref) => !!W.git(root, ['rev-parse', '--verify', ref + '^{commit}']).trim();
    const used = new Set();
    const hint = '--base ' + roots.map((r) => (path.relative(opts.cwd, r).replace(/\\/g, '/') || '.') + '=<改之前的提交>').join(' --base ');
    for (const root of roots) {
      const pair = pairs.find((x) => S.normKey(x.root) === S.normKey(root));
      const own = pair ? pair.ref : bare.find((b) => isCommit(root, b));
      if (own) used.add(own);
      const base = own || (saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root)) || {}).ref;
      if (!base) { skipped.push({ file: root, reason: '缺开工基线：用 --base 明确这个仓库改之前的提交再审，几个仓库各写一个，例：' + hint }); continue; }
      if (!isCommit(root, base)) throw new Error('审查基线 ' + base + ' 不是 ' + root + ' 里的本地提交；几个仓库各写各的：' + hint);
      bases.push({ root, ref: base });
      // 已跟踪的改动排在前面，未跟踪的只要基线之后建的、改过的（#206：--base HEAD 把 167 个早就在的 .claude、.review、docs 文件也送审）；
      // 有开工基线的，开工时就在的未跟踪文件不算，之后又改过的照算
      const tracked = W.git(root, ['diff', '--name-only', '-z', base]).split('\0').filter(Boolean);
      const since = (Number(W.git(root, ['show', '-s', '--format=%ct', base]).trim()) || 0) * 1000;
      const repoRec = saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root));
      const before = repoRec ? repoRec.dirtyFiles || [] : [];
      const preexisting = (f) => before.some((p) => p === f || (/\/$/.test(p) && f.startsWith(p)));
      const mtime = (f) => { try { return fs.statSync(path.join(root, f)).mtimeMs; } catch (e) { return 0; } };
      let old = 0;
      const fresh = W.git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).filter((f) => {
        const keep = preexisting(f) ? mtime(f) > (saved.at || 0) : !since || mtime(f) >= since - 60000;
        if (!keep && !/^(?:\.vibe|openspec)\//.test(f)) old++;
        return keep;
      });
      if (old) excluded.push({ root, untracked: old, reason: '基线之前就在、之后没改过的未跟踪文件，不算这次的改动' });
      const files = [...new Set(tracked.concat(fresh))];
      for (const file of files) {
        if (/^(?:\.vibe|openspec)\//.test(file)) continue;
        const f = path.join(root, file);
        if (opts.point && change) { const selected = require('./flow-policy').pointFiles(change.dir, opts.point); if (selected.length && !selected.some(p => S.normKey(p) === S.normKey(f))) continue; }
        const label = path.relative(opts.cwd, f).replace(/\\/g, '/'); const current = load(f, root, label, true);
        if (!current) continue; // 读取 Git 差异之前先查链接归属，避免 Git 跟随外部联接。
        const diff = W.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=5', base, '--', file]);
        let text = diff ? '基线差异：\n' + diff + '\n当前文件：\n' + current.text : current.missing ? '文件已删除' : current.text;
        const oldDirty = saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root));
        if (oldDirty && (oldDirty.dirtyFiles || []).includes(file)) text = '说明：该文件在开工前已有改动，不能全部认作本次助手改动。\n' + text;
        add(label, text, root, f, undefined, current.missing ? '' : current.text, current.missing ? '已删除' : oldDirty && (oldDirty.dirtyFiles || []).includes(file) ? '开工前已有改动，不能全部认作本次改动' : '');
      }
    }
    // 不带等号的 --base 一个仓库都不认得：是写错了，不当成缺基线
    for (const b of bare) if (!used.has(b)) throw new Error('审查基线 ' + b + ' 不是本地提交（这几个仓库里都没有）；几个仓库各写各的：' + hint);
    if (change) for (const row of artifacts().filter((r) => !/revisions\.md$/.test(r.file))) add(row.file, row.text, change.dir, undefined, '需求文档');
  }
  const batches = []; let batch = [], size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) batches.push(batch);
  return { items, skipped, uncovered, excluded, bases, batches, contextOnly, inputs: [...inputs.values()], currents };
}
/** 随提案交付的补充材料变化后结论失效；实施源码的变化留给代码审查，不重开需求审查。 */
function inputsCurrent(inputs) {
  if (!Array.isArray(inputs)) return true; // 升级前的审查记录继续按原产物指纹核对。
  return inputs.every(input => {
    require('./invocation').phase('核对提案审查材料');
    try {
      const checked = W.pathStatus(input.file, input.root);
      return checked.safe && !checked.missing && checked.stat.size <= 4 * 1024 * 1024 && W.hash(fs.readFileSync(input.file)) === input.hash;
    } catch (e) { return false; } // 材料不可读不能把旧结论当有效。
  });
}
/** 子代理最后一条回复里的结论：JSON，可以包在代码块里、前后带话。不对就抛错，错误信息原样给子代理看 */
function parseResult(text) {
  const body = String(text || '');
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  let result;
  const fences = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse();
  for (const m of fences) { result = tryParse(m[1]); if (result !== undefined) break; }
  if (result === undefined) { const i = body.indexOf('{'); const k = body.lastIndexOf('}'); if (i >= 0 && k > i) result = tryParse(body.slice(i, k + 1)); }
  if (result === undefined) throw new Error('最后一条回复里没有能解析的 JSON');
  if (!result || !Array.isArray(result.issues) || result.issues.some((x) => !x || typeof x.file !== 'string' || typeof x.problem !== 'string' || typeof x.evidence !== 'string')) throw new Error('JSON 要有 issues 数组，每条都要有 file、problem、evidence 三个字符串');
  return { issues: R.tree(result.issues), summary: R.clip(result.summary || '', 1500) };
}
/** 模型执行接受问题时核对真人决定；手工 CLI 仍由执行者负责。 */
function decisionIssue(j) {
  const parser = require('../hooks/guard-commit'); const ps = j.tool_name === 'PowerShell';
  for (const group of parser.splitCommand(String(j.tool_input && j.tool_input.command || ''), ps)) for (const segment of group) {
    const ws = parser.words(parser.scanRedirects(segment).rest, ps).map((w) => w.text);
    if (ws.length < 3 || !/^node(?:\.exe)?$/i.test(path.basename(ws[0].replace(/\\/g, '/'))) || S.normKey(path.resolve(j.cwd, S.expandHome(ws[1]))) !== S.normKey(path.join(S.KIT, 'tools/review.js'))) continue;
    const val = (k) => { const i = ws.indexOf(k); return i < 0 ? '' : S.expandHome(ws[i + 1] || ''); }; const cwd = path.resolve(j.cwd, val('--project') || '.'); const change = changeOf(cwd, val('--change'));
    let action = '';
    if (ws[2] === 'resolve') { try { const d = JSON.parse(fs.readFileSync(path.resolve(j.cwd, val('--decisions')), 'utf8')); if ((d.findings || []).some((x) => x.action === 'accepted')) action = 'reviewAccept'; } catch (e) { return '意见处理文件无法核对，先检查 --decisions 文件'; } }
    if (!action) continue;
    // 不走 OpenSpec 的审查（不带 --change）：按项目目录核对用户的决定（#234）
    const allowed = require('./permissions').allow(j, action, change ? change.dir : W.rootOf(cwd), j.tool_use_id);
    if (!allowed.ok) return '需要当前用户明确决定接受这次审查中的问题：' + allowed.reason;
  }
  return '';
}
/**
 * 审完对着配置页的"审查预期用时"看：超了，或者有角度没交，就记一条问题反馈（用户 2026-10-28 定的，问题反馈表第 6 条），
 * 写清用在哪，给维护的人持续优化审查用。只有用时、文件数、字数，不带材料原文和审查意见
 */
function reportReview(result, job) {
  try {
    const over = result.spentMs > job.expectMs;
    const lost = job.lenses.filter((l) => job.state[l].status === 'failed');
    if (!over && !lost.length) return null;
    const sec = (ms) => Math.round(ms / 1000);
    const lines = ['审查模式 ' + job.mode + (job.point ? '，审查点 ' + job.point : '') + (job.change ? '' : '（不走 OpenSpec）') + (job.scoped ? '，只审修改点' : '，' + job.lenses.length + ' 个角度'),
      '总用时 ' + sec(result.spentMs) + ' 秒，配置页的预期用时 ' + sec(job.expectMs) + ' 秒' + (over ? '，超了 ' + sec(result.spentMs - job.expectMs) + ' 秒' : '，没超'),
      '每个角度：' + job.lenses.map((l) => l + (job.state[l].status === 'submitted' ? ' ' + sec(job.state[l].doneAt - job.started) + ' 秒' : ' 没交')).join('，'),
      '材料 ' + job.files + ' 个文件、' + Math.round(job.chars / 1000) + ' 千字；结果 ' + result.status];
    const title = over ? '审查超出预期用时（' + sec(result.spentMs) + ' 秒，预期 ' + sec(job.expectMs) + ' 秒）' : '审查有 ' + lost.length + ' 个角度没交结论';
    const sig = require('./feedback').sigOf(['review-report', job.mode, over ? 'over' : '', lost.length ? 'lost' : '']);
    return require('./feedback').record({ kind: lost.length ? '出错' : '建议', hook: 'review.js', source: '审查自动记录', title, what: lines.join('\n'), why: '审查做完对着配置页的预期用时自动核对（用户 2026-10-28 定的：不截断审查，超了分析用时和原因上报，用来优化审查）。', cwd: job.root, sig, note: lines[1] });
  } catch (e) { return null; } // 记不了不影响审查结果
}
/** 审完下一步怎么办，写在结果里（模型照着做，不用翻规范） */
function nextStep(result) {
  if (!['completed', 'partial'].includes(result.status)) return '';
  if (result.status === 'partial') return '有材料没审到，不算审完：看 skipped 里的原因，处理完再跑一次 review.js prepare。';
  if (result.noChange) return '文件和上一轮审过的一样，这次不用开子代理' + (result.blocking ? '；上一轮的 ' + result.blocking + ' 条 P1、P2 还没处理' : '') + '。用户要整份再审一遍，加 --full。';
  if (!result.issues.length) return '没有问题，这个点过了。';
  if (!result.blocking) return '只有 P3，这个点过了，不用再审。顺手能改的改了用 review.js resolve 登记 fixed，不想改的不用管。';
  return '有 ' + result.blocking + ' 条 P1、P2：逐条核实，成立的改，不成立的写依据（rejected）；实现细节归后面文档的标 deferred，不要现在写进这份文档。写好处理明细跑 review.js resolve，再跑一次 review.js prepare：下一轮只审改过的地方。';
}
const MODE_NAME = { proposal: '提案', code: '代码' };
const QUIET_MS = 30 * 60000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-');
const jobFolder = (job) => path.join(job.root, '.vibe', 'reviews', job.change || 'plain');
function findJob(id) { const o = S.readState('review-jobs'); for (const k of Object.keys(o)) if (o[k] && o[k].id === id) return o[k]; return null; }
const leftOf = (job) => job.lenses.filter((l) => job.state[l].status !== 'submitted');
/** 探索记录：这个变更属于大任务才有 */
function exploreOf(job) { try { const B = require('./big-task'); const t = job.change ? B.ofChange(job.root, job.change) : null; return t && t.explore && fs.existsSync(t.explore) ? t.explore : ''; } catch (e) { return ''; } }
/** 一个角度的范围文件：审什么、按什么审、怎么交。子代理自己读文件、看 git，没有文件数的限制 */
function scopeText(job, lens, plan, round, material) {
  const out = ['# 审查任务 ' + job.id + '/' + lens.name, '', '模式：' + (plan.scoped ? '复审' : '') + MODE_NAME[job.mode], '变更：' + (job.change || '（不走 OpenSpec）'), '项目：' + job.root];
  if (job.point) out.push('审查点：' + job.point);
  out.push('', '## 要求', '', Sc.requirements(round, job.mode, lens.text));
  if (round.cross) out.push('', '## 来源的修改点', '', '这次只审下面这处修改对这个 change 的影响：这个 change 依赖它的地方有没有跟着改、还对不对。别的不审。', '', round.cross);
  const explore = exploreOf(job);
  if (explore) out.push('', '## 探索记录', '', explore + '（读公共几节' + (job.change ? '和 ' + job.change + ' 那一节' : '') + '：范围、定了的都在里面）');
  if (plan.scoped) {
    const names = new Set(plan.items.map((x) => String(x.file)));
    out.push('', '## 上一轮的问题', '', '```json', JSON.stringify((plan.open || []).filter((x) => names.has(String(x.file))), null, 1), '```');
    if ((plan.closed || []).length) out.push('', '## 已处理', '', '```json', JSON.stringify(plan.closed, null, 1), '```');
    out.push('', '## 这次改过的地方');
    for (const it of plan.items) out.push('', '### ' + it.file + (it.role ? '（' + it.role + '）' : '') + (it.note ? ' — ' + it.note : ''), '', '路径：' + (it.source || it.file), '', '```', it.text, '```');
  } else {
    if ((round.carry || []).length) out.push('', '## 上游审查留给这一步的要点', '', '这一步要覆盖到，没覆盖到的报 P2：', '', '```json', JSON.stringify(round.carry, null, 1), '```');
    out.push('', '## 要审的文件', '');
    for (const [file, cur] of material.currents) out.push('- ' + file + (cur.role ? '（' + cur.role + '，只用来核对）' : '') + (cur.note ? '（' + cur.note + '）' : '') + (cur.source && cur.source !== file ? '：' + cur.source : ''));
    if ((material.bases || []).length) out.push('', '基线：' + material.bases.map((b) => b.root + ' 的 ' + b.ref).join('；') + '。改动用 `git -C <仓库> diff <基线> -- <文件>` 看，新文件整个读。');
  }
  if ((material.uncovered || []).length) out.push('', '## 没进审查的（不用看）', '', ...material.uncovered.map((x) => '- ' + x.file + '：' + x.reason));
  out.push('', '## 怎么交', '', '最后一条回复只写这两样：第一行 `审查任务：' + job.id + '/' + lens.name + '`，后面一个 JSON 代码块，格式见你的说明。');
  return out.join('\n') + '\n';
}
/** 子代理的提示：第一行模式、第二行变更、第三行任务，钩子靠第三行认 */
function promptOf(job, lens) {
  return ['模式：' + (job.scoped ? '复审' : '') + MODE_NAME[job.mode], '变更：' + (job.change || '（不走 OpenSpec）'), '审查任务：' + job.id + '/' + lens, '范围文件：' + path.join(job.dir, safeName(lens) + '.md')].join('\n');
}
/** 还要开的子代理：没发出去的、没交结论的（已交的角度不重开，正在跑的不重开） */
function agentsOf(job) {
  const open = job.lenses.filter((l) => !['submitted', 'sent'].includes(job.state[l].status));
  const sent = job.lenses.filter((l) => job.state[l].status === 'sent');
  const status = 'review.js status' + (job.change ? ' --change ' + job.change : '') + ' --mode ' + job.mode + (job.point ? ' --point ' + job.point : '') + ' --project ' + job.root.replace(/\\/g, '/');
  return { status: 'prepared', id: job.id, round: job.round, scope: job.scoped ? 'changes' : 'full', lenses: job.lenses, running: sent, agents: open.map((l) => ({ lens: l, subagent_type: 'ttls-reviewer', description: '审查 ' + (job.point || job.mode) + ' ' + l, prompt: promptOf(job, l) })),
    next: open.length ? '一条回复里同时开这 ' + open.length + ' 个子代理：Agent 工具，subagent_type 写 ttls-reviewer，prompt 原样用 agents 里的。都回来之后（2.1.259 起在后台，做完会来通知，这期间不用等也不要再开）跑 ' + status + ' 看汇总。' : '这几个角度正在跑，不要再开。都回来之后跑 ' + status + ' 看汇总。' };
}
/** 备一轮审查：不发请求。输入没变就复用同一个任务、不加轮数 */
function prepare(opts) {
  opts = Object.assign({ cwd: process.cwd(), mode: 'code' }, opts); opts.cwd = path.resolve(opts.cwd);
  if (!['proposal', 'code'].includes(opts.mode)) throw new Error('审查模式只能是 proposal 或 code');
  // #197：不走 OpenSpec 的小修复，模型编了一个变更名。报错里说清不带 --change 的写法
  const change = changeOf(opts.cwd, opts.change); if (opts.change && !change) throw new Error('没找到当前变更 ' + opts.change + '（' + opts.cwd + ' 的 openspec/changes 里没有这个变更）。不走 OpenSpec 的改动不带 --change，按改之前的提交审：review.js prepare --mode code --project ' + opts.cwd.replace(/\\/g, '/') + ' --base <改之前的提交>');
  const key = jobKey(opts.cwd, opts.change, opts.mode, opts.point, opts.base); const cfg = S.readConfig();
  const policy = require('./flow-policy');
  if (opts.point && (!change || !policy.points(change.dir, opts.mode).includes(opts.point))) throw new Error('审查点不存在或该任务组尚未完成');
  const pointHash = opts.point ? policy.fingerprint(change.dir, opts.point) : '';
  const before = W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all');
  const input = pointHash || before.hash;
  const old = S.readState('review-jobs')[key];
  if (old && old.status === 'running' && old.lenses && !opts.full && old.input === input && Date.now() < old.deadline && fs.existsSync(old.dir)) return leftOf(old).length ? agentsOf(old) : finish(old.id);
  if (old && old.dir) fs.rmSync(old.dir, { recursive: true, force: true });
  const id = crypto.randomBytes(12).toString('hex'); const started = Date.now();
  // 配置页的"审查预期用时"：不到点截断（用户 2026-10-28 定的），审完超了就记问题反馈。--budget 给了就按它算这一次的预期
  const expectMs = Math.min(1800, Math.max(10, Number(opts.budgetSeconds || cfg.reviewBudgetSeconds) || 300)) * 1000;
  const folder = path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'); const file = path.join(folder, opts.mode + (opts.point ? '-' + opts.point : '') + '.json');
  const born = change ? S.changeBorn(change.dir) : 0;
  if (change && opts.point) policy.begin(change.dir, opts.point, id, pointHash);
  const job = { id, key, mode: opts.mode, change: opts.change || '', point: opts.point || '', root: opts.cwd, base: opts.base, status: 'running', started, deadline: started + 6 * 3600000, expectMs, fingerprint: before.hash, pointHash, input, dir: path.join(folder, 'job-' + id), file, lenses: [], state: {} };
  try {
    const material = materials(opts, change);
    if (!material.batches.length) throw new Error('没有可审查材料或开工基线缺失');
    // 第一轮全量，后面只审修改点（问题表第 37 条）。--full 要整份再审一遍
    const prior = opts.full ? null : Sc.readPrior(file, born, opts.base);
    const plan = Sc.planRound(material, prior);
    const prevRound = Sc.readPrior(file, born, opts.base);
    job.round = change && opts.point ? policy.record(change.dir, opts.point).rounds || 1 : (prevRound ? prevRound.round + 1 : 1);
    job.scoped = !!plan.scoped;
    const noChange = plan.scoped && !plan.items.length;
    const lenses = noChange ? [] : plan.scoped ? [{ name: '复审', text: '' }] : policy.isCross(opts.point) ? [{ name: '修改点', text: '' }] : Sc.lensesFor(opts.mode, material.batches.length, cfg);
    const list = lenses.length || noChange ? lenses : [{ name: '全量', text: '' }];
    job.lenses = list.map((l) => l.name);
    for (const l of job.lenses) job.state[l] = { status: 'open' };
    job.files = material.currents.size; job.chars = material.items.reduce((n, x) => n + x.text.length, 0);
    const currents = {}; for (const [f, cur] of material.currents) currents[f] = { text: cur.text, source: cur.source };
    fs.mkdirSync(job.dir, { recursive: true });
    if (!store.atomicWrite(path.join(job.dir, 'plan.json'), { scoped: job.scoped, why: plan.why, noChange, open: plan.open, closed: plan.closed, carried: plan.carried, kept: plan.kept, changed: plan.changed, itemFiles: plan.scoped ? [...new Set(plan.items.map((x) => x.file))] : [], currents, skipped: material.skipped, uncovered: material.uncovered, excluded: material.excluded, contextOnly: material.contextOnly, materialInputs: material.inputs, deferred: Sc.deferredOf(prevRound), born, fingerprintNote: before.truncated ? '这个目录不是 git 仓库，文件太多，只核对了前面的文件：后面的文件改了认不出来，"审查后输入没变"对它们不作数' : undefined })) throw new Error('审查材料写不进 ' + job.dir);
    const round = { stage: Sc.stageText(opts.mode, opts.point), scoped: job.scoped, carry: !plan.scoped && opts.point === 'design' ? Sc.carryover(folder, ['proposal', 'specs']) : [], cross: policy.isCross(opts.point) ? policy.crossText(change.dir, opts.point) : '' };
    for (const l of list) fs.writeFileSync(path.join(job.dir, safeName(l.name) + '.md'), scopeText(job, l, plan, round, material));
    S.updateState('review-jobs', (o) => { o[key] = job; });
    if (noChange) return finish(id);
    return agentsOf(job);
  } catch (e) {
    const result = { id, mode: opts.mode, status: 'failed', issues: [], covered: [], skipped: [], reason: R.clip(e.message, 500), at: Date.now(), spentMs: 0 };
    S.updateState('review-jobs', (o) => { o[key] = Object.assign(job, result); });
    if (change && opts.point) policy.noteResult(change.dir, opts.point, result, pointHash);
    return result;
  }
}
/** 主会话发出去了（flow-policy 放行 Agent 时记）：收工时才分得清"在跑"和"没开" */
function dispatch(id, lens, toolId) {
  S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) { const job = o[k]; if (job && job.id === id && job.status === 'running' && job.state[lens] && job.state[lens].status !== 'submitted') job.state[lens] = Object.assign(job.state[lens], { status: 'sent', sentAt: Date.now(), tool: toolId || '' }); } });
}
/** 这条提示是不是一个有效的审查任务。返回 { id, lens } 或 null */
function taskOf(text) {
  const m = /审查任务\s*[:：]\s*([0-9a-f]{24})\/([^\s`"，。]+)/.exec(String(text || ''));
  if (!m) return null;
  const job = findJob(m[1]);
  return job && job.status === 'running' && job.state[m[2]] ? { id: m[1], lens: m[2] } : null;
}
/** 子代理交结论（review-stop 钩子调）。JSON 不对返回 { ok: false, error }；同一角度只算一次；交齐了合并入账 */
function submit(id, lens, text) {
  const job = findJob(id);
  if (!job || job.status !== 'running') return { ok: true, late: true };
  if (!job.state[lens]) return { ok: false, error: '角度 ' + lens + ' 不在这个任务里（' + job.lenses.join('、') + '）' };
  if (job.state[lens].status === 'submitted') return { ok: true, repeat: true };
  let parsed; try { parsed = parseResult(text); } catch (e) { return { ok: false, error: e.message }; }
  if (!store.atomicWrite(path.join(job.dir, 'result-' + safeName(lens) + '.json'), parsed)) return { ok: false, error: '结论写不进 ' + job.dir };
  let all = false;
  S.updateState('review-jobs', (o) => {
    const cur = o[job.key];
    if (!cur || cur.id !== id) return;
    cur.state[lens] = Object.assign(cur.state[lens], { status: 'submitted', doneAt: Date.now() });
    if (!cur.finishing && leftOf(cur).length === 0) { cur.finishing = true; all = true; }
  });
  if (!all) return { ok: true, left: leftOf(findJob(id) || job) };
  return Object.assign({ ok: true }, finish(id));
}
/** 同一角度 JSON 不对又被拦了一次：返回第几次 */
function noteReject(id, lens) {
  let n = 0;
  S.updateState('review-jobs', (o) => { for (const k of Object.keys(o)) { const job = o[k]; if (job && job.id === id && job.state[lens]) { job.state[lens].rejects = (job.state[lens].rejects || 0) + 1; n = job.state[lens].rejects; } } });
  return n;
}
/** 这个角度算没交：下一次 prepare 只重开它。连续 3 次没交就不再催（flow-policy 的 halted），不算通过 */
function failLens(id, lens, why) {
  const job = findJob(id); if (!job || job.status !== 'running' || !job.state[lens] || job.state[lens].status === 'submitted') return;
  S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === id) cur.state[lens] = { status: 'failed', why: R.clip(why, 300), at: Date.now() }; });
  const change = job.change ? changeOf(job.root, job.change) : null;
  if (change && job.point) require('./flow-policy').noteFail(change.dir, job.point);
  try { require('./usage').bump('review.lost'); } catch (e) { /* 数不了就算了 */ }
  reportReview({ spentMs: Date.now() - job.started, status: 'running' }, Object.assign({}, job, { state: Object.assign({}, job.state, { [lens]: { status: 'failed' } }) }));
}
/** 收工时看还在跑的任务：前台子代理的结果回来了还没交（被 Esc 打断）、发出去半小时没回（Claude Code 退出过）的算没交 */
function sweep(entries, cwd) {
  const results = S.toolResults(entries); const root = S.normKey(path.resolve(cwd));
  const jobs = S.readState('review-jobs');
  for (const k of Object.keys(jobs)) {
    const job = jobs[k];
    if (!job || job.status !== 'running' || !job.lenses || !(S.underDir(job.root, root) || S.underDir(root, job.root))) continue;
    for (const l of job.lenses) {
      const st = job.state[l];
      if (st.status !== 'sent') continue;
      const r = st.tool ? results.get(st.tool) : null;
      const over = r && !/Async agent launched|working in the background/i.test(String(r.text || ''));
      if (over) failLens(job.id, l, '子代理结束了，没交结论');
      else if (Date.now() - (st.sentAt || 0) > QUIET_MS) failLens(job.id, l, '发出去半小时没回结论');
    }
  }
}
/** 这个变更（这个模式）有角度正在跑：别催、别再开 */
function inFlight(dir, mode) {
  const name = path.basename(dir); const jobs = S.readState('review-jobs');
  return Object.values(jobs).some((job) => job && job.status === 'running' && job.state && job.change.toLowerCase() === name.toLowerCase() && (!mode || job.mode === mode) && S.normKey(path.join(job.root, 'openspec', 'changes', job.change)) === S.normKey(dir) && Object.values(job.state).some((s) => s.status === 'sent'));
}
/** 角度交齐：合并、入账、写快照和审查记录 */
function finish(id) {
  const job = findJob(id);
  if (!job) return { status: 'cancelled', reason: '迟到结果已忽略' };
  const policy = require('./flow-policy');
  const change = job.change ? changeOf(job.root, job.change) : null;
  const plan = readJson(path.join(job.dir, 'plan.json')) || {};
  const folder = jobFolder(job);
  const groups = job.lenses.map((l) => readJson(path.join(job.dir, 'result-' + safeName(l) + '.json')) || { issues: [] });
  const labels = Object.keys(plan.currents || {});
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const labelOf = (f) => labels.find((n) => norm(n) === norm(f) || norm((plan.currents[n] || {}).source || '') === norm(f)) || f;
  let issues = Sc.mergeIssues(groups.map((g) => g.issues.map((x) => Object.assign({}, x, { file: labelOf(x.file) }))));
  // 需求和探索记录里没有的（scope: out）不算问题：不挡通过、不触发复审，人工核验时列给用户（第 43 条）
  const outside = issues.filter((x) => /^out$/i.test(String(x.scope || '')));
  issues = issues.filter((x) => !/^out$/i.test(String(x.scope || '')));
  const result = { id, mode: job.mode, status: 'failed', issues, covered: [], skipped: plan.skipped || [], uncovered: plan.uncovered || [], excluded: plan.excluded, contextOnly: plan.contextOnly, materialInputs: plan.materialInputs, scope: job.scoped ? 'changes' : 'full', round: job.round, lenses: job.lenses.length || 1, expectSeconds: job.expectMs / 1000, summary: groups.map((g) => g.summary).filter(Boolean).join('\n') };
  if (plan.why) result.scopeWhy = plan.why;
  if (plan.fingerprintNote) result.fingerprintNote = plan.fingerprintNote;
  if (plan.noChange) result.noChange = true;
  if (plan.scoped) {
    result.changedFiles = plan.changed;
    result.covered = [...new Set((plan.kept || []).concat(plan.itemFiles || []))];
    // 报到这一轮没送的文件（没改过的）：不算数，也不算没审完
    const items = new Set(plan.itemFiles || []);
    const off = result.issues.filter((x) => labels.includes(x.file) && !items.has(x.file));
    if (off.length) result.outOfScope = off;
    const fresh = Sc.dropClosed(result.issues.filter((x) => !off.includes(x)), plan.closed);
    if (fresh.dropped.length) result.repeated = fresh.dropped;
    result.issues = fresh.kept.concat(plan.carried || []);
  } else result.covered = labels;
  if (outside.length) {
    result.suggestions = outside.map((x) => ({ file: x.file, problem: x.problem }));
    try { const B = require('./big-task'); const task = job.change ? B.ofChange(job.root, job.change) : null; if (task) for (const x of outside) B.addSuggestion(task, x.file + '：' + x.problem, '审查 ' + (job.point || job.mode)); } catch (e) { /* 记不了：结果里还有 */ }
  }
  const nowInput = job.point && change ? policy.fingerprint(change.dir, job.point) : W.fingerprint(job.root, job.mode === 'code' ? 'code' : 'all').hash;
  if (nowInput !== (job.pointHash || job.fingerprint) || !inputsCurrent(result.materialInputs)) { result.status = 'stale'; result.reason = '审查期间输入变更，本轮结果不能批准新版'; }
  else if (result.skipped.length) { result.status = 'partial'; result.reason = '还有未覆盖材料，不能记为完整审查'; }
  else result.status = 'completed';
  result.issues = result.issues.map((x, i) => Object.assign({}, x, { id: 'r' + (i + 1) }));
  result.blocking = Sc.blocking(result.issues);
  result.fingerprint = job.fingerprint; result.spentMs = Date.now() - job.started; result.at = Date.now();
  const fb = reportReview(result, job); if (fb && fb.id) result.reported = fb.id;
  try { if (!store.atomicWrite(job.file, result)) throw new Error('结果写入失败'); result.file = job.file; }
  catch (e) { result.status = 'failed'; result.reason = '审查结果未能保存，不能登记为完成'; }
  try {
    const U = require('./usage');
    U.bump(result.spentMs > job.expectMs ? 'review.timeout' : 'review.' + result.status);
    U.bump('review.' + (job.mode === 'proposal' ? 'proposal' : 'code')); if (result.status === 'completed' && !result.issues.length) U.bump('review.clean');
  } catch (e) { /* 计数失败不改变结论 */ }
  if (change && job.point) policy.noteResult(change.dir, job.point, result, job.pointHash);
  // 这一轮审成了才留作下一轮的比较对象；审查期间文件变了不动上一轮
  if (['completed', 'partial'].includes(result.status)) {
    const covered = new Set(result.covered); const files = {};
    for (const n of labels) if (covered.has(n)) files[n] = plan.currents[n].text;
    try { Sc.writeSnapshot(store, job.file, { born: plan.born, base: job.base, round: job.round, files, issues: result.issues, closed: plan.scoped ? plan.closed : plan.deferred, covered: result.covered }); } catch (e) { /* 存不了，下一轮按第一轮审 */ }
  }
  const log = Sc.logRound(folder, { round: job.round, point: job.point, mode: job.mode, at: result.at, scoped: job.scoped, changed: plan.changed, lenses: result.lenses, why: plan.why, status: result.status, reason: result.reason, issues: result.issues, spentMs: result.spentMs, repeated: (result.repeated || []).length });
  if (log) result.log = log;
  result.next = nextStep(result);
  if (change && result.status === 'completed' && (!job.point || policy.allPassed(change.dir, job.mode))) {
    S.recordReview(job.mode, change.dir, result.blocking, id, Date.now(), true);
    S.updateState(job.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const r = o[S.normKey(change.dir)]; if (r && r.key === id) { if (job.mode === 'code') r.fingerprint = job.fingerprint; else { r.proposalHash = require('./apply-scope').planHash(change.dir); r.materialInputs = result.materialInputs; } r.reportFile = job.file; r.executor = 'agent'; r.covered = result.covered; } });
  }
  S.updateState('review-jobs', (o) => { if (o[job.key] && o[job.key].id === id) o[job.key] = Object.assign(o[job.key], result, { finishing: false }); });
  fs.rmSync(job.dir, { recursive: true, force: true });
  return result;
}
function status(opts) {
  const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); const r = S.readState('review-jobs')[key];
  if (r && r.status === 'running' && Date.now() >= r.deadline) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === r.id) { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'interrupted'; o[key].reason = '角度没交齐，没有完整结果'; } }); return S.readState('review-jobs')[key]; }
  // 都交了但入账没走完（钩子的预算用完了）：这里补上
  if (r && r.status === 'running' && r.lenses && r.lenses.length && !leftOf(r).length) return finish(r.id);
  if (r && r.status === 'running') return Object.assign({}, r, { left: r.lenses ? leftOf(r) : [] });
  return r || { status: 'none' };
}
function cancel(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); S.updateState('review-jobs', (o) => { if (o[key] && o[key].status === 'running') { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'cancelled'; o[key].reason = '用户或当前会话取消'; } }); return status(opts); }
const NO_EVIDENCE = '成立问题修复后还没有当前输入的成功复验证据：先跑一次能证明修好了的编译或测试（mvn、gradle、npm 的脚本、npx、pytest、go、dotnet、make，或者 .vibe 下的脚本），成功了再登记';
function resolve(opts) {
  const change = changeOf(opts.cwd || process.cwd(), opts.change);
  if (opts.change && !change) throw new Error('没找到当前变更 ' + opts.change + '；不走 OpenSpec 的审查不带 --change：resolve --mode code --project <项目> --decisions <文件>');
  if (!change) return resolvePlain(opts);
  const policy = require('./flow-policy');
  const pointRec = opts.point && policy.record(change.dir, opts.point);
  // 失败、部分覆盖、超时、取消的结果没有审完全部材料，处理其中的意见也不能把这个点记成已处理。
  if (pointRec && pointRec.status !== 'completed') throw new Error('审查点 ' + opts.point + ' 没有完整完成的审查结果（当前：' + (pointRec.status || '未审查') + '），不能登记处理；先重新审查这个点');
  // 不带审查点的整套审查：按 --mode 读提案或代码的记录（Codex C20：以前固定读代码的，整套提案审查的意见配不上报告）
  const kind = opts.mode === 'proposal' ? 'proposal' : 'code';
  const r = pointRec ? Object.assign({}, pointRec, { reportFile: pointRec.report }) : S.reviewRecord(kind, change.dir); if (!r || !r.reportFile) throw new Error('没有可配对的完整审查报告');
  const report = JSON.parse(fs.readFileSync(r.reportFile, 'utf8')); const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  // deferred：实现细节留给后面的文档，只有需求文档能用（问题表第 37 条）
  const actions = kind === 'proposal' ? ['fixed', 'rejected', 'accepted', 'deferred'] : ['fixed', 'rejected', 'accepted'];
  for (const issue of report.issues) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !actions.includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (report.id !== r.key || !Array.isArray(report.issues)) throw new Error('审查报告不属于当前完整记录');
  if (decisions.findings.length !== report.issues.length || new Set(decisions.findings.map((x) => x.id)).size !== report.issues.length || decisions.findings.some((x) => !report.issues.some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  // 改文档不用跑编译（窗口里见过：为了登记提案的修改先跑基线编译）；代码照旧要有复验证据
  if (kind === 'code' && decisions.findings.some((x) => x.action === 'fixed') && !require('./evidence').commands(opts.cwd || process.cwd()).length) throw new Error(NO_EVIDENCE);
  // 只有 P1、P2 修了才要复审；P3 顺手改了不再审（问题表第 37 条）
  const refix = decisions.findings.some((x) => x.action === 'fixed' && !/^P3$/i.test(String((report.issues.find((i) => i.id === x.id) || {}).severity || '')));
  const noted = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) }));
  // 校验都过了才记：不然登记失败了，决定却已经进了下一轮的"已处理"和审查记录
  const remember = () => { if (r.reportFile) { try { Sc.noteDecisions(store, r.reportFile, noted); Sc.logDecisions(path.dirname(r.reportFile), opts.point || kind, noted); } catch (e) { /* 记不了不影响登记 */ } } };
  const fingerprint = W.fingerprint(opts.cwd || process.cwd(), opts.mode === 'proposal' ? 'all' : 'code').hash;
  if (!opts.point && !decisions.findings.some((x) => x.action === 'fixed') && fingerprint !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或零问题记录不能批准新版，需要补审');
  if (opts.point) {
    const changed = pointRec.fingerprint !== policy.fingerprint(change.dir, opts.point);
    const fixed = decisions.findings.some(x => x.action === 'fixed');
    if (!fixed && changed) throw new Error('当前审查点输入已变化，先重新审查');
    remember();
    S.updateState('review-points', o => { const rec = o[S.normKey(change.dir) + '|' + opts.point]; if (rec && rec.key === r.key) { rec.decisions = decisions.findings; rec.status = refix ? 'needs_review' : 'resolved'; rec.resolvedFingerprint = policy.fingerprint(change.dir, opts.point); rec.at = Date.now(); } });
    return { status: refix ? 'needs_review' : 'resolved', count: report.issues.length };
  }
  // 有"修了"的：和带审查点的一样要复审改过的地方，不直接算解决（审核 P34：以前有一条修了就记成已解决）
  remember();
  const fixedAny = refix;
  S.updateState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const rec = o[S.normKey(change.dir)]; if (rec && rec.key === r.key) { rec.resolved = !fixedAny; rec.needsReview = fixedAny; rec.resolvedAt = Date.now(); if (fixedAny) delete rec.resolvedFingerprint; else rec.resolvedFingerprint = fingerprint; rec.decisions = noted; } });
  return fixedAny ? { status: 'needs_review', count: report.issues.length, next: '登记好了。有改过的地方，下一步是复审：再跑一次 review.js prepare（同样的 --change、--mode），审过了才算处理完；不用再登记一次。' } : { status: 'resolved', count: report.issues.length };
}
/**
 * 不走 OpenSpec 的审查（prepare 不带 --change，结果在 .vibe/reviews/plain/<模式>.json）登记用户的决定（#234：以前一律要变更，决定只能留在会话里）。
 * 和带变更的一样核对：每条意见都要有处理动作和依据；修了的要有之后的复验证据；只驳回、接受的，审完之后输入不能变
 */
function resolvePlain(opts) {
  const cwd = path.resolve(opts.cwd || process.cwd()); const mode = opts.mode === 'proposal' ? 'proposal' : 'code';
  if (mode !== 'code') throw new Error('提案审查要带 --change');
  const file = path.join(cwd, '.vibe', 'reviews', 'plain', 'code.json');
  let report; try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('没有这个项目不带变更的审查结果（' + file + '）；先 review.js prepare --mode code --project <项目> --base <提交>'); }
  if (report.status !== 'completed') throw new Error('这次审查没有完整完成（' + (report.status || '未知') + '），不能登记处理；先重新审查');
  const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  for (const issue of report.issues || []) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !['fixed', 'rejected', 'accepted'].includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (decisions.findings.length !== (report.issues || []).length || new Set(decisions.findings.map((x) => x.id)).size !== decisions.findings.length || decisions.findings.some((x) => !(report.issues || []).some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  const fixed = decisions.findings.some((x) => x.action === 'fixed');
  if (fixed && !require('./evidence').commands(cwd).length) throw new Error(NO_EVIDENCE);
  if (!fixed && W.fingerprint(cwd, 'code').hash !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或接受的记录不能批准新版，需要补审');
  report.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) }));
  try { Sc.noteDecisions(store, file, report.decisions); Sc.logDecisions(path.dirname(file), 'code', report.decisions); } catch (e) { /* 记不了不影响登记 */ }
  report.resolvedAt = Date.now(); report.resolvedFingerprint = W.fingerprint(cwd, 'code').hash;
  if (!store.atomicWrite(file, report)) throw new Error('处理记录没能写进审查结果');
  return { status: 'resolved', count: report.decisions.length, file };
}
/**
 * 这段会话记录里跑过的 review.js prepare 的结果，给经验规则自动收（lessons.autoCollect，问题表第 34 条）。
 * 结论在结果文件里（子代理交齐才写）；文件没变、没开子代理的那次结论在命令的输出里。同一次审查只算一次。
 * 登记过处理结果的：驳回、接受不改的不收；修了的，那个文件在这次审查之后确实动过才收（按证据认，不只听模型说修了）。没登记的：报了之后那个文件确实改过才收。
 * 返回 [{ source, mode, issues, findings, pos }]
 */
function runsForLessons(calls, results, cwd) {
  const parser = require('../hooks/guard-commit');
  const out = []; const seen = new Set();
  for (const c of calls) {
    if (!/^(Bash|PowerShell)$/.test(c.name) || !/review\.js/i.test(String(c.input.command || ''))) continue;
    const ps = c.name === 'PowerShell';
    let ws = null;
    try {
      for (const seg of parser.splitCommand(parser.preprocess(String(c.input.command), ps).s, ps).flat()) {
        const w = parser.words(parser.scanRedirects(seg).rest, ps).map((x) => String(x.text));
        if (/^node(?:\.exe)?$/i.test(path.basename(String(w[0] || '').replace(/\\/g, '/'))) && /(?:^|[\\/])review\.js$/i.test(String(w[1] || '')) && ['run', 'prepare'].includes(w[2])) { ws = w; break; }
      }
    } catch (e) { continue; }
    if (!ws) continue;
    const val = (k) => { const i = ws.indexOf(k); return i < 0 ? '' : S.expandHome(ws[i + 1] || ''); };
    const project = path.resolve(cwd, val('--project') || '.');
    const changeName = val('--change'); const mode = val('--mode') === 'proposal' ? 'proposal' : 'code'; const point = val('--point');
    const reportFile = path.join(project, '.vibe', 'reviews', changeName || 'plain', mode + (point ? '-' + point : '') + '.json');
    const res = results.get(c.id);
    let report = null;
    if (res) for (const l of String(res.text || '').split(/\r?\n/).reverse()) { if (!/^\s*\{/.test(l)) continue; try { const j = JSON.parse(l); if (j && Array.isArray(j.issues)) { report = j; break; } } catch (e) { /* 不是这一行 */ } }
    if (!report) { try { const j = JSON.parse(fs.readFileSync(reportFile, 'utf8')); if (j && Array.isArray(j.issues) && Number(j.at) >= (Number(c.at) || 0)) report = j; } catch (e) { /* 没有结果 */ } }
    if (!report || !report.issues.length || !report.id || seen.has(report.id)) continue;
    seen.add(report.id);
    const change = changeName ? changeOf(project, changeName) : null;
    const day = new Date(Number(report.at) || Number(c.at) || Date.now()); const p2 = (n) => String(n).padStart(2, '0');
    const source = changeName || (day.getFullYear() + '-' + p2(day.getMonth() + 1) + '-' + p2(day.getDate()) + ' 小改动');
    let decisions = [];
    try {
      let rec = null;
      if (change && point) rec = require('./flow-policy').record(change.dir, point);
      else if (change) rec = S.reviewRecord(mode, change.dir);
      else rec = Object.assign({ key: report.id }, JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      if (rec && (rec.key === report.id || rec.id === report.id) && Array.isArray(rec.decisions)) decisions = rec.decisions;
    } catch (e) { decisions = []; }
    const bases = [project].concat(change ? [change.dir] : []);
    const findings = [];
    for (const x of report.issues) {
      const d = decisions.find((y) => y.id === x.id);
      if (d && d.action !== 'fixed') continue;
      const abs = bases.map((b) => path.resolve(b, String(x.file || ''))).find((f) => fs.existsSync(f)) || path.resolve(project, String(x.file || ''));
      let touched = false;
      try { touched = fs.statSync(abs).mtimeMs > Number(report.at || 0); } catch (e) { touched = false; }
      findings.push({ file: fs.existsSync(abs) ? abs : String(x.file || ''), problem: x.problem, when: x.evidence, severity: x.severity, kind: x.kind, avoid: x.avoid, fixed: !!d && touched });
    }
    if (findings.length) out.push({ key: report.id, change: change || undefined, recheck: report.scope === 'changes', source, mode, issues: findings.length, findings, pos: res ? res.pos : c.i, at: Number(report.at) || 0 });
  }
  return out;
}
// 老会话还可能敲 run
const run = prepare;
module.exports = { runsForLessons, prepare, run, submit, noteReject, failLens, dispatch, taskOf, sweep, inFlight, materials, inputsCurrent, baseline, status, cancel, resolve, jobKey, parseResult, decisionIssue };

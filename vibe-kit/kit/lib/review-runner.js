'use strict';
/*
 * 审查脚本（第 72 条，仓库主人 2026-11-05 定的：不用子代理，脚本调 claude -p。内网报告看到子代理的时间几乎全花在一步步反复想上，单次请求 1～2 分钟）：
 *   run：算这一轮审什么（第一轮材料小的 1 个看全、大的 2～3 个角度，放不下分批；后面只审修改点），把材料和脚本查好的事实（review-facts.js）写进提示，
 *     每个角度起一个后台进程跑 claude -p（不带工具、关掉钩子），等结果。最多等 9 分钟，没审完返回 running，再跑一次接着等，不重开（Bash 工具单条命令最多 10 分钟，guard-commit 把这条命令的 timeout 改成 10 分钟）。
 *   worker：后台进程，一个角度一个。回复里没有 JSON（只想不答）重试一次，还没有算没交。交齐才合并入账。
 *   prepare（R.prepare）只备材料不起进程，测试和 VIBE_KIT_REVIEW_NO_RUN 用。
 * claude -p 的选项（第 73 条，实测见 docs/claude-code-facts.md）：--tools "" 关不掉用户配的 MCP，要加 --strict-mcp-config（不然启动时连它们，工具也带上）；
 *   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 少一个起标题的请求；CLAUDE_CODE_DISABLE_CLAUDE_MDS 不带全局约定（8K 字，全是写代码的规矩），项目约定和经验规则脚本自己放进提示。
 * 没有次数上限、文件上限，不收敛也不停。只有连续 3 次拿不到结论才不再催，也不算通过（flow-policy.js 的 halted）。
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
const Facts = require('./review-facts');
const { spawn, spawnSync } = require('child_process');
const secretFile = (f) => /(^|[\\/])(secrets\.json|router-data|\.env(?:\.[^/]*)?|db-crud\.ini|redis\.json|login\.json)([\\/]|$)/i.test(f);
function changeOf(cwd, name) { return name ? S.allChanges(cwd).find((c) => c.name.toLowerCase() === String(name).toLowerCase()) : null; }
// 不带变更名的审查按"项目 + 基线"算一次审查（#211：以前只按项目算，前一次不相干的审查把累计预算占掉了，这次一开始就超时）
function jobKey(cwd, name, mode, point, base) { const c = changeOf(cwd, name); const b = !c && base ? '|' + [].concat(base).filter(Boolean).join(',') : ''; return W.hash((c ? S.normKey(c.dir) : W.rootOf(cwd).toLowerCase() + b) + '|' + mode + (point ? '|' + point : '')).slice(0, 24); }
function baseline(j, dirs) {
  const cwd = j.cwd || process.cwd();
  S.updateState('work-baselines', (o) => {
    for (const dir of dirs) {
      // 同名变更归档后重建：旧基线不认（没有 born 的旧记录照认）
      const key = S.normKey(dir); const born = S.changeBorn(dir); if (o[key] && (!o[key].born || o[key].born === born)) continue;
      const roots = S.projectRootsOf(dir);
      o[key] = { at: Date.now(), born, session: j.session_id, repos: roots.map((root) => ({ root, ref: W.git(root, ['rev-parse', 'HEAD']).trim(), dirtyFiles: W.git(root, ['status', '--porcelain', '-z']).split('\0').filter(Boolean).map((l) => l.slice(3)) })).filter((r) => r.ref) };
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
  const items = [], skipped = [], uncovered = [], excluded = [], bases = [], files = new Set(), inputs = new Map(), currents = new Map(), outside = new Set(); let contextOnly = [];
  // current：这个文件现在的内容，下一轮拿来比改了什么（代码的 text 还带着基线差异）；role：只用来核对、不审它本身的材料；note：范围文件里的一句话
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
    // 用户点名审单份：只审那一份，前面的只用来核对是否对齐（问题表第 37 条）。审查点 tasks 审整套，四份都要审（第 57 条）
    const upstream = (f) => ['proposal', 'specs', 'design'].includes(opts.point) && !(opts.point === 'specs' ? /^specs[\\/]/.test(f) : f === opts.point + '.md');
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
    // 只收这个 change 的文件（第 77 条、#456，flow-policy.js 的 changeScope）：别的会话、别的变更在同一个仓库里没提交的改动不审。
    // 用户点名审某一组的按那一组点名的文件走（下面的 selected）；--all 不筛
    const policy = require('./flow-policy');
    const scope = change && !opts.all && (!opts.point || opts.point === 'change' || policy.isCross(opts.point)) ? policy.changeScope(change.dir) : null;
    let othersAll = 0;
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
      let inherited = 0; const others = [];
      for (const file of files) {
        if (/^(?:\.vibe|openspec)\//.test(file)) continue;
        // 整个 change 的审查：开工前就有改动、开工后没再动的文件不是这个 change 的（前面 change 没提交的改动就是这样，复审 20261105 第 2 条）
        if (opts.point === 'change' && saved && preexisting(file) && mtime(file) <= (saved.at || 0)) { inherited++; continue; }
        const f = path.join(root, file);
        if (scope && scope.known && !scope.has(f)) { others.push(file); outside.add(path.relative(opts.cwd, f).replace(/\\/g, '/')); continue; }
        if (opts.point && change) { const selected = require('./flow-policy').pointFiles(change.dir, opts.point); if (selected.length && !selected.some(p => S.normKey(p) === S.normKey(f))) continue; }
        const label = path.relative(opts.cwd, f).replace(/\\/g, '/'); const current = load(f, root, label, true);
        if (!current) continue; // 读取 Git 差异之前先查链接归属，避免 Git 跟随外部联接。
        const diff = W.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=5', base, '--', file]);
        let text = diff ? '基线差异：\n' + diff + '\n当前文件：\n' + current.text : current.missing ? '文件已删除' : current.text;
        const oldDirty = saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root));
        if (oldDirty && (oldDirty.dirtyFiles || []).includes(file)) text = '说明：该文件在开工前已有改动，不能全部认作本次助手改动。\n' + text;
        add(label, text, root, f, undefined, current.missing ? '' : current.text, current.missing ? '已删除' : oldDirty && (oldDirty.dirtyFiles || []).includes(file) ? '开工前已有改动，不能全部认作本次改动' : '');
      }
      if (inherited) excluded.push({ root, dirty: inherited, reason: '开工前就有改动、开工后没动过的文件，不算这个 change 的改动' });
      if (others.length) { othersAll += others.length; excluded.push({ root, others: others.length, files: others.slice(0, 20), reason: '不是这个 change 改的（它的任务、设计里没点名，做它的会话也没用编辑工具改过），不审。确实是这个 change 的：在 tasks.md 里点名，或者加 --all 按这个仓库的全部改动审' }); }
    }
    // 不带等号的 --base 一个仓库都不认得：是写错了，不当成缺基线
    for (const b of bare) if (!used.has(b)) throw new Error('审查基线 ' + b + ' 不是本地提交（这几个仓库里都没有）；几个仓库各写各的：' + hint);
    // 改过的文件都不算这个 change 的：说清楚，不报成"没有代码改动"
    if (change && !skipped.length && !items.length && !opts.docsOnly && othersAll) throw new Error('开工基线之后改过的 ' + othersAll + ' 个文件都不算这个 change 的（任务、设计里没点名，做它的会话也没用编辑工具改过）：' + excluded.flatMap((x) => x.files || []).slice(0, 8).join('、') + '。里面有这个 change 的：在 tasks.md 里点名再审，或者加 --all 按这个仓库的全部改动审；这个 change 本来就不改代码的，加 --docs-only');
    // 一个代码文件都没有：以前照样审，只审了需求文档也不说（第 71 条内网报告看到的：基线记晚了，改动在基线之前）
    if (change && !skipped.length && !items.length && !opts.docsOnly) throw new Error('没有代码改动可审：开工基线之后 ' + roots.map((r) => path.basename(r)).join('、') + ' 里没有改过的代码文件（openspec、.vibe 不算）。代码在开工基线之前就改了或提交了的，用 --base 指定改之前的提交：' + hint + '；这个 change 本来就不改代码的，加 --docs-only 再跑一次');
    if (change) for (const row of artifacts().filter((r) => !/revisions\.md$/.test(r.file))) add(row.file, row.text, change.dir, undefined, '需求文档');
  }
  const batches = []; let batch = [], size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) batches.push(batch);
  return { items, skipped, uncovered, excluded, bases, batches, contextOnly, inputs: [...inputs.values()], currents, outside };
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
/** claude -p 回复里的结论：JSON，可以包在代码块里、前后带话。不对就抛错，错误信息记下来 */
function parseResult(text) {
  const body = String(text || '');
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  let result;
  const fences = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse();
  for (const m of fences) { result = tryParse(m[1]); if (result !== undefined) break; }
  if (result === undefined) { const i = body.indexOf('{'); const k = body.lastIndexOf('}'); if (i >= 0 && k > i) result = tryParse(body.slice(i, k + 1)) || tryParse(repairJson(body.slice(i, k + 1))); }
  if (result === undefined) throw new Error('最后一条回复里没有能解析的 JSON');
  if (!result || !Array.isArray(result.issues) || result.issues.some((x) => !x || typeof x.file !== 'string' || typeof x.problem !== 'string' || typeof x.evidence !== 'string')) throw new Error('JSON 要有 issues 数组，每条都要有 file、problem、evidence 三个字符串');
  return { issues: R.tree(result.issues), summary: R.clip(result.summary || '', 1500), need: (Array.isArray(result.need) ? result.need : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 20).map((x) => R.clip(x, 300)) };
}
/** 模型写的 JSON 常见两种毛病：字符串里有裸换行、最后多一个逗号 */
function repairJson(t) {
  let out = ''; let inStr = false; let esc = false;
  for (const ch of String(t)) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
/** 模型执行接受问题时核对真人决定；手工 CLI 仍由执行者负责。 */
function decisionIssue(j) {
  const parser = require('../hooks/guard-commit'); const ps = j.tool_name === 'PowerShell';
  for (const group of parser.splitCommand(String(j.tool_input && j.tool_input.command || ''), ps)) for (const segment of group) {
    const ws = parser.words(parser.scanRedirects(segment).rest, ps).map((w) => w.text);
    if (ws.length < 3 || !/^node(?:\.exe)?$/i.test(path.basename(ws[0].replace(/\\/g, '/'))) || S.normKey(path.resolve(j.cwd, S.expandHome(ws[1]))) !== S.normKey(path.join(S.KIT, 'tools/review.js'))) continue;
    const val = (k) => { const i = ws.indexOf(k); return i < 0 ? '' : S.expandHome(ws[i + 1] || ''); }; const cwd = path.resolve(j.cwd, val('--project') || '.'); const change = changeOf(cwd, val('--change'));
    let action = '';
    // run 带 --decisions 也是登记（20261109 起）：一样要核对"接受不改"有没有用户的决定
    if (ws[2] === 'resolve' || (['run', 'prepare'].includes(ws[2]) && ws.includes('--decisions'))) { try { const d = JSON.parse(fs.readFileSync(path.resolve(j.cwd, val('--decisions')), 'utf8')); if ((d.findings || []).some((x) => x.action === 'accepted')) action = 'reviewAccept'; } catch (e) { return '意见处理文件无法核对，先检查 --decisions 文件'; } }
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
    // 每个角度的每次请求（第 83 条）：慢在模型那头（模型算的用时接近总用时）、卡在本机起进程、还是到 20 分钟上限被结束
    const fresh = findJob(job.id) || job;
    const callText = (c, i) => '第 ' + (i + 1) + ' 次 ' + sec(c.ms) + ' 秒' + (c.killed ? '（到 ' + Math.round(CALL_MS / 60000) + ' 分钟上限被结束）' : '') + (c.apiMs ? '，模型那头 ' + sec(c.apiMs) + ' 秒' : '') + (c.turns ? '、' + c.turns + ' 轮' : '') + '，提示 ' + Math.round((c.chars || 0) / 1000) + ' 千字、输出 ' + (c.out || 0) + ' token' + (c.err ? '，出错：' + c.err : '');
    const callsOf = (l) => { const a = ((fresh.state || {})[l] || {}).calls; const b = ((job.state || {})[l] || {}).calls; return (a && a.length ? a : b) || []; };
    const detail = job.lenses.map((l) => { const calls = callsOf(l); return calls.length ? l + '：' + calls.map(callText).join('；') : ''; }).filter(Boolean);
    const lines = ['审查模式 ' + job.mode + (job.point ? '，审查点 ' + job.point : '') + (job.change ? '' : '（不走 OpenSpec）') + (job.scoped ? '，只审修改点' : '，' + job.lenses.length + ' 个角度'),
      '总用时 ' + sec(result.spentMs) + ' 秒，配置页的预期用时 ' + sec(job.expectMs) + ' 秒' + (over ? '，超了 ' + sec(result.spentMs - job.expectMs) + ' 秒' : '，没超'),
      '每个角度：' + job.lenses.map((l) => l + (job.state[l].status === 'submitted' ? ' ' + sec(job.state[l].doneAt - job.started) + ' 秒' : ' 没交')).join('，'),
      '材料 ' + job.files + ' 个文件、' + Math.round(job.chars / 1000) + ' 千字；结果 ' + result.status].concat(detail.length ? ['每次请求（自动带上的）：'].concat(detail) : []);
    const title = over ? '审查超出预期用时（' + sec(result.spentMs) + ' 秒，预期 ' + sec(job.expectMs) + ' 秒）' : '审查有 ' + lost.length + ' 个角度没交结论';
    const sig = require('./feedback').sigOf(['review-report', job.mode, over ? 'over' : '', lost.length ? 'lost' : '']);
    return require('./feedback').record({ kind: lost.length ? '出错' : '建议', hook: 'review.js', source: '审查自动记录', title, what: lines.join('\n'), why: '审查做完对着配置页的预期用时自动核对（用户 2026-10-28 定的：不截断审查，超了分析用时和原因上报，用来优化审查）。', cwd: job.root, sig, note: lines[1] + (detail.length ? '；' + detail.join('；').slice(0, 900) : '') });
  } catch (e) { return null; } // 记不了不影响审查结果
}
/** 审完下一步怎么办，写在结果里（模型照着做，不用翻规范） */
function nextStep(result) {
  const text = nextText(result);
  return text && (result.need || []).length ? text + ' need 里是审查者想看、材料里没有的：能一两步查清的自己用 Grep、Read 查，查出问题按问题处理，查不清的写进交代，不用为它再审一轮。' : text;
}
function nextText(result) {
  if (result.status === 'stale') return '审查期间文件改过了，这一轮不算审完，但报的问题还要看。逐条核实、改完，再跑一次 review.js run：只审改过的地方，不用从头审。';
  if (!['completed', 'partial'].includes(result.status)) return '';
  if (result.status === 'partial') return '有材料没审到，不算审完：看 skipped 里的原因，处理完再跑一次 review.js run。';
  if (result.noChange) return '文件和上一轮审过的一样，这次不用审' + (result.blocking ? '；上一轮的 ' + result.blocking + ' 条 P1、P2 还没处理' : '') + '。用户要整份再审一遍，加 --full。';
  if (!result.issues.length) return '没有问题，这个点过了。';
  if (!result.blocking) return '只有 P3，这个点过了，不用再审。顺手能改的改了用 review.js resolve 登记 fixed，不想改的不用管。';
  return '有 ' + result.blocking + ' 条 P1、P2：逐条核实，成立的改，不成立的写依据（rejected）；提案、规格里被要求补的实现细节写进 design，不写进提案、规格。写好处理明细，跑 review.js run 加 --decisions <处理明细>（和这次一样的 --change、--mode、--point、--project）：先登记再复审，一条命令，下一轮只审改过的地方。' + (result.mode === 'code' ? '改代码时注释、日志只写业务上的原因，不写审查编号（r1 这类）、第几轮审查、工具的名字：同事看不懂。' : '');
}
const MODE_NAME = { proposal: '提案', code: '代码' };
const WORKER_MS = 45 * 60000; // 一个角度最多两次请求，一次最多 20 分钟
const CALL_MS = 20 * 60000;
const WAIT_MS = 9 * 60000; // Bash 工具单条命令最多 10 分钟，留点余量
const MAX_WORKERS = 3;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-');
const jobFolder = (job) => path.join(job.root, '.vibe', 'reviews', job.change || 'plain');
function findJob(id) { const o = S.readState('review-jobs'); for (const k of Object.keys(o)) if (o[k] && o[k].id === id) return o[k]; return null; }
const leftOf = (job) => job.lenses.filter((l) => job.state[l].status !== 'submitted');
/** 探索记录：这个变更属于大任务才有 */
function exploreOf(job) { try { const B = require('./big-task'); const t = job.change ? B.ofChange(job.root, (changeOf(job.root, job.change) || {}).dir || job.change) : null; return t && t.explore && fs.existsSync(t.explore) ? t.explore : ''; } catch (e) { return ''; } }
/** 一个角度的范围：审什么、按什么审。材料在 promptText 里拼上去 */
function scopeText(job, lens, plan, round, material) {
  const out = ['# 审查任务 ' + job.id + '/' + lens.name, '', '模式：' + (plan.scoped ? '复审' : '') + MODE_NAME[job.mode], '变更：' + (job.change || '（不走 OpenSpec）'), '项目：' + job.root];
  if (job.point) out.push('审查点：' + job.point);
  out.push('', '## 要求', '', Sc.requirements(round, job.mode, lens.text));
  if (round.cross) out.push('', '## 来源的修改点', '', '这次只审下面这处修改对这个 change 的影响：这个 change 依赖它的地方有没有跟着改、还对不对。别的不审。', '', round.cross);
  const explore = exploreOf(job);
  if (explore) out.push('', '## 探索记录', '', explore + '（读公共几节' + (job.change ? '和 ' + job.change + ' 那一节' : '') + '：范围、定了的都在里面）');
  if (plan.scoped) {
    // 复审也可能很大（#425：57 个文件 147 万字进了一个请求）：分批时每批只带自己的那些文件
    const items = lens.items || plan.items;
    const names = new Set(items.map((x) => String(x.file)));
    // 文件名对不上材料的"修了"（#420）：放在第一批里核对
    const loose = (x) => !material.currents.has(String(x.file)) && (!lens.items || lens.first);
    out.push('', '## 上一轮的问题', '', '```json', JSON.stringify((plan.open || []).filter((x) => names.has(String(x.file)) || loose(x)), null, 1), '```');
    if ((plan.closed || []).length) out.push('', '## 已处理', '', '```json', JSON.stringify(plan.closed, null, 1), '```');
    if (lens.text) out.push('', lens.text);
    out.push('', '## 这次改过的地方');
    for (const it of items) out.push('', '### ' + it.file + (it.role ? '（' + it.role + '）' : '') + (it.note ? ' — ' + it.note : ''), '', '路径：' + (it.source || it.file), '', '```', it.text, '```');
  } else {
    if ((round.carry || []).length) out.push('', '## 上游审查留给这一步的要点', '', '这一步要覆盖到，没覆盖到的报 P2：', '', '```json', JSON.stringify(round.carry, null, 1), '```');
    const areas = areasOf(job, material, round);
    if (areas.length) out.push('', '## 这次涉及的目录', '', areas.join('、'), '', '这些目录之外不主动看：要审的内容直接调用到的地方，只读调用的那几行。框架和基础设施（登录鉴权、网关、ORM、基类）不读实现。');
    if (round.paths && (round.paths.found.length || round.paths.missing.length || round.paths.context)) out.push('', '## 脚本核过的路径', '', '这些不用再开文件确认在不在。要核对的是文档说它里面是什么样：只开点名的文件，读相关的那一段，不顺着往外找。', '', '- 在：' + (round.paths.found.join('、') || '无') + (round.paths.context ? '；design 现状里列的探索路径 ' + round.paths.context + ' 个也都在，不用开' : ''), '- 不在（文档提到了，又没写新建）：' + (round.paths.missing.join('、') || '无'));
    out.push('', '## 要审的文件', '');
    for (const [file, cur] of material.currents) out.push('- ' + file + (cur.role ? '（' + cur.role + '，只用来核对）' : '') + (cur.note ? '（' + cur.note + '）' : '') + (cur.source && cur.source !== file ? '：' + cur.source : ''));
    if ((material.bases || []).length) out.push('', '基线：' + material.bases.map((b) => b.root + ' 的 ' + b.ref).join('；') + '。改动用 `git -C <仓库> diff <基线> -- <文件>` 看，新文件整个读。');
  }
  if ((material.uncovered || []).length) out.push('', '## 没进审查的（不用看）', '', ...material.uncovered.map((x) => '- ' + x.file + '：' + x.reason));
  return out.join('\n') + '\n';
}
/** 这次涉及的目录（第 70 条）：要审的代码文件、文档点名的文件所在的目录，给子代理划边界。不含 openspec、.vibe */
function areasOf(job, material, round) {
  const files = round.paths ? round.paths.found : [...material.currents.entries()].filter(([, cur]) => !cur.role).map(([f]) => f);
  const dirs = new Set();
  for (const f of files) { const d = path.dirname(String(f).replace(/\\/g, '/')); if (d && d !== '.' && !/(^|\/)(openspec|\.vibe)(\/|$)/.test(d)) dirs.add(d); }
  return [...dirs].sort().slice(0, 15);
}
/**
 * 文档点名的路径，脚本先核一遍（第 64 条）：在不在是能确定判断的，不用子代理一个个开文件。这个变更里任一处写明新建的不算不在；revisions.md 记的是历史，不算。
 * design 现状里列的是探索时读过的（contextOnly）：不逐个列、不算涉及的目录，只报个数（第 70 条：列出来等于把边界放宽；不在的照样报）
 */
function pathFacts(change, contextOnly) {
  const roots = S.projectRootsOf(change.dir).concat(change.dir);
  const found = new Set(); const missing = new Set(); const seen = new Set();
  const key = (t) => String(t).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const context = new Set((contextOnly || []).map(key));
  const declared = S.declaredNew(change.dir, '');
  for (const f of S.artifactFiles(change.dir).filter((x) => !/revisions\.md$/.test(x))) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const l of text.split(/\r?\n/)) for (const t of S.pathTokens(l)) { if (S.pathExists(t, roots)) { if (context.has(key(t))) seen.add(key(t)); else found.add(t); } else if (!S.NEW_FILE.test(l) && !declared(t)) missing.add(t); }
  }
  return { found: [...found].slice(0, 40), missing: [...missing].slice(0, 40), context: seen.size };
}
/** 这一轮还要跑的角度：没起的、没交结论的（已交的、正在跑的不重开） */
function pendingOf(job) {
  const open = job.lenses.filter((l) => !['submitted', 'sent'].includes(job.state[l].status));
  const sent = job.lenses.filter((l) => job.state[l].status === 'sent');
  return { status: 'prepared', id: job.id, round: job.round, scope: job.scoped ? 'changes' : 'full', lenses: job.lenses, running: sent, pending: open.map((l) => ({ lens: l, scope: path.join(job.dir, safeName(l) + '.md') })) };
}
/** 备一轮审查：不发请求。输入没变就复用同一个任务、不加轮数 */
function prepare(opts) {
  opts = Object.assign({ cwd: process.cwd(), mode: 'code' }, opts); opts.cwd = path.resolve(opts.cwd);
  if (!['proposal', 'code'].includes(opts.mode)) throw new Error('审查模式只能是 proposal 或 code');
  // #197：不走 OpenSpec 的小修复，模型编了一个变更名。报错里说清不带 --change 的写法
  const change = changeOf(opts.cwd, opts.change); if (opts.change && !change) throw new Error('没找到当前变更 ' + opts.change + '（' + opts.cwd + ' 的 openspec/changes 里没有这个变更）。不走 OpenSpec 的改动不带 --change，按改之前的提交审：review.js prepare --mode code --project ' + opts.cwd.replace(/\\/g, '/') + ' --base <改之前的提交>');
  const key = jobKey(opts.cwd, opts.change, opts.mode, opts.point, opts.base); const cfg = S.readConfig();
  const policy = require('./flow-policy');
  if (opts.point && (!change || !policy.reviewable(change.dir, opts.mode).includes(opts.point))) throw new Error('审查点 ' + opts.point + ' 现在还不能审：需求文档用 tasks（四份写完审整套），代码用 change（这个 change 的任务全部做完审整个 change）；用户点名审单份文档、某一组的，那一份要写好、那一组要做完');
  // 这个 change 还没记过改了哪些文件（升级前开的工）：把当前会话记录里用编辑工具改过的补进去（第 77 条）。要在算指纹之前：指纹和材料用同一个范围
  if (change && opts.mode === 'code' && !opts.all) {
    try {
      const rec = S.readState('change-files')[S.normKey(change.dir)];
      if (!(rec && rec.born === S.changeBorn(change.dir) && (rec.files || []).length)) {
        const E = require('./edited-files'); const s = E.findSession({ cwd: opts.cwd, marker: /review\.js/ });
        if (s && s.transcript) policy.learnEdits(change.dir, E.editedFiles(E.entriesOf(s.transcript), opts.cwd).map((x) => x.abs));
      }
    } catch (e) { /* 认不出是哪个会话：只按点了名的和记过的算 */ }
  }
  const pointHash = opts.point ? policy.fingerprint(change.dir, opts.point) : '';
  const before = W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all');
  const input = pointHash || before.hash;
  const old = S.readState('review-jobs')[key];
  // 提示文件不全的（升级前子代理那一轮）不接着用
  const promptsThere = (j) => j.lenses.every((l) => j.state[l].status === 'submitted' || fs.existsSync(path.join(j.dir, safeName(l) + '.prompt.md')));
  if (old && old.status === 'running' && old.lenses && !opts.full && old.input === input && Date.now() < old.deadline && fs.existsSync(old.dir) && promptsThere(old)) if (leftOf(old).length) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === old.id) o[key].tries = (o[key].tries || 0) + 1; }); old.tries = (old.tries || 0) + 1; return pendingOf(old); } else return finish(old.id);
  // 这个变更（这个模式）上一轮还有审查在跑（第 59 条）：不开新的一轮。开了旧的没人管，白占额度，结论回来也作废
  // 只看同一个审查点（#426、#428：以前别的审查点的进程活着也算"上一轮在跑"，看这个点的 status 却是失败，取消了才解开）
  const liveJobs = Object.values(S.readState('review-jobs')).filter((x) => x && x.status === 'running' && x.state && x.mode === opts.mode && (x.change || '') === (opts.change || '') && (x.point || '') === (opts.point || '') && S.normKey(x.root) === S.normKey(opts.cwd) && Object.values(x.state).some(alive));
  if (liveJobs.length) {
    const names = liveJobs.flatMap((x) => Object.entries(x.state).filter(([, s]) => alive(s)).map(([l, s]) => (x.point || x.mode) + ' ' + l + '（进程 ' + (s.pid || '刚起') + '，已跑 ' + Math.round((Date.now() - (Number(s.sentAt) || Date.now())) / 60000) + ' 分钟）'));
    const cancel = 'review.js cancel' + (opts.change ? ' --change ' + opts.change : '') + ' --mode ' + opts.mode + (opts.point ? ' --point ' + opts.point : '') + ' --project ' + String(opts.cwd).replace(/\\/g, '/');
    return { status: 'running', running: names, next: '上一轮还有 ' + names.length + ' 个审查在跑（' + names.join('、') + '），这次不开新的一轮。等一会儿再跑一次 review.js run；这期间文档或代码改过的，那一轮结论会作废（stale），只审改过的地方。用户要现在重开：' + cancel + '，再 run。' };
  }
  if (old && old.dir) { try { fs.rmSync(old.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) { /* 占着就算了 */ } }
  pruneJobDirs(path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'));
  const id = crypto.randomBytes(12).toString('hex'); const started = Date.now();
  // 配置页的"审查预期用时"：不到点截断（用户 2026-10-28 定的），审完超了就记问题反馈。--budget 给了就按它算这一次的预期
  const expectMs = Math.min(1800, Math.max(10, Number(opts.budgetSeconds || cfg.reviewBudgetSeconds) || 300)) * 1000;
  const folder = path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'); const file = path.join(folder, opts.mode + (opts.point ? '-' + opts.point : '') + '.json');
  const born = change ? S.changeBorn(change.dir) : 0;
  if (change && opts.point) policy.begin(change.dir, opts.point, id, pointHash);
  const job = { id, key, mode: opts.mode, change: opts.change || '', point: opts.point || '', root: opts.cwd, base: opts.base, status: 'running', started, deadline: started + 6 * 3600000, expectMs, fingerprint: before.hash, pointHash, input, dir: path.join(folder, 'job-' + id), file, lenses: [], state: {}, decided: opts.decided || '' };
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
    const lenses = noChange ? [] : plan.scoped ? [{ name: '复审', text: '' }] : policy.isCross(opts.point) ? [{ name: '修改点', text: '' }] : Sc.lensesFor(opts.mode, material.batches.length, cfg, Facts.reviewChars(material.items));
    let list = lenses.length || noChange ? lenses : [{ name: '全量', text: '' }];
    // 一个请求放不下：分批，每批一个请求，一个人看全几个角度。放得下就是一批，每个角度都看全部材料
    const packs = !plan.scoped && !noChange ? Facts.packsOf(material.items) : [];
    if (packs.length > 1) list = packs.map((pack, i) => ({ name: '第' + (i + 1) + '批', text: '材料太多分了 ' + packs.length + ' 批，这是第 ' + (i + 1) + ' 批，你一个人看全所有角度，只报这一批里的问题。' }));
    // 复审放不下也分批（#425：以前复审不分，147 万字一个请求，想到 128000 token 上限也没交结论）
    const scopedPacks = plan.scoped && !noChange ? Sc.batchesOf(plan.items, Facts.REQUEST_CHARS) : [];
    if (scopedPacks.length > 1) list = scopedPacks.map((items, i) => ({ name: '复审第' + (i + 1) + '批', items, first: i === 0, text: '改动太多分了 ' + scopedPacks.length + ' 批，这是第 ' + (i + 1) + ' 批：只核对这一批里的文件和写它们的"上一轮的问题"，只报这一批里的问题。' }));
    job.lenses = list.map((l) => l.name);
    for (const l of job.lenses) job.state[l] = { status: 'open' };
    job.files = material.currents.size; job.chars = material.items.reduce((n, x) => n + x.text.length, 0);
    const currents = {}; for (const [f, cur] of material.currents) currents[f] = { text: cur.text, source: cur.source };
    fs.mkdirSync(job.dir, { recursive: true });
    if (!store.atomicWrite(path.join(job.dir, 'plan.json'), { scoped: job.scoped, why: plan.why, noChange, open: plan.open, closed: plan.closed, carried: plan.carried, dropped: plan.dropped, kept: plan.kept, changed: plan.changed, itemFiles: plan.scoped ? [...new Set(plan.items.map((x) => x.file))] : [], currents, skipped: material.skipped, uncovered: material.uncovered, excluded: material.excluded, contextOnly: material.contextOnly, materialInputs: material.inputs, deferred: Sc.deferredOf(prevRound), born, fingerprintNote: before.truncated ? '这个目录不是 git 仓库，文件太多，只核对了前面的文件：后面的文件改了认不出来，"审查后输入没变"对它们不作数' : undefined })) throw new Error('审查材料写不进 ' + job.dir);
    const round = { stage: Sc.stageText(opts.mode, opts.point), scoped: job.scoped, carry: !plan.scoped && opts.point === 'design' ? Sc.carryover(folder, ['proposal', 'specs']) : !plan.scoped && opts.point === 'tasks' ? Sc.carryover(folder, ['proposal', 'specs', 'design']) : [], cross: policy.isCross(opts.point) ? policy.crossText(change.dir, opts.point) : '', paths: !plan.scoped && opts.mode === 'proposal' && change ? pathFacts(change, material.contextOnly) : null };
    const facts = !plan.scoped && !noChange ? safeFacts(opts, material) : '';
    list.forEach((l, i) => {
      const scope = scopeText(job, l, plan, round, material);
      fs.writeFileSync(path.join(job.dir, safeName(l.name) + '.md'), scope);
      fs.writeFileSync(path.join(job.dir, safeName(l.name) + '.prompt.md'), promptText(job, scope, plan.scoped ? null : (packs.length > 1 ? packs[i] : packs[0] || []), facts));
    });
    S.updateState('review-jobs', (o) => { o[key] = job; });
    if (noChange) return finish(id);
    return pendingOf(job);
  } catch (e) {
    const result = { id, mode: opts.mode, status: 'failed', issues: [], covered: [], skipped: [], reason: R.clip(e.message, 500), at: Date.now(), spentMs: 0 };
    S.updateState('review-jobs', (o) => { o[key] = Object.assign(job, result); });
    if (change && opts.point) policy.noteResult(change.dir, opts.point, result, pointHash);
    return result;
  }
}
/** 没收尾留下的任务目录（子代理时期的、中途退出的）：一天以前的删掉。里面是范围文件和文件全文 */
function pruneJobDirs(folder) {
  let list = []; try { list = fs.readdirSync(folder, { withFileTypes: true }); } catch (e) { return; }
  const running = new Set(Object.values(S.readState('review-jobs')).filter((x) => x && x.status === 'running' && x.dir).map((x) => S.normKey(x.dir)));
  for (const e of list) {
    if (!e.isDirectory() || !/^job-[0-9a-f]+$/.test(e.name)) continue;
    const d = path.join(folder, e.name);
    try { if (!running.has(S.normKey(d)) && Date.now() - fs.statSync(d).mtimeMs > 86400000) fs.rmSync(d, { recursive: true, force: true }); } catch (x) { /* 占着就算了 */ }
  }
}
function safeFacts(opts, material) { try { return Facts.factsOf(opts.mode, material.items, opts.cwd, (material.bases || []).map((b) => b.root)); } catch (e) { return ''; } }
/** 审查的规矩里只留这一轮用得上的模式 */
function rulesFor(rules, job) {
  const keep = job.scoped ? '复审模式' : job.mode === 'proposal' ? '提案模式' : '代码模式';
  return rules.split(/^(?=## )/m).filter((s) => { const m = /^## (复审模式|提案模式|代码模式)/.exec(s); return !m || m[1] === keep; }).join('');
}
/** 项目约定和经验规则：不带全局约定（CLAUDE_CODE_DISABLE_CLAUDE_MDS），这些脚本自己放进去 */
function conventionsOf(root) {
  const parts = [];
  const take = (name, cap) => { try { const t = fs.readFileSync(path.join(root, name), 'utf8'); if (t.trim()) parts.push('=== ' + name.split(path.sep).join('/') + ' ===\n' + R.material(t).slice(0, cap)); } catch (e) { /* 没有 */ } };
  take('CLAUDE.md', 8000); take(path.join('.vibe', 'project.md'), 8000); take(path.join('openspec', 'config.yaml'), 4000);
  try { let left = 12000; for (const n of fs.readdirSync(path.join(root, '.claude', 'rules')).filter((x) => /^vk-lessons-.*\.md$/.test(x)).sort()) { if (left <= 0) break; take(path.join('.claude', 'rules', n), left); left -= parts[parts.length - 1].length; } } catch (e) { /* 没有 */ }
  return parts.length ? '## 项目约定和经验规则\n\n' + parts.join('\n\n') : '';
}
/** 发给 claude -p 的全文：审查的规矩、项目约定、范围（要求、上一轮的问题）、材料、脚本查好的事实 */
function promptText(job, scope, pack, facts) {
  let rules = ''; try { rules = fs.readFileSync(path.join(S.KIT, 'review-prompt.md'), 'utf8'); } catch (e) { rules = '你是审查者，只读不改，找出会在什么情况下出错。最后只回一个 JSON：{"issues":[{"severity":"P2","file":"路径","line":1,"problem":"一句话","evidence":"具体输入和错误结果","scope":"in"}],"need":[],"summary":""}'; }
  const parts = [rulesFor(rules, job).trim(), scope.trim()];
  const conventions = conventionsOf(job.root);
  if (conventions) parts.push(conventions);
  if (pack) {
    parts.push('## 材料\n\n' + pack.map(Facts.renderEntry).join('\n\n'));
    const explore = exploreOf(job);
    if (explore) { try { parts.push('## 探索记录全文\n\n' + R.material(fs.readFileSync(explore, 'utf8')).slice(0, 60000)); } catch (e) { /* 读不了 */ } }
  }
  if (facts) parts.push(facts);
  return parts.join('\n\n') + '\n';
}
function claudeExe() {
  if (process.env.VIBE_KIT_CLAUDE_EXE) return process.env.VIBE_KIT_CLAUDE_EXE;
  const own = process.env.CLAUDE_CODE_EXECPATH; // Claude Code 给子进程的：它自己。npm 装的可能是 node，不算
  return own && /claude[^\\/]*$/i.test(path.basename(own)) ? own : 'claude';
}
/**
 * 跑一次 claude -p：不带工具、关掉钩子（不然套件的流程检查掺进来）、不留会话记录。
 * 不指定模型，用用户默认的（仓库主人 2026-11-09 定的，替代第 63 条的 sonnet：#427 那台的网关把 sonnet 映射成它不认的名字）
 */
function askClaude(prompt, cwd, settings) {
  const exe = claudeExe();
  const raw = ['-p', '--output-format', 'json', '--settings', settings, '--no-session-persistence', '--system-prompt', 'You are a code and requirements reviewer. Read only, change nothing. Write your findings in Chinese.', '--tools', '', '--strict-mcp-config'];
  const useShell = process.platform === 'win32' && !/\.exe$/i.test(exe);
  // shell:true 时 Node 只把参数拼起来：空参数和带空格的自己加引号
  const a = useShell ? raw.map((x) => (x === '' ? '""' : /[\s"&|<>^]/.test(x) ? '"' + x.replace(/"/g, '\\"') + '"' : x)) : raw;
  const env = Object.assign({}, process.env, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }); delete env.CLAUDECODE;
  const t0 = Date.now();
  const r = spawnSync(useShell && /\s/.test(exe) ? '"' + exe + '"' : exe, a, { input: prompt, cwd, env, encoding: 'utf8', windowsHide: true, shell: useShell, timeout: CALL_MS, maxBuffer: 128 * 1024 * 1024 });
  const ms = Date.now() - t0; const killed = !!(r.error && r.error.code === 'ETIMEDOUT') || (!!r.signal && ms >= CALL_MS - 5000);
  let j = null; try { j = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { /* 下面报 */ }
  const u = (j && j.usage) || {};
  return { ms, killed, apiMs: (j && Number(j.duration_api_ms)) || 0, turns: (j && Number(j.num_turns)) || 0, chars: String(prompt).length, text: j ? String(j.result || '') : '', out: u.output_tokens || 0, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), err: j ? (j.is_error ? R.clip(String(j.result || j.subtype || ''), 200) : '') : R.clip(String(r.stderr || (r.error && r.error.message) || r.stdout || '没有输出'), 200) };
}
/** 后台进程：一个角度。回复里没有 JSON（只想不答）重试一次 */
function work(id, lens) {
  const job = findJob(id);
  if (!job || job.status !== 'running' || !job.state[lens]) return;
  const file = path.join(job.dir, safeName(lens) + '.prompt.md');
  const settings = path.join(job.dir, 'claude-settings.json');
  let why = '';
  try {
    fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
    const prompt = fs.readFileSync(file, 'utf8');
    for (let i = 0; i < 2; i++) {
      // 第二次：上一次只想没答，提示它直接交
      const r = askClaude(i ? prompt + '\n上一次你只想没有回结论。这次不要再分析，直接按上面的格式回 JSON。\n' : prompt, job.root, settings);
      S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === id && cur.state[lens]) { cur.state[lens].out = (cur.state[lens].out || 0) + r.out; cur.state[lens].input = (cur.state[lens].input || 0) + r.input; cur.state[lens].calls = (cur.state[lens].calls || []).concat({ ms: r.ms, killed: r.killed, apiMs: r.apiMs, turns: r.turns, out: r.out, chars: r.chars, err: r.err ? R.clip(r.err, 80) : '' }).slice(-4); } });
      if (r.err) { why = 'claude -p 出错：' + r.err; if (!r.text) break; }
      const s = submit(id, lens, r.text);
      if (s.ok) return;
      why = s.error + (r.out ? '（输出 ' + r.out + ' token，回复 ' + r.text.length + ' 字）' : '');
    }
  } catch (e) { why = (e && e.message) || String(e); }
  failLens(id, lens, why || '没拿到结论');
}
function startWorker(job, lens) {
  S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === job.id && cur.state[lens]) cur.state[lens] = { status: 'sent', sentAt: Date.now() }; });
  try {
    const child = spawn(process.execPath, [path.join(S.KIT, 'tools', 'review.js'), 'worker', job.id, lens], { detached: true, windowsHide: true, stdio: 'ignore', cwd: job.root, env: process.env });
    child.on('error', () => { /* 下面 pid 是空的，等不到结果算没交 */ });
    child.unref();
    if (!child.pid) { failLens(job.id, lens, '审查进程起不来'); return; }
    S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === job.id && cur.state[lens] && cur.state[lens].status === 'sent') cur.state[lens].pid = child.pid; });
  } catch (e) { failLens(job.id, lens, '审查进程起不来：' + ((e && e.message) || e)); }
}
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 等不了就接着 */ } };
/** 审一轮：备材料、起后台进程、等结果。最多等 waitSeconds，没审完返回 running，再跑一次接着等 */
function run(opts) {
  opts = Object.assign({ cwd: process.cwd(), mode: 'code' }, opts); opts.cwd = path.resolve(opts.cwd);
  // 带 --decisions：先登记处理结果，有要复审的接着审，一条命令（第 71 条第 1 点，仓库主人 2026-11-09 选的：以前 resolve、run 各一次请求）
  let resolved = null;
  // 同一份处理明细已经登记过（返回 running 后再跑一次一样的命令）：不再登记，接着等
  if (opts.decisions && !decisionsDone(opts)) {
    const r = resolve(opts);
    let fixed = false; try { fixed = (JSON.parse(fs.readFileSync(opts.decisions, 'utf8')).findings || []).some((x) => x.action === 'fixed'); } catch (e) { fixed = false; }
    resolved = { status: r.status, count: r.count };
    try { require('./usage').bump('review.decisions'); } catch (e) { /* 数不了不影响 */ }
    if (!(r.status === 'needs_review' || (!opts.change && fixed))) return Object.assign({}, r, { resolved, next: '登记好了，没有要复审的，这个点处理完了。' });
    opts.decided = decisionsSig(opts.decisions);
  }
  const out = waitRound(opts);
  if (resolved && out && typeof out === 'object') out.resolved = resolved;
  return out;
}
function decisionsSig(file) { try { return W.hash(fs.readFileSync(file, 'utf8')).slice(0, 16); } catch (e) { return ''; } }
/** 这份处理明细登记过了：这一轮就是拿它开的（记在任务上），或者和审查点上记着的决定一样 */
function decisionsDone(opts) {
  try {
    const job = S.readState('review-jobs')[jobKey(opts.cwd, opts.change, opts.mode, opts.point, opts.base)];
    if (job && job.decided && job.decided === decisionsSig(opts.decisions)) return true;
    const sig = (arr) => JSON.stringify((arr || []).map((x) => [x.id, x.action]).sort());
    const mine = JSON.parse(fs.readFileSync(opts.decisions, 'utf8')).findings || [];
    const change = changeOf(opts.cwd, opts.change);
    const rec = change && opts.point ? require('./flow-policy').record(change.dir, opts.point) : change ? S.reviewRecord(opts.mode === 'proposal' ? 'proposal' : 'code', change.dir) : readJson(path.join(opts.cwd, '.vibe', 'reviews', 'plain', 'code.json'));
    return !!rec && Array.isArray(rec.decisions) && rec.decisions.length > 0 && sig(rec.decisions) === sig(mine);
  } catch (e) { return false; }
}
function waitRound(opts) {
  const p = prepare(opts);
  if (p.status !== 'prepared') return p;
  const key = jobKey(opts.cwd, opts.change, opts.mode, opts.point, opts.base);
  const queue = (p.pending || []).map((a) => a.lens);
  const limit = Date.now() + (Number(opts.waitSeconds) > 0 ? Number(opts.waitSeconds) * 1000 : WAIT_MS);
  for (;;) {
    const job = S.readState('review-jobs')[key];
    if (!job || job.id !== p.id) return { status: 'cancelled', reason: '这一轮被取消或者换掉了' };
    if (job.status !== 'running') { return job; }
    for (const l of job.lenses) { const s = job.state[l]; if (s.status === 'sent' && !alive(s)) failLens(job.id, l, '审查进程没了，没交结论'); }
    const now = S.readState('review-jobs')[key] || job;
    const busy = now.lenses.filter((l) => now.state[l].status === 'sent').length;
    for (let i = busy; i < MAX_WORKERS && queue.length; i++) startWorker(now, queue.shift());
    const fresh = S.readState('review-jobs')[key] || now;
    if (fresh.status === 'running' && !queue.length && !fresh.lenses.some((l) => fresh.state[l].status === 'sent')) {
      if (!leftOf(fresh).length) return finish(fresh.id);
      const lost = fresh.lenses.filter((l) => fresh.state[l].status === 'failed').map((l) => l + '：' + (fresh.state[l].why || '没交结论'));
      return { status: 'failed', id: fresh.id, lost, reason: lost.join('；'), next: '有角度没拿到结论，不算审完。再跑一次 review.js run 只补没交的；连续 3 次没拿到就不再催，写进交代。' };
    }
    if (Date.now() >= limit) return { status: 'running', id: fresh.id, lenses: fresh.lenses, left: leftOf(fresh), next: '还在审。再跑一次一样的 review.js run 接着等，不会重开；这期间不要改文件。' };
    pause(1500);
  }
}
// 后台进程在就算活着（有个上限，防进程号被复用）。还没有进程号的是刚起的，一小会儿没有就算没了；升级前子代理留下的记录也走这条
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
// 重启之前起的（sentAt 比这次开机早）：进程号可能被别的程序占了，不看进程号（第 80 条）
const alive = (s) => !!s && s.status === 'sent' && !store.beforeBoot(s.sentAt) && (s.pid ? pidAlive(s.pid) && Date.now() - (Number(s.sentAt) || 0) < WORKER_MS : Date.now() - (Number(s.sentAt) || 0) < 30000);
/** 这个角度是电脑重启打断的：不算一次没拿到结论（不进连续 3 次的数），也不记审查超时 */
const rebooted = (s) => !!s && s.status === 'sent' && store.beforeBoot(s.sentAt);
/** 交结论（后台进程调）。JSON 不对返回 { ok: false, error }；同一角度只算一次；交齐了合并入账 */
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
/** 这个角度算没交：下一次 prepare 只重开它。连续 3 次没交就不再催（flow-policy 的 halted），不算通过 */
function failLens(id, lens, why) {
  const job = findJob(id); if (!job || job.status !== 'running' || !job.state[lens] || job.state[lens].status === 'submitted') return;
  const boot = rebooted(job.state[lens]);
  S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === id) cur.state[lens] = { status: 'failed', why: R.clip(boot ? '电脑重启过，这个角度被打断了' : why, 300), at: Date.now(), reboot: boot || undefined, calls: cur.state[lens].calls }; });
  if (boot) return;
  const change = job.change ? changeOf(job.root, job.change) : null;
  if (change && job.point) require('./flow-policy').noteFail(change.dir, job.point, job.id + ':' + (job.tries || 0));
  try { require('./usage').bump('review.lost'); } catch (e) { /* 数不了就算了 */ }
  reportReview({ spentMs: Date.now() - job.started, status: 'running' }, Object.assign({}, job, { state: Object.assign({}, job.state, { [lens]: { status: 'failed' } }) }));
}
/** 后台进程没了、没交结论的角度记成没交（Claude Code 退出过、机器重启过） */
function sweep(cwd) {
  const root = S.normKey(path.resolve(cwd));
  const jobs = S.readState('review-jobs');
  for (const k of Object.keys(jobs)) {
    const job = jobs[k];
    if (!job || job.status !== 'running' || !job.lenses || !job.state || !(S.underDir(job.root, root) || S.underDir(root, job.root))) continue;
    for (const l of job.lenses) if (job.state[l] && job.state[l].status === 'sent' && !alive(job.state[l])) failLens(job.id, l, '审查进程没了，没交结论');
  }
}
/** 这个变更（这个模式）有角度正在跑：别催、别再开 */
function inFlight(dir, mode) {
  const name = path.basename(dir); const jobs = S.readState('review-jobs');
  // 进程还活着才算在跑：进程没了还记着"发出去了"的（Claude Code 结束命令时连后台进程一起结束了），不挡提交、不让收工钩子干等
  return Object.values(jobs).some((job) => job && job.status === 'running' && job.state && job.change.toLowerCase() === name.toLowerCase() && (!mode || job.mode === mode) && S.normKey(path.join(job.root, 'openspec', 'changes', job.change)) === S.normKey(dir) && Object.values(job.state).some(alive));
}
/** 角度交齐：合并、入账、写快照和审查记录 */
function finish(id) {
  const job = findJob(id);
  if (!job) return { status: 'cancelled', reason: '迟到结果已忽略' };
  // 后台进程交完最后一个角度在入账，run 的等待循环、status 同时也可能走到这里：只让一个入账（第 72 条全量回归抓到的：入账两次，第二次报错）
  let mine = false;
  S.updateState('review-jobs', (o) => { const cur = o[job.key]; if (cur && cur.id === id && cur.status === 'running' && !(Date.now() - (Number(cur.finalizer) || 0) < 120000)) { cur.finalizer = Date.now(); mine = true; } });
  if (!mine) {
    for (let i = 0; i < 240; i++) { const cur = findJob(id); if (!cur || cur.status !== 'running') return cur || { status: 'cancelled', reason: '迟到结果已忽略' }; pause(500); }
    return { status: 'running', id, next: '还在入账，再跑一次一样的 review.js run。' };
  }
  const policy = require('./flow-policy');
  const change = job.change ? changeOf(job.root, job.change) : null;
  const plan = readJson(path.join(job.dir, 'plan.json')) || {};
  const folder = jobFolder(job);
  const groups = job.lenses.map((l) => readJson(path.join(job.dir, 'result-' + safeName(l) + '.json')) || { issues: [] });
  const need = [...new Set(groups.flatMap((g) => g.need || []))];
  const labels = Object.keys(plan.currents || {});
  // 审查者写的文件名对到材料的名字：相对项目的、带行号的也认（#420）
  const labelOf = (f) => Sc.matchLabel(f, plan.currents || {});
  let issues = Sc.mergeIssues(groups.map((g) => g.issues.map((x) => Object.assign({}, x, { file: labelOf(x.file) }))));
  // 需求和探索记录里没有的（scope: out）不算问题：不挡通过、不触发复审，人工核验时列给用户（第 43 条）
  const outside = issues.filter((x) => /^out$/i.test(String(x.scope || '')));
  issues = issues.filter((x) => !/^out$/i.test(String(x.scope || '')));
  const result = { id, mode: job.mode, status: 'failed', issues, covered: [], skipped: plan.skipped || [], uncovered: plan.uncovered || [], excluded: plan.excluded, contextOnly: plan.contextOnly, materialInputs: plan.materialInputs, scope: job.scoped ? 'changes' : 'full', round: job.round, lenses: job.lenses.length || 1, expectSeconds: job.expectMs / 1000, summary: groups.map((g) => g.summary).filter(Boolean).join('\n') };
  if (need.length) result.need = need;
  const tokens = job.lenses.reduce((o, l) => ({ out: o.out + (Number(job.state[l].out) || 0), input: o.input + (Number(job.state[l].input) || 0) }), { out: 0, input: 0 });
  if (tokens.out || tokens.input) result.tokens = tokens;
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
    // 上一轮记在别的会话、别的变更的文件上的问题：那些文件现在不算这个 change 的，问题不带了（第 77 条）
    if ((plan.dropped || []).length) result.droppedOthers = plan.dropped.length;
  } else result.covered = labels;
  if (outside.length) {
    result.suggestions = outside.map((x) => ({ file: x.file, problem: x.problem }));
    try { const B = require('./big-task'); const task = job.change ? B.ofChange(job.root, (changeOf(job.root, job.change) || {}).dir || job.change) : null; if (task) for (const x of outside) B.addSuggestion(task, x.file + '：' + x.problem, '审查 ' + (job.point || job.mode)); } catch (e) { /* 记不了：结果里还有 */ }
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
  // 这一轮审成了才留作下一轮的比较对象。审查期间文件变了（stale）也留（第 65 条）：审的是发出去时的内容，问题还在，下一轮比这份、只审改过的地方。
  // 以前不留，第一个角度回来模型就动手改的话，下一轮没有基准，又开 2～3 个从头审
  if (['completed', 'partial'].includes(result.status) || (result.status === 'stale' && nowInput !== (job.pointHash || job.fingerprint))) {
    const covered = new Set(result.covered); const files = {};
    for (const n of labels) if (covered.has(n)) files[n] = plan.currents[n].text;
    try { Sc.writeSnapshot(store, job.file, { born: plan.born, base: job.base, round: job.round, files, issues: result.issues, closed: plan.scoped ? plan.closed : plan.deferred, covered: result.covered }); } catch (e) { /* 存不了，下一轮按第一轮审 */ }
  }
  const log = Sc.logRound(folder, { round: job.round, point: job.point, mode: job.mode, at: result.at, scoped: job.scoped, changed: plan.changed, lenses: result.lenses, why: plan.why, status: result.status, reason: result.reason, issues: result.issues, spentMs: result.spentMs, tokens: result.tokens, repeated: (result.repeated || []).length });
  if (log) result.log = log;
  result.next = nextStep(result);
  if (change && result.status === 'completed' && (!job.point || policy.allPassed(change.dir, job.mode))) {
    S.recordReview(job.mode, change.dir, result.blocking, id, Date.now(), true);
    S.updateState(job.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const r = o[S.normKey(change.dir)]; if (r && r.key === id) { if (job.mode === 'code') r.fingerprint = job.fingerprint; else { r.proposalHash = require('./apply-scope').planHash(change.dir); r.materialInputs = result.materialInputs; } r.reportFile = job.file; r.executor = 'agent'; r.covered = result.covered; } });
  }
  S.updateState('review-jobs', (o) => { if (o[job.key] && o[job.key].id === id) o[job.key] = Object.assign(o[job.key], result, { finishing: false }); });
  try { fs.rmSync(job.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* 占着就算了，审查目录在 .vibe 里 */ }
  return result;
}
function status(opts) {
  const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); const r = S.readState('review-jobs')[key];
  if (r && r.status === 'running' && Date.now() >= r.deadline) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === r.id) { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'interrupted'; o[key].reason = '角度没交齐，没有完整结果'; } }); return S.readState('review-jobs')[key]; }
  // 都交了但入账没走完（钩子的预算用完了）：这里补上
  if (r && r.status === 'running' && r.lenses && r.lenses.length && !leftOf(r).length) return finish(r.id);
  if (r && r.status === 'running' && r.lenses) {
    // 进程没了的角度记成没交，顶层按各角度汇总（#426、#428：以前角度失败了顶层还是 running，看着像还在审）
    for (const l of r.lenses) { const s = r.state[l]; if (s && s.status === 'sent' && !alive(s)) failLens(r.id, l, '审查进程没了，没交结论'); }
    const now = S.readState('review-jobs')[key] || r;
    const left = leftOf(now);
    const busy = now.lenses.filter((l) => alive(now.state[l]));
    const lost = now.lenses.filter((l) => now.state[l].status === 'failed');
    if (!busy.length && lost.length) return Object.assign({}, now, { status: 'failed', left, lost: lost.map((l) => l + '：' + (now.state[l].why || '没交结论')), next: '有角度没拿到结论，没有在跑的了。再跑一次 review.js run 只补没交的；连续 3 次没拿到就不再催，写进交代。' });
    return Object.assign({}, now, { left, running: busy });
  }
  return r || { status: 'none' };
}
function cancel(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); S.updateState('review-jobs', (o) => { if (o[key] && o[key].status === 'running') { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'cancelled'; o[key].reason = '用户或当前会话取消'; } }); return status(opts); }
/**
 * 有没有当前输入的成功复验证据：按代码审查取材料的那几个仓库查（变更的各子项目；不带变更的，项目和它下面的子仓库）。
 * 复审 20261031 D-R6：壳子里 mvn -f 子项目 的证据记在子仓库名下，以前按壳子查对不上，修了登记不进去
 */
function provedIn(cwd, change) {
  const E = require('./evidence');
  const roots = change ? S.projectRootsOf(change.dir) : [W.rootOf(cwd)].concat(S.nestedRepos ? S.nestedRepos(cwd) : []);
  return [path.resolve(cwd)].concat(roots).some((r) => { try { return E.commands(r).length > 0; } catch (e) { return false; } });
}
const NO_EVIDENCE = '成立问题修复后还没有当前输入的成功复验证据：先跑一次能证明修好了的编译或测试（mvn、gradle、npm 的脚本、npx、pytest、go、dotnet、make，或者 .vibe 下的脚本），成功了再登记';
function resolve(opts) {
  const change = changeOf(opts.cwd || process.cwd(), opts.change);
  if (opts.change && !change) throw new Error('没找到当前变更 ' + opts.change + '；不走 OpenSpec 的审查不带 --change：resolve --mode code --project <项目> --decisions <文件>');
  if (!change) return resolvePlain(opts);
  const policy = require('./flow-policy');
  const pointRec = opts.point && policy.record(change.dir, opts.point);
  // 失败、部分覆盖、超时、取消的结果没有审完全部材料，处理其中的意见也不能把这个点记成已处理。
  // 已经处理完的、等复审的说清楚（#455：以前一律说"没有完整完成的审查结果…先重新审查"，处理完的也这么说，模型又去审一遍）
  if (pointRec && pointRec.status === 'resolved') throw new Error('变更 ' + change.name + ' 的审查点 ' + opts.point + ' 的意见已经登记处理完了（resolved），不用再登记。提交被"审查还没收尾"拦的，照那条提示里写的变更和审查点处理，不是这一个');
  if (pointRec && pointRec.status === 'needs_review') throw new Error('变更 ' + change.name + ' 的审查点 ' + opts.point + ' 的意见已经登记过，等复审（needs_review）：跑 review.js run --change ' + change.name + ' --mode ' + (opts.mode === 'proposal' ? 'proposal' : 'code') + ' --point ' + opts.point + ' 复审，不用再登记');
  if (pointRec && pointRec.status !== 'completed') throw new Error('审查点 ' + opts.point + ' 没有完整完成的审查结果（当前：' + (pointRec.status || '未审查') + '），不能登记处理；先重新审查这个点');
  // 不带审查点的整套审查：按 --mode 读提案或代码的记录（Codex C20：以前固定读代码的，整套提案审查的意见配不上报告）
  const kind = opts.mode === 'proposal' ? 'proposal' : 'code';
  const r = pointRec ? Object.assign({}, pointRec, { reportFile: pointRec.report }) : S.reviewRecord(kind, change.dir); if (!r || !r.reportFile) throw new Error('没有可配对的完整审查报告');
  const report = JSON.parse(fs.readFileSync(r.reportFile, 'utf8')); const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  // deferred：实现细节留给后面的文档，只有需求文档能用（问题表第 37 条）
  // 审查点 tasks 审的是整套，没有后面的文档可留（第 57 条）：标 deferred 等于这条再没人看
  if (opts.point === 'tasks' && decisions.findings.some((x) => x.action === 'deferred')) throw new Error('审查点 tasks 审的是整套文档，没有后面的文档可留：实现细节写进 design 后标 fixed，不成立的标 rejected 写依据');
  const actions = kind === 'proposal' ? ['fixed', 'rejected', 'accepted', 'deferred'] : ['fixed', 'rejected', 'accepted'];
  for (const issue of report.issues) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !actions.includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (report.id !== r.key || !Array.isArray(report.issues)) throw new Error('审查报告不属于当前完整记录');
  if (decisions.findings.length !== report.issues.length || new Set(decisions.findings.map((x) => x.id)).size !== report.issues.length || decisions.findings.some((x) => !report.issues.some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  // 改文档不用跑编译（窗口里见过：为了登记提案的修改先跑基线编译）；代码照旧要有复验证据
  if (kind === 'code' && decisions.findings.some((x) => x.action === 'fixed') && !provedIn(opts.cwd || process.cwd(), change)) throw new Error(NO_EVIDENCE);
  // 只有 P1、P2 修了才要复审；P3 顺手改了不再审（问题表第 37 条）
  const refix = decisions.findings.some((x) => x.action === 'fixed' && !/^P3$/i.test(String((report.issues.find((i) => i.id === x.id) || {}).severity || '')));
  const noted = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) }));
  // 校验都过了才记：不然登记失败了，决定却已经进了下一轮的"已处理"和审查记录
  const remember = () => { if (r.reportFile) { try { Sc.noteDecisions(store, r.reportFile, noted); Sc.logDecisions(path.dirname(r.reportFile), opts.point || kind, noted); } catch (e) { /* 记不了不影响登记 */ } } };
  const fingerprint = W.fingerprint(opts.cwd || process.cwd(), opts.mode === 'proposal' ? 'all' : 'code').hash;
  if (!opts.point && !decisions.findings.some((x) => x.action === 'fixed') && fingerprint !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或零问题记录不能批准新版，需要补审');
  if (opts.point) {
    const changed = !policy.sameInput(change.dir, opts.point, pointRec.fingerprint);
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
  if (fixed && !provedIn(cwd, null)) throw new Error(NO_EVIDENCE);
  if (!fixed && W.fingerprint(cwd, 'code').hash !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或接受的记录不能批准新版，需要补审');
  report.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) }));
  try { Sc.noteDecisions(store, file, report.decisions); Sc.logDecisions(path.dirname(file), 'code', report.decisions); } catch (e) { /* 记不了不影响登记 */ }
  report.resolvedAt = Date.now(); report.resolvedFingerprint = W.fingerprint(cwd, 'code').hash;
  if (!store.atomicWrite(file, report)) throw new Error('处理记录没能写进审查结果');
  return { status: 'resolved', count: report.decisions.length, file };
}
/**
 * 这段会话记录里跑过的 review.js prepare 的结果，给经验规则自动收（lessons.autoCollect，问题表第 34 条）。
 * 结论在结果文件里（交齐才写）；文件没变、没发请求的那次结论在命令的输出里。同一次审查只算一次。
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
module.exports = { runsForLessons, prepare, run, work, askClaude, claudeExe, repairJson, submit, failLens, sweep, inFlight, materials, inputsCurrent, baseline, status, cancel, resolve, jobKey, parseResult, decisionIssue };

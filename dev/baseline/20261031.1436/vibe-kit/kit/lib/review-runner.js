'use strict';
/* 独立审查执行器：有限材料分片，经本机路由独立请求；探索清单保留在设计正文，不自动展开源码。分别记录发送、回复、解析与覆盖，诊断脱敏后仅存本机。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const S = require('./session');
const W = require('./workspace');
const R = require('./redact');
const store = require('./state-store');
const secretFile = (f) => /(^|[\\/])(secrets\.json|router-data|\.env(?:\.[^/]*)?|db-crud\.ini|redis\.json|login\.json)([\\/]|$)/i.test(f);
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch (e) { return false; } }
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
  const items = [], skipped = [], excluded = [], files = new Set(), inputs = new Map(); let contextOnly = []; const cfg = S.readConfig(); const maxFiles = Math.min(60, Math.max(1, Number(cfg.reviewMaxFiles) || 20));
  const add = (file, text, root, source) => {
    if (files.has(file)) return;
    if (files.size >= maxFiles) { skipped.push({ file, reason: '超过本轮文件上限；在配置页提高审查文件上限（最多 60），或明确拆成独立变更后审查' }); return; }
    files.add(file);
    const chunks = []; let chunk = '', line = 1, start = 1;
    // 先遮整份文本再切片，避免凭据字面值跨片后漏掉模式匹配。
    for (const row of R.material(text).split(/(?<=\n)/)) {
      if (chunk && chunk.length + row.length > 40000) { chunks.push({ text: chunk, startLine: start }); chunk = ''; start = line; }
      for (let i = 0; i < row.length; i += 40000) { if (i) { chunks.push({ text: chunk, startLine: start }); chunk = ''; start = line; } chunk += row.slice(i, i + 40000); }
      line += (row.match(/\n/g) || []).length;
    }
    if (chunk || !chunks.length) chunks.push({ text: chunk, startLine: start });
    chunks.forEach((c, i) => items.push({ file, root, source: source || path.resolve(root, file), text: c.text, startLine: c.startLine, part: i + 1, parts: chunks.length }));
  };
  const load = (file, root, label, allowMissing) => {
    const skip = (reason) => { skipped.push({ file: label, reason }); return null; };
    if (secretFile(file)) return skip('敏感配置不进审查材料');
    const checked = W.pathStatus(file, root);
    if (!checked.safe) return skip(checked.reason);
    if (checked.missing) return allowMissing ? { missing: true, text: '' } : skip('材料不可读');
    if (checked.stat.size > 4 * 1024 * 1024) return skip('单文件超过 4MB；按职责拆文件或准备明确范围的独立变更，不能截断后算完整覆盖');
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
    for (const row of rows) add(row.file, row.text, change.dir);
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
        const loaded = load(f, change.dir, label); if (loaded) add(label, loaded.text, change.dir, f);
        continue;
      }
      let found = false;
      for (const root of roots) {
        const f = path.resolve(root, ref);
        if (!S.underDir(f, root) || S.underDir(f, change.dir) || /[\\/]\.vibe[\\/]/.test(f) || !fs.existsSync(f)) continue;
        found = true;
        if (!refs.required.has(ref) && fs.lstatSync(f).isDirectory() && S.underDir(S.realish(f), S.realish(root))) break; // 普通目录引用只是范围说明。
        const label = path.relative(opts.cwd, f).replace(/\\/g, '/'); const loaded = load(f, root, label);
        if (loaded) add(label, loaded.text, root, f);
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
      // 已跟踪的改动排在前面，未跟踪的只要基线之后建的、改过的（#206：--base HEAD 把 167 个早就在的 .claude、.review、docs 文件也送审，
      // 20 个文件的上限被它们占满）；有开工基线的，开工时就在的未跟踪文件不算，之后又改过的照算
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
        add(label, text, root, f);
      }
    }
    // 不带等号的 --base 一个仓库都不认得：是写错了，不当成缺基线
    for (const b of bare) if (!used.has(b)) throw new Error('审查基线 ' + b + ' 不是本地提交（这几个仓库里都没有）；几个仓库各写各的：' + hint);
    if (change) for (const row of artifacts().filter((r) => !/revisions\.md$/.test(r.file))) add(row.file, row.text, change.dir);
  }
  const batches = []; let batch = [], size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) batches.push(batch);
  return { items, skipped, excluded, batches, contextOnly, inputs: [...inputs.values()] };
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
function routerUrl() {
  if (process.env.VIBE_KIT_REVIEW_PORT) return 'http://127.0.0.1:' + Number(process.env.VIBE_KIT_REVIEW_PORT) + '/v1/messages';
  try { const settings = JSON.parse(fs.readFileSync(path.join(S.KIT, '..', 'settings.json'), 'utf8')); for (const groups of Object.values(settings.hooks || {})) for (const g of groups) for (const h of g.hooks || []) if (h.type === 'http' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/vibe-kit\/hook\//.test(h.url)) return new URL('/v1/messages', h.url).href; } catch (e) { /* 尚无 HTTP 钩子 */ }
  return 'http://127.0.0.1:15730/v1/messages';
}
/*
 * 审查请求的输出上限（#206、#209、#211，旧 #180、#186、#188、#175；问题反馈表第 7 条问的就是这两个数）：一次请求最多让模型输出多少 token。
 * deepseek-flash、MiniMax 这类先思考的模型，以前的 5000 常常全花在思考上，正文还没写就停了（只有 thinking 块）。先给 16000；
 * 只回思考、停在输出上限（或者没给停止原因）的，同一批用 32000、在要求里加一句"少想、直接给 JSON"再试；还是只有思考（#226 两次把 32000 全用在思考上），
 * 把这一批拆成两半各审一次。都不行的这一批记失败、接着审下一批，审完记一条问题反馈（用户 2026-10-28 定的：不拦，记下来上报，用来优化审查）。
 * 思考不是结论，不从思考里抽意见。"请求里关思考"网关认不认没法在这里验证，不加
 */
const OUTPUT_TOKENS = 16000;
const RETRY_TOKENS = 32000;
// 单批请求等回复的保险：本机路由自己有首字节和空闲超时，这里只防路由整个没了、一直挂着。不是审查预算（总预算 2026-10-28 取消）
const HANG_MS = 30 * 60000;
const CONCISE = '这一批上次你只输出了思考、没写结论：这次少想，每个文件看一遍就下结论，直接输出 JSON，不要长篇推理。';
function parseReply(text, material) {
  const fail = (stage, reason, raw, extra) => { const e = new Error(reason + '，未记为完成'); e.diagnostic = Object.assign({ stage, excerpt: R.clip(R.material(raw), 1500) }, extra || {}); throw e; };
  let reply; try { reply = JSON.parse(text); } catch (e) { fail('router-json', '本机路由回复不是有效 JSON', text); }
  if (!reply || !Array.isArray(reply.content)) fail('router-content', '本机路由回复缺少 content 文本', text);
  // 停止原因、输出用量、实际模型在回复 JSON 的末尾，以前只截开头 1500 字看不到
  const meta = { stopReason: String(reply.stop_reason || ''), outputTokens: Number(reply.usage && reply.usage.output_tokens) || 0, model: R.clip(String(reply.model || ''), 80), blocks: reply.content.map((x) => (x && x.type) || '').filter(Boolean).slice(0, 12) };
  const body = reply.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (!body) {
    const thinking = meta.blocks.length > 0 && meta.blocks.every((t) => /thinking/.test(t));
    const cut = thinking && !/^(?:end_turn|stop_sequence|tool_use)$/.test(meta.stopReason);
    fail('model-empty', cut ? '模型只输出了思考，到了输出上限还没写结论' : '未收到审查者正文', text, Object.assign(meta, { retry: cut }));
  }
  // 模型常把 JSON 包在 ```json 代码块里、前后带一句话：剥掉再解析（审核 P34：以前直接算失败、也不重试）
  const parseLoose = (t) => {
    try { return JSON.parse(t); } catch (e) { /* 往下试 */ }
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t); if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* 往下试 */ } }
    const i = t.indexOf('{'); const j = t.lastIndexOf('}'); if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { /* 不是 */ } }
    return undefined;
  };
  let result = parseLoose(body);
  if (result === undefined) fail('model-json', '审查者正文不是有效 JSON（stop_reason：' + (meta.stopReason || '没有') + '）', body, Object.assign(meta, { jsonRetry: true }));
  if (!result || !Array.isArray(result.issues) || result.issues.length > 100 || result.issues.some((x) => !x || typeof x.file !== 'string' || typeof x.problem !== 'string' || typeof x.evidence !== 'string')) fail('issue-structure', '审查问题缺少 file、problem 或 evidence', body);
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const issues = [], skipped = [];
  for (const x of result.issues) {
    const name = norm(x.file); const matches = [...new Set(material.filter((m) => norm(m.file) === name || norm(m.source || path.resolve(m.root, m.file)) === name).map((m) => m.file))];
    if (matches.length !== 1) { skipped.push({ file: R.clip(x.file, 200), reason: '审查意见路径不属于本批材料，意见未采纳；本轮只算部分结果' }); continue; }
    issues.push(Object.assign({}, x, { file: matches[0] }));
  }
  return { issues: R.tree(issues), skipped, summary: R.clip(result.summary || '', 1500), meta };
}
function ask(url, material, mode, ms, cancelled, received, maxTokens, concise) {
  return new Promise((resolve, reject) => {
    // model 只给本机路由分角色用（审查走 sonnet 那个角色），路由转发给网关时去掉（2026-10-28）
    const body = JSON.stringify({ model: 'claude-sonnet-vibe-review', stream: false, max_tokens: maxTokens || OUTPUT_TOKENS, system: '你是独立审查者。只审提供的材料，不运行命令、不调用工具、不推测未提供的内容。找实际错误、风险和遗漏，正常情况不提建议凑数。简体中文直说。返回 JSON，格式 {"issues":[{"severity":"P1|P2|P3","file":"材料中的文件","line":1,"problem":"问题","evidence":"可核对依据","fix":"修复建议"}],"summary":"覆盖和限制"}。没有问题 issues 为 []。' + (concise ? CONCISE : ''), messages: [{ role: 'user', content: '模式：' + mode + '\n本批材料：\n' + JSON.stringify(material) }] });
    // 每批都新开连接（agent: false）：Node 默认复用空闲连接，路由那头空闲几秒就关了它，或者两批之间路由重启过，
    // 复用到断掉的连接就报 ECONNRESET，这一批白白算失败（2026-10-16 机器忙时测试里遇到）。本机连接，新开几乎不花时间
    const req = http.request(url, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (b) => { text += b; if (text.length > 300000) req.destroy(new Error('审查回复过大')); });
      res.on('end', () => { clear(); if (received) received(); if (res.statusCode !== 200) return reject(new Error('本机路由返回 ' + res.statusCode + '：' + R.clip(text, 300))); try { resolve(parseReply(text, material)); } catch (e) { reject(e); } });
      res.on('error', (e) => { clear(); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('本机路由 ' + Math.round(ms / 60000) + ' 分钟没回这一批')), Math.max(1, ms));
    const poll = setInterval(() => { if (cancelled()) req.destroy(new Error('审查已取消或被新运行替换')); }, 200);
    const clear = () => { clearTimeout(timer); clearInterval(poll); };
    req.on('error', (e) => { clear(); reject(e); }); req.end(body);
  });
}
// 审查总预算 2026-10-28 取消（用户定的），--new-budget 不再需要、也不再拦（老习惯写了照常跑）。guard-commit 还在调，留个空的
function budgetIssue() { return ''; }
// 模型执行跳过或接受问题时核对真人决定；手工 CLI 仍由执行者负责。
function decisionIssue(j) {
  const parser = require('../hooks/guard-commit'); const ps = j.tool_name === 'PowerShell';
  for (const group of parser.splitCommand(String(j.tool_input && j.tool_input.command || ''), ps)) for (const segment of group) {
    const ws = parser.words(parser.scanRedirects(segment).rest, ps).map((w) => w.text);
    if (ws.length < 3 || !/^node(?:\.exe)?$/i.test(path.basename(ws[0].replace(/\\/g, '/'))) || S.normKey(path.resolve(j.cwd, S.expandHome(ws[1]))) !== S.normKey(path.join(S.KIT, 'tools/review.js'))) continue;
    const val = (k) => { const i = ws.indexOf(k); return i < 0 ? '' : S.expandHome(ws[i + 1] || ''); }; const cwd = path.resolve(j.cwd, val('--project') || '.'); const change = changeOf(cwd, val('--change'));
    let action = ws[2] === 'waive' ? 'reviewSkip' : '';
    if (ws[2] === 'resolve') { try { const d = JSON.parse(fs.readFileSync(path.resolve(j.cwd, val('--decisions')), 'utf8')); if ((d.findings || []).some((x) => x.action === 'accepted')) action = 'reviewAccept'; } catch (e) { return '意见处理文件无法核对，先检查 --decisions 文件'; } }
    if (!action) continue;
    // 不走 OpenSpec 的审查（不带 --change）：按项目目录核对用户的决定（#234）
    const allowed = require('./permissions').allow(j, action, change ? change.dir : W.rootOf(cwd), j.tool_use_id);
    if (!allowed.ok) return '需要当前用户明确决定' + (action === 'reviewSkip' ? '跳过这次审查' : '接受这次审查中的问题') + '：' + allowed.reason;
  }
  return '';
}
function waived(dir, mode) {
  const rec = S.readState('review-waivers')[mode + '|' + S.normKey(dir)];
  return !!(rec && rec.born === S.changeBorn(dir) && rec.fingerprint === (mode === 'proposal' ? require('./apply-scope').planHash(dir) : W.fingerprint(dir, 'code').hash));
}
function waive(opts) {
  // 放弃不是通过，不改团队产物，也不登记未审查待办。
  return { status: 'dismissed' };
}
/** 一批审查：16000 → 只回思考就 32000 + 少想 → 还不行拆两半。返回 { done: [成功的片段], failed: [{ items, error }], issues, skipped, stat } */
async function reviewBatch(batch, no, opts, cancelled, received, progress) {
  const stat = { batch: no, files: new Set(batch.map((x) => x.file)).size, parts: batch.length, chars: batch.reduce((n, x) => n + x.text.length, 0), attempts: [], ms: 0 };
  const t0 = Date.now();
  const once = async (items, tokens, concise, label) => {
    const a0 = Date.now();
    try {
      const r = await ask(routerUrl(), items, opts.mode, HANG_MS, cancelled, received, tokens, concise);
      stat.attempts.push({ label, tokens, ms: Date.now() - a0, ok: true, outputTokens: r.meta.outputTokens, stopReason: r.meta.stopReason, model: r.meta.model });
      return { r };
    } catch (e) {
      const d = e.diagnostic || {};
      stat.attempts.push({ label, tokens, ms: Date.now() - a0, ok: false, stage: d.stage || '', outputTokens: d.outputTokens || 0, stopReason: d.stopReason || '', model: d.model || '', error: R.clip(e.message, 200) });
      return { e };
    }
  };
  const thinkingOnly = (x) => !!(x.e && x.e.diagnostic && x.e.diagnostic.retry);
  const out = { done: [], failed: [], issues: [], skipped: [], diagnostics: [], stat };
  const take = (items, x) => { if (x.r) { out.done.push(...items); out.issues.push(...x.r.issues); out.skipped.push(...x.r.skipped); } else { out.failed.push({ items, error: x.e }); if (x.e.diagnostic) out.diagnostics.push(Object.assign({ batch: no }, x.e.diagnostic)); } };
  let x = await once(batch, OUTPUT_TOKENS, false, '第一次');
  // 回的不是 JSON（剥了代码块也解析不了）：原样再审一次（审核 P34：以前直接算这一批失败）
  if (x.e && x.e.diagnostic && x.e.diagnostic.jsonRetry && !cancelled()) {
    if (progress) progress('第 ' + no + ' 批：审查者回的不是 JSON，再审一次');
    out.diagnostics.push(Object.assign({ batch: no, retried: true }, x.e.diagnostic));
    x = await once(batch, OUTPUT_TOKENS, false, '回的不是 JSON，再来一次');
  }
  if (thinkingOnly(x) && !cancelled()) {
    if (progress) progress('第 ' + no + ' 批：模型只输出了思考、到了输出上限，上限加到 ' + RETRY_TOKENS + '、要求少想直接给结论再试一次');
    out.diagnostics.push(Object.assign({ batch: no, retried: true }, x.e.diagnostic));
    x = await once(batch, RETRY_TOKENS, true, '加大上限、少想');
  }
  if (thinkingOnly(x) && batch.length > 1 && !cancelled()) {
    // 还是只有思考（#226）：材料少一半，要想的也少一半
    if (progress) progress('第 ' + no + ' 批：还是只有思考，拆成两半各审一次');
    out.diagnostics.push(Object.assign({ batch: no, split: true }, x.e.diagnostic));
    const half = Math.ceil(batch.length / 2);
    for (const part of [batch.slice(0, half), batch.slice(half)]) take(part, await once(part, RETRY_TOKENS, true, '拆半批'));
  } else take(batch, x);
  stat.ms = Date.now() - t0;
  return out;
}
/**
 * 审完对着配置页的"审查预期用时"看：超了，或者碰到了输出上限、有批次失败，就记一条问题反馈（用户 2026-10-28 定的，问题反馈表第 6、7 条），
 * 写清用在哪、为什么，给维护的人持续优化审查用。只有次数、用时、token、字数，不带材料原文和审查意见
 */
function reportReview(result, opts, expectMs, stats) {
  try {
    const over = result.spentMs > expectMs;
    const limited = stats.some((b) => b.attempts.some((a) => !a.ok && a.stage === 'model-empty'));
    const failedBatches = stats.filter((b) => b.attempts.length && !b.attempts.some((a) => a.ok));
    if (!over && !limited && !failedBatches.length) return null;
    const sec = (ms) => Math.round(ms / 1000);
    const slow = stats.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
    const model = (stats.flatMap((b) => b.attempts).find((a) => a.model) || {}).model || '';
    const why = [];
    if (limited) why.push('模型把输出上限用在了思考上（' + stats.reduce((n, b) => n + b.attempts.filter((a) => a.stage === 'model-empty').length, 0) + ' 次只回思考），重试、拆半批都要多等');
    if (stats.some((b) => b.attempts.length > 1)) why.push('重试了 ' + stats.filter((b) => b.attempts.length > 1).length + ' 批');
    if (failedBatches.length) why.push(failedBatches.length + ' 批最后也没拿到结论：' + [...new Set(failedBatches.flatMap((b) => b.attempts.map((a) => a.stage || a.error)).filter(Boolean))].slice(0, 3).join('、'));
    if (over && !why.length) why.push('材料多（' + stats.length + ' 批、' + Math.round(stats.reduce((n, b) => n + b.chars, 0) / 1000) + ' 千字），或者模型回得慢（最慢一批 ' + sec(slow[0] ? slow[0].ms : 0) + ' 秒）');
    const lines = ['审查模式 ' + opts.mode + (opts.point ? '，审查点 ' + opts.point : '') + (opts.change ? '' : '（不走 OpenSpec）') + '，模型 ' + (model || '（回复里没写）'),
      '总用时 ' + sec(result.spentMs) + ' 秒，配置页的预期用时 ' + sec(expectMs) + ' 秒' + (over ? '，超了 ' + sec(result.spentMs - expectMs) + ' 秒' : '，没超'),
      '材料 ' + stats.length + ' 批、' + stats.reduce((n, b) => n + b.files, 0) + ' 个文件、' + Math.round(stats.reduce((n, b) => n + b.chars, 0) / 1000) + ' 千字；覆盖 ' + (result.covered || []).length + ' 个文件，结果 ' + result.status,
      '用时最长的几批：' + slow.map((b) => '第 ' + b.batch + ' 批 ' + sec(b.ms) + ' 秒（' + b.files + ' 个文件、' + Math.round(b.chars / 1000) + ' 千字，' + b.attempts.map((a) => a.label + ' ' + sec(a.ms) + ' 秒' + (a.ok ? '' : '没成') + (a.outputTokens ? '、输出 ' + a.outputTokens + ' token' : '') + (a.stopReason ? '、停在 ' + a.stopReason : '')).join('，') + '）').join('；'),
      '原因：' + why.join('；')];
    const kind = failedBatches.length ? '出错' : '建议';
    const title = (over ? '审查超出预期用时（' + sec(result.spentMs) + ' 秒，预期 ' + sec(expectMs) + ' 秒）' : failedBatches.length ? '审查有 ' + failedBatches.length + ' 批没拿到结论' : '审查模型把输出上限用在思考上') + (model ? '：' + model : '');
    const sig = require('./feedback').sigOf(['review-report', opts.mode, over ? 'over' : '', limited ? 'limited' : '', failedBatches.length ? 'failed' : '', model]);
    return require('./feedback').record({ kind, hook: 'review.js', source: '审查自动记录', title, what: lines.join('\n'), why: '审查做完对着配置页的预期用时自动核对（用户 2026-10-28 定的：不截断审查，超了分析用时和原因上报，用来优化审查）。', cwd: opts.cwd, sig, note: lines[1] + '；' + lines[4] });
  } catch (e) { return null; } // 记不了不影响审查结果
}
async function run(opts, progress) {
  opts = Object.assign({ cwd: process.cwd(), mode: 'code' }, opts); opts.cwd = path.resolve(opts.cwd);
  if (!['proposal', 'code'].includes(opts.mode)) throw new Error('审查模式只能是 proposal 或 code');
  // #197：不走 OpenSpec 的小修复，模型编了一个变更名。报错里说清不带 --change 的写法
  const change = changeOf(opts.cwd, opts.change); if (opts.change && !change) throw new Error('没找到当前变更 ' + opts.change + '（' + opts.cwd + ' 的 openspec/changes 里没有这个变更）。不走 OpenSpec 的改动不带 --change，按改之前的提交审：review.js run --mode code --project ' + opts.cwd.replace(/\\/g, '/') + ' --base <改之前的提交>');
  const key = jobKey(opts.cwd, opts.change, opts.mode, opts.point, opts.base); const id = crypto.randomBytes(12).toString('hex'); const cfg = S.readConfig();
  const policy = require('./flow-policy');
  if (opts.point && (!change || !policy.points(change.dir, opts.mode).includes(opts.point))) throw new Error('审查点不存在或该任务组尚未完成');
  const pointHash = opts.point ? policy.fingerprint(change.dir, opts.point) : '';
  // 配置页的"审查预期用时"：不再到点截断（用户 2026-10-28 定的），审完超了就记问题反馈。--budget 给了就按它算这一次的预期
  const expectMs = Math.min(1800, Math.max(10, Number(opts.budgetSeconds || cfg.reviewBudgetSeconds) || 300)) * 1000;
  const before = W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all'); const started = Date.now();
  // deadline 只给 status 认"进程早没了还记着在跑"用（6 小时），不截断审查
  const claimed = S.updateState('review-jobs', (o) => { const old = o[key]; if (old && old.status === 'running' && alive(old.pid) && Date.now() < old.deadline) return; o[key] = { id, mode: opts.mode, change: opts.change || '', root: opts.cwd, status: 'running', pid: process.pid, started, deadline: started + 6 * 3600000, expectMs, fingerprint: before.hash, completedBatches: 0 }; });
  if (!claimed || !claimed[key] || claimed[key].id !== id) return { status: 'running', reason: '同一范围已有审查，请查看 status 或 cancel，不重复启动' };
  if (change && opts.point) policy.begin(change.dir, opts.point, id, pointHash);
  const cancelled = () => { const job = S.readState('review-jobs')[key]; return !job || job.id !== id || job.status !== 'running'; };
  let result = { id, mode: opts.mode, status: 'failed', issues: [], covered: [], skipped: [], attemptedBatches: 0, receivedBatches: 0, completedBatches: 0, attemptedFiles: [], diagnostics: [], expectSeconds: expectMs / 1000 };
  const stats = [];
  try {
    const material = materials(opts, change); result.skipped = material.skipped; result.excluded = material.excluded; result.contextOnly = material.contextOnly; result.materialInputs = material.inputs;
    if (!material.batches.length) throw new Error('没有可审查材料或开工基线缺失');
    const left = new Map(); for (const item of material.items) left.set(item.file, (left.get(item.file) || 0) + 1);
    result.totalBatches = material.batches.length;
    result.batching = '每片最多 40000 字符，每批最多 80000 字符；文件上限限制候选材料，批数不消耗额外审查轮数';
    for (let i = 0; i < material.batches.length; i++) {
      if (cancelled()) { for (const pending of material.batches.slice(i)) for (const item of pending) result.skipped.push({ file: item.file, part: item.part, reason: '未尝试：审查已取消' }); throw new Error('审查已取消'); }
      const batch = material.batches[i]; result.attemptedBatches++; result.attemptedFiles = [...new Set(result.attemptedFiles.concat(batch.map((x) => x.file)))];
      S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], { attemptedBatches: result.attemptedBatches, attemptedFiles: result.attemptedFiles, totalBatches: result.totalBatches }); });
      if (progress) progress('审查 ' + (i + 1) + '/' + material.batches.length + ' 批，本批 ' + new Set(batch.map((x) => x.file)).size + ' 个文件/' + batch.length + ' 个片段，已尝试 ' + result.attemptedFiles.length + ' 个文件，已覆盖 ' + result.covered.length + ' 个文件，已用 ' + Math.round((Date.now() - started) / 1000) + ' 秒（预期 ' + expectMs / 1000 + ' 秒）');
      // 一批里重试、拆半批会收到好几次回复：只算这一批收到过（"已收到"数的是批，和"已尝试""总批数"对得上）
      let got = false;
      const out = await reviewBatch(batch, i + 1, opts, cancelled, () => { if (!got) { got = true; result.receivedBatches++; } }, progress);
      stats.push(out.stat); result.diagnostics.push(...out.diagnostics);
      if (out.stat.attempts.length > 1) result.retriedBatches = (result.retriedBatches || 0) + 1;
      result.issues.push(...out.issues); result.skipped.push(...out.skipped);
      for (const f of out.failed) for (const item of f.items) result.skipped.push({ file: item.file, part: item.part, reason: '本批失败：' + R.clip(f.error.message, 300) });
      if (!out.failed.length) result.completedBatches++;
      for (const item of out.done) { left.set(item.file, left.get(item.file) - 1); if (!left.get(item.file)) result.covered.push(item.file); }
      S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id && o[key].status === 'running') { o[key].completedBatches = result.completedBatches; o[key].covered = result.covered.length; } });
      if (cancelled()) { for (const pending of material.batches.slice(i + 1)) for (const item of pending) result.skipped.push({ file: item.file, part: item.part, reason: '未尝试：审查已取消' }); throw new Error('审查已取消'); }
    }
    if (cancelled()) throw new Error('审查已取消或结果已迟到');
    if ((opts.point ? policy.fingerprint(change.dir, opts.point) !== pointHash : W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all').hash !== before.hash) || !inputsCurrent(result.materialInputs)) { result.status = 'stale'; result.reason = '审查期间输入变更，本轮结果不能批准新版'; }
    else if (result.skipped.length) { result.status = result.completedBatches || result.covered.length ? 'partial' : 'failed'; result.reason = '还有失败或未覆盖材料，不能记为完整审查'; }
    else result.status = 'completed';
  } catch (e) { if (e.diagnostic) result.diagnostics.push(e.diagnostic); result.reason = R.clip(e.message, 500); result.status = /取消|迟到|替换/.test(result.reason) ? 'cancelled' : 'failed'; }
  // 没拿到正文的：说清是模型只输出了思考，给一句能照着做的话（以前只有"未收到审查者正文"，模型不知道下一步）
  const empty = result.diagnostics.filter((d) => d.stage === 'model-empty');
  if (empty.length && result.status !== 'completed') result.hint = '审查模型' + (empty[0].model ? '（' + empty[0].model + '）' : '') + (empty.some((d) => d.retry) ? '只输出了思考，到了输出上限（' + Math.max(...empty.map((d) => d.outputTokens || 0)) + ' token）还没写结论，加大上限、拆半批也没成' : '没给出正文') + '：缩小范围再审（按审查点 --point，或者少几个文件），或者在配置页把审查方式改成"原审查代理"、用兼容代理方式审。思考内容不是结论，不要从诊断片段里抽意见。已经自动记了一条问题反馈。';
  result.issues = result.issues.map((x, i) => Object.assign({ id: 'r' + (i + 1) }, x));
  result.fingerprint = before.hash; result.spentMs = Date.now() - started; result.at = Date.now();
  result.batchTimes = stats.map((b) => ({ batch: b.batch, seconds: Math.round(b.ms / 1000), attempts: b.attempts.length }));
  let valid = false;
  S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) { const terminal = o[key].status; if (terminal !== 'running') { result.status = terminal; result.reason = o[key].reason; } o[key] = Object.assign(o[key], result); valid = true; } });
  if (!valid) { result.status = 'cancelled'; result.reason = '迟到结果已忽略'; return result; }
  if (result.status !== 'cancelled') { const fb = reportReview(result, opts, expectMs, stats); if (fb && fb.id) result.reported = fb.id; }
  const folder = path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'); const file = path.join(folder, opts.mode + (opts.point ? '-' + opts.point : '') + '.json');
  try { if (!store.atomicWrite(file, result)) throw new Error('结果写入失败'); result.file = file; }
  catch (e) { result.status = 'failed'; result.reason = '审查结果未能保存，不能登记为完成'; S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], result); }); }
  try { const U = require('./usage'); U.bump(result.spentMs > expectMs ? 'review.timeout' : 'review.' + result.status); } catch (e) { /* 计数失败不改变结论 */ }
  if (change && opts.point) policy.noteResult(change.dir, opts.point, result, pointHash);
  if (change && result.status === 'completed' && (!opts.point || policy.allPassed(change.dir, opts.mode))) {
    S.recordReview(opts.mode, change.dir, result.issues.length, id, Date.now());
    S.updateState(opts.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const r = o[S.normKey(change.dir)]; if (r && r.key === id) { if (opts.mode === 'code') r.fingerprint = before.hash; else { r.proposalHash = require('./apply-scope').planHash(change.dir); r.materialInputs = result.materialInputs; } r.reportFile = file; r.executor = 'direct'; r.covered = result.covered; } });
  }
  return result;
}
function status(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); const r = S.readState('review-jobs')[key]; if (r && r.status === 'running' && (!alive(r.pid) || Date.now() >= r.deadline)) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === r.id) { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'interrupted'; o[key].reason = '执行进程退出了，没有完整结果'; } }); return S.readState('review-jobs')[key]; } return r || { status: 'none' }; }
function cancel(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code', opts.point, opts.base); S.updateState('review-jobs', (o) => { if (o[key] && o[key].status === 'running') { o[key].spentMs = Date.now() - Number(o[key].started || Date.now()); o[key].status = 'cancelled'; o[key].reason = '用户或当前会话取消'; } }); return status(opts); }
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
  const r = pointRec ? Object.assign({}, pointRec, { reportFile: pointRec.report }) : S.reviewRecord(kind, change.dir); if (!r || (!r.reportFile && r.executor !== 'agent')) throw new Error('没有可配对的完整审查报告');
  const report = r.reportFile ? JSON.parse(fs.readFileSync(r.reportFile, 'utf8')) : { id: r.key, fingerprint: r.fingerprint || W.fingerprint(opts.cwd, kind === 'proposal' ? 'all' : 'code').hash, issues: Array.from({ length: Number(r.issues) || 0 }, (_, i) => ({ id: 'r' + (i + 1) })) }; const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  for (const issue of report.issues) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !['fixed', 'rejected', 'accepted'].includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (report.id !== r.key || !Array.isArray(report.issues)) throw new Error('审查报告不属于当前完整记录');
  if (decisions.findings.length !== report.issues.length || new Set(decisions.findings.map((x) => x.id)).size !== report.issues.length || decisions.findings.some((x) => !report.issues.some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  if (decisions.findings.some((x) => x.action === 'fixed') && !require('./evidence').commands(opts.cwd || process.cwd()).length) throw new Error('成立问题修复后还没有当前输入的成功复验证据');
  const fingerprint = W.fingerprint(opts.cwd || process.cwd(), opts.mode === 'proposal' ? 'all' : 'code').hash;
  if (!opts.point && !decisions.findings.some((x) => x.action === 'fixed') && fingerprint !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或零问题记录不能批准新版，需要补审');
  if (opts.point) {
    const changed = pointRec.fingerprint !== policy.fingerprint(change.dir, opts.point);
    const fixed = decisions.findings.some(x => x.action === 'fixed');
    if (!fixed && changed) throw new Error('当前审查点输入已变化，先重新审查');
    S.updateState('review-points', o => { const rec = o[S.normKey(change.dir) + '|' + opts.point]; if (rec && rec.key === r.key) { rec.decisions = decisions.findings; rec.status = fixed ? 'needs_review' : 'resolved'; rec.resolvedFingerprint = policy.fingerprint(change.dir, opts.point); } });
    return { status: fixed ? 'needs_review' : 'resolved', count: report.issues.length };
  }
  // 有"修了"的：和带审查点的一样要复审改过的地方，不直接算解决（审核 P34：以前有一条修了就记成已解决）
  const fixedAny = decisions.findings.some((x) => x.action === 'fixed');
  S.updateState(kind === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const rec = o[S.normKey(change.dir)]; if (rec && rec.key === r.key) { rec.resolved = !fixedAny; rec.needsReview = fixedAny; rec.resolvedAt = Date.now(); if (fixedAny) delete rec.resolvedFingerprint; else rec.resolvedFingerprint = fingerprint; rec.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) })); } });
  return fixedAny ? { status: 'needs_review', count: report.issues.length, next: '登记好了。有改过的地方，下一步是复审：再跑一次 review.js run（同样的 --change、--mode），审过了才算处理完；不用再登记一次。' } : { status: 'resolved', count: report.issues.length };
}
/**
 * 不走 OpenSpec 的审查（run 不带 --change，结果在 .vibe/reviews/plain/<模式>.json）登记用户的决定（#234：以前一律要变更，决定只能留在会话里）。
 * 和带变更的一样核对：每条意见都要有处理动作和依据；修了的要有之后的复验证据；只驳回、接受的，审完之后输入不能变
 */
function resolvePlain(opts) {
  const cwd = path.resolve(opts.cwd || process.cwd()); const mode = opts.mode === 'proposal' ? 'proposal' : 'code';
  if (mode !== 'code') throw new Error('提案审查要带 --change');
  const file = path.join(cwd, '.vibe', 'reviews', 'plain', 'code.json');
  let report; try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error('没有这个项目不带变更的审查结果（' + file + '）；先 review.js run --mode code --project <项目> --base <提交>'); }
  if (report.status !== 'completed') throw new Error('这次审查没有完整完成（' + (report.status || '未知') + '），不能登记处理；先重新审查');
  const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  for (const issue of report.issues || []) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !['fixed', 'rejected', 'accepted'].includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (decisions.findings.length !== (report.issues || []).length || new Set(decisions.findings.map((x) => x.id)).size !== decisions.findings.length || decisions.findings.some((x) => !(report.issues || []).some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  const fixed = decisions.findings.some((x) => x.action === 'fixed');
  if (fixed && !require('./evidence').commands(cwd).length) throw new Error('成立问题修复后还没有当前输入的成功复验证据');
  if (!fixed && W.fingerprint(cwd, 'code').hash !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或接受的记录不能批准新版，需要补审');
  report.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) }));
  report.resolvedAt = Date.now(); report.resolvedFingerprint = W.fingerprint(cwd, 'code').hash;
  if (!store.atomicWrite(file, report)) throw new Error('处理记录没能写进审查结果');
  return { status: 'resolved', count: report.decisions.length, file };
}
function stateFor(dir, mode) { const c = S.artifactOf(path.join(dir, 'tasks.md')); return status({ cwd: c ? c.root : dir, change: path.basename(dir), mode }); }
// 成功的真实代理工具结果先记账，不等待 Stop；没有启动或结论的证据仍不补记。
function syncAgent(j) {
  const entries = j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : [];
  const id = j.tool_use_id; const calls = S.toolCalls(entries, 0);
  const response = j.tool_response || {};
  const body = typeof response === 'string' ? response : response.content !== undefined ? response.content : response.stdout || response.result || response.text || '';
  const text = typeof body === 'string' ? body : Array.isArray(body) ? body.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
  if (id && !calls.some((c) => c.id === id) && /^(Agent|Task)$/.test(j.tool_name) && /(ttls|vibe)-reviewer/.test(String(j.tool_input && j.tool_input.subagent_type || ''))) entries.push({ type: 'assistant', uuid: 'after-review-' + id, timestamp: new Date(Date.now() - Math.max(0, Number(j.duration_ms) || 0)).toISOString(), message: { content: [{ type: 'tool_use', name: j.tool_name, id, input: j.tool_input }] } });
  if (id && text && !S.toolResults(entries).has(id)) entries.push({ type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  return S.syncReviews(entries.slice(), j.cwd);
}
function instruction(name, mode, cfg) { return cfg.reviewExecutor === 'agent' ? '按 /ttls-cross-review 的兼容代理方式审查 ' + name + '，等它审完（预期 ' + cfg.reviewBudgetSeconds + ' 秒，超了不取消）' : '执行 review.js run --change ' + name + ' --mode ' + mode + '（预期 ' + cfg.reviewBudgetSeconds + ' 秒，超了不截断，套件会自动记问题反馈）'; }
module.exports = { run, materials, inputsCurrent, baseline, status, stateFor, instruction, cancel, resolve, jobKey, budgetIssue, parseReply, syncAgent, waived, waive, decisionIssue };

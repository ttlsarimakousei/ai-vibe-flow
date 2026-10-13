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
function jobKey(cwd, name, mode) { const c = changeOf(cwd, name); return W.hash((c ? S.normKey(c.dir) : W.rootOf(cwd).toLowerCase()) + '|' + mode).slice(0, 24); }
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
  const items = [], skipped = [], files = new Set(), inputs = new Map(); let contextOnly = []; const cfg = S.readConfig(); const maxFiles = Math.min(60, Math.max(1, Number(cfg.reviewMaxFiles) || 20));
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
    const rows = artifacts();
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
    for (const root of roots) {
      const base = opts.base || (saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root)) || {}).ref;
      if (!base) { skipped.push({ file: root, reason: '缺开工基线，使用 --base 明确基线后再审' }); continue; }
      if (!W.git(root, ['rev-parse', '--verify', base + '^{commit}']).trim()) throw new Error('审查基线不是本地提交');
      const files = [...new Set(W.git(root, ['diff', '--name-only', '-z', base]).split('\0').concat(W.git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')))].filter(Boolean);
      for (const file of files) {
        if (/^(?:\.vibe|openspec)\//.test(file)) continue;
        const f = path.join(root, file); const label = path.relative(opts.cwd, f).replace(/\\/g, '/'); const current = load(f, root, label, true);
        if (!current) continue; // 读取 Git 差异之前先查链接归属，避免 Git 跟随外部联接。
        const diff = W.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=5', base, '--', file]);
        let text = diff ? '基线差异：\n' + diff + '\n当前文件：\n' + current.text : current.missing ? '文件已删除' : current.text;
        const oldDirty = saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root));
        if (oldDirty && (oldDirty.dirtyFiles || []).includes(file)) text = '说明：该文件在开工前已有改动，不能全部认作本次助手改动。\n' + text;
        add(label, text, root, f);
      }
    }
    if (change) for (const row of artifacts().filter((r) => !/revisions\.md$/.test(r.file))) add(row.file, row.text, change.dir);
  }
  const batches = []; let batch = [], size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) batches.push(batch);
  return { items, skipped, batches, contextOnly, inputs: [...inputs.values()] };
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
function parseReply(text, material) {
  const fail = (stage, reason, raw) => { const e = new Error(reason + '，未记为完成'); e.diagnostic = { stage, excerpt: R.clip(R.material(raw), 1500) }; throw e; };
  let reply; try { reply = JSON.parse(text); } catch (e) { fail('router-json', '本机路由回复不是有效 JSON', text); }
  if (!reply || !Array.isArray(reply.content)) fail('router-content', '本机路由回复缺少 content 文本', text);
  const body = reply.content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  if (!body) fail('model-empty', '未收到审查者正文', text);
  let result; try { result = JSON.parse(body); } catch (e) { fail('model-json', '审查者正文不是有效 JSON', body); }
  if (!result || !Array.isArray(result.issues) || result.issues.length > 100 || result.issues.some((x) => !x || typeof x.file !== 'string' || typeof x.problem !== 'string' || typeof x.evidence !== 'string')) fail('issue-structure', '审查问题缺少 file、problem 或 evidence', body);
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const issues = [], skipped = [];
  for (const x of result.issues) {
    const name = norm(x.file); const matches = [...new Set(material.filter((m) => norm(m.file) === name || norm(m.source || path.resolve(m.root, m.file)) === name).map((m) => m.file))];
    if (matches.length !== 1) { skipped.push({ file: R.clip(x.file, 200), reason: '审查意见路径不属于本批材料，意见未采纳；本轮只算部分结果' }); continue; }
    issues.push(Object.assign({}, x, { file: matches[0] }));
  }
  return { issues: R.tree(issues), skipped, summary: R.clip(result.summary || '', 1500) };
}
function ask(url, material, mode, ms, cancelled, received) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-vibe-review', stream: false, max_tokens: 5000, system: '你是独立审查者。只审提供的材料，不运行命令、不调用工具、不推测未提供的内容。找实际错误、风险和遗漏，正常情况不提建议凑数。简体中文直说。返回 JSON，格式 {"issues":[{"severity":"P1|P2|P3","file":"材料中的文件","line":1,"problem":"问题","evidence":"可核对依据","fix":"修复建议"}],"summary":"覆盖和限制"}。没有问题 issues 为 []。', messages: [{ role: 'user', content: '模式：' + mode + '\n本批材料：\n' + JSON.stringify(material) }] });
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (b) => { text += b; if (text.length > 300000) req.destroy(new Error('审查回复过大')); });
      res.on('end', () => { clear(); if (received) received(); if (res.statusCode !== 200) return reject(new Error('本机路由返回 ' + res.statusCode + '：' + R.clip(text, 300))); try { resolve(parseReply(text, material)); } catch (e) { reject(e); } });
      res.on('error', (e) => { clear(); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('审查总预算用完')), Math.max(1, ms));
    const poll = setInterval(() => { if (cancelled()) req.destroy(new Error('审查已取消或被新运行替换')); }, 200);
    const clear = () => { clearTimeout(timer); clearInterval(poll); };
    req.on('error', (e) => { clear(); reject(e); }); req.end(body);
  });
}
function used(job, now) {
  const prior = Number(job.spentBefore === undefined ? job.spentMs : job.spentBefore) || 0;
  return Math.max(Number(job.spentMs) || 0, prior + Math.max(0, Math.min(now, Number(job.deadline) || now) - Number(job.started || now)));
}
// 模型工具重开预算需要当前真人的一次许可；用户手工执行 CLI 的显式参数仍由用户负责。
function budgetIssue(j) {
  const cmd = String(j.tool_input && j.tool_input.command || '');
  if (!/\breview\.js["']?\s+run\b[\s\S]*--new-budget\b/i.test(cmd)) return '';
  const parser = require('../hooks/guard-commit'); const ps = j.tool_name === 'PowerShell'; const groups = parser.splitCommand(cmd, ps); const words = parser.words(cmd, ps).map((w) => w.text);
  const why = '重开审查预算需要当前用户明确同意；取消和失败仍计入已用预算。交代已覆盖和未覆盖范围，不能自动反复使用 --new-budget。';
  if (groups.length !== 1 || groups[0].length !== 1 || parser.scanRedirects(cmd).list.length || !/^(node|node\.exe)$/i.test(path.basename((words[0] || '').replace(/\\/g, '/'))) || !words[1] || S.normKey(path.resolve(j.cwd, S.expandHome(words[1]))) !== S.normKey(path.join(S.KIT, 'tools/review.js'))) return why;
  const args = words.slice(2); const val = (k) => { const at = args.indexOf(k); return at < 0 ? '' : S.expandHome(args[at + 1] || ''); }; const cwd = path.resolve(j.cwd, val('--project') || '.'); const change = changeOf(cwd, val('--change'));
  const allowed = require('./permissions').allow(j, 'reviewBudget', change ? change.dir : W.rootOf(cwd), j.tool_use_id);
  return allowed.ok ? '' : why + ' ' + allowed.reason;
}
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
    if (!change) return '用户决定必须绑定有效变更，不能对无目标的审查跳过或接受问题';
    const allowed = require('./permissions').allow(j, action, change.dir, j.tool_use_id);
    if (!allowed.ok) return '需要当前用户明确决定' + (action === 'reviewSkip' ? '跳过这次审查' : '接受这次审查中的问题') + '：' + allowed.reason;
  }
  return '';
}
function waived(dir, mode) {
  const rec = S.readState('review-waivers')[mode + '|' + S.normKey(dir)];
  return !!(rec && rec.born === S.changeBorn(dir) && rec.fingerprint === (mode === 'proposal' ? require('./apply-scope').planHash(dir) : W.fingerprint(dir, 'code').hash));
}
function waive(opts) {
  const change = changeOf(opts.cwd || process.cwd(), opts.change); if (!change || !['proposal', 'code'].includes(opts.mode)) throw new Error('跳过审查要明确有效变更和模式');
  const reason = R.clip(String(opts.reason || '').replace(/\r?\n/g, ' '), 500); if (reason.length < 10) throw new Error('写明用户决定跳过审查的原因，至少十个字');
  if (opts.mode === 'code') {
    const file = path.join(change.dir, 'tasks.md'); const text = fs.readFileSync(file, 'utf8');
    const next = text.split('\n').map((line) => ['review', 'review-fix'].includes(require('./task-types').kind(line)) ? line.replace(/\[[ xX]\]/, '[x]').replace(/（用户决定跳过审查：[^）]*）/g, '') + '（用户决定跳过审查：' + reason + '）' : line).join('\n');
    if (next !== text && !store.atomicText(file, next)) throw new Error('跳过记录无法写入任务清单，未登记');
  }
  const rec = { status: 'waived', mode: opts.mode, change: change.name, born: S.changeBorn(change.dir), reason, at: Date.now(), fingerprint: opts.mode === 'proposal' ? require('./apply-scope').planHash(change.dir) : W.fingerprint(opts.cwd, 'code').hash };
  const saved = S.updateState('review-waivers', (o) => { o[opts.mode + '|' + S.normKey(change.dir)] = rec; }); if (!saved) throw new Error('用户跳过记录未能保存');
  S.updateState('review-jobs', (o) => { const k = jobKey(opts.cwd, opts.change, opts.mode); o[k] = Object.assign({}, o[k], rec); });
  return rec;
}
async function run(opts, progress) {
  opts = Object.assign({ cwd: process.cwd(), mode: 'code' }, opts); opts.cwd = path.resolve(opts.cwd);
  if (!['proposal', 'code'].includes(opts.mode)) throw new Error('审查模式只能是 proposal 或 code');
  const change = changeOf(opts.cwd, opts.change); if (opts.change && !change) throw new Error('没找到当前变更');
  const key = jobKey(opts.cwd, opts.change, opts.mode); const id = crypto.randomBytes(12).toString('hex'); const cfg = S.readConfig();
  const budget = Math.min(1800, Math.max(10, Number(opts.budgetSeconds || cfg.reviewBudgetSeconds) || 300)) * 1000;
  const before = W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all'); const started = Date.now(); let previous = null;
  const claimed = S.updateState('review-jobs', (o) => { const old = o[key]; if (old && old.status === 'running' && alive(old.pid) && Date.now() < old.deadline) return; previous = old; o[key] = { id, mode: opts.mode, change: opts.change || '', root: opts.cwd, status: 'running', pid: process.pid, started, deadline: started + budget, fingerprint: before.hash, completedBatches: 0 }; });
  if (!claimed || !claimed[key] || claimed[key].id !== id) return { status: 'running', reason: '同一范围已有审查，请查看 status 或 cancel，不重复启动' };
  const spent = opts.newBudget ? 0 : previous && previous.status === 'running' ? used(previous, started) : Number(previous && previous.spentMs) || 0;
  const deadline = started + Math.max(0, budget - spent);
  S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], { deadline, spentBefore: spent, spentMs: spent }); });
  const cancelled = () => { const job = S.readState('review-jobs')[key]; return !job || job.id !== id || job.status !== 'running'; };
  let result = { id, mode: opts.mode, status: 'failed', issues: [], covered: [], skipped: [], attemptedBatches: 0, receivedBatches: 0, completedBatches: 0, attemptedFiles: [], diagnostics: [] };
  try {
    if (deadline <= started) throw new Error('累计审查预算已用完；交代现有结果和未覆盖范围，用户可明确用 --new-budget 开启新预算');
    const material = materials(opts, change); result.skipped = material.skipped; result.contextOnly = material.contextOnly; result.materialInputs = material.inputs;
    if (!material.batches.length) throw new Error('没有可审查材料或开工基线缺失');
    const left = new Map(); for (const item of material.items) left.set(item.file, (left.get(item.file) || 0) + 1);
    result.totalBatches = material.batches.length;
    for (let i = 0; i < material.batches.length; i++) {
      if (cancelled()) throw new Error('审查已取消');
      const batch = material.batches[i]; result.attemptedBatches++; result.attemptedFiles = [...new Set(result.attemptedFiles.concat(batch.map((x) => x.file)))];
      S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], { attemptedBatches: result.attemptedBatches, attemptedFiles: result.attemptedFiles, totalBatches: result.totalBatches }); });
      if (progress) progress('审查 ' + (i + 1) + '/' + material.batches.length + ' 批，本批 ' + new Set(batch.map((x) => x.file)).size + ' 个文件/' + batch.length + ' 个片段，已尝试 ' + result.attemptedFiles.length + ' 个文件，已覆盖 ' + result.covered.length + ' 个文件，剩余预算 ' + Math.max(0, Math.round((deadline - Date.now()) / 1000)) + ' 秒');
      const reply = await ask(routerUrl(), batch, opts.mode, deadline - Date.now(), cancelled, () => result.receivedBatches++);
      result.issues.push(...reply.issues); result.skipped.push(...reply.skipped); result.completedBatches++;
      for (const item of batch) { left.set(item.file, left.get(item.file) - 1); if (!left.get(item.file)) result.covered.push(item.file); }
      S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id && o[key].status === 'running') { o[key].completedBatches = i + 1; o[key].covered = result.covered.length; } });
    }
    if (cancelled()) throw new Error('审查已取消或结果已迟到');
    if (W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all').hash !== before.hash) { result.status = 'stale'; result.reason = '审查期间输入变更，本轮结果不能批准新版'; }
    else if (result.skipped.length) { result.status = 'partial'; result.reason = '还有未覆盖材料，不能记为完整审查'; }
    else result.status = 'completed';
  } catch (e) { if (e.diagnostic) result.diagnostics.push(e.diagnostic); result.reason = R.clip(e.message, 500); result.status = /取消|迟到|替换/.test(result.reason) ? 'cancelled' : /预算/.test(result.reason) ? 'timed_out' : 'failed'; }
  result.issues = result.issues.map((x, i) => Object.assign({ id: 'r' + (i + 1) }, x));
  result.fingerprint = before.hash; result.spentMs = spent + Date.now() - started; result.at = Date.now();
  let valid = false;
  S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) { const terminal = o[key].status; if (terminal !== 'running') { result.status = terminal; result.reason = o[key].reason; } result.spentMs = Math.max(result.spentMs, Number(o[key].spentMs) || 0); o[key] = Object.assign(o[key], result); valid = true; } });
  if (!valid) { result.status = 'cancelled'; result.reason = '迟到结果已忽略'; return result; }
  const folder = path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'); const file = path.join(folder, opts.mode + '.json');
  try { if (!store.atomicWrite(file, result)) throw new Error('结果写入失败'); result.file = file; }
  catch (e) { result.status = 'failed'; result.reason = '审查结果未能保存，不能登记为完成'; S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], result); }); }
  try { const U = require('./usage'); U.bump(result.status === 'timed_out' ? 'review.timeout' : 'review.' + result.status); } catch (e) { /* 计数失败不改变结论 */ }
  if (change && result.status === 'completed') {
    S.recordReview(opts.mode, change.dir, result.issues.length, id, Date.now());
    S.updateState(opts.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const r = o[S.normKey(change.dir)]; if (r && r.key === id) { if (opts.mode === 'code') r.fingerprint = before.hash; else { r.proposalHash = require('./apply-scope').planHash(change.dir); r.materialInputs = result.materialInputs; } r.reportFile = file; r.executor = 'direct'; r.covered = result.covered; } });
  }
  return result;
}
function status(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code'); const r = S.readState('review-jobs')[key]; if (r && r.status === 'running' && (!alive(r.pid) || Date.now() >= r.deadline)) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === r.id) { o[key].spentMs = used(o[key], Date.now()); o[key].status = 'interrupted'; o[key].reason = '执行进程退出或超过截止时间，没有完整结果'; } }); return S.readState('review-jobs')[key]; } return r || { status: 'none' }; }
function cancel(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code'); S.updateState('review-jobs', (o) => { if (o[key] && o[key].status === 'running') { o[key].spentMs = used(o[key], Date.now()); o[key].status = 'cancelled'; o[key].reason = '用户或当前会话取消'; } }); return status(opts); }
function resolve(opts) {
  const change = changeOf(opts.cwd || process.cwd(), opts.change); if (!change) throw new Error('意见处理需要当前变更');
  const r = S.reviewRecord('code', change.dir); if (!r || (!r.reportFile && r.executor !== 'agent')) throw new Error('没有可配对的完整审查报告');
  const report = r.reportFile ? JSON.parse(fs.readFileSync(r.reportFile, 'utf8')) : { id: r.key, fingerprint: r.fingerprint || W.fingerprint(opts.cwd, 'code').hash, issues: Array.from({ length: Number(r.issues) || 0 }, (_, i) => ({ id: 'r' + (i + 1) })) }; const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  for (const issue of report.issues) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !['fixed', 'rejected', 'accepted'].includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (report.id !== r.key || !Array.isArray(report.issues)) throw new Error('审查报告不属于当前完整记录');
  if (decisions.findings.length !== report.issues.length || new Set(decisions.findings.map((x) => x.id)).size !== report.issues.length || decisions.findings.some((x) => !report.issues.some((i) => i.id === x.id))) throw new Error('处理记录必须恰好对应报告中的意见');
  if (decisions.findings.some((x) => x.action === 'fixed') && !require('./evidence').commands(opts.cwd || process.cwd()).length) throw new Error('成立问题修复后还没有当前输入的成功复验证据');
  const fingerprint = W.fingerprint(opts.cwd || process.cwd(), 'code').hash;
  if (!decisions.findings.some((x) => x.action === 'fixed') && fingerprint !== report.fingerprint) throw new Error('输入在审查后变化；仅驳回或零问题记录不能批准新版，需要补审');
  S.updateState('reviewed', (o) => { const rec = o[S.normKey(change.dir)]; if (rec && rec.key === r.key) { rec.resolved = true; rec.resolvedAt = Date.now(); rec.resolvedFingerprint = fingerprint; rec.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) })); } });
  return { status: 'resolved', count: report.issues.length };
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
function instruction(name, mode, cfg) { return cfg.reviewExecutor === 'agent' ? '按 /ttls-cross-review 的兼容代理方式审查 ' + name + '，最多等待 ' + cfg.reviewBudgetSeconds + ' 秒，超时取消已知审查任务并交代未覆盖范围' : '执行 review.js run --change ' + name + ' --mode ' + mode + '，总预算 ' + cfg.reviewBudgetSeconds + ' 秒'; }
module.exports = { run, materials, inputsCurrent, baseline, status, stateFor, instruction, cancel, resolve, jobKey, budgetIssue, parseReply, syncAgent, waived, waive, decisionIssue };

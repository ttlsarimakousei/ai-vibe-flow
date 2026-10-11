'use strict';
/* 独立审查执行器：主会话准备确定材料，经本机路由审查角色发有限请求。无工具、无自主检索；总预算、覆盖和取消决定是否记为完成。 */
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
function materials(opts, change) {
  const items = []; const skipped = []; const cfg = S.readConfig(); const maxFiles = Math.min(60, Math.max(1, Number(cfg.reviewMaxFiles) || 20));
  const add = (file, text, root) => {
    if (secretFile(file)) { skipped.push({ file, reason: '敏感配置不进审查材料' }); return; }
    if (items.length >= maxFiles) { skipped.push({ file, reason: '超过本轮文件上限' }); return; }
    if (text.length > 50000) { skipped.push({ file, reason: '单文件材料超过上限，请拆范围' }); return; }
    items.push({ file, root, text: R.material(text) });
  };
  if (opts.mode === 'proposal') {
    if (!change) throw new Error('提案审查需要有效变更名');
    for (const f of S.artifactFiles(change.dir)) { try { add(path.relative(change.dir, f), fs.readFileSync(f, 'utf8'), change.dir); } catch (e) { skipped.push({ file: f, reason: '材料不可读' }); } }
    const issues = require('./proposal-files').changeIssues(S.artifactOf(path.join(change.dir, 'proposal.md')));
    if (issues.length) throw new Error('提案材料交付检查未通过：' + issues.join('；'));
    const roots = S.projectRootsOf(change.dir); const references = new Set(S.artifactFiles(change.dir).flatMap((f) => S.pathTokens(fs.readFileSync(f, 'utf8'))));
    for (const ref of references) for (const root of roots) { const f = path.resolve(root, ref); if (!S.underDir(f, root) || S.underDir(f, change.dir) || secretFile(f) || /[\\/]\.vibe[\\/]/.test(f)) continue; try { if (fs.statSync(f).isFile()) { add(path.relative(opts.cwd, f).replace(/\\/g, '/'), fs.readFileSync(f, 'utf8'), root); break; } } catch (e) { /* 只读提案点名且存在的依据，不自主检索 */ } }
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
        const diff = W.git(root, ['diff', '--no-ext-diff', '--no-textconv', '--unified=5', base, '--', file]);
        let text = diff;
        try { const current = fs.readFileSync(path.join(root, file), 'utf8'); text = diff ? '基线差异：\n' + diff + '\n当前文件：\n' + current : current; } catch (e) { if (!text) text = '文件已删除'; }
        const oldDirty = saved && saved.repos.find((r) => S.normKey(r.root) === S.normKey(root));
        if (oldDirty && (oldDirty.dirtyFiles || []).includes(file)) text = '说明：该文件在开工前已有改动，不能全部认作本次助手改动。\n' + text;
        add(path.relative(opts.cwd, path.join(root, file)).replace(/\\/g, '/'), text, root);
      }
    }
    if (change) for (const f of S.artifactFiles(change.dir).filter((f) => !/revisions\.md$/.test(f))) { try { add(path.relative(change.dir, f), fs.readFileSync(f, 'utf8'), change.dir); } catch (e) { skipped.push({ file: f, reason: '需求不可读' }); } }
  }
  const batches = []; let batch = [], size = 0;
  for (const item of items) { if (size + item.text.length > 80000 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(item); size += item.text.length; }
  if (batch.length) batches.push(batch);
  return { items, skipped, batches };
}
function routerUrl() {
  if (process.env.VIBE_KIT_REVIEW_PORT) return 'http://127.0.0.1:' + Number(process.env.VIBE_KIT_REVIEW_PORT) + '/v1/messages';
  try { const settings = JSON.parse(fs.readFileSync(path.join(S.KIT, '..', 'settings.json'), 'utf8')); for (const groups of Object.values(settings.hooks || {})) for (const g of groups) for (const h of g.hooks || []) if (h.type === 'http' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/vibe-kit\/hook\//.test(h.url)) return new URL('/v1/messages', h.url).href; } catch (e) { /* 尚无 HTTP 钩子 */ }
  return 'http://127.0.0.1:15730/v1/messages';
}
function ask(url, material, mode, ms, cancelled) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'claude-sonnet-vibe-review', stream: false, max_tokens: 5000, system: '你是独立审查者。只审提供的材料，不运行命令、不调用工具、不推测未提供的内容。找实际错误、风险和遗漏，正常情况不提建议凑数。简体中文直说。返回 JSON，格式 {"issues":[{"severity":"P1|P2|P3","file":"材料中的文件","line":1,"problem":"问题","evidence":"可核对依据","fix":"修复建议"}],"summary":"覆盖和限制"}。没有问题 issues 为 []。', messages: [{ role: 'user', content: '模式：' + mode + '\n本批材料：\n' + JSON.stringify(material) }] });
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (b) => { text += b; if (text.length > 300000) req.destroy(new Error('审查回复过大')); });
      res.on('end', () => { clear(); if (res.statusCode !== 200) return reject(new Error('本机路由返回 ' + res.statusCode + '：' + R.clip(text, 300))); try { const reply = JSON.parse(text); const resultText = (reply.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').replace(/^```(?:json)?\s*|\s*```$/g, ''); const result = JSON.parse(resultText); if (!Array.isArray(result.issues) || result.issues.length > 100 || result.issues.some((x) => !x || typeof x.problem !== 'string' || typeof x.evidence !== 'string' || !material.some((m) => m.file === x.file))) throw new Error('结果缺少可核对的问题结构'); resolve(R.tree(result)); } catch (e) { reject(new Error('审查结果格式无法识别，未记为完成')); } });
      res.on('error', (e) => { clear(); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('审查总预算用完')), Math.max(1, ms));
    const poll = setInterval(() => { if (cancelled()) req.destroy(new Error('审查已取消或被新运行替换')); }, 200);
    const clear = () => { clearTimeout(timer); clearInterval(poll); };
    req.on('error', (e) => { clear(); reject(e); }); req.end(body);
  });
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
  const spent = opts.newBudget ? 0 : Number(previous && previous.spentMs) || 0;
  const deadline = started + Math.max(0, budget - spent);
  S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) o[key].deadline = deadline; });
  const cancelled = () => { const job = S.readState('review-jobs')[key]; return !job || job.id !== id || job.status !== 'running'; };
  let result = { id, mode: opts.mode, status: 'failed', issues: [], covered: [], skipped: [] };
  try {
    if (deadline <= started) throw new Error('累计审查预算已用完；交代现有结果和未覆盖范围，用户可明确用 --new-budget 开启新预算');
    const material = materials(opts, change); result.skipped = material.skipped;
    if (!material.batches.length) throw new Error('没有可审查材料或开工基线缺失');
    for (let i = 0; i < material.batches.length; i++) {
      if (cancelled()) throw new Error('审查已取消');
      if (progress) progress('审查 ' + (i + 1) + '/' + material.batches.length + ' 批，已覆盖 ' + result.covered.length + ' 个文件，剩余预算 ' + Math.max(0, Math.round((deadline - Date.now()) / 1000)) + ' 秒');
      const reply = await ask(routerUrl(), material.batches[i], opts.mode, deadline - Date.now(), cancelled);
      result.issues.push(...reply.issues); result.covered.push(...material.batches[i].map((x) => x.file));
      S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id && o[key].status === 'running') { o[key].completedBatches = i + 1; o[key].covered = result.covered.length; } });
    }
    if (cancelled()) throw new Error('审查已取消或结果已迟到');
    if (W.fingerprint(opts.cwd, opts.mode === 'code' ? 'code' : 'all').hash !== before.hash) { result.status = 'stale'; result.reason = '审查期间输入变更，本轮结果不能批准新版'; }
    else if (result.skipped.length) { result.status = 'partial'; result.reason = '还有未覆盖材料，不能记为完整审查'; }
    else result.status = 'completed';
  } catch (e) { result.reason = R.clip(e.message, 500); result.status = /取消|迟到|替换/.test(result.reason) ? 'cancelled' : /预算/.test(result.reason) ? 'timed_out' : 'failed'; }
  result.issues = result.issues.map((x, i) => Object.assign({ id: 'r' + (i + 1) }, x));
  result.fingerprint = before.hash; result.spentMs = spent + Date.now() - started; result.at = Date.now();
  let valid = false;
  S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id && o[key].status === 'running') { o[key] = Object.assign(o[key], result); valid = true; } });
  if (!valid) { result.status = 'cancelled'; result.reason = '迟到结果已忽略'; return result; }
  const folder = path.join(opts.cwd, '.vibe', 'reviews', opts.change || 'plain'); const file = path.join(folder, opts.mode + '.json');
  try { store.atomicWrite(file, JSON.stringify(result, null, 2) + '\n'); result.file = file; }
  catch (e) { result.status = 'failed'; result.reason = '审查结果未能保存，不能登记为完成'; S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === id) Object.assign(o[key], result); }); }
  try { const U = require('./usage'); U.bump(result.status === 'timed_out' ? 'review.timeout' : 'review.' + result.status); } catch (e) { /* 计数失败不改变结论 */ }
  if (change && result.status === 'completed') {
    S.recordReview(opts.mode, change.dir, result.issues.length, id, Date.now());
    S.updateState(opts.mode === 'proposal' ? 'reviewed-proposal' : 'reviewed', (o) => { const r = o[S.normKey(change.dir)]; if (r && r.key === id) { if (opts.mode === 'code') r.fingerprint = before.hash; r.reportFile = file; r.executor = 'direct'; r.covered = result.covered; } });
  }
  return result;
}
function status(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code'); const r = S.readState('review-jobs')[key]; if (r && r.status === 'running' && (!alive(r.pid) || Date.now() >= r.deadline)) { S.updateState('review-jobs', (o) => { if (o[key] && o[key].id === r.id) { o[key].status = 'interrupted'; o[key].reason = '执行进程退出或超过截止时间，没有完整结果'; } }); return S.readState('review-jobs')[key]; } return r || { status: 'none' }; }
function cancel(opts) { const key = jobKey(opts.cwd || process.cwd(), opts.change, opts.mode || 'code'); S.updateState('review-jobs', (o) => { if (o[key] && o[key].status === 'running') { o[key].status = 'cancelled'; o[key].reason = '用户或当前会话取消'; } }); return status(opts); }
function resolve(opts) {
  const change = changeOf(opts.cwd || process.cwd(), opts.change); if (!change) throw new Error('意见处理需要当前变更');
  const r = S.reviewRecord('code', change.dir); if (!r || !r.reportFile) throw new Error('没有可配对的完整审查报告');
  const report = JSON.parse(fs.readFileSync(r.reportFile, 'utf8')); const decisions = JSON.parse(fs.readFileSync(opts.decisions, 'utf8'));
  if (!Array.isArray(decisions.findings)) throw new Error('处理记录需要 findings 数组');
  for (const issue of report.issues) { const d = decisions.findings.find((x) => x.id === issue.id); if (!d || !['fixed', 'rejected'].includes(d.action) || typeof d.reason !== 'string' || d.reason.trim().length < 10) throw new Error('每条意见都要对应处理动作和可核对依据：' + issue.id); }
  if (decisions.findings.some((x) => x.action === 'fixed') && !require('./evidence').current(opts.cwd || process.cwd()).length) throw new Error('成立问题修复后还没有当前输入的成功复验证据');
  const fingerprint = W.fingerprint(opts.cwd || process.cwd(), 'code').hash;
  S.updateState('reviewed', (o) => { const rec = o[S.normKey(change.dir)]; if (rec && rec.key === r.key) { rec.resolved = true; rec.resolvedAt = Date.now(); rec.resolvedFingerprint = fingerprint; rec.decisions = decisions.findings.map((x) => ({ id: x.id, action: x.action, reason: R.clip(x.reason, 1000) })); } });
  return { status: 'resolved', count: report.issues.length };
}
function stateFor(dir, mode) { const c = S.artifactOf(path.join(dir, 'tasks.md')); return status({ cwd: c ? c.root : dir, change: path.basename(dir), mode }); }
function instruction(name, mode, cfg) { return cfg.reviewExecutor === 'agent' ? '按 /ttls-cross-review 的兼容代理方式审查 ' + name + '，最多等待 ' + cfg.reviewBudgetSeconds + ' 秒，超时取消已知审查任务并交代未覆盖范围' : '执行 review.js run --change ' + name + ' --mode ' + mode + '，总预算 ' + cfg.reviewBudgetSeconds + ' 秒'; }
module.exports = { run, materials, baseline, status, stateFor, instruction, cancel, resolve, jobKey };

'use strict';
/*
 * 探索记录的多角度讨论（问题表第 92 条，仓库主人 2026-11-20 定的；借鉴 Claude Code 的 agent teams，但不开子代理、不用 agent teams：
 * 内网子代理一个角度要 1～2 小时，11-05 起审查都改成不带工具的 claude -p，这里一样）。
 *   什么时候：探索记录"还没定的"清空了、写这个大任务第一个提案之前，强制跑一轮（hooks/guard-spec.js 新建 proposal.md 时查；仓库主人选的"强制一轮"）
 *   三个角度，各一个 claude -p，同时跑：用户和业务 / 现有代码 / 反方（review-runner.askClaude：不带工具、关掉钩子、不留会话记录）
 *   材料：探索记录全文，加脚本查好的事实（探索记录点名的类、方法、表在代码里的位置，review-facts.factsOf 的 proposal 模式）
 *   要的结果只有两类：要问用户的问题、探索记录里矛盾或说不清的地方。不提新功能（第 43 条"不自己加"）
 *   脚本去重后追加进探索记录"还没定的"一节（每条带"（多角度讨论：<角度>）"）：已有的"还没定的清空了才写需求"那道检查接着挡，模型用提问框问用户
 *   至少两个角度交了结论才算讨论过，记在 state/big-task.json 这个大任务的 panel 上；没提出问题也算过。一个大任务只讨论一轮，后来补了回答也不再讨论
 * 命令：node review.js run --mode explore --task <大任务> --project <项目>。最多等 9 分钟（Bash 单条命令最多 10 分钟），没跑完返回 running，再跑一次接着等，不重开。
 * 老任务（没有探索记录）、升级前就开始写提案的大任务不查（gateIssue）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WAIT_MS = 9 * 60000;
const WORKER_MS = 45 * 60000; // 一个角度最多两次请求，一次最多 20 分钟（和审查一样）
const MAX_ITEMS = 8;
const LENSES = [
  { name: '用户和业务', text: '你这次只从用户和业务看：谁在什么情况下用、要做成什么样；业务规则、权限（谁能看、谁能改）、异常流程（失败、重复提交、数据不全）、边界数据（空、超长、很多条），探索记录说清楚了没有。没说清、又会影响做法或验收的，写成要问用户的问题。' },
  { name: '现有代码', text: '你这次只从现有代码看："脚本查的"那几节是探索记录点名的类、方法、表在代码里的样子。探索记录说的现状和代码对得上吗；要改的地方会碰到哪些已有的校验、权限、数据；代码里有没有已经做了一部分、探索记录没提的同类功能。对不上的、会改坏已有功能的、要用户拿主意的，写成问题。材料里没有的代码不要猜。' },
  { name: '反方', text: '你这次专门挑毛病：探索记录前后矛盾的地方、"范围"和"定了的"打架的地方、验收标准核对不了的（没有具体输入和结果）、两种理解都说得通的说法。每一处写成要问用户的问题，问题里把两种理解都写出来。' },
];
const RULE = [
  '你在帮忙把一份需求探索记录问清楚。你只读不改，没有工具可用：材料都在这条消息里，一次看完，直接给结论。不要把想过的再想一遍。',
  '只提两类：要问用户的问题（kind 写 ask）、探索记录里矛盾或说不清的地方（kind 写 unclear，也写成要问用户的一句话）。不提新功能、新校验、新按钮：用户没说的不加，"这里加个导出更好"这种不提。探索记录"定了的"里已经定了的不再问；"还没定的"里已经有的不重复。',
  '一条一个问题，写成能直接问用户的一句话，why 写不问清会怎么样。最多 ' + MAX_ITEMS + ' 条，挑最影响做法和验收的；没有就 items 写 []，不要凑数。',
  '最后只回一个 JSON 代码块，别的不写：',
  '```json\n{"items":[{"kind":"ask","question":"导出的 Excel 要不要带上已停用的商品？","why":"探索记录只说导出全部商品，停用的算不算全部没写，影响查询条件和验收数据"}],"summary":"看了什么"}\n```',
].join('\n\n');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '-');
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 等不了就接着 */ } };
const resultFile = (dir, lens) => path.join(dir, 'result-' + safeName(lens) + '.json');

/** 找大任务：--task 给了按名字；没给时这个目录下只有一个有探索记录的就是它 */
function taskOf(cwd, name) {
  const B = require('./big-task');
  const all = B.tasks(cwd);
  const task = name ? all.find((t) => t.name === name) : (all.filter((t) => !t.legacy).length === 1 ? all.find((t) => !t.legacy) : null);
  if (!task) throw new Error('没找到大任务' + (name ? ' ' + name : '') + '：--task 写 openspec/plan.md 里大任务的名字（## 后面那个）' + (all.length ? '，现在有：' + all.map((t) => t.name).join('、') : '；这个目录下没有 openspec/plan.md，--project 写项目目录'));
  if (task.legacy || !task.explore || !fs.existsSync(task.explore)) throw new Error('大任务 ' + task.name + ' 没有探索记录，不用讨论');
  return task;
}
const folderOf = (task) => path.join(path.dirname(task.osDir), '.vibe', 'reviews', 'explore-' + safeName(task.name));

/** 这个大任务讨论过没有：{ at, added, lenses } 或 null */
function doneOf(task) { try { return require('./big-task').taskState(task).panel || null; } catch (e) { return null; } }

/**
 * 新建提案时查（guard-spec）：这个大任务要先讨论一轮。返回拦的话，或 ''。
 * 不查：老任务、没有探索记录、"还没定的"没清空（那一道先挡）、这个大任务别的 change 已经开始了（升级前就在做的，不半路补）
 */
function gateIssue(task, art) {
  if (!task || task.legacy || !task.explore || !fs.existsSync(task.explore)) return '';
  const B = require('./big-task');
  if (B.exploreOpen(task)) return '';
  if (task.changes.some((c) => c.name !== art.name && (c.archived || (c.exists && fs.existsSync(path.join(c.dir, 'proposal.md')))))) return '';
  if (doneOf(task)) return '';
  const tool = 'node "' + path.join(__dirname, '..', 'tools', 'review.js').split(path.sep).join('/') + '"';
  return '写提案之前，探索记录要先过一轮多角度讨论（问题表第 92 条）：跑 ' + tool + ' run --mode explore --task ' + task.name + ' --project "' + path.dirname(task.osDir).split(path.sep).join('/') + '"（Bash 的 timeout 写 600000）。'
    + '它从用户和业务、现有代码、反方三个角度看探索记录，要问用户的问题直接写进"还没定的"；有的话用提问框一次问完，答案写进"定了的"、从"还没定的"删掉，清空了再写提案。没提出问题就直接写。';
}

/** 起一轮：写好三个角度的提示，各起一个后台进程 */
function start(task, folder) {
  const S = require('./session');
  const root = path.dirname(task.osDir);
  const text = fs.readFileSync(task.explore, 'utf8');
  const rel = path.relative(root, task.explore).split(path.sep).join('/');
  let facts = '';
  try { facts = require('./review-facts').factsOf('proposal', [{ file: rel, text, role: 'doc' }], root, []); } catch (e) { facts = ''; }
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(folder, 'job-' + id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-settings.json'), JSON.stringify({ disableAllHooks: true }));
  const job = { id, task: task.name, explore: task.explore, root, dir, status: 'running', started: Date.now(), hash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16), lenses: {} };
  for (const l of LENSES) {
    const prompt = RULE + '\n\n## 这次的角度：' + l.name + '\n\n' + l.text + '\n\n## 探索记录（' + rel + '）\n\n' + text + (facts ? '\n\n' + facts : '') + '\n';
    fs.writeFileSync(path.join(dir, safeName(l.name) + '.prompt.md'), prompt);
    job.lenses[l.name] = { status: 'sent', sentAt: Date.now() };
    try {
      const child = spawn(process.execPath, [path.join(S.KIT, 'tools', 'review.js'), 'explore-worker', dir, l.name], { detached: true, windowsHide: true, stdio: 'ignore', cwd: root, env: process.env });
      child.on('error', () => { /* pid 是空的，下面按没交算 */ });
      child.unref();
      if (child.pid) job.lenses[l.name].pid = child.pid; else job.lenses[l.name] = { status: 'failed', error: '讨论进程起不来' };
    } catch (e) { job.lenses[l.name] = { status: 'failed', error: '讨论进程起不来：' + ((e && e.message) || e) }; }
  }
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify(job, null, 2));
  return job;
}

/** 后台进程：一个角度。回复里没有 JSON 重试一次。结果写 result-<角度>.json */
function work(dir, lens) {
  const R = require('./review-runner');
  let out = { ok: false, error: '没拿到结论' };
  try {
    const prompt = fs.readFileSync(path.join(dir, safeName(lens) + '.prompt.md'), 'utf8');
    const settings = path.join(dir, 'claude-settings.json');
    const job = readJson(path.join(path.dirname(dir), 'job.json')) || {};
    for (let i = 0; i < 2; i++) {
      const r = R.askClaude(i ? prompt + '\n上一次你只想没有回结论。这次不要再分析，直接按上面的格式回 JSON。\n' : prompt, job.root || process.cwd(), settings);
      if (r.err && !r.text) { out = { ok: false, error: 'claude -p 出错：' + r.err, ms: r.ms }; break; }
      try { out = Object.assign({ ok: true, ms: r.ms, tokens: r.out }, parse(r.text)); break; } catch (e) { out = { ok: false, error: e.message + (r.out ? '（输出 ' + r.out + ' token）' : ''), ms: r.ms }; }
    }
  } catch (e) { out = { ok: false, error: (e && e.message) || String(e) }; }
  try { fs.writeFileSync(resultFile(dir, lens), JSON.stringify(out, null, 2)); } catch (e) { /* 写不了：按没交算 */ }
}
/** 模型的回复里取 JSON：{ items: [{ kind, question, why }], summary } */
function parse(text) {
  const body = String(text || '');
  const tryParse = (t) => { try { return JSON.parse(t); } catch (e) { return undefined; } };
  let r;
  for (const m of [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].reverse()) { r = tryParse(m[1]); if (r !== undefined) break; }
  if (r === undefined) { const i = body.indexOf('{'); const k = body.lastIndexOf('}'); if (i >= 0 && k > i) { r = tryParse(body.slice(i, k + 1)); if (r === undefined) { try { r = tryParse(require('./review-runner').repairJson(body.slice(i, k + 1))); } catch (e) { r = undefined; } } } }
  if (!r || !Array.isArray(r.items)) throw new Error('回复里没有带 items 数组的 JSON');
  const items = r.items.filter((x) => x && typeof x.question === 'string' && x.question.trim()).slice(0, MAX_ITEMS).map((x) => ({ kind: x.kind === 'unclear' ? 'unclear' : 'ask', question: clip(x.question, 200), why: clip(x.why, 200) }));
  return { items, summary: clip(r.summary, 400) };
}

/** 一个角度现在怎样：submitted（交了）、failed（出错、进程没了、超时）、sent（还在跑） */
function lensState(job, name) {
  const s = job.lenses[name] || {};
  if (s.status === 'failed') return { status: 'failed', error: s.error };
  const r = readJson(resultFile(job.dir, name));
  if (r) return r.ok ? { status: 'submitted', result: r } : { status: 'failed', error: r.error };
  const tooLong = Date.now() - (Number(s.sentAt) || 0) > WORKER_MS;
  if (tooLong || (s.pid && !pidAlive(s.pid))) return { status: 'failed', error: tooLong ? '超过 45 分钟没交' : '讨论进程没了' };
  return { status: 'sent' };
}

/** 去重：问题去掉标点、空白后一样的算一条；已经在"还没定的""定了的"里的不加 */
const norm = (s) => String(s || '').replace(/[\s，。,.？?！!：:；;、“”"'（）()【】\[\]]/g, '').toLowerCase();
/** 追加进探索记录"还没定的"一节。返回加了几条 */
function appendOpen(file, items) {
  const B = require('./big-task');
  let text = fs.readFileSync(file, 'utf8');
  const secs = B.exploreSections(file) || {};
  const have = norm((secs['还没定的'] || '') + (secs['定了的'] || ''));
  const seen = new Set();
  const lines = [];
  for (const x of items) {
    const k = norm(x.question);
    if (!k || seen.has(k) || have.includes(k)) continue;
    seen.add(k);
    lines.push('- ' + x.question + (x.why ? '（' + x.why + '）' : '') + '（多角度讨论：' + x.lens + '）');
  }
  if (!lines.length) return 0;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const m = /^##[ \t]+还没定的[ \t]*$/m.exec(text);
  if (!m) { text = text.replace(/\s*$/, '') + eol + eol + '## 还没定的' + eol + eol + lines.join(eol) + eol; }
  else {
    // 这一节的正文：标题之后到下一个二级标题。原来写着"无""都定了"的那一行换掉，别的留着
    const bodyStart = m.index + m[0].length;
    const next = text.slice(bodyStart).search(/^##[ \t]/m);
    const bodyEnd = next < 0 ? text.length : bodyStart + next;
    const body = text.slice(bodyStart, bodyEnd);
    // 原来写着"无""都定了"（算空）的整节换掉；有真内容的留着，接在后面
    const kept = B.exploreOpen({ explore: file }) ? body.replace(/\s*$/, '') : '';
    text = text.slice(0, bodyStart) + eol + eol + (kept.trim() ? kept.trim() + eol : '') + lines.join(eol) + eol + eol + text.slice(bodyEnd).replace(/^\s*/, '');
  }
  fs.writeFileSync(file, text);
  return lines.length;
}

/** 都交了（或者出错了）：合起来，写进探索记录，记成讨论过 */
function finish(job, task) {
  const states = LENSES.map((l) => ({ name: l.name, s: lensState(job, l.name) }));
  const ok = states.filter((x) => x.s.status === 'submitted');
  const failed = states.filter((x) => x.s.status === 'failed').map((x) => x.name + '：' + clip(x.s.error, 120));
  const folder = path.dirname(job.dir);
  if (ok.length < 2) {
    job.status = 'failed'; job.failed = failed; job.endedAt = Date.now();
    fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify(job, null, 2));
    try { require('./feedback').recordHookError('explore-panel', {}, new Error('探索记录多角度讨论只有 ' + ok.length + ' 个角度交了结论：' + failed.join('；'))); } catch (e) { /* 记不了就算了 */ }
    return { status: 'failed', task: task.name, failed, next: '只有 ' + ok.length + ' 个角度交了结论，不算讨论过。再跑一次一样的命令重来；连着几次都这样，告诉用户，在交代里写清楚。' };
  }
  const items = ok.flatMap((x) => (x.s.result.items || []).map((it) => Object.assign({ lens: x.name }, it)));
  const added = appendOpen(task.explore, items);
  job.status = 'completed'; job.added = added; job.endedAt = Date.now(); job.failed = failed;
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify(job, null, 2));
  try { require('./big-task').setTaskState(task, { panel: { at: Date.now(), added, lenses: ok.map((x) => x.name), hash: job.hash } }); } catch (e) { /* 记不了：下次新建提案还会让它跑 */ }
  const rel = path.relative(job.root, task.explore).split(path.sep).join('/');
  return {
    status: 'completed', task: task.name, added, lenses: ok.map((x) => x.name), failed: failed.length ? failed : undefined,
    questions: items.map((x) => '[' + x.lens + '] ' + x.question),
    next: added ? '加进了探索记录 ' + rel + ' "还没定的"一节 ' + added + ' 条（标着"多角度讨论"）。用提问框一次问用户（一个框最多 4 问，多的分几个框），答案写进"定了的"、从"还没定的"删掉；"还没定的"清空了再写提案。用户没回、到点让你自己定的，照提问框收掉时那句话做。'
      : '三个角度都没提出要问用户的，讨论过了，接着写提案。',
  };
}

/** 讨论一轮，最多等 waitSeconds（默认 9 分钟）。opts：{ cwd, task, waitSeconds, full } */
function run(opts) {
  const cwd = path.resolve((opts && opts.cwd) || process.cwd());
  const task = taskOf(cwd, opts && opts.task);
  const done = doneOf(task);
  const folder = folderOf(task);
  const jobFile = path.join(folder, 'job.json');
  if (done && !(opts && opts.full)) return { status: 'completed', already: true, task: task.name, added: done.added || 0, next: '大任务 ' + task.name + ' 的探索记录讨论过了（' + new Date(done.at).toLocaleString() + '），不用再跑，接着写提案。' };
  fs.mkdirSync(folder, { recursive: true });
  let job = readJson(jobFile);
  if (!job || job.status !== 'running' || !fs.existsSync(job.dir || '')) job = start(task, folder);
  const limit = Date.now() + (Number(opts && opts.waitSeconds) > 0 ? Number(opts.waitSeconds) * 1000 : WAIT_MS);
  for (;;) {
    const open = LENSES.filter((l) => lensState(job, l.name).status === 'sent');
    if (!open.length) return finish(job, task);
    if (Date.now() >= limit) return { status: 'running', task: task.name, waiting: open.map((l) => l.name), next: '还有 ' + open.length + ' 个角度没交（' + open.map((l) => l.name).join('、') + '）。再跑一次一样的命令接着等，不会重开。' };
    pause(1000);
  }
}

module.exports = { LENSES, run, work, parse, gateIssue, appendOpen, doneOf, taskOf };

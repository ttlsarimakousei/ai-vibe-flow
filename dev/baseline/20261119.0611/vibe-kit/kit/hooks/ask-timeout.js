'use strict';
/*
 * PermissionRequest 钩子：提问框、权限确认框发出后没人回，等够时间替用户收掉（问题表第 90 条，仓库主人 2026-11-13 定的；
 * 2026-11-18 仓库主人改成任何时候都算：探索、写需求、实施、核验、不走 OpenSpec 的普通任务都一样，以前只在自动实施时）。
 *   提问框（AskUserQuestion）：到点按"不允许"收掉，带一句话让模型自己定、记下来接着做。按在做什么给不同的交代：
 *     写需求那一段：选推荐的写进需求，写进去的地方标"（用户没回，按推荐定的）"，记进 revisions.md，最后交代时列出来（仓库主人选的"按推荐定，标出来"）；
 *     做任务、核验那一段：照自动模式的规矩自己定、记进 revisions.md；普通任务：自己定，交代时说清替用户定了什么。
 *     需求审过问"开始实施 / 先不实施"的那一问：到点钩子替用户开工（登记开工范围、进做任务那一段），仓库主人选的"问，没人答到点就开工"。
 *     别的不替用户选选项：脚本选了的话，会话记录里就是"用户答了"，推送、归档这些认用户表态的检查会当成用户点了头。
 *   别的工具的权限确认框：到点按"允许"（仓库主人定的）。命令里像推送、发布的除外：按"不允许"收掉，留给用户。
 *     跑查库、redis 工具的命令也按"不允许"（复审 R1）：那两个工具认"用户在不在"看钩子跑命令前留的条子，两分钟内才算数；
 *     框挂了 10 分钟再放行，条子早过期了，工具会当成有人在，要人确认的删就能拿着确认串执行。
 *     关服务（devserver.js stop）也按"不允许"：自己起的服务用户说关才关（用户 2026-11-17 定的）。
 *   ExitPlanMode 不管。
 * 任何时候都等（2026-11-18 起，权限确认框也是，仓库主人选的"什么时候都按允许"）。只读配置和流程状态文件，不调 git。
 * 等多久：配置页"询问没人回，等多久替你做主"（askTimeoutMin，默认 10 分钟，0 是一直等）。
 *
 * 实测（dev/probes/cc-ask-timeout.js，2.1.120、2.1.259、2.1.289、2.1.316）：框先显示、钩子同时被调；钩子给出决定时框自己收起、
 * 会话接着走；用户先答了，钩子的进程不会被结束，后到的决定不起作用。所以等的时候隔几秒看一眼会话记录：这个框有结果了、
 * 用户另说了话，就退出，不留一个等到点的进程。
 *
 * 不走 cli()：那里有 12 秒的本机预算，这个钩子本来就是要等的。出错一律什么都不说（框照常等人），记一条问题反馈。
 * 安装器给它写明的超时比能配的最长等待长（install.js）。
 */
const fs = require('fs');
const path = require('path');

const POLL_MS = 3000;          // 多久看一眼会话记录
const TAIL_BYTES = 800000;     // 看会话记录最后这么多字节
const PUSH_LIKE = /push|publish|发布到/i;   // 和 lib/session-out.js 的 pushFailOut 一个认法
const DATA_TOOL = /\b(db\.py|redis\.js)\b/i;  // 和 hooks/guard-commit.js 给查库、redis 留条子的认法一样
const NOT_OURS = /^(ExitPlanMode|EnterPlanMode)$/;
// 删东西、丢改动、还原不了的命令：确认框到点也不放（复审 R7）。rm -r/-f、git reset --hard、git clean -f、git checkout -- .、git restore .、
// git branch -D、git stash drop/clear、Remove-Item -Recurse、rd/rmdir /s、del /s、format
const DESTRUCTIVE = /(?:^|[\s;&|(])rm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--(?:recursive|force)\s+)|\bgit(?:\s+-C\s+\S+)?\s+(?:reset\s+(?:\S+\s+)*--hard|clean\s+(?:\S+\s+)*-[a-zA-Z]*f|checkout\s+(?:\S+\s+)*--\s+\.|restore\s+(?:--\S+\s+)*\.(?:\s|$)|branch\s+(?:\S+\s+)*-D\b|stash\s+(?:drop|clear)\b)|Remove-Item\b[^|;&]*-Recurse|(?:^|[\s;&|(])(?:rd|rmdir)\s+\/s|(?:^|[\s;&|(])del\s+(?:\/[a-zA-Z]\s+)*\/s|(?:^|[\s;&|(])format\s+[a-zA-Z]:/i;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const answer = (decision) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

/** 会话记录最后一段的条目（半截的第一行丢掉）。读不了返回 []。文件大小没变就用上一次解析的（框挂着的时候会话记录一般不动） */
let last = { file: '', size: -1, entries: [] };
function tail(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (last.file === file && last.size === size) return last.entries;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();
    const out = [];
    for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (e) { /* 半截行、正在写的行 */ } }
    last = { file, size, entries: out };
    return out;
  } catch (e) { return []; } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* 关不了不管 */ } }
}

/**
 * 这个框是不是已经有结果了：对应的那次工具调用有了结果，或者它之后用户另说了话（打断、发了新的一句）。
 * 钩子的输入里没有工具调用的 id：按名字一样、输入一样认最后一次；输入对不上（别的钩子改写过命令）认名字一样的最后一次。
 * 找不到这次调用（还没写进会话记录、被挤出读的那一段、transcript_path 是空的）：钩子起来之后用户另说了话就算有结果（复审 R3），
 * 别的返回 false。since 是钩子起来的时间。返回 true / false；opts.found 里放这次调用找没找到过（到点时决定报告怎么写）
 */
function settled(j, since, opts) {
  const es = tail(String(j.transcript_path || ''));
  const want = JSON.stringify(j.tool_input === undefined ? null : j.tool_input);
  let at = -1; let id = ''; let exact = false;
  // 子代理弹的框，transcript_path 给的是子代理自己的记录（条目都标着 isSidechain）：不按它筛
  es.forEach((e, i) => {
    const c = e && e.type === 'assistant' && e.message && e.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_use' || b.name !== j.tool_name) continue;
      const same = JSON.stringify(b.input === undefined ? null : b.input) === want;
      if (same || !exact) { at = i; id = String(b.id || ''); exact = exact || same; }
    }
  });
  if (at < 0) {
    // 框挂着的时候会话停在这一步，不会有新的用户的话；有了，就是用户按了 Esc 或者另说了一句
    return es.some((e) => e && e.type === 'user' && !e.isMeta && !e.isCompactSummary && (Date.parse(e.timestamp || '') || 0) > (since || 0) + 1000
      && !(Array.isArray(e.message && e.message.content) && e.message.content.some((b) => b && b.type === 'tool_result')));
  }
  if (opts) opts.found = true;
  for (let i = at + 1; i < es.length; i++) {
    const e = es[i];
    if (!e || e.type !== 'user') continue;
    const c = e.message && e.message.content;
    const results = Array.isArray(c) ? c.filter((b) => b && b.type === 'tool_result') : [];
    if (results.length) { if (results.some((b) => String(b.tool_use_id || '') === id)) return true; continue; }
    if (!e.isMeta && !e.isCompactSummary) return true;
  }
  return false;
}

/** 等多久（毫秒）。0 是不等、不管。测试用 VIBE_KIT_ASK_TIMEOUT_MS、VIBE_KIT_ASK_POLL_MS 顶替 */
function waitOf(cfg) {
  const over = process.env.VIBE_KIT_ASK_TIMEOUT_MS;
  if (over !== undefined && over !== '') return Math.max(0, Number(over) || 0);
  const m = Number(cfg && cfg.askTimeoutMin);
  return m > 0 ? m * 60000 : 0;
}
const pollOf = () => { const p = Number(process.env.VIBE_KIT_ASK_POLL_MS); return p > 0 ? p : POLL_MS; };
const waitedText = (ms) => (ms >= 60000 ? Math.round(ms / 60000) + ' 分钟' : Math.max(1, Math.round(ms / 1000)) + ' 秒');

/** 到点了：这个框怎么收。返回要打印的决定，顺手记进全自动报告。found 为 false：会话记录里一直没找到这次调用，报告里写明可能已经处理过 */
function decide(j, waitMs, found) {
  const tool = String(j.tool_name || '');
  const waited = waitedText(waitMs) + (found === false ? '（会话记录里没找到这一问，可能你已经处理过）' : '');
  let report = null;
  try { report = require('../lib/report.js'); } catch (e) { report = null; }
  const note = (item) => { try { if (report) report.note(j, item); } catch (e) { /* 记不了不影响 */ } };
  const S = require('../lib/session');
  if (tool === 'AskUserQuestion') {
    const qs = Array.isArray(j.tool_input && j.tool_input.questions) ? j.tool_input.questions : [];
    let st = {}; try { st = S.flowState(j) || {}; } catch (e) { st = {}; }
    // 需求审过问"开始实施 / 先不实施"的那一问：到点替用户开工（仓库主人 2026-11-18 选的"问，没人答到点就开工"）
    const applyAsk = st.on && st.stage !== 'apply' && qs.some((q) => ((q && q.options) || []).some((o) => S.autoAnswerOf(o && o.label, q.question) === 'on'));
    const started = applyAsk ? startApply(j, qs, waited, found) : null;
    if (started) return started;
    if (applyAsk) {
      // 对不上（会话记录里没找到这一问、问题里没点名唯一一个变更、需求还没整套审过）：不替用户开工，停下等用户
      S.hookLog('ask-timeout 开工那一问等了 ' + waited + '没人答，对不上开工的条件，没替用户开工：' + clip(qs.map((q) => q && q.question).join('；'), 80));
      return answer({ behavior: 'deny', message: '[vibe-kit] 开工那一问发出 ' + waited + '没人答。没替用户开工：问题里要点名一个变更、它的需求要整套审过，会话记录里要找得到这一问，有一样对不上。不要自己开工，停在这里，写进最后的交代，等用户回来说开工。' });
    }
    for (const q of qs.slice(0, 4)) note({ kind: 'ask', title: clip(q && q.question, 160), detail: ((q && q.options) || []).map((o) => clip(o && o.label, 40)).join(' / ') + '；等了 ' + waited + '没人答，让它自己定了' });
    S.hookLog('ask-timeout 提问框等了 ' + waited + '没人答，收掉让模型自己定：' + clip(qs.map((q) => q && q.question).join('；'), 80));
    const head = '[vibe-kit] 这个提问框发出 ' + waited + '没人答，按用户不在处理。这一问你自己定：选你推荐的那一项，拿不准就选改动最小、最容易改回来的；';
    const how = !st.on ? '最后交代时说清你替用户定了什么、为什么，接着做。'
      : st.stage !== 'apply' ? '定的内容写进需求文档的，在写进去的那句话后面标"（用户没回，按推荐定的）"；还没建变更、在探索的，写进探索记录"定了的"一节，带同样的标记；建了变更的，再记一条进它的 revisions.md（起因：用户没回，按推荐定的）。最后交代时把这几处列出来，让用户回来改。接着做。'
        : '把问的是什么、你怎么定的记进 revisions.md（起因：自动模式决定，用户没回），写进最后的交代，接着做。';
    return answer({ behavior: 'deny', message: head + how + HARD + '同一个问题不要再问一遍。' });
  }
  const cmd = String((j.tool_input && j.tool_input.command) || '');
  const what = tool + (cmd ? '：' + clip(cmd, 120) : '');
  if (/^(Bash|PowerShell)$/.test(tool) && DATA_TOOL.test(cmd)) {
    note({ kind: 'hand', title: '查库、redis 的命令要你确认、没人点，没让它跑：' + clip(cmd, 120), detail: '框挂久了，工具认不出你在不在' });
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，是查库、redis 的命令，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 这条查库、redis 的命令弹了确认框，' + waited + '没人点，不替用户放行。换一个不弹框的写法（不和 cd 串在一起，路径写全）重跑一次；还弹就把这一步留给用户，写进最后的交代，接着做别的。' });
  }
  // 关服务要用户点头（用户 2026-11-17 定的）：没人点就留着
  if (/^(Bash|PowerShell)$/.test(tool) && /devserver(?:\.js)?["']?\s+stop\b/i.test(cmd)) {
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，是关服务，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 关服务的确认框 ' + waited + '没人点，服务留着。不要再试，最后的交代里写一句哪些服务在跑、端口是多少，接着做别的。' });
  }
  // 还原不了的删、丢改动的命令（复审 R7：和提问框那边"还原不了的删留给用户"一个口径）：按不允许，留给用户
  if (/^(Bash|PowerShell)$/.test(tool) && DESTRUCTIVE.test(cmd)) {
    note({ kind: 'hand', title: '要你确认的命令没人点，没让它跑：' + clip(cmd, 120), detail: '删东西、丢改动还原不了，要你自己来' });
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，是还原不了的删除，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 这个确认框发出 ' + waited + '没人点。命令会删东西或丢掉改动，还原不了，留给用户：不要再试、不要换个写法删，写进最后的交代，接着做别的。' });
  }
  if (/^(Bash|PowerShell)$/.test(tool) && PUSH_LIKE.test(cmd)) {
    note({ kind: 'hand', title: '要你确认的命令没人点，没让它跑：' + clip(cmd, 120), detail: '推送、发布要你自己来' });
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，像推送、发布，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 这个确认框发出 ' + waited + '没人点。命令里有推送或发布，留给用户：不要再试，写进最后的交代，接着做别的。' });
  }
  note({ kind: 'bypass', title: '权限确认框没人点，到点替你点了允许：' + what, detail: '等了 ' + waited });
  S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，按允许收掉：' + clip(what, 80));
  return answer({ behavior: 'allow' });
}

const HARD = '要用户本人点头的事不能自己定（推送、归档、发布、还原不了的删）：那一步留给用户，写进最后的交代，接着做别的；没有别的可做就收工。';

/**
 * 开工那一问到点：替用户开工。按问题里点名的变更登记开工范围（和用户选了"开始实施"走同一个 grant），进做任务那一段，自动开着。
 * 只在这几样都对得上时开（复审 R2、R8）：会话记录里找到了这一问、还没有结果（found 为真）；问题里点了一个变更的名字；
 * 那个变更的需求整套审过了。对不上的返回 null，照普通的提问框收掉、让模型自己定（它定不了开工：没有用户的话，pre-edit 照旧拦）。
 * 开工没认下来（grant 不成）：收掉这个框，说清为什么没开工、停下等用户。返回要打印的决定
 */
function startApply(j, qs, waited, found) {
  if (found !== true) return null;
  const S = require('../lib/session');
  const context = qs.map((q) => String((q && q.question) || '')).join('\n');
  let named = [];
  try {
    const cwd = j.cwd || process.cwd();
    named = S.allChanges(cwd).filter((c) => S.mentionsChange(context, c.name));
    if (!named.length) named = S.nearChanges(cwd, context);
  } catch (e) { named = []; }
  if (named.length !== 1) return null;
  let reviewed = false;
  try { reviewed = require('../lib/flow-policy').allDone(named[0].dir, 'proposal'); } catch (e) { reviewed = false; }
  if (!reviewed) return null;
  let g = null;
  try { g = require('../lib/apply-scope').grant(j, '开始实施 ' + named[0].name, context, {}); } catch (e) { g = { ok: false, reason: (e && e.message) || String(e) }; }
  if (!g || !g.ok) {
    S.hookLog('ask-timeout 开工那一问等了 ' + waited + '没人答，想替用户开工没认下来：' + clip(g && g.reason, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 开工那一问发出 ' + waited + '没人答，想按"开始实施"替用户开工，开工没认下来：' + clip(g && g.reason, 200) + '。停在这里，写进最后的交代，等用户回来说开工。' });
  }
  S.setFlow(j, true, '开工那一问没人答，到点开工', 'apply');
  S.setSessionAuto(j, true, '开工那一问没人答，到点开工');
  const names = (g.targets || []).join('、');
  try { require('../lib/report.js').note(j, { kind: 'decision', title: '开工那一问没人答，到点替你开工了：' + clip(names, 120), detail: '等了 ' + waited }); } catch (e) { /* 记不了不影响 */ }
  S.hookLog('ask-timeout 开工那一问等了 ' + waited + '没人答，到点开工：' + clip(names, 80));
  // 同一个框里还有别的问题（复审 R2）：那几问照普通的到点规矩自己定
  const rest = qs.length > 1 ? '这个提问框里别的问题你自己定：选你推荐的那一项，记进 revisions.md（起因：自动模式决定，用户没回）。' : '';
  return answer({ behavior: 'deny', message: '[vibe-kit] 开工那一问发出 ' + waited + '没人答，按"开始实施"替用户开工了（' + names + '）：接着做任务，照自动实施的规矩做完、审查、改、复审，同一个问题不要再问。' + rest + '最后交代时写一句"开工那一问你没回，到点开工了"。' });
}

/** 父进程（Claude Code 起的那层）还在不在。查不了按还在算 */
function parentGone(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e && e.code === 'ESRCH'; }
}

/**
 * 返回要打印的决定，或者 null（什么都不说，框照常等人）。opts.sleep 测试时顶替等待
 */
async function handle(j, opts) {
  const tool = String((j && j.tool_name) || '');
  if (!tool || NOT_OURS.test(tool)) return null;
  const S = require('../lib/session');
  // 任何时候都等（2026-11-18 起）：只读配置，不算流程状态、不调 git（每个确认框都起这个进程）
  let cfg = null;
  try { cfg = S.readConfig(j); } catch (e) { return null; }
  const waitMs = waitOf(cfg);
  if (!(waitMs > 0)) return null;
  const sleep = (opts && opts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  const parent = process.ppid;
  const seen = { found: false };
  while (Date.now() - started < waitMs) {
    await sleep(Math.max(1, Math.min(pollOf(), waitMs - (Date.now() - started))));
    if (settled(j, started, seen)) return null;
    if (!(opts && opts.sleep) && parentGone(parent)) return null;
  }
  return decide(j, waitMs, seen.found);
}

module.exports = { handle, settled, decide, waitOf };
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch (e) { process.exit(0); }
    Promise.resolve().then(() => handle(j)).then((out) => {
      if (out) { const text = JSON.stringify(out); try { fs.writeSync(1, text); } catch (e) { process.stdout.write(text); } }
    }).catch((e) => {
      // 判断不了就什么都不说：框照常等人
      try { require('../lib/feedback').recordHookError(path.basename(__filename, '.js'), j, e); } catch (err) { /* 记不了就算了 */ }
    }).then(() => process.exit(0));
  });
}

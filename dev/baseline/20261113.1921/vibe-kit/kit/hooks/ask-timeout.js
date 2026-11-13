'use strict';
/*
 * PermissionRequest 钩子：自动实施时，提问框、权限确认框发出后没人回，等够时间替用户收掉（问题表第 90 条，仓库主人 2026-11-13 定的）。
 *   提问框（AskUserQuestion）：到点按"不允许"收掉，带一句话让模型自己定、记下来接着做。不替用户选选项：
 *     脚本选了的话，会话记录里就是"用户答了"，推送、归档、开工这些认用户表态的检查会当成用户点了头。
 *   别的工具的权限确认框：到点按"允许"（仓库主人定的）。命令里像推送、发布的除外：按"不允许"收掉，留给用户。
 *     跑查库、redis 工具的命令也按"不允许"（复审 R1）：那两个工具认"用户在不在"看钩子跑命令前留的条子，两分钟内才算数；
 *     框挂了 10 分钟再放行，条子早过期了，工具会当成有人在，要人确认的删就能拿着确认串执行。
 *   ExitPlanMode 不管。
 * 只在这个会话的自动实施在生效（readConfigFor(j).autoMode）时等；别的时候马上退出、什么都不说，框照常等人。
 * 会话的自动开关没开的（readConfig 的 autoApply），不算流程状态就退：每个确认框都起这个进程，不为它调 git（复审 R6）。
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
    for (const q of qs.slice(0, 4)) note({ kind: 'ask', title: clip(q && q.question, 160), detail: ((q && q.options) || []).map((o) => clip(o && o.label, 40)).join(' / ') + '；等了 ' + waited + '没人答，让它自己定了' });
    S.hookLog('ask-timeout 提问框等了 ' + waited + '没人答，收掉让模型自己定：' + clip(qs.map((q) => q && q.question).join('；'), 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 自动实施：这个提问框发出 ' + waited + '没人答，按用户不在处理。这一问你自己定：选你推荐的那一项，拿不准就选改动最小、最容易改回来的；把问的是什么、你怎么定的记进 revisions.md（起因：自动模式决定，用户没回），写进最后的交代，接着做。'
      + '要用户本人点头的事不能自己定（推送、归档、发布、开始下一个 change、还原不了的删）：那一步留给用户，写进最后的交代，接着做别的；没有别的可做就收工。同一个问题不要再问一遍。' });
  }
  const cmd = String((j.tool_input && j.tool_input.command) || '');
  const what = tool + (cmd ? '：' + clip(cmd, 120) : '');
  if (/^(Bash|PowerShell)$/.test(tool) && DATA_TOOL.test(cmd)) {
    note({ kind: 'hand', title: '查库、redis 的命令要你确认、没人点，没让它跑：' + clip(cmd, 120), detail: '框挂久了，工具认不出你在不在' });
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，是查库、redis 的命令，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 自动实施：这条查库、redis 的命令弹了确认框，' + waited + '没人点，不替用户放行。换一个不弹框的写法（不和 cd 串在一起，路径写全）重跑一次；还弹就把这一步留给用户，写进最后的交代，接着做别的。' });
  }
  if (/^(Bash|PowerShell)$/.test(tool) && PUSH_LIKE.test(cmd)) {
    note({ kind: 'hand', title: '要你确认的命令没人点，没让它跑：' + clip(cmd, 120), detail: '推送、发布要你自己来' });
    S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，像推送、发布，按不允许收掉：' + clip(cmd, 80));
    return answer({ behavior: 'deny', message: '[vibe-kit] 自动实施：这个确认框发出 ' + waited + '没人点。命令里有推送或发布，留给用户：不要再试，写进最后的交代，接着做别的。' });
  }
  note({ kind: 'bypass', title: '权限确认框没人点，到点替你点了允许：' + what, detail: '等了 ' + waited });
  S.hookLog('ask-timeout 确认框等了 ' + waited + '没人点，按允许收掉：' + clip(what, 80));
  return answer({ behavior: 'allow' });
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
  // 会话的自动开关没开：不算流程状态（要读任务、调 git），直接不管
  try { if (S.readConfig(j).autoApply !== true) return null; } catch (e) { return null; }
  // 算流程状态要读任务、调 git：照别的钩子给 12 秒，算不出来就不管这个框
  let cfg = null;
  try { cfg = require('../lib/invocation').run(() => S.readConfigFor(j), { budgetMs: 12000 }); } catch (e) { return null; }
  if (!cfg || cfg.autoMode !== true) return null;
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

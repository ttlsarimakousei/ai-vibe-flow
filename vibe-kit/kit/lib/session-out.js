'use strict';
/*
 * 钩子的输出（拦下、问用户、push 检查没跑成）、命令方式的入口 cli、套件代码有没有被改过。
 * 2026-11-01 从 session.js 拆出来（K 批）。session.js 照旧导出全部名字，别的文件照旧 require('./session')。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KIT, readState } = require('./session-state');
const { readConfigFor } = require('./session-flow');

/**
 * 套件自己的代码的指纹：安装器装完记下 hooks、lib、tools、page 下的 .js 和 statusline.js 每个文件的 sha1（state/kit-hash.json，
 * install.js 里有一份同样算法的）；会话开始时再算一遍比。禁改拦的是写入的那一下，路径藏在变量里的拦不住——改了能发现才是兜底
 */
const KIT_CODE_DIRS = ['hooks', 'lib', 'tools', 'page'];

function kitCodeHashes(kitDir) {
  const base = kitDir || KIT;
  const files = {};
  const add = (rel) => { try { files[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(base, rel))).digest('hex'); } catch (e) { /* 读不了 */ } };
  for (const d of KIT_CODE_DIRS) { let es = []; try { es = fs.readdirSync(path.join(base, d), { withFileTypes: true }); } catch (e) { continue; } for (const e of es) if (e.isFile() && /\.js$/i.test(e.name)) add(d + '/' + e.name); }
  if (fs.existsSync(path.join(base, 'statusline.js'))) add('statusline.js');
  return files;
}

/** 和安装时记下的比：返回 [{ rel, how: 改过 / 没了 / 多出来的 }]；安装时没记过（老版本装的）返回 null */
function kitCodeDrift() {
  const rec = readState('kit-hash');
  if (!rec.files) return null;
  const now = kitCodeHashes();
  const out = [];
  for (const [rel, h] of Object.entries(rec.files)) { if (!(rel in now)) out.push({ rel, how: '没了' }); else if (now[rel] !== h) out.push({ rel, how: '改过' }); }
  for (const rel of Object.keys(now)) if (!(rel in rec.files)) out.push({ rel, how: '多出来的' });
  return out;
}

// ===================== 钩子的输出 =====================
// 每个钩子文件都导出 handle(输入) → 返回对象（打印成 JSON）、字符串（原样打印）或 null（什么都不说，放行）。
// 同一个 handle 既能作为命令跑（cli：读标准输入、打印、退出码 0）。
// 拦截一律用 JSON（decision: block），不用退出码 2：Windows 上经 PowerShell 执行钩子时退出码 2 会变成 1，拦不住。
function blockOut(event, reason) {
  const out = { decision: 'block', reason };
  if (event === 'PreToolUse') out.hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
  return out;
}

/** PreToolUse：不拦，但要用户点头（权限规则里放行了也照样问） */
function askOut(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
}

/**
 * 跑命令的检查没跑成（出错、超出预算）时，命令里像推送的怎么回（用户 2026-10-30 定的：push 只留钩子这一道确认，
 * 是"钩子出错一律放行"的例外）：人工模式要用户确认；全自动模式没人点确认框，拦下、留给用户（和 guard-commit 全自动时不 push 一样）。
 * 不像推送的返回 null，照旧放行。字样和登记 guard-push 的 if 条件一致
 */
const PUSH_LIKE = /push|publish|发布到/i;

function pushFailOut(j, why) {
  const cmd = String((j && j.tool_input && j.tool_input.command) || '');
  if (!PUSH_LIKE.test(cmd)) return null;
  const reason = '[vibe-kit] 推送的检查这次没跑成（' + String(why || '').split('\n')[0].slice(0, 120) + '）';
  let auto = false;
  try { auto = !!readConfigFor(j).autoMode; } catch (e) { auto = false; }
  if (auto) return blockOut('PreToolUse', reason + '。全自动模式：推送留给用户，这一步不要做，写进最后的交代，接着做别的。');
  return askOut(reason + '，推到远端要你确认。');
}

/**
 * 作为命令运行：读标准输入 → handle → 打印结果 → 退出码 0。任何异常都放行，但记进问题反馈（放行了用户看不到，只有那里有）。
 * opts.onError(j, e)：出错、超出预算时要回的话（跑命令的检查用它：像推送的不放行，见 pushFailOut）
 */
function cli(handle, opts) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch (e) { process.exit(0); }
    const print = (out) => {
      if (out == null || out === '') return;
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      try { fs.writeSync(1, text); } catch (e) { process.stdout.write(text); }
    };
    Promise.resolve().then(() => require('./invocation').run(() => handle(j), { budgetMs: 12000 })).then(print).catch((e) => {
      // 判断不了就放行
      try { require('./feedback').recordHookError(path.basename(process.argv[1] || 'hook', '.js'), j, e); } catch (err) { /* 记不了就算了 */ }
      try { if (opts && typeof opts.onError === 'function') print(opts.onError(j, e)); } catch (err) { /* 替代输出也出错：放行 */ }
    }).then(() => process.exit(0));
  });
}

module.exports = { kitCodeHashes, kitCodeDrift, blockOut, askOut, pushFailOut, cli };

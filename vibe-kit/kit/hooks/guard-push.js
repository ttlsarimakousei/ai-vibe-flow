'use strict';
/*
 * PreToolUse 钩子（Bash、PowerShell），一直是命令方式。只在钩子走路由（HTTP）时登记，带 if 条件（"Bash(*push*)" 这类）：
 * 命令里没有 push、发布字样的，Claude Code 根本不起这个进程（2.1.120 起认 if；实测 $(…)、反引号、bash -c 里的 push 都触发，
 * 见 docs/claude-code-facts.md）。平时的命令不多花这 0.3—0.9 秒。
 *
 * 为什么要它（用户 2026-10-30 定的，docs/feedback-20261030.md 的 B 批）：push 只留钩子这一道确认，去掉了 Claude Code 自带的确认框。
 * 钩子走路由时，路由没在跑、调不通，Claude Code 当放行，push 就直接出去了。所以：
 *   路由在跑（/version 有回话）：什么都不做，路由里的 guard-commit 照常查；它出错、超时时也按"要确认"回（lib/hook-host.js）
 *   路由不在：在这里跑一遍 guard-commit 的检查（和命令方式一样）
 *   这里自己出错、超时：问用户。push 是硬规矩 2"钩子出错一律放行"的例外：放行了就推出去了，收不回来
 * 用法（安装器登记）：node guard-push.js <路由端口>
 */
const http = require('http');

const ASK_MS = 25000;
const ask = (why) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '[vibe-kit] 推送的检查这次没跑成（' + why + '），推到远端要你确认。' } });

/** 路由能答话：请求 /version 拿到 200。只连得上端口不算（路由卡住时端口照样连得上，钩子却等不到结果） */
function routerUp(port, ms) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: ms }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
async function handle(j, port) {
  if (await routerUp(Number(port) || 0, 800)) return null;
  // 路由不在：照命令方式跑一遍完整的检查（push 之外的检查顺带也做了，和命令方式一样）
  const out = require('./guard-commit').handle(j);
  return out == null ? null : out;
}

module.exports = { handle, routerUp };

if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = (out) => {
    if (done) return;
    done = true;
    if (out != null) { const text = typeof out === 'string' ? out : JSON.stringify(out); try { require('fs').writeSync(1, text); } catch (e) { process.stdout.write(text); } }
    process.exit(0);
  };
  const fail = (j, e) => {
    try { require('../lib/feedback').recordHookError('guard-push', j, e); } catch (x) { /* 记不了也照样问 */ }
    finish(ask(String((e && e.message) || e).split('\n')[0].slice(0, 120)));
  };
  // 不走 session.js 的 cli()：那里出错、超出预算一律放行，这里出错要问
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw || '{}'); } catch (e) { return finish(ask('钩子收到的输入读不懂')); }
    setTimeout(() => fail(j, new Error(Math.round(ASK_MS / 1000) + ' 秒没查完')), ASK_MS).unref();
    Promise.resolve().then(() => handle(j, process.argv[2])).then(finish, (e) => fail(j, e));
  });
}

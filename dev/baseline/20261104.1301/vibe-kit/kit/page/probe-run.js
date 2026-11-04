'use strict';
/* 场景格式不能表达的页面验证。探针导出 async ({ page, context, assert })，断言失败抛错，返回实际读到的值。
 * 执行器统一启动系统浏览器、限制耗时、关闭浏览器并输出结果，收工检查只认成功完成的结果。
 * node probe-run.js .vibe/tmp/<事由>/probe.js [--max 秒]；从被测项目目录运行。
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { fork, spawnSync } = require('child_process');
const redact = require('../lib/redact');
async function main() {
  let browser; let result;
  try {
    const file = fs.realpathSync(path.resolve(process.argv[2] || ''));
    const base = fs.realpathSync(path.resolve('.vibe/tmp')) + path.sep;
    const project = fs.realpathSync(process.cwd()) + path.sep;
    const relative = path.relative(base, file);
    if (!base.toLowerCase().startsWith(project.toLowerCase()) || !file.toLowerCase().startsWith(base.toLowerCase()) || !relative.includes(path.sep) || !/\.(?:js|cjs)$/i.test(file)) throw new Error('探针必须放在当前项目 .vibe/tmp/<事由>/ 下，目录链接不能指向项目外');
    const probe = require(file);
    if (typeof probe !== 'function') throw new Error('探针须用 module.exports = async ({ page, context, assert }) => { …; return { 实际值 }; }');
    const { launchBrowser, newPage } = require('./browser');
    ({ browser } = await launchBrowser());
    const { ctx: context, page } = await newPage(browser);
    const values = await probe({ page, context, assert });
    if (!values || typeof values !== 'object' || !Object.keys(values).length) throw new Error('探针须返回实际读到的值，不能只返回成功字样');
    result = { ok: true, values: redact.tree(values) };
  } catch (e) {
    result = { ok: false, reason: redact.clip(String(e.message || e), 600) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return result;
}
// 父进程计时，覆盖脚本加载、同步死循环和浏览器起停；只在浏览器关闭后输出成功。
function supervise() {
  const i = process.argv.indexOf('--max');
  const seconds = Math.min(300, Math.max(1, (i >= 0 ? Number(process.argv[i + 1]) : 120) || 120));
  const child = fork(__filename, process.argv.slice(2).concat('--probe-worker'), { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let done = false; let result;
  const finish = (value) => {
    if (done) return;
    done = true; clearTimeout(timer);
    console.log('PAGE_PROBE ' + JSON.stringify(value));
    process.exitCode = value.ok ? 0 : 1;
  };
  const timer = setTimeout(() => {
    // Windows 结束这一棵进程树，不能只杀 Node 留下浏览器。
    if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else {
      const rows = String(spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }).stdout || '').trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
      const kill = (pid) => { for (const [p, parent] of rows) if (parent === pid) kill(p); try { process.kill(pid, 'SIGKILL'); } catch (e) { /* 已退出 */ } };
      kill(child.pid);
    }
    try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    finish({ ok: false, reason: '页面探针超时' });
  }, seconds * 1000);
  child.on('message', value => { result = value; });
  child.on('error', e => finish({ ok: false, reason: redact.clip(e.message, 600) }));
  child.on('exit', code => finish(result && result.ok === (code === 0) ? result : { ok: false, reason: '页面探针未正常完成' }));
}
if (process.argv.includes('--probe-worker') && process.send) main().then(result => {
  process.send(result, () => process.exit(result.ok ? 0 : 1));
});
else supervise();

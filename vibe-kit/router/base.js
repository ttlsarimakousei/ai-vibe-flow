'use strict';
/*
 * 路由的公共部分：命令行参数、数据文件的位置、版本、日志、诊断脱敏、原子写、读请求体、回 JSON。
 * 2026-11-01 从 router.js 拆出来（K1-1），代码原样搬过来，说法、行为没变。只用 Node 自带模块。
 */
const fs = require('fs');
const path = require('path');
const diagnostic = require(fs.existsSync(path.join(__dirname, '..', 'lib', 'redact.js')) ? '../lib/redact' : '../kit/lib/redact');
let diagnosticSecrets = [];
const scrub = (s) => diagnostic.text(s, diagnosticSecrets);
const refreshSecrets = (c) => { diagnosticSecrets = [...new Set(diagnosticSecrets.concat((c.providers || []).map((p) => p.api_key).filter(Boolean)))].slice(-300); };

const VERSION = '3.0';
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const CONFIG_PATH = argOf('-c') ? path.resolve(argOf('-c')) : path.join(__dirname, 'config.json');
const DATA_DIR = path.dirname(CONFIG_PATH);
const LAST_GOOD = path.join(DATA_DIR, 'config.last-good.json');
const BACKUP_DIR = path.join(DATA_DIR, 'config-backups');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
const DAILY_PATH = path.join(DATA_DIR, 'usage-daily.json');
const TODAY_PATH = path.join(DATA_DIR, 'usage-today.json');
const LOG_PATH = path.join(DATA_DIR, 'router.log');
const UI_PATH = path.join(__dirname, 'ui.html');
const overridePort = argOf('-p') ? parseInt(argOf('-p'), 10) : null;
// 套件目录按这个文件自己所在的位置定（~/.claude/vibe-kit/router/router.js → ~/.claude/vibe-kit），不看环境变量：
// 路由可能是登录时由"启动"文件夹拉起来的，那时候没有任何自定义的环境变量。VIBE_KIT_DIR 只给测试用。
const KIT_DIR = process.env.VIBE_KIT_DIR || path.dirname(__dirname);
// 这一份安装的标识，/version 带着（E1，2026-11-01）：service.js 靠它认出端口上的是不是这份安装的路由。
// 按程序所在的套件目录算（和 service.js 一样），不看 VIBE_KIT_DIR
const INSTALL_ID = require('./install-id').installId(path.dirname(__dirname));

// ---------- 日志 ----------
// 由 service.js 在后台拉起时，标准输出接的是数据目录里的 router.out.log（一个文件）：每行都写进去等于把 router.log 再存一份，
// 而且一次运行期间没有上限。所以标准输出是文件时不往控制台写（router.log 里都有，满 5 MB 轮换）；
// 在终端里跑、或者被别的程序用管道读的时候照常输出。
const LOG_TO_CONSOLE = (() => { try { return !fs.fstatSync(1).isFile(); } catch (e) { return true; } })();
function log(msg) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + scrub(msg);
  if (LOG_TO_CONSOLE) console.log(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) { /* 日志写不了不影响转发 */ }
}
process.on('uncaughtException', (e) => log('未捕获的异常（已忽略，路由继续运行）：' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('未处理的拒绝（已忽略）：' + (e && e.stack || e)));

/** 先写临时文件再改名：写到一半断电、被结束，留下的也是上一份完整的文件，不会是半截 */
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => { const parts = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('请求太大')); req.destroy(); } else parts.push(c); }); req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(diagnostic.tree(obj, diagnosticSecrets))); };

module.exports = { diagnostic, secrets: () => diagnosticSecrets, scrub, refreshSecrets, VERSION, argOf, CONFIG_PATH, DATA_DIR, LAST_GOOD, BACKUP_DIR, USAGE_PATH, DAILY_PATH, TODAY_PATH, LOG_PATH, UI_PATH, overridePort, KIT_DIR, INSTALL_ID, log, writeAtomic, readBody, json };

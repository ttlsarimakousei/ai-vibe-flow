'use strict';
/*
 * 钩子走 HTTP 时的自检，和几个"现在登记的是哪种方式"的小工具（安装器、配置页、会话开始的钩子、路由都用）。
 *
 * HTTP 钩子有个特点：路由没在跑、或者路由那边出了问题，Claude Code 调不通就当放行，不报错——编码保护、提交检查、收工检查
 * 就这样悄悄失效了。所以用户每次开口时（task-anchor，命令方式，一定会跑）查一下：
 *   上一轮改过文件或跑过命令，路由却没记到这个会话的钩子调用 →
 *     钩子登记的端口和路由的端口对不上：重新登记
 *     路由没在跑：在后台拉起来，等端口真的通了才算；拉不起来就切回命令方式
 *     路由在跑也收不到：第一轮重新登记，连着两轮收不到再切回命令方式（config.json 的 hookTransport 改成 command，重新登记钩子；
 *     config.json 读不懂就不写，免得把用户的开关写没了）
 *   并告诉模型：上一轮的改动没经过检查，自己核对一遍。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const CFG_DIR = path.dirname(KIT);
const HOOK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?\/vibe-kit\/hook\/([\w-]+)/i;
// 这几种工具调用一定会经过 HTTP 钩子（改文件 → pre-edit，跑命令 → guard-commit）
const CHECKED_TOOLS = /^(Edit|Write|MultiEdit|Bash|PowerShell)$/;

function readSettings(claudeDir) {
  try { let t = fs.readFileSync(path.join(claudeDir || CFG_DIR, 'settings.json'), 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); const s = JSON.parse(t); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
}
/** settings.json 里套件登记的钩子：{ ev, kind: http | command, url } */
function ourHooks(s) {
  const out = [];
  const hooks = s && s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  for (const ev of Object.keys(hooks)) {
    for (const g of Array.isArray(hooks[ev]) ? hooks[ev] : []) {
      for (const h of g && Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h !== 'object') continue;
        if (h.type === 'http' && HOOK_URL.test(String(h.url || ''))) out.push({ ev, kind: 'http', url: String(h.url) });
        // guard-push 是 HTTP 方式下另加的 push 兜底（一直是命令方式），不算"混着两种"
        else if (String(h.command || '').includes('vibe-kit/hooks/')) out.push({ ev, kind: 'command', url: '', pushGuard: /guard-push\.js/.test(String(h.command)) });
      }
    }
  }
  return out;
}
const isOurHttpHook = (h) => !!h && typeof h === 'object' && h.type === 'http' && HOOK_URL.test(String(h.url || ''));
/** 登记的方式：http（高频的几个走 HTTP）、command、mixed（两种都有）、none（没登记） */
function registeredTransport(claudeDir) {
  const hs = ourHooks(readSettings(claudeDir));
  const http = hs.some((h) => h.kind === 'http');
  // 会话开始、用户开口两个钩子一直是命令方式，不算"混着"
  const cmd = hs.some((h) => h.kind === 'command' && !h.pushGuard && /^(PreToolUse|PostToolUse|Stop)$/.test(h.ev));
  return http && cmd ? 'mixed' : http ? 'http' : hs.length ? 'command' : 'none';
}
/** HTTP 钩子打的端口 */
function registeredHookPorts(claudeDir) {
  const ports = new Set();
  for (const h of ourHooks(readSettings(claudeDir))) {
    if (h.kind !== 'http') continue;
    const m = h.url.match(HOOK_URL);
    ports.add(Number(m && m[2]) || 80);
  }
  return [...ports];
}
const httpRegistered = (claudeDir) => ourHooks(readSettings(claudeDir)).some((h) => h.kind === 'http');

function readStats() { try { return JSON.parse(fs.readFileSync(path.join(KIT, 'state', 'hook-stats.json'), 'utf8')) || {}; } catch (e) { return {}; } }
function resync() {
  const r = spawnSync(process.execPath, [path.join(KIT, 'install.js'), '--sync'], { env: Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: CFG_DIR }), encoding: 'utf8', timeout: 30000, windowsHide: true });
  return r.status === 0;
}
function portOpen(port, ms) {
  return new Promise((resolve) => {
    const s = require('net').connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.setTimeout(ms, () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}
const AFTERMATH = '上一轮的改动没经过套件的检查：自己核对一遍——改过的文件中文有没有写坏（GBK 的老文件尤其要看），有没有用 git add -A、git add .、git commit -a，改了代码有没有跑过验证。';
const HAND_SWITCH = '请用户把 ~/.claude/vibe-kit/config.json 里的 hookTransport 改成 "command"，再运行 node ~/.claude/vibe-kit/install.js --sync';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 切回命令方式。config.json 读得懂才改：以前读不懂就拿空对象写回去，用户的开关（两个自动模式、提交方式……）全没了（审核 P11）。
 * 和配置页保存用同一把锁（config.json.lock），免得两边同时写、互相盖掉
 */
function switchToCommand() {
  const cfgFile = path.join(KIT, 'config.json');
  const store = require('./state-store');
  const lock = store.acquire(cfgFile + '.lock', { waitMs: 2000 });
  if (!lock) return { ok: false, why: 'config.json 正被别的程序写' };
  try {
    let cur = {};
    if (fs.existsSync(cfgFile)) {
      let t = fs.readFileSync(cfgFile, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      try { cur = JSON.parse(t); } catch (e) { cur = null; }
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return { ok: false, why: 'config.json 读不懂，没敢改' };
    }
    cur.hookTransport = 'command';
    if (!store.atomicText(cfgFile, JSON.stringify(cur, null, 2) + '\n')) return { ok: false, why: '写不进 config.json' };
  } catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
  finally { lock.release(); }
  return resync() ? { ok: true, why: '' } : { ok: false, why: '重新登记钩子没成功' };
}
/** 这个会话连着几轮没收到钩子调用（收到了就清零）。只记次数，清了也就是从头数 */
function misses(S, sid, bump) {
  let n = 0;
  try { S.updateState('hook-miss', (o) => { if (bump) o[sid] = { n: ((o[sid] && o[sid].n) || 0) + 1, at: Date.now() }; else delete o[sid]; n = bump ? o[sid].n : 0; }); } catch (e) { n = bump ? 1 : 0; }
  return n;
}

/**
 * 用户开口时的自检。j 是 UserPromptSubmit 的输入。返回要带给模型的话，没事返回空串。
 * 只在登记了 HTTP 钩子时才查；上一轮没有改文件、跑命令，或者上一轮当中钩子登记刚改过（装新版、切换方式），都不下结论
 */
async function check(j) {
  const s = readSettings();
  if (!ourHooks(s).some((h) => h.kind === 'http')) return '';
  if (!j || !j.transcript_path || !j.session_id) return '';
  const S = require('./session');
  const { tailEntries, isUserTurn, textOf, toolCalls, toolResults, hookLog } = S;
  const entries = tailEntries(j.transcript_path, 300000);
  // 上一轮：最后一条用户消息（不是现在这一条）之后的工具调用
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!isUserTurn(entries[i])) continue;
    if (start < 0 && textOf(entries[i]).trim() === String(j.prompt || '').trim() && i === entries.length - 1) continue;
    start = i + 1;
    break;
  }
  if (start < 0) return '';
  const results = toolResults(entries.slice(start));
  const calls = toolCalls(entries, start).filter((c) => CHECKED_TOOLS.test(c.name) && results.has(c.id));
  if (!calls.length) return '';
  const firstAt = Date.parse(entries[calls[0].i].timestamp || '') || 0;
  if (!firstAt) return '';
  // 上一轮是好几天以前的（隔了几天用 --continue 接着说）：路由那边的记录只留 3 天，早就清掉了，查不到不说明钩子没生效
  if (Date.now() - firstAt > 2 * 86400000) return '';
  // 上一轮当中钩子登记改过（装了新版、在配置页切了方式）：那一轮的记录说明不了问题
  let settingsAt = 0;
  try { settingsAt = fs.statSync(path.join(CFG_DIR, 'settings.json')).mtimeMs; } catch (e) { /* 没有 */ }
  if (settingsAt > firstAt - 2000) return '';
  const stats = readStats();
  const seen = Number((stats.sessions || {})[j.session_id]) || 0;
  if (seen >= firstAt - 5000) { if ((S.readState('hook-miss')[j.session_id] || {}).n) misses(S, j.session_id, false); return ''; }

  // 上一轮的检查没生效。看是哪种情况
  const svcFile = path.join(KIT, 'router', 'service.js');
  let svc = null;
  try { if (fs.existsSync(svcFile)) svc = require(svcFile); } catch (e) { svc = null; }
  const port = svc && typeof svc.portOf === 'function' ? svc.portOf() : 15730;
  const ports = registeredHookPorts();
  if (ports.length && ports.some((p) => p !== port)) {
    const ok = resync();
    hookLog('hook-health port mismatch registered=' + ports.join(',') + ' router=' + port + ' resync=' + ok);
    return '[vibe-kit 自检] 钩子登记的端口（' + ports.join('、') + '）和模型路由的端口（' + port + '）对不上，上一轮改文件、跑命令的检查都没生效；' + (ok ? '已经重新登记。' : '重新登记没成功，请用户在配置页"套件开关"里把钩子运行方式改成"命令"。') + AFTERMATH;
  }
  if (!(await portOpen(port, 400))) {
    // ensureRunning 不抛错：起不来时返回 absent / error。以前只要它没抛错就当拉起来了，新版路由一启动就崩时 HTTP 钩子一直放行（审核 P36）
    let how = 'error';
    try { if (svc && typeof svc.ensureRunning === 'function') how = await svc.ensureRunning(); } catch (e) { how = 'error'; }
    let up = false;
    if (how === 'started' || how === 'running') for (let i = 0; i < 10 && !up; i++) { up = await portOpen(port, 300); if (!up) await sleep(300); }
    hookLog('hook-health router down port=' + port + ' ensure=' + how + ' up=' + up);
    if (up) return '[vibe-kit 自检] 模型路由刚才没在跑，上一轮改文件、跑命令的检查（它们在路由里跑）都没生效；已经在后台把路由拉起来了。' + AFTERMATH;
    const sw = switchToCommand();
    hookLog('hook-health router not up, switch to command ok=' + sw.ok + (sw.why ? ' ' + sw.why : ''));
    return '[vibe-kit 自检] 模型路由没在跑、也拉不起来，上一轮改文件、跑命令的检查（它们在路由里跑）都没生效；' + (sw.ok ? '已经把钩子切回命令方式（每次检查慢零点几秒，但不依赖路由）。路由好了以后，用户可以在配置页"套件开关"里改回来。' : '切回命令方式也没成功（' + sw.why + '），' + HAND_SWITCH + '。') + AFTERMATH;
  }
  // 路由在跑，钩子却没到：第一轮先重新登记（装新版、改端口之后常见），连着两轮都没到再切回命令方式，不依赖路由
  const n = misses(S, j.session_id, true);
  if (n < 2) {
    const ok = resync();
    hookLog('hook-health no calls while router up port=' + port + ' resync=' + ok + ' miss=' + n);
    return '[vibe-kit 自检] 模型路由在跑，但上一轮改文件、跑命令时它没收到钩子调用，检查没生效；' + (ok ? '已经重新登记钩子，下一轮还收不到就切回命令方式。' : '重新登记没成功，下一轮还收不到就切回命令方式。') + AFTERMATH;
  }
  const sw = switchToCommand();
  hookLog('hook-health no calls while router up port=' + port + ' miss=' + n + ' switched=' + sw.ok + (sw.why ? ' ' + sw.why : ''));
  return '[vibe-kit 自检] 模型路由在跑，但连着两轮都没收到钩子调用，检查没生效；' + (sw.ok ? '已经把钩子切回命令方式（每次检查慢零点几秒，但不依赖路由）。用户可以在配置页"套件开关"里看到、改回来。' : '切回命令方式没成功（' + sw.why + '），请用户在配置页"套件开关"里把钩子运行方式改成"命令"。') + AFTERMATH;
}

module.exports = { check, switchToCommand, ourHooks, isOurHttpHook, registeredTransport, registeredHookPorts, httpRegistered, HOOK_URL };

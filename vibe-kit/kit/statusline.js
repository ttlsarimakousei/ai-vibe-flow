'use strict';
/*
 * Claude Code 状态栏，最多三行（输出一行、状态栏就显示一行；2.1.120、2.1.259 都认多行）：
 *   第一行  警告 │ 模型 │ 目录(分支) │ 上下文进度条 │ 进行中的 OpenSpec 变更
 *   第二行  全自动开没开、这个会话在不在流程里 │ 用到多少自动压缩 │ 放松了的保护 │ 经验待确认 │ 更新
 *   第三行  今天的请求次数和 token、各个模型的（开关 statusUsage；读路由记的用量，一个小文件）
 * 终端窄的时候被截掉的是每一行的末尾，所以要紧的放前面，警告放在第一行最前面。
 * 用了多少 token 优先用 Claude Code 自己给的数；旧版本不给，就读会话记录里最后一次回复的用量。
 * 百分比的分母是配置里的"上下文上限"（默认 100 万，填 0 表示跟着 Claude Code 报的窗口走），交接线默认 70%。
 * 这两个数在路由配置页的"套件开关"里改。每次刷新都现读配置，改完不用重开会话，下一次刷新就按新值显示。
 * 公司规定用到交接线必须交接并开新会话：到线就变红，并把提醒放在最前面。用量超过上限（Claude Code 没自动压缩）另说一句怎么办。
 * 另有一道按实测来的保险：路由真的被网关拒过"请求太大"（413）之后，快到那个大小时也提前警告——那是硬墙，撞上了这个会话就发不出去了。
 * 用了多少、Claude Code 报的窗口多大、这个会话最高用到多少，顺手记下来，给提醒钩子、配置页和使用情况统计用。
 */
const fs = require('fs');
const path = require('path');
const { activeChanges, tailEntries, lastUsageTokens, readConfig, contextPercent, autoCompactAt, nearGatewayLimit, readState, writeState, flowState, flowDone } = require('./lib/session');

const C = { dim: '\x1b[2m', reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const SEP = C.dim + ' │ ' + C.reset;

function gitBranch(dir) {
  try {
    let d = path.resolve(dir);
    for (let i = 0; i < 8; i++) {
      const head = path.join(d, '.git', 'HEAD');
      if (fs.existsSync(head)) {
        const t = fs.readFileSync(head, 'utf8').trim();
        const m = t.match(/^ref: refs\/heads\/(.+)$/);
        return m ? m[1] : t.slice(0, 7);
      }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  } catch (e) { /* 不是 git 仓库 */ }
  return '';
}
/** 84k、230k、1M、1.5M */
const k = (n) => (n >= 1000000 ? String(Math.round(n / 100000) / 10) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n)));
const today = () => { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const readJson = (f) => { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } };

/**
 * 今天的用量：路由每 20 秒写一次 router-data/usage-today.json（今天、提醒线、各个模型的次数和 token）；
 * 老版本的路由没有这个文件，就从 usage-daily.json 里取今天那一天，提醒线按公司的 4000 次算。没装路由、今天还没请求过返回 null
 */
function todayUsage() {
  const dir = path.join(__dirname, 'router-data');
  const t = today();
  const small = readJson(path.join(dir, 'usage-today.json'));
  if (small && small.day === t && small.byProvider) return { requests: Number(small.requests) || 0, warnAt: Number(small.warnAt) || 4000, byProvider: small.byProvider };
  if (small && small.day && small.day !== t) return { requests: 0, warnAt: Number(small.warnAt) || 4000, byProvider: {} };
  const daily = readJson(path.join(dir, 'usage-daily.json'));
  if (!daily || typeof daily !== 'object') return null;
  const d = daily[t];
  return d ? { requests: Number(d.requests) || 0, warnAt: 4000, byProvider: d.byProvider || {} } : { requests: 0, warnAt: 4000, byProvider: {} };
}
function usageLine(cfg) {
  if (cfg.statusUsage === false) return '';
  const u = todayUsage();
  if (!u) return '';
  const tok = (x) => (Number(x.input) || 0) + (Number(x.cacheRead) || 0) + (Number(x.cacheWrite) || 0) + (Number(x.output) || 0);
  const list = Object.entries(u.byProvider || {}).map(([name, x]) => ({ name, n: Number(x.requests) || 0, t: tok(x || {}), fail: Number(x.fail) || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const total = list.reduce((a, x) => a + x.t, 0);
  const color = u.warnAt && u.requests >= u.warnAt ? C.red : u.warnAt && u.requests >= u.warnAt * 0.75 ? C.yellow : '';
  const parts = [(color || '') + '今天 ' + u.requests + ' 次' + (color ? C.reset : '') + C.dim + '（提醒线 ' + u.warnAt + '）' + C.reset + ' · ' + k(total) + ' token'];
  for (const x of list.slice(0, 3)) parts.push(x.name + ' ' + x.n + ' 次 ' + k(x.t) + (x.fail ? C.dim + '（失败 ' + x.fail + '）' + C.reset : ''));
  if (list.length > 3) parts.push(C.dim + '还有 ' + (list.length - 3) + ' 个模型' + C.reset);
  return parts.join(SEP);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch (e) { /* 空输入也要出一行 */ }
  const line1 = [];
  const line2 = [];
  const model = (j.model && (j.model.display_name || j.model.id)) || '';
  if (model) line1.push(C.cyan + model + C.reset);

  const cwd = (j.workspace && j.workspace.current_dir) || j.cwd || process.cwd();
  const br = gitBranch(cwd);
  line1.push(path.basename(cwd) + (br ? C.dim + ' (' + br + ')' + C.reset : ''));

  // 上下文
  const cw = j.context_window || {};
  const cfg = readConfig();
  const windowSize = Number(cw.context_window_size) || 0;
  let used = 0;
  if (typeof cw.used_percentage === 'number') {
    const cu = cw.current_usage || {};
    used = (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0) + (cu.cache_creation_input_tokens || 0) || Math.round((windowSize || 200000) * cw.used_percentage / 100);
  } else if (j.transcript_path) used = lastUsageTokens(tailEntries(j.transcript_path, 300000));
  const { size, pct: rawPct } = contextPercent(used, windowSize, cfg);
  const pct = (used || typeof cw.used_percentage === 'number') ? rawPct : null;
  const line = Number(cfg.handoverPercent) || 70;
  if (pct === null) line1.push(C.dim + '上下文 --' + C.reset);
  else {
    // 进度条满格为止；百分比照实写，超过 100% 就是超过上限了（下面另有一句怎么办）
    const shown = Math.max(0, Math.round(pct));
    const p = Math.min(100, shown);
    const color = shown >= line ? C.red : (shown >= line - 15 ? C.yellow : C.green);
    const filled = Math.round(p / 10);
    line1.push('上下文 ' + color + '█'.repeat(filled) + C.dim + '░'.repeat(10 - filled) + C.reset + ' ' + color + shown + '%' + C.reset + C.dim + ' ' + k(used) + '/' + k(size) + C.reset);
  }

  // 变更进度按目录缓存 5 秒：状态栏刷新得很勤，大壳子里每次都扫一遍所有 tasks.md 太慢
  let ch = null;
  const cache = readState('changes-cache');
  const ck = String(cwd).toLowerCase();
  if (cache[ck] && Date.now() - cache[ck].at < 5000) ch = cache[ck].list;
  if (!ch) {
    ch = activeChanges(cwd).map((c) => ({ name: c.name, done: c.done, total: c.total }));
    cache[ck] = { at: Date.now(), list: ch };
    for (const key of Object.keys(cache)) if (Date.now() - cache[key].at > 3600000) delete cache[key];
    writeState('changes-cache', cache);
  }
  if (ch.length) line1.push('opsx ' + ch[0].name + ' ' + ch[0].done + '/' + ch[0].total + (ch.length > 1 ? C.dim + ' +' + (ch.length - 1) + C.reset : ''));

  // 警告放第一行最前面：终端窄的时候被截掉的是末尾，最要紧的不能丢
  const gw = used ? nearGatewayLimit(used) : null;
  if (gw) line1.unshift(C.red + '⚠ 快到网关能接受的请求大小了（上次约 ' + k(gw.limitTokens) + ' 时被拒），现在 /compact；压缩失败再手动交接' + C.reset);
  else if (pct !== null && pct >= 100) line1.unshift(C.red + '⚠ 上下文超过上限了（' + k(used) + '/' + k(size) + '），Claude Code 没自动压缩：敲 /compact 压缩，或者 /ttls-handover 交接' + C.reset);
  else if (cfg.contextStrategy === 'handover' && pct !== null && pct >= line) line1.unshift(C.red + '⚠ 上下文 ' + Math.round(pct) + '%，到手动交接线：/ttls-handover' + C.reset);
  // 放松保护的开关被绕开配置页改了（没生效）
  if (cfg._tampered) line1.unshift(C.red + '⚠ 套件开关文件被直接改过，没生效，去配置页核对' + C.reset);
  // 会话开始时比对过套件代码的指纹，对不上（被改过）：一直挂着，直到重新安装
  const drift = readState('kit-drift');
  if (Array.isArray(drift.list) && drift.list.length) line1.unshift(C.red + '⚠ 套件代码被改过（' + drift.list.length + ' 个文件），重新安装能恢复' + C.reset);

  // 两个开关与当前生效阶段分开显示。
  const fl = require('./lib/session').flowView({ session_id: j.session_id, cwd });
  line2.push(C.dim + '需求自动 ' + (cfg.autoRequirements ? '开' : '关') + ' · Apply 自动 ' + (cfg.autoApply ? '开' : '关') + C.reset);
  if (fl.effective) line2.push(C.yellow + fl.phase + '，当前生效' + C.reset);
  // 这个会话做的变更都归档了：明说照常，不再像在做任务（用户 2026-10-07 反馈）
  else if (fl.archived) line2.push(C.dim + fl.phase + '，照常，变更已归档' + C.reset);
  else if (fl.waiting) line2.push(C.yellow + fl.waiting + C.reset);
  // Claude Code 会在用到多少时自己压缩（套件写进 settings.json 的 autoCompactWindow；新开的会话才认）
  const at = autoCompactAt(cfg, windowSize);
  if (at) line2.push(C.dim + '到 ' + k(at) + ' 自动压缩' + C.reset);
  // 放松了的保护：一直挂着提醒
  if (cfg.kitLock === false) line2.push(C.yellow + '允许改套件' + C.reset);
  if (cfg.kitBypass === 'auto') line2.push(C.yellow + '被拦可自行放行' + C.reset);
  // 有经验在几个项目里都成了规则、等你确认要不要升成用户级（去配置页"经验规则"里点）
  try { if (cfg.lessons !== 'off') { const n = require('./lib/lessons').pendingUser().length; if (n) line2.push(C.yellow + '经验待确认 ' + n + ' 条' + C.reset); } } catch (e) { /* 老版本没有，或者读不了 */ }
  // 自动更新：刚更新过（一小时内）说一声；开关是"只提醒"的挂着"有新版"；新版装不上的也挂着。只读一个状态文件，不连网
  try {
    const mode = ['auto', 'notify', 'off'].includes(cfg.autoUpdate) ? cfg.autoUpdate : 'auto';
    if (mode !== 'off') {
      const up = readState('update');
      let cur = '';
      try { cur = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch (e) { /* 没有版本号 */ }
      const failed = up.failed && up.failed.version === up.remoteVersion && up.failed.version !== cur ? up.failed : null;
      if (failed) line2.push(C.yellow + '新版 ' + failed.version + ' 没装上，看配置页' + C.reset);
      // 安装器什么都没动就停了（settings.json 读不懂、全局约定不是 UTF-8、Node 太老）：要用户改电脑上的问题，不然一直装不上（复审 S5）
      else if (up.refused && up.refused.version === up.remoteVersion && up.refused.version !== cur) line2.push(C.yellow + '新版 ' + up.refused.version + ' 装不上：电脑上有问题要改，看配置页' + C.reset);
      else if (up.remoteVersion && cur && up.remoteVersion !== cur) { if (mode === 'notify') line2.push(C.yellow + '有新版 ' + up.remoteVersion + '，去配置页更新' + C.reset); }
      else if (up.lastApplied && up.lastApplied.to === cur && Date.now() - (up.lastApplied.at || 0) < 3600000) line2.push(C.green + '已更新到 ' + cur + C.reset);
    }
  } catch (e) { /* 读不了就不显示 */ }

  let line3 = '';
  try { line3 = usageLine(cfg); } catch (e) { line3 = ''; }

  if (pct !== null && j.session_id) {
    const prev = readState(j.session_id);
    const before = Number(prev.peak) || 0;
    const peak = Math.max(Math.round(pct), before);
    writeState(j.session_id, { pct: Math.round(pct), peak, used, size, windowSize, cwd: path.basename(cwd), at: Date.now() });
    // 使用情况：这个会话头一回到 70%、90%、超过上限，各数一次
    if (peak > before) { try { const U = require('./lib/usage'); for (const t of [70, 90, 100]) if (before < t && peak >= t) U.bump('ctx.' + t); } catch (e) { /* 老版本没有 */ } }
  }
  // 这台电脑上用的是哪个版本的 Claude Code（使用情况统计用；版本没变就不写）
  try { if (j.version) require('./lib/usage').seen('cc', String(j.version)); } catch (e) { /* 老版本没有 */ }
  process.stdout.write([line1.join(SEP), line2.join(SEP), line3].filter(Boolean).join('\n') + '\n');
});

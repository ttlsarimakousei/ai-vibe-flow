'use strict';
/*
 * Claude Code 状态栏：模型 │ 目录(分支) │ 上下文进度条 │ 进行中的 OpenSpec 变更
 * 用了多少 token 优先用 Claude Code 自己给的数；旧版本不给，就读会话记录里最后一次回复的用量。
 * 百分比的分母是配置里的"上下文上限"（默认 100 万，填 0 表示跟着 Claude Code 报的窗口走），交接线默认 70%。
 * 这两个数在路由配置页的"套件开关"里改。每次刷新都现读配置，改完不用重开会话，下一次刷新就按新值显示。
 * 公司规定用到交接线必须交接并开新会话：到线就变红，并把提醒放在最前面。
 * 另有一道按实测来的保险：路由真的被网关拒过"请求太大"（413）之后，快到那个大小时也提前警告——那是硬墙，撞上了这个会话就发不出去了。
 * 用了多少、Claude Code 报的窗口多大，顺手记下来，给提醒钩子和配置页用。
 */
const fs = require('fs');
const path = require('path');
const { activeChanges, tailEntries, lastUsageTokens, readConfig, contextPercent, nearGatewayLimit, readState, writeState } = require('./lib/session');

const C = { dim: '\x1b[2m', reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

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
const k = (n) => (n >= 1000000 ? String(Math.round(n / 100000) / 10) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch (e) { /* 空输入也要出一行 */ }
  const parts = [];
  const model = (j.model && (j.model.display_name || j.model.id)) || '';
  if (model) parts.push(C.cyan + model + C.reset);

  const cwd = (j.workspace && j.workspace.current_dir) || j.cwd || process.cwd();
  const br = gitBranch(cwd);
  parts.push(path.basename(cwd) + (br ? C.dim + ' (' + br + ')' + C.reset : ''));

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
  if (pct === null) parts.push(C.dim + '上下文 --' + C.reset);
  else {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const color = p >= line ? C.red : (p >= line - 15 ? C.yellow : C.green);
    const filled = Math.round(p / 10);
    parts.push('上下文 ' + color + '█'.repeat(filled) + C.dim + '░'.repeat(10 - filled) + C.reset + ' ' + color + p + '%' + C.reset + C.dim + ' ' + k(used) + '/' + k(size) + C.reset);
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
  if (ch.length) parts.push('opsx ' + ch[0].name + ' ' + ch[0].done + '/' + ch[0].total + (ch.length > 1 ? C.dim + ' +' + (ch.length - 1) + C.reset : ''));

  // 警告放最前面：终端窄的时候被截掉的是末尾，最要紧的不能丢
  const gw = used ? nearGatewayLimit(used) : null;
  if (gw) parts.unshift(C.red + '⚠ 快到网关能接受的请求大小了（上次约 ' + k(gw.limitTokens) + ' 时被拒），现在就 /ttls-handover' + C.reset);
  else if (pct !== null && pct >= line) parts.unshift(C.red + '⚠ 上下文 ' + Math.round(pct) + '%，该交接了：/ttls-handover' + C.reset);
  // 放松保护的开关被绕开配置页改了（没生效）；经配置页关掉了禁改、开了自动放行的，也一直挂着提醒
  if (cfg._tampered) parts.unshift(C.red + '⚠ 套件开关文件被直接改过，没生效，去配置页核对' + C.reset);
  // 会话开始时比对过套件代码的指纹，对不上（被改过）：一直挂着，直到重新安装
  const drift = readState('kit-drift');
  if (Array.isArray(drift.list) && drift.list.length) parts.unshift(C.red + '⚠ 套件代码被改过（' + drift.list.length + ' 个文件），重新安装能恢复' + C.reset);
  else if (cfg.kitLock === false || cfg.kitBypass === 'auto') parts.push(C.yellow + (cfg.kitLock === false ? '禁改已关' : '') + (cfg.kitLock === false && cfg.kitBypass === 'auto' ? '、' : '') + (cfg.kitBypass === 'auto' ? '放行：自动' : '') + C.reset);
  // 有经验在几个项目里都成了规则、等你确认要不要升成用户级：挂在末尾提醒（去配置页"经验规则"里点）
  try { if (cfg.lessons !== 'off') { const n = require('./lib/lessons').pendingUser().length; if (n) parts.push(C.yellow + '经验待确认 ' + n + ' 条' + C.reset); } } catch (e) { /* 老版本没有，或者读不了 */ }
  // 自动更新：刚更新过（一小时内）说一声；开关是"只提醒"的挂着"有新版"；新版装不上的也挂着。只读一个状态文件，不连网
  try {
    const mode = ['auto', 'notify', 'off'].includes(cfg.autoUpdate) ? cfg.autoUpdate : 'auto';
    if (mode !== 'off') {
      const up = readState('update');
      let cur = '';
      try { cur = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch (e) { /* 没有版本号 */ }
      const failed = up.failed && up.failed.version === up.remoteVersion && up.failed.version !== cur ? up.failed : null;
      if (failed) parts.push(C.yellow + '新版 ' + failed.version + ' 没装上，看配置页' + C.reset);
      else if (up.remoteVersion && cur && up.remoteVersion !== cur) { if (mode === 'notify') parts.push(C.yellow + '有新版 ' + up.remoteVersion + '，去配置页更新' + C.reset); }
      else if (up.lastApplied && up.lastApplied.to === cur && Date.now() - (up.lastApplied.at || 0) < 3600000) parts.push(C.green + '已更新到 ' + cur + C.reset);
    }
  } catch (e) { /* 读不了就不显示 */ }
  if (pct !== null && j.session_id) writeState(j.session_id, { pct: Math.round(pct), used, size, windowSize, cwd: path.basename(cwd), at: Date.now() });
  process.stdout.write(parts.join(C.dim + ' │ ' + C.reset) + '\n');
});

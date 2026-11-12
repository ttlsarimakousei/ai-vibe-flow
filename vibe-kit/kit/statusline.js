'use strict';
/*
 * Claude Code 状态栏（用户 2026-11-03 定的，第 46、47 条）：
 *   第一行  警告 │ 目录(分支) │ 上下文进度条 │ 自动 开
 *   第二行  步骤条：探索✓ │ c2-api 提案✓◆ 规格✓◆ 设计✓◆ 任务✓◆ 1组✓◆ 2组●◇ 3组○ │ 自测○ 核验○ 归档○（lib/big-task.js 的 bar）
 *           ✓做完 ●正在做 ○没开始；◆审过 ◇在审 ✗N 有 N 条 P1、P2 待修。没进流程不显示：目录里有没勾完的 change 也不显示
 *   第三行  下一项，或者在等你什么
 *   有才出现的一行：放松了的保护、经验待确认、更新
 * 终端窄的时候被截掉的是每一行的末尾，所以要紧的放前面，警告放在第一行最前面。
 * 用了多少 token 优先用 Claude Code 自己给的数；旧版本不给，就读会话记录里最后一次回复的用量。
 * 百分比的分母是配置里的"上下文上限"（默认 100 万，填 0 表示跟着 Claude Code 报的窗口走），交接线默认 70%。
 * 这两个数在配置页（/vk-config）的"套件开关"里改。每次刷新都现读配置，改完不用重开会话，下一次刷新就按新值显示。
 * 公司规定用到交接线必须交接并开新会话：到线就变红，并把提醒放在最前面。用量超过上限（Claude Code 没自动压缩）另说一句怎么办。
 * 用了多少、Claude Code 报的窗口多大、这个会话最高用到多少，顺手记下来，给提醒钩子、配置页和使用情况统计用。
 */
const fs = require('fs');
const path = require('path');
const { tailEntries, lastUsageTokens, readConfig, contextPercent, readState, writeState, flowState, flowDone } = require('./lib/session');

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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let j = {};
  try { j = JSON.parse(raw || '{}'); } catch (e) { /* 空输入也要出一行 */ }
  const line1 = [];
  const extra = [];

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

  // 警告放第一行最前面：终端窄的时候被截掉的是末尾，最要紧的不能丢
  if (pct !== null && pct >= 100) line1.unshift(C.red + '⚠ 上下文超过上限了（' + k(used) + '/' + k(size) + '），Claude Code 没自动压缩：敲 /compact 压缩，或者 /vk-handover 交接' + C.reset);
  else if (cfg.contextStrategy === 'handover' && pct !== null && pct >= line) line1.unshift(C.red + '⚠ 上下文 ' + Math.round(pct) + '%，到手动交接线：/vk-handover' + C.reset);
  // 放松保护的开关被绕开配置页改了（没生效）
  if (cfg._tampered) line1.unshift(C.red + '⚠ 套件开关文件被直接改过，没生效，去配置页核对' + C.reset);
  // 套件代码和安装时的指纹对不上，以前挂红字。2026-11-04 起套件可以改（仓库主人定的），状态栏不再显示；doctor.js 照样查得到

  // 自动模式按会话开（问题表第 28 条）
  const flowJ = { session_id: j.session_id, cwd };
  let fl = {}; try { const v = require('./lib/session').flowView(flowJ) || {}; fl = { switchOn: v.switchOn, waiting: v.waiting }; } catch (e) { fl = {}; }
  line1.push(fl.switchOn ? C.yellow + '自动 开' + C.reset : C.dim + '自动 关' + C.reset);
  // 步骤条和下一项按会话缓存 5 秒：状态栏刷新得勤，大任务每次都读一遍 tasks.md、plan.md 太慢
  let steps = ''; let next = '';
  try {
    const ck = String(j.session_id || '') + '|' + String(cwd).toLowerCase();
    const cache = readState('changes-cache');
    let b = cache[ck] && Date.now() - cache[ck].at < 5000 ? cache[ck].bar : undefined;
    if (b === undefined) {
      b = require('./lib/big-task').bar(flowJ);
      cache[ck] = { at: Date.now(), bar: b };
      for (const key of Object.keys(cache)) if (Date.now() - cache[key].at > 3600000) delete cache[key];
      writeState('changes-cache', cache);
    }
    if (b) { steps = b.steps; next = b.next; }
  } catch (e) { steps = ''; next = ''; }
  // 在等你：写明你下一步说什么
  if (fl.waiting && !/^等你核验/.test(next)) next = '等你：' + fl.waiting + (/范围变化/.test(fl.waiting) ? '，说开工或 /vk-go' : '');
  // 有经验在几个项目里都成了规则、等你确认要不要升成用户级（去配置页"经验规则"里点）
  try { if (cfg.lessons !== 'off') { const n = require('./lib/lessons').pendingUser().length; if (n) extra.push(C.yellow + '经验待确认 ' + n + ' 条' + C.reset); } } catch (e) { /* 老版本没有，或者读不了 */ }
  // 自动更新：刚更新过（一小时内）说一声；开关是"只提醒"的挂着"有新版"；新版装不上的也挂着；
  // 新版在等尝鲜组、被尝鲜组报了有问题、仓库里有新版但固定着或跳过了的也说。只读一个状态文件，不连网
  try {
    const mode = ['auto', 'notify', 'off'].includes(cfg.autoUpdate) ? cfg.autoUpdate : 'auto';
    if (mode !== 'off') {
      const up = readState('update');
      let cur = '';
      try { cur = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch (e) { /* 没有版本号 */ }
      const failed = up.failed && up.failed.version === up.remoteVersion && up.failed.version !== cur ? up.failed : null;
      // 装坏了、也没能装回上一版（审核 P04）：现在装着的就是坏的，放第一行红字
      let doneAt = 0; try { doneAt = Number(JSON.parse(fs.readFileSync(path.join(__dirname, 'state', 'install-done.json'), 'utf8')).at) || 0; } catch (e) { /* 没装过新的 */ }
      if (up.failed && up.failed.rolledBack === false && !(doneAt > Number(up.failed.at || 0))) line1.unshift(C.red + '⚠ 新版 ' + up.failed.version + ' 没装好，也没能装回上一版：后台会再试，急用就在配置页"更新和上报"点"立即更新"或重新运行安装包' + C.reset);
      // 发版保护（K2）现在拦着没有：等尝鲜组先试、尝鲜组报了这一版有问题（和配置页用同一份判断）
      let ph = null;
      try { const U = require('./lib/updater'); ph = { p: U.phase(cfg, up, cur, Date.now()), when: U.whenText }; } catch (e) { ph = null; }
      if (failed) extra.push(C.yellow + '新版 ' + failed.version + ' 没装上，看配置页' + C.reset);
      // 安装器什么都没动就停了（settings.json 读不懂、全局约定不是 UTF-8、Node 太老）：要用户改电脑上的问题，不然一直装不上（复审 S5）
      else if (up.refused && up.refused.version === up.remoteVersion && up.refused.version !== cur) extra.push(C.yellow + '新版 ' + up.refused.version + ' 装不上：电脑上有问题要改，看配置页' + C.reset);
      else if (ph && ph.p.hold === 'pin') extra.push(C.dim + '固定在 ' + ph.p.pin + '，不自动更新（仓库里是 ' + up.remoteVersion + '）' + C.reset);
      else if (ph && ph.p.hold === 'skip') extra.push(C.dim + '跳过了新版 ' + up.remoteVersion + '，出了别的版本照常' + C.reset);
      else if (ph && ph.p.hold === 'flag') extra.push(C.yellow + '新版 ' + up.remoteVersion + ' 尝鲜组报了有问题，先不装' + C.reset);
      else if (ph && ph.p.hold === 'wait') extra.push(C.dim + '新版 ' + up.remoteVersion + ' 等尝鲜组先试，' + ph.when(ph.p.until) + ' 以后' + (mode === 'auto' ? '装' : '再装') + C.reset);
      else if (up.remoteVersion && cur && up.remoteVersion !== cur) { if (mode === 'notify') extra.push(C.yellow + '有新版 ' + up.remoteVersion + '，去配置页更新' + C.reset); }
      else if (up.lastApplied && up.lastApplied.to === cur && Date.now() - (up.lastApplied.at || 0) < 3600000) extra.push(C.green + '已更新到 ' + cur + C.reset);
    }
  } catch (e) { /* 读不了就不显示 */ }

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
  process.stdout.write([line1.join(SEP), steps, next ? C.dim + next + C.reset : '', extra.join(SEP)].filter(Boolean).join('\n') + '\n');
});

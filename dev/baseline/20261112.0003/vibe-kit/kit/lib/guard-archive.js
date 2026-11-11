'use strict';
/*
 * 归档门槛（2026-11-01 从 guard-commit 拆出来，K 批）：openspec archive、或者把 openspec/changes/<名字> 挪进 archive，
 * 要任务全打勾、代码审过、用户自测过并说了归档。规矩写在 hooks/guard-commit.js 开头第 4 条。
 */
const fs = require('fs');
const path = require('path');
const { readConfigFor, flowState, flowTouch, userSaid, mentionsChange, allChanges, changeRoots, normKey, codeReviewIssue, touchChange, isDeferredTask, tailEntries } = require('./session');
const { local, baseName } = require('./shell-words');
const { parseGit } = require('./guard-git');

// ---------- 归档门槛 ----------
function archiveTarget(ws, head, dir) {
  const k = ws.findIndex((w) => baseName(w.text) === 'openspec');
  if (k >= 0 && ws[k + 1] && ws[k + 1].text === 'archive') {
    for (let n = k + 2; n < ws.length; n++) {
      const t = ws[n].text;
      if (t === '--change' || t === '-c') return ws[n + 1] ? { name: ws[n + 1].text } : null;
      if (t.startsWith('--change=')) return { name: t.slice(9) };
      if (t.startsWith('-')) continue;
      return { name: t };
    }
    return { name: '' };
  }
  let args = null;
  if (['mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'robocopy'].includes(head.name)) args = ws.slice(head.i + 1);
  const g = parseGit(ws, dir);
  if (g && g.sub === 'mv') { args = g.args; dir = g.dir; }
  if (!args) return null;
  const plain = args.filter((w) => !w.text.startsWith('-') && !/^\/[A-Za-z]{1,2}$/.test(w.text));
  if (plain.length < 2) return null;
  // Windows 路径在 Bash 的规则下反斜杠会被吃掉：原样的写法也试一遍
  const forms = (w) => [...new Set([w.text, String(w.raw).replace(/^["']|["']$/g, '')])];
  for (const s of forms(plain[0])) {
    for (const d of forms(plain[plain.length - 1])) {
      const src = normKey(path.resolve(dir, local(s.replace(/[\\/]+$/, ''))));
      const dst = normKey(path.resolve(dir, local(d)));
      const m = src.match(/^(.*\/openspec\/changes)\/([^/]+)$/);
      if (m && m[2] !== 'archive' && dst.includes('/openspec/changes/archive')) return { name: m[2], changesDir: m[1] };
    }
  }
  return null;
}

/** 归档门槛。过了返回 null；没过返回 { name: 查的是哪个变更, msg } */
function archiveIssue(t, dir, j) {
  let es = [];
  if (j && j.transcript_path) { try { es = tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain); } catch (e) { /* 读不了就按没说过算 */ } }
  let chDir = '';
  let guessed = false;
  if (t.changesDir) chDir = path.join(t.changesDir, t.name);
  else if (t.name) { for (const root of changeRoots(dir)) { const d = path.join(root, t.name); if (fs.existsSync(d)) { chDir = d; break; } } }
  else {
    // 命令里没写变更名：没归档的变更只有一个时，查的就是它（提示里说明，免得以为查错了人——问题反馈 F20260929-004）
    const active = [];
    for (const root of changeRoots(dir)) try { for (const n of fs.readdirSync(root)) if (n !== 'archive' && fs.statSync(path.join(root, n)).isDirectory()) active.push(path.join(root, n)); } catch (e) { /* 读不了 */ }
    if (active.length === 1) { chDir = active[0]; guessed = true; }
  }
  if (!chDir || !fs.existsSync(chDir)) return null;
  if (j && j.session_id) touchChange(j.session_id, chDir);
  const name = path.basename(chDir);
  const cfg = readConfigFor(j);
  // 归档命令点到的变更：算这个会话在流程里动手做的（收工时照着它往下催、写进报告）
  if (cfg.autoSwitch && flowState(j).on) flowTouch(j, chDir);
  // 大任务：按表的顺序归档，归档前要预演过（用户 2026-11-03 定的）
  try {
    const B = require('../lib/big-task');
    const task = B.ofChange(path.resolve(chDir, '../../..'), chDir);
    if (task && !task.legacy) {
      const first = task.changes.find((c) => !c.archived);
      if (first && first.name !== name) return { name, msg: '[vibe-kit] 大任务 ' + task.name + ' 要按 plan.md 表的顺序归档：下一个是 ' + first.name + '，不是 ' + name + '。后面的 change 依赖前面的需求，顺序错了 OpenSpec 会拒绝。' };
      const ck = B.taskState(task).archiveCheck;
      if (task.changes.every((c) => !c.archived) && (!ck || ck.specs !== B.specsHash(task))) return { name, msg: '[vibe-kit] 归档前先预演：node "' + path.join(__dirname, '..', 'tools', 'workflow.js') + '" archive-check --task ' + task.name + ' --project ' + path.resolve(chDir, '../../..') + '。在临时副本里按表的顺序跑一遍归档，过了才动真目录。' };
    }
  } catch (e) { /* 算不了不挡归档 */ }
  const issues = [];
  let waiting = 0;
  try {
    const open = (fs.readFileSync(path.join(chDir, 'tasks.md'), 'utf8').match(/^\s*[-*]\s*\[ \]\s*.*$/gm) || []);
    waiting = open.filter((l) => isDeferredTask(l)).length;
    if (open.length) issues.push('还有 ' + open.length + ' 项任务没打勾' + (waiting ? '（其中 ' + waiting + ' 项是留给用户做的）' : ''));
  } catch (e) { /* 没有 tasks.md 就不管任务 */ }
  const cr = cfg.autoMode ? codeReviewIssue(chDir) : '';
  if (cr) issues.push(cr);
  const who = guessed ? '这条命令没写变更名，没归档的变更只有 ' + name + ' 一个，查的是它（要归档的是别的，把名字写上）。' : '';
  if (!issues.length) {
    // 任务都打了勾、代码也审过了：还要用户自测过、说了归档（用户 2026-10-07 定的）。认会话记录里他最后一句话；点了别的变更的名不算
    const said = userSaid(es, 'archive');
    let others = [];
    try { if (said.ok && said.text) others = allChanges(dir).map((c) => c.name).filter((n) => mentionsChange(said.text, n)); } catch (e) { others = []; }
    const wrong = others.length > 0 && !others.some((n) => n.toLowerCase() === name.toLowerCase());
    const permit = said.ok && !wrong ? require('../lib/permissions').allow(j, 'archive', chDir, j.tool_use_id) : { ok: false };
    if (permit.ok) return null;
    const why = wrong ? '我说的是归档 ' + others.join('、') + '，不是它' : permit.reason || '我还没自测、还没说归档';
    // 人工模式归档不要求审查（用户 2026-10-16 定的），审过没有照实说
    const reviewed = cfg.autoMode || !codeReviewIssue(chDir) ? '、代码也审过了' : '，代码没有做过完整审查（人工模式审不审由我决定）';
    return { name, noBypass: true, msg: '[vibe-kit] ' + who + '变更 ' + name + ' 的任务都打了勾' + reviewed + '，但' + why + '。归档要我自测过、我说了才做：先交代做了什么、怎么自测（起服务的命令、要看的页面、要调的接口、要执行的脚本），然后' + (cfg.autoMode ? '收工交报告，写进"留给你做的"：等我自测过说归档。不要再试归档。' : '用提问框问我自测过了没有、能不能归档（选项写"归档"和"还要改"）。我说还要改什么，改完再问；我说归档了再归档。') };
  }
  const tail = !cfg.autoMode ? '确实要放弃这个变更，告诉我，我来删。'
    : waiting ? '留给用户做的任务还没做，这个变更先不归档：写进最后的交代，接着做别的。' : '';
  const order = cfg.autoMode ? '任务全部打勾 → /vk-cross-review 审代码 → 修掉成立的问题并验证 → 再归档' : '任务全部打勾 → 要不要审查、自测由我决定 → 我说归档再归档';
  return { name, msg: '[vibe-kit] ' + who + '变更 ' + name + ' 还不能归档：' + issues.map((s) => s.replace(/。$/, '')).join('；') + '。顺序是：' + order + '。' + tail };
}

module.exports = { archiveTarget, archiveIssue };

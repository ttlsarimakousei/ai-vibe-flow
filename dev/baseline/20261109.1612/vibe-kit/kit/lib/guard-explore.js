'use strict';
/*
 * 探索完之后，探索记录的"范围""定了的"两节、plan.md 的表，只有用户开口的那一轮能改（用户 2026-11-03 定的，第 43 条）。
 * 需求、apply、自测都对着探索记录核对；模型自己改了这两节，"没说的不加"就没有依据了。
 * 怎么算"用户开口的那一轮"：用户最后一次说话（含提问框答案）之后，这个会话还没有收过工（verify-gate 记的 lastStopAt）。
 * 落地偏差、别的小节随时能写。探索中（还没有 change 开始）都放行。不在流程里不管。
 */
const fs = require('fs');
const path = require('path');

const GUARDED = ['范围', '定了的'];
function sectionsOf(text) {
  const out = {}; let cur = null;
  for (const line of String(text).replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out[cur] = ''; continue; }
    if (cur) out[cur] += line + '\n';
  }
  return out;
}
const rowsOf = (text) => String(text).split(/\r?\n/).filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]*\|?\s*$/.test(l)).map((l) => l.split('|')[2]).filter(Boolean).map((s) => s.trim());
function simulate(j, oldText) {
  const inp = j.tool_input || {};
  if (j.tool_name === 'Write') return String(inp.content == null ? '' : inp.content);
  if (j.tool_name === 'Edit') return inp.replace_all ? oldText.split(String(inp.old_string)).join(String(inp.new_string)) : oldText.replace(String(inp.old_string), () => String(inp.new_string));
  if (j.tool_name === 'MultiEdit') return (inp.edits || []).reduce((t, e) => t.replace(String(e.old_string), () => String(e.new_string)), oldText);
  return oldText;
}
/** 用户开口之后还没收过工 */
function userTurn(j) {
  const S = require('./session');
  if (!j.transcript_path) return true;
  const v = S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
  if (!v) return false;
  const stop = Number(S.readState(String(j.session_id) + '-last-stop').at) || 0;
  return !stop || (Number(v.at) || 0) > stop;
}
function issue(j, file) {
  const S = require('./session');
  if (!S.flowState(j).on) return '';
  const B = require('./big-task');
  const k = S.normKey(file);
  for (const task of B.tasks(j.cwd || process.cwd())) {
    const isExplore = task.explore && S.normKey(task.explore) === k;
    const isPlan = S.normKey(task.planFile) === k;
    if (!isExplore && !isPlan) continue;
    if (B.phaseOf(task).phase === 'explore' || !task.changes.some((c) => c.exists || c.archived)) return '';
    let oldText = ''; try { oldText = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
    const next = simulate(j, oldText);
    if (isExplore) {
      const a = sectionsOf(oldText); const b = sectionsOf(next);
      const changed = GUARDED.filter((s) => String(a[s] || '').trim() !== String(b[s] || '').trim());
      if (!changed.length || userTurn(j)) return '';
      return '探索完之后，探索记录的"' + changed.join('""') + '"只有用户开口的那一轮能改：需求、apply、自测都对着它核对，用户没说的不加。想到的新东西记成范围外建议：node "' + path.join(__dirname, '..', 'tools', 'workflow.js') + '" suggest --task ' + task.name + ' --text "<建议>"，人工核验时列给用户。落地偏差那一节随时能写。';
    }
    const added = rowsOf(next).filter((r) => !rowsOf(oldText).includes(r));
    if (!added.length || userTurn(j)) return '';
    return 'plan.md 的表不能自己加行（' + added.join('、') + '）：用户说要加才加（第 38 条）。不属于这个大任务的就不用管。';
  }
  return '';
}
module.exports = { issue, sectionsOf };

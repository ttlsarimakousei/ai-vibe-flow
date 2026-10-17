'use strict';
/* apply 的范围与实质提案绑定；勾选进度不改范围。发现新增变更、换项目或修改需求时回到沟通阶段，不凭已有勾选开工。 */
const fs = require('fs');
const path = require('path');
const W = require('./workspace');
function planHash(dir) {
  const S = require('./session'); const rows = [];
  for (const f of S.artifactFiles(dir).filter((f) => !/revisions\.md$/.test(f))) { try { const t = fs.readFileSync(f, 'utf8'); rows.push([path.relative(dir, f), W.hash(/tasks\.md$/.test(f) ? W.progressText(t) : t)]); } catch (e) { rows.push([f, '缺失']); } }
  return W.hash(JSON.stringify(rows));
}
function grant(j, text, context) {
  const S = require('./session'); const all = S.allChanges(j.cwd || process.cwd()); const named = all.filter((c) => S.mentionsChange(text, c.name));
  const asked = all.filter((c) => S.mentionsChange(context || '', c.name));
  if (!named.length && asked.length > 1) return { ok: false, reason: '提问涉及多个变更，请在答案里明确选择开工目标' };
  const touched = all.filter((c) => S.flowChanges(j).includes(S.normKey(c.dir)));
  const targets = named.length ? named : asked.length === 1 ? asked : all.length === 1 ? all : touched.length === 1 ? touched : [];
  if (!targets.length) return { ok: false, reason: all.length ? '有多个变更，请明确 apply 哪个变更' : '没有当前变更，按普通任务沟通' };
  const scope = { at: Date.now(), dirs: {}, roots: [] };
  for (const c of targets) { scope.dirs[S.normKey(c.dir)] = { hash: planHash(c.dir) }; for (const root of S.projectRootsOf(c.dir)) if (!scope.roots.includes(S.normKey(root))) scope.roots.push(S.normKey(root)); }
  const voice = j.transcript_path && S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
  const saved = S.updateState(j.session_id + '-flow', (s) => { s.applyScope = scope; s.waiting = ''; s.lastApplyAt = scope.at; s.applySource = { text: String(text).slice(0, 500), targets: targets.map((c) => c.name), at: scope.at }; if (voice) { s.applyVoice = S.voiceKey(voice); s.applyVoiceSchema = 2; } });
  if (!saved) return { ok: false, reason: '开工范围暂时不能保存，请重试' };
  try { require('./review-runner').baseline(j, targets.map((c) => c.dir)); } catch (e) { /* 审查缺基线时明确降级 */ }
  return { ok: true, targets: targets.map((c) => c.name) };
}
function valid(j) {
  const S = require('./session'); const st = S.flowState(j); if (!st.applyScope) return { ok: st.stage === 'apply' };
  for (const [dir, p] of Object.entries(st.applyScope.dirs || {})) if (!fs.existsSync(dir) || planHash(dir) !== p.hash) return { ok: false, reason: '需求、设计或任务验法已变化，先沟通新范围，再明确 apply' };
  return { ok: true };
}
function check(j, target) {
  const S = require('./session'); const st = S.flowState(j);
  if (st.on && st.stage === 'plan' && st.waiting === 'scope' && !S.artifactOf(target)) return '提案已修订，业务代码要重新明确开工；可以继续修改提案和修订记录';
  if (!st.on || st.stage !== 'apply' || !st.applyScope) return '';
  const v = valid(j); if (!v.ok) return v.reason;
  const file = S.normKey(target); const a = S.artifactOf(target);
  if (a && !st.applyScope.dirs[S.normKey(a.dir)]) return '这个变更不在当前 apply 许可里，先沟通范围并单独开工';
  if (!a && !(st.applyScope.roots || []).some((r) => file === r || file.startsWith(r + '/'))) return '目标项目不在当前 apply 许可里，不能借用另一个项目的全自动状态';
  return '';
}
// 修订产物时退出失效的实施范围；源码与任务打勾仍必须有新版开工许可。
function prepareEdit(j, target) {
  const S = require('./session'); const st = S.flowState(j); const a = S.artifactOf(target);
  if (!a || !st.on || st.stage !== 'apply' || !st.applyScope) return;
  const input = j.tool_input || {}; let ticking = false;
  if (a.kind === 'tasks') {
    let old = ''; try { old = fs.readFileSync(target, 'utf8'); } catch (e) { /* 新产物 */ }
    const next = input.content !== undefined ? String(input.content) : input.edits ? input.edits.reduce((s, e) => s.replace(String(e.old_string || ''), String(e.new_string || '')), old) : old.replace(String(input.old_string || ''), String(input.new_string || ''));
    ticking = S.tickedLines(old, next).length > 0;
  }
  if (ticking || valid(j).ok && st.applyScope.dirs[S.normKey(a.dir)]) return;
  S.updateState(j.session_id + '-flow', (s) => { s.stage = 'plan'; s.waiting = 'scope'; s.why = '修订提案，旧开工范围失效'; delete s.applyScope; });
  S.hookLog('范围回到提案阶段：' + a.name);
}
module.exports = { grant, valid, check, planHash, prepareEdit };

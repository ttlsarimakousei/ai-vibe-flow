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
function grant(j, text) {
  const S = require('./session'); const all = S.allChanges(j.cwd || process.cwd()); const named = all.filter((c) => S.mentionsChange(text, c.name));
  const targets = named.length ? named : all.length === 1 ? all : [];
  if (!targets.length) return { ok: false, reason: all.length ? '有多个变更，请明确 apply 哪个变更' : '没有当前变更，按普通任务沟通' };
  const scope = { at: Date.now(), dirs: {}, roots: [] };
  for (const c of targets) { scope.dirs[S.normKey(c.dir)] = { hash: planHash(c.dir) }; for (const root of S.projectRootsOf(c.dir)) if (!scope.roots.includes(S.normKey(root))) scope.roots.push(S.normKey(root)); }
  S.updateState(j.session_id + '-flow', (s) => { s.applyScope = scope; s.waiting = ''; });
  try { require('./review-runner').baseline(j, targets.map((c) => c.dir)); } catch (e) { /* 审查缺基线时明确降级 */ }
  return { ok: true, targets: targets.map((c) => c.name) };
}
function valid(j) {
  const S = require('./session'); const st = S.flowState(j); if (!st.applyScope) return { ok: st.stage === 'apply' };
  for (const [dir, p] of Object.entries(st.applyScope.dirs || {})) if (!fs.existsSync(dir) || planHash(dir) !== p.hash) return { ok: false, reason: '需求、设计或任务验法已变化，先沟通新范围，再明确 apply' };
  return { ok: true };
}
function check(j, target) {
  const S = require('./session'); const st = S.flowState(j); if (!st.on || st.stage !== 'apply' || !st.applyScope) return '';
  const v = valid(j); if (!v.ok) return v.reason;
  const file = S.normKey(target); const a = S.artifactOf(target);
  if (a && !st.applyScope.dirs[S.normKey(a.dir)]) return '这个变更不在当前 apply 许可里，先沟通范围并单独开工';
  if (!a && !(st.applyScope.roots || []).some((r) => file === r || file.startsWith(r + '/'))) return '目标项目不在当前 apply 许可里，不能借用另一个项目的全自动状态';
  return '';
}
module.exports = { grant, valid, check, planHash };

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
/**
 * 登记开工范围。text 是用户的话（或提问框的答案）；context 是提问框的问题；
 * opts.said 是模型在用户这句话之前最后说的那段话、opts.hint 是这一步要改的文件或变更目录：
 * 用户只说"开工"、有好几个变更时（#214：两个没归档的变更，"开工"、/opsx:apply 都认不出开哪个），
 * 模型刚才那段话里只点了一个变更名的用它，再定不了就看这一步要改的是哪个变更
 */
function grant(j, text, context, opts) {
  const S = require('./session'); const o = opts || {}; const all = S.allChanges(j.cwd || process.cwd()); const named = all.filter((c) => S.mentionsChange(text, c.name));
  const asked = all.filter((c) => S.mentionsChange(context || '', c.name));
  if (!named.length && asked.length > 1) return refuse(j, '提问里有 ' + asked.map((c) => c.name).join('、') + ' 几个变更，用户选开工时没说开哪个：提问框的选项写明变更名（例："开工 ' + asked[0].name + '"）', all);
  const touched = all.filter((c) => S.flowChanges(j).includes(S.normKey(c.dir)));
  // /opsx:apply 技能的参数里点了名的（模型照用户的"开工"调技能时带上的变更名）
  const argued = all.filter((c) => S.mentionsChange(o.args || '', c.name));
  const spoken = all.filter((c) => S.mentionsChange(o.said || '', c.name));
  // 要改的文件在哪个变更目录里就认哪个；不在变更目录里的（业务代码），只有一个变更的项目包含它时才认
  const hk = o.hint ? S.normKey(o.hint) : '';
  const under = (k, d) => k === d || k.startsWith(d + '/');
  const inChange = hk ? all.filter((c) => under(hk, S.normKey(c.dir))) : [];
  const hinted = !hk ? [] : inChange.length ? inChange : all.filter((c) => S.projectRootsOf(c.dir).some((r) => under(hk, S.normKey(r))));
  const targets = named.length ? named : argued.length === 1 ? argued : asked.length === 1 ? asked : all.length === 1 ? all : touched.length === 1 ? touched : spoken.length === 1 ? spoken : hinted.length === 1 ? hinted : [];
  if (!targets.length) return refuse(j, all.length ? '有 ' + all.map((c) => c.name).slice(0, 5).join('、') + ' 几个变更，用户说开工时没点名：让用户说"开工 ' + all[0].name + '"这样带上变更名，或者在提问框的选项里写明' : '没有当前变更，按普通任务沟通', all);
  const scope = { at: Date.now(), dirs: {}, roots: [] };
  for (const c of targets) { scope.dirs[S.normKey(c.dir)] = { hash: planHash(c.dir) }; for (const root of S.projectRootsOf(c.dir)) if (!scope.roots.includes(S.normKey(root))) scope.roots.push(S.normKey(root)); }
  const voice = j.transcript_path && S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
  const saved = S.updateState(j.session_id + '-flow', (s) => { delete s.applyRefused; s.applyScope = scope; s.waiting = ''; s.lastApplyAt = scope.at; s.applySource = { text: String(text).slice(0, 500), targets: targets.map((c) => c.name), at: scope.at }; if (voice) { s.applyVoice = S.voiceKey(voice); s.applyVoiceSchema = 2; } });
  if (!saved) return { ok: false, reason: '开工范围暂时不能保存，请重试' };
  try { require('./review-runner').baseline(j, targets.map((c) => c.dir)); } catch (e) { /* 审查缺基线时明确降级 */ }
  return { ok: true, targets: targets.map((c) => c.name) };
}
/** 开工没认下来：原因记进流程状态（绑定是哪一次开口），拦"还没开工"的地方照着说，不再只说"用户还没说开工" */
function refuse(j, reason, all) {
  try {
    const S = require('./session');
    const v = j.transcript_path && S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
    if (j.session_id) S.updateState(j.session_id + '-flow', (s) => { s.applyRefused = { reason, voice: v ? S.voiceKey(v) : '', at: Date.now() }; });
  } catch (e) { /* 记不了：拦截提示照旧 */ }
  return { ok: false, reason, changes: (all || []).map((c) => c.name) };
}
/** 用户最后一句是开工、却没认下来的原因；没有返回 '' */
function refusal(j) {
  try {
    const S = require('./session'); const st = S.flowState(j); const r = st.applyRefused;
    if (!r || !r.reason || !j.transcript_path) return '';
    const v = S.lastUserVoice(S.tailEntries(j.transcript_path, 3000000));
    return v && S.voiceKey(v) === r.voice ? r.reason : '';
  } catch (e) { return ''; }
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
module.exports = { grant, refusal, valid, check, planHash, prepareEdit };

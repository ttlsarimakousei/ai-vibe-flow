'use strict';
/*
 * 明确用户许可绑定会话、动作、目标和当前版本。成功才消费，失败重试保留；旧交接、不同目标与改动后的版本不能借用。
 * 每个动作各自记是哪一次开口给的许可（2026-10-25 起）：审查、自测往回看本轮，给许可的不一定是最后一句，
 * 以前整份记录只认一个开口，换一次开口就把别的动作的许可一起清掉。
 * 提交、推送：同一句许可可以用在几个仓库上，每个仓库一次（壳子里几个子项目都改了，#207）；话里点了子项目名的，只用在点了名的那几个。
 * "改完提交""修好再推送"这种先改后提的，开口时不登记版本，到真正提交、推送时再登记（#215"确认后输入发生变化"）。
 * 审查、提交：同一句许可在这一轮里能用好几次（用户 2026-10-28 定的，问题反馈表第 16 条："审核、提交之类的经常要确认多遍"）——
 *   说了"审查"，这一轮里审几个点、改完再复审都算；说了"提交"，按规矩分几次提交都算，中间改过代码也不用再问。
 *   用户下一次开口（换了一句话）就从头算。推送、归档、接受、跳过照旧一次一用。
 */
const path = require('path');
const W = require('./workspace');
function keyOf(j) { return j && j.session_id && j.session_id !== 'unknown' ? j.session_id + '-permissions' : ''; }
// 升级前的记录只有一个整份的 voice：先把它分给各个动作，旧许可的消费记录照留，不能因为标识算法变化把旧答案当新确认。
function migrate(st, v) {
  if (st.voice === undefined) return;
  const S = require('./session');
  const vk = S.voiceKey(v);
  const oldKey = W.hash(JSON.stringify([v.kind, v.at, v.pos, v.text]));
  const latest = Math.max(0, ...Object.values(st.actions || {}).map((a) => a.at || 0));
  const legacySame = st.voiceSchema !== 2 && (st.voice === oldKey || !v.at || !latest || v.at <= latest);
  for (const a of Object.values(st.actions || {})) if (a && !a.voice) a.voice = legacySame ? vk : st.voice;
  delete st.voice; delete st.voiceSchema;
}
function scopeOf(j, action, target) { return path.resolve(target || j.cwd || process.cwd()).replace(/\\/g, '/').toLowerCase(); }
function versionOf(j, action, target) { return W.fingerprint(action === 'archive' || action === 'accept' ? W.rootOf(target) : target || j.cwd, action === 'archive' || action === 'accept' ? 'code' : 'all').hash; }
function entriesOf(j) { const S = require('./session'); return j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : []; }
/** 话里点了名的仓库（壳子里子项目的目录名）：没点名返回空 */
function namedRepos(j, text) {
  const S = require('./session');
  let roots = [];
  try { const home = S.sessionHome(j); roots = S.isShell(home) ? S.nestedRepos(home) : []; } catch (e) { roots = []; }
  const t = String(text || '').toLowerCase();
  return roots.filter((r) => { const n = path.basename(r).toLowerCase(); return n.length > 1 && new RegExp('(^|[^\\w-])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^\\w-]|$)').test(t); });
}
// 先改后提："改完提交""修好再推送""审一下然后提交"
const DEFERRED = /(?:然后|之后|以后|再|完|好)\s*(?:git\s+)?(?:提交|commit|推送|push)/i;
const REUSABLE = new Set(['review', 'commit']);
function allow(j, action, target, toolId) {
  const S = require('./session'); const k = keyOf(j);
  if (!k) return { ok: false, reason: '没有可识别的会话许可' };
  const entries = entriesOf(j); const said = S.userSaid(entries, action);
  if (!said.ok) return { ok: false, reason: '没有当前用户的明确' + action + '许可' };
  const v = said.voice; const vk = S.voiceKey(v);
  const all = S.allChanges(j.cwd || process.cwd()); const selected = all.filter((c) => S.mentionsChange(said.text, c.name));
  const names = selected.length ? selected : all.filter((c) => S.mentionsChange(said.targetText || said.text, c.name));
  if (['archive', 'reviewBudget', 'reviewSkip', 'reviewAccept'].includes(action) && !selected.length && names.length > 1 && !/全部|所有|各个|分别|批量/.test(said.text)) return { ok: false, reason: '提问有多个变更，请明确这次许可的目标' };
  if (['archive', 'reviewBudget', 'reviewSkip', 'reviewAccept'].includes(action) && names.length && !names.some((c) => path.resolve(c.dir).toLowerCase() === path.resolve(target).toLowerCase())) return { ok: false, reason: '这次许可属于另一个变更' };
  const multi = action === 'commit' || action === 'push';
  if (multi) {
    const named = namedRepos(j, said.text);
    if (named.length && !named.some((r) => S.normKey(r) === S.normKey(W.rootOf(target || j.cwd)))) return { ok: false, reason: '用户这次点名的是 ' + named.map((r) => path.basename(r)).join('、') + '，不是这个仓库' };
  }
  const scope = scopeOf(j, action, target); const ver = versionOf(j, action, target); const id = action + '|' + scope;
  let result = { ok: false, reason: '许可状态暂时不能写入' };
  S.updateState(k, (st) => {
    migrate(st, v);
    const actions = st.actions || (st.actions = {});
    let old = actions[id];
    // 换了一次开口给的许可：这个动作从头算（别的动作不受影响）
    if (old && old.voice !== vk) { delete actions[id]; old = null; }
    const reusable = REUSABLE.has(action);
    if (old && old.consumed && !reusable && !(action === 'reviewBudget' && old.toolId === String(toolId || ''))) { result = { ok: false, reason: '这次许可已用于成功操作，需要重新确认' }; return; }
    if (old && old.version !== ver && !reusable) { result = { ok: false, reason: '确认后输入发生变化，需要重新确认当前版本' }; return; }
    if (!multi && !reusable && !old && Object.keys(actions).some((n) => n.startsWith(action + '|') && actions[n].consumed && actions[n].voice === vk) && !/全部|所有|各个|分别|批量/.test(said.text)) { result = { ok: false, reason: '这次许可已经用于另一个目标' }; return; }
    actions[id] = Object.assign(old || {}, { action, scope, version: ver, voice: vk, at: Date.now(), consumed: false });
    if (!old) actions[id].head = W.git(W.rootOf(target || j.cwd), ['rev-parse', 'HEAD']).trim();
    if (toolId) actions[id].toolId = String(toolId);
    if (action === 'reviewBudget') { actions[id].consumed = true; actions[id].finished = Date.now(); }
    result = { ok: true, key: k, id, version: ver };
  });
  return result;
}
function capture(j) {
  const S = require('./session'); const k = keyOf(j); if (!k) return;
  const entries = entriesOf(j); const v = S.lastUserVoice(entries); if (!v) return;
  S.updateState(k, (s) => { migrate(s, v); });
  // 先改后提的：版本到真正提交、推送时再登记
  for (const action of ['commit', 'push']) if (S.userSaid(entries, action).ok && !(v.kind === 'prompt' && DEFERRED.test(v.text))) allow(j, action, W.rootOf(j.cwd));
  for (const action of ['archive', 'accept']) if (S.userSaid(entries, action).ok) for (const c of S.allChanges(j.cwd)) if (S.mentionsChange(v.text, c.name) || S.allChanges(j.cwd).length === 1) allow(j, action, c.dir);
}
function consume(j, succeeded) {
  const S = require('./session'); const k = keyOf(j); if (!k || !succeeded || !j.tool_use_id) return;
  S.updateState(k, (s) => { for (const a of Object.values(s.actions || {})) if (a.toolId === String(j.tool_use_id) && !a.consumed) {
    if (a.action === 'commit' && a.head === W.git(a.scope, ['rev-parse', 'HEAD']).trim()) continue;
    if (a.action === 'archive' && require('fs').existsSync(a.scope)) continue;
    a.consumed = true; a.finished = Date.now();
  } });
}
module.exports = { allow, capture, consume, versionOf };

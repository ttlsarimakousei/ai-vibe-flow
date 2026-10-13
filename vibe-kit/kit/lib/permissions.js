'use strict';
/* 明确用户许可绑定会话、动作、目标和当前版本。成功才消费，失败重试保留；旧交接、不同目标与改动后的版本不能借用。 */
const path = require('path');
const W = require('./workspace');
function keyOf(j) { return j && j.session_id && j.session_id !== 'unknown' ? j.session_id + '-permissions' : ''; }
// 升级时保留旧许可的消费记录，不能因标识算法变化把旧答案当新确认。
function syncVoice(st, v) {
  const vk = require('./session').voiceKey(v);
  const oldKey = W.hash(JSON.stringify([v.kind, v.at, v.pos, v.text]));
  const latest = Math.max(0, ...Object.values(st.actions || {}).map((a) => a.at || 0));
  const legacySame = st.voice && st.voiceSchema !== 2 && (st.voice === oldKey || !v.at || !latest || v.at <= latest);
  if (st.voice !== vk && !legacySame) st.actions = {};
  st.voice = vk; st.voiceSchema = 2;
}
function scopeOf(j, action, target) { return path.resolve(target || j.cwd || process.cwd()).replace(/\\/g, '/').toLowerCase(); }
function versionOf(j, action, target) { return W.fingerprint(action === 'archive' || action === 'accept' ? W.rootOf(target) : target || j.cwd, action === 'archive' || action === 'accept' ? 'code' : 'all').hash; }
function entriesOf(j) { const S = require('./session'); return j.transcript_path ? S.tailEntries(j.transcript_path, 3000000) : []; }
function allow(j, action, target, toolId) {
  const S = require('./session'); const k = keyOf(j);
  if (!k) return { ok: false, reason: '没有可识别的会话许可' };
  const entries = entriesOf(j); const said = S.userSaid(entries, action);
  if (!said.ok) return { ok: false, reason: '没有当前用户的明确' + action + '许可' };
  const v = said.voice;
  const all = S.allChanges(j.cwd || process.cwd()); const selected = all.filter((c) => S.mentionsChange(said.text, c.name));
  const names = selected.length ? selected : all.filter((c) => S.mentionsChange(said.targetText || said.text, c.name));
  if (['archive', 'reviewBudget', 'reviewSkip', 'reviewAccept'].includes(action) && !selected.length && names.length > 1 && !/全部|所有|各个|分别|批量/.test(said.text)) return { ok: false, reason: '提问有多个变更，请明确这次许可的目标' };
  if (['archive', 'reviewBudget', 'reviewSkip', 'reviewAccept'].includes(action) && names.length && !names.some((c) => path.resolve(c.dir).toLowerCase() === path.resolve(target).toLowerCase())) return { ok: false, reason: '这次许可属于另一个变更' };
  const scope = scopeOf(j, action, target); const ver = versionOf(j, action, target); const id = action + '|' + scope;
  let result = { ok: false, reason: '许可状态暂时不能写入' };
  S.updateState(k, (st) => {
    syncVoice(st, v);
    const actions = st.actions || (st.actions = {}); const old = actions[id];
    if (old && old.consumed && !(action === 'reviewBudget' && old.toolId === String(toolId || ''))) { result = { ok: false, reason: '这次许可已用于成功操作，需要重新确认' }; return; }
    if (old && old.version !== ver) { result = { ok: false, reason: '确认后输入发生变化，需要重新确认当前版本' }; return; }
    if (!old && Object.keys(actions).some((n) => n.startsWith(action + '|') && actions[n].consumed) && !/全部|所有|各个|分别|批量/.test(said.text)) { result = { ok: false, reason: '这次许可已经用于另一个目标' }; return; }
    actions[id] = Object.assign(old || {}, { action, scope, version: ver, at: Date.now(), consumed: false });
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
  S.updateState(k, (s) => { syncVoice(s, v); });
  for (const action of ['commit', 'push']) if (S.userSaid(entries, action).ok) allow(j, action, W.rootOf(j.cwd));
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

'use strict';
/* 同一变更的活跃实施会话提示冲突。只提示、不隔离工作区、不阻断检索；退出、取消、归档和过期都撤销记录。 */
const fs = require('fs');
const S = require('./session');
const KEEP_MS = 30 * 60000;
function alive(pid) { if (!pid) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function touch(j) {
  if (!j.session_id) return [];
  const f = S.flowState(j); const h = S.readState(j.session_id + '-home'); const now = Date.now(); let conflicts = [];
  S.updateState('work-sessions', (s) => {
    for (const [id, r] of Object.entries(s)) if (!r || now - r.at > KEEP_MS || !alive(r.pid) || !(r.scopes || []).some((d) => fs.existsSync(d))) delete s[id];
    if (!f.on || f.stage !== 'apply' || S.flowView(j).waiting || !require('./apply-scope').valid(j).ok || S.flowDone(j)) { delete s[j.session_id]; return; }
    const scopes = Object.keys(f.applyScope && f.applyScope.dirs || {}).length ? Object.keys(f.applyScope.dirs) : S.flowChanges(j);
    conflicts = Object.entries(s).filter(([id, r]) => id !== j.session_id && r.scopes.some((d) => scopes.includes(d))).map(([id]) => id);
    const warned = conflicts.slice().sort().join('|'); const old = s[j.session_id];
    s[j.session_id] = { scopes, pid: h.ownerPid || 0, at: now, warned };
    if (old && old.warned === warned) conflicts = [];
  });
  return conflicts;
}
function clearOwner(pid) { S.updateState('work-sessions', (s) => { for (const [id, r] of Object.entries(s)) if (r && r.pid === pid) delete s[id]; }); }
module.exports = { touch, clearOwner, KEEP_MS };

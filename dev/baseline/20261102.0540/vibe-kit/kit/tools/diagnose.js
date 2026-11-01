'use strict';
/* 受控只读诊断入口，替代 node -e 引用套件内部模块。只输出会话阶段和钩子统计白名单，不读取秘密或执行项目操作。 */
const S = require('../lib/session'); const R = require('../lib/redact');
const args = process.argv.slice(2); const val = (k) => { const i = args.indexOf(k); return i < 0 ? '' : args[i + 1] || ''; };
const sid = val('--session'); if (sid && !/^[\w.-]{1,80}$/.test(sid)) throw new Error('会话编号格式不正确');
let result;
if (args[0] === 'flow' && sid) {
  const s = S.flowState({ session_id: sid }); result = { on: !!s.on, stage: s.stage || 'plan', reason: s.why || '', targets: Object.keys(s.applyScope && s.applyScope.dirs || {}), authorizedAt: s.applyScope && s.applyScope.at || 0, sourceTargets: s.applySource && s.applySource.targets || [] };
} else if (args[0] === 'hooks') result = { hooks: S.readState('hook-stats').byHook || {} };
else result = { usage: 'diagnose.js flow --session <当前会话编号>；diagnose.js hooks；审查结果用 review.js status|diagnose|sync' };
console.log(JSON.stringify(R.tree(result)));

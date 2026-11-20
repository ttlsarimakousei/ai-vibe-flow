'use strict';
/* 更新后的无副作用行为自检。仅确定性判断，不执行项目命令，不改用户设置；异常或行为不符返回失败。 */
function check() {
  try {
    const S = require('./session'); const I = require('./intent'); const R = require('./redact');
    if (S.applyIntent('先不要执行 apply') || I.explicit('提交时机需要讨论', 'commit') || I.explicit('归档策略是什么', 'archive')) return { ok: false, why: '明确许可检查没有通过' };
    if (!S.applyIntent('/opsx:apply')) return { ok: false, why: '正式开工入口不可用' };
    if (!require('../hooks/guard-read').protectedRange(S.KIT)) return { ok: false, why: '令牌读取保护没有通过' };
    if (R.text('password=entry-check-fake') .includes('entry-check-fake')) return { ok: false, why: '诊断脱敏没有通过' };
    return { ok: true };
  } catch (e) { return { ok: false, why: '行为自检无法执行' }; }
}
module.exports = { check };

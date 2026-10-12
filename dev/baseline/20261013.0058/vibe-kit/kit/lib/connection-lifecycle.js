'use strict';
/* 自动连接的失效记录只保存名称、来源和原因，不保存地址、账号或口令。原配置移出可执行列表后可重新探索恢复。 */
const fs = require('fs');
const path = require('path');
const store = require('./state-store');
function retire(root, kind, name, source, reason) {
  const file = path.join(root, '.vibe', 'connections-retired.json');
  return store.update(file, (o) => {
    const key = kind + '|' + name;
    const sourceFile = path.resolve(root, String(source || '').replace(/:\d+$/, ''));
    o[key] = { kind, name, source: String(source || ''), status: fs.existsSync(sourceFile) ? 'not-dev-or-removed' : 'source-missing', reason: String(reason || (fs.existsSync(sourceFile) ? '来源连接已不再符合开发环境筛选或已移除' : '来源文件缺失')), at: Date.now() };
    for (const k of Object.keys(o)) if (Date.now() - (o[k].at || 0) > 90 * 86400000) delete o[k];
  });
}
function restored(root, kind, name) {
  const file = path.join(root, '.vibe', 'connections-retired.json');
  if (!fs.existsSync(file)) return {};
  return store.update(file, (o) => { delete o[kind + '|' + name]; });
}
module.exports = { retire, restored };

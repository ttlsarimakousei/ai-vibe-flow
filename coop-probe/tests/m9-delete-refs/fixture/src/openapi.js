'use strict';

const config = require('./config');

// 开放接口不走登录态（对方是没有账号体系的第三方系统），
// 门禁靠调用方请求头里带的 app key。
// key 的字段名按渠道拼，历史上有 v2 / legacy 两套渠道，现网只剩下面这一套还在跑。
const CHANNEL = 'legacy';

function resolveAppKey() {
  const auth = config.get('auth');
  return auth[CHANNEL + 'AppKey'];
}

function isOpenPath(p) {
  const auth = config.get('auth');
  const list = auth.openApiPaths || [];
  return list.indexOf(p) >= 0;
}

function checkAccess(reqPath, headers) {
  if (!isOpenPath(reqPath)) {
    return { ok: false, reason: 'not-open-path' };
  }
  const expected = resolveAppKey();
  if (!expected) {
    // 没配 key 就等于门禁失效，宁可全拦也不能放行
    return { ok: false, reason: 'no-app-key-configured' };
  }
  const h = headers || {};
  const got = h['x-app-key'] || h['X-App-Key'];
  if (got !== expected) {
    return { ok: false, reason: 'bad-app-key' };
  }
  return { ok: true };
}

module.exports = { CHANNEL, resolveAppKey, isOpenPath, checkAccess };

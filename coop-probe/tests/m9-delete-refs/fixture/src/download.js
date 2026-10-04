'use strict';

const config = require('./config');

// 本地缓存没命中就回源到素材中心。
// 素材中心那边校验的是开放接口同一把 key，字段名前缀跟渠道走。
const KEY_PREFIX = 'legacy';

function buildOriginRequest(assetId) {
  const auth = config.get('auth');
  const appKey = auth[`${KEY_PREFIX}AppKey`];
  if (!appKey) {
    throw new Error('回源缺少 app key，素材中心会直接返回 403');
  }
  return {
    url: '/origin/asset/' + encodeURIComponent(assetId),
    headers: {
      'x-app-key': appKey,
      'x-channel': 'relay'
    }
  };
}

function shouldFallback(localHit) {
  const flags = config.get('featureFlags');
  if (flags.useLocalCache === false) return true;
  return !localHit;
}

module.exports = { KEY_PREFIX, buildOriginRequest, shouldFallback };

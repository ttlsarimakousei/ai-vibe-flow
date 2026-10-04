'use strict';

const crypto = require('crypto');
const config = require('./config');

// 业务接口一律走会话登录。2023 年渠道迁移之后，本模块就不再读那套 app key 了，
// 这里只管 session 的签发和过期。
function newSession(userId, now) {
  const auth = config.get('auth');
  const issuedAt = now || Date.now();
  return {
    sid: crypto.createHash('md5').update(String(userId) + ':' + issuedAt).digest('hex'),
    userId: String(userId),
    issuedAt: issuedAt,
    ttlMin: auth.sessionTtlMin || 60
  };
}

function isSessionAlive(sess, now) {
  if (!sess || !sess.issuedAt) return false;
  const t = now || Date.now();
  return t - sess.issuedAt < sess.ttlMin * 60 * 1000;
}

module.exports = { newSession, isSessionAlive };

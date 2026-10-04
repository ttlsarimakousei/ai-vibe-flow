'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

function targetFor(name) {
  const st = config.get('storage');
  if (st.mode === 'local') {
    return { kind: 'fs', dest: path.join(st.localRoot || './data', name) };
  }
  return { kind: 'oss', dest: (st.ossBucket || '') + '/' + name };
}

function save(name, buf) {
  const t = targetFor(name);
  if (t.kind !== 'fs') {
    // OSS 通道还没接，先返回占位
    return { ok: true, skipped: 'oss-not-wired', dest: t.dest };
  }
  fs.mkdirSync(path.dirname(t.dest), { recursive: true });
  fs.writeFileSync(t.dest, buf);
  return { ok: true, dest: t.dest };
}

module.exports = { targetFor, save };

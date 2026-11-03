'use strict';
/* 公共脱敏模块（kit/lib/redact.js）。路由 2026-11-03 删了，HTTP、流式错误、日志这些出口的验证随路由删掉。 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const h = H.makeHome('diagnostic-redaction', process.argv[2]);
const KEY = 'FAKE_ONLY_opaqueKeyNoStandardPrefix_A998812';
const redactor = path.join(h.kit, 'lib/redact.js');
H.ok('公共脱敏模块随包提供', fs.existsSync(redactor));
if (fs.existsSync(redactor)) { const R = require(redactor); H.ok('脱敏先于截断', !R.clip('a'.repeat(230) + KEY, 240, [KEY]).includes(KEY.slice(0, 7))); }
H.done('诊断脱敏');

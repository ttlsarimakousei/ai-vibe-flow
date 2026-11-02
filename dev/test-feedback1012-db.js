'use strict';
/* #61、#63 只补诊断，不伪造真实神通或 Oracle 已修复。匿名汇总不携带语句和数据。SQL 语句本身的错 2026-11-02 起不上报（用户定的）。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
const h = H.makeHome('feedback1012-db', process.argv[3]);
const S = require(path.join(h.kit, 'lib/session')); const T = require(path.join(h.kit, 'lib/toolstats')); const F = require(path.join(h.kit, 'lib/feedback'));
const errs = {};
for (const [dialect, code] of [['oscar', 'SQL_ERROR:42S22'], ['oracle', 'SQL_ERROR:42000:904'], ['mysql', 'SQL_ERROR:42000:904']]) errs[dialect] = { tool: 'ttls-db-crud', dialect, code, n: 2, cmds: { query: 2 } };
S.writeState('tool-stats', { errs, errsSince: Date.now() - 90000000 });
const ids = T.reportErrors(); const records = F.listRecords().filter((r) => ids.includes(r.meta.id));
H.ok('SQL 语句本身的错（42S22、904）不再上报', records.length === 0, records.map((r) => r.title));
if (process.argv[2] === 'auto') {
  const rt = H.runtime('auto');
  const db = path.join(h.cfg, 'skills/ttls-db-crud/scripts/db.py');
  const script = path.join(h.root, 'diagnostic.py');
  H.write(script, 'import sys, importlib.util\nsys.path.insert(0, ' + JSON.stringify(path.dirname(db)) + ')\nspec=importlib.util.spec_from_file_location("db", ' + JSON.stringify(db) + ')\ndb=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(db)\ndb.die({"code":"SQL_ERROR","sql_state":"42000","vendor_code":904,"error":"invalid identifier"},{"dialect":"oracle"})\n');
  const r = H.run(h, rt.python, [script]);
  H.ok('数据库 CLI 现场失败也给可执行刷新结构提示', r.code === 0 && /columns --fresh/.test(r.err), r);
}
H.done('1012 数据库诊断');

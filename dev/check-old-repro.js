'use strict';
/*
 * 确认"修之前确实有这个毛病"：拿上一版（解压出来的旧包）跑同样的输入。
 * 用法：node dev/check-old-repro.js <旧包解压出来的 vibe-kit 目录>
 */
const path = require('path');
const H = require('./lib/harness');
const old = process.argv[2];
if (!old) { console.log('用法：node dev/check-old-repro.js <旧包的 vibe-kit 目录>'); process.exit(2); }
const h = H.makeHome('oldrepro', old);
const S = require(path.join(h.kit, 'lib', 'session.js'));
const v42 = '`node .vibe/run42.js`（串跑 /see-page 两场景，两个 RESULT ok）';
H.ok('旧版：跑过 run42.js 仍然判成没跑过（毛病能复现）', S.verifyRan(v42, ['node .vibe/run42.js']) === false);
const proj = H.makeRepo(path.join(h.work, 'p'), { 'pom.xml': '<project/>', 'src/main/java/A.java': 'class A {}\n' });
const chg = path.join(proj, 'openspec', 'changes', 'gate');
const tfile = H.transcript(path.join(h.root, 't.jsonl'), [H.tr.user('做 gate')]);
const r = H.hook(h, 'guard-spec', { session_id: 's', transcript_path: tfile, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(chg, 'tasks.md'), content: '- [ ] 1.1 写预检脚本：新建 deploy/sql/gate_precheck.sql；验：人工看\n- [ ] 1.2 执行 deploy/sql/gate_precheck.sql 之后改 src/main/java/A.java；验：node q.js 输出 0 行\n' } });
H.ok('旧版：上一行声明过新建的文件、验法里的脚本都被拦（毛病能复现）', r && /gate_precheck\.sql 在项目里找不到/.test(H.reasonOf(r)) && /q\.js 在项目里找不到/.test(H.reasonOf(r)), H.reasonOf(r));
H.done('旧版复现');

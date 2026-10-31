'use strict';
/*
 * 11-01 这一批（docs/feedback-20261101.md）主会话做的几项，一项一节：
 *   H4（审核 P15）openspec 命令改写认引号、认命令开头
 *   别的节见各节标题；拿 20261031.1436 跑每节至少一项不过
 * 用法：node dev/test-k-batch.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;

(async () => {
  H.section('H4 openspec 命令改写：引号里的不动；FOO=1、timeout、& 调用符、bash -lc、cmd /c、PowerShell 的 { } 里的都认');
  {
    const h = H.makeHome('tkb-h4', FROM, {}, { openspec: true });
    const O = require(path.join(h.kit, 'lib', 'openspec.js'));
    const B = O.BIN.replace(/\\/g, '/');
    const call = 'node "' + B + '"';
    const callPs = 'node "' + O.BIN + '"';
    const cases = [
      ['openspec list', false, call + ' list'],
      ['cd a && openspec status --change x', false, 'cd a && ' + call + ' status --change x'],
      ['echo "a; openspec x"', false, null],
      ['FOO=1 openspec list', false, 'FOO=1 ' + call + ' list'],
      ['timeout 60 openspec validate x', false, 'timeout 60 ' + call + ' validate x'],
      ['& openspec list', true, '& ' + callPs + ' list'],
      ['bash -lc "openspec list"', false, 'bash -lc "node \\"' + B + '\\" list"'],
      ['cmd /c openspec list', false, 'cmd /c ' + call + ' list'],
      ['if ($?) { openspec list }', true, 'if ($?) { ' + callPs + ' list }'],
      ['git commit -m "docs: openspec 说明"', false, null],
      ['ls openspec/changes', false, null],
    ];
    for (const [c, ps, want] of cases) { const got = O.rewrite(c, ps); H.ok((ps ? 'PowerShell：' : 'Bash：') + c + ' → ' + (want === null ? '不改' : '改写'), got === want, { got, want }); }
  }

  H.done('11-01 这一批（主会话）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

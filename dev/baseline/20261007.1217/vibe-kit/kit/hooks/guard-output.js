'use strict';
/*
 * PreToolUse 钩子（Write，由改文件的总入口 pre-edit 调用）：代码之外的产出（DDL 脚本、说明文档、分析报告、表格……）
 * 放哪要先跟用户定好。新建这类文件、而位置没确认过（项目说明的"产出位置"里没有，用户这次也没说过）就拦下：
 *   普通模式：先用提问框问用户放哪，定了记进项目说明，再写；
 *   全自动模式：用户不在，不问也不自己挑，先放到 .vibe/pending/，最后交代时列进"等你回来定的事"
 *   （项目里现成的同类目录——同一目录里已经有两个以上同类文件——直接用）。
 * 判断细节见 lib/outputs.js。开关 outputGate（配置页"代码之外的产出先定好放哪"），默认开。
 */
const path = require('path');
const { readConfig, readConfigFor, blockOut, hookLog, cli } = require('../lib/session');
const { outputCheck } = require('../lib/outputs');

function handle(j) {
  const cfg = readConfigFor(j);
  if (cfg.outputGate === false) return null;
  const r = outputCheck(j, cfg);
  if (!r) return null;
  const show = (p) => { const rel = path.relative(r.cwd, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p; };
  hookLog('guard-output block ' + (r.auto ? 'auto ' : '') + r.file);
  if (r.auto) {
    return blockOut('PreToolUse', '[vibe-kit 产出位置] 全自动模式：要新建的 ' + show(r.file) + ' 是一份' + r.type + '，不是代码，放哪还没跟用户定过。不要问，也不要自己挑地方：先写到 '
      + show(r.pending) + '（位置待定，.vibe 不进仓库），在最后交代的"等你回来定的事"里列出来；用户定了位置再挪过去，记进项目说明的"产出位置"。');
  }
  return blockOut('PreToolUse', '[vibe-kit 产出位置] 要新建的 ' + show(r.file) + ' 是一份' + r.type + '，不是代码。这类产出放哪还没跟用户定过：项目说明的"产出位置"里没有，用户这次也没说过。\n'
    + '先定位置再写：用提问框问用户放哪，选项写实际的目录（第一个放你推荐的，比如项目里已有的同类目录）；用户选定后，把它记进 ' + show(r.projectMd)
    + ' 的"产出位置"一节（没有这个文件就新建；一类一行，例：`- DDL 脚本：sql/ddl/`），然后写到那里。以后同类产出照着放，不用再问。');
}

module.exports = { handle };
if (require.main === module) cli(handle);

'use strict';
/*
 * PreToolUse 钩子（Write，由改文件的总入口 pre-edit 调用）：代码之外的产出（DDL 脚本、说明文档、分析报告、表格……）
 * 放哪要先跟用户定好。新建这类文件、而位置没确认过（项目说明的"产出位置"里没有，用户这次也没说过）就拦下：
 *   普通模式：先用提问框问用户放哪，定了记进项目说明，再写；
 *   全自动模式：用户不在，不问也不自己挑，先放到 .vibe/pending/，最后交代时列进"等你回来定的事"
 *   （项目里现成的同类目录——同一目录里已经有两个以上同类文件——直接用）。
 * 判断细节见 lib/outputs.js。固定检查，不做开关（用户 2026-10-17 定的；以前的开关 outputGate 不再认）。
 */
const path = require('path');
const { readConfig, readConfigFor, blockOut, hookLog, cli } = require('../lib/session');
const { outputCheck } = require('../lib/outputs');

function handle(j) {
  const cfg = readConfigFor(j);
  // 固定检查，不做开关（用户 2026-10-17 定的：代码之外的产出放哪，默认就要问用户）
  const r = outputCheck(j, cfg);
  if (!r) return null;
  const show = (p) => { const rel = path.relative(r.cwd, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p; };
  hookLog('guard-output block ' + (r.auto ? 'auto ' : '') + r.file);
  if (r.auto) {
    return blockOut('PreToolUse', '[vibe-kit 产出位置] 全自动模式：要新建的 ' + show(r.file) + ' 是一份' + r.type + '，不是代码，放哪还没跟用户定过。不要问，也不要自己挑地方：先写到 '
      + show(r.pending) + '（位置待定，.vibe 不进仓库），在最后交代的"等你回来定的事"里列出来；用户定了位置再挪过去，记进项目说明的"产出位置"。');
  }
  // 选项要写成目录（例：子项目根目录写 jssslt-oa/），"子项目根目录""仓库根目录"这种说法认不出是哪个目录（#196）
  const dir = (() => { const d = show(path.dirname(r.file)).replace(/\\/g, '/'); return d === '.' || !d ? './' : d.replace(/\/?$/, '/'); })();
  const how = '用提问框问用户放哪，选项写实际的目录（例：`' + dir + '`；第一个放你推荐的，比如项目里已有的同类目录），不写"子项目根目录""仓库根目录"这种说法；用户选定后，把它记进 ' + show(r.projectMd)
    + ' 的"产出位置"一节（没有这个文件就新建；一类一行，例：`- DDL 脚本：sql/ddl/`），然后写到那里。以后同类产出照着放，不用再问。';
  // 两种情况第一行一样（#225）：放行按拦截话的第一行认是不是同一条规矩，以前两种话第一行不同，为第一种申请的放行对第二种不算
  const first = '[vibe-kit 产出位置] 要新建的 ' + show(r.file) + ' 是一份' + r.type + '，不是代码，放哪还没跟用户定过。\n';
  if (r.selfAdded) {
    return blockOut('PreToolUse', first + '项目说明里现在有这个位置，但它是这个会话里自己加的，不算定过：这个会话里没用提问框问过用户放哪（防止自己给自己定位置）。别再改项目说明的写法：\n' + how);
  }
  return blockOut('PreToolUse', first + '项目说明的"产出位置"里没有，用户这次也没说过。先定位置再写：' + how);
}

module.exports = { handle };
if (require.main === module) cli(handle);

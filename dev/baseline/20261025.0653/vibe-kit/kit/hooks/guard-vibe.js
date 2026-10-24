'use strict';
/*
 * PreToolUse 钩子（Write，由改文件的总入口 pre-edit 调用）：过程文件放 .vibe，不放进项目。
 *   - .vibe/ 里只放套件长期要用的东西，临时脚本、草稿放 .vibe/tmp/<事由>/，一件事一个目录（事由是变更名的留到归档，别的做完就删）；往 .vibe 里别的地方新建文件就拦
 *   - 往项目里（.vibe 以外）新建备份、日志、临时文件（A.java.bak、build.log、"A - 副本.java"、backup/ 里的这类）也拦，让它放 .vibe/tmp/<事由>/；
 *     拦错了原样再写一次就放行（同一个文件只拦一次）
 * 判断细节见 lib/tidy.js。固定检查，不做开关（用户 2026-10-17 定的；以前的开关 vibeTidy 不再认），原来默认开。
 */
const { readConfig, readConfigFor, blockOut, hookLog, cli } = require('../lib/session');
const { vibeCheck, processCheck } = require('../lib/tidy');

function handle(j) {
  const cfg = readConfigFor(j);
  const reason = vibeCheck(j) || processCheck(j);
  if (!reason) return null;
  hookLog('guard-vibe block ' + String((j.tool_input && j.tool_input.file_path) || ''));
  return blockOut('PreToolUse', reason);
}

module.exports = { handle };
if (require.main === module) cli(handle);

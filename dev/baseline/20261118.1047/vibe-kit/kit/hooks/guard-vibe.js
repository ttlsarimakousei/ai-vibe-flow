'use strict';
/*
 * PreToolUse 钩子（Write，由改文件的总入口 pre-edit 调用）：过程文件放 .vibe，不放进项目。
 *   - .vibe/ 里只放套件长期要用的东西，临时脚本、草稿放 .vibe/tmp/<事由>/，一件事一个目录（事由是变更名的留到归档，别的做完就删）；往 .vibe 里别的地方新建文件就拦
 *   - 往项目里（.vibe 以外）新建备份、日志、临时文件（A.java.bak、build.log、"A - 副本.java"、backup/ 里的这类）也拦，让它放 .vibe/tmp/<事由>/；
 *     拦错了原样再写一次就放行（同一个文件只拦一次）
 *   - 往 .vibe/tmp/ 里新建测试账号文件、登录场景：tmp 会被清，拦一次，让它写进 .vibe/login.json、.vibe/scenarios/（第 75 条）；原样再写一次放行
 * 判断细节见 lib/tidy.js。固定检查，不做开关（用户 2026-10-17 定的；以前的开关 vibeTidy 不再认），原来默认开。
 */
const { blockOut, hookLog, cli } = require('../lib/session');
const T = require('../lib/tidy');
const { vibeCheck, processCheck } = T;

// 固定检查，不看开关：以前开头读一遍配置（连同会话记录）没用上，白花时间（审核 P42）
// keepCheck（第 75 条）：账号、登录场景写进 .vibe/tmp/ 会被清，拦一次指到 login.json、scenarios/。老版本的 tidy 没有它（自动更新时新旧混着）就不查
function handle(j) {
  const reason = vibeCheck(j) || (T.keepCheck ? T.keepCheck(j) : null) || processCheck(j);
  if (!reason) return null;
  hookLog('guard-vibe block ' + String((j.tool_input && j.tool_input.file_path) || ''));
  return blockOut('PreToolUse', reason);
}

module.exports = { handle };
if (require.main === module) cli(handle);

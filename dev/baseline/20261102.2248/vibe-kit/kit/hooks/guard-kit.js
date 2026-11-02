'use strict';
/*
 * PreToolUse 钩子（改文件时）：套件自己的文件不许模型改，也不许用项目设置把钩子关掉。
 * 实际发生过：模型嫌钩子碍事，自己去改 ~/.claude/vibe-kit 里的钩子。套件是用户的，模型只能用不能改。
 * 保护的范围：~/.claude/vibe-kit 整个目录（钩子、规范、配置、状态、路由）、settings.json（钩子登记在这里）、全局 CLAUDE.md、
 * 套件装进去的技能和代理。~/.claude 是目录联接时，真实路径和用户看到的路径都认。项目里的东西（.vibe/、代码、openspec）不在此列。
 * 另外：往任何 .claude/settings*.json（项目级的也算）里写 disableAllHooks，会让所有钩子失效，一律拦（实测 2.1.259）。
 * 经验规则的文件（项目和用户目录的 .claude/rules/ttls-lessons-*.md、.vibe/lessons/）也不许直接改，要通过 tools/lesson.js。
 * 开关：config.json 的 kitLock（默认开）。命令行那一路（rm、Remove-Item、重定向、curl 调路由接口）在 guard-commit.js 里拦。
 */
const path = require('path');
const { readConfig, blockOut, isKitPath, isClaudeSettingsFile, hookLog, cli } = require('../lib/session');
let lessons = null;
try { lessons = require('../lib/lessons.js'); } catch (e) { /* 老版本没有 */ }

function newText(input) {
  const parts = [input.content, input.new_string];
  if (Array.isArray(input.edits)) input.edits.forEach((e) => parts.push(e && e.new_string));
  return parts.filter((s) => typeof s === 'string').join('\n');
}

function handle(j) {
  if (readConfig().kitLock === false) return null;
  const inp = j.tool_input || {};
  const f = String(inp.file_path || inp.notebook_path || '');
  if (!f) return null;
  if (isClaudeSettingsFile(f) && /disableAllHooks/i.test(newText(inp))) {
    hookLog('guard-kit block disableAllHooks ' + f);
    return blockOut('PreToolUse', '[vibe-kit] 不许写 disableAllHooks：' + f + '\n它会把套件的所有检查（编码保护、提交检查、收工检查）一起关掉。钩子拦错了就把原因告诉用户，由用户在配置页里调整；不要绕过。');
  }
  // 经验规则的文件（.claude/rules/ttls-lessons-*.md、.vibe/lessons/）由 tools/lesson.js 维护：条数上限、合并重复、什么时候升成规则都在它那里
  let isLesson = false;
  try { isLesson = !!lessons && lessons.isLessonFile(path.isAbsolute(f) ? f : path.resolve(j.cwd || process.cwd(), f)); } catch (e) { isLesson = false; }
  if (isLesson) {
    hookLog('guard-kit block lesson file ' + j.tool_name + ' ' + f);
    return blockOut('PreToolUse', '[vibe-kit] 这是经验规则的文件，不要直接改：' + f + '\n记一条、退役一条、查过时的，都用 node "$HOME/.claude/vibe-kit/tools/lesson.js"（help 里有写法）：条数上限、合并重复、什么时候升成规则由它来管。规则的文字不对，用 retire 退掉再重新记；用户级的规则让用户在配置页里改。');
  }
  if (!isKitPath(f, j.cwd)) return null;
  hookLog('guard-kit block ' + j.tool_name + ' ' + f);
  return blockOut('PreToolUse', '[vibe-kit] 这是 vibe-kit 套件在用户目录里的文件，不许改：' + f + '\n钩子、规范、技能、配置、settings.json、全局 CLAUDE.md 只能用户自己改（配置页或手动）。你要是觉得钩子拦错了、规范不合适，把原因和你想改成什么告诉用户，让用户来定；不要绕过，不要用命令行去改。');
}

module.exports = { handle };
if (require.main === module) cli(handle);

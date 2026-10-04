'use strict';
/*
 * PostToolUse 钩子（Read / Grep / Glob）：模型刚读到、搜到某类文件时，补一句"这件事有专门的能力"。
 * 典型情况：装了查数据库的技能，模型却去翻项目里过时的 DDL 文件来回答和写代码——它不知道那些文件过时了。
 * 规则在 config.json 的 hints 里（路由配置页的"套件开关"里填）：files 是路径里出现的词，say 是提醒的话。
 * 只看路径：Read 看读的那个文件，Grep、Glob 看搜出来的文件列表，不看匹配到的内容（@Schema 注解不算 schema）。
 * 同一条规则十分钟内只提醒一次，免得连着读几个文件时刷屏。
 * 没有带 files 的规则时，安装器根本不登记这个钩子。
 */
const { readConfig, matchHints, readState, writeState, cli } = require('../lib/session');

const QUIET_MS = 10 * 60000;

function pathsOf(j) {
  const input = j.tool_input || {};
  const out = [input.file_path, input.path, j.tool_name === 'Glob' ? input.pattern : '', input.glob].filter(Boolean).map(String);
  const r = j.tool_response;
  if (j.tool_name !== 'Read' && r && typeof r === 'object') {
    if (Array.isArray(r.filenames)) out.push(...r.filenames.slice(0, 200).map(String));
    else if (Array.isArray(r.files)) out.push(...r.files.slice(0, 200).map(String));
  }
  return out;
}

function handle(j) {
  const cfg = readConfig();
  if (!Array.isArray(cfg.hints) || !cfg.hints.some((h) => h && h.files)) return null;
  const hits = matchHints(cfg, 'files', pathsOf(j));
  if (!hits.length) return null;
  const key = String(j.session_id || 'unknown') + '-hints';
  const seen = readState(key);
  const now = Date.now();
  const fresh = hits.filter((h) => !(seen[h.name] && now - seen[h.name] < QUIET_MS));
  if (!fresh.length) return null;
  for (const h of fresh) seen[h.name] = now;
  writeState(key, seen);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[vibe-kit 提醒] ' + fresh.map((h) => h.say).join('\n') } };
}

module.exports = { handle };
if (require.main === module) cli(handle);

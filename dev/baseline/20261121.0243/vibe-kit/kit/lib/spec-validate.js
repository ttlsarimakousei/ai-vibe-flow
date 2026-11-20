'use strict';
/*
 * 需求文档写齐了，钩子自己跑 openspec validate <变更> --strict（第 71 条第 1 点，仓库主人 2026-11-09 选的：模型一周自己跑 168 次，每次一个请求）。
 * 什么时候跑：Edit、Write 改成功了变更目录里的 proposal、design、tasks、specs 下的文件，而且 proposal、tasks、至少一份规格都在（写齐了）。
 *   文档内容和这个会话上次跑的一样就不再跑。用套件自带的 OpenSpec（lib/openspec.js），用不了（Node 不够、文件不在）就不跑。
 * 说什么：过了，同一份内容说一句"过了，不用再跑"；没过，把 ERROR 和 WARNING 逐条告诉模型，说改完钩子会再跑。
 * 一次约 1 秒，算在钩子的 12 秒预算里，剩得不够就不跑。出错一律不说话（钩子放行，记问题反馈由调用方做）。
 */
const fs = require('fs');
const path = require('path');
const S = require('./session');

const stateName = (sid) => String(sid) + '-spec-validate';
/** 这次改的是不是一个写齐了的变更的需求文档：是就返回 { dir, name, root } */
function targetOf(j) {
  if (!/^(Edit|Write|MultiEdit)$/.test(String(j.tool_name || ''))) return null;
  const file = String((j.tool_input && (j.tool_input.file_path || j.tool_input.path)) || '');
  const art = file ? S.artifactOf(path.resolve(j.cwd || process.cwd(), file)) : null;
  if (!art || !['proposal', 'design', 'tasks', 'spec'].includes(art.kind)) return null;
  const dir = path.resolve(art.dir);
  const files = S.artifactFiles(dir).filter((f) => !/revisions\.md$/i.test(f));
  const has = (n) => fs.existsSync(path.join(dir, n));
  if (!has('proposal.md') || !has('tasks.md') || !files.some((f) => /[\\/]specs[\\/]/.test(f))) return null;
  return { dir, name: art.name, root: path.resolve(art.root), files };
}
function contentKey(files) {
  const W = require('./workspace');
  return W.hash(files.map((f) => { try { return f + '\n' + fs.readFileSync(f, 'utf8'); } catch (e) { return f; } }).join('\n\0')).slice(0, 24);
}
/** 跑一次，返回要送给模型的话；没话说返回 '' */
function check(j) {
  const t = targetOf(j);
  if (!t) return '';
  const O = require('./openspec');
  if (!O.usable()) return '';
  const I = require('./invocation');
  const key = contentKey(t.files); const dirKey = S.normKey(t.dir);
  const sid = String(j.session_id || '');
  const seen = sid ? (S.readState(stateName(sid))[dirKey] || {}) : {};
  if (seen.key === key) return '';
  I.phase('openspec validate（' + t.name + '）');
  let left = 20000; try { left = I.remaining(20000); } catch (e) { return ''; }
  if (left < 4000) return '';
  const r = O.run(['validate', t.name, '--strict', '--json', '--no-interactive'], t.root, {}, left - 1000);
  let out = null; try { out = JSON.parse(String(r.stdout || '')); } catch (e) { return ''; }
  const item = (out.items || []).find((x) => x && x.id === t.name);
  if (!item) return '';
  if (sid) S.updateState(stateName(sid), (o) => { o[dirKey] = { key, valid: !!item.valid, at: Date.now() }; });
  try { require('./usage').bump('validate.auto'); } catch (e) { /* 数不了不影响 */ }
  const cmd = 'openspec validate ' + t.name + ' --strict';
  if (item.valid) return '[vibe-kit] 钩子跑过 ' + cmd + '：过了。这份内容不用再自己跑 validate。';
  const issues = (item.issues || []).slice(0, 12).map((x) => '- [' + (x.level || '?') + '] ' + (x.path ? x.path + '：' : '') + String(x.message || '').slice(0, 300));
  return '[vibe-kit] 钩子跑了 ' + cmd + '，没过：\n' + issues.join('\n') + ((item.issues || []).length > 12 ? '\n- ……还有 ' + (item.issues.length - 12) + ' 条' : '')
    + '\n照着改（规格里每个 Requirement 要有 SHALL 或 MUST、至少一个 #### Scenario:，增量标题写 ## ADDED/MODIFIED/REMOVED/RENAMED Requirements）。改完钩子会再跑，不用自己跑 validate。';
}
module.exports = { check, targetOf };

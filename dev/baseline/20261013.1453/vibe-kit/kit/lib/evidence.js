'use strict';
/* 执行证据只保存在本机，按仓库、代码与环境指纹复用。命令成功、覆盖范围和仍适用分别判断；失败或运行中不记通过。 */
const fs = require('fs');
const path = require('path');
const W = require('./workspace');
const R = require('./redact');
function environment(root) {
  const S = require('./session');
  let local = ''; try { local = fs.readFileSync(path.join(S.KIT, 'local.json')); } catch (e) { /* 没有本机设置 */ }
  const project = [];
  for (const f of ['db-crud.ini', 'redis.json', 'project.md']) { try { project.push(W.hash(fs.readFileSync(path.join(root || '.', '.vibe', f)))); } catch (e) { project.push('缺少'); } }
  return W.hash(Buffer.concat([Buffer.from(JSON.stringify([process.version, process.env.JAVA_HOME || '', process.env.PATH || '', process.env.VIBE_KIT_TEST_ENV || '', project])), Buffer.from(local)]));
}
function actual(j) {
  let input = j.tool_input || {}; let name = j.tool_name || ''; let root = j.cwd;
  if (/^mcp__.*__(execute_tool|execute_terminal_command|get_file_problems|execute_run_configuration)$/.test(name)) {
    if (!require('./idea-tools').isIdea(name)) return null;
    if (name.endsWith('__execute_tool')) { const r = require('./idea-tools').route(input.command); if (!r) return null; name = r.name; input = Object.assign({}, r.input, input.projectPath ? { projectPath: input.projectPath } : {}); }
    root = input.projectPath; if (!root || !path.isAbsolute(root)) return null;
    if (/execute_run_configuration$/.test(name)) { const r = j.tool_response || {}; if (r.isRunning || !/BUILD SUCCESS|Tests run:|测试.*通过/i.test(JSON.stringify(r))) return null; return { root, command: 'IDEA 运行配置验证 ' + String(input.configurationName || ''), kind: 'test' }; }
    if (/get_file_problems$/.test(name)) return { root, command: 'IDEA 文件检查 ' + String(input.filePath || ''), kind: 'inspection' };
    name = 'Bash';
  }
  if (!/^(Bash|PowerShell)$/.test(name) || !root) return null;
  const command = String(input.command || '');
  // 切目录或从另一个工程运行的命令不猜覆盖范围；IDEA 的明确 projectPath 已在上面处理。
  if (/\b(?:cd|pushd|Set-Location)\b|\bgit\s+-C\b|\b(?:npm|pnpm|yarn)\s+(?:--prefix|--dir|-C)\b|\b(?:mvn|gradle)\s+(?:-f|--file|-p|--project-dir)\b/i.test(command)) return null;
  const response = j.tool_response || {};
  if (response.isRunning || response.is_running || response.background_task_id || response.task_id || response.session_id || /(?:running in (?:the )?background|still running|后台运行|任务已启动)/i.test(JSON.stringify(response))) return null;
  if (!require('./session').VERIFY_CMD.test(command) || /\b(?:echo|printf|write-output|write-host)\s+['"]?(?:测试|Tests|BUILD)/i.test(command)) return null;
  if (/probe-run\.js/.test(command) && !/PAGE_PROBE\s+\{"ok":true[,}]/.test(String(response.stdout || ''))) return null;
  return { root: W.rootOf(root), command, kind: /scenario-run|probe-run|playwright|截图|浏览器/.test(command) ? 'page' : 'test' };
}
function recordTool(j, ok) {
  const S = require('./session'); const a = actual(j); if (!a || !j.tool_use_id) return null;
  const r = j.tool_response || {}; const out = JSON.stringify(r);
  ok = ok && !/\b(?:BUILD FAILURE|[1-9]\d*\s+(?:tests?\s+)?failed|Tests run:[^\n]*Failures:\s*[1-9])\b/i.test(out);
  const fp = W.fingerprint(a.root, 'code'); const env = environment(fp.root); const id = W.hash(j.session_id + '|' + j.tool_use_id);
  let rec;
  S.updateState('evidence', (s) => {
    const rows = s.rows || (s.rows = []); if (rows.some((x) => x.id === id)) return;
    rec = { id, session: j.session_id, root: fp.root, fingerprint: fp.hash, environment: env, command: R.clip(a.command, 2000), kind: a.kind, ok: !!ok, at: Date.now(), durationMs: Math.max(0, Number(j.duration_ms) || 0) };
    rows.push(rec); s.rows = rows.filter((x) => Date.now() - x.at < 14 * 86400000).slice(-300);
  });
  if (rec) { try { require('./usage').bump(rec.ok ? 'evidence.success' : 'evidence.fail'); } catch (e) { /* 本机证据仍然有效 */ } }
  return rec;
}
function current(root, kind) {
  const S = require('./session'); const fp = W.fingerprint(root, 'code'); const env = environment(fp.root);
  return (S.readState('evidence').rows || []).filter((r) => r.ok && r.root.toLowerCase() === fp.root.toLowerCase() && r.fingerprint === fp.hash && r.environment === env && (!kind || r.kind === kind));
}
function commands(root) { return current(root).filter((r) => r.kind !== 'inspection').map((r) => r.command); }
module.exports = { environment, actual, recordTool, current, commands };

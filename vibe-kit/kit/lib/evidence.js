'use strict';
/*
 * 执行证据只保存在本机，按仓库、代码与环境指纹复用。命令成功、覆盖范围和仍适用分别判断；失败或运行中不记通过。
 * 2026-10-30（审核第五节、P35、Codex C04，C 批 C3）：
 *   - 只算命令针对的那个仓库：mvn -f、gradle -p、npm --prefix 这类从参数里认；以前一律算会话所在目录（壳子）的整个指纹，
 *     壳子加几个子项目一条命令要跑几十个 git，指定了子项目的命令反倒不记。
 *   - 版本查询（java -version、node --version）、curl 不记：它们证明不了代码对不对，以前也算"跑过验证"。
 *   - 分类（和手册"快检和自测"那张表一致）：compile（编译、类型、静态检查）、test（测试、不跳过测试的 mvn package/install、名字带 test/spec 的脚本）、
 *     page（页面、接口场景）、other。现在只记下来；快检、修了审查问题的复验照旧认哪一类都行（只认后两类的话，人工模式用户不让测时修了的问题收不了尾）。
 *   - 环境指纹去掉 PATH：命令方式和 HTTP 方式的钩子 PATH 不一样，同一份证据换个方式就对不上。
 *   - 失败的命令不算指纹（本来就不算通过），只数次数。
 */
const fs = require('fs');
const path = require('path');
const W = require('./workspace');
const R = require('./redact');
function environment(root) {
  const S = require('./session');
  let local = ''; try { local = fs.readFileSync(path.join(S.KIT, 'local.json')); } catch (e) { /* 没有本机设置 */ }
  const project = [];
  for (const f of ['db-crud.ini', 'redis.json', 'project.md']) { try { project.push(W.hash(fs.readFileSync(path.join(root || '.', '.vibe', f)))); } catch (e) { project.push('缺少'); } }
  return W.hash(Buffer.concat([Buffer.from(JSON.stringify([process.version, process.env.JAVA_HOME || '', process.env.VIBE_KIT_TEST_ENV || '', project])), Buffer.from(local)]));
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
  // 查库、缓存工具属于查询和运维，不是项目测试；不为这些命令额外遍历整个仓库。
  if (/[\\/]skills[\\/](?:ttls-db-crud|ttls-redis|urai-db-crud|redis)[\\/]/i.test(command)) return null;
  // 切目录、git -C 指到别处的命令不猜覆盖范围；IDEA 的明确 projectPath 已在上面处理。mvn -f、gradle -p、npm --prefix 指到哪个仓库就算哪个，指了几个不同的不记
  if (/\b(?:cd|pushd|Set-Location)\b|\bgit\s+-C\b/i.test(command)) return null;
  // 每个工具只认自己指目录的那几个选项，大小写要对（复审 D-R5：以前不分大小写，mvn -P dev 的 profile 名、mvn -C 后面的 test 被当成目录，算指纹时报错）
  const DIR_OPTS = { mvn: ['-f', '--file'], gradle: ['-p', '--project-dir'], npm: ['--prefix'], pnpm: ['-C', '--dir', '--prefix'], yarn: ['--cwd'] };
  const targets = [];
  for (const m of command.matchAll(/\b(mvnw?|gradlew?|npm|pnpm|yarn)(?:\.cmd|\.bat)?\b([^\n;&|]*)/gi)) {
    const opts = DIR_OPTS[m[1].toLowerCase().replace(/w$/, '')] || [];
    for (const o of m[2].matchAll(/\s(-{1,2}[\w-]+)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) if (opts.includes(o[1])) targets.push(path.resolve(root, o[2].replace(/^["']|["']$/g, '')));
  }
  const uniq = [...new Set(targets)];
  if (uniq.length > 1) return null;
  if (uniq.length) {
    let t = uniq[0];
    try { if (fs.statSync(t).isFile()) t = path.dirname(t); } catch (e) { if (/\.(xml|gradle|kts)$/i.test(t)) t = path.dirname(t); }
    // 指的目录不在：认不出是哪个仓库，不记（以前照样去算指纹，报错记一条问题反馈）
    if (!fs.existsSync(t)) return null;
    root = t;
  }
  const response = j.tool_response || {};
  if (response.isRunning || response.is_running || response.background_task_id || response.task_id || response.session_id || /(?:running in (?:the )?background|still running|后台运行|任务已启动)/i.test(JSON.stringify(response))) return null;
  if (!require('./session').VERIFY_CMD.test(command) || /\b(?:echo|printf|write-output|write-host)\s+['"]?(?:测试|Tests|BUILD)/i.test(command)) return null;
  // 版本查询、curl 探一下：证明不了代码对不对，不记
  if (/^\s*"?(?:[^"\s]*[\\/])?(?:java|javac|node|npm|npx|pnpm|yarn|mvnw?|gradlew?|python3?|py|go|dotnet|tsc|ant|make)(?:\.exe|\.cmd|\.bat)?"?\s+(?:-v|-V|-version|--version|version)\s*$/i.test(command)) return null;
  if (/\bcurl(?:\.exe)?\b/i.test(command) && !require('./session').VERIFY_CMD.test(command.replace(/\bcurl(?:\.exe)?\b[^\n;&|]*/gi, ''))) return null;
  if (/probe-run\.js/.test(command) && !/PAGE_PROBE\s+\{"ok":true[,}]/.test(String(response.stdout || ''))) return null;
  return { root: W.rootOf(root), command, kind: kindOf(command) };
}
/** 证据分类：page 页面、接口场景；test 跑测试；compile 编译、类型、静态检查；other 别的（node 跑个脚本这类） */
function kindOf(command) {
  if (/scenario-run|probe-run|playwright|截图|浏览器/.test(command)) return 'page';
  const skip = /-DskipTests|-Dmaven\.test\.skip=true|\s-x\s+test\b/i.test(command);
  if (/(?<![\w-])test-compile(?![\w-])|\s--check\b|py_compile/i.test(command)) return 'compile';
  if (!skip && /\b(?:mvnw?|gradlew?)(?:\.cmd|\.bat)?\b[^\n;&|]*(?<![\w-])(?:package|install|build|deploy|verify|check|test)(?![\w-])/i.test(command)) return 'test';
  if (!skip && /(?<![\w-])(?:test|tests|pytest|jest|vitest|mocha|karma|cypress)(?![\w-])|\bnpm\s+(?:run\s+)?test|\bgo\s+test\b|\bdotnet\s+test\b|[\w.-]*(?:test|spec|scenario|probe)[\w-]*\.(?:[cm]?[jt]s|py|sh|ps1)\b/i.test(command)) return 'test';
  if (/(?<![\w-])(?:compile|validate|tsc|vue-tsc|javac|eslint|lint|build|package|install|assemble|classes|compileJava|typecheck|type-check)(?![\w-])/i.test(command)) return 'compile';
  return 'other';
}
function recordTool(j, ok) {
  const S = require('./session'); const a = actual(j); if (!a || !j.tool_use_id) return null;
  const r = j.tool_response || {}; const out = JSON.stringify(r);
  ok = ok && !/\b(?:BUILD FAILURE|[1-9]\d*\s+(?:tests?\s+)?failed|Tests run:[^\n]*Failures:\s*[1-9])\b/i.test(out);
  // 失败的不记：本来就不算通过，算指纹（几次 git）白花时间
  if (!ok) { try { require('./usage').bump('evidence.fail'); } catch (e) { /* 数不了就算了 */ } return null; }
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
/** 当前有效的成功命令。kinds 给了只要这几类 */
function commands(root, kinds) { return current(root).filter((r) => r.kind !== 'inspection' && (!kinds || kinds.includes(r.kind))).map((r) => r.command); }
module.exports = { environment, actual, recordTool, current, commands, kindOf };

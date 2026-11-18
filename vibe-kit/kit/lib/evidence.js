'use strict';
/*
 * 执行证据只保存在本机，按仓库、代码与环境指纹复用。命令成功、覆盖范围和仍适用分别判断；失败或运行中不记通过。
 * 2026-10-30（审核第五节、P35、Codex C04，C 批 C3）：
 *   - 只算命令针对的那个仓库：mvn -f、gradle -p、npm --prefix 这类从参数里认；以前一律算会话所在目录（壳子）的整个指纹，
 *     壳子加几个子项目一条命令要跑几十个 git，指定了子项目的命令反倒不记。
 *   - 版本查询（java -version、node --version）、curl 不记：它们证明不了代码对不对，以前也算"跑过验证"。
 *   - 分类（和手册"快检和自测"那张表一致）：compile（编译、类型、静态检查）、test（测试、不跳过测试的 mvn package/install、名字带 test/spec 的脚本）、
 *     page（页面、接口场景）、other。现在只记下来；快检、修了审查问题的复验照旧认哪一类都行（只认后两类的话，人工模式用户不让测时修了的问题收不了尾）。
 *   - 环境指纹去掉 PATH：不同终端的 PATH 不一样，同一份证据换个终端就对不上。
 *   - 失败的命令不算指纹（本来就不算通过），只数次数。
 * 2026-11-02（#260、#275、#276、#279）：python -c、node -e、pip 安装、npm install、mvn dependency:get，还有 grep "java\|node" 这种参数里带工具名的，不算验证。
 *   以前这些都当验证记，每条都算一遍整个仓库的指纹，壳子里预算用完算一次钩子出错，记下来的"证据"也是假的。
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
const VIBE_SCRIPT = /\.vibe[\\/]\S*\.(?:bat|cmd|sh|ps1|js)$/i;
/** 拆开的一段命令（词）：是不是真的在跑构建、测试、脚本 */
function verifyWords(ws, ps, depth) {
  const base = (w) => path.basename(String(w || '').replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat|sh)$/i, '').toLowerCase();
  let k = 0;
  for (let n = 0; n < 12 && k < ws.length; n++) {
    const w = String(ws[k]); const b = base(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === '&' || /^(?:env|cross-env|time|call|winpty)$/.test(b)) k++;
    else if (b === 'timeout') k += 2;
    else if (b === 'cmd' && /^\/c$/i.test(String(ws[k + 1] || ''))) k += 2;
    else break;
  }
  if (VIBE_SCRIPT.test(String(ws[k] || ''))) return true;
  const exe = base(ws[k]); const args = ws.slice(k + 1).map(String);
  if (/^(?:bash|sh|powershell|pwsh)$/.test(exe)) {
    const i = args.findIndex((a) => /^(?:-c|-lc|-command)$/i.test(a));
    if (i >= 0 && args[i + 1] && depth < 2) return runsVerify(args[i + 1], /^(?:powershell|pwsh)$/.test(exe), depth + 1);
    return VIBE_SCRIPT.test(args[0] || '');
  }
  if (/^(?:python3?|py)$/.test(exe)) {
    if (args.includes('-c')) return false;
    const m = args.indexOf('-m');
    return m < 0 || !/^(?:pip\d?|venv|virtualenv|ensurepip|http\.server|json\.tool)$/i.test(args[m + 1] || '');
  }
  if (exe === 'node') return !args.some((a) => /^(?:-e|--eval|-p|--print)$/.test(a));
  if (/^(?:npm|cnpm|pnpm|yarn)$/.test(exe)) return !/^(?:i|install|ci|add|remove|rm|uninstall|un|config|view|ls|list|outdated|cache|root|bin|init|audit|login|logout)$/.test(String(args.find((a) => !a.startsWith('-')) || '').toLowerCase());
  if (/^mvnw?$/.test(exe)) return !(args.some((a) => /^["']?(?:dependency|help|versions):/.test(a)) && !args.some((a) => /^(?:validate|compile|test-compile|test|package|verify|install|deploy|[\w.-]+:(?:run|start|dev))$/.test(a)));
  return /^(?:gradlew?|javac|java|npx|vue-tsc|tsc|eslint|pytest|go|dotnet|make|ant)$/.test(exe);
}
/** 整条命令里有没有一段真的在跑验证。解析不了的算有（和以前一样，宁可多记） */
function runsVerify(command, ps, depth) {
  try {
    const G = require('../hooks/guard-commit');
    return G.splitCommand(G.preprocess(command, ps).s, ps).flat().some((seg) => verifyWords(G.words(G.scanRedirects(seg).rest, ps).map((w) => w.text), ps, depth || 0));
  } catch (e) { return true; }
}
function actual(j) {
  const input = j.tool_input || {}; const name = j.tool_name || ''; let root = j.cwd;
  if (!/^(Bash|PowerShell)$/.test(name) || !root) return null;
  const command = String(input.command || '');
  // 查库、缓存工具属于查询和运维，不是项目测试；不为这些命令额外遍历整个仓库。
  if (/[\\/]skills[\\/](?:vk-db-crud|vk-redis|urai-db-crud|redis)[\\/]/i.test(command)) return null;
  // 切目录、git -C 指到别处的命令不猜覆盖范围。mvn -f、gradle -p、npm --prefix 指到哪个仓库就算哪个，指了几个不同的不记
  if (/\b(?:cd|pushd|Set-Location)\b|\bgit\s+-C\b/i.test(command)) return null;
  // 每个工具只认自己指目录的那几个选项，大小写要对（复审 D-R5：以前不分大小写，mvn -P dev 的 profile 名、mvn -C 后面的 test 被当成目录，算指纹时报错）
  const DIR_OPTS = { mvn: ['-f', '--file'], gradle: ['-p', '--project-dir'], npm: ['--prefix'], pnpm: ['-C', '--dir', '--prefix'], yarn: ['--cwd'] };
  const targets = [];
  for (const m of command.matchAll(/\b(mvnw?|gradlew?|npm|pnpm|yarn)(?:\.cmd|\.bat)?\b([^\n;&|]*)/gi)) {
    const opts = DIR_OPTS[m[1].toLowerCase().replace(/w$/, '')] || [];
    // 选项的值不能以 - 开头：mvn -q -f api/pom.xml 以前把 -f 当成 -q 的值，-f 指的目录认不到，证据记到了壳子名下
    for (const o of m[2].matchAll(/\s(-{1,2}[\w-]+)\s+("[^"]+"|'[^']+'|(?!-)[^\s;&|]+)/g)) if (opts.includes(o[1])) targets.push(path.resolve(root, o[2].replace(/^["']|["']$/g, '')));
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
  if (!runsVerify(command, name === 'PowerShell', 0)) return null;
  // 版本查询、curl 探一下：证明不了代码对不对，不记
  if (/^\s*"?(?:[^"\s]*[\\/])?(?:java|javac|node|npm|npx|pnpm|yarn|mvnw?|gradlew?|python3?|py|go|dotnet|tsc|ant|make)(?:\.exe|\.cmd|\.bat)?"?\s+(?:-v|-V|-version|--version|version)\s*$/i.test(command)) return null;
  if (/\bcurl(?:\.exe)?\b/i.test(command) && !require('./session').VERIFY_CMD.test(command.replace(/\bcurl(?:\.exe)?\b[^\n;&|]*/gi, ''))) return null;
  if (/probe-run\.js/.test(command) && !/PAGE_PROBE\s+\{"ok":true[,}]/.test(String(response.stdout || ''))) return null;
  if (onlyTemp(command, root, name === 'PowerShell')) return null;
  return { root: W.rootOf(root), command, kind: kindOf(command) };
}
/**
 * 命令里点名的文件、目录都在系统临时目录里（#484：在 %TEMP% 下 javac 编一个试验文件，也当成项目的验证证据记，
 * 为它算子项目的指纹，一条 git 要 3 秒的电脑上钩子预算用完）：它证明不了项目的代码，不记。
 * 只看写全了的路径（C:/…、/c/…、/tmp/…，带引号的整段算一个）；工具本身（Program Files 下的、.exe、javac 这类）不算；
 * 在项目目录（root）里面的不算临时目录（项目本身放在临时目录下也一样）。一个都没点的照旧记。
 * 输出去处不算（复审 R1：npm test > /tmp/x.log、| tee /tmp/o.log、--junitxml=/tmp/r.xml、javac -d 临时目录，测的还是项目）：
 * 重定向、tee 的目标、写结果的选项（-d、-o、--output、--junitxml 这类，和所有 --名字=值）先去掉再看
 */
const OUTPUT_PARTS = [
  /\d?>>?\|?\s*("[^"]*"|'[^']*'|[^\s"'|;&<>()]+)/g,
  /&>>?\s*("[^"]*"|'[^']*'|[^\s"'|;&<>()]+)/g,
  /\btee(?:\.exe)?(?:\s+-[a-z]+)*\s+("[^"]*"|'[^']*'|[^\s"'|;&<>()]+)/gi,
  /(?:^|\s)(?:-d|-o|-od|--out(?:put)?(?:-?dir(?:ectory)?)?|--outdir|--junitxml|--reports?-dir|--log-file|--logfile|-Dmaven\.repo\.local)(?:\s+|=)("[^"]*"|'[^']*'|[^\s"'|;&<>()]+)/gi,
  /(?:^|\s)--[\w-]+=("[^"]*"|'[^']*'|[^\s"'|;&<>()]+)/g,
];
function tempPaths(command, root) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\/+$/, '').toLowerCase();
  const temps = [require('os').tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).map(norm);
  const home = root ? norm(path.resolve(root)) : '';
  const isTemp = (p) => !(home && (p === home || p.startsWith(home + '/'))) && (temps.some((t) => p === t || p.startsWith(t + '/')) || /\/appdata\/local\/temp(\/|$)/.test(p) || /^\/tmp(\/|$)/.test(p));
  const tool = (p) => /\/program files( \(x86\))?\//.test(p) || /\.(exe|cmd|bat)$/.test(p) || /\/(javac|java|node|python3?|py|mvnw?|gradlew?|npm|npx|pnpm|yarn|go|dotnet|tsc)$/.test(p);
  let text = String(command);
  for (const re of OUTPUT_PARTS) text = text.replace(re, ' ');
  const found = [];
  for (const m of text.matchAll(/"([A-Za-z]:[\\/][^"]*)"|'([A-Za-z]:[\\/][^']*)'|(?<![\w.:])([A-Za-z]:[\\/][^\s"'|;&<>()]*)|(?<![\w.:/])(\/(?:[a-zA-Z]|tmp)\/[^\s"'|;&<>()]*)/g)) {
    const p = norm(m[1] || m[2] || m[3] || m[4]);
    if (p && !tool(p)) found.push(p);
  }
  return found.length > 0 && found.every(isTemp);
}
/**
 * 按段看（复审 R1：node <临时>/x.js && npm test，后半段测的是项目）：真在跑验证的那几段，每段点名的都在临时目录里才算"只在临时目录"。
 * 拆不开、认不出哪段在验证的，按整条看
 */
function onlyTemp(command, root, ps) {
  let segs = null;
  try {
    const G = require('../hooks/guard-commit');
    segs = G.splitCommand(G.preprocess(command, ps).s, ps).flat().filter((seg) => typeof seg === 'string' && verifyWords(G.words(G.scanRedirects(seg).rest, ps).map((w) => w.text), ps, 0));
  } catch (e) { segs = null; }
  if (!segs || !segs.length) return tempPaths(command, root);
  return segs.every((seg) => tempPaths(seg, root));
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
  // 壳子根跑、没点子项目的：只算这个会话改过文件的那几个子项目，各记一条（同一条命令记一个 cmd，查的时候要几条都还对）；
  // 会话没改过子项目的（只改了壳子的文档、用 Bash 改的）照旧算壳子加全部子项目的整个指纹（复审 R1）
  const targets = shellTargets(j, a.root);
  const fps = targets ? targets.map((t) => W.fingerprint(t, 'code')) : [W.fingerprint(a.root, 'code')];
  const env = environment(a.root);
  const cmd = W.hash(j.session_id + '|' + j.tool_use_id);
  const made = [];
  S.updateState('evidence', (s) => {
    const rows = s.rows || (s.rows = []);
    for (const fp of fps) {
      const id = targets ? W.hash(cmd + '|' + S.normKey(fp.root)) : cmd;
      if (rows.some((x) => x.id === id)) continue;
      const rec = { id, session: j.session_id, root: fp.root, fingerprint: fp.hash, environment: env, command: R.clip(a.command, 2000), kind: a.kind, ok: !!ok, at: Date.now(), durationMs: Math.max(0, Number(j.duration_ms) || 0) };
      if (targets) { rec.cmd = cmd; rec.parts = fps.length; }
      rows.push(rec); made.push(rec);
    }
    s.rows = rows.filter((x) => Date.now() - x.at < 14 * 86400000).slice(-300);
  });
  if (made.length) { try { require('./usage').bump(made[0].ok ? 'evidence.success' : 'evidence.fail'); } catch (e) { /* 本机证据仍然有效 */ } }
  return made[0];
}
/**
 * 在壳子根跑的验证命令记到哪几个仓库（用户 2026-11-17 选的"只算命令点了名的仓库"，#468、#470、#471、#473：
 * 以前算壳子加全部子项目的指纹，五六个子项目、一条 git 一两秒的电脑上钩子 12 秒预算用完）。
 * 这个会话用编辑工具改过文件的子项目。一个子项目都没改过、或者不是壳子，返回 null（照旧算整个指纹）
 */
function shellTargets(j, root) {
  const S = require('./session');
  if (!S.isShell(root)) return null;
  const subs = S.nestedRepos(root).map((r) => path.resolve(r));
  const key = (p) => S.normKey(p);
  const hit = new Set();
  let edited = [];
  try { if (j.transcript_path) edited = require('./edited-files').editedFiles(S.tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain), j.cwd).map((f) => f.abs); } catch (e) { if (e && e.code === 'VIBE_HOOK_BUDGET') throw e; edited = []; }
  for (const f of edited) { const k = key(f); const sub = subs.find((r) => k.startsWith(key(r) + '/')); if (sub) hit.add(sub); }
  return hit.size ? [...hit] : null;
}
/**
 * 这个目录现在还有效的成功证据。目录下面别的仓库名下的也算（#464，2026-11-12）：壳子里 mvn -f 子项目/pom.xml、npm --prefix 子项目 跑的
 * 记在子项目名下，全面自测登记、审查登记处理结果从壳子根查，以前一条都看不到，登记不上（子模块、套了两层的也一样）。
 * 记在哪个仓库名下，就按那个仓库现在的指纹和环境比
 */
function current(root, kind) {
  const S = require('./session');
  const all = (S.readState('evidence').rows || []).filter((r) => r.ok && (!kind || r.kind === kind));
  const rows = all;
  // 壳子：记在壳子名下的（整个指纹）有才算一次整个的（2026-11-17：壳子根跑、改过子项目的分开记在子项目名下，不再每次都算整个）
  const top0 = W.rootOf(root);
  const here0 = rows.filter((r) => r.root.toLowerCase() === top0.toLowerCase());
  const shell = S.isShell(top0);
  const fp = !shell || here0.length ? W.fingerprint(root, 'code') : { root: top0, hash: '' }; const env = environment(fp.root);
  const out = here0.filter((r) => r.fingerprint === fp.hash && r.environment === env);
  const top = S.normKey(fp.root); const below = new Map();
  for (const r of rows) { const k = S.normKey(r.root); if (k.startsWith(top + '/')) below.set(k, (below.get(k) || []).concat(r)); }
  // 最多看最近有证据的 8 个（复审 20261113 R5：每个都要算一次指纹，几条 git；钩子里有预算。壳子的子项目一般就五六个）
  const recent = [...below.values()].sort((a, b) => Math.max(...b.map((r) => Number(r.at) || 0)) - Math.max(...a.map((r) => Number(r.at) || 0))).slice(0, 8);
  for (const mine of recent) {
    // 预算用完照旧抛给钩子的放行入口；别的错（那个仓库没了、读不了）不算它的证据
    let sfp; try { if (!fs.existsSync(mine[0].root)) continue; sfp = W.fingerprint(mine[0].root, 'code'); } catch (e) { if (e && e.code === 'VIBE_HOOK_BUDGET') throw e; continue; }
    const senv = environment(sfp.root);
    out.push(...mine.filter((r) => r.root.toLowerCase() === sfp.root.toLowerCase() && r.fingerprint === sfp.hash && r.environment === senv));
  }
  // 壳子根的一条命令分几个子项目记的（cmd、parts）：几条都还对才算（复审 R1：改了 B，A 那条不能单独顶着）。
  // 只查了 root 下面的：分在别处的那几条（root 是子项目时）不在这里比，按记在这个仓库名下的算
  const valid = new Map(); for (const r of out) if (r.cmd) valid.set(r.cmd, (valid.get(r.cmd) || 0) + 1);
  const underTop = (r) => { const k = S.normKey(r.root); return k === top || k.startsWith(top + '/'); };
  return out.filter((r) => !r.cmd || !shell || valid.get(r.cmd) >= all.filter((x) => x.cmd === r.cmd && underTop(x)).length);
}
/** 当前有效的成功命令。kinds 给了只要这几类 */
function commands(root, kinds) { return current(root).filter((r) => r.kind !== 'inspection' && (!kinds || kinds.includes(r.kind))).map((r) => r.command); }
module.exports = { environment, actual, recordTool, current, commands, kindOf, onlyTemp };

'use strict';
/*
 * 进程、起服务、过程文件、串 cd 的检查（2026-11-01 从 guard-commit 拆出来，K 批）。
 * 规矩写在 hooks/guard-commit.js 开头第 6、7、8、10、11 条。
 */
const fs = require('fs');
const path = require('path');
let tidy = null;
try { tidy = require('./tidy.js'); } catch (e) { /* 老版本没有 */ }
const { flowChanges, sessionHome, allChanges, archivedNames, normKey, KIT, hookLog, cli } = require('./session');
const { preprocess, OPEN, CLOSE, splitCommand, scanRedirects, words, dynamic, dynamicPath, local, baseName, headOf, joinWords, POPD, cdTarget } = require('./shell-words');

// ---------- 起服务要经过 devserver.js ----------
/*
 * 模型起服务自测，常常忘了之前起过、或者上次没关，再起时端口被占，就换个端口又起一个——前端代理、配置里写的还是原来的端口，
 * 测的就不是它改的那一份。所以直接起开发服务器的命令一律拦下，让它走 tools/devserver.js：那里记着起过什么、跑的是不是现在的代码，
 * 端口被占时查清是谁，不会再起一个。固定检查，不做开关（用户 2026-10-17 定的）。
 */
const RUN_SCRIPT = /^(dev|serve|start|preview|server)(:[\w-]+)?$/i;

const SERVER_TOOL = /\b(vite|vue-cli-service\s+serve|webpack(-dev-server|\s+serve)|next\s+(dev|start)|nuxt|react-scripts\s+start|http-server|live-server|nodemon|ng\s+serve|umi\s+dev|max\s+dev|node\s+\S*server\S*|express|koa)\b/i;

/** npm start 不一定是服务（Electron、命令行工具也用它）：看 package.json 里 start 这个脚本是不是开发服务器 */
function startIsServer(dir, script) {
  if (!/^start$/i.test(script)) return true;
  try { const s = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {}).start; return !s || SERVER_TOOL.test(String(s)); } catch (e) { return true; }
}

function serverStart(ws, head, dir) {
  const a = ws.slice(head.i + 1).map((w) => String(w.text));
  const low = a.map((x) => x.toLowerCase());
  const n = head.name;
  if (/^mvnw?$/.test(n) && low.some((x) => /^(spring-boot|tomcat7?|tomcat|jetty|cargo|quarkus):(run|dev|start)$/.test(x))) return 'mvn ' + low.find((x) => /:(run|dev|start)$/.test(x));
  if (/^gradlew?$/.test(n) && low.some((x) => /^(bootrun|apprun|:?[\w-]*:bootrun)$/.test(x))) return 'gradle bootRun';
  if (/^(npm|cnpm|pnpm|yarn)$/.test(n)) {
    // 前面带的全局选项：npm --prefix 目录、pnpm -C 目录 / --dir、yarn --cwd 目录、--filter / -w 这类
    let k = 0;
    let d = dir;
    while (k < a.length && /^-/.test(a[k])) {
      const eq = a[k].match(/^--(prefix|dir|cwd)=(.+)$/i);
      if (eq) { d = path.resolve(dir, local(eq[2])); k++; continue; }
      if (/^(--prefix|-c|--dir|--cwd)$/i.test(a[k]) && a[k + 1]) { d = path.resolve(dir, local(a[k + 1])); k += 2; continue; }
      if (/^(--filter|-f|-w|--workspace)$/i.test(a[k]) && a[k + 1]) { k += 2; continue; }
      k++;
    }
    const aa = a.slice(k);
    const ll = low.slice(k);
    const s = ll[0] === 'run' || ll[0] === 'run-script' ? aa[1] : aa[0];
    if (s && RUN_SCRIPT.test(s) && startIsServer(d, s)) return n + ' ' + (ll[0] === 'run' ? 'run ' : '') + s;
    if ((ll[0] === 'dlx' || ll[0] === 'exec') && /^(vite|vue-cli-service|webpack-dev-server|http-server|live-server|serve)$/.test(ll[1] || '') && !ll.includes('build')) return n + ' ' + ll[0] + ' ' + ll[1];
  }
  if (n === 'npx' && /^(vite|vue-cli-service|webpack-dev-server|http-server|live-server|serve|nodemon)$/.test(low[0] || '') && !low.includes('build')) return 'npx ' + low[0];
  if (/^(vite|webpack-dev-server|http-server|live-server|nodemon)$/.test(n) && !low.includes('build')) return n;
  if (n === 'vue-cli-service' && low[0] === 'serve') return 'vue-cli-service serve';
  if (n === 'webpack' && low[0] === 'serve') return 'webpack serve';
  if (n === 'catalina' && /^(run|start|jpda)$/.test(low[0] || '')) return 'catalina ' + low[0];
  if (n === 'startup') return 'startup';
  if (n === 'java') { const i = low.indexOf('-jar'); const jar = i >= 0 ? (a[i + 1] || '').replace(/\\/g, '/') : ''; if (jar && (/(^|\/)(target|build\/libs)\//i.test(jar) || /\.war$/i.test(jar))) return 'java -jar ' + jar; }
  if (/^(python3?|py)$/.test(n) && ((low[0] === '-m' && /^(http\.server|flask|uvicorn|django)$/.test(low[1] || '')) || (/manage\.py$/.test(low[0] || '') && low[1] === 'runserver'))) return n + ' ' + a.slice(0, 2).join(' ');
  if ((n === 'flask' && low[0] === 'run') || /^(uvicorn|gunicorn)$/.test(n)) return n;
  return '';
}

const serverMsg = (what) => '[vibe-kit 起服务] 起服务自测用 devserver.js，不要直接起（' + what + '）：它先查这个项目的服务是不是已经在跑、跑的是不是现在的代码（改过代码就在同一个端口重启），端口被占时查清是谁占着——不会再起一个，也不会换端口。\n'
  + '  node "' + path.join(KIT, 'tools', 'devserver.js').split(path.sep).join('/') + '" start --name <名字> --port auto --avoid <项目说明里记的端口> -- <你原来的命令>\n'
  + '端口由它在 30000 到 39999 里挑，离项目配置的端口远（用户自己在 IDE 里按配置的端口起的不会撞上）；Spring Boot、Vue CLI、Next、CRA 认环境变量 SERVER_PORT / PORT，命令不用改；Vite、webpack-dev-server 不认，命令写 npm run dev -- --port {port}（{port} 会换成挑到的端口）。起来之后它会说用的是哪个端口，看页面、调接口都用那个。vite 这类会热更新的它自己认得，改了代码不重启（认不出的加 --hot）；换了目录、换了名字也认得之前起过的，不要另起一个；要设环境变量用 --env K=V；服务要在子目录里起的，start 后面加 --cwd <子目录>，不要先 cd。它起好（答了 HTTP）才返回，日志在 .vibe/run/<名字>.log。测完：node "' + path.join(KIT, 'tools', 'devserver.js').split(path.sep).join('/') + '" stop --all';

// ---------- 过程文件别落在项目里（固定，不做开关） ----------
/*
 * cp A.java A.java.bak、cp -r src src_bak、cp A.java backup/、mvn compile > build.log、… | tee build.log、Copy-Item x x.bak 这类命令会在项目里留下过程文件。
 * 目标是过程文件、或者在过程目录里（怎么认见 lib/tidy.js），又在项目里、不在 .vibe 里，就拦下让它放 .vibe/tmp/<事由>/。
 * git add 过程文件也拦（它们不该提交），add 整个目录时看里面有没有没进 git 的过程文件。拦错了原样再执行一次就放行（同一个路径只拦一次）。
 * 返回 { show, key } 或 null
 */
const COPY_MOVE = /^(cp|copy|xcopy|copy-item|cpi|mv|move|move-item|mi|ren|rename|rename-item|rni)$/;

const WRITE_TO = /^(tee|tee-object|out-file|set-content|sc|add-content|ac)$/;

function processTarget(x, head, dir) {
  if (!tidy) return null;
  const bad = (p, asDir) => {
    if (!p || /^(\$null|\/dev\/null|nul)$/i.test(p) || dynamic({ raw: p })) return null;
    return tidy.processPath(path.resolve(dir, local(p)), dir, asDir);
  };
  for (const r of x.redirs) { const b = bad(r.target, false); if (b) return b; }
  if (!head.name) return null;
  const rest = x.ws.slice(head.i + 1);
  const named = (re) => { const i = rest.findIndex((w) => re.test(w.text)); return i >= 0 && rest[i + 1] ? rest[i + 1].text : ''; };
  const positional = rest.filter((w, i) => !w.text.startsWith('-') && !(i > 0 && /^-[A-Za-z]+$/.test(rest[i - 1].text) && !/^-(r|R|f|v|p|n|i|u|a|y|Force|Recurse|Verbose)$/i.test(rest[i - 1].text))).map((w) => w.text);
  if (COPY_MOVE.test(head.name)) {
    const dest = named(/^-(destination|newname)$/i) || (positional.length >= 2 ? positional[positional.length - 1] : '');
    // 目标是已有的目录、或者以 / 结尾：文件会放进这个目录里，目录本身也要看
    let asDir = /[\\/]$/.test(dest);
    try { asDir = asDir || fs.statSync(path.resolve(dir, local(dest))).isDirectory(); } catch (e) { /* 还不存在 */ }
    return bad(dest, asDir);
  }
  if (WRITE_TO.test(head.name)) return bad(named(/^-(filepath|path|literalpath)$/i) || positional[0] || '', false);
  return null;
}

// ---------- 变更没归档之前，它的过程文件先留着（固定，不做开关） ----------
/*
 * 用户 2026-09-30 定的：全自动跑着的时候看到它一路在 rm .vibe 下面的过程文件。流程全部结束之前不要删：
 *   OpenSpec 流程里的过程文件（.vibe/tmp/<变更名>/ 里的脚本、草稿、数据，.vibe/out/ 里以变更名开头的结果）等变更归档之后再删——
 *   归档之前审查、核对、复现问题都可能还要用；归档之后套件自己清（lib/tidy.js 的 cleanTmp）。
 *   别的事由的过程文件，那件事做完就删，不拦。
 *   全自动模式、这个会话在流程里：变更还没建、或者做着的变更还有没归档的，.vibe/tmp、.vibe/out 里的都先留着（流程没走完，分不清哪些还要用）。
 * 只认直接删的命令（rm、rmdir、del、Remove-Item、find … -delete）；挪走（mv）、覆盖不管。返回拦下的话或者 ''
 */
const DELETE_CMD = /^(rm|rmdir|rd|del|erase|remove-item|ri|unlink)$/;

const PS_VALUE_PARAM = /^-(include|exclude|filter|stream|credential)$/i;

function deleteTargets(x, head) {
  const rest = x.ws.slice(head.i + 1);
  if (DELETE_CMD.test(head.name)) {
    const out = [];
    rest.forEach((w, i) => {
      const m = String(w.text).match(/^-(?:path|literalpath):(.+)$/i);
      if (m) { out.push({ raw: m[1], text: m[1] }); return; }
      if (/^-/.test(w.text) || /^\/\/?[A-Za-z]$/.test(w.text)) return;
      if (i > 0 && PS_VALUE_PARAM.test(rest[i - 1].text)) return;
      out.push(w);
    });
    return out;
  }
  if (head.name === 'find' && rest.some((w, i) => w.text === '-delete' || (/^-(exec|execdir|ok|okdir)$/.test(w.text) && rest[i + 1] && DELETE_CMD.test(baseName(rest[i + 1].text))))) {
    const out = [];
    for (const w of rest) { if (/^[-(!]/.test(w.text)) break; out.push(w); }
    return out;
  }
  return [];
}

function keepIssue(x, head, dir, st, cfg) {
  if (!tidy || !head.name) return '';
  const targets = deleteTargets(x, head);
  if (!targets.length) return '';
  const j = st.j || {};
  let active = null;      // 没归档的变更的名字（小写）
  const activeNames = (root) => {
    if (active) return active;
    const names = new Set();
    for (const d of [root, sessionHome(j), st.cwd0]) { try { for (const c of allChanges(d)) names.add(c.name.toLowerCase()); } catch (e) { /* 读不了就当没有 */ } }
    active = [...names];
    return active;
  };
  let done = null;        // 已归档的变更的名字（小写）
  const doneNames = (root) => {
    if (done) return done;
    const names = new Set();
    for (const d of [root, sessionHome(j), st.cwd0]) { try { for (const n of archivedNames(d)) names.add(String(n).toLowerCase()); } catch (e) { /* 读不了就当没有 */ } }
    done = [...names];
    return done;
  };
  // 两边都对得上的（add-x 还在做、add-x-excel 归档了，目录叫 add-x-excel-测试）：哪边对得上的名字更长算哪边的，一样长算没归档的（和 lib/tidy.js 的 cleanTmp 一个算法）
  const ownerOf = (name, root) => { const a = tidy.changeOwner(name, activeNames(root)); if (!a) return ''; return a.length >= tidy.changeOwner(name, doneNames(root)).length ? a : ''; };
  // 全自动、在流程里：做着的变更还有没归档的（变更还没建也算流程没走完）
  let flowOpen = null;
  const openFlow = () => {
    if (flowOpen !== null) return flowOpen;
    flowOpen = '';
    if (cfg.autoMode) { const touched = flowChanges(j); const left = touched.filter((d) => fs.existsSync(d)).map((d) => path.basename(d)); flowOpen = !touched.length ? '变更还没归档' : left.length ? '变更 ' + left.join('、') + ' 还没归档' : ''; }
    return flowOpen;
  };
  for (const w of targets) {
    if (dynamicPath(w)) continue;
    for (const t of [...new Set([w.text, String(w.raw).replace(/^["']|["']$/g, '')])]) {
      // 带通配符的：通配符前面那一截是它要删的东西所在的目录
      const cut = local(t).replace(/[\\/]?[^\\/]*[*?[].*$/, '');
      const abs = path.resolve(dir, cut || '.');
      const v = tidy.vibePart(abs);
      if (!v) continue;
      const segs = v.rel ? v.rel.split('/') : [];
      if (segs.length && !/^(tmp|out)$/i.test(segs[0])) continue;
      const root = path.dirname(v.vibeDir);
      const show = (() => { const r = path.relative(st.cwd0, path.resolve(dir, local(t))); return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : path.resolve(dir, local(t))).split(path.sep).join('/'); })();
      let owner = '';
      let any = false;
      if (segs.length >= 2) { owner = ownerOf(segs[1], root); any = fs.existsSync(path.join(v.vibeDir, segs[0], segs[1])); }
      else {
        // 删的是整个 .vibe、整个 tmp / out，或者用通配符删里面的一批：看里面有没有变更的
        for (const top of segs.length ? [segs[0]] : ['tmp', 'out']) {
          let names = [];
          try { names = fs.readdirSync(path.join(v.vibeDir, top)); } catch (e) { names = []; }
          if (names.length) any = true;
          owner = owner || names.map((n) => ownerOf(n, root)).find(Boolean) || '';
        }
      }
      if (owner) {
        hookLog('guard-commit 过程文件先留着（变更 ' + owner + ' 还没归档）：' + show);
        return '[vibe-kit 过程文件] ' + show + (segs.length >= 2 ? ' 是' : ' 里有') + '变更 ' + owner + ' 的过程文件，变更还没归档，先留着：审查、核对、复现问题都可能还要用。不用你删，归档之后套件自己清。'
          + '要重新生成的直接覆盖；和这个变更无关的过程文件，一个一个点名删（rm <那个目录>）。';
      }
      if (any && openFlow()) {
        hookLog('guard-commit 过程文件先留着（全自动，流程没走完）：' + show);
        return '[vibe-kit 过程文件] 全自动模式：OpenSpec 流程还没走完（' + openFlow() + '），.vibe 里的过程文件先都留着，不要删：' + show + '。变更归档之后套件自己清变更的那些；别的等这一轮流程走完再删。不用处理，接着做下一步。';
      }
    }
  }
  return '';
}

// ---------- cd 和别的命令串在一条里 ----------
/*
 * Bash 里只要 cd 和别的命令串在一条（cd 子项目 && mvn …、cd x; git …、(cd x && …)），Claude Code 就会停下来等人点确认，
 * 开着跳过权限模式（--dangerously-skip-permissions）也照样问。它给模型的 Bash 工具说明里自己写着"优先用绝对路径，
 * 组合命令里的 cd 可能触发权限确认"，内网的模型不照做；壳子结构下子项目的编译、提交、构建又几乎都要进子目录，所以一直在弹
 * （内网 0930：用户在项目的 CLAUDE.md 里加了一句"Bash 里不要用 cd"之后没再弹过）。全自动时没人点，会一直挂着。
 * 当场拦下，按后面跟的是什么命令给出不用 cd 的写法。单独一条 cd（后面没串别的）不拦。只看 Bash，不看开关
 */
const CD_BASH = /^(cd|chdir|pushd)$/;

const READ_CMDS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'ls', 'wc', 'sort', 'uniq', 'cut', 'paste', 'diff', 'stat', 'file', 'nl', 'sed', 'awk', 'jq', 'strings', 'md5sum', 'sha1sum', 'sha256sum']);

const WRITE_CMDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp']);

// 第一个不带 - 的参数是模式或脚本，不是路径（用 -e、-f 给了模式的除外）
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'jq']);

const SCRIPT_RUNNERS = new Set(['node', 'python', 'python3', 'py', 'bash', 'sh', 'java', 'php', 'ruby', 'perl']);

const isAbsArg = (t) => /^[\/\\~$%]/.test(t) || /^[A-Za-z]:/.test(t);

/** 参数看着像路径：带 / 或 \、带扩展名、. ..；别的可能是 -A 3 的 3、要找的词 */
const looksPath = (t) => t === '.' || t === '..' || /[\/\\]/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);

/** 命令里有没有 cd 和别的命令串在一起。返回 { dir: cd 到哪（算不出来是 ''）, same: 就是会话目录, next: 它后面那条命令 { name, args } } */
function cdCompoundIssue(cmd, cwd) {
  const base = path.resolve(cwd || process.cwd());
  const steps = [];
  for (const g of splitCommand(preprocess(cmd, false).s, false, true)) {
    if (g[0] === OPEN || g[0] === CLOSE) continue;
    for (const seg of g) {
      const ws = words(scanRedirects(seg).rest, false);
      const { i, name } = headOf(ws);
      if (name) steps.push({ name, args: ws.slice(i + 1) });
    }
  }
  const at = steps.findIndex((s) => CD_BASH.test(s.name));
  if (at < 0) return null;
  const others = steps.filter((s) => !CD_BASH.test(s.name) && !POPD.test(s.name));
  if (!others.length) return null;      // 只有 cd：不拦
  const t = cdTarget(steps[at].args);
  const dir = t && !t.back && !dynamicPath(t) ? path.resolve(base, local(t.text)) : '';
  const next = steps.slice(at + 1).find((s) => !CD_BASH.test(s.name) && !POPD.test(s.name)) || others[0];
  return { dir, same: !!dir && normKey(dir) === normKey(base), next };
}

const CD_WHY = 'Claude Code 碰到 cd 和别的命令串在一条里，会停下来等人点确认，开着跳过权限模式也照样问，全自动时就一直挂着。';

/** 拦下时说的话：按 cd 后面那条命令是什么，给出不用 cd 的写法 */
function cdCompoundText(hit, cwd) {
  const base = path.resolve(cwd || process.cwd());
  const slash = (p) => String(p).replace(/\\/g, '/');
  if (!hit.dir) return '[vibe-kit] 这条命令里 cd 和别的命令串在一起。' + CD_WHY + '不要 cd：git 用 git -C <目录>，Maven 用 mvn -f <目录>/pom.xml，npm 用 npm --prefix <目录>，别的命令、脚本、文件写完整路径。';
  if (hit.same) return '[vibe-kit] 这条命令 cd 到的就是现在所在的目录（' + slash(hit.dir) + '）。' + CD_WHY + '去掉 cd 和它后面的 &&，别的原样再跑一次。';
  // 目录在会话目录里面的，给相对会话目录的写法；在外面的给完整路径
  const inside = path.relative(base, hit.dir);
  const d = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? slash(inside) : slash(hit.dir);
  // cd 之后写的相对路径，换成不用 cd 也对的路径。它写的路径末尾带 / 的照样带上（path.join 会去掉）
  const at = (rel) => { const abs = slash(path.join(hit.dir, rel)).replace(/\/$/, ''); const head = slash(hit.dir); return (abs.toLowerCase().startsWith(head.toLowerCase() + '/') ? d + abs.slice(head.length) : abs) + (/[\/\\]$/.test(rel) ? '/' : ''); };
  const n = hit.next.name;
  const args = hit.next.args || [];
  const rest = joinWords(args);
  const sp = rest ? ' ' + (rest.length > 160 ? rest.slice(0, 160) + '…' : rest) : '';
  let how = '';
  if (n === 'git') how = 'git 用 -C 指目录，比如 git -C "' + d + '"' + sp;
  else if (/^mvnw?$/.test(n)) how = 'Maven 用 -f 指 pom，比如 ' + (n === 'mvnw' ? '"' + d + '/mvnw"' : 'mvn') + ' -f "' + d + '/pom.xml"' + sp;
  else if (/^gradlew?$/.test(n)) how = 'Gradle 用 -p 指目录，比如 ' + (n === 'gradlew' ? '"' + d + '/gradlew"' : 'gradle') + ' -p "' + d + '"' + sp;
  else if (n === 'npm' || n === 'cnpm') how = n + ' 用 --prefix 指目录，比如 ' + n + ' --prefix "' + d + '"' + sp;
  else if (n === 'pnpm') how = 'pnpm 用 -C 指目录，比如 pnpm -C "' + d + '"' + sp;
  else if (n === 'yarn') how = 'yarn 用 --cwd 指目录，比如 yarn --cwd "' + d + '"' + sp;
  // 起服务的工具：start 用 --cwd 指服务在哪个目录里起（记录留在当前目录，stop、status 不用带参数）；
  // 以前 cd 进去起的服务，记录在那个目录里，stop、status 用 --dir 指过去才找得到
  else if (args.some((w) => /(^|[\/\\])devserver\.js$/i.test(w.text))) how = args.some((w) => w.text === 'start') ? 'devserver.js 用 --cwd 指服务在哪个目录里起：在 start 后面加 --cwd "' + d + '"（之后 stop、status 不用加）' : 'devserver.js 用 --dir 指项目目录：在 stop、status 后面加 --dir "' + d + '"';
  else if (READ_CMDS.has(n) || WRITE_CMDS.has(n)) {
    let first = PATTERN_FIRST.has(n) && !args.some((w) => /^(-e|-f|--regexp|--file)$|^--(regexp|file)=/.test(w.text));
    let rel = '';
    for (const w of args) {
      if (/^-/.test(w.text)) continue;
      if (first) { first = false; continue; }
      if (dynamic(w) || isAbsArg(w.text)) continue;
      if (WRITE_CMDS.has(n) || looksPath(w.text)) { rel = w.text; break; }
    }
    const p = rel ? at(rel) : d;
    how = WRITE_CMDS.has(n) ? '路径直接写全，比如 ' + n + ' … "' + p + '"' : '搜代码用 Grep 工具，path 写 "' + p + '"；读文件用 Read；非用命令行不可就把路径写全，比如 ' + n + ' … "' + p + '"';
  } else if (SCRIPT_RUNNERS.has(n)) {
    const script = args.find((w) => !/^-/.test(w.text) && !dynamic(w) && !isAbsArg(w.text) && looksPath(w.text));
    how = '脚本和文件都写完整路径，比如 "' + (script ? at(script.text) : d + '/<脚本>') + '"';
  }
  return '[vibe-kit] 这条命令先 cd 到 ' + d + '，再跑 ' + n + '。' + CD_WHY + '不要 cd：'
    + (how ? how + '。后面串着的别的命令照同样的办法改。'
      : '这个命令要在那个目录里才能跑的话，cd "' + d + '" 单独跑一条、后面不串别的，下一条再跑它，跑完再单独一条 cd 回 "' + slash(base) + '"。');
}

module.exports = { serverStart, serverMsg, WRITE_TO, processTarget, keepIssue, cdCompoundIssue, cdCompoundText };

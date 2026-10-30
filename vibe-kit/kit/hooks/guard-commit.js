'use strict';
/*
 * PreToolUse 钩子（Bash / PowerShell）：看模型要跑的命令。
 *   1. git push 要用户确认：任何写法（git -C x push、cd x && git push、cmd /c、bash -c、powershell -Command 里的）都检查。
 *      用户说了"推送""push"就直接推（用户 2026-10-25 定的）；合并推送 2026-10-28 取消了（用户定的），"合并推送"也按普通推送走。取消、问句、后台通知不算。
 *      20261030 起 push 只留这一道确认（用户定的）：settings 里的 Bash(git push:*) 确认规则去掉了（它按前缀匹配，git -C sub push 本来就绕得过）。
 *      这一道不看任何开关；钩子走路由时，路由不在由命令钩子 guard-push 兜底，路由里没跑成时带 push 的要确认（lib/hook-host.js）。
 *   2. 提交信息要符合公司规范："类型: 内容"（例：feat: 新增修改页面）。heredoc、here-string、-m"x"、-mx 这些写法都认。
 *   3. 不许把原来就有的改动带进提交：git add -A / --all / . / :/ / -u、git commit -a 一律拦；
 *      仓库下面套着别的 git 仓库（壳子）时，add 子项目目录也拦（会被提交成 gitlink，公司红线）。登记成子模块的不算。
 *      新建的仓库第一次入仓（还没有任何提交、下面没套着别的仓库）整仓 add 不拦。git -C 的目录写在变量里的：
 *      是 for 循环的变量、取值写在命令里，就挨个代进去查；代不出来的不猜是哪个仓库。
 *   4. 归档门槛（开关 specGate）：openspec archive、或者把 openspec/changes/<名字> 挪进 archive，要任务全打勾、代码真的审过，
 *      还要用户自测过、说了归档（会话记录里他最后一句话是"归档"，或者提问框里选了"归档"；用户 2026-10-07 定的。这一条不能放行）。
 *  12. 提交方式（配置页"提交方式"，用户 2026-10-17 定的，人工和自动都用）：关——用户说了"提交"才提交；询问——用户在就交代改动、用提问框问，
 *      自动模式下用户不在就先不提交、记进报告；自动——做完一件完整的事（新勾完任务、审查修复收尾、需求文档定稿）才提交。不能放行。
 *   5. 禁止改套件（开关 kitLock）：命令动到套件的文件、直接调路由的 /api、命令里出现 disableAllHooks，都拦。
 *   6. 装了路由时，不许一把结束所有 node 进程（taskkill /IM node.exe 之类），也不许结束路由自己的进程：路由一停，模型连不上、走 HTTP 的检查全部失效。
 *   7. 起服务自测（mvn spring-boot:run、npm run dev、Tomcat 这类）要经过 tools/devserver.js（固定，不做开关）：同一个服务在跑就不重复起；端口在 30000 到 39999 里挑，离项目配置的端口至少 1000。
 *   8. 过程文件别落在项目里（固定，不做开关）：cp 出来的备份、备份目录、重定向出来的日志这类，放 .vibe/tmp/<事由>/；git add 过程文件也拦。同一个路径只拦一次。
 *      临时查看 JAR、ZIP、TAR、7z 等归档的直接解包命令检查实际目标目录，目录联接也查；不能靠重复执行落到项目根。只读列表和流式读取放行。
 *   9. 提交时它这个会话里新建的文件还没 git add（git 不会自动带上新文件）：点名拦一次，同样的一批只拦一次。
 *      用临时 index 提交的（GIT_INDEX_FILE=…）看那份 index；找不到它就不查。
 *  10. Bash 里 cd 和别的命令串在一条里（cd 子项目 && mvn …）：Claude Code 会停下来要人确认（跳过权限模式也问），拦下并给出不用 cd 的写法
 *      （git -C、mvn -f、npm --prefix、devserver.js --cwd、路径写全）。单独一条 cd 不拦。不看开关。
 *  11. 变更没归档之前，它的过程文件先留着（固定，不做开关）：rm .vibe/tmp/<变更名>/ 这类拦下；全自动模式、在流程里，
 *      .vibe/tmp、.vibe/out 里的都先不删。归档之后套件自己清。
 * 兜底放行（lib/feedback.js）：起服务、过程文件、归档门槛、提交信息格式、新文件没 add 这几类拦下时带〔拦截编号〕，
 *   申请过放行的跳过这一类（按"同一件事"认：归档认变更名，别的认这一类检查）；结束进程、改套件、整仓 add / commit -a / gitlink 不放行。
 * 全自动模式（用户不在）：push、发布不弹确认框（没人点，会一直挂着），直接拦下、记进全自动报告，让它接着做别的。
 * 提交时不再查"像密码的内容"（用户 2026-10-17 定的）；套件自己的令牌文件（secrets.json、router-data）不许提交，那道保护在别处，照留。
 * 命令先按 Bash 或 PowerShell 各自的引号和转义规则拆开：heredoc、here-string 的正文是数据，不当命令拆；注释（# 到行尾）去掉；续行先合并；
 * 按没加引号的 && || ; 换行 分成几组，每组再按 | 分段；cd、Push-Location 会跟着算当前目录。
 * 读不出来的（提交信息在变量里、路径藏在变量里）放行：误拦比漏拦更糟。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const archiveExtract = require('../lib/archive-extract');
const { readConfig, readConfigFor, flowState, setFlow, flowTouch, flowChanges, sessionChanges, userSaid, mentionsChange, sessionHome, allChanges, archivedNames, nestedRepos, blockOut, askOut, changeRoots, readState, writeState, updateState, normKey, KIT, CFG_DIR, realish, isKitPath, isKitSkillScript, expandHome, codeReviewIssue, touchChange, isDeferredTask, syncReviews, syncReviewRounds, reviewLoopIssue, tailEntries, toolCalls, toolResults, hookLog, cli } = require('../lib/session');
let tidy = null;
try { tidy = require('../lib/tidy.js'); } catch (e) { /* 老版本没有 */ }
let feedback = null;
try { feedback = require('../lib/feedback.js'); } catch (e) { /* 老版本没有 */ }
let lessons = null;
try { lessons = require('../lib/lessons.js'); } catch (e) { /* 老版本没有 */ }
let report = null;
try { report = require('../lib/report.js'); } catch (e) { /* 老版本没有 */ }

const TYPES =['feat', 'fix', 'docs', 'style', 'refactor', 'chore', 'release'];
const FORMAT = new RegExp('^(' + TYPES.join('|') + '): {1,2}\\S');

// ---------- 拆命令 ----------
/**
 * 去掉注释（# 到行尾）。引号里的、词中间的 #（a#b、$#、地址里的 #/）不算。
 * 注释不是命令：注释里提到套件的路径、写了 git push，以前会被当成要动套件、要 push（问题反馈 F20260928-012）
 */
function stripComments(s, ps) {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      out += ch;
      if (q === '"' && ((!ps && ch === '\\') || (ps && ch === '`')) && i + 1 < s.length) { out += s[++i]; continue; }
      if (ch === q) q = '';
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    if (((!ps && ch === '\\') || (ps && ch === '`')) && i + 1 < s.length) { out += ch + s[++i]; continue; }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      while (i < s.length && s[i] !== '\n') i++;
      if (i < s.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}
/** heredoc / here-string 的正文单独拿出来（换成 __HD0__ 这样的记号），注释去掉，续行合并 */
function preprocess(cmd, ps) {
  const docs = [];
  let s = String(cmd || '');
  s = s.replace(/<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2([^\n]*)\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\r?\n|$|\))/g, (m, dash, q, tag, rest, body) => { docs.push(body); return '<<__HD' + (docs.length - 1) + '__' + rest; });
  s = s.replace(/@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n\1@/g, (m, q, body) => { docs.push(body); return '__HD' + (docs.length - 1) + '__'; });
  if (s.includes('#')) s = stripComments(s, ps);
  s = ps ? s.replace(/`\r?\n/g, ' ') : s.replace(/\\\r?\n/g, ' ');
  return { s, docs };
}
/**
 * 按没加引号的 && || ; & 换行 切成组，每组再按 | 切成段。
 * ( ) { } 两边也各算一组：PowerShell 的 if ($?) { git push }、try { … }、ForEach-Object { … }，Bash 的 (cd x && git push)、
 * 函数体、$( … ) 里面的命令都要查（模型串命令的标准写法就是 A; if ($?) { B }）。${VAR}、@{…} 哈希表、{} 占位符、
 * x.java{,.bak} 这种贴在词上的花括号不算。
 * marks 为真时，圆括号的开和关各多给一组（OPEN、CLOSE）：括号里的 cd 只在括号里管用，出了括号要回到原来的目录
 */
const OPEN = '\u0001(';
const CLOSE = '\u0001)';
function splitCommand(s, ps, marks) {
  const groups = [];
  let segs = [];
  let cur = '';
  let q = '';
  const braces = [];
  const pushSeg = () => { if (cur.trim()) segs.push(cur.trim()); cur = ''; };
  const pushGroup = () => { pushSeg(); if (segs.length) groups.push(segs); segs = []; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      cur += ch;
      if (q === '"' && ((!ps && ch === '\\') || (ps && ch === '`')) && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === q) { if (ps && q === "'" && s[i + 1] === "'") { cur += s[++i]; continue; } q = ''; }
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (((!ps && ch === '\\') || (ps && ch === '`')) && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === '{') {
      if (s[i + 1] === '}') { cur += '{}'; i++; continue; }
      const prev = i > 0 ? s[i - 1] : ' ';
      if (/[\s);|&%{(=]/.test(prev)) { braces.push('block'); pushGroup(); continue; }
      braces.push('keep'); cur += ch; continue;
    }
    if (ch === '}') { if (braces.pop() === 'block') { pushGroup(); continue; } cur += ch; continue; }
    if (ch === '(' || ch === ')') { pushGroup(); if (marks) groups.push([ch === '(' ? OPEN : CLOSE]); continue; }
    if (ch === '\n' || ch === ';') { pushGroup(); continue; }
    if (ch === '&' && s[i + 1] === '&') { pushGroup(); i++; continue; }
    if (ch === '|' && s[i + 1] === '|') { pushGroup(); i++; continue; }
    if (ch === '|') { pushSeg(); continue; }
    if (ch === '&' && !ps && s[i + 1] !== '>' && s[i - 1] !== '>' && s[i - 1] !== '<') { pushGroup(); continue; }
    cur += ch;
  }
  pushGroup();
  return groups;
}
/** 取出一段里的重定向（写到哪个文件）；2>&1 这种复制文件描述符的不算。返回 { list, rest }，rest 是去掉重定向之后的命令 */
function scanRedirects(seg) {
  const list = [];
  let rest = '';
  let q = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q) { rest += ch; if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") { q = ch; rest += ch; continue; }
    if (ch !== '>') { rest += ch; continue; }
    let fd = '1';
    const prev = seg[i - 1];
    if (prev && /[0-9*&]/.test(prev) && (i < 2 || /\s/.test(seg[i - 2]))) { fd = prev; rest = rest.slice(0, -1); }
    let k = i + 1;
    if (seg[k] === '>') k++;
    if (seg[k] === '&') { k++; while (k < seg.length && /[0-9-]/.test(seg[k])) k++; i = k - 1; rest += ' '; continue; }
    while (k < seg.length && /\s/.test(seg[k])) k++;
    let target = '';
    if (seg[k] === '"' || seg[k] === "'") { const qq = seg[k]; let e = k + 1; while (e < seg.length && seg[e] !== qq) e++; target = seg.slice(k + 1, e); k = e + 1; }
    else { let e = k; while (e < seg.length && !/[\s;&|<>]/.test(seg[e])) e++; target = seg.slice(k, e); k = e; }
    list.push({ fd, target });
    i = k - 1;
    rest += ' ';
  }
  return { list, rest };
}
/** 一段命令拆成词：Bash 里 \ 转义、单引号原样；PowerShell 里 ` 转义、\ 就是 \、'' 表示一个单引号。raw 是原样（判断有没有变量用） */
function words(seg, ps) {
  const out = [];
  let cur = '';
  let raw = '';
  let q = '';
  let has = false;
  const push = () => { if (has) out.push({ raw, text: cur }); cur = ''; raw = ''; has = false; };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q) {
      raw += ch;
      if (q === '"' && !ps && ch === '\\' && i + 1 < seg.length && /["\\$`]/.test(seg[i + 1])) { cur += seg[++i]; raw += seg[i]; continue; }
      if (q === '"' && ps && ch === '`' && i + 1 < seg.length) { cur += seg[++i]; raw += seg[i]; continue; }
      if (ch === q) { if (ps && q === "'" && seg[i + 1] === "'") { cur += "'"; raw += seg[++i]; continue; } q = ''; continue; }
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    has = true;
    raw += ch;
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (!ps && ch === '\\' && i + 1 < seg.length) { cur += seg[++i]; raw += seg[i]; continue; }
    if (ps && ch === '`' && i + 1 < seg.length) { cur += seg[++i]; raw += seg[i]; continue; }
    cur += ch;
  }
  push();
  return out;
}
/** 这个词的值脚本算不出来：带变量、子命令（单引号里的不算） */
const dynamic = (w) => !!w && /\$[({\w]|`/.test(String(w.raw).replace(/'[^']*'/g, ''));
/**
 * 同上，但 $HOME、$env:USERPROFILE、%USERPROFILE%、$CLAUDE_CONFIG_DIR 这几个算得出来的先换掉再看。
 * 约定和技能说明里的路径都写成 "$HOME/.claude/…"：把它们当成算不出来，cd 进去之后当前目录就跟丢了
 */
const dynamicPath = (w) => !!w && /\$[({\w]|`|%\w+%/.test(expandHome(String(w.raw).replace(/'[^']*'/g, '')));
/** Git Bash 的 /c/Users/…、WSL 的 /mnt/c/…、~ 换成 Windows 认的路径 */
function local(p) {
  let s = expandHome(String(p || ''));
  if (process.platform === 'win32') s = s.replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return s;
}
const baseName = (t) => path.basename(String(t || '')).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
// 命令前面可能有的：流程关键字（Bash 的 if/then/else/do…，PowerShell 的 try/foreach…）和只是"包一层"的命令（nohup、env、cross-env…）
const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', '!', 'elseif', 'foreach', 'try', 'catch', 'finally', 'switch', 'trap']);
const WRAPPER = new Set(['nohup', 'time', 'command', 'exec', 'env', 'cross-env', 'winpty', 'stdbuf', 'nice']);
/** 命令名在第几个词：跳过前置的临时环境变量（A=b cmd）、PowerShell 的调用符 & 和点、流程关键字、包装命令（nohup、env、timeout 120、npx cross-env） */
function headOf(ws) {
  let i = 0;
  for (let n = 0; n < 20 && i < ws.length; n++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i].raw)) { i++; continue; }
    if (ws[i].raw === '&' || ws[i].raw === '.') { i++; continue; }
    const name = baseName(ws[i].text);
    // env -C 的目录是参数，不能当成命令名；交给 innerCommand 按临时工作目录检查。
    if (name === 'env' && ws.slice(i + 1).some((w) => /^(?:-C|--chdir)(?:=|$)|^-C.+/.test(w.text))) break;
    if (CONTROL.has(name)) { i++; continue; }
    if (name === 'npx' && ws[i + 1] && baseName(ws[i + 1].text) === 'cross-env') { i += 2; continue; }
    if (WRAPPER.has(name)) { i++; while (i < ws.length && /^-/.test(ws[i].text)) i++; continue; }
    // timeout [选项] <多久> 命令 …（Windows 自己的 timeout /t 5 是"等几秒"，后面没有命令，不受影响）
    if (name === 'timeout' && ws[i + 1] && !/^\//.test(ws[i + 1].text)) {
      let k = i + 1;
      while (k < ws.length && /^-/.test(ws[k].text)) k += /^-(s|k)$/.test(ws[k].text) ? 2 : 1;
      if (k < ws.length && /^\d+(\.\d+)?[smhd]?$/.test(ws[k].text) && ws[k + 1]) { i = k + 1; continue; }
    }
    break;
  }
  return { i, name: i < ws.length ? baseName(ws[i].text) : '' };
}
/** 拆开的词拼回供 Bash 拆词器检查的命令。完整 Windows 路径和空参数也要保留，不能把反斜杠再当成转义吃掉。 */
const joinWords = (list) => list.map((w) => (!w.text || /[\s;&|\\'"]/.test(w.text) ? '"' + w.text.replace(/[\\"]/g, '\\$&') + '"' : w.text)).join(' ');
/** Windows 原生命令中的反斜杠是路径字符。只转换检查用的文本，不改变用户命令；保留原有 &、管道和引号边界。 */
function nativeBackslashes(s) {
  let out = '', q = '';
  for (const ch of s) {
    if (ch === '\\' && q !== "'") { out += '\\\\'; continue; }
    if (ch === q) q = '';
    else if (!q && (ch === '"' || ch === "'")) q = ch;
    out += ch;
  }
  return out;
}
function repoRoot(dir) {
  let d = dir;
  for (let i = 0; i < 12; i++) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return '';
}

// ---------- cd ----------
const CD = /^(cd|chdir|pushd|set-location|sl|push-location)$/;
const PUSHD = /^(pushd|push-location)$/;
const POPD = /^(popd|pop-location)$/;
/** cd 到哪。cd -（回上一个目录）返回 { back: true } */
function cdTarget(args) {
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (/^-(path|literalpath)$/i.test(t)) return args[k + 1] || null;
    const m = t.match(/^-(?:path|literalpath):(.+)$/i);
    if (m) return { raw: m[1], text: m[1] };
    if (t === '-') return { back: true };
    if (/^\/d$/i.test(t) || t.startsWith('-')) continue;
    return args[k];
  }
  return { raw: '~', text: '~' };
}

// ---------- 包在别的东西里的命令 ----------
/*
 * cmd /c（Git Bash 里写 cmd //c）、bash -c、powershell -Command / -EncodedCommand、xargs 后面的命令、
 * PowerShell 的 Start-Process（start、saps）和 cmd 的 start、Invoke-Expression（iex）、call，
 * 还有直接跑的脚本文件（bash x.sh、powershell -File x.ps1、./x.sh、.\x.ps1、x.bat；64KB 以内的读出来一起查）。
 * 从标准输入喂进去的也算：bash <<'EOF' … EOF、powershell -Command @'…'@ 的正文是要执行的命令，不是数据（docs 是 preprocess 拿出来的正文）；eval "…" 同理
 */
const HD = /^(?:<<-?)?__HD(\d+)__$/;
/** 这几个词里有没有 heredoc、here-string 的记号：有就返回它的正文 */
function docOf(list, docs) {
  if (!docs || !docs.length) return null;
  for (const w of list) { const m = HD.exec(String(w.text)); if (m && docs[Number(m[1])] !== undefined) return String(docs[Number(m[1])]); }
  return null;
}
function innerCommand(ws, head, dir, docs) {
  const rest = ws.slice(head.i + 1);
  if (head.name === 'env') {
    let cwd = dir;
    let k = 0;
    for (; k < rest.length; k++) {
      const w = rest[k];
      if (w.text === '--') { k++; break; }
      if (w.text === '-C' || w.text === '--chdir') {
        const next = rest[++k];
        if (!next || dynamicPath(next)) return null;
        cwd = path.resolve(cwd, local(next.text));
      } else if (/^--chdir=|^-C.+/.test(w.text)) {
        const value = w.text.replace(/^--chdir=|^-C/, '');
        if (dynamicPath({ raw: value })) return null;
        cwd = path.resolve(cwd, local(value));
      } else if (w.text === '-u' || w.text === '--unset') {
        if (!rest[++k]) return null;
      } else if (/^(?:-i|--ignore-environment|-u.+|--unset=.+)$/.test(w.text) || /^[A-Za-z_]\w*=/.test(w.text)) {
        continue;
      } else if (w.text.startsWith('-')) return null;
      else break;
    }
    if (k < rest.length) return { cmd: rest.slice(k).map((w) => w.raw).join(' '), ps: false, dir: cwd };
    return null;
  }
  const script = (p, ps) => {
    try {
      const f = path.resolve(dir || process.cwd(), local(p));
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 65536) return null;
      return { cmd: fs.readFileSync(f, 'utf8'), ps: ps === undefined ? /\.ps1$/i.test(f) : ps };
    } catch (e) { return null; }
  };
  // 参数里的 heredoc 记号换回正文（cmd /c、powershell -Command 后面跟着 here-string 的）
  const textOf = (list) => list.map((w) => { const m = HD.exec(String(w.text)); return m && docs && docs[Number(m[1])] !== undefined ? String(docs[Number(m[1])]) : w.text; }).join(' ');
  if (head.name === 'cmd') {
    const k = rest.findIndex((w) => /^\/\/?[ck]$/i.test(w.text));
    if (k >= 0) {
      const body = rest.slice(k + 1);
      // 单个命令字符串先去外层引用；多个参数保留各自引号，避免带空格的程序路径变成几条参数。
      const command = body.length === 1 ? textOf(body) : body.map((w) => HD.test(w.text) ? textOf([w]) : w.raw).join(' ');
      return { cmd: nativeBackslashes(command), ps: false };
    }
  }
  if (['bash', 'sh', 'zsh', 'dash'].includes(head.name)) {
    const k = rest.findIndex((w) => w.text === '-c' || /^-[a-z]*c$/.test(w.text));
    if (k >= 0 && rest[k + 1]) return { cmd: textOf([rest[k + 1]]), ps: false };
    const doc = docOf(rest, docs);
    if (doc !== null) return { cmd: doc, ps: false };
    const f = rest.find((w) => !w.text.startsWith('-'));
    if (f) return script(f.text, false);
  }
  if (head.name === 'powershell' || head.name === 'pwsh') {
    const e = rest.findIndex((w) => /^-(e|ec|encodedcommand)$/i.test(w.text));
    if (e >= 0 && rest[e + 1]) { try { return { cmd: Buffer.from(rest[e + 1].text, 'base64').toString('utf16le'), ps: true }; } catch (err) { return null; } }
    const k = rest.findIndex((w) => /^-(c|command)$/i.test(w.text));
    if (k >= 0) return { cmd: textOf(rest.slice(k + 1)), ps: true };
    const f = rest.findIndex((w) => /^-(f|file)$/i.test(w.text));
    if (f >= 0 && rest[f + 1]) return script(rest[f + 1].text, true);
    const doc = docOf(rest, docs);
    if (doc !== null) return { cmd: doc, ps: true };
  }
  if (head.name === 'eval' && rest.length) return { cmd: textOf(rest), ps: false };
  if (head.name === 'xargs') {
    let k = 0;
    while (k < rest.length) {
      const t = rest[k].text;
      if (t === '--') { k++; break; }
      if (/^-(I|n|P|L|d|E|s|a)$/.test(t)) { k += 2; continue; }
      if (/^-[InPLdEsai].+/.test(t) || /^--[\w-]+(=.*)?$/.test(t) || /^-[0rtpx]+$/.test(t)) { k++; continue; }
      break;
    }
    if (k < rest.length) return { cmd: joinWords(rest.slice(k)), ps: false };
  }
  if (/^(start-process|saps|start)$/.test(head.name)) {
    const named = (re) => { const i = rest.findIndex((w) => re.test(w.text)); return i >= 0 && rest[i + 1] ? { i, v: rest[i + 1].text } : null; };
    const file = named(/^-(filepath|file|f)$/i);
    const argl = named(/^-(argumentlist|args|a)$/i);
    if (file || argl || head.name !== 'start') {
      // PowerShell 的 Start-Process：-FilePath 程序 -ArgumentList a,b（也可以按位置写）
      const pos = rest.filter((w, i) => !w.text.startsWith('-') && !(i > 0 && /^-[A-Za-z]+$/.test(rest[i - 1].text)));
      const prog = file ? file.v : (pos[0] && pos[0].text) || '';
      const args = argl ? argl.v : (pos[1] && pos[1].text) || '';
      const work = named(/^-workingdirectory$/i);
      if (work && dynamicPath({ raw: work.v })) return null;
      const program = joinWords([{ text: prog }]);
      if (prog) return { cmd: [program, nativeBackslashes(String(args).split(',').map((x) => x.trim()).filter(Boolean).join(' '))].join(' '), ps: false, dir: work ? path.resolve(dir, local(work.v)) : dir };
    } else {
      // cmd 的 start [/b /min /wait /d 目录] ["标题"] 命令 …
      let k = 0;
      let cwd = dir;
      if (rest[k] && /^["']/.test(rest[k].raw)) k++;
      while (k < rest.length && /^\/\/?[a-z]+$/i.test(rest[k].text)) {
        if (/^\/\/?d$/i.test(rest[k].text)) {
          if (!rest[k + 1] || dynamicPath(rest[k + 1])) return null;
          cwd = path.resolve(cwd, local(rest[k + 1].text)); k += 2;
        } else k++;
      }
      if (k < rest.length) return { cmd: joinWords(rest.slice(k)), ps: false, dir: cwd };
    }
  }
  if (/^(invoke-expression|iex)$/.test(head.name) && rest.length) return { cmd: textOf(rest), ps: true };
  if (head.name === 'call' && rest[0]) return script(rest[0].text, false) || { cmd: joinWords(rest), ps: false };
  const self = ws[head.i] ? ws[head.i].text : '';
  if (/\.(sh|ps1|bat|cmd)$/i.test(self)) return script(self);
  return null;
}
/*
 * push 的保守兜底：拆命令总有想不到的写法（函数、别名、变量拼命令……）。去掉 heredoc 正文和引号里的内容之后，
 * 只要出现 git [选项] push，就要用户确认——多问一次没有坏处，漏一次就推出去了
 */
const PUSH_WORD = /(^|[^\w.-])git(\.exe)?((\s+(-C|-c|--git-dir|--work-tree|--namespace)\s+\S+)|(\s+--?[\w-]+(=\S+)?))*\s+push(?=$|[\s;&|)}`])/i;
function pushAnywhere(cmd, ps) {
  const { s } = preprocess(cmd, ps);
  // 引号里的换成一个占位词：提交信息里写的"git push"不算，git -C "$d" push 的目录参数还在
  const bare = s.replace(/"(?:[^"\\`]|\\.|`.)*"|'[^']*'/g, ' Q ');
  if (PUSH_WORD.test(bare)) return true;
  // 命令替换照样会执行：bash 的 $(…) 和 `…`，PowerShell 的 $(…)，在双引号里也一样。以前整段引号当成文字，
  // echo "r $(git push)"、x=`git push` 都放行了（审核 P08）；里面再套引号（echo "$(git -C "$d" push)"）也要认（复审 S2）。
  // 按括号配对取出每一段替换的内容，当一条命令再查一遍
  for (const body of substitutions(s, ps)) if (pushAnywhere(body, ps)) return true;
  return false;
}
/** 命令里每一段命令替换的内容：$( … ) 按括号配对（跳过里面引号中的括号），bash 还有成对的反引号 */
function substitutions(s, ps) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] !== '$' || s[i + 1] !== '(') continue;
    let depth = 0; let q = ''; let j = i + 1;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === q) q = ''; else if (!ps && ch === '\\' && q === '"') j++; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    if (depth === 0 && j < s.length) out.push(s.slice(i + 2, j));
  }
  if (!ps) for (const m of s.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  return out;
}
/**
 * 跑套件的发布脚本（安装包里的 publish.js、"发布到 GitLab"那个 bat）：它会把安装包 git push 到团队的仓库，
 * 命令里看不到 push 这个词，所以单独认。和 push 一样，一律要用户确认。
 * 别的项目里恰好也叫 publish.js 的不算：旁边得有 install.js 和 kit/VERSION 才是套件的安装包
 */
function publishAnywhere(cmd, cwd) {
  if (/发布到\s*GitLab[^\r\n|;&]*\.bat/i.test(cmd)) return true;
  if (!/publish\.js/i.test(cmd)) return false;
  const base = path.resolve(cwd || process.cwd());
  const dirs = [base];
  const cd = /(?:^|[\s;&|(])(?:cd|chdir|pushd|set-location|sl|push-location)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/gi;
  let m;
  while ((m = cd.exec(cmd))) { try { dirs.push(path.resolve(dirs[dirs.length - 1], local(m[1] || m[2] || m[3]))); } catch (e) { /* 认不出就跳过 */ } }
  const re = /"([^"]*publish\.js)"|'([^']*publish\.js)'|([^\s"'|;&<>()]*publish\.js)/gi;
  while ((m = re.exec(cmd))) {
    const p = local(m[1] || m[2] || m[3]);
    for (const d of dirs) {
      try { const at = path.dirname(path.resolve(d, p)); if (fs.existsSync(path.join(at, 'install.js')) && fs.existsSync(path.join(at, 'kit', 'VERSION'))) return true; } catch (e) { /* 认不出就不算 */ }
    }
  }
  return false;
}

// ---------- git ----------
/**
 * 返回 { sub, args, dir, dyn }。dyn：-C / --git-dir / --work-tree 给的目录写在变量里（git -C "$r" add …），算不出是哪个仓库，
 * 这时 dir 不可信（议题 #2：以前把 "$r" 当成字面的目录名往上找仓库，找到的是外面那层壳子，说"会提交成 gitlink"）
 */
function parseGit(ws, dir) {
  const h = headOf(ws);
  if (h.name !== 'git') return null;
  let i = h.i + 1;
  let at = dir;
  let gitDir = '';
  let dyn = '';
  const to = (w, text) => { if (dynamicPath(w)) dyn = dyn || String(w.raw); else at = path.resolve(at, local(text)); };
  while (i < ws.length && ws[i].text.startsWith('-')) {
    const t = ws[i].text;
    if (t === '-C' && ws[i + 1]) { to(ws[i + 1], ws[i + 1].text); i += 2; continue; }
    if (/^-C.+/.test(t)) { to(ws[i], t.slice(2)); i++; continue; }
    if (t === '--git-dir' && ws[i + 1]) { if (dynamicPath(ws[i + 1])) dyn = dyn || String(ws[i + 1].raw); else gitDir = ws[i + 1].text; i += 2; continue; }
    if (t.startsWith('--git-dir=')) { if (dynamicPath(ws[i])) dyn = dyn || String(ws[i].raw); else gitDir = t.slice(10); i++; continue; }
    if (t === '--work-tree' && ws[i + 1]) { to(ws[i + 1], ws[i + 1].text); i += 2; continue; }
    if (t.startsWith('--work-tree=')) { to(ws[i], t.slice(12)); i++; continue; }
    if (['-c', '--namespace', '--exec-path', '--super-prefix', '--config-env'].includes(t) && ws[i + 1]) { i += 2; continue; }
    i++;
  }
  if (i >= ws.length) return null;
  if (gitDir) { const g = path.resolve(at, local(gitDir)); at = /\.git$/i.test(g) ? path.dirname(g) : g; }
  return { sub: ws[i].text, args: ws.slice(i + 1), dir: at, dyn };
}
/**
 * for r in a b c; do git -C "$r" … ; done：循环变量的取值写在命令里，挨个代进去就算得出目录。
 * 返回代好的每一份词（ws 的副本）；用到的变量不是循环变量、取值里还有变量的，返回 null
 */
function expandLoopVars(ws, loops) {
  const names = Object.keys(loops || {});
  if (!names.length) return null;
  const used = new Set();
  for (const w of ws) for (const m of String(w.raw).replace(/'[^']*'/g, '').matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)) used.add(m[1]);
  const mine = [...used].filter((n) => names.includes(n));
  if (mine.length !== 1 || [...used].some((n) => !names.includes(n) && !/^(HOME|USERPROFILE|CLAUDE_CONFIG_DIR)$/.test(n))) return null;
  const name = mine[0];
  const src = '\\$\\{' + name + '\\}|\\$' + name + '(?![A-Za-z0-9_])';
  const has = new RegExp(src);
  const all = () => new RegExp(src, 'g');
  return loops[name].slice(0, 40).map((v) => ws.map((w) => (has.test(String(w.raw)) ? { raw: String(w.raw).replace(all(), () => v), text: String(w.text).replace(all(), () => v) } : w)));
}
/** 提交信息的第一行；取不出来、算不出来返回 null */
function messageOf(args, docs) {
  for (const a of args) {
    const t = a.text;
    if (['-F', '--file', '--no-edit', '-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash'].includes(t) || /^--(file|reuse-message|reedit-message|fixup|squash)=/.test(t)) return null;
  }
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    let val = null;
    let src = null;
    if (t.startsWith('--message=')) { val = t.slice(10); src = args[i]; }
    else if (t === '--message' && args[i + 1]) { val = args[i + 1].text; src = args[i + 1]; }
    else if (/^-[A-Za-z]/.test(t) && !t.startsWith('--')) {
      const k = t.indexOf('m', 1);
      if (k > 0) { const rest = t.slice(k + 1); if (rest) { val = rest; src = args[i]; } else if (args[i + 1]) { val = args[i + 1].text; src = args[i + 1]; } }
    }
    if (val === null) continue;
    const hd = String(val).match(/__HD(\d+)__/);
    if (hd) return ((docs[Number(hd[1])] || '').split(/\r?\n/).find((l) => l.trim()) || '').trim();
    if (dynamic(src)) return null;
    return String(val).split(/\\n|\r?\n/)[0].trim();
  }
  return null;
}
/** git commit -a / --all：短选项组里 m 前面有 a（-am、-a），-mawesome 里的 a 是提交信息的一部分，不算 */
function commitAll(args) {
  for (const a of args) {
    const t = a.text;
    if (t === '--all') return true;
    if (/^-[A-Za-z]/.test(t) && !t.startsWith('--')) { const k = t.indexOf('m', 1); if ((k > 0 ? t.slice(1, k) : t.slice(1)).includes('a')) return true; }
  }
  return false;
}
const WHOLE_ADD = (t) => t === '-A' || t === '--all' || t === '--no-ignore-removal' || (/^-[a-zA-Z]+$/.test(t) && t.includes('A')) || ['.', './', '.\\', '*', './*', '.\\*', ':/', ':/*', ':(top)', ':(top).'].includes(t);
const UPDATE_ADD = (t) => t === '-u' || t === '--update' || (/^-[a-zA-Z]+$/.test(t) && t.slice(1).includes('u'));
const SUBJECT = '只 git add 这一轮改的和新建的文件：git add <文件1> <文件2>。';
const FIRST_IMPORT = '新建的仓库第一次入仓（还没有任何提交）不拦，可以整仓 add。';
/** 新建的仓库，还没有任何提交：这时整仓 add 带不进"原来就有的改动"，里面什么都还没提交过（议题 #2：新仓首次入仓只能整仓加） */
function freshRepo(root) {
  if (!root || !fs.existsSync(path.join(root, '.git'))) return false;
  try { execFileSync('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--verify', '-q', 'HEAD'], { timeout: 5000, windowsHide: true, stdio: 'ignore' }); return false; } catch (e) { return !!e && e.status === 1; }
}
function gitIssue(g, docs) {
  if (g.sub === 'add' && g.dyn) {
    // 目录写在变量里，算不出是哪个仓库：不猜（以前往上找到了外面的壳子，说会提交成 gitlink）。整仓 add 照样不许，话说清楚
    if (g.args.some((a) => a.text !== '--' && (UPDATE_ADD(a.text) || WHOLE_ADD(a.text)))) {
      return '[vibe-kit] 这条 git add 的目录写在变量里（' + g.dyn + '），算不出是哪个仓库。git add -A / . / -u 会把那个仓库工作区里原来就有的改动一起加进去。' + SUBJECT
        + '新建的仓库第一次入仓（还没有任何提交）可以整仓 add，目录要写成确定的路径，一个仓库一条：git -C <仓库目录> add -A；'
        + '用循环的话，取值直接写在 for 里（for r in a b c; do git -C "$r" add -A; done）也认得出来。';
    }
    return '';
  }
  if (g.sub === 'add') {
    const root = repoRoot(g.dir) || g.dir;
    const nested = nestedRepos(root);
    const shell = nested.length > 0 || fs.existsSync(path.join(root, 'workspace.yaml'));
    const gitlink = (list) => '[vibe-kit] ' + root + ' 下面套着别的 git 仓库（各个子项目：' + (list.slice(0, 5).map((p) => path.basename(p)).join('、') || '见 workspace.yaml') + '），这样 add 会把它们提交成 gitlink。' + SUBJECT;
    let fresh = null;
    for (const a of g.args) {
      const t = a.text;
      if (t === '--') continue;
      if (!UPDATE_ADD(t) && !WHOLE_ADD(t)) continue;
      if (WHOLE_ADD(t) && shell) return gitlink(nested);
      if (fresh === null) fresh = freshRepo(root);
      if (fresh) { hookLog('guard-commit 新建的仓库第一次入仓（还没有提交），整仓 add 放行：' + root); break; }
      if (UPDATE_ADD(t)) return '[vibe-kit] git add -u 会把你工作区里原来就有的、已跟踪文件的改动一起加进去。' + SUBJECT;
      return '[vibe-kit] git add -A / git add . 会把你工作区里原来就有的改动、没打算提交的新文件一起加进去。' + SUBJECT + FIRST_IMPORT;
    }
    if (nested.length) {
      for (const a of g.args) {
        if (a.text.startsWith('-') || dynamic(a)) continue;
        const p = normKey(path.resolve(g.dir, local(a.text)));
        const hit = nested.filter((r) => normKey(r) === p || normKey(r).startsWith(p + '/'));
        if (hit.length) return gitlink(hit);
      }
    }
  }
  if (g.sub === 'commit') {
    if (commitAll(g.args)) return '[vibe-kit] git commit -a 会把你工作区里原来就有的、已跟踪文件的改动一起提交。先 git add 这一轮改的和新建的文件，再 git commit -m "类型: 内容"。';
    const msg = messageOf(g.args, docs);
    if (msg !== null && !FORMAT.test(msg)) return '[vibe-kit] 提交信息不符合公司规范：' + JSON.stringify(msg) + '\n格式：类型: 内容（类型后面是英文冒号加一个空格，然后直接写内容，只写一行）。\n类型只能是 ' + TYPES.join(' / ') + '。\n例：feat: 新增修改页面';
  }
  return '';
}

// ---------- 归档门槛 ----------
function archiveTarget(ws, head, dir) {
  const k = ws.findIndex((w) => baseName(w.text) === 'openspec');
  if (k >= 0 && ws[k + 1] && ws[k + 1].text === 'archive') {
    for (let n = k + 2; n < ws.length; n++) {
      const t = ws[n].text;
      if (t === '--change' || t === '-c') return ws[n + 1] ? { name: ws[n + 1].text } : null;
      if (t.startsWith('--change=')) return { name: t.slice(9) };
      if (t.startsWith('-')) continue;
      return { name: t };
    }
    return { name: '' };
  }
  let args = null;
  if (['mv', 'move', 'move-item', 'mi', 'rename-item', 'rni', 'ren', 'robocopy'].includes(head.name)) args = ws.slice(head.i + 1);
  const g = parseGit(ws, dir);
  if (g && g.sub === 'mv') { args = g.args; dir = g.dir; }
  if (!args) return null;
  const plain = args.filter((w) => !w.text.startsWith('-') && !/^\/[A-Za-z]{1,2}$/.test(w.text));
  if (plain.length < 2) return null;
  // Windows 路径在 Bash 的规则下反斜杠会被吃掉：原样的写法也试一遍
  const forms = (w) => [...new Set([w.text, String(w.raw).replace(/^["']|["']$/g, '')])];
  for (const s of forms(plain[0])) {
    for (const d of forms(plain[plain.length - 1])) {
      const src = normKey(path.resolve(dir, local(s.replace(/[\\/]+$/, ''))));
      const dst = normKey(path.resolve(dir, local(d)));
      const m = src.match(/^(.*\/openspec\/changes)\/([^/]+)$/);
      if (m && m[2] !== 'archive' && dst.includes('/openspec/changes/archive')) return { name: m[2], changesDir: m[1] };
    }
  }
  return null;
}
/** 归档门槛。过了返回 null；没过返回 { name: 查的是哪个变更, msg } */
function archiveIssue(t, dir, j) {
  // 刚审完（前台审查、或者后台审查的通知刚到）就归档：收工检查还没来得及记，先把会话记录里做完的审查记上
  let es = [];
  let found = [];
  if (j && j.transcript_path) { try { es = tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain); found = syncReviews(es, j.cwd || dir); } catch (e) { /* 记不了就按已有的记录判断 */ } }
  let chDir = '';
  let guessed = false;
  if (t.changesDir) chDir = path.join(t.changesDir, t.name);
  else if (t.name) { for (const root of changeRoots(dir)) { const d = path.join(root, t.name); if (fs.existsSync(d)) { chDir = d; break; } } }
  else {
    // 命令里没写变更名：没归档的变更只有一个时，查的就是它（提示里说明，免得以为查错了人——问题反馈 F20260929-004）
    const active = [];
    for (const root of changeRoots(dir)) try { for (const n of fs.readdirSync(root)) if (n !== 'archive' && fs.statSync(path.join(root, n)).isDirectory()) active.push(path.join(root, n)); } catch (e) { /* 读不了 */ }
    if (active.length === 1) { chDir = active[0]; guessed = true; }
  }
  if (!chDir || !fs.existsSync(chDir)) return null;
  if (j && j.session_id) touchChange(j.session_id, chDir);
  const name = path.basename(chDir);
  const cfg = readConfigFor(j);
  // 归档命令点到的变更：算这个会话在流程里动手做的（收工时照着它往下催、写进报告）
  if (cfg.autoSwitch && flowState(j).on) flowTouch(j, chDir);
  const issues = [];
  let waiting = 0;
  try {
    const open = (fs.readFileSync(path.join(chDir, 'tasks.md'), 'utf8').match(/^\s*[-*]\s*\[ \]\s*.*$/gm) || []);
    waiting = open.filter((l) => isDeferredTask(l)).length;
    if (open.length) issues.push('还有 ' + open.length + ' 项任务没打勾' + (waiting ? '（其中 ' + waiting + ' 项是留给用户做的）' : ''));
  } catch (e) { /* 没有 tasks.md 就不管任务 */ }
  const cr = cfg.autoMode ? codeReviewIssue(chDir) : '';
  if (cr) issues.push(cr);
  else if (cfg.autoMode && cfg.reviewLoop) {
    // 审查之后只在 revisions.md 记了理由（意见都不成立）的算处理完；轮数用完的这次按"问用户 / 全自动自己定"说
    try { syncReviewRounds(es, found); } catch (e) { /* 计不了就按已有的记录判断 */ }
    const lo = reviewLoopIssue('code', chDir, cfg);
    if (lo) issues.push(lo);
  }
  const who = guessed ? '这条命令没写变更名，没归档的变更只有 ' + name + ' 一个，查的是它（要归档的是别的，把名字写上）。' : '';
  if (!issues.length) {
    // 任务都打了勾、代码也审过了：还要用户自测过、说了归档（用户 2026-10-07 定的）。认会话记录里他最后一句话；点了别的变更的名不算
    const said = userSaid(es, 'archive');
    let others = [];
    try { if (said.ok && said.text) others = allChanges(dir).map((c) => c.name).filter((n) => mentionsChange(said.text, n)); } catch (e) { others = []; }
    const wrong = others.length > 0 && !others.some((n) => n.toLowerCase() === name.toLowerCase());
    const permit = said.ok && !wrong ? require('../lib/permissions').allow(j, 'archive', chDir, j.tool_use_id) : { ok: false };
    if (permit.ok) return null;
    const why = wrong ? '我说的是归档 ' + others.join('、') + '，不是它' : permit.reason || '我还没自测、还没说归档';
    // 人工模式归档不要求审查（用户 2026-10-16 定的），审过没有照实说
    const reviewed = cfg.autoMode || !codeReviewIssue(chDir) ? '、代码也审过了' : '，代码没有做过完整审查（人工模式审不审由我决定）';
    return { name, noBypass: true, msg: '[vibe-kit] ' + who + '变更 ' + name + ' 的任务都打了勾' + reviewed + '，但' + why + '。归档要我自测过、我说了才做：先交代做了什么、怎么自测（起服务的命令、要看的页面、要调的接口、要执行的脚本），然后' + (cfg.autoMode ? '收工交报告，写进"留给你做的"：等我自测过说归档。不要再试归档。' : '用提问框问我自测过了没有、能不能归档（选项写"归档"和"还要改"）。我说还要改什么，改完再问；我说归档了再归档。') };
  }
  const tail = !cfg.autoMode ? '确实要放弃这个变更，告诉我，我来删。'
    : waiting ? '留给用户做的任务还没做，这个变更先不归档：写进最后的交代，接着做别的。' : '';
  const order = cfg.autoMode ? '任务全部打勾 → /ttls-cross-review 审代码 → 修掉成立的问题并验证 → 再归档' : '任务全部打勾 → 要不要审查、自测由我决定 → 我说归档再归档';
  return { name, msg: '[vibe-kit] ' + who + '变更 ' + name + ' 还不能归档：' + issues.map((s) => s.replace(/。$/, '')).join('；') + '。顺序是：' + order + '。' + tail };
}

// ---------- 禁止改套件 ----------
const READ_ONLY = new Set(['cat', 'type', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'ls', 'dir', 'get-childitem', 'gci', 'tree', 'grep', 'rg', 'findstr', 'select-string', 'sls', 'find', 'wc', 'stat', 'test-path', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'certutil', 'get-filehash', 'diff', 'fc', 'compare-object', 'echo', 'write-output', 'write-host', 'pwd', 'get-location', 'get-item', 'gi', 'get-itemproperty', 'gp', 'jq', 'sort', 'sort-object', 'uniq', 'select-object', 'select', 'where-object', 'where', 'measure-object', 'measure', 'format-list', 'fl', 'format-table', 'ft', 'out-string', 'convertfrom-json', 'resolve-path', 'split-path', 'join-path', 'realpath', 'readlink', 'dirname', 'basename', 'du', 'od', 'xxd', 'hexdump', 'strings', 'cut', 'column', 'nl', 'sed', 'awk', 'perl']);
// 会改东西的命令名。只看命令名（和 xargs、find -exec 后面跟的命令名），不看别的词：grep "install" 里的 install 是要搜的字，不是要装什么
const DESTRUCTIVE = /^(rm|rmdir|rd|del|erase|remove-item|ri|clear-content|clc|set-content|sc|add-content|ac|out-file|tee|tee-object|cp|copy|copy-item|cpi|xcopy|robocopy|mv|move|move-item|mi|rename-item|rni|ren|new-item|ni|mkdir|md|touch|truncate|chmod|attrib|icacls|takeown|install|ln|mklink|set-itemproperty|sp|clear-item|xargs|unzip|tar|7z|expand-archive|compress-archive|invoke-webrequest|iwr|curl|wget)$/i;
const cleanWord = (t) => String(t || '').replace(/^[{(]+|[})]+$/g, '');
/** 这一段会改东西吗：命令名本身，或者 xargs、find -exec、-execdir 后面跟的命令名 */
function destructiveSeg(x, h) {
  if (DESTRUCTIVE.test(cleanWord(h.name))) return true;
  const ws = x.ws;
  for (let i = h.i + 1; i < ws.length; i++) {
    const t = ws[i].text;
    if ((h.name === 'xargs' || /^-(exec|execdir|ok|okdir)$/.test(t)) && ws[i + 1] && DESTRUCTIVE.test(cleanWord(baseName(ws[i + 1].text)))) return true;
  }
  return false;
}
/** 一个词可能指向的路径：词本身；PowerShell 的 -LiteralPath:xxx 取冒号后面 */
function pathCandidates(w) {
  const out = [w.text];
  const m = String(w.text).match(/^-[A-Za-z]+:(.+)$/);
  if (m) out.push(m[1]);
  if (w.raw !== w.text) out.push(String(w.raw).replace(/^["']|["']$/g, ''));
  return out;
}
/*
 * 令牌和模型的 key 不给模型看：~/.claude/vibe-kit/secrets.json（GitLab 令牌）和 router-data/（模型的 key、它的备份）。
 * 套件别的文件模型可以读（cat、Get-Content…），这两处不行：读出来的内容会进会话记录、发给模型的网关。
 * 列目录（ls、dir）可以；整条命令只是列目录、按名字找、过滤名单的（ls … | head、find … -iname …）也可以。
 * 带通配符、可能碰到这两处的（vibe-kit/*.json、~/.claude/*\/secrets.json），递归搜整个套件目录、
 * ~/.claude、用户目录、整个盘的（grep -r、findstr /s、rg），也拦。
 * Read、Grep 这些工具那一路，靠 settings.json 里的 deny 规则（安装时加的）和 guard-read。
 */
const LISTING = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree', 'stat', 'test-path', 'get-item', 'gi', 'pwd', 'get-location', 'cd', 'chdir', 'push-location', 'pushd', 'set-location', 'sl', 'resolve-path', 'split-path', 'join-path', 'dirname', 'basename', 'realpath', 'echo', 'write-output', 'write-host', 'du']);
const SEARCHES = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls', 'find']);
// 这些命令会把前面传给它的文件的内容读出来（管道里前面是 ls 套件目录、Get-ChildItem -Recurse ~\.claude 的时候）
const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'select-string', 'sls', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'head', 'tail', 'more', 'less', 'xargs', 'foreach-object', 'foreach', '%', 'awk', 'sed', 'perl', 'python', 'python3', 'py', 'node', 'jq', 'strings', 'od', 'xxd', 'hexdump', 'copy-item', 'cpi', 'cp', 'copy', 'compress-archive', 'tar', '7z', 'zip', 'invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr', 'curl', 'wget', 'tee', 'tee-object', 'out-file', 'set-content', 'sc', 'add-content', 'ac', 'import-module', 'source', '.']);
// 只列名字、只过滤名单的命令：整条命令里全是它们，文件的内容就读不出来
const EASY_HEADS = new Set([...LISTING, 'find', 'cat', 'head', 'tail', 'more', 'less', 'grep', 'egrep', 'fgrep', 'sort', 'uniq', 'wc', 'cut', 'column', 'nl', 'tr', 'printf', 'true', 'false', 'test', '[']);
/**
 * 整条 Bash 命令只是列目录、按名字找、过滤名单：ls 套件目录 | head -30、find ~/.claude -maxdepth 1 -iname "*.md" 2>/dev/null。
 * 这种命令里列出来的文件名到不了别的命令的参数里，读出来的只有名单。条件从严，拿不准的都不算（照原来的办法查）：
 *   没有命令替换、没有变量（$HOME 这类写路径用的不算）、没有括号和花括号、没有 heredoc；
 *   每一段的命令都在上面的单子里，前面不带流程关键字（for、while、if）、不带赋值、不包一层（env、nohup）；
 *   find 不带 -exec、-delete、-fprint 这类会对找到的文件做事的开关；没有 --files0-from 这类"从名单里读文件"的开关。
 * 起因（议题 #9 附的流水账）：全自动模式下 ls … | head、find … -iname 这几条只读命令被当成"列了再读""搜套件目录"拦下，
 * 每条都记成了留给用户的事
 */
function easyListing(cmd, ps) {
  if (ps) return false;
  const c = String(cmd || '');
  const bare = c.replace(/\$\{?(HOME|USERPROFILE|PWD)\}?(?![A-Za-z0-9_])/g, '').replace(/\$[?$!#]/g, '');
  if (/[`$(){}]|<<|files0?-from|stdin-paths/.test(bare)) return false;
  try {
    const { s } = preprocess(c, false);
    let n = 0;
    for (const group of splitCommand(s, false)) {
      for (const seg of group) {
        const ws = words(scanRedirects(seg).rest, false);
        if (!ws.length) continue;
        const first = String(ws[0].text).toLowerCase();
        if (CONTROL.has(first) || WRAPPER.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0].raw)) return false;
        const h = headOf(ws);
        if (!h.name || h.i !== 0 || !EASY_HEADS.has(h.name)) return false;
        if (h.name === 'find' && ws.slice(1).some((w) => /^-(exec|execdir|ok|okdir|delete|fls|fprint\w*)$/.test(w.text))) return false;
        n++;
      }
    }
    return n > 0;
  } catch (e) { return false; }
}
/** 两处秘密的位置（按看到的路径和真实路径各算一份，去掉重复） */
function secretRoots() {
  const out = [];
  for (const kit of [...new Set([normKey(KIT), normKey(realish(KIT))])]) out.push({ kit, cfg: kit.replace(/\/[^/]+$/, ''), files: [kit + '/secrets.json', kit + '/router-data'] });
  return out;
}
/** 带通配符的路径（*、?、**）会不会落到这两处：按一段一段比 */
function globHits(absPattern, target) {
  const segs = absPattern.split('/').filter(Boolean);
  const want = target.split('/').filter(Boolean);
  if (segs.some((s) => s === '**')) {
    // ** 匹配任意多段：只看最后一段是不是能对上目标的最后一段，前面的段落在目标的前缀里就行
    const last = segs[segs.length - 1];
    const re = new RegExp('^' + last.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(want[want.length - 1]) || last === '**';
  }
  if (segs.length < want.length) return false;
  for (let i = 0; i < want.length; i++) {
    const re = new RegExp('^' + segs[i].replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$', 'i');
    if (!re.test(want[i])) return false;
  }
  return true;
}
// 列目录的命令里，会把列出来的文件、算出来的路径往后传的那几个（ls 套件目录 | xargs cat、Get-Content (Resolve-Path …)）
const PASSING = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree', 'get-item', 'gi', 'resolve-path', 'join-path', 'realpath', 'echo', 'write-output', 'split-path', 'dirname']);
/**
 * 这个词指向的路径会不会碰到令牌、key。head 是这一段的命令名，recursive 是这一段带不带递归的开关。
 *   读的命令（cat）：指着那两处才算
 *   搜的命令（grep -r）：对着套件目录、~/.claude 搜，或者递归搜它们的上级（用户目录、整个盘），也算
 *   列的命令（ls、Get-ChildItem），后面有人读它列出来的：列套件目录（令牌就在里面）也算；递归列上级也算
 * 会：返回一句为什么；不会：返回 ''
 */
function secretTouch(word, dir, head, recursive) {
  let s = local(String(word || '').replace(/^["']|["']$/g, ''));
  if (!s || /^-/.test(s)) return '';
  const abs0 = path.isAbsolute(s) ? s : path.resolve(dir, s);
  const wild = /[*?[\]]/.test(abs0);
  // 8.3 短名（VIBE-K~1）、目录联接：按真实路径也比一遍。带通配符的算不出真实路径，只比看到的
  const keys = wild ? [normKey(abs0)] : [...new Set([normKey(abs0), normKey(realish(abs0))])];
  const search = SEARCHES.has(head);
  const listing = PASSING.has(head);
  const deep = recursive || ['rg', 'ag', 'find'].includes(head);
  for (const r of secretRoots()) {
    for (const abs of keys) {
      // 带通配符：每一段比，能落到这两处就算
      if (wild) {
        // 通配符前面那一截是确定的目录：递归搜整个用户目录、整个盘（findstr /s "$env:USERPROFILE\*.json"）也算
        const fixed = abs.split('/').filter(Boolean).reduce((acc, seg) => (acc.stop || /[*?[\]]/.test(seg) ? Object.assign(acc, { stop: true }) : Object.assign(acc, { parts: acc.parts.concat(seg) })), { parts: [], stop: false }).parts.join('/');
        if ((search || listing) && deep && fixed && (r.kit === fixed || r.kit.startsWith(fixed + '/'))) return '递归搜 ' + word + ' 会搜到套件放令牌、放模型 key 的文件';
        if (r.files.some((f) => globHits(abs, f))) return word + ' 会落到放令牌、放模型 key 的文件上';
        continue;
      }
      if (r.files.some((f) => abs === f || abs.startsWith(f + '/'))) return word + ' 就是放令牌、放模型 key 的文件';
      // 搜索命令对着套件目录、~/.claude、用户目录、整个盘搜（递归）：会把这两处一起读出来
      if (search && (abs === r.kit || abs === r.cfg || (deep && r.kit.startsWith(abs + '/')))) return '搜 ' + word + ' 会搜到套件放令牌、放模型 key 的文件';
      // 列目录再交给后面的命令读：列的是套件目录（令牌就在里面），或者递归列它的上级
      if (listing && (abs === r.kit || (deep && r.kit.startsWith(abs + '/')))) return '列 ' + word + ' 再读，会读到套件放令牌、放模型 key 的文件';
    }
  }
  return '';
}
/** 这一段带不带递归的开关（grep -r、findstr /s、Get-ChildItem -Recurse、-R） */
const recursiveSeg = (x, h) => x.ws.slice(h.i + 1).some((w) => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive|-recurse|-rec|\/s)$/i.test(w.text));
/** 粗筛：这条命令有没有可能碰到令牌和 key。宁可多算，多算只是多走一遍细查 */
function mayTouchSecret(cmd, cwd) {
  if (/secrets|router-data|vibe-kit|\.claude|\bhome\b|userprofile|~/i.test(cmd)) return true;
  try { const d = normKey(path.resolve(cwd || process.cwd())); const c = normKey(CFG_DIR); return d === c || d.startsWith(c + '/'); } catch (e) { return true; }
}
const SECRET_TEXT = /vibe-kit[\s"'`,+\\/)(]{1,12}(secrets\.json|router-data)/i;
/** 这一段是不是在跑套件自带的工具（page/、tools/ 下的脚本）：它们自己会读令牌（上报问题、检查更新），不往外打印 */
function kitToolRun(x, h, dir) {
  if (h.name !== 'node') return false;
  const arg = x.ws.slice(h.i + 1).map((w) => w.text).find((t) => !t.startsWith('-')) || '';
  if (!arg) return false;
  const script = normKey(path.resolve(dir, local(arg)));
  return /\/(page|tools)\/[^/]+\.js$/i.test(script) && isKitPath(script, dir);
}
/**
 * segs 是用管道连着的一串命令；hasReader 是这整条命令里有没有会把文件内容读出来的命令
 * （只是 ls 一下放令牌的目录可以；ls 完交给 Get-Content、Select-String，或者 cat $(ls …)，就不行）；
 * easy 是这整条命令是不是只在列名字、过滤名单（这时 hasReader 是 false：后面的 head、grep 读的是名单）
 */
function keyFileIssue(segs, dir, hasReader, easy) {
  const NO = '，不许读：它们只给套件自己用，读出来会进会话记录。要看套件的开关，读 config.json；要知道令牌、模型配没配好，让用户看配置页。';
  for (const x of segs) {
    const h = headOf(x.ws);
    if (!h.name) continue;
    if (kitToolRun(x, h, dir)) continue;
    const rec = recursiveSeg(x, h);
    // 整条命令只是在列名字（easyListing）：这一段的 find 是按名字找、把名字列出来，不读内容，和 ls -R 一样看。别的时候 find 照搜索算
    if (easy && h.name === 'find') continue;
    // 只是列一下、算个路径：别的命令不去读它就没事。cd、pwd、test-path 这些不往后传东西的，怎么都没事
    if (LISTING.has(h.name) && (!hasReader || !PASSING.has(h.name))) continue;
    for (const w of x.ws.slice(h.i + 1)) {
      if (h.name === 'cmd' && /^\/?[ck]$/i.test(w.text)) continue; // cmd 的 /C、/K 是开关，不能按 Git Bash 盘符路径解释。
      for (const c of pathCandidates(w)) {
        const why = secretTouch(c, dir, h.name, rec);
        if (why) return '[vibe-kit] 这条命令会读到令牌或者模型的 key（' + why + '）' + NO;
      }
    }
    // Join-Path $HOME '.claude\vibe-kit\router-data\config.json'：几段拼起来再看
    if (h.name === 'join-path') {
      const parts = x.ws.slice(h.i + 1).filter((w) => !w.text.startsWith('-')).map((w) => local(w.text));
      if (parts.length >= 2) { const why = secretTouch(path.join(...parts), dir, 'get-content', false); if (why) return '[vibe-kit] 这条命令会读到令牌或者模型的 key（' + why + '）' + NO; }
    }
    for (const r of x.redirs) { const why = secretTouch(r.target, dir, h.name, false); if (why) return '[vibe-kit] 这条命令会碰到令牌或者模型的 key（' + r.target + '），不许动。'; }
    // 路径藏在一段脚本里的（node -e、python -c、powershell -Command 里读文件、heredoc 的正文）：按字面认
    const raw = x.ws.slice(h.i).map((w) => w.text).join(' ') + ' ' + (x.doc || '');
    const inKit = (() => { try { const d = normKey(realish(dir)); const k = normKey(realish(KIT)); return d === k || d.startsWith(k + '/'); } catch (e) { return false; } })();
    if (SECRET_TEXT.test(raw) || (inKit && /(^|[^\w.-])(secrets\.json|router-data)([^\w.-]|$)/i.test(raw))) return '[vibe-kit] 这条命令里提到了放令牌、放模型 key 的文件（secrets.json、router-data）' + NO;
  }
  return '';
}
/** 当前目录在 ~/.claude 里面：这时一个光秃秃的词（vibe-kit、settings.json）也可能指向套件 */
function insideCfg(dir) {
  try { const d = normKey(realish(dir)); const c = normKey(realish(CFG_DIR)); return d === c || d.startsWith(c + '/'); } catch (e) { return false; }
}
const PATHISH = /[\\/~$%]|^\.{1,2}$/;
/**
 * segs 是用管道连着的一串命令。一段一段看：这一段自己提到了套件的路径，或者管道里前面的段提到过（ls 套件目录 | xargs rm），
 * 这一段就只能是只读的命令、或者跑套件自带的工具。前面没提到套件的段不管
 */
const INTERP = /^(node|deno|bun|python\d?(\.\d+)?|pythonw|py|ruby|perl|php)$/;
const KIT_TEXT = /\.claude["'`\s,+\\/)(]{1,12}(vibe-kit|(skills|agents)["'`\s,+\\/)(]{1,12}ttls-)/i;
const PYTHON = new Set(['python', 'python3', 'pythonw', 'py']);
const isPython = (name) => PYTHON.has(name) || /^python\d(\.\d+)?$/.test(name);
/**
 * 解释器命令里带的一段代码（不是脚本文件）：node -e、-p、-pe、--eval=…、python -c、-Bc、-c"…"、-m 模块，
 * 还有从标准输入喂进去的 heredoc（python - <<EOF、node <<EOF）。返回 { code, module }；没有返回 null
 */
function inlineCode(h, rest, docs) {
  const py = isPython(h.name);
  const node = /^(node|deno|bun)$/.test(h.name);
  if (!py && !node) return null;
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k].text;
    if (t === '-' || t === '--') { const doc = docOf(rest.slice(k), docs); return doc !== null ? { code: doc } : null; }
    if (HD.test(t)) return { code: String(docs[Number(HD.exec(t)[1])] || '') };
    if (!t.startsWith('-')) return null;                     // 第一个不是选项的词：脚本文件
    let m = t.match(/^--(eval|print|require|import|loader|experimental-loader)(?:=(.*))?$/);
    if (m) { if (/^(eval|print)$/.test(m[1])) return { code: m[2] !== undefined ? m[2] : (rest[k + 1] ? rest[k + 1].text : '') }; if (m[2] === undefined) k++; continue; }
    if (t.startsWith('--')) continue;
    // 短选项组：一个字母一个字母看。e / p（node）、c（python）后面的是代码：贴在一起的（-c"…"）或者下一个词
    const letters = t.slice(1);
    for (let i = 0; i < letters.length; i++) {
      const ch = letters[i];
      const tail = letters.slice(i + 1);
      if ((node && /[ep]/.test(ch)) || (py && ch === 'c')) {
        const flags = node ? /^[eprc]*$/ : /^$/;
        if (tail && !flags.test(tail)) return { code: tail };
        if (!tail || (node && flags.test(tail) && !/[ep]/.test(tail))) return { code: rest[k + 1] ? rest[k + 1].text : '' };
        continue;
      }
      if (py && ch === 'm') return { module: tail || (rest[k + 1] ? rest[k + 1].text : '') };
      if (node && ch === 'r') { if (!tail) k++; break; }
      if (py && /[XW]/.test(ch)) { if (!tail) k++; break; }
    }
  }
  return null;
}
/**
 * 路径藏在一段代码里的（node -e、python -c、heredoc）：引号里的每一截当路径看一遍，再按字面认"~/.claude 下面套件的东西"。
 * 代码是读还是写分不出来，一律算动到了：要看套件的文件用 cat、Get-Content
 */
function codeTouch(x, h, dir, docs) {
  if (!INTERP.test(h.name)) return '';
  const ic = inlineCode(h, x.ws.slice(h.i + 1), docs);
  if (!ic || !ic.code) return '';
  const code = String(ic.code);
  for (const m of code.matchAll(/(["'`])([^"'`]{2,}?)\1/g)) if (PATHISH.test(m[2]) && isKitPath(local(m[2]), dir)) return m[2];
  const t = code.match(KIT_TEXT);
  return t ? t[0] : '';
}
/** 这个词是不是指向套件的东西。bare（当前目录在 ~/.claude 里面）时光秃秃的词也算 */
const kitWord = (c, dir, bare) => !!c && !/^-[A-Za-z]+$/.test(c) && (bare || PATHISH.test(c)) && isKitPath(local(c), dir);
/**
 * 这一段是不是在跑套件自带技能里的脚本：python <技能目录>/scripts/x.py …、node <技能目录>/scripts/x.js …。
 * 是就返回脚本那个词，不是返回 null。-c、-m、-e 后面跟的是代码不是脚本，不算；
 * 命令里别的词再指着套件的东西也不算（脚本的参数不该是套件的文件）。
 * 当前目录就在技能目录里（cd 进去再写相对路径）时，参数里的普通词（find、订单）不算指向套件，指着套件里实际存在的文件才算
 */
function skillScriptRun(x, h, dir, bare, docs) {
  if (!isPython(h.name) && h.name !== 'node') return null;
  const rest = x.ws.slice(h.i + 1);
  if (inlineCode(h, rest, docs)) return null;
  let k = 0;
  while (k < rest.length && rest[k].text.startsWith('-')) k += isPython(h.name) && /^-[XW]$/.test(rest[k].text) ? 2 : 1;
  const w = rest[k];
  if (!w) return null;
  const script = local(w.text);
  if (!new RegExp(isPython(h.name) ? '\\.py$' : '\\.js$', 'i').test(script) || !isKitSkillScript(script, dir)) return null;
  for (let i = 0; i < x.ws.length; i++) {
    const o = x.ws[i];
    if (o === w || i <= h.i) continue;
    for (const c of pathCandidates(o)) {
      if (!c || /^-[A-Za-z]+$/.test(c)) continue;
      if (PATHISH.test(c)) { if (isKitPath(local(c), dir)) return null; continue; }
      if (bare) { try { const abs = path.resolve(dir, c); if (fs.existsSync(abs) && isKitPath(abs, dir)) return null; } catch (e) { /* 不是路径 */ } }
    }
  }
  return w;
}
function kitIssue(segs, dir, docs) {
  const bare = insideCfg(dir);
  for (const x of segs) {
    for (const r of x.redirs) {
      if (/^(\$null|\/dev\/null|nul)$/i.test(r.target)) continue;
      if (kitWord(r.target, dir, bare)) return kitMsg(r.target);
    }
  }
  let touched = '';
  for (const x of segs) {
    const h = headOf(x.ws);
    // 当前目录在套件里时，命令名本身（python、node、grep）不是路径，不算
    x.ws.forEach((w, i) => { if (touched || (bare && i === h.i && !PATHISH.test(w.text))) return; for (const c of pathCandidates(w)) if (!touched && kitWord(c, dir, bare)) touched = c; });
    if (!touched && h.name) { const c = codeTouch(x, h, dir, docs); if (c) return kitMsg(c); }
    if (!touched) continue;
    if (!h.name) continue;
    // 只是换到套件的目录里：后面的命令照样一条一条查
    if (CD.test(h.name)) { touched = ''; continue; }
    // 包着别的命令的（cmd /c、bash -c、powershell -Command 之类）：这一段不判，里面那条命令拆出来之后再判。
    // xargs 不算：它要动的文件是管道前面传过来的（ls 套件目录 | xargs rm），里面那条命令自己看不出来
    if (h.name !== 'xargs' && innerCommand(x.ws, h, dir, docs)) { touched = ''; continue; }
    // 跑技能自带的脚本（查库、查 redis）。它吐出来的是查到的数据，不是套件的路径，管道后面接什么不归这里管
    if (skillScriptRun(x, h, dir, bare, docs)) { touched = ''; continue; }
    // 跑套件自带的工具（看页面、清点技能、转码、生成计划）
    if (h.name === 'node') { if (kitToolRun(x, h, dir)) continue; return kitMsg(touched); }
    const texts = x.ws.slice(h.i + 1).map((w) => w.text);
    const inPlace = (h.name === 'sed' || h.name === 'perl') && texts.some((t) => /^-[a-zA-Z]*i/.test(t));
    const findWrites = h.name === 'find' && texts.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(t));
    if (READ_ONLY.has(h.name) && !destructiveSeg(x, h) && !inPlace && !findWrites) continue;
    return kitMsg(touched);
  }
  return '';
}
/*
 * 经验规则的文件（项目和用户目录的 .claude/rules/ttls-lessons-*.md、.vibe/lessons/）：条数上限、合并重复、什么时候升成规则
 * 都由 tools/lesson.js 管。只读的命令、跑套件自带的工具、git 的 add / commit / diff 这些照常放行（规则文件要跟着仓库提交）
 */
const GIT_FINE_ON_LESSON = new Set(['add', 'commit', 'diff', 'status', 'log', 'show', 'blame', 'ls-files', 'check-ignore']);
function lessonIssue(segs, dir, docs) {
  if (!lessons) return '';
  const at = (p) => { try { return path.resolve(dir, local(p)); } catch (e) { return String(p); } };
  for (const x of segs) {
    for (const r of x.redirs) {
      if (/^(\$null|\/dev\/null|nul)$/i.test(r.target)) continue;
      if (lessons.isLessonFile(at(r.target))) return lessonMsg(r.target);
    }
    let touched = '';
    for (const w of x.ws) for (const c of pathCandidates(w)) if (!touched && c && !/^-[A-Za-z]+$/.test(c) && /ttls-lessons-|lessons/i.test(c) && lessons.isLessonFile(at(c))) touched = c;
    if (!touched) continue;
    const h = headOf(x.ws);
    if (!h.name) continue;
    if (innerCommand(x.ws, h, dir, docs)) continue;
    const texts = x.ws.slice(h.i + 1).map((w) => w.text);
    if (h.name === 'node') { if (kitToolRun(x, h, dir)) continue; return lessonMsg(touched); }
    if (h.name === 'git') { const g = parseGit(x.ws, dir); if (g && GIT_FINE_ON_LESSON.has(g.sub)) continue; return lessonMsg(touched); }
    const inPlace = (h.name === 'sed' || h.name === 'perl') && texts.some((t) => /^-[a-zA-Z]*i/.test(t));
    const findWrites = h.name === 'find' && texts.some((t) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(t));
    if (READ_ONLY.has(h.name) && !destructiveSeg(x, h) && !inPlace && !findWrites) continue;
    return lessonMsg(touched);
  }
  return '';
}

const lessonMsg = (p) => '[vibe-kit] 这条命令会改到经验规则的文件（' + p + '），不要直接改：记一条、退役一条、查过时的，都用 node "$HOME/.claude/vibe-kit/tools/lesson.js"（help 里有写法），条数上限和合并重复由它来管。看内容（cat、Get-Content）和提交（git add、git commit）可以。';
const kitMsg = (p) => '[vibe-kit] 这条命令会动到 vibe-kit 套件在用户目录里的东西（' + p + '），不许改：钩子、规范、技能、配置、settings.json、全局 CLAUDE.md 只能用户自己改。只读的命令（cat、Get-Content、ls…）和跑套件自带的工具（page/、tools/ 里的脚本）可以。你要是觉得钩子拦错了，把原因告诉用户，让用户来定；不要绕过。';
/*
 * 不许直接调路由的接口（配置页后端 /api、钩子入口 /vibe-kit/hook/）：出现路由要的请求头 x-vibe-router、钩子入口的路径，
 * 或者本机地址（127.x、localhost、[::1]、0.0.0.0）后面跟的端口按数值等于路由的端口（015730、0x3d72 这种写法也认），就拦
 */
function routerApiIssue(cmd, ps, cwd) {
  const msg = '[vibe-kit] 不许直接调路由的接口改套件：模型、开关、本机环境、问题反馈只能用户在配置页里改。你想改什么，告诉用户。';
  // 跑套件自带的工具（记问题反馈）的那一段不看：它的参数里提到配置页的地址是在描述问题，不是在调接口
  const { s, docs } = preprocess(cmd, ps);
  const dir = path.resolve(cwd || process.cwd());
  const parts = [];
  for (const group of splitCommand(s, ps)) {
    for (const seg of group) {
      const ws = words(scanRedirects(seg).rest, ps);
      const h = headOf(ws);
      if (ws.length && kitToolRun({ ws }, h, dir)) continue;
      parts.push(seg);
      const doc = docOf(ws, docs);
      if (doc !== null) parts.push(doc);
    }
  }
  const text = parts.join('\n');
  if (/x-vibe-router|\/vibe-kit\/hook\//i.test(text)) return msg;
  let port = 15730;
  try { port = require(path.join(KIT, 'router', 'service.js')).portOf() || 15730; } catch (e) { /* 没装路由 */ }
  const re = /(?:127(?:\.\d+){0,3}|localhost|\[[0:]*:1\]|\[::\]|0\.0\.0\.0)\s*:\s*(0x[0-9a-f]+|\d+)/gi;
  let m;
  while ((m = re.exec(text))) { const p = /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1], 10); if (p === port) return msg; }
  return '';
}
/** 整条命令都是只读的（每一段的命令名都在只读名单里、没有往文件写的重定向、没有包着别的命令） */
function readOnlyCommand(cmd, ps) {
  const { s, docs } = preprocess(cmd, ps);
  for (const group of splitCommand(s, ps)) {
    for (const seg of group) {
      const r = scanRedirects(seg);
      if (r.list.some((x) => !/^(\$null|\/dev\/null|nul)$/i.test(x.target))) return false;
      const ws = words(r.rest, ps);
      if (!ws.length) continue;
      const h = headOf(ws);
      if (!READ_ONLY.has(h.name) || destructiveSeg({ ws }, h) || innerCommand(ws, h, process.cwd(), docs)) return false;
      if ((h.name === 'sed' || h.name === 'perl') && ws.some((w) => /^-[a-zA-Z]*i/.test(w.text))) return false;
    }
  }
  return true;
}

// ---------- 不许顺手把模型路由一起杀掉 ----------
/*
 * 开发服务卡住时，模型常顺手 taskkill /IM node.exe、Stop-Process -Name node、pkill node。模型路由也是 node 进程：
 * 它一停，接上了路由的 Claude Code 连不上模型，走 HTTP 的检查（改文件、跑命令、收工）也全部失效。要停哪个服务就按 PID 停。
 * 只在装了路由时管；按 PID 结束路由自己的进程也拦。
 */
function routerPid() { try { return Number(JSON.parse(fs.readFileSync(path.join(KIT, 'router-data', 'router.pid'), 'utf8')).pid) || 0; } catch (e) { return 0; } }
const NODE_PROC = /^node(\.exe)?\*?$/i;
const KILL_ALL_MSG = '[vibe-kit] 这条命令会把所有 node 进程一起结束，模型路由也在里面（Claude Code 连模型、套件的检查都靠它）。要停某个开发服务，按端口找到它的 PID 再结束：netstat -ano | findstr :<端口>，然后 taskkill /PID <PID> /F（PowerShell：Stop-Process -Id <PID>）。';
function killIssue(segs) {
  if (!fs.existsSync(path.join(KIT, 'router', 'router.js'))) return '';
  const pid = routerPid();
  const pidMsg = '[vibe-kit] 进程 ' + pid + ' 是模型路由（Claude Code 连模型、套件的检查都靠它），不要结束它。要停的是别的服务，先用 netstat -ano | findstr :<端口> 找对 PID。';
  // Git Bash 里为了不被当成路径，Windows 命令的开关常写成 //F //IM：归成 /F /IM 再认
  const segsInfo = segs.map((x) => { const h = headOf(x.ws); return { name: h.name, args: x.ws.slice(h.i + 1).map((w) => String(w.text).replace(/^\/\/(?=[A-Za-z])/, '/')) }; });
  const isPid = (t) => pid > 0 && String(t).replace(/,$/, '') === String(pid);
  for (let k = 0; k < segsInfo.length; k++) {
    const { name, args } = segsInfo[k];
    const low = args.map((a) => a.toLowerCase());
    if (name === 'taskkill') {
      for (let i = 0; i < low.length; i++) {
        if (/^[/-]im$/.test(low[i]) && NODE_PROC.test(low[i + 1] || '')) return KILL_ALL_MSG;
        if (/^[/-]pid$/.test(low[i]) && isPid(low[i + 1])) return pidMsg;
        if (/^[/-]fi$/.test(low[i]) && /imagename\s+eq\s+node/i.test(low[i + 1] || '')) return KILL_ALL_MSG;
      }
    }
    if (/^(stop-process|spps)$/.test(name) || (name === 'kill' && low.some((a) => /^-(name|processname|id)$/.test(a)))) {
      for (let i = 0; i < low.length; i++) {
        if (/^-(name|processname|n)$/.test(low[i]) && (low[i + 1] || '').split(',').some((n) => NODE_PROC.test(n.trim()))) return KILL_ALL_MSG;
        if (/^-id$/.test(low[i]) && (low[i + 1] || '').split(',').some(isPid)) return pidMsg;
      }
      if (low.some(isPid)) return pidMsg;
    }
    if (/^(pkill|killall)$/.test(name) && low.some((a) => !a.startsWith('-') && (NODE_PROC.test(a) || /(^|[\\/])node(\.exe)?$/.test(a)))) return KILL_ALL_MSG;
    if (name === 'kill' && low.some(isPid)) return pidMsg;
    if (name === 'wmic' && /name\s*=\s*['"]?node(\.exe)?['"]?/i.test(args.join(' ')) && /\b(delete|terminate)\b/i.test(args.join(' '))) return KILL_ALL_MSG;
    if (/^(get-ciminstance|gcim|get-wmiobject|gwmi)$/.test(name) && /node/i.test(args.join(' ')) && segsInfo.slice(k + 1).some((x) => /^(invoke-cimmethod|icim|remove-ciminstance|rcim|invoke-wmimethod|iwmi|stop-process|spps)$/.test(x.name) || x.args.some((a) => /terminate|\.kill\(\)/i.test(a)))) return KILL_ALL_MSG;
    // Get-Process node | Stop-Process、gps -Name node* | spps、Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process、pgrep node | xargs kill
    const killer = (x) => /^(stop-process|spps|kill|taskkill)$/.test(x.name) || (x.name === 'xargs' && x.args.some((a) => /^(kill|taskkill|stop-process)$/i.test(a)));
    if (/^(get-process|gps|ps|pgrep)$/.test(name) && segsInfo.slice(k + 1).some(killer)) {
      const text = [args.join(' ')].concat(segsInfo.slice(k + 1).map((x) => x.args.join(' '))).join(' ');
      if (/(^|[\s'"=,])node(\.exe)?\*?($|[\s'",}])/i.test(text)) return KILL_ALL_MSG;
      if (pid > 0 && new RegExp('(^|\\D)' + pid + '(\\D|$)').test(text)) return pidMsg;
    }
  }
  return '';
}

/**
 * 整条命令看一遍（不按组拆）：列进程的命令和结束进程的命令都在，中间提到了 node（或者路由的进程号），就拦。
 * Where-Object { … }、ForEach-Object { … } 这种花括号块会把管道拆成几组，按组看认不出来
 */
function killAnywhere(cmd, ps) {
  if (!fs.existsSync(path.join(KIT, 'router', 'router.js'))) return '';
  const { s } = preprocess(cmd, ps);
  const lister = /(^|[\s;|&({])(get-process|gps|ps|pgrep|tasklist|get-ciminstance|gcim|get-wmiobject|gwmi)(\.exe)?(?=$|[\s;|&)}])/i;
  const killer = /(^|[\s;|&({])(stop-process|spps|kill|taskkill|invoke-cimmethod|icim|remove-ciminstance|rcim|invoke-wmimethod|iwmi)(\.exe)?(?=$|[\s;|&)}])|\.kill\(\)|\bTerminate\b/i;
  if (!lister.test(s) || !killer.test(s)) return '';
  if (/(^|[\s'"=,(])node(\.exe)?\*?($|[\s'",)}])/i.test(s)) return KILL_ALL_MSG;
  const pid = routerPid();
  if (pid > 0 && new RegExp('(^|\\D)' + pid + '(\\D|$)').test(s)) return '[vibe-kit] 进程 ' + pid + ' 是模型路由（Claude Code 连模型、套件的检查都靠它），不要结束它。要停的是别的服务，先用 netstat -ano | findstr :<端口> 找对 PID。';
  return '';
}

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

// ---------- 提交时：它新建的文件有没有 add ----------
/*
 * git 不会自动带上新文件：它这个会话里用 Write 新建的文件，在要提交的这个仓库里还是"未跟踪"（??），而且这条命令里也没 git add 它，
 * 就拦一次，点名是哪些。属于这次提交的一起 add；为了测试临时加的不提交、测完删掉；它确实要先不提交，原样再执行一次就放行（同样的一批只拦一次）。
 * 过程文件（备份、日志）不在这里说：那些本来就不该提交。
 */
/**
 * 用临时 index 提交（GIT_INDEX_FILE=… git add / commit：把工作区里别人没提交的改动隔在外面）：要提交什么看的是那份 index，
 * 真实的 index 里看不到（议题 #5：文件明明 add 进了临时 index，却说"还没 git add"）。
 * 命令里设了就返回 { file: 那份 index 的路径，算不出来是 '' }；没设返回 null
 */
function tempIndexOf(cmd) {
  const s = String(cmd || '');
  if (!/GIT_INDEX_FILE/.test(s)) return null;
  const m = s.match(/GIT_INDEX_FILE\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/);
  const v = m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
  // /tmp/… 是 Git Bash 自己的路径，这里换算不出来
  if (!v || /\$[({\w]|`|%\w+%/.test(expandHome(v)) || /^\/(tmp|var|dev|proc)(\/|$)/.test(v)) return { file: '' };
  return { file: local(v) };
}
/** 查这个仓库要用的环境变量：没用临时 index 返回 undefined（照常查）；用了、那份 index 找得到，带上它；找不到返回 null（查不了） */
function indexEnv(st, root, dir) {
  if (!st.tempIndex) return undefined;
  const f = st.tempIndex.file;
  if (!f) return null;
  const cands = path.isAbsolute(f) ? [f] : [path.resolve(root, f), path.resolve(dir, f)];
  const hit = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
  return hit ? Object.assign({}, process.env, { GIT_INDEX_FILE: hit }) : null;
}
function newFilesIssue(g, st) {
  const j = st.j;
  if (!j || !j.transcript_path || !j.session_id) return '';
  const root = repoRoot(g.dir);
  if (!root) return '';
  const env = indexEnv(st, root, g.dir);
  // 临时 index 还没建出来（同一条命令里现建现用）、路径算不出来：查不了，不猜
  if (env === null) return '';
  const entries = tailEntries(j.transcript_path, 2000000);
  const res = toolResults(entries);
  const rootKey = normKey(root);
  const mine = new Set();
  for (const c of toolCalls(entries)) {
    if (!/^(Write|NotebookEdit)$/.test(c.name) || !res.has(c.id) || res.get(c.id).error) continue;
    const f = String(c.input.file_path || c.input.notebook_path || '');
    if (!f) continue;
    const abs = path.resolve(j.cwd || st.dir, f);
    const k = normKey(abs);
    if (!k.startsWith(rootKey + '/') || /\/\.(vibe|claude)\//.test(k) || !fs.existsSync(abs)) continue;
    if (tidy && (tidy.isProcessFile(abs) || tidy.processDirOf(abs, root, false))) continue;
    mine.add(abs);
  }
  if (!mine.size) return '';
  const rel = [...mine].map((f) => path.relative(root, f).split(path.sep).join('/')).slice(0, 80);
  let out = '';
  try { out = execFileSync('git', ['--no-optional-locks', '-C', root, '-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--'].concat(rel), { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env || process.env }); } catch (e) { return ''; }
  const added = [...st.added];
  const pending = out.split(/\r?\n/).filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((r) => { const k = normKey(path.join(root, r)); return !added.some((a) => k === a || k.startsWith(a.replace(/\/$/, '') + '/')); });
  if (!pending.length) return '';
  const sig = pending.slice().sort().join('|');
  const key = j.session_id + '-newfiles-commit';
  if (readState(key).sig === sig) return '';
  // 记不下"拦过这一批"就放行：不然每次都拦，"原样再执行一次就放行"这条路走不通
  if (!writeState(key, { sig, at: Date.now() })) return '';
  return '[vibe-kit] 你这个会话里新建的这些文件还没 git add，这次提交不会带上它们（git 不会自动加新文件）：' + pending.slice(0, 8).join('、') + (pending.length > 8 ? ' 等 ' + pending.length + ' 个' : '') + '。\n'
    + '- 属于这次提交的（这项任务新加的代码、配置、页面）：一起 git add 再提交。\n'
    + '- 为了测试临时加的（测试页面、调试接口、测试数据、临时脚本）：不要提交，这件事测完就删掉；能放 .vibe/tmp/<事由>/ 的放那里。\n'
    + '- 确实要先留着、不放进这次提交：原样再执行一次这条提交命令就行。';
}


// ---------- 提交方式：关 / 询问 / 自动（用户 2026-10-17 定的，人工和自动都用，替代 autoCommit 档位和 plainCommit） ----------
/*
 * 关：只在用户说了"提交"时提交。询问：用户在就交代改动、用提问框问"提交 / 还要改"；自动模式下用户不在，先不提交、记进报告。
 * 自动：做完一件完整的事才提交（OpenSpec 实施里上次提交之后又勾完任务、审查修复收尾；需求文档定稿；不走 OpenSpec 的改动做完）。
 * 提案产物的提交始终要用户点头，提交方式是自动、需求文档定稿时除外；经验规则文件（套件催着单独提交的）询问、自动都不再问。
 * 怎么算他点了头：会话记录里他最后一次开口（自己打的字、提问框里选的）是"提交"（lib/session.js 的 userSaid）。
 */
function onlyMetadata(g, st) {
  const root = repoRoot(g.dir) || g.dir;
  const rk = normKey(root);
  const added = [...st.added].filter((a) => a === rk || a.startsWith(rk + '/'));
  const kitFile = (a) => /\/\.claude\/rules\/(?:[^/]*lessons-[^/]*|learned-rules)\.md$/i.test(a) || /\/openspec\//i.test(a);
  try {
    const staged = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], { windowsHide: true, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\x00').filter(Boolean).map((f) => normKey(path.resolve(root, f)));
    const files = added.concat(staged);
    return files.length > 0 && files.every(kitFile);
  } catch (e) { return false; }
}
/**
 * 这次提交会带上的文件（相对仓库根）：已经暂存的，加上这条命令里 git add 的路径下有改动的。
 * PreToolUse 时同一条命令里的 git add 还没执行，只看暂存区会把"git add 提案 && git commit"当成空提交（2026-10-17 审核问题 1）。
 * Git 出错、超时返回 null，调用方按更严的一边处理。
 */
function commitFiles(g, st) {
  const root = repoRoot(g.dir) || g.dir; const rk = normKey(root);
  const opt = { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    const out = new Set(execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], opt).split('\0').filter(Boolean));
    const added = [...st.added].filter((a) => a === rk || a.startsWith(rk + '/')).map((a) => path.relative(root, a).split(path.sep).join('/') || '.');
    if (added.length) {
      // -z 的格式：两位状态、一个空格、路径；改名、复制的后面再跟一段原路径
      const parts = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '-uall', '--'].concat(added.slice(0, 50)), opt).split('\0');
      for (let i = 0; i < parts.length; i++) { const e = parts[i]; if (e.length < 4) continue; out.add(e.slice(3)); if (/^[RC]/.test(e)) i++; }
    }
    return [...out];
  } catch (e) { return null; }
}
const PROPOSAL_FILE = /(?:^|\/)openspec\/changes\/(?!archive\/)[^/]+\/(?:proposal\.md|design\.md|tasks\.md|specs\/)/;
function consentIssue(g, st, cfg, docs) {
  const j = st.j || {};
  const msg = messageOf(g.args, docs);
  let es = [];
  try { if (j.transcript_path) es = tailEntries(j.transcript_path, 3000000).filter((e) => e && !e.isSidechain); } catch (e) { es = []; }
  const permit = userSaid(es, 'commit').ok ? require('../lib/permissions').allow(j, 'commit', repoRoot(g.dir) || g.dir, j.tool_use_id) : { ok: false };
  if (permit.reason && !permit.ok) return '[vibe-kit] ' + permit.reason + '。交代当前改动后重新确认是否提交。';
  let approved = permit.ok;
  // 用户自己说了合并推送（用户 2026-10-28 补充：去掉的是套件的合并推送工具，用户跟 Claude 说合并推送时照做、不拦）：合并时重新提交算在这句话里
  if (!approved) { try { const ps = userSaid(es, 'push'); if (ps.ok && require('../lib/intent').mergeIntent(ps.text)) approved = true; } catch (e) { /* 认不出照原来的规矩 */ } }
  const fl = flowState(j);
  const files = commitFiles(g, st);
  // 读不出要提交哪些文件：后面按提交方式的判断都做不了，没有用户许可就先问（审核问题 13）
  if (files === null) return approved ? '' : '[vibe-kit] 读不出这次要提交哪些文件（Git 超时或出错）。先交代改动，问用户是否提交。';
  const proposalCommit = files.some(f => PROPOSAL_FILE.test(f));
  const S = require('../lib/session'); const P = require('../lib/flow-policy');
  const mode = S.commitModeOf(cfg);
  // 需求文档定稿：提交方式是"自动"才直接提交（需求自动生效时要四份都审过；人工时四份都写完，每份用户都看过）。询问、关都要用户点头（审核问题 2）
  const planRoots = allChanges(st.cwd0).filter(c => flowChanges(j).includes(normKey(c.dir)) && P.points(c.dir, 'proposal').length === 4 && (!cfg.autoMode || P.allPassed(c.dir, 'proposal'))).map(c => normKey(c.dir) + '/');
  const automaticPlan = mode === 'auto' && fl.stage === 'plan' && files.length && files.every(f => planRoots.some(d => normKey(path.resolve(repoRoot(g.dir) || g.dir, f)).startsWith(d)));
  if (automaticPlan) return '';
  if (!approved && proposalCommit && fl.stage !== 'apply') return '[vibe-kit] 提案提交要单独确认：先交代定稿内容，问用户是否提交；开工许可不能代替提交许可。';
  if (approved) return '';
  if (mode === 'off') return '[vibe-kit] 提交方式是"关"：不自动提交，也不问。用户说了"提交"再提交，没说就留给用户自己提交，接着做别的。';
  // 经验规则文件（套件自己催着单独提交的 docs: 更新经验规则）：询问、自动都不用再问
  if (onlyMetadata(g, st)) return '';
  if (mode === 'ask') return cfg.autoMode
    ? '[vibe-kit] 提交方式是"询问"，自动模式下用户不在：先不提交，收工时列进全自动报告，等用户回来说。接着做别的。'
    : '[vibe-kit] 提交方式是"询问"：先自己把 diff 过一遍（有没有调试代码、误改、漏改），交代改了什么、怎么验的，用提问框问用户（选项写"提交"和"还要改"）。用户选了提交再提交；说还要改什么，改完再问。';
  // 自动：做完一件完整的事才提交。OpenSpec 实施里，上次提交之后又勾完了任务、或者审查修复刚收尾；做到一半、审查没收尾不提交
  const current = allChanges(st.cwd0).filter((c) => flowChanges(j).some((d) => normKey(d) === normKey(c.dir)));
  if (!(cfg.autoMode || fl.on && fl.stage === 'apply')) return '';
  if (!current.length) return cfg.autoMode ? '[vibe-kit] 这次提交没有对应的当前 OpenSpec 变更，不能借用全自动许可；交代改动后问用户是否提交。' : '';
  const root = repoRoot(g.dir) || g.dir; const baselines = readState('work-baselines');
  const original = new Set(current.flatMap((c) => ((baselines[normKey(c.dir)] || {}).repos || []).filter((r) => normKey(r.root) === normKey(root)).flatMap((r) => r.dirtyFiles || [])));
  if (original.size) { const mixed = files.filter((f) => original.has(f)); if (mixed.length) return '[vibe-kit] 暂存文件在开工前已有用户改动：' + mixed.join('、') + '。先核对 diff 与文件段归属，不能自动全部提交；交代范围后取得用户的明确提交许可。'; }
  const rounds = syncReviewRounds(es, syncReviews(es, st.cwd0));
  const open = current.some(c => P.points(c.dir, 'code').some(p => { const r = P.record(c.dir, p); return r.rounds && !P.settled(c.dir, p); })) || current.some(c => { const r = readState('review-rounds')['code|' + normKey(c.dir)]; return r && r.pendingFix && !r.done; });
  if (open) return '[vibe-kit] 审查还没收尾，成立的问题全部修完、验证并审完后一起提交，不逐轮提交。';
  if (S.pendingReviewsIn(toolCalls(es, 0), toolResults(es), current, S.taskNotes(es)).length) return '[vibe-kit] 审查还在运行，等结论回来、修完并验证后一起提交。';
  const since = require('./verify-gate').lastCommitAt(root);
  const reviewReady = rounds.some((x) => x.key.startsWith('code|') && current.some((c) => normKey(c.dir) === normKey(x.change.dir)) && (x.rec.done || (!cfg.reviewLoop && x.fixed)) && x.rec.at > since);
  const ready = reviewReady || current.some((c) => Object.values(S.syncTicks(c.dir)).some((tick) => tick > since));
  if (!ready) return '[vibe-kit] 提交方式是"自动"，但还没做完一件事：上次提交之后还没有新勾完的任务，也没有刚收尾的审查修复。做完、勾上再提交。';
  return '';
}

// ---------- 主流程 ----------
/**
 * 拦下这条命令。kind 是哪一类检查：server、process、archive、commit-format、new-files 可以申请放行（lib/feedback.js），
 * 这一步申请过、通行证还有效的，这一类就跳过（记下用了哪张），接着查别的；kill、kit、git-scope（整仓 add、commit -a、gitlink）、
 * archive-ok（用户没说归档）、commit-ok（不走 OpenSpec 的提交用户没点头）永远不放行
 */
function setBlock(st, kind, msg, target) {
  if (st.block || !msg) return;
  // 通行证按"同一件事"认：归档认变更名，别的认这一类检查（同一个目录里）
  const t = target || kind + ':' + normKey(st.cwd0);
  let p = null;
  try { p = feedback ? feedback.pickPass(st.passes, kind, st.sig, t, msg) : null; } catch (e) { p = null; }
  if (p) { if (!st.used.includes(p)) st.used.push(p); st.blocked[kind] = msg; return; }
  st.block = msg;
  st.kind = kind;
  st.target = t;
}
/** 这条命令（连同包在里面的）有没有会把文件内容读出来的命令 */
function hasReaderIn(cmd, ps, depth) {
  const { s, docs } = preprocess(cmd, ps);
  for (const group of splitCommand(s, ps)) {
    for (const seg of group) {
      const ws = words(scanRedirects(seg).rest, ps);
      if (!ws.length) continue;
      const h = headOf(ws);
      if (READERS.has(h.name) || /^(cat|type)$/.test(h.name)) return true;
      const inner = depth < 3 ? innerCommand(ws, h, process.cwd(), docs) : null;
      if (inner && hasReaderIn(inner.cmd, inner.ps, depth + 1)) return true;
    }
  }
  return false;
}
function analyze(cmd, ps, st, cfg, depth) {
  require('../lib/invocation').phase('分析执行命令');
  const decision = require('../lib/review-runner').decisionIssue(Object.assign({}, st.j, { cwd: st.dir, tool_input: { command: cmd } }));
  if (decision) { setBlock(st, 'review-decision', '[vibe-kit 审查决定] ' + decision); return; }
  // 包装命令换过目录后，相对发布脚本也要按内层的目录检查。
  if (publishAnywhere(cmd, st.dir)) st.publishing = true;
  const { s, docs } = preprocess(cmd, ps);
  if (st.easy === undefined) st.easy = easyListing(cmd, ps);
  if (st.hasReader === undefined) st.hasReader = st.easy ? false : hasReaderIn(cmd, ps, 0);
  // 括号里的 cd 只在括号里管用；pushd / popd 按栈来
  const dirs = [];
  for (const group of splitCommand(s, ps, true)) {
    if (group.length === 1 && group[0] === OPEN) { dirs.push({ dir: st.dir, unknown: st.archiveUnknown }); continue; }
    if (group.length === 1 && group[0] === CLOSE) { if (dirs.length) { const d = dirs.pop(); st.dir = d.dir; st.archiveUnknown = d.unknown; } continue; }
    const segs = group.map((seg) => { const r = scanRedirects(seg); const ws = words(r.rest, ps); const doc = docOf(ws, docs); return { redirs: r.list, ws, doc: doc === null ? '' : doc }; });
    // for r in a b c：循环变量的取值记下来，后面 git -C "$r" 的目录就算得出来（取值里还有变量的不记）
    if (!ps && segs.length === 1) {
      const w0 = segs[0].ws;
      if (w0.length >= 4 && w0[0].text === 'for' && w0[2].text === 'in' && /^[A-Za-z_]\w*$/.test(w0[1].text)) {
        const vals = w0.slice(3);
        st.loops = st.loops || {};
        if (vals.length && !vals.some((w) => dynamic(w) || /[*?]/.test(w.raw))) st.loops[w0[1].text] = vals.map((w) => w.text); else delete st.loops[w0[1].text];
      }
    }
    if (!st.block) { const k = killIssue(segs); if (k) setBlock(st, 'kill', k); }
    if (cfg.kitLock !== false && !st.block) { const k = kitIssue(segs, st.dir, docs); if (k) setBlock(st, 'kit', k); }
    if (cfg.kitLock !== false && !st.block) { let k = ''; try { k = lessonIssue(segs, st.dir, docs); } catch (e) { k = ''; } if (k) setBlock(st, 'kit', k); }
    // 令牌和模型的 key：不看"禁止改套件"那个开关，什么时候都不给读
    if (!st.block) { let k = ''; try { k = keyFileIssue(segs, st.dir, st.hasReader, st.easy); } catch (e) { k = ''; } if (k) setBlock(st, 'kit', k); }
    const archiveStream = segs.some(x => { const h = headOf(x.ws); return archiveExtract.isArchive(h.name, x.ws.slice(h.i + 1)); });
    for (const x of segs) {
      const ws = x.ws;
      if (!ws.length) continue;
      const head = headOf(ws);
      if (POPD.test(head.name)) { if (st.pushed.length) { const d = st.pushed.pop(); st.dir = d.dir; st.archiveUnknown = d.unknown; } continue; }
      if (CD.test(head.name)) {
        const to = cdTarget(ws.slice(head.i + 1));
        if (PUSHD.test(head.name)) st.pushed.push({ dir: st.dir, unknown: st.archiveUnknown });
        if (!to) continue;
        // cd -：回上一个目录
        if (to.back) { const t = st.dir, u = st.archiveUnknown; st.dir = st.prev || st.dir; st.archiveUnknown = st.prevUnknown; st.prev = t; st.prevUnknown = u; continue; }
        if (!dynamicPath(to)) { st.prev = st.dir; st.prevUnknown = st.archiveUnknown; st.dir = path.resolve(st.dir, local(to.text)); if (path.isAbsolute(local(to.text))) st.archiveUnknown = false; continue; }
        st.prev = st.dir; st.prevUnknown = st.archiveUnknown; st.archiveUnknown = true;
        // 算不出来要去哪、又像是往 ~/.claude 里去：后面的相对路径就没法查了，这种 cd 不放
        if (cfg.kitLock !== false && !st.block && /\.claude|vibe-kit/i.test(String(to.raw))) setBlock(st, 'kit', '[vibe-kit] 这条 cd 要去的目录算不出来（' + to.raw + '），又像是套件在用户目录里的东西。写成确定的路径（~/.claude/… 或者 $HOME/.claude/…），不要用别的变量拼。');
        continue;
      }
      const inner = innerCommand(ws, head, st.dir, docs);
      if (inner && depth < 3) {
        const outer = st.dir, unknown = st.archiveUnknown;
        if (inner.dir) st.dir = inner.dir;
        analyze(inner.cmd, inner.ps, st, cfg, depth + 1);
        if (inner.dir) { st.dir = outer; st.archiveUnknown = unknown; }
        continue;
      }
      // 经过 devserver.js 起的：它自己查重、查端口，这一段里带的启动命令不拦（只免这一段，同一条命令里别的段照查）
      const viaTool = ws.some((w) => /devserver\.js$/i.test(w.text));
      if (!viaTool && !st.block) { const s = serverStart(ws, head, st.dir); if (s) setBlock(st, 'server', serverMsg(s, st.dir)); }
      if (tidy && !st.block) { const p = processTarget(x, head, st.dir); if (p && tidy.blockOnce(st.j.session_id, p.key)) setBlock(st, 'process', tidy.processMsg(p.show)); }
      if (!st.block && !st.archiveUnknown) {
        const outputs = archiveStream ? x.redirs.map(r => ({ text: r.target, raw: r.target })) : [];
        if (archiveStream && WRITE_TO.test(head.name)) {
          const rest = ws.slice(head.i + 1);
          const i = rest.findIndex(w => /^-(?:filepath|path|literalpath)$/i.test(w.text));
          const dest = i >= 0 ? rest[i + 1] : rest.find(w => !w.text.startsWith('-'));
          if (dest) outputs.push(dest);
        }
        const p = archiveExtract.issue(head.name, ws.slice(head.i + 1), st.dir, outputs);
        if (p) setBlock(st, 'process', p.message, 'extract:' + p.key);
      }
      if (tidy && !st.block) { let k = ''; try { k = keepIssue(x, head, st.dir, st, cfg); } catch (e) { k = ''; } if (k) setBlock(st, 'keep', k); }
      if (cfg.specGate !== false && !st.block) { const t = archiveTarget(ws, head, st.dir); if (t) { const a = archiveIssue(t, st.dir, st.j); if (a) setBlock(st, a.noBypass ? 'archive-ok' : 'archive', a.msg, 'archive:' + a.name.toLowerCase()); } }
      const g0 = parseGit(ws, st.dir);
      if (!g0) continue;
      // 目录写在循环变量里（for r in a b c; do git -C "$r" …）：取值挨个代进去查；代不出来的按"算不出是哪个仓库"查
      let gits = [g0];
      if (g0.dyn) { const ex = expandLoopVars(ws, st.loops); const list = ex ? ex.map((w2) => parseGit(w2, st.dir)).filter(Boolean) : []; if (list.length && !list.some((x) => x.dyn)) gits = list; }
      for (const g of gits) {
      if (g.sub === 'push') { st.pushes.push(g); st.push = st.push || '[vibe-kit] 这是 git push' + (g.dyn ? '' : '（' + path.basename(repoRoot(g.dir) || g.dir) + '）') + '，推到远端要你确认。'; continue; }
      // 同一条命令里前面 git add 过的文件，提交时算已经加进去了
      if (g.sub === 'add' && !g.dyn) {
        for (const a of g.args) {
          if (a.text === '--' || a.text.startsWith('-') || dynamic(a)) continue;
          const abs = path.resolve(g.dir, local(a.text));
          st.added.add(normKey(abs));
          // 过程文件不提交。文件已经不在了的是在记删除，不管；. 和 :/ 这种整仓 add 由下面的提交检查拦
          if (!tidy || st.block || !fs.existsSync(abs) || /^(\.|\.\/|:\/?)$/.test(a.text)) continue;
          let isDir = /[\\/]$/.test(a.text);
          try { isDir = isDir || fs.statSync(abs).isDirectory(); } catch (e) { /* 不存在 */ }
          const p = tidy.processPath(abs, st.dir, isDir);
          if (p) { if (tidy.blockOnce(st.j.session_id, p.key)) setBlock(st, 'process', '[vibe-kit 过程文件] ' + p.show + ' 是过程文件（备份、日志、临时文件），不要提交：从这次 git add 里去掉，删掉或者挪进 .vibe/tmp/<事由>/。确实是项目要用的，原样再执行一次就行。'); continue; }
          if (!isDir) continue;
          const inside = tidy.untrackedProcessIn(abs, st.dir);
          if (inside.length && tidy.blockOnce(st.j.session_id, abs)) setBlock(st, 'process', '[vibe-kit 过程文件] git add ' + a.text + ' 会把里面还没进 git 的过程文件一起带上：' + inside.join('、') + '。先把它们删掉或者挪进 .vibe/tmp/<事由>/，或者只 add 要提交的文件。确实要一起提交，原样再执行一次就行。');
        }
      }
      // 提交信息格式可以申请放行；整仓 add、commit -a、gitlink（公司红线）不行
      if (cfg.commitCheck && !st.block) { const c = gitIssue(g, docs); if (c) setBlock(st, /提交信息不符合公司规范/.test(c) ? 'commit-format' : 'git-scope', c); }
      // 提案在别人电脑上也要能实施：命令写入和已经暂存的产物同样查，不能只守编辑工具。
      if (g.sub === 'commit' && !g.dyn && cfg.specGate !== false && !st.block) {
        try {
          const root = repoRoot(g.dir) || g.dir;
          const staged = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only', '-z'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\x00').filter(Boolean);
          const check = require('../lib/proposal-files');
          const found = [];
          for (const f of staged) {
            const abs = path.resolve(root, f); const art = require('../lib/session').artifactOf(abs);
            if (!art || art.kind === 'revisions' || /\/changes\/archive\//i.test(normKey(abs))) continue;
            const added = [...st.added].some((p) => normKey(abs) === p || normKey(abs).startsWith(p + '/'));
            const text = added ? fs.readFileSync(abs, 'utf8') : execFileSync('git', ['-C', root, 'show', ':' + f], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
            found.push(...check.issuesIn(text, art));
          }
          const dirs = new Map();
          for (const p of st.added) { const a = require('../lib/session').artifactOf(p); if (a && a.kind !== 'revisions' && !/\/changes\/archive\//i.test(p)) dirs.set(normKey(a.dir), a); }
          // git add 变更目录和逐文件 add 都要查；目录本身不是 artifactOf 能识别的产物。
          for (const c of allChanges(root)) if ([...st.added].some((p) => normKey(c.dir) === p || normKey(c.dir).startsWith(p + '/'))) {
            const a = require('../lib/session').artifactOf(path.join(c.dir, 'proposal.md'));
            if (a) dirs.set(normKey(a.dir), a);
          }
          for (const a of dirs.values()) found.push(...check.changeIssues(a));
          if (found.length) setBlock(st, 'spec', '[vibe-kit] 提案材料不能交付：' + found.slice(0, 3).join('\n'));
        } catch (e) { /* 检查出错照常放行，由收工再次核对 */ }
      }
      // 按提交方式判断能不能提交（consentIssue）。不能放行
      if (g.sub === 'commit' && !st.block && !commitAll(g.args)) { let c = ''; try { c = consentIssue(g, st, cfg, docs); } catch (e) { c = ''; } if (c) setBlock(st, 'commit-ok', c); }
      // 下面两道要去那个仓库里看：目录算不出来的不查
      if (g.dyn) continue;
      if (g.sub === 'commit' && cfg.commitCheck && !st.block && !commitAll(g.args)) { const n = newFilesIssue(g, st); if (n) setBlock(st, 'new-files', n); }
      // 提交前看有没有把密码、key 带进去：要用户确认，不拦
      }
    }
  }
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

/** 给查库、查 redis 的工具留的条子：这个目录里的这个会话现在算不算全自动（state/tool-flow.json） */
function noteToolFlow(j, cfg) {
  try {
    const k = normKey(path.resolve(j.cwd || process.cwd()));
    const now = Date.now();
    updateState('tool-flow', (o) => {
      const by = o.byCwd && typeof o.byCwd === 'object' ? o.byCwd : {};
      for (const x of Object.keys(by)) if (now - (Number(by[x] && by[x].at) || 0) > 600000) delete by[x];
      // 只在做任务那一段（apply）按全自动：写需求那一段的"需求自动"不能让查库工具改库不要确认串（审核问题 16）
      by[k] = { auto: cfg.autoMode === true && flowState(j).stage === 'apply', at: now, sid: String(j.session_id || '').slice(0, 8) };
      return { byCwd: by, at: now };
    });
  } catch (e) { /* 留不了：工具按用户不在算，只会更严 */ }
}

/**
 * 普通推送（用户说了推送就直接推）：不带参数（-u 除外）、推到当前分支跟踪的那个远端分支。强推、删远端分支、推到别的分支、
 * 目标看不清（命令里有变量）的返回 false，在确认框里问。原来在 lib/merge-push.js 的 plainAllowed，合并推送取消后挪到这里（2026-10-28）
 */
function plainPush(g) {
  try {
    if (g.dyn) return false;
    const W = require('../lib/workspace');
    const args = g.args.map((a) => a.text);
    if (args.some((a) => a.startsWith('-') && !['-u', '--set-upstream'].includes(a))) return false;
    const root = W.git(g.dir, ['rev-parse', '--show-toplevel']).trim();
    if (!root) return false;
    const ref = W.git(root, ['symbolic-ref', '-q', 'HEAD']).trim();
    if (!ref.startsWith('refs/heads/')) return false;
    const branch = ref.slice(11);
    const remotes = W.git(root, ['remote']).split(/\r?\n/).filter(Boolean);
    const remote = W.git(root, ['config', '--get', 'branch.' + branch + '.remote']).trim() || (remotes.length === 1 ? remotes[0] : '');
    const merge = W.git(root, ['config', '--get', 'branch.' + branch + '.merge']).trim() || ref;
    const pos = args.filter((a) => !a.startsWith('-'));
    if (!remote || pos.length > 2) return false;
    if (pos[0] && pos[0] !== remote) return false;
    if (pos[1] && ![ref, branch, 'HEAD', ref + ':' + merge, branch + ':' + merge.slice(11), 'HEAD:' + merge, 'HEAD:' + merge.slice(11)].includes(pos[1])) return false;
    return true;
  } catch (e) { return false; }
}

function check(j) {
  // IDEA 的终端、工具路由也走现有检查；认不出是 IDEA 的 MCP 只查路径参数读不读套件令牌（lib/idea-tools.js）。
  if (/^mcp__/.test(String(j.tool_name || ''))) {
    const out = require('../lib/idea-tools').handle(j); if (out) return out;
    const issue = require('../lib/flow-policy').actionIssue(j);
    return issue ? blockOut('PreToolUse', '[vibe-kit] ' + issue) : null;
  }
  const cmd = String((j.tool_input && j.tool_input.command) || '');
  if (!cmd.trim()) return null;
  // 前面这几段各记一个阶段名：12 秒预算在第一次登记阶段之前花完时，报错里以前只写"开始"，看不出慢在哪（旧 #181）
  const I = require('../lib/invocation');
  I.phase('命令：读开关');
  let cfg = readConfigFor(j);
  // 全自动模式开着、这个会话还没进 OpenSpec 流程，这条命令在建变更（用户用大白话让它出提案，它照 OpenSpec 的步骤做）：从这时起算进了流程
  // 建变更是写提案那一段（plan）：全自动还不算数，用户要看过提案、说了开工才算
  if (cfg.autoSwitch && !cfg.autoMode && !flowState(j).on && /(^|[\s;&|("'])openspec(\.cmd)?\s+new\s+change\b/i.test(cmd)) { setFlow(j, true, '建了变更', 'plan'); hookLog('全自动模式 这个会话进了 OpenSpec 流程：建了变更（写提案那一段，照有人在的样子来）'); cfg = readConfigFor(j); }
  // 查库、查 redis 的工具只看得到开关，看不到这个会话在不在流程里：跑它们之前留一张条子（按当前目录记，工具那头两分钟内认），
  // 说这个会话现在算不算全自动。不留的话，开关开着、用户却在场的会话里，工具会照"用户不在"来
  if (cfg.autoSwitch && /\b(db\.py|redis\.js)\b/i.test(cmd)) noteToolFlow(j, cfg);
  const ps = j.tool_name === 'PowerShell';
  // cd 和别的命令串在一条里。放在改套件、读令牌那几道后面查：那几道的话更要紧（它们拦下时顺带提一句）
  I.phase('命令：串着 cd');
  let cdHit = null;
  try { cdHit = ps ? null : cdCompoundIssue(cmd, j.cwd); } catch (e) { cdHit = null; }
  // 不走拦截编号的几处（串着 cd、关钩子、调路由的接口、全自动下的 push）也数一笔：哪条规矩拦得多，使用情况里要看得到
  const counted = (kind, text) => { try { if (feedback && feedback.countBlock) feedback.countBlock(kind, text, String(j.session_id || '')); } catch (e) { /* 数不了不影响 */ } return blockOut('PreToolUse', text); };
  I.phase('命令：审查预算和决定');
  const budgetIssue = require('../lib/review-runner').budgetIssue(j);
  if (budgetIssue) return counted('review-budget', '[vibe-kit 审查预算] ' + budgetIssue);
  const decisionIssue = require('../lib/review-runner').decisionIssue(j);
  if (decisionIssue) return counted('review-decision', '[vibe-kit 审查决定] ' + decisionIssue);
  const cdBlock = () => {
    if (!cdHit) return null;
    hookLog('guard-commit 拦下串着 cd 的命令：' + cmd.replace(/\s+/g, ' ').slice(0, 100));
    return counted('cd', cdCompoundText(cdHit, j.cwd));
  };
  I.phase('命令：改套件和路由接口');
  if (cfg.kitLock !== false) {
    // disableAllHooks 会把套件的检查一起关掉：只在命令要写东西的时候拦。只读的命令（grep 排查、cat）、提交信息、文档里提到这个词不拦
    if (/disableAllHooks/i.test(cmd) && !readOnlyCommand(cmd, ps) && (/settings[\w.-]*\.json/i.test(cmd) || /(>|\b(set-content|sc|out-file|add-content|ac|tee|tee-object)\b|sed\s+-i|writefile|write_text|\.write\s*\(|\bnode(\.exe)?\s+-e\b|\bpython3?(\.exe)?\s+-c\b)/i.test(cmd))) return counted('kit', '[vibe-kit] 不许写 disableAllHooks：它会把套件的所有检查一起关掉。钩子拦错了就把原因告诉用户，由用户来定；不要绕过。');
    const api = routerApiIssue(cmd, ps, j.cwd);
    if (api) return counted('kit', api);
  }
  // push 不看任何开关，没有当场授权就确认；拆命令没认出来的写法由 pushAnywhere 兜底
  I.phase('命令：发布和推送');
  const publishing = publishAnywhere(cmd, j.cwd);
  // 推送：用户说了"推送""push"就直接推（用户 2026-10-25 定的）。合并推送（合并预览、计划、合成一条）2026-10-28 取消（用户定的），"合并推送"也算说了推送
  let pushSaid = { ok: false, text: '' };
  try { if (j.transcript_path) pushSaid = userSaid(tailEntries(j.transcript_path, 3000000), 'push'); } catch (e) { pushSaid = { ok: false, text: '' }; }
  const publishNotice = '[vibe-kit] 这条命令会把 vibe-kit 的安装包发布到团队的 GitLab 仓库（里面有 git push，同事的电脑会跟着更新），发布要你确认。';
  const pushAsk = pushAnywhere(cmd, ps) ? '[vibe-kit] 这条命令里有 git push，推到远端要你确认。' : publishing ? publishNotice : '';
  if (cfg.kitLock === false && !pushAsk && !mayTouchSecret(cmd, j.cwd) && !/>/.test(cmd) && !/\.(sh|ps1|bat|cmd)\b/i.test(cmd) && !/\b(git|openspec|mv|move|move-item|mi|rename-item|rni|ren|robocopy|cmd|bash|sh|powershell|pwsh|taskkill|stop-process|spps|kill|pkill|killall|wmic|mvnw?|gradlew?|npm|cnpm|pnpm|yarn|npx|vite|vue-cli-service|webpack|webpack-dev-server|http-server|live-server|nodemon|catalina|startup|java|python3?|py|flask|uvicorn|gunicorn|cp|copy|xcopy|copy-item|cpi|tee|tee-object|out-file|set-content|sc|add-content|ac|xargs|start|start-process|saps|invoke-expression|iex|call|nohup|env|cross-env|rm|rmdir|rd|del|erase|remove-item|ri|unlink|find|jar|tar|gtar|bsdtar|unzip|7z|7za|7zr|7zz|expand-archive)\b/i.test(cmd)) return cdBlock();
  const cwd0 = path.resolve(j.cwd || process.cwd());
  const st = { dir: cwd0, cwd0, pushed: [], pushes: [], block: '', kind: '', target: '', ask: '', push: '', publishing: false, j, added: new Set(), passes: [], used: [], blocked: {}, sig: '', loops: {}, tempIndex: tempIndexOf(cmd) };
  // 先按名字挑出进程再结束的写法（Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process）：拆成组之后认不出来，整条看一遍
  I.phase('命令：结束进程');
  if (!st.block) { const k = killAnywhere(cmd, ps); if (k) setBlock(st, 'kill', k); }
  // 兜底放行：这个会话里申请过、还能用的通行证
  I.phase('命令：放行记录');
  const action = (j.tool_name || 'Bash') + '：' + cmd;
  try { if (feedback) { st.sig = feedback.sigOf([j.tool_name || 'Bash', cmd.trim()]); st.passes = feedback.validPasses(cfg, j); } } catch (e) { st.passes = []; }
  analyze(cmd, ps, st, cfg, 0);
  if (st.publishing) st.push = publishNotice;
  else if (!st.push && pushAsk) st.push = pushAsk;
  if (st.block) {
    let tail = '';
    try { if (feedback && st.sig) tail = feedback.registerBlock(j, st.kind, st.sig, st.block, action, st.target); } catch (e) { /* 记不了编号也照样拦 */ }
    // 不能放行的（改套件、读令牌、结束路由、整仓 add）：全自动模式下不让它停下等人。
    // 过程文件先留着那一道不算：它本来就不用做什么，也没有要留给用户的事
    if (!tail && cfg.autoMode && st.kind !== 'keep') {
      tail = '\n全自动模式：我不在，不要停下等我。这条命令不要跑：照上面说的换一个做法；换不了，就把这一步留给我，写进最后的交代，接着做别的。';
      try { if (report) report.note(j, { kind: 'hand', title: '没让它跑：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail: st.block.split(/\r?\n/)[0].replace(/^\[vibe-kit[^\]]*\]\s*/, '') }); } catch (e) { /* 记不了不影响 */ }
    }
    // 这条命令还串着 cd：一起说，免得改完这一处、再跑又被拦一次
    const cdNote = cdHit ? '\n另外，这条命令里 cd 和别的命令串在一起，Claude Code 会停下来等人点确认：改的时候把 cd 去掉，git 用 git -C <目录>，Maven 用 mvn -f <目录>/pom.xml，npm 用 npm --prefix <目录>，别的写完整路径。' : '';
    return blockOut('PreToolUse', st.block + tail + cdNote);
  }
  const cb = cdBlock();
  if (cb) return cb;
  const actionIssue = require('../lib/flow-policy').actionIssue(j);
  if (actionIssue) return counted('manual-action', '[vibe-kit] ' + actionIssue);
  // 全自动模式：用户不在，确认框没人点，会一直挂着。push、发布直接拦下，记进报告；提交里像有密码的放行，记进报告
  // 推送代码的授权不能用于发布内网安装包，发布仍单独确认。
  // 普通 git push（用户 2026-10-25 定的，问题反馈表第 5 条）：用户说了"推送""push"就直接推，几笔提交都一样，不出推送计划；
  // 壳子里几个仓库各推一次。强推、删远端分支、推到别的分支在确认框里问
  const pushes = st.publishing ? [] : st.pushes;
  let pushConfirm = false;
  if (pushes.length) {
    const noteHand = (detail) => { if (cfg.autoMode) { try { if (report) report.note(j, { kind: 'hand', title: '它想执行 git push，没让做：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail }); } catch (e) { /* 记不了也拦 */ } } };
    if (!pushSaid.ok) { noteHand('用户没说推送'); return counted('auto-push', '[vibe-kit 推送] 这条命令里有 git push，用户没说推送。用户说"推送""push"再推（直接推，不用推送计划）。' + (cfg.autoMode ? '全自动模式也一样：提交留在本地，最后的交代里说一句哪些还没推。' : '')); }
    if (!pushes.every((g) => plainPush(g))) pushConfirm = true;
  }
  if (pushConfirm) st.push = '[vibe-kit] 这条 git push 带了强推、删远端分支这类参数，或者推到的不是当前分支跟踪的那个远端分支，要你确认。';
  const pushRoots = pushes.length ? [...new Set(pushes.map((g) => repoRoot(g.dir) || g.dir))] : [repoRoot(st.dir) || st.dir];
  // 只在引号、命令替换里认出来的 push（拆不出是哪条 git push）：查不了推到哪、是不是强推，用户说过推送也要确认（复审 S1）
  const pushApproved = !!st.push && !st.publishing && pushSaid.ok && !pushConfirm && pushes.length > 0 && pushRoots.every((r) => require('../lib/permissions').allow(j, 'push', r, j.tool_use_id).ok);
  if (cfg.autoMode) {
    if (st.push && !pushApproved) {
      hookLog('guard-commit 全自动模式不 push：' + cmd.slice(0, 80));
      try { if (report) report.note(j, { kind: 'hand', title: '它想' + (/发布/.test(st.push) ? '发布安装包' : '执行 git push') + '，没让做：' + cmd.replace(/\s+/g, ' ').slice(0, 120), detail: '推到远端要你自己来' }); } catch (e) { /* 记不了不影响 */ }
      return counted('auto-push', '[vibe-kit] 全自动模式：' + (/发布/.test(st.push) ? '发布' : 'push') + '留给用户做，已经记进全自动报告。不要再试，也不要等：提交留在本地，接着做别的；最后的交代里说一句哪些提交还没推。');
    }
    if (st.used.length) return feedback.bypassOutcome(st.used, cfg, j, st.blocked, action);
    return null;
  }
  const ask = pushApproved ? '' : st.push;
  if (st.used.length) {
    const out = feedback.bypassOutcome(st.used, cfg, j, st.blocked, action);
    // 放行申请和 push 确认一起问
    if (ask) return askOut(ask + (out ? '\n' + out.hookSpecificOutput.permissionDecisionReason : ''));
    return out;
  }
  if (ask) return askOut(ask);
  return null;
}

/**
 * 检查都过了、照常放行的命令：里面以 openspec 开头的段，改成调用套件自带的那份（lib/openspec.js，用户 2026-10-17 定的集成 OpenSpec）。
 * 用 PreToolUse 的 updatedInput 改写，2.1.120、2.1.259、2.1.289 实测都支持。项目还没初始化 OpenSpec 的先初始化。
 * 检查拦下、要问的照旧（不改写）；自带的用不了（Node 版本不够）、出错，都让原命令照常跑
 */
function handle(j) {
  const out = check(j);
  if (out || /^mcp__/.test(String(j.tool_name || ''))) return out;
  try {
    const O = require('../lib/openspec');
    const next = O.rewrite(String((j.tool_input && j.tool_input.command) || ''), j.tool_name === 'PowerShell');
    if (!next) return out;
    const at = O.ensureRoot(j.cwd || process.cwd());
    if (at) hookLog('guard-commit 自带的 OpenSpec 在 ' + at + ' 建了 openspec/');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: Object.assign({}, j.tool_input, { command: next }) } };
  } catch (e) { try { feedback.recordHookError('guard-commit OpenSpec 改写', j, e); } catch (x) { /* 记不了也放行 */ } return out; }
}

module.exports = { handle, preprocess, stripComments, splitCommand, words, scanRedirects, parseGit, messageOf };
// 命令方式下出错、超出 12 秒预算：别的检查照旧放行，像推送的不放行（push 只留钩子这一道确认，复审 S3）
if (require.main === module) cli(handle, { onError: (j, e) => require('../lib/session').pushFailOut(j, (e && e.message) || e) });

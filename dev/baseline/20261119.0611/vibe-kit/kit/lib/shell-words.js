'use strict';
/*
 * 拆命令（2026-11-01 从 guard-commit 拆出来，K 批）：按 Bash 或 PowerShell 各自的引号和转义规则拆成组、段、词。
 *   heredoc、here-string 的正文是数据，不当命令拆；注释（# 到行尾）去掉；续行先合并；按没加引号的 && || ; 换行分组，每组再按 | 分段。
 *   headOf 认一段命令真正的命令名（跳过 sudo、env、time 这类包装）；innerCommand 解开包着的命令（bash -c、cmd /c、powershell -Command、跑的脚本）。
 * 只拆不判断：要不要拦由 guard-git、guard-kit、guard-process、guard-archive 判断。lib/openspec.js 改写 openspec 命令也用它。
 */
const fs = require('fs');
const path = require('path');
const { expandHome } = require('./session');

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

const cleanWord = (t) => String(t || '').replace(/^[{(]+|[})]+$/g, '');

module.exports = { stripComments, preprocess, splitCommand, scanRedirects, words, headOf, innerCommand, cdTarget, docOf, local, dynamic, dynamicPath, baseName, joinWords, repoRoot, substitutions, expandLoopVars, cleanWord, OPEN, CLOSE, CD, PUSHD, POPD, CONTROL, WRAPPER, HD };

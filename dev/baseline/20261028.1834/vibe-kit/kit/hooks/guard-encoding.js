'use strict';
/*
 * PreToolUse 钩子（改文件时）：拦住会把中文写坏的 Edit / Write。
 * 原因（实测过）：Claude Code 读写文件只认 UTF-8。用 Edit 改 GBK 文件里的一个数字，数字改对了，
 * 但整个文件的中文全部变成乱码写回磁盘，工具照常返回成功；用 Write 重写，文件被悄悄转成 UTF-8。
 *
 * 拦三种情况：
 *   1. 目标文件是 GBK（严格按 UTF-8 解不开、严格按 GBK 能解开）
 *   2. 目标文件里 GBK 和 UTF-8 的行混着（老工程里有人用 UTF-8 编辑器加过几行）
 *   3. 目标是新文件或纯英文文件，要写进去的内容带中文，而同目录的同类文件以 GBK 为主
 * 该怎么办取决于这个工程以哪种编码为主：UTF-8 为主就可以把这一个 .java 转过去；
 * GBK 为主就不能单转（按 GBK 编译时会编不过，或者字符串静默变乱码），要停下来让用户定。
 * 周围一个带中文的同类文件都没有时，先看 pom.xml / build.gradle 里声明的编码；还判断不了就按 GBK 为主处理，不给转码建议。
 * 套件自己和 Claude Code 按 UTF-8 读的文件（.vibe/、.claude/、openspec/、CLAUDE.md）不看"目录以 GBK 为主"。
 * 判断不了的（二进制、读到的不是明文）一律放行，宁可漏拦也不误拦。
 * .vibe 进 .gitignore 的事由 pre-edit 在确定放行之后做，这里不做。
 */
const fs = require('fs');
const path = require('path');
const { blockOut, cli } = require('../lib/session');

const hasHigh = (buf) => { for (let i = 0; i < buf.length; i++) if (buf[i] >= 0x80) return true; return false; };
const strict = (enc, buf) => { try { new TextDecoder(enc, { fatal: true }).decode(buf); return true; } catch (e) { return false; } };

/** ascii / utf8 / gbk / mixed / unknown */
function classify(buf) {
  if (buf.subarray(0, 8192).includes(0)) return 'unknown';
  if (strict('utf-8', buf)) return hasHigh(buf) ? 'utf8' : 'ascii';
  if (strict('gbk', buf)) return 'gbk';
  // 按行判断：换行符 0x0A 不会出现在 GBK 的双字节里，可以放心按它切
  let g = 0, x = 0, start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== 0x0a) continue;
    const line = buf.subarray(start, i);
    start = i + 1;
    if (!hasHigh(line) || strict('utf-8', line)) continue;
    if (strict('gbk', line)) g++; else x++;
  }
  return (x === 0 && g > 0) ? 'mixed' : 'unknown';
}

const MAX_LOOKED = 80;   // 普查最多看多少个同类文件（含纯英文的）：3000 个纯英文 .java 的包里也不会慢
/** 同目录（不够再看上一级及其子目录）里同扩展名的文件，含中文的有几个是 GBK、几个是 UTF-8 */
function surveyDir(file) {
  const ext = path.extname(file).toLowerCase();
  const seen = new Set([path.resolve(file)]);
  let gbk = 0, utf8 = 0, read = 0, looked = 0;
  const look = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      if (read >= 20 || looked >= MAX_LOOKED) return;
      if (path.extname(n).toLowerCase() !== ext) continue;
      const p = path.resolve(dir, n);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        looked++;
        const c = classify(fs.readFileSync(p));
        if (c === 'ascii' || c === 'unknown') continue;
        read++;
        if (c === 'utf8') utf8++; else gbk++;
      } catch (e) { /* 读不了就跳过 */ }
    }
  };
  const dir = path.dirname(path.resolve(file));
  look(dir);
  if (gbk + utf8 < 3) {
    const up = path.dirname(dir);
    look(up);
    try { for (const n of fs.readdirSync(up)) { if (read >= 20 || looked >= MAX_LOOKED) break; const p = path.join(up, n); if (p !== dir && fs.statSync(p).isDirectory()) look(p); } } catch (e) { /* 忽略 */ }
  }
  return { gbk, utf8, gbkMajor: gbk > 0 && gbk >= utf8, none: gbk + utf8 === 0 };
}

/**
 * 构建文件里声明的源码编码：往上找 pom.xml / build.gradle(.kts)，找到就返回 'utf8' | 'gbk'，没声明返回 ''。
 * pom 只认 sourceEncoding 和编译插件的 <encoding>：pom 开头的 <?xml … encoding="UTF-8"?> 说的是 pom 自己的编码，
 * 不是源码的（老工程的 pom 常常没写 sourceEncoding，按平台编码 GBK 编译）
 */
function declaredEncoding(file) {
  let d = path.dirname(path.resolve(file));
  for (let i = 0; i < 12; i++) {
    for (const n of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      let t = '';
      try { t = fs.readFileSync(path.join(d, n), 'latin1'); } catch (e) { continue; }
      if (n === 'pom.xml') t = t.replace(/<\?xml[^>]*\?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
      const m = t.match(/<project\.build\.sourceEncoding>\s*([\w-]+)\s*</i) || t.match(/<encoding>\s*([\w-]+)\s*<\/encoding>/i) || (n !== 'pom.xml' && t.match(/encoding\s*=\s*['"]([\w-]+)['"]/i));
      if (m) return /^utf-?8$/i.test(m[1]) ? 'utf8' : /^(gbk|gb2312|gb18030|cp936)$/i.test(m[1]) ? 'gbk' : '';
    }
    if (fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}

/** 套件自己、Claude Code、OpenSpec 按 UTF-8 读的文件：不看"目录以 GBK 为主" */
const UTF8_OWNED = /(^|[\\/])(\.vibe|\.claude|openspec)[\\/]|(^|[\\/])(CLAUDE|AGENTS)\.md$/i;

function newText(input) {
  const parts = [input.content, input.new_string];
  if (Array.isArray(input.edits)) input.edits.forEach((e) => parts.push(e && e.new_string));
  return parts.filter((s) => typeof s === 'string').join('\n');
}
const stop = (lines) => blockOut('PreToolUse', lines.join('\n'));
/** 这个会话里这件事还没拦过：记下来，返回 true；拦过了返回 false（原样再做一次就放行） */
function onceFor(j, key) {
  const sid = String((j && j.session_id) || '');
  if (!sid) return true;
  try {
    const { readState, writeState } = require('../lib/session');
    const k = sid + '-encoding-once';
    const st = readState(k);
    const list = Array.isArray(st.keys) ? st.keys : [];
    if (list.includes(key)) return false;
    return !!writeState(k, { keys: list.concat(key).slice(-100), at: Date.now() });
  } catch (e) { return true; }
}

function handle(j) {
  const input = j.tool_input || {};
  let file = input.file_path || input.path;
  if (!file) return null;
  if (!path.isAbsolute(file) && j.cwd) file = path.resolve(j.cwd, file);

  let cls = 'new';
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) return null;
    cls = st.size === 0 ? 'ascii' : classify(fs.readFileSync(file));
  }
  if (cls === 'utf8' || cls === 'unknown') return null;

  const tool = path.join(__dirname, '..', 'tools', 'to-utf8.js').split(path.sep).join('/');
  const isJava = /\.java$/i.test(file);

  if (cls === 'mixed') {
    return stop(['已拦下：' + file + ' 里 GBK 和 UTF-8 的行混在一起（多半是有人用 UTF-8 编辑器往 GBK 文件里加过几行）。直接 Edit / Write 会把其中 GBK 的中文全部写坏。',
      '这种文件没法自动处理。停下来告诉用户，让用户在 IDE 里把它统一成一种编码之后再改。']);
  }
  if (cls === 'gbk') {
    const s = surveyDir(file);
    // 周围没有样本：看构建文件声明的编码；没声明就按 GBK 为主（这个文件本身就是 GBK）
    const gbkMajor = s.none ? declaredEncoding(file) !== 'utf8' : s.gbkMajor;
    if (gbkMajor) {
      return stop(['已拦下：' + file + ' 是 GBK，' + (s.none ? '周围没有别的带中文的同类文件，构建文件里也没声明 UTF-8' : '而且同目录的同类文件也以 GBK 为主（含中文的：GBK ' + s.gbk + ' 个，UTF-8 ' + s.utf8 + ' 个）') + '，这个工程多半整体按 GBK 编译。',
        '不要单独把这一个文件转成 UTF-8：按 GBK 编译时它要么编不过，要么中文字符串静默变成乱码。直接 Edit / Write 也不行，会把整个文件的中文写坏。',
        '停下来告诉用户，由用户决定：整个工程统一转成 UTF-8 并改掉编译编码，或者这个文件由用户自己在 IDE 里改。']);
    }
    if (isJava) {
      return stop(['已拦下：' + file + ' 是 GBK，直接 Edit / Write 会把整个文件的中文写坏。',
        (s.none ? '构建文件里声明的编码是 UTF-8' : '同目录的同类文件以 UTF-8 为主') + '，这个文件是少数派，可以先转成 UTF-8 再改：node "' + tool + '" "' + file + '"（会留备份并逐字校验）。',
        '转完之后告诉用户这个文件的编码变了。']);
    }
    return stop(['已拦下：' + file + ' 是 GBK，直接 Edit / Write 会把整个文件的中文写坏。',
      '这类文件（.js .css .htm .jsp .properties 等）可能被声明了 GBK 的页面引用，或者按 ISO-8859-1 读取，转码有风险。停下来告诉用户，由用户决定怎么处理，不要自己转。']);
  }

  // .ps1 里写中文：Write 写出来的是不带 BOM 的 UTF-8，Windows 自带的 PowerShell 5.1 按系统代码页（GBK）读它，
  // 中文变乱码，紧挨着的 } 有时被吞掉、报语法错。.vibe 里的探针脚本也一样。同一个文件只拦一次（跑它的是 PowerShell 7 的，再写一次就行）
  if ((cls === 'new' || cls === 'ascii') && /\.ps1$/i.test(file)) {
    const text = newText(input);
    let bom = false;
    try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(3); fs.readSync(fd, b, 0, 3, 0); fs.closeSync(fd); bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; } catch (e) { bom = false; }
    if (/[^\x00-\x7f]/.test(text.replace(/^﻿/, '')) && !bom && !text.startsWith('﻿') && onceFor(j, 'ps1:' + file)) {
      return stop(['已拦下：要写进 ' + file + ' 的内容带中文。Write / Edit 写出来的 .ps1 是不带 BOM 的 UTF-8，Windows 自带的 PowerShell 5.1 会按 GBK 去读：中文变乱码，有时还报"缺少右大括号"这类语法错。',
        '这样做：脚本里只写英文字符（要输出的中文放进一个 UTF-8 的文本文件，脚本里用 Get-Content -Encoding UTF8 读进来）；或者这个探针别用 PowerShell，写成 .js 用 node 跑。',
        '确定是用 PowerShell 7（pwsh）跑的，原样再写一次就行。']);
    }
  }

  // 新文件或纯英文文件：要写进去的内容带中文，而这个目录以 GBK 为主（套件、Claude Code、OpenSpec 按 UTF-8 读的文件不管）
  if ((cls === 'new' || cls === 'ascii') && !UTF8_OWNED.test(file) && /[^\x00-\x7f]/.test(newText(input))) {
    const s = surveyDir(file);
    if (s.gbkMajor) {
      return stop(['已拦下：要写进 ' + file + ' 的内容带中文，而同目录的同类文件以 GBK 为主（含中文的：GBK ' + s.gbk + ' 个，UTF-8 ' + s.utf8 + ' 个）。Write / Edit 只能写出 UTF-8，按 GBK 编译时这些中文会变成乱码，而且不报错。',
        '可以这样做：新增内容保持纯英文字符，Java 字符串和 .properties 里的中文写成 \\uXXXX 转义（两种编码下都正确），注释用英文。',
        '不想这样处理，就停下来告诉用户，由用户决定。']);
    }
  }
  return null;
}

module.exports = { handle, classify };
if (require.main === module) cli(handle);

'use strict';
/* 直接解包命令的落盘目录检查，由 guard-commit 在现有拆词和工作目录跟踪之后调用。
 * 临时查看归档不能在项目根、源码目录或 .vibe/tmp 根散落条目；只读列表和流式读取不落盘。
 * 不猜任意脚本和变量的执行结果，也不接管构建工具自己的产物或项目外的正式安装。
 * JAR 的 -C 在旧 JDK 中不是解包目标，保守地同时检查当前目录；--dir 只在支持它的 JDK 中执行。
 */
const path = require('path');
const { expandHome, normKey, realish } = require('./session');
const { projectRootOf, vibePart } = require('./tidy');

function value(w, skip) { return w ? { text: w.text.slice(skip || 0), raw: w.raw } : null; }
function resolveDir(dir, w) {
  if (!w || !w.text) return null;
  const raw = expandHome(String(w.raw).replace(/'[^']*'/g, ''));
  if (/\$[({\w]|`|%\w+%/.test(raw) || /[*?]/.test(w.text)) return null;
  let text = expandHome(w.text);
  if (process.platform === 'win32') text = text.replace(/^\/mnt\/([a-z])(?=\/|$)/i, '$1:').replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  return path.resolve(dir, text);
}

/** 返回解包的可能落盘目录；只读、无法确定或不是支持的命令返回空数组。 */
function targetsOf(name, args, dir) {
  let dest = null;
  let source = null;
  let extract = false;
  let readOnly = false;
  let unknown = false;
  const dirs = [];
  if (name === 'jar') {
    for (let i = 0; i < args.length; i++) {
      const w = args[i], t = w.text;
      if (t === '--') break;
      if (t === '-C' || t === '--dir') { dest = args[++i]; if (!dest) unknown = true; if (t === '-C') dirs.push(dir); }
      else if (t.startsWith('--dir=')) dest = value(w, 6);
      else if (t === '--file' || t === '-f') i++;
      else if (t.startsWith('--file=')) continue;
      else if (t === '--extract') extract = true;
      else if (/^(?:--list|--describe-module|--help(?::compat)?|--help-extra|--version|--validate)$/.test(t)) readOnly = true;
      else if (/^-[xvfk]+$/.test(t) || (i === 0 && /^[xvfk]+$/.test(t))) {
        if (t.includes('x')) extract = true;
        if (t.includes('f')) i++;
      } else if (t.startsWith('@')) unknown = true;
    }
    if (!extract || readOnly || unknown) return [];
  } else if (['tar', 'gtar', 'bsdtar'].includes(name)) {
    let at = dir;
    let members = false;
    for (let i = 0; i < args.length; i++) {
      const w = args[i], t = w.text;
      if (t === '--') { if (args[i + 1]) members = true; break; }
      if (t === '-C' || t === '--directory' || t.startsWith('--directory=') || /^-C.+/.test(t)) {
        const next = t === '-C' || t === '--directory' ? args[++i] : value(w, t.startsWith('--directory=') ? 12 : 2);
        if (members) dirs.push(at);
        at = resolveDir(at, next);
        if (!at) { unknown = true; break; }
      } else if (t === '--extract' || t === '--get') extract = true;
      else if (t === '--to-stdout' || t === '--list' || /^(?:--help|--version)$/.test(t)) readOnly = true;
      else if (t === '-f' || t === '--file' || t === '-T' || t === '--files-from' || t === '-X' || t === '--exclude-from') i++;
      else if (/^(?:-I|--use-compress-program|--exclude|--strip-components|--transform|--xform|--checkpoint-action|--warning|--owner|--group|--mode|--mtime|--newer|--newer-mtime|-N|-b|--blocking-factor|-H|--format|-K|--starting-file)$/.test(t)) i++;
      else if (/^--(?:file|files-from|exclude-from)=/.test(t)) continue;
      else if (/^-[^-]+$/.test(t) || (i === 0 && /^[cxtru][a-zA-Z]*$/.test(t))) {
        const allFlags = t.replace(/^-/, '');
        const f = allFlags.indexOf('f');
        const flags = f >= 0 ? allFlags.slice(0, f + 1) : allFlags;
        if (flags.includes('x')) extract = true;
        if (/[Ot]/.test(flags)) readOnly = true;
        // -xvf archive 与 -xfarchive 都认；f 后紧跟的内容是归档名，不能当成模式。
        if (f >= 0 && f === allFlags.length - 1) i++;
      } else if (!t.startsWith('-')) members = true;
    }
    if (!extract || readOnly || unknown) return [];
    dirs.push(at);
    return [...new Set(dirs)];
  } else if (name === 'unzip') {
    for (let i = 0; i < args.length; i++) {
      const w = args[i], t = w.text;
      if (t === '--') break;
      if (t === '-d') { dest = args[++i]; if (!dest) unknown = true; }
      else if (t.startsWith('-d')) dest = value(w, 2);
      else if (t.startsWith('-P')) { if (t === '-P') i++; }
      else if (/^-[^-]/.test(t) && /[plvtcZ]/.test(t.slice(1))) readOnly = true;
      else if (/^--(?:help|version)$/.test(t)) readOnly = true;
      else if (!t.startsWith('-')) source = source || w;
    }
    if (readOnly || unknown || !source) return [];
    extract = true;
  } else if (['7z', '7za', '7zr', '7zz'].includes(name)) {
    const mode = args.find(w => !w.text.startsWith('-'));
    if (!mode || !/^[xe]$/.test(mode.text)) return [];
    for (let i = 0; i < args.length; i++) {
      const w = args[i], t = w.text;
      if (t === '--') break;
      if (t === '-o') { dest = args[++i]; if (!dest) unknown = true; }
      else if (t.startsWith('-o')) dest = value(w, 2);
      else if (t === '-so' || t === '-h' || t === '--help') readOnly = true;
    }
    if (readOnly || unknown) return [];
    extract = true;
  } else if (/^(?:python\d*(?:\.\d+)?|py)$/.test(name)) {
    const m = args.findIndex(w => w.text === '-m');
    if (m < 0 || !args[m + 1] || !/^(?:zipfile|tarfile)$/.test(args[m + 1].text)) return [];
    const e = args.findIndex((w, i) => i > m + 1 && (w.text === '-e' || w.text === '--extract'));
    if (e < 0 || !args[e + 1]) return [];
    dest = args[e + 2] && !args[e + 2].text.startsWith('-') ? args[e + 2] : null;
    extract = true;
  } else if (name === 'expand-archive') {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const w = args[i], t = w.text;
      const m = /^-(destinationpath|destination|dest|literalpath|pspath|path)(?::(.*))?$/i.exec(t);
      if (m) {
        const next = m[2] !== undefined ? value(w, t.indexOf(':') + 1) : args[++i];
        if (!next) { unknown = true; break; }
        if (/^dest/i.test(m[1])) dest = next; else source = next;
      } else if (/^-(whatif|wi)(?::\$?true)?$/i.test(t)) readOnly = true;
      else if (/^-(erroraction|ea|errorvariable|ev|warningaction|wa|warningvariable|wv|informationaction|infa|informationvariable|iv|outvariable|ov|outbuffer|ob|pipelinevariable|pv|progressaction)$/i.test(t)) i++;
      else if (!t.startsWith('-')) positional.push(w);
    }
    if (readOnly || unknown) return [];
    if (!source) source = positional.shift();
    if (!dest) dest = positional.shift();
    // 没传目标时，PowerShell 在当前目录创建与 ZIP 同名的子目录，不是在 ZIP 所在目录。
    if (!dest) {
      if (source && /[*?]|\$|`/.test(source.text)) return [dir];
      const base = source && path.basename(source.text.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
      return [base ? path.resolve(dir, base) : dir];
    }
    extract = true;
  }
  if (!extract) return [];
  const at = dest ? resolveDir(dir, dest) : dir;
  if (!at) return [];
  return [...new Set(dirs.concat(at))];
}

function inReasonDir(dest) {
  const v = vibePart(dest);
  return !!v && /^tmp\/[^/]+(?:\/|$)/i.test(v.rel);
}

function isArchive(name, args) {
  if (/^(?:jar|tar|gtar|bsdtar|unzip|7z|7za|7zr|7zz|expand-archive)$/.test(name)) return true;
  const m = args.findIndex(w => w.text === '-m');
  return /^(?:python\d*(?:\.\d+)?|py)$/.test(name) && m >= 0 && args[m + 1] && /^(?:zipfile|tarfile)$/.test(args[m + 1].text);
}

/** 只拦项目中的已知落盘目录；返回 { key, message }，不读归档、凭据或任意脚本。 */
function issue(name, args, dir, outputs) {
  const destinations = targetsOf(name, args, dir).map(dest => ({ dest }));
  for (const w of outputs || []) {
    if (/^(?:\$null|\/dev\/null|nul)$/i.test(w.text)) continue;
    const file = resolveDir(dir, w);
    if (file) destinations.push({ dest: path.dirname(file), file });
  }
  for (const { dest, file } of destinations) {
    const actual = file ? path.dirname(realish(file)) : realish(dest);
    if (inReasonDir(dest) && inReasonDir(actual)) continue;
    const root = projectRootOf(path.join(dest, '__解包条目__'), dir) || projectRootOf(path.join(actual, '__解包条目__'), dir);
    if (!root) continue;
    const rel = path.relative(root, file || dest);
    const show = (!rel ? '项目根目录' : !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : dest).split(path.sep).join('/');
    return { key: normKey(file || dest), message: '[vibe-kit 归档解包] ' + (file ? '归档检查结果会写到 ' : name + ' 会把归档条目解到 ') + show + '，临时查看会污染项目。把落盘位置改成 .vibe/tmp/<事由>/，不能直接放 .vibe/tmp 根。\n'
      + '只看目录用 jar tf "<归档>" 或 unzip -l "<归档>"，只读条目用 unzip -p "<归档>" "<条目>"。需要落盘：先建事由目录，再用 unzip "<归档>" -d ".vibe/tmp/<事由>"，或 Expand-Archive -LiteralPath "<归档>" -DestinationPath ".vibe/tmp/<事由>"。\n'
      + (name === 'jar' ? '旧 JDK 的 jar -C 不能保证改变解包目标。用工具的工作目录参数指向事由目录，或单独切换到该目录再执行 jar xf "<归档完整路径>"，不要把切目录和解包串成一条 Bash 命令。\n' : '')
      + '解包样本不提交；变更材料需要交付给别人时，按提案材料规则整理进变更目录。若这是用户明确要求导入的正式项目文件，可说明用途后申请这条检查的放行；原样重试不会自动放行。' };
  }
  return null;
}

module.exports = { targetsOf, isArchive, issue };

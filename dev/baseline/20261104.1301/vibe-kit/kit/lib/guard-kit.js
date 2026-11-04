'use strict';
/*
 * 改套件、读令牌和模型的 key、改经验规则、直接调配置页接口的检查（2026-11-01 从 guard-commit 拆出来，K 批）。
 * 规矩写在 hooks/guard-commit.js 开头第 5 条；令牌和 key 什么时候都不给读（硬规矩 6），不看"禁止改套件"开关。
 */
const fs = require('fs');
const path = require('path');
let lessons = null;
try { lessons = require('./lessons.js'); } catch (e) { /* 老版本没有 */ }
const { normKey, KIT, CFG_DIR, realish, isKitPath, isKitSkillScript } = require('./session');
const { preprocess, splitCommand, scanRedirects, words, local, baseName, CONTROL, WRAPPER, headOf, CD, HD, docOf, innerCommand, cleanWord } = require('./shell-words');
const { parseGit } = require('./guard-git');

// ---------- 禁止改套件 ----------
const READ_ONLY = new Set(['cat', 'type', 'head', 'tail', 'less', 'more', 'get-content', 'gc', 'ls', 'dir', 'get-childitem', 'gci', 'tree', 'grep', 'rg', 'findstr', 'select-string', 'sls', 'find', 'wc', 'stat', 'test-path', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'certutil', 'get-filehash', 'diff', 'fc', 'compare-object', 'echo', 'write-output', 'write-host', 'pwd', 'get-location', 'get-item', 'gi', 'get-itemproperty', 'gp', 'jq', 'sort', 'sort-object', 'uniq', 'select-object', 'select', 'where-object', 'where', 'measure-object', 'measure', 'format-list', 'fl', 'format-table', 'ft', 'out-string', 'convertfrom-json', 'resolve-path', 'split-path', 'join-path', 'realpath', 'readlink', 'dirname', 'basename', 'du', 'od', 'xxd', 'hexdump', 'strings', 'cut', 'column', 'nl', 'sed', 'awk', 'perl']);

// 会改东西的命令名。只看命令名（和 xargs、find -exec 后面跟的命令名），不看别的词：grep "install" 里的 install 是要搜的字，不是要装什么
const DESTRUCTIVE = /^(rm|rmdir|rd|del|erase|remove-item|ri|clear-content|clc|set-content|sc|add-content|ac|out-file|tee|tee-object|cp|copy|copy-item|cpi|xcopy|robocopy|mv|move|move-item|mi|rename-item|rni|ren|new-item|ni|mkdir|md|touch|truncate|chmod|attrib|icacls|takeown|install|ln|mklink|set-itemproperty|sp|clear-item|xargs|unzip|tar|7z|expand-archive|compress-archive|invoke-webrequest|iwr|curl|wget)$/i;

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
 * 不许直接调配置页的接口（/api/kit）：出现配置页要的请求头 x-vibe-router、老版本钩子入口的路径，
 * 或者本机地址（127.x、localhost、[::1]、0.0.0.0）后面跟的端口按数值等于配置页的端口（015731、0x3d73 这种写法也认），就拦
 */
function configApiIssue(cmd, ps, cwd) {
  const msg = '[vibe-kit] 不许直接调配置页的接口改套件：开关、本机环境、问题反馈只能用户在配置页里改（/vk-config）。你想改什么，告诉用户。';
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
  const ports = new Set([15731]);
  try { ports.add(Number(JSON.parse(fs.readFileSync(path.join(KIT, 'state', 'config-page.json'), 'utf8')).port)); } catch (e) { /* 配置页没起 */ }
  const re = /(?:127(?:\.\d+){0,3}|localhost|\[[0:]*:1\]|\[::\]|0\.0\.0\.0)\s*:\s*(0x[0-9a-f]+|\d+)/gi;
  let m;
  while ((m = re.exec(text))) { const p = /^0x/i.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1], 10); if (ports.has(p)) return msg; }
  return '';
}

/** 整条命令都是只读的（每一段的命令名都在只读名单里、没有往文件写的重定向、没有包着别的命令） */
/** cwd：命令在哪个目录跑（审核 P12） */
function readOnlyCommand(cmd, ps, cwd) {
  const { s, docs } = preprocess(cmd, ps);
  for (const group of splitCommand(s, ps)) {
    for (const seg of group) {
      const r = scanRedirects(seg);
      if (r.list.some((x) => !/^(\$null|\/dev\/null|nul)$/i.test(x.target))) return false;
      const ws = words(r.rest, ps);
      if (!ws.length) continue;
      const h = headOf(ws);
      if (!READ_ONLY.has(h.name) || destructiveSeg({ ws }, h) || innerCommand(ws, h, cwd || process.cwd(), docs)) return false;
      if ((h.name === 'sed' || h.name === 'perl') && ws.some((w) => /^-[a-zA-Z]*i/.test(w.text))) return false;
    }
  }
  return true;
}

/** 这条命令（连同包在里面的）有没有会把文件内容读出来的命令 */
function hasReaderIn(cmd, ps, depth, cwd) {
  const { s, docs } = preprocess(cmd, ps);
  for (const group of splitCommand(s, ps)) {
    for (const seg of group) {
      const ws = words(scanRedirects(seg).rest, ps);
      if (!ws.length) continue;
      const h = headOf(ws);
      if (READERS.has(h.name) || /^(cat|type)$/.test(h.name)) return true;
      const inner = depth < 3 ? innerCommand(ws, h, cwd || process.cwd(), docs) : null;
      if (inner && hasReaderIn(inner.cmd, inner.ps, depth + 1, inner.dir || cwd)) return true;
    }
  }
  return false;
}

module.exports = { easyListing, mayTouchSecret, keyFileIssue, kitIssue, lessonIssue, configApiIssue, readOnlyCommand, hasReaderIn };

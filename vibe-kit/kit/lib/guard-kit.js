'use strict';
/*
 * 读令牌和模型的 key 的检查（2026-11-01 从 guard-commit 拆出来，K 批）。规矩写在 hooks/guard-commit.js 开头第 5 条。
 * 2026-11-04 仓库主人定的：套件可以改，"禁止改套件"那个开关和改套件、改经验规则、调配置页接口、写 disableAllHooks 这几道检查都去掉了；
 * 读 secrets.json、router-data 照拦。
 */
const path = require('path');
const { normKey, KIT, realish, isKitPath } = require('./session');
const { preprocess, splitCommand, scanRedirects, words, local, CONTROL, WRAPPER, headOf, innerCommand } = require('./shell-words');

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
    // 重定向到令牌文件（echo x > secrets.json）：放在下面"只是列一下"的跳过之前。以前 echo 走到那里就跳过了，靠"不许改套件"兜着；
    // 2026-11-04 那道去掉之后漏出来（自审发现）
    for (const r of x.redirs) { const why = secretTouch(r.target, dir, h.name, false); if (why) return '[vibe-kit] 这条命令会碰到令牌或者模型的 key（' + r.target + '），不许动。'; }
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

module.exports = { easyListing, keyFileIssue, hasReaderIn };

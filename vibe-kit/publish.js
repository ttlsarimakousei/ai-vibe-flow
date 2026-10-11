'use strict';
/*
 * 把这个安装包发布到内网 GitLab 的仓库：同事的电脑会自己发现新版、自己装上（kit/lib/updater.js）。
 * 在解压出来的安装包目录里运行（双击"发布到 GitLab（双击我）.bat"）。只给维护套件的人用。
 *
 * 顺序：
 *   1. 这台电脑的自动更新关掉：发布的电脑每次都是先装再发，用不着自动更新（开着的话，它会跟着仓库走，把刚装的新版换回仓库里的旧版）
 *   2. 在这台电脑上装一遍（和双击"安装"完全一样），再自检。装不上、自检不过就停，不发布——自己都装不上的包不能发给别人
 *   3. 连仓库。走哪条路和自动更新一样（手填的令牌 / SSH 密钥 / 这台电脑上 git 登录的身份），仓库地址在配置页里填
 *   4. 看仓库里现在是什么：
 *        空的                      第一次发布
 *        不是套件的安装包          不发（发布会把仓库里原来的文件换掉）。确实要用这个仓库，加 --force
 *        同一个版本号、内容一样    已经发过了，什么都不做
 *        同一个版本号、内容不一样  不发。重新打包、换一个版本号（装了这一版的电脑看版本号没变，不会更新）
 *        比这个包新                发布等于让所有人退回旧版。要确认（输入 yes），或者加 --rollback
 *   5. 推上去：一个提交（chore: 发布 vibe-kit <版本号>）加一个标签 v<版本号>（同事的电脑装坏了退回上一版靠它）
 *   6. 《更新说明.md》这一版里写了"修了 #编号"的议题：在下面留一句是哪一版修的，还开着的顺手关掉
 *
 *   node publish.js                 照上面的顺序
 *   node publish.js --no-install    不装，只发布（这一版已经装过了）
 *   node publish.js --dry-run       只看不推：说出会做什么
 *   node publish.js --rollback      仓库里的比这个新也发（全员退回这一版），不再问
 *   node publish.js --force         仓库里不是套件的安装包也发
 *   --no-router、--no-open          原样传给安装器
 *
 * 要推送权限：令牌要勾 write_repository；走 SSH 的话账号在项目里至少是 Developer，分支受保护的要 Maintainer。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY = has('--dry-run');
const VERSION_RE = /^\d{8}\.\d{4}$/;
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const KIT = path.join(CLAUDE, 'vibe-kit');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim(); } catch (e) { return ''; } };
const say = (s) => console.log('  ' + s);
let tmp = '';
function cleanup() { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 删不掉就留着，在系统的临时目录里 */ } tmp = ''; } }
function stop(msg, code) { console.log(''); console.log('  [X] ' + msg); cleanup(); process.exit(code === undefined ? 1 : code); }
function ask(q) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('  ' + q, (a) => { rl.close(); resolve(String(a || '').trim()); });
  });
}
/** 《更新说明.md》里这一版那一节写的"修了 #12、#15" */
function fixedIssues(version) {
  const text = readText(path.join(SRC, '更新说明.md'));
  const start = text.search(new RegExp('^##\\s+' + version.replace('.', '\\.'), 'm'));
  if (start < 0) return [];
  const rest = text.slice(start + 3);
  const end = rest.search(/^##\s/m);
  const sec = end < 0 ? rest : rest.slice(0, end);
  const out = new Set();
  const re = /修(?:了|复了?|好了?)\s*((?:#\d+[\s、,，和及]*)+)/g;
  let m;
  while ((m = re.exec(sec))) for (const n of m[1].match(/\d+/g) || []) out.add(Number(n));
  return [...out].sort((a, b) => a - b);
}

(async () => {
  console.log('');
  console.log('vibe-kit：发布到 GitLab' + (DRY ? '（只看不推）' : ''));
  // ---------- 这个目录是不是一个完整的安装包 ----------
  for (const f of ['install.js', 'settings.fragment.json', 'kit/VERSION', 'kit/lib/gitlab.js', 'kit/lib/updater.js', 'claude/CLAUDE.md', '更新说明.md']) if (!fs.existsSync(path.join(SRC, f))) stop('这里不是一个完整的安装包：缺 ' + f + '。要在解压出来的安装包目录里运行');
  const version = readText(path.join(SRC, 'kit', 'VERSION'));
  if (!VERSION_RE.test(version)) stop('版本号不对（kit/VERSION 里是"' + version + '"），应该像 20260928.1700。这个包不是打包脚本打出来的');
  if (!new RegExp('^##\\s+' + version.replace('.', '\\.'), 'm').test(readText(path.join(SRC, '更新说明.md')))) stop('《更新说明.md》里没有 ' + version + ' 这一版的说明。先写上这一版改了什么');
  say('这个安装包的版本：' + version);

  // ---------- 1. 这台电脑的自动更新关掉 ----------
  try {
    const f = path.join(KIT, 'config.json');
    let c = {};
    try { c = JSON.parse(readText(f) || '{}'); } catch (e) { c = null; }
    if (c && c.autoUpdate !== 'off') {
      if (!DRY) { c.autoUpdate = 'off'; fs.mkdirSync(KIT, { recursive: true }); fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n'); }
      say('[OK] 这台电脑的自动更新' + (DRY ? '会被关掉' : '已关掉') + '：发布的电脑每次都是先装再发，用不着自动更新');
    } else if (!c) say('[!] 这台电脑的开关文件（config.json）读不懂，没能关掉自动更新。不影响发布，可以在配置页里自己关');
  } catch (e) { say('[!] 没能关掉这台电脑的自动更新（' + ((e && e.message) || e) + '），不影响发布。可以在配置页里自己关'); }

  // ---------- 2. 在这台电脑上装一遍 ----------
  if (!has('--no-install')) {
    console.log('');
    say('第一步：先在这台电脑上装一遍');
    // VIBE_KIT_NO_UPDATE：安装器装完不甩后台的更新进程（这台电脑不用自动更新；攒下的问题反馈由之后的钩子去传）
    const r = spawnSync(process.execPath, [path.join(SRC, 'install.js')].concat(args.filter((a) => a === '--no-router' || a === '--no-open')), { cwd: SRC, stdio: 'inherit', windowsHide: true, env: Object.assign({}, process.env, { VIBE_KIT_NO_UPDATE: '1' }) });
    if (r.status !== 0) stop('这台电脑上没装成，发布停了：自己都装不上的包不能发给别人。先看上面安装器说了什么');
    if (readText(path.join(KIT, 'VERSION')) !== version) stop('装完之后版本号对不上（装着的是 ' + (readText(path.join(KIT, 'VERSION')) || '没有版本号') + '），发布停了');
    console.log('');
    say('[OK] 这台电脑上已经是 ' + version);
    // 装上了还要能用：和同事的电脑自动更新之后做的自检一样（每个钩子、每个库载得进来，状态栏跑得出来）
    let check = { ok: false, why: '自检没跑起来' };
    try { check = require(path.join(KIT, 'lib', 'updater.js')).selfCheck(); } catch (e) { check = { ok: false, why: String((e && e.message) || e) }; }
    if (!check.ok) stop('这一版装上之后自检没过（' + check.why + '），发布停了。这台电脑上现在装着的就是这个有问题的版本：修好重新打包，或者拿上一版的安装包重装一遍');
    say('[OK] 自检通过');
  }
  if (!fs.existsSync(path.join(KIT, 'lib', 'gitlab.js')) || !fs.existsSync(path.join(KIT, 'lib', 'updater.js'))) stop('这台电脑上装着的套件里没有发布要用的代码。去掉 --no-install 再跑一次');

  // ---------- 3. 连仓库 ----------
  const gl = require(path.join(KIT, 'lib', 'gitlab.js'));
  const up = require(path.join(KIT, 'lib', 'updater.js'));
  const s = gl.settings();
  console.log('');
  say('第二步：发布到 ' + gl.maskUrl(s.repo) + (s.isDefault ? '（默认的仓库地址）' : ''));
  if (!s.parsed.ok) stop('仓库地址不对：' + s.parsed.why + '。在配置页"自动更新和问题上报"里改');
  if (!gl.gitVersion()) stop('这台电脑上找不到 git');
  const head = up.remoteHead(s);
  if (!head.ok) stop(head.why + '。在配置页"自动更新和问题上报"里点"测试连接"看看是哪一步不通');
  const branch = head.branch || s.branch || 'main';
  say('连上了，走的是' + head.route.label + '；分支 ' + branch + (head.empty ? '；仓库是空的，这是第一次发布' : ''));

  // ---------- 4. 仓库里现在是什么 ----------
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-kit-publish-'));
  const gitDir = path.join(tmp, 'repo.git');
  const init = gl.git(tmp, ['init', '-q', '--bare', gitDir], { timeout: 60000 });
  if (init.code !== 0) stop(gl.explainGit(init, '建临时仓库'));
  // 临时仓库在系统的临时目录里，文件就用安装包目录里的这一份：不拷贝、不改动安装包目录
  const G = (a, opt) => gl.git(SRC, ['--git-dir=' + gitDir, '--work-tree=' + SRC].concat(a), Object.assign({ settings: s }, opt || {}));
  let remoteVersion = '';
  let remoteTree = '';
  if (!head.empty) {
    const f = gl.viaRoutes(s, (route) => G(['fetch', '-q', '--depth', '1', '--no-tags', route.url, branch], { route, timeout: 600000 }));
    if (f.code !== 0) stop(gl.explainRoutes(f, '读仓库里现在的内容'));
    G(['update-ref', 'refs/heads/publish', 'FETCH_HEAD']);
    const v = G(['show', 'FETCH_HEAD:kit/VERSION']);
    remoteVersion = v.code === 0 ? v.out.replace(/^﻿/, '').trim() : '';
    const isKit = VERSION_RE.test(remoteVersion) && G(['cat-file', '-e', 'FETCH_HEAD:install.js']).code === 0;
    remoteTree = G(['rev-parse', 'FETCH_HEAD^{tree}']).out.trim();
    if (!isKit) {
      const ls = G(['ls-tree', '--name-only', 'FETCH_HEAD']).out.split(/\r?\n/).filter(Boolean);
      // 只有一个说明文件的新仓库（建项目时勾了"用 README 初始化"）：当成空的
      const onlyReadme = ls.length > 0 && ls.every((n) => /^(readme(\.\w+)?|license(\.\w+)?|\.gitignore|\.gitattributes)$/i.test(n));
      if (!onlyReadme && !has('--force')) stop('仓库里现在放的不是 vibe-kit 的安装包（' + ls.slice(0, 6).join('、') + (ls.length > 6 ? ' 等 ' + ls.length + ' 项' : '') + '）。发布会把这些文件换掉，所以没发。确实要用这个仓库，加上 --force 再跑；不是的话，在配置页里把仓库地址改对');
      say(onlyReadme ? '仓库里只有建项目时带的说明文件，会被安装包换掉' : '[!] --force：仓库里原来的文件会被安装包换掉（历史还在，能找回来）');
      remoteVersion = '';
    } else say('仓库里现在是 ' + remoteVersion);
  }
  G(['symbolic-ref', 'HEAD', 'refs/heads/publish']);
  // 只放安装包本来的内容：在解压出来的包目录里开过 Claude Code、跑过测试留下的 .vibe、临时文件、Python 缓存不推上去
  // （-f 连 .gitignore 挡住的也会加，所以按清单挑，不能 add .）
  const PACKAGE = ['install.js', 'settings.fragment.json', 'publish.js', 'README.md', '开发流程.md', '更新说明.md', '.gitattributes', 'kit', 'claude', 'router'].concat(fs.readdirSync(SRC).filter((n) => /\.bat$/i.test(n)));
  const junk = fs.readdirSync(SRC).filter((n) => !PACKAGE.includes(n));
  if (junk.length) say('包目录里有这些不是安装包的东西，不发：' + junk.slice(0, 8).join('、') + (junk.length > 8 ? ' 等 ' + junk.length + ' 项' : ''));
  const add = G(['add', '-f', '--'].concat(PACKAGE.filter((n) => fs.existsSync(path.join(SRC, n))), [':(exclude)**/__pycache__', ':(exclude)**/*.pyc', ':(exclude)**/.vibe', ':(exclude)kit/state', ':(exclude)kit/feedback', ':(exclude)kit/config.json', ':(exclude)kit/secrets.json', ':(exclude)kit/router-data']), { timeout: 600000 });
  if (add.code !== 0) stop(gl.explainGit(add, '整理要发布的文件'));
  const tree = G(['write-tree']).out.trim();
  if (!/^[0-9a-f]{40}$/.test(tree)) stop('整理要发布的文件时出错了');
  const count = G(['ls-files']).out.split(/\r?\n/).filter(Boolean).length;
  if (remoteTree && remoteTree === tree) { console.log(''); say('[OK] 仓库里已经是这一版（' + version + '），内容一模一样，不用再发'); cleanup(); return; }
  if (remoteVersion === version) stop('仓库里已经有 ' + version + ' 了，但内容和这个包不一样。没发：装了这一版的电脑看版本号没变，不会更新。重新打包（换一个版本号）再发布');
  if (remoteVersion && remoteVersion > version) {
    say('[!] 仓库里的 ' + remoteVersion + ' 比这个包（' + version + '）新。发布之后，所有开着自动更新的电脑都会退回 ' + version);
    if (!has('--rollback')) {
      if (DRY) say('（只看不推：真发的时候这里会问你）');
      else if ((await ask('确实要让所有人退回 ' + version + '？要的话输入 yes 再回车：')) !== 'yes') stop('没发。要退回旧版，重新运行并输入 yes，或者加上 --rollback', 2);
    }
  }

  // ---------- 5. 推上去 ----------
  const fixed = fixedIssues(version);
  if (DRY) {
    console.log('');
    say('只看不推。真发的话会：');
    say('  推一个提交到 ' + branch + '（' + count + ' 个文件），标签 v' + version);
    if (fixed.length) say('  在这几个议题下面留话说这一版修了：' + fixed.map((n) => '#' + n).join('、'));
    cleanup();
    return;
  }
  const ident = [];
  if (!gl.git(null, ['config', '--get', 'user.name']).out.trim()) ident.push('-c', 'user.name=' + (os.userInfo().username || 'vibe-kit'));
  if (!gl.git(null, ['config', '--get', 'user.email']).out.trim()) ident.push('-c', 'user.email=' + (os.userInfo().username || 'vibe-kit') + '@' + os.hostname());
  const commit = G(ident.concat(['commit', '-q', '-m', 'chore: 发布 vibe-kit ' + version]), { timeout: 120000 });
  if (commit.code !== 0) stop(gl.explainGit(commit, '建提交'));
  G(['tag', '-f', 'v' + version]);
  const push = gl.viaRoutes(s, (route) => G(['push', '-q', route.url, 'HEAD:refs/heads/' + branch, 'refs/tags/v' + version], { route, timeout: 600000 }));
  if (push.code !== 0) {
    const e = String(push.err || '');
    if (/protected branch|not allowed to push/i.test(e)) stop('GitLab 不让推：分支 ' + branch + ' 是受保护的，这个账号的权限不够。在项目的 设置 → 仓库 → 受保护分支 里允许这个账号推送，或者换一个权限够的账号（令牌）');
    if (/already exists|rejected/i.test(e) && /tags\/v/.test(e)) stop('仓库里已经有标签 v' + version + ' 了，指着的不是这个包。重新打包（换一个版本号）再发布');
    if (/insufficient_scope|write_repository|denied|not allowed|403/i.test(e)) stop('GitLab 不让推：权限不够。令牌要勾 write_repository；走 SSH 的话账号在项目里至少是 Developer。原话：' + e.split(/\r?\n/).filter(Boolean).pop());
    stop(gl.explainRoutes(push, '推送'));
  }
  console.log('');
  say('[OK] 已发布 ' + version + '（' + count + ' 个文件，走的是' + push.route.label + '）' + (remoteVersion ? '，上一版是 ' + remoteVersion : ''));
  say('同事的电脑会在下一次检查时发现它（默认两小时一次，配置页里能点"立即检查"）');

  // ---------- 6. 关掉这一版修了的议题 ----------
  if (fixed.length) {
    try {
      const r = await require(path.join(KIT, 'lib', 'issues.js')).closeFixed(version, fixed);
      if (!r.ok) say('[!] 《更新说明.md》里写了修了 ' + fixed.map((n) => '#' + n).join('、') + '，但没能去关：' + r.why + '。可以在 GitLab 上手动关');
      else { if (r.noted.length) say('[OK] 已在议题下面留了话（' + version + ' 修了）：' + r.noted.map((n) => '#' + n).join('、') + (r.closed.length ? '；其中还开着的已经关掉：' + r.closed.map((n) => '#' + n).join('、') : '')); if (r.failed.length) say('[!] 这几个没处理成：' + r.failed.join('、')); }
    } catch (e) { say('[!] 关议题时出错：' + ((e && e.message) || e) + '。不影响发布'); }
  }
  cleanup();
})().catch((e) => stop('发布做到一半出错了：' + ((e && e.stack) || e)));

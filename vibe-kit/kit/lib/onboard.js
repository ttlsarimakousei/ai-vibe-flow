'use strict';
/*
 * 后台自动探索。进到一个没探索过的项目，不用模型、不花额度，脚本自己查清这几件事，写进项目的 .vibe/：
 *   project.md     项目说明：是什么工程、模块、怎么构建、启动命令和端口、编码、数据库和 redis 的连接名
 *   db-crud.ini    开发环境的数据库连接（ttls-db-crud 用）
 *   redis.json     开发环境的 redis 连接（ttls-redis 用）
 *   onboard.json   探索的记录：依据了哪些文件（指纹）、各部分上次生成的是什么
 *
 * 什么时候跑：会话开始、用户每次开口时看一眼（只读一个小文件、对十几个文件取一下修改时间），该跑了就甩一个后台进程，钩子自己马上返回。
 *   没探索过                          → 探索
 *   依据的文件改了（pom.xml、application-dev.yml…）→ 重新探索，只改变了的那几行
 *   离上次整个扫一遍超过 6 小时           → 再扫一遍（看有没有新加的配置文件、新模块）
 *
 * 脚本查不了的不猜：登录账号、代码之外的产出放哪、壳子里这次动哪个子项目。用到的时候由模型问用户。
 * 命令是照工程结构推出来的，没有实际跑过：项目说明里标着"没跑过"，模型第一次用的时候跑一遍，通了把标记去掉。
 *
 * 项目说明是一行一条（- 键：值）。重新探索时只换"这里生成的、而且这次生成的和上次不一样"的行：
 * 模型和用户改过的行（去掉了"没跑过"、补了别的话）、自己加的行，都不动。
 * 项目说明不是这里生成的（/ttls-onboard 或者人写的）：不动它，只管数据库和 redis 的连接。
 *
 * 只要开发环境的连接。测试、生产环境的不写进去：宁可少找一个，不能把生产库配给 AI。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const D = require('./discover.js');

const KIT = path.join(__dirname, '..');
const RESCAN_MS = 6 * 3600000;
// 会话开始和用户开口的钩子会挨着来：后台进程起来、占上锁之前的这一小会儿里不重复甩
const KICK_GAP_MS = 3000;
const MARK = '<!-- vibe-kit 后台自动探索 -->';
const NOT_RUN = '（没跑过）';
const SKIP = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '__pycache__', '.vibe', '.claude', 'logs', 'log', '.gradle', '.mvn', 'openspec']);

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const readText = (f) => { try { return D.readText(f).replace(/\r\n/g, '\n'); } catch (e) { return ''; } };
const readJson = (f) => { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } };
const exists = (f) => { try { return fs.existsSync(f); } catch (e) { return false; } };
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { fs.writeFileSync(file, text, 'utf8'); try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ } }
}
function log(line) {
  try { const f = path.join(KIT, 'state', 'onboard.log'); fs.mkdirSync(path.dirname(f), { recursive: true }); try { if (fs.statSync(f).size > 200 * 1024) fs.renameSync(f, f + '.1'); } catch (e) { /* 还没有 */ } fs.appendFileSync(f, new Date().toLocaleString('zh-CN', { hour12: false }) + ' ' + line + '\n'); } catch (e) { /* 记不了就算了 */ }
}
function config() {
  const c = readJson(path.join(KIT, 'config.json')) || {};
  return { on: c.autoOnboard !== false };
}

// ---------- 这个目录该不该探索、探索哪几个 ----------
const PROJECT_MARKS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'package.json', 'go.mod', 'pyproject.toml', '.classpath', '.project', 'src'];
function looksLikeProject(dir) {
  try { return PROJECT_MARKS.some((m) => exists(path.join(dir, m))) || fs.readdirSync(dir).some((n) => /\.(iml|sln|csproj)$/i.test(n)); } catch (e) { return false; }
}
function subRepos(dir) {
  const out = [];
  try {
    const deep = exists(path.join(dir, 'workspace.yaml'));
    const subs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name[0] !== '.' && !SKIP.has(e.name)).map((e) => path.join(d, e.name));
    for (const a of subs(dir)) {
      if (exists(path.join(a, '.git'))) out.push(a);
      else if (deep) for (const b of subs(a)) if (exists(path.join(b, '.git'))) out.push(b);
      if (out.length >= 12) break;
    }
  } catch (e) { /* 读不了 */ }
  return out.slice(0, 12);
}
/**
 * 要探索的目录。用户目录、盘符根、套件自己的目录不探索。
 * 壳子（自己不是装代码的项目，下面套着子项目）：探索下面的每个子项目；普通项目：探索它自己
 */
function targetsOf(cwd) {
  const dir = path.resolve(cwd || process.cwd());
  if (same(dir, os.homedir()) || path.dirname(dir) === dir) return [];
  const cfgDir = path.dirname(KIT);
  if (same(dir, cfgDir) || dir.toLowerCase().startsWith(cfgDir.toLowerCase() + path.sep)) return [];
  if (looksLikeProject(dir) && !exists(path.join(dir, 'workspace.yaml'))) return [dir];
  // 壳子才往下探索子项目。只是放着一堆仓库的普通目录（D:\code）不算：不然在里面问一句话，十几个仓库的 .gitignore 都被改了。
  // 是不是壳子和会话开始的钩子用同一个判断（lib/session.js 的 isShell）
  let shell = false;
  try { shell = require('./session.js').isShell(dir); } catch (e) { shell = false; }
  if (shell) { const subs = subRepos(dir).filter(looksLikeProject); if (subs.length) return subs; }
  // 技能、文档、脚本的仓库没有构建文件：是 git 仓库就算
  return exists(path.join(dir, '.git')) ? [dir] : [];
}
// ---------- 探索不成的（目录只读、.vibe 是个文件）：记下来，隔一阵再试，不是每次开口都起一个进程 ----------
const FAIL_STATE = 'onboard-fail';
function failedLately(root) {
  try {
    const S = require('./session.js');
    const f = S.readState(FAIL_STATE)[S.normKey(root)];
    if (!f || !f.at) return false;
    return Date.now() - f.at < Math.min(6 * 3600000, 600000 * Math.pow(2, Math.min(6, (f.n || 1) - 1)));
  } catch (e) { return false; }
}
function noteFail(root, ok) {
  try {
    const S = require('./session.js');
    S.updateState(FAIL_STATE, (st) => {
      const k = S.normKey(root);
      if (ok) delete st[k]; else st[k] = { at: Date.now(), n: ((st[k] && st[k].n) || 0) + 1 };
      for (const x of Object.keys(st)) if (Date.now() - (st[x].at || 0) > 7 * 86400000) delete st[x];
    });
  } catch (e) { /* 记不了就算了 */ }
}

// ---------- 项目里还留着的旧技能 ----------
// 并进套件之前单独装的技能。装在用户目录里的，安装器会删；装在项目里的安装器不动，由这里在会话开始时提醒
const db0 = (d) => exists(path.join(d, 'scripts', 'db.py')) && exists(path.join(d, 'scripts', 'sqlguard.py'));
const OLD_SKILLS = [
  { name: 'urai-db-crud', now: 'ttls-db-crud', is: db0, drivers: true },
  { name: 'db-crud', now: 'ttls-db-crud', is: db0, drivers: true },
  { name: 'redis', now: 'ttls-redis', is: (d) => exists(path.join(d, 'assets', 'redis-client.js')) },
];
/** cwd 和它下面各个子项目的 .claude/skills 里，认得出的旧技能：[{ name, now, dir, drivers: 带不带驱动 }]。用户目录的不算 */
function oldSkills(cwd) {
  const out = [];
  try {
    const cfgDir = path.dirname(KIT);
    const bases = [path.resolve(cwd || process.cwd())].concat(targetsOf(cwd)).filter((d, i, a) => a.findIndex((x) => same(x, d)) === i);
    for (const base of bases) {
      if (same(path.join(base, '.claude'), cfgDir)) continue;
      for (const x of OLD_SKILLS) {
        const d = path.join(base, '.claude', 'skills', x.name);
        let mine = false;
        try { mine = exists(d) && x.is(d); } catch (e) { mine = false; }
        if (mine) out.push({ name: x.name, now: x.now, dir: d, drivers: !!x.drivers && exists(path.join(d, 'drivers')) });
      }
    }
  } catch (e) { /* 查不了就当没有 */ }
  return out;
}
/** 旧技能自带的驱动收进套件的驱动目录并登记（那种数据库已经登记了驱动的不动）。返回登记了哪些 */
function rescueDrivers(list) {
  const got = [];
  try {
    const drv = require('./drivers.js');
    for (const s of list || []) if (s.drivers) for (const u of drv.rescueFrom(s.dir)) got.push(u.name + ' ' + path.basename(u.jar));
    if (got.length) log('从项目里的旧技能收了驱动：' + got.join('、'));
  } catch (e) { log('收旧技能的驱动出错：' + ((e && e.message) || e)); }
  return got;
}
/**
 * 会话开始时给模型的话（没有旧技能返回 ''）。每个旧技能只让它提醒用户一次（记在 state/old-skills.json 里），
 * 之后的会话只说"用新的"。第一次提醒之前先把它自带的驱动收进来
 */
function oldSkillNotice(cwd) {
  try {
    const list = oldSkills(cwd);
    if (!list.length) return '';
    const S = require('./session.js');
    const told = S.readState('old-skills');
    const fresh = list.filter((s) => !told[S.normKey(s.dir)]);
    const names = list.map((s) => s.name + '（' + s.dir + '，现在叫 /' + s.now + '）').join('；');
    if (!fresh.length) return '这个项目里还留着并进套件之前的技能：' + names + '。用 ttls- 开头的那个，旧的不要用。';
    const got = rescueDrivers(fresh);
    for (const s of fresh) told[S.normKey(s.dir)] = Date.now();
    S.writeState('old-skills', told);
    return '这个项目里还留着并进套件之前的技能：' + names + '。用 ttls- 开头的那个，旧的不要用。'
      + '这一次回答的最后提醒我一句：旧的可以删掉了，删哪几个目录照上面写' + (fresh.some((s) => s.drivers) ? '；它自带的数据库驱动' + (got.length ? '已经收进套件登记好了（' + got.join('、') + '）' : '套件里已经有登记的，不用管') : '') + '。不要自己去删。';
  } catch (e) { return ''; }
}

// ---------- 指纹 ----------
function stamp(file) { try { const s = fs.statSync(file); return { m: Math.round(s.mtimeMs), s: s.size }; } catch (e) { return null; } }
function changedFiles(rec) {
  const out = [];
  const t = (rec && rec.tracked) || {};
  for (const f of Object.keys(t)) {
    const now = stamp(f);
    if (!now) { out.push({ file: f, how: '没了' }); continue; }
    if (now.m !== t[f].m || now.s !== t[f].s) out.push({ file: f, how: '改了' });
  }
  return out;
}
const recordFile = (root) => path.join(root, '.vibe', 'onboard.json');

/** 这个项目现在该不该跑一次。返回原因（不用跑返回 ''）。只读一个小文件、取十几个文件的修改时间 */
function due(root) {
  const rec = readJson(recordFile(root));
  if (!rec || !rec.at) return '没探索过';
  const ch = changedFiles(rec);
  if (ch.length) return '依据的文件' + ch[0].how + '：' + rel(root, ch[0].file) + (ch.length > 1 ? ' 等 ' + ch.length + ' 个' : '');
  if (Date.now() - (rec.scanAt || 0) > RESCAN_MS) return '离上次整个扫一遍超过 6 小时';
  // 项目说明被删了：重新生成
  if (rec.wroteProject && !exists(path.join(root, '.vibe', 'project.md'))) return '项目说明不见了';
  return '';
}

// ---------- 认工程 ----------
function walk(root, maxDepth, visit, budget) {
  let left = budget || 20000;
  const go = (dir, depth) => {
    if (depth > maxDepth || left <= 0) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (--left <= 0) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && e.name[0] !== '.') { if (visit(p, true, depth) !== false) go(p, depth + 1); } } else if (e.isFile()) visit(p, false, depth);
    }
  };
  go(root, 0);
}
const xmlTag = (text, tag) => { const m = new RegExp('<' + tag + '>\\s*([^<]*?)\\s*</' + tag + '>').exec(text); return m ? m[1] : ''; };
const stripXmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
function readPom(file) {
  const raw = stripXmlComments(readText(file));
  if (!raw) return null;
  // 去掉 dependencies、build 里面的内容再取最外层的标签，免得拿到某个依赖的 version
  const head = raw.replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '').replace(/<build>[\s\S]*?<\/build>/g, '').replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const parent = (/<parent>([\s\S]*?)<\/parent>/.exec(head) || [])[1] || '';
  const noParent = head.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const props = (/<properties>([\s\S]*?)<\/properties>/.exec(head) || [])[1] || '';
  const modules = [];
  const mm = /<modules>([\s\S]*?)<\/modules>/.exec(head);
  if (mm) { const re = /<module>\s*([^<]+?)\s*<\/module>/g; let m; while ((m = re.exec(mm[1]))) modules.push(m[1]); }
  let boot = '';
  if (/spring-boot-starter-parent/.test(parent)) boot = xmlTag(parent, 'version');
  if (!boot) boot = xmlTag(props, 'spring-boot.version') || xmlTag(props, 'spring.boot.version');
  if (!boot) { const m = /<artifactId>spring-boot-dependencies<\/artifactId>\s*<version>\s*([^<]+?)\s*<\/version>/.exec(raw); if (m) boot = m[1]; }
  if (/^\$\{/.test(boot)) boot = xmlTag(props, boot.replace(/^\$\{|\}$/g, '')) || '';
  const java = xmlTag(props, 'java.version') || xmlTag(props, 'maven.compiler.release') || xmlTag(props, 'maven.compiler.source') || xmlTag(props, 'maven.compiler.target');
  return {
    file, artifactId: xmlTag(noParent, 'artifactId'), packaging: xmlTag(noParent, 'packaging') || 'jar', modules, boot, java: java.replace(/^1\./, ''),
    usesBoot: /spring-boot/.test(raw), runnable: /spring-boot-maven-plugin/.test(raw), war: xmlTag(noParent, 'packaging') === 'war',
  };
}
/** yml、properties 里取一个键的值（server.port 这种）。yml 认缩进，properties 认整行 */
function propOf(text, ext, key) {
  if (/\.properties$/i.test(ext)) {
    const m = new RegExp('^\\s*' + key.replace(/[.]/g, '\\.') + '\\s*[=:]\\s*(.+?)\\s*$', 'm').exec(text);
    return m ? m[1] : '';
  }
  const stack = [];
  for (const l of text.split('\n')) {
    if (/^\s*#/.test(l) || !l.trim()) continue;
    if (/^---/.test(l)) { stack.length = 0; continue; }
    const m = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1].ind >= m[1].length) stack.pop();
    stack.push({ ind: m[1].length, key: m[2] });
    const v = m[3].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
    if (v && stack.map((x) => x.key).join('.') === key) return v;
  }
  return '';
}
/** 一个模块的 Spring 配置里的端口、上下文路径。先看开发环境的文件，再看公共的 */
function springFacts(moduleDir, tracked) {
  const res = path.join(moduleDir, 'src', 'main', 'resources');
  let files = [];
  try { files = fs.readdirSync(res).filter((n) => /^(application|bootstrap).*\.(ya?ml|properties)$/i.test(n)); } catch (e) { files = []; }
  try { for (const n of fs.readdirSync(path.join(res, 'config'))) if (/^(application|bootstrap).*\.(ya?ml|properties)$/i.test(n)) files.push('config/' + n); } catch (e) { /* 没有 config 目录 */ }
  const rank = (n) => { const e = D.envOfFile(n); return e === 'dev' ? 0 : e === 'base' || e === 'other' ? 1 : 9; };
  files = files.filter((n) => rank(n) < 9).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let port = ''; let ctx = ''; let from = ''; let active = '';
  for (const n of files) {
    const f = path.join(res, n);
    const t = D.stripComments(readText(f), path.extname(f));
    if (!t) continue;
    tracked.add(f);
    if (!active) active = D.activeProfile(t);
    if (!port) { const p = D.expand(propOf(t, f, 'server.port')).text; if (/^\d+$/.test(p)) { port = p; from = n; } }
    if (!ctx) ctx = D.expand(propOf(t, f, 'server.servlet.context-path') || propOf(t, f, 'server.context-path') || propOf(t, f, 'server.servlet.contextPath')).text;
  }
  return { port, ctx: ctx === '/' ? '' : ctx, from, active, has: files.length > 0 };
}
function frontendFacts(dir, tracked) {
  const pkgFile = path.join(dir, 'package.json');
  const pkg = readJson(pkgFile);
  if (!isObj(pkg)) return null;
  tracked.add(pkgFile);
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const scripts = isObj(pkg.scripts) ? pkg.scripts : {};
  const ver = (n) => String(deps[n] || '').replace(/^[^\d]*/, '').split('.')[0];
  let fw = '';
  if (deps.nuxt) fw = 'Nuxt ' + ver('nuxt');
  else if (deps.vue) fw = 'Vue ' + ver('vue');
  else if (deps.next) fw = 'Next ' + ver('next');
  else if (deps.react) fw = 'React ' + ver('react');
  else if (deps['@angular/core']) fw = 'Angular ' + ver('@angular/core');
  const bundler = deps.vite ? 'Vite' : deps['@vue/cli-service'] ? 'Vue CLI' : deps.webpack ? 'webpack' : deps['react-scripts'] ? 'react-scripts' : '';
  if (!fw && !bundler && !scripts.dev && !scripts.serve && !scripts.build) return { plain: true, name: pkg.name || '', scripts };
  const dev = scripts.dev ? 'dev' : scripts.serve ? 'serve' : scripts.start ? 'start' : '';
  let port = '';
  let portFrom = '';
  const proxies = [];
  for (const n of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vue.config.js', 'webpack.config.js', '.env.development', '.env']) {
    const f = path.join(dir, n);
    const t = readText(f);
    if (!t) continue;
    tracked.add(f);
    // 去掉注释。// 前面要是空白或者行首才算注释：http://… 里的不算
    const code = t.replace(/(^|\s)\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
    if (!port) { const m = /^\.env/.test(n) ? /^\s*(?:VITE_PORT|VUE_APP_PORT|PORT)\s*=\s*(\d+)/m.exec(t) : /\bport\s*:\s*(\d{2,5})\b/.exec(code); if (m) { port = m[1]; portFrom = n; } }
    const re = /target\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/g;
    let m;
    while ((m = re.exec(code))) if (!proxies.includes(m[1])) proxies.push(m[1]);
  }
  if (!port) port = deps.vite ? '5173' : deps['@vue/cli-service'] ? '8080' : (deps['react-scripts'] || deps.next || deps.nuxt) ? '3000' : '';
  const notes = [];
  if (!exists(path.join(dir, 'node_modules'))) notes.push('前端的 node_modules 不在，要先 npm install 才跑得起来');
  const ts = readJson(path.join(dir, 'tsconfig.json'));
  if (isObj(ts) && Array.isArray(ts.files) && !ts.files.length && Array.isArray(ts.references)) notes.push('tsconfig.json 是 files 为空加 references 的写法：类型检查要写成 vue-tsc --noEmit -p tsconfig.app.json，不然一个文件都不查');
  return { fw, bundler, dev, build: scripts.build ? 'build' : '', typeCheck: scripts['type-check'] ? 'type-check' : '', lint: scripts.lint ? 'lint' : '', eslint: !!deps.eslint, port, portFrom, proxies: proxies.slice(0, 3), notes, name: pkg.name || '' };
}
function encodingFacts(root) {
  const EXT = /\.(java|js|jsx|ts|tsx|vue|xml|properties|jsp|html?|css|scss|less|sql|ya?ml|json|md|py|bat|ps1)$/i;
  let seen = 0; let withCn = 0;
  const bad = [];
  walk(root, 8, (p, isDir) => {
    if (isDir || seen >= 400 || !EXT.test(p)) return;
    let buf;
    try { const st = fs.statSync(p); if (st.size > 512 * 1024 || !st.size) return; buf = fs.readFileSync(p); } catch (e) { return; }
    seen++;
    if (!buf.some((b) => b > 0x7f)) return;
    withCn++;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { bad.push(rel(root, p)); }
  }, 30000);
  // 这一行里不放文件的个数：项目里每加一个文件数字就变，每次重扫都要改这一行、再告诉模型一遍
  if (!seen) return '';
  if (!withCn) return 'UTF-8（抽查的文件里没有中文）';
  if (!bad.length) return 'UTF-8';
  if (bad.length / withCn > 0.5) return '不是 UTF-8 的居多（多半是 GBK）。这类文件不要直接改，钩子会拦，照它说的做';
  return 'UTF-8；这 ' + bad.length + ' 个不是 UTF-8（多半是 GBK），别直接改：' + bad.slice(0, 8).join('、') + (bad.length > 8 ? ' 等' : '');
}
function jdkNote(java) {
  if (!java) return '';
  const local = readJson(path.join(KIT, 'local.json')) || {};
  const jdks = (Array.isArray(local.jdks) ? local.jdks : []).filter((j) => j && j.name && j.path);
  if (!jdks.length) return '';
  const hit = jdks.find((j) => String(j.name) === String(java) || new RegExp('(^|\\D)' + java + '(\\D|$)').test(String(j.name)));
  if (hit) return 'JDK 用"本机环境"里的 ' + hit.name + (String(local.defaultJdk) === String(hit.name) ? '' : '（不是默认的那个，跑命令时要带上它的 JAVA_HOME）');
  return '这个项目要 JDK ' + java + '，"本机环境"里没有配';
}

/**
 * 看一个项目，返回 { kind, lines: [[键, 值]…]（项目说明的行，按顺序）, tracked: Set（依据了哪些文件） }
 */
function facts(root) {
  const tracked = new Set();
  const lines = [];
  const notes = [];
  const add = (k, v) => { if (v) lines.push([k, v]); };
  const pomFile = path.join(root, 'pom.xml');
  const gradle = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].map((n) => path.join(root, n)).filter(exists);
  let kind = '';
  let front = null;
  let frontDir = '';

  // 同一个仓库里的前端（根目录自己，或者往下两层）
  const frontDirs = [];
  if (exists(path.join(root, 'package.json'))) frontDirs.push(root);
  walk(root, 2, (p, isDir) => { if (isDir && exists(path.join(p, 'package.json')) && !frontDirs.includes(p)) frontDirs.push(p); }, 3000);
  for (const d of frontDirs) { const f = frontendFacts(d, tracked); if (f && !f.plain) { front = f; frontDir = d; break; } }

  if (exists(pomFile)) {
    kind = 'maven';
    const pom = readPom(pomFile);
    tracked.add(pomFile);
    const mods = [];
    for (const m of (pom && pom.modules) || []) {
      const f = path.join(root, m, 'pom.xml');
      const p = readPom(f);
      if (!p) continue;
      tracked.add(f);
      mods.push(Object.assign({ dir: path.join(root, m), name: m }, p));
      // 再往下一层（聚合模块下面还有模块）
      for (const mm of p.modules) { const f2 = path.join(root, m, mm, 'pom.xml'); const p2 = readPom(f2); if (p2) { tracked.add(f2); mods.push(Object.assign({ dir: path.join(root, m, mm), name: m + '/' + mm }, p2)); } }
    }
    const boot = (pom && pom.boot) || (mods.find((m) => m.boot) || {}).boot || '';
    const java = (pom && pom.java) || (mods.find((m) => m.java) || {}).java || '';
    const usesBoot = !!boot || (pom && pom.usesBoot) || mods.some((m) => m.usesBoot);
    const runnable = mods.filter((m) => m.runnable || m.war);
    const runMod = runnable[0] || null;
    const what = ['代码工程。Maven ' + (mods.length ? '多模块（' + mods.length + ' 个模块）' : '单模块')];
    if (usesBoot) what.push('Spring Boot' + (boot ? ' ' + boot : ''));
    if (java) what.push('Java ' + java);
    let type = what.join('，');
    if (runnable.length) type += '；能跑起来的模块：' + runnable.map((m) => m.name).slice(0, 4).join('、');
    if (front && !same(frontDir, root)) type += '；前端在 ' + rel(root, frontDir) + '（' + [front.fw, front.bundler].filter(Boolean).join(' + ') + '）';
    add('类型', type);
    add('环境', jdkNote(java));
    add('快检', 'mvn -q -o compile' + NOT_RUN + '。离线编不过（父 pom、内部依赖只在私服上）就去掉 -o。嫌慢：照 /ttls-onboard 的 recipes 导出依赖清单，用 javac 只编改过的文件');
    add('全量', 'mvn -q -DskipTests compile' + NOT_RUN);
    const sf = springFacts(runMod ? runMod.dir : root, tracked);
    if (usesBoot) {
      const port = sf.port || '8080';
      add('启动', 'mvn spring-boot:run' + (runMod ? ' -pl ' + runMod.name + ' -am（在根目录执行）' : '') + '，端口 ' + port + (sf.port ? '（' + sf.from + ' 里的 server.port）' : '（配置里没写，按默认的算）') + (sf.ctx ? '，上下文路径 ' + sf.ctx : '') + '，起来的标志是日志里出现 Started' + NOT_RUN + '。用 devserver.js 起：--port auto --avoid ' + port + '，它认环境变量 SERVER_PORT，命令不用改');
      if (sf.active) notes.push('配置里写的当前环境是 ' + sf.active);
    } else if ((pom && pom.war) || mods.some((m) => m.war)) add('启动', '打成 war 放进 Tomcat，或者在 IDE 里启动' + NOT_RUN);
    else add('启动', '没认出怎么启动（不是 Spring Boot，也不是 war）：用到的时候问我');
    if (/[^\x00-\x7f]/.test(root) && usesBoot) notes.push('项目路径里有中文，spring-boot:run 可能报找不到主类');
  } else if (gradle.length) {
    kind = 'gradle';
    for (const f of gradle) tracked.add(f);
    const wrapper = exists(path.join(root, 'gradlew.bat')) || exists(path.join(root, 'gradlew'));
    const g = wrapper ? './gradlew.bat' : 'gradle';
    const text = gradle.map(readText).join('\n');
    const usesBoot = /org\.springframework\.boot/.test(text);
    add('类型', '代码工程。Gradle' + (usesBoot ? '，Spring Boot' : '') + (front && !same(frontDir, root) ? '；前端在 ' + rel(root, frontDir) + '（' + [front.fw, front.bundler].filter(Boolean).join(' + ') + '）' : ''));
    add('快检', g + ' compileJava --offline -q' + NOT_RUN + '。离线不行就去掉 --offline');
    add('全量', g + ' compileJava -q' + NOT_RUN);
    if (usesBoot) { const sf = springFacts(root, tracked); add('启动', g + ' bootRun，端口 ' + (sf.port || '8080') + (sf.ctx ? '，上下文路径 ' + sf.ctx : '') + NOT_RUN + '。用 devserver.js 起：--port auto --avoid ' + (sf.port || '8080') + '，它认环境变量 SERVER_PORT，命令不用改'); }
  } else if (front && same(frontDir, root)) {
    kind = 'frontend';
    add('类型', '前端。' + [front.fw, front.bundler].filter(Boolean).join(' + '));
  } else {
    // 没有构建文件：老式 Java Web、技能、文档、脚本
    let webInf = '';
    let skills = 0; let md = 0; let code = 0; let scripts = 0;
    const scriptExt = {};
    walk(root, 3, (p, isDir) => {
      const n = path.basename(p);
      if (isDir) { if (n === 'WEB-INF' && exists(path.join(p, 'web.xml')) && !webInf) webInf = p; return; }
      if (n === 'SKILL.md') skills++;
      if (/\.(md|docx?)$/i.test(n)) md++;
      else if (/\.(java|vue|tsx?|jsx|go|rs|cs)$/i.test(n)) code++;
      else if (/\.(bat|cmd|ps1|py|sh|js)$/i.test(n)) { scripts++; const e = n.split('.').pop().toLowerCase(); scriptExt[e] = (scriptExt[e] || 0) + 1; }
    }, 6000);
    const classpath = exists(path.join(root, '.classpath'));
    if (webInf || classpath) {
      kind = 'legacy-web';
      if (classpath) tracked.add(path.join(root, '.classpath'));
      add('类型', '代码工程。没有 pom 的老式 Java Web（在 IDE 里配 Tomcat 启动）' + (webInf ? '，页面和 jar 在 ' + rel(root, path.dirname(webInf)) : ''));
      add('快检', '还没备好：照 /ttls-onboard 的 recipes（"没有 pom 的老式 Java Web"一节）拼 javac 命令，跑通了记在这里');
      add('全量', '同上');
      add('启动', '在 IDE 里启动');
    } else if (skills >= 2 || exists(path.join(root, '.claude-plugin'))) {
      kind = 'skills';
      add('类型', '技能工程。' + skills + ' 个技能');
      add('快检', 'node "$HOME/.claude/vibe-kit/tools/skills-check.js" . --repo；改了脚本再加语法检查（node --check、python -m py_compile）');
      add('全量', '同上');
      add('启动', '不适用');
      add('看页面', '不适用');
    } else if (scripts > md && scripts >= 3 && !code) {
      kind = 'scripts';
      add('类型', '脚本、工具。' + Object.keys(scriptExt).sort((a, b) => scriptExt[b] - scriptExt[a]).map((e) => '.' + e + ' ' + scriptExt[e] + ' 个').join('，'));
      add('快检', '语法检查：' + [scriptExt.js && 'node --check <文件>', scriptExt.py && 'python -m py_compile <文件>', scriptExt.ps1 && 'PowerShell 的语法检查（见 /ttls-onboard 的 recipes）'].filter(Boolean).join('；'));
      add('全量', '不适用');
      add('启动', '不适用');
      add('看页面', '不适用');
    } else if (md >= 3 && !code && scripts < 3) {
      kind = 'docs';
      add('类型', '文档、规范。' + md + ' 个文档');
      add('快检', '不适用：改完通读改动的那一节，文中的路径和链接用 grep 核对存在');
      add('全量', '不适用');
      add('启动', '不适用');
      add('看页面', '不适用');
    } else {
      kind = 'unknown';
      add('类型', '没认出来（没有构建文件）。改东西之前先问我这个仓库是干什么的、改完怎么算改对了，或者跑 /ttls-onboard');
    }
  }
  if (front) {
    // 前端不在工程根上的：命令用 --prefix 指目录，不写"进到 X 里"。
    // cd 和别的命令串在一条里，Claude Code 会停下来要人确认（开着跳过权限模式也问），照着"进到 X 里"做就会写出 cd X && npm run …
    const sub = same(frontDir, root) ? '' : rel(root, frontDir);
    const npmRun = (script) => 'npm ' + (sub ? '--prefix ' + (/\s/.test(sub) ? '"' + sub + '"' : sub) + ' ' : '') + 'run ' + script;
    const pre = kind === 'frontend' ? '' : '前端';
    if (kind === 'frontend') {
      add('快检', front.eslint ? 'npx --no-install eslint <改动的文件>' + NOT_RUN : '没有单个文件的检查：靠开发服务器热更新，用 /ttls-see-page 看页面');
      add('全量', front.build ? 'npm run ' + front.build + NOT_RUN : '');
    } else if (front.build) add('前端全量', npmRun(front.build) + NOT_RUN);
    if (front.typeCheck) add(pre + '类型检查', npmRun(front.typeCheck) + NOT_RUN + '。现在就有的错先存成基线，只看新增的');
    if (front.dev) add(pre + '启动', npmRun(front.dev) + (front.port ? '，端口 ' + front.port + (front.portFrom ? '（' + front.portFrom + '）' : '（默认的）') : '') + (front.proxies.length ? '，接口代理到 ' + front.proxies.join('、') : '') + NOT_RUN + '。用 devserver.js 起，加 --hot，--port auto' + (front.port ? ' --avoid ' + front.port : '') + (/^(Vite|webpack)$/.test(front.bundler) ? '，' + front.bundler + ' 不认环境变量 PORT，命令写 ' + npmRun(front.dev) + ' -- --port {port}' : '，它认环境变量 PORT，命令不用改'));
    for (const n of front.notes) notes.push(n);
  }
  add('编码', encodingFacts(root));
  return { kind, lines, notes, tracked };
}

// ---------- 数据库、redis：只要开发环境的 ----------
const DIALECT_NAME = { dm: '达梦', oscar: '神通', mysql: 'MySQL', oracle: 'Oracle', kingbase: '人大金仓', postgresql: 'PostgreSQL' };
const safeName = (s) => String(s || '').replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
/** 连接串里的主机和库，给人看、给模型看的：串里带的账号口令遮掉，参数去掉 */
const shortUrl = (u) => D.maskUrl(String(u || '')).replace(/\?.*$/, '').replace(/;.*$/, '');
const sha8 = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
/** 读一个已经存在的文件。读不出来（被杀毒、备份软件占着）返回 null：调用的地方要停手，不能当成空文件整份重写 */
function readStrict(file) {
  for (let i = 0; i < 3; i++) {
    try { return D.readText(file).replace(/\r\n/g, '\n'); } catch (e) { if (e && e.code === 'ENOENT') return ''; try { require('./session.js').sleepMs(60); } catch (e2) { /* 不等了 */ } }
  }
  return null;
}

/** ini 按段切开：[{ name, start, end（行号，不含） }]，连同所有的行。段头后面带注释的（[master]  ; 主库）也认，和 Python 读配置的写法一致 */
function iniSections(text) {
  const lines = text.split('\n');
  const secs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\[([^\]]+)\]\s*([;#].*)?$/.exec(lines[i]);
    if (!m) continue;
    if (secs.length) secs[secs.length - 1].end = i;
    secs.push({ name: m[1].trim(), start: i, end: lines.length });
  }
  const get = (s, key) => { for (let i = s.start + 1; i < s.end; i++) { const m = new RegExp('^\\s*' + key + '\\s*=\\s*(.*?)\\s*$').exec(lines[i]); if (m) return m[1]; } return ''; };
  return { lines, secs, get };
}
const DB_CONFIG_NAMES = ['db-crud.ini', 'urai-db-crud.ini'];
function dbConfigFile(owner) {
  let best = ''; let at = -1;
  for (const n of DB_CONFIG_NAMES) { const f = path.join(owner, '.vibe', n); const s = stamp(f); if (s && s.m > at) { best = f; at = s.m; } }
  return best || path.join(owner, '.vibe', DB_CONFIG_NAMES[0]);
}
/**
 * 把找到的连接并进一个项目的连接配置。
 *   配置里已经有同一个地址、同一个账号的连接：自动探索写的（带 source）而且项目里的口令变了就更新，人写的不动
 *   没有：加一段
 *   自动探索写的连接，这次在项目里找不到了：加一行注释说明，不删（上面可能记着坑）
 * memo 记着上一次从项目里找到的是什么（只存指纹）：配置里的口令和找到的不一样时，
 *   找到的和上次一样 = 项目那头没变，是人在配置里改的，不动；找到的变了 = 项目那头改了，跟着改。
 * 找到的是空的（没找到账号、口令是占位符）不拿去盖已有的值。
 * 配置文件在、却读不出来：这次不写，返回 skipped。
 * 返回 { file, names: [连接名…], added, updated, gone, changed, skipped }
 */
function mergeDb(owner, found, memo) {
  const file = dbConfigFile(owner);
  const had = exists(file);
  const out = { file, names: [], added: [], updated: [], gone: [] };
  const before = had ? readStrict(file) : '; ttls-db-crud 的连接配置。带 source 的连接是 vibe-kit 后台自动探索从项目的配置文件里找到的（只找开发环境的），\n; 来源文件改了会跟着更新；你手改过、不想被更新的，把那一段的 source 那一行删掉。\n; ★ 这里面有账号口令，确认项目的 .gitignore 排除了 .vibe/。\n';
  if (before === null) { log('连接配置读不出来，这次不动它：' + file); return Object.assign(out, { changed: false, skipped: true }); }
  const seen = memo || {};
  const ini = iniSections(before);
  const L = ini.lines.slice();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const taken = new Set(ini.secs.map((s) => s.name.toLowerCase()));
  const edits = [];   // { at, del, ins }
  const matched = new Set();
  const tail = [];
  const valueAt = (i, key) => L[i].replace(new RegExp('^\\s*' + key + '\\s*=\\s*'), '').trim();
  /** 项目那头的口令该不该写进配置：找到了、和配置里的不一样、而且不是"项目那头没变、人在配置里改过" */
  const pwFresh = (name, f, cur) => !!f.password && cur !== f.password && !(seen[name] && seen[name].pw === sha8(f.password));
  for (const f of found) {
    const hit = ini.secs.find((s) => norm(ini.get(s, 'jdbc')) === norm(f.url) && norm(ini.get(s, 'user')) === norm(f.user));
    if (hit) {
      matched.add(hit.name);
      out.names.push(hit.name);
      const src = ini.get(hit, 'source');
      if (src) {
        for (let i = hit.start + 1; i < hit.end; i++) {
          if (/^\s*password\s*=/.test(L[i]) && pwFresh(hit.name, f, valueAt(i, 'password'))) { L[i] = 'password = ' + f.password; if (!out.updated.includes(hit.name)) out.updated.push(hit.name); }
          if (/^\s*source\s*=/.test(L[i]) && valueAt(i, 'source') !== f.source + ':' + f.line) L[i] = 'source = ' + f.source + ':' + f.line;
          if (/^;\s*★ 来源文件里已经找不到这个连接/.test(L[i])) L[i] = null;
        }
      }
      seen[hit.name] = { pw: sha8(f.password || '') };
      continue;
    }
    // 同一个来源位置、地址变了（换了开发库的地址）：更新那一段
    const moved = ini.secs.find((s) => !matched.has(s.name) && ini.get(s, 'source') && ini.get(s, 'source').replace(/:\d+$/, '') === f.source && norm(ini.get(s, 'dialect')) === f.dialect && !found.some((x) => norm(x.url) === norm(ini.get(s, 'jdbc')) && norm(x.user) === norm(ini.get(s, 'user'))));
    if (moved) {
      matched.add(moved.name);
      out.names.push(moved.name);
      for (let i = moved.start + 1; i < moved.end; i++) {
        if (/^\s*jdbc\s*=/.test(L[i])) L[i] = 'jdbc = ' + f.url;
        else if (/^\s*user\s*=/.test(L[i])) { if (f.user) L[i] = 'user = ' + f.user; } else if (/^\s*password\s*=/.test(L[i])) { if (pwFresh(moved.name, f, valueAt(i, 'password'))) L[i] = 'password = ' + f.password; } else if (/^\s*source\s*=/.test(L[i])) L[i] = 'source = ' + f.source + ':' + f.line;
        else if (/^;\s*★ 来源文件里已经找不到这个连接/.test(L[i])) L[i] = null;
      }
      out.updated.push(moved.name);
      seen[moved.name] = { pw: sha8(f.password || '') };
      continue;
    }
    const base = safeName(f.nameHint) || f.dialect;
    let name = base;
    for (let k = 2; taken.has(name); k++) name = base + k;
    taken.add(name);
    out.names.push(name);
    out.added.push(name);
    const sec = ['', '[' + name + ']', 'dialect = ' + f.dialect, 'jdbc = ' + f.url];
    if (f.user) sec.push('user = ' + f.user);
    if (f.encrypted) sec.push('; 项目配置里的口令是加密的（ENC(…)），这里用不了：把明文口令填在下面', 'password =');
    else sec.push('password = ' + (f.password || ''));
    sec.push('source = ' + f.source + ':' + f.line);
    tail.push(...sec);
    seen[name] = { pw: sha8(f.password || '') };
  }
  for (const s of ini.secs) {
    if (matched.has(s.name) || !ini.get(s, 'source')) continue;
    out.gone.push(s.name);
    let noted = false;
    for (let i = s.start + 1; i < s.end; i++) if (/^;\s*★ 来源文件里已经找不到这个连接/.test(L[i] || '')) noted = true;
    if (!noted) edits.push({ at: s.start + 1, ins: '; ★ 来源文件里已经找不到这个连接了（' + today() + '）。确实不用了就把这一段删掉' });
  }
  for (const e of edits.sort((a, b) => b.at - a.at)) L.splice(e.at, 0, e.ins);
  let text = L.filter((l) => l !== null).join('\n').replace(/\n+$/, '') + (tail.length ? '\n' + tail.join('\n') : '') + '\n';
  if (!had && !tail.length) return Object.assign(out, { changed: false });
  out.changed = text !== before;
  if (out.changed) writeAtomic(file, text);
  return out;
}
/**
 * redis 的连接并进 <项目>/.vibe/redis.json。自动探索写的（auto: true）跟着来源更新，人写的不动。
 * 口令的规矩和 mergeDb 一样：找到的是空的不盖已有的；项目那头没变、人在配置里改过的不动。
 * redis.json 在、却读不出来或者不是合法的 JSON（人手改的时候多了一个逗号）：这次不写，返回 skipped
 */
function mergeRedis(owner, found, memo) {
  const file = path.join(owner, '.vibe', 'redis.json');
  const out = { file, names: [], added: [], updated: [], gone: [] };
  let cur = null;
  if (exists(file)) {
    const t = readStrict(file);
    try { cur = t === null ? null : JSON.parse(t.replace(/^﻿/, '')); } catch (e) { cur = null; }
    if (!isObj(cur)) { log('redis 的连接配置读不出来（不是合法的 JSON），这次不动它：' + file); return Object.assign(out, { changed: false, skipped: true }); }
  }
  const seen = memo || {};
  const conns = isObj(cur) && isObj(cur.connections) ? cur.connections : {};
  const before = JSON.stringify(conns);
  const key = (c) => String(c.host).toLowerCase() + ':' + (Number(c.port) || 6379) + '/' + (Number(c.db) || 0);
  const matched = new Set();
  for (const f of found) {
    let name = Object.keys(conns).find((k) => key(conns[k]) === key(f));
    if (!name) name = Object.keys(conns).find((k) => !matched.has(k) && conns[k].auto && String(conns[k].source || '').replace(/:\d+$/, '') === f.source && !found.some((x) => key(x) === key(conns[k])));
    const fresh = { host: f.host, port: f.port, password: f.password, db: f.db, source: f.source + ':' + f.line, auto: true };
    if (f.mode) fresh.mode = f.mode;
    if (f.tls) fresh.tls = true;
    if (f.encrypted) fresh.note = '项目配置里的口令是加密的，这里用不了：把明文口令填进 password';
    if (name) {
      matched.add(name);
      out.names.push(name);
      if (conns[name].auto) {
        const old = JSON.stringify(conns[name]);
        const had = String(conns[name].password == null ? '' : conns[name].password);
        const keep = had && (!f.password || (seen[name] && seen[name].pw === sha8(f.password)));
        conns[name] = Object.assign({}, conns[name], fresh, keep ? { password: had } : {});
        delete conns[name].gone;
        if (JSON.stringify(conns[name]) !== old) out.updated.push(name);
      }
      seen[name] = { pw: sha8(f.password || '') };
      continue;
    }
    const base = safeName(f.nameHint) || 'dev';
    name = base;
    for (let k = 2; conns[name]; k++) name = base + k;
    conns[name] = fresh;
    matched.add(name);
    out.names.push(name);
    out.added.push(name);
    seen[name] = { pw: sha8(f.password || '') };
  }
  for (const k of Object.keys(conns)) if (conns[k].auto && !matched.has(k)) { out.gone.push(k); if (!conns[k].gone) conns[k].gone = '来源文件里已经找不到这个连接了（' + today() + '）'; }
  out.changed = JSON.stringify(conns) !== before;
  if (out.changed && Object.keys(conns).length) writeAtomic(file, JSON.stringify({ note: 'ttls-redis 的连接配置。auto 为 true 的是 vibe-kit 后台自动探索从项目的配置文件里找到的（只找开发环境的），来源文件改了会跟着更新；不想被更新的把 auto 改成 false。这里面有口令，.vibe/ 不要提交。', connections: conns }, null, 2) + '\n');
  return out;
}

// ---------- 项目说明 ----------
const LINE = /^-\s*([^：:]{1,12})[：:]\s*(.*)$/;
/** 生成的项目说明（第一次）。lines: [[键, 值]] */
function renderProject(lines) {
  return ['# 项目说明（vibe-kit 后台自动探索于 ' + today() + ' 查得）', MARK, '',
    '> 脚本照工程结构查的，没用模型。标着"没跑过"的命令第一次用的时候跑一遍：通了把"（没跑过）"去掉，不通就查清原因、改成对的。',
    '> 这个文件你和 AI 都可以改、可以加行。依据的文件（pom.xml、application-dev.yml 这些）变了，脚本只更新它自己生成的、你们没改过的那几行。',
    '> 脚本查不了的：登录账号（记到 .vibe/login.json）、代码之外的产出放哪。用到的时候问我。', '',
  ].concat(lines.map(([k, v]) => '- ' + k + '：' + v)).join('\n') + '\n';
}
const ALT = '（自动探索）';
/**
 * 把这次生成的行并进项目说明。prev 是上次生成的 { 键: 值 }。只动"这里生成的、没人改过的"行：
 *   文件里这一行和上次生成的一样（没人改过）：换成这次的，算一处变化
 *   这一行被改过（模型跑通了命令、去掉了"没跑过"；人补了话）：不动它。这次查到的和上次不一样（事实变了）时，
 *     在 notes 里说一句"查到的变成了什么"，由模型去核对那一行
 *   这一行不是这里生成的（文件是人写的、/ttls-onboard 写的，里面本来就有"数据库"一行）：不动它，这里查到的另起一行，键后面带"（自动探索）"
 *   文件里没有这个键：上次生成过（被人删了）就不再加；没生成过就加在文件最后（不往中间插：中间可能是一条带着下一级的记录）
 * 返回 { text, changes: [改了哪几行], notes: [没改、要模型核对的], gen: 这次生成的 { 键: 值 }（下次的 prev） }
 */
function mergeProject(text, lines, prev) {
  const L = text.replace(/\r\n/g, '\n').split('\n');
  const at = {};
  L.forEach((l, i) => { const m = LINE.exec(l); if (m && !(m[1].trim() in at)) at[m[1].trim()] = i; });
  const was0 = prev || {};
  const changes = [];
  const notes = [];
  const extra = [];
  const gen = {};
  const same = (a, b) => String(a).trim() === String(b).trim();
  const valueAt = (k) => (LINE.exec(L[at[k]]) || [])[2] || '';
  for (const [k0, v] of lines) {
    let k = k0;
    if ((k0 in at) && was0[k0] === undefined && !same(valueAt(k0), v)) k = k0 + ALT;
    gen[k] = v;
    const was = was0[k];
    if (k in at) {
      const cur = valueAt(k);
      if (same(cur, v)) continue;
      if (was !== undefined && same(cur, was)) { L[at[k]] = '- ' + k + '：' + v; changes.push(k + '：' + v); continue; }
      if (was !== undefined && !same(was, v)) notes.push('"' + k + '"那一行你们改过，没有动；脚本这次查到的是：' + v);
    } else if (was === undefined) { extra.push('- ' + k + '：' + v); changes.push(k + '：' + v); }
  }
  // 这次没有了的键（redis 不用了）：上次是这里生成的、没人改过，就去掉
  for (const k of Object.keys(was0)) {
    if (k in gen || !(k in at)) continue;
    if (same(valueAt(k), was0[k])) { L[at[k]] = null; changes.push(k + '：没有了'); }
  }
  const out = L.filter((l) => l !== null);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { text: out.concat(extra).join('\n') + '\n', changes, notes, gen };
}
/** 项目的 CLAUDE.md 里有没有"项目说明（团队共享）"一节（/ttls-onboard 写的，跟着仓库走，Claude Code 自己会带上） */
function teamNotes(root) {
  for (const f of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) { try { if (/^#{1,3}\s*项目说明（团队共享）/m.test(fs.readFileSync(f, 'utf8'))) return f; } catch (e) { /* 没有 */ } }
  return '';
}

/**
 * 探索一个项目。返回 { root, kind, why, first, wroteProject, changes: [说明…], db, redis, drivers }
 */
function explore(root, why) {
  const t0 = Date.now();
  const recFile = recordFile(root);
  const rec = readJson(recFile) || {};
  const first = !rec.at;
  const f = facts(root);
  const tracked = f.tracked;
  const lines = f.lines.slice();
  const out = { root, kind: f.kind, why: why || '', first, wroteProject: false, changes: [], db: null, redis: null, dbFiles: [], drivers: [], notDev: [] };

  // 数据库、redis：按"这份配置属于哪个项目"分组（多模块落在聚合根；根目录没有构建文件的落在带构建文件的那一层）
  const db = D.scanDb(root);
  const rd = D.scanRedis(root);
  for (const x of db.files.concat(rd.files)) tracked.add(x);
  const devDb = db.found.filter((x) => x.devOnly && x.dialect && !x.unresolved);
  const devRd = rd.found.filter((x) => x.devOnly && !x.unresolved);
  const skipped = db.found.filter((x) => !x.devOnly && x.dialect).length + rd.found.filter((x) => !x.devOnly).length;
  // 没配进来的是哪几个、为什么（手动跑的时候给人看；地址遮掉口令）
  out.notDev = db.found.filter((x) => !x.devOnly && x.dialect).map((x) => ({ kind: 'db', url: shortUrl(x.url), source: x.source + ':' + x.line, why: x.why }))
    .concat(rd.found.filter((x) => !x.devOnly).map((x) => ({ kind: 'redis', url: x.host + ':' + x.port, source: x.source + ':' + x.line, why: x.why })));
  const group = (list) => { const g = new Map(); for (const x of list) { const o = D.owningProject(x.file, root); if (!g.has(o)) g.set(o, []); g.get(o).push(x); } return g; };
  const dbNames = [];
  const rdNames = [];
  const dbGroups = group(devDb);
  const rdGroups = group(devRd);
  // 以前探索到过、现在一个都找不到了：也要过一遍，好标上"找不到了"
  for (const o of (rec.dbOwners || [])) if (!dbGroups.has(o) && exists(o)) dbGroups.set(o, []);
  for (const o of (rec.redisOwners || [])) if (!rdGroups.has(o) && exists(o)) rdGroups.set(o, []);
  // 上一次从项目里找到的口令的指纹：分得出"项目那头改了"和"人在连接配置里改了"
  const memo = { db: isObj(rec.memo) && isObj(rec.memo.db) ? rec.memo.db : {}, redis: isObj(rec.memo) && isObj(rec.memo.redis) ? rec.memo.redis : {} };
  const memoOf = (kind, owner) => { const k = rel(root, owner) || '.'; if (!isObj(memo[kind][k])) memo[kind][k] = {}; return memo[kind][k]; };
  let unread = false;
  for (const [owner, list] of dbGroups) {
    const m = mergeDb(owner, list.map((x) => Object.assign({}, x, { source: rel(owner, x.file) })), memoOf('db', owner));
    if (m.skipped) { unread = true; continue; }
    m.names.forEach((n, i) => { if (!dbNames.some((d) => d.name === n && d.owner === owner)) dbNames.push({ name: n, x: list[i], owner }); });
    for (const n of m.added) out.changes.push('数据库连接多了 ' + n);
    for (const n of m.updated) out.changes.push('数据库连接 ' + n + ' 跟着项目的配置更新了');
    for (const n of m.gone) out.changes.push('数据库连接 ' + n + ' 在项目的配置里找不到了');
    out.db = m;
    if (m.names.length) out.dbFiles.push({ file: m.file, names: m.names.slice() });
  }
  for (const [owner, list] of rdGroups) {
    const m = mergeRedis(owner, list.map((x) => Object.assign({}, x, { source: rel(owner, x.file) })), memoOf('redis', owner));
    if (m.skipped) { unread = true; continue; }
    m.names.forEach((n, i) => { if (!rdNames.some((d) => d.name === n && d.owner === owner)) rdNames.push({ name: n, x: list[i], owner }); });
    for (const n of m.added) out.changes.push('redis 连接多了 ' + n);
    for (const n of m.updated) out.changes.push('redis 连接 ' + n + ' 跟着项目的配置更新了');
    for (const n of m.gone) out.changes.push('redis 连接 ' + n + ' 在项目的配置里找不到了');
    out.redis = m;
  }
  // 测试、生产环境的连接没有配进来，模型也不要自己去配：用户说"查一下线上库"的时候，它得知道这件事要交回给用户
  const NOT_DEV = '。测试、生产环境的连接没有配进来，也不要自己往连接配置里加；要查那些库，告诉我，由我来';
  if (dbNames.length) lines.push(['数据库', dbNames.map((d) => '连接 ' + d.name + '（' + (DIALECT_NAME[d.x.dialect] || d.x.dialect) + '，' + shortUrl(d.x.url) + '，来自 ' + rel(root, d.x.file) + '）').join('；') + '。查库、核对表和字段用 /ttls-db-crud，连接名照这里写' + (skipped ? NOT_DEV : '')]);
  if (rdNames.length) lines.push(['redis', rdNames.map((d) => '连接 ' + d.name + '（' + d.x.host + ':' + d.x.port + '，库 ' + d.x.db + (d.x.mode ? '，' + (d.x.mode === 'cluster' ? '集群' : '哨兵') + '模式，内置的客户端连不了' : '') + '，来自 ' + rel(root, d.x.file) + '）').join('；') + '。查缓存用 /ttls-redis，连接名照这里写' + (skipped && !dbNames.length ? NOT_DEV : '')]);

  // 用到的数据库还没有驱动的：要到 Maven 本地仓库里找。上次找过、没找到的，6 小时内不再找（手动跑的除外），那句提醒照旧留着。
  // 用户在配置页里去掉的那一种不再自动登记回来
  let drv = null;
  let need = [];
  try {
    drv = require('./drivers.js');
    const reg = drv.readRegistry();
    const removed = drv.removedByUser ? drv.removedByUser() : [];
    const declared = [...new Set([...dbGroups.keys()])].flatMap((owner) => drv.projectDrivers(owner));
    need = [...new Set(dbNames.map((d) => d.x.driver || d.x.dialect))].filter((k) => {
      if (!k || removed.includes(k)) return false;
      if (!(reg[k] && exists(reg[k].jar))) return true;
      const pool = reg[k].versions || [reg[k]];
      const wanted = declared.filter((p) => (drv.DIALECTS[k].names || []).some((re) => re.test(p.artifactId + '-' + p.version + '.jar')));
      return wanted.some((p) => !pool.some((v) => v.version === p.version && exists(v.jar)));
    });
  } catch (e) { drv = null; need = []; }
  const missed = Array.isArray(rec.driverMiss) ? rec.driverMiss : [];
  const search = need.length > 0 && (why === '手动' || Date.now() - (Number(rec.driverSearchAt) || 0) > RESCAN_MS || need.some((k) => !missed.includes(k)));
  const missNote = (list) => list.map((k) => DIALECT_NAME[k] || k).join('、') + '的数据库驱动还没有：Maven 本地仓库里没找到，在配置页"数据库驱动"里选一个 jar';
  const driver = { at: Number(rec.driverSearchAt) || 0, miss: search ? [] : need.slice() };

  // 项目说明：没有就生成；有、是这里生成的就并进去；是别人写的（/ttls-onboard、人）只补数据库和 redis 两行。
  // 项目的 CLAUDE.md 里有"项目说明（团队共享）"一节的：命令以那一节为准（同事跑通过的），这里只管数据库和 redis，
  // 不另写一套没跑过的命令——模型手上有两条快检命令时，弱一点的会照没跑过的那条去跑
  const pm = path.join(root, '.vibe', 'project.md');
  const team = teamNotes(root);
  const OWN = (k) => k === '数据库' || k === 'redis' || k === '数据库' + ALT || k === 'redis' + ALT;
  let prev = isObj(rec.lines) ? rec.lines : {};
  const history = (Array.isArray(rec.history) ? rec.history : []).slice();
  let noted = false;
  /** 把项目说明和记录写出来。quiet：找完驱动之后补写的那一次，项目说明变了也不算"探索结果变了"（模型用到查库的技能时自己会知道缺驱动） */
  const commit = (quiet) => {
    const notes = f.notes.concat(driver.miss.length ? [missNote(driver.miss)] : []);
    const full = lines.concat(notes.length ? [['坑', notes.join('；')]] : []);
    const all = team ? [['命令', '快检、全量、启动的命令以 ' + rel(root, team) + ' 的"项目说明（团队共享）"一节为准']].concat(full.filter(([k]) => OWN(k))) : full;
    const cur = exists(pm) ? readStrict(pm) : '';
    let gen = prev;
    if (cur === null) log('项目说明读不出来，这次不动它：' + pm);
    else if (!cur.trim()) {
      if (f.kind !== 'unknown' || dbNames.length || rdNames.length) {
        writeAtomic(pm, renderProject(all));
        out.wroteProject = true;
        if (!first && !quiet) out.changes.push('项目说明重新生成了');
      }
      gen = {};
      for (const [k, v] of all) gen[k] = v;
    } else {
      const mine = cur.includes(MARK);
      const use = mine ? all : all.filter(([k]) => OWN(k));
      // 别人写的项目说明里，归这里管的只有数据库和 redis 两行：别的行就算和这里查到的一字不差，也不是这里生成的，不能当成"没人改过"去掉
      const own = (o) => { const r = {}; for (const k of Object.keys(o)) if (OWN(k)) r[k] = o[k]; return r; };
      const m = mergeProject(cur, use, mine ? prev : own(prev));
      if (m.text !== cur) { writeAtomic(pm, m.text); if (!quiet) for (const c of m.changes) if (!out.changes.some((x) => x.startsWith(c.split('：')[0]))) out.changes.push('项目说明的"' + c.split('：')[0] + '"那一行更新了'); }
      if (!quiet) for (const n of m.notes) if (!out.changes.includes(n)) out.changes.push(n);
      out.wroteProject = mine;
      gen = m.gen;
    }
    const tr = {};
    for (const x of tracked) { const s = stamp(x); if (s) tr[path.resolve(x)] = s; }
    prev = gen;
    if (!noted && (first || out.changes.length)) { history.push({ at: Date.now(), why: out.why, changes: first ? ['第一次探索'] : out.changes.slice(0, 10) }); noted = true; }
    // 有文件读不出来、这次没并进去的：十分钟之后再来一遍（不记成"刚扫过"）
    const scanAt = unread || cur === null ? Date.now() - RESCAN_MS + 600000 : Date.now();
    writeAtomic(recFile, JSON.stringify({ version: 1, at: rec.at || t0, updatedAt: Date.now(), scanAt, root, kind: f.kind, wroteProject: out.wroteProject, tracked: tr, lines: gen, memo,
      dbOwners: [...dbGroups.keys()], redisOwners: [...rdGroups.keys()], skippedNonDev: skipped, driverSearchAt: driver.at, driverMiss: driver.miss, ms: Date.now() - t0, history: history.slice(-10) }, null, 1) + '\n');
  };
  // 先写出来（用户开口时就带得上），再去找驱动：仓库大、驱动又不在常见位置的时候，找一遍要十几秒
  commit(false);
  // 连接配置里有口令：.vibe 先进 .gitignore，再干别的
  try { require('./session.js').ensureVibeIgnored(path.join(root, '.vibe')); for (const o of [...dbGroups.keys(), ...rdGroups.keys()]) require('./session.js').ensureVibeIgnored(path.join(o, '.vibe')); } catch (e) { /* 加不上不影响 */ }
  if (search) {
    try {
      const r = drv.auto({ only: need, budgetMs: 20000, quick: true });
      out.drivers = r.used.map((u) => u.name + ' ' + path.basename(u.jar));
      driver.miss = r.missing.filter((k) => need.includes(k));
    } catch (e) { log('找驱动出错：' + ((e && e.message) || e)); driver.miss = need.slice(); }
    driver.at = Date.now();
    commit(true);
  }
  if (out.drivers.length) log('登记了驱动：' + out.drivers.join('、'));
  log('探索 ' + root + '（' + (why || '') + '）：' + f.kind + '，数据库 ' + dbNames.length + ' 个，redis ' + rdNames.length + ' 个，没配进来的非开发环境连接 ' + skipped + ' 个，' + (Date.now() - t0) + ' ms' + (out.changes.length ? '；' + out.changes.join('；') : ''));
  return out;
}

// ---------- 钩子调的 ----------
const LOCK_MS = 5 * 60000;
function lockFile(root) { return path.join(root, '.vibe', 'onboard.lock'); }
function locked(root) { try { const l = JSON.parse(fs.readFileSync(lockFile(root), 'utf8')); if (!l || Date.now() - (l.at || 0) > LOCK_MS) return false; try { process.kill(l.pid, 0); return l.pid !== process.pid; } catch (e) { return !!e && e.code === 'EPERM'; } } catch (e) { return false; } }
/** 后台进程干的事：把该探索的都探索一遍 */
function run(cwd, force) {
  const out = [];
  // 项目里的旧技能带着驱动的：先收进来，下面探索时就不用到 Maven 仓库里找了
  rescueDrivers(oldSkills(cwd));
  for (const root of targetsOf(cwd)) {
    const why = force ? '手动' : due(root);
    if (!why || locked(root)) continue;
    try {
      fs.mkdirSync(path.join(root, '.vibe'), { recursive: true });
      fs.writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, at: Date.now() }));
      out.push(explore(root, why));
      noteFail(root, true);
    } catch (e) { log('探索 ' + root + ' 出错：' + ((e && e.stack) || e)); out.push({ root, error: String((e && e.message) || e) }); noteFail(root, false); } finally { try { fs.unlinkSync(lockFile(root)); } catch (e) { /* 没有锁 */ } }
  }
  return out;
}
/**
 * 钩子里调：该探索了就甩一个后台进程，自己马上返回。返回甩没甩。
 * 同一个目录 3 秒内不重复甩（会话开始和第一次开口挨着来）。开关 autoOnboard 关着、环境变量 VIBE_KIT_NO_ONBOARD=1 时什么都不做
 */
function kick(cwd, why) {
  try {
    if (process.env.VIBE_KIT_NO_ONBOARD === '1' || !config().on) return false;
    const dir = path.resolve(cwd || process.cwd());
    const roots = targetsOf(dir);
    if (!roots.length) return false;
    const need = roots.filter((r) => !locked(r) && due(r) && !failedLately(r));
    if (!need.length) return false;
    const S = require('./session.js');
    const key = 'onboard-kick';
    const st = S.readState(key);
    const k = S.normKey(dir);
    if (st[k] && Date.now() - st[k] < KICK_GAP_MS) return false;
    st[k] = Date.now();
    for (const x of Object.keys(st)) if (Date.now() - st[x] > 86400000) delete st[x];
    S.writeState(key, st);
    const c = spawn(process.execPath, [path.join(KIT, 'tools', 'onboard.js'), 'run', '--dir', dir, '--quiet'], { detached: true, windowsHide: true, stdio: 'ignore', cwd: KIT, env: Object.assign({}, process.env) });
    c.on('error', () => {});
    c.unref();
    S.hookLog('onboard 甩了一个后台进程（' + (why || '') + '）：' + need.map((r) => path.basename(r)).join('、'));
    return true;
  } catch (e) { return false; }
}

/**
 * 探索正在跑（刚甩出去、还没写出结果）：等它一小会儿。没探索过的、依据的文件改了还没重新探索完的才等；没有在跑的不等。
 * 用户开口离甩出去很近的时候（claude -p，或者手快），不等的话这条消息带不上项目说明、带不上"哪几处变了"，
 * 模型接着查库用的还是旧的连接
 */
function waitFresh(cwd, ms) {
  try {
    if (process.env.VIBE_KIT_NO_ONBOARD === '1' || !config().on) return false;
    const roots = targetsOf(cwd).filter((r) => !failedLately(r));
    const pending = () => roots.filter((r) => !exists(recordFile(r)) || due(r));
    if (!pending().length) return false;
    const S = require('./session.js');
    const kicked = S.readState('onboard-kick')[S.normKey(path.resolve(cwd || process.cwd()))] || 0;
    if (Date.now() - kicked > 10000 && !roots.some(locked)) return false;      // 没有在跑的：不等
    const end = Date.now() + (ms || 1500);
    while (Date.now() < end && pending().length) S.sleepMs(100);
    return !pending().length;
  } catch (e) { return false; }
}

/**
 * 会话开始、当前目录往上没有项目说明的时候，告诉模型现在是哪种情况（都有项目说明了返回 ''）：
 *   正在探索：等着，不用自己查；探索过了没认出是什么工程、探索没跑成、自动探索关着：要改东西先跑 /ttls-onboard。
 * 全局约定里不再写这件事：那句话每个请求都带，又说不清是哪种情况
 */
function startNote(cwd, kicked) {
  const roots = targetsOf(cwd).filter((r) => !exists(path.join(r, '.vibe', 'project.md')));
  if (!roots.length) return '';
  const names = roots.length > 1 ? '（' + roots.slice(0, 6).map((r) => path.basename(r)).join('、') + '）' : '';
  const TAIL = '要改东西先跑 /ttls-onboard；只是回答问题不用管。';
  if (!config().on) return '这个项目还没有项目说明' + names + '。后台自动探索关着：' + TAIL;
  if (kicked || roots.some((r) => locked(r) || (due(r) && !failedLately(r) && process.env.VIBE_KIT_NO_ONBOARD !== '1'))) {
    return '这个项目还没有项目说明' + names + '，套件正在后台自动探索（查工程类型、构建和启动命令、编码、开发环境的数据库和 redis 连接），几秒钟就好，探索好了会在我下一条消息里带给你。不用自己跑 /ttls-onboard。';
  }
  if (roots.some(failedLately)) return '这个项目还没有项目说明' + names + '。后台自动探索没跑成（多半是项目目录写不了）：' + TAIL;
  if (roots.every((r) => exists(recordFile(r)))) return '这个项目还没有项目说明' + names + '。后台探索过了，没认出这是什么工程：' + TAIL;
  return '';
}

/**
 * 这个会话还没听说过的探索结果：第一次探索好了、或者依据的文件改了之后更新了。返回给模型看的话（没有返回 ''）。
 * 每条只说一次（记在 state/<会话>-onboard.json 里）。会话开始时项目说明已经带过的，第一次那条不重复说
 */
function noticeFor(j, atStart) {
  try {
    if (!j || !j.session_id || !config().on) return '';
    const S = require('./session.js');
    const cwd = path.resolve(j.cwd || process.cwd());
    const key = String(j.session_id) + '-onboard';
    const seen = S.readState(key);
    const out = [];
    let dirty = false;
    for (const root of targetsOf(cwd)) {
      const rec = readJson(recordFile(root));
      if (!rec || !rec.at) continue;
      const k = S.normKey(root);
      const last = seen[k] || 0;
      if ((rec.updatedAt || 0) <= last) continue;
      const pm = path.join(root, '.vibe', 'project.md');
      if (atStart) { seen[k] = rec.updatedAt; dirty = true; continue; }       // 会话开始时项目说明整份带过了
      const news = (rec.history || []).filter((h) => h.at > last);
      seen[k] = rec.updatedAt;
      dirty = true;
      if (!news.length) continue;
      if (news.some((h) => (h.changes || []).includes('第一次探索'))) {
        let text = exists(pm) ? readText(pm).trim() : '';
        if (text.length > 3000) text = text.slice(0, 3000) + '\n…（后面的自己去读）';
        if (text) out.push('这个项目后台自动探索好了，项目说明在 ' + pm + '：\n' + text);
      } else {
        const ch = [...new Set(news.flatMap((h) => h.changes || []))].slice(0, 8);
        if (ch.length) out.push('项目依据的文件改了，后台重新探索过（' + path.basename(root) + '）：' + ch.join('；') + '。以 ' + pm + ' 现在写的为准。');
      }
    }
    if (dirty) S.writeState(key, Object.assign({}, seen, { at: Date.now() }));
    return out.join('\n\n');
  } catch (e) { return ''; }
}

/**
 * 只看不写：这个目录下的配置文件里有哪些数据库、redis 的连接，各是哪个环境的。
 * 给人看、给模型看的：地址里的口令遮掉，口令本身不给，只说找没找到
 */
function scan(root) {
  const db = D.scanDb(root);
  const rd = D.scanRedis(root);
  return {
    root,
    db: db.found.map((x) => ({ url: D.maskUrl(x.url), user: x.user || '', hasPassword: !!x.password, encrypted: !!x.encrypted, source: x.source, line: x.line, dialect: x.dialect || '', driver: x.driver || '', env: x.env || '', devOnly: !!x.devOnly, why: x.why || '', unresolved: !!x.unresolved })),
    redis: rd.found.map((x) => ({ host: x.host, port: x.port, db: x.db, hasPassword: !!x.password, encrypted: !!x.encrypted, mode: x.mode || '', source: x.source, line: x.line, env: x.env || '', devOnly: !!x.devOnly, why: x.why || '', unresolved: !!x.unresolved })),
  };
}
/** 给配置页和命令行：这个目录下各个项目探索得怎么样了 */
function status(cwd) {
  return targetsOf(cwd).map((root) => {
    const rec = readJson(recordFile(root)) || {};
    return { root, explored: !!rec.at, kind: rec.kind || '', at: rec.at || 0, updatedAt: rec.updatedAt || 0, due: due(root), running: locked(root), project: path.join(root, '.vibe', 'project.md'), wroteProject: !!rec.wroteProject, tracked: Object.keys(rec.tracked || {}).length, history: rec.history || [], skippedNonDev: rec.skippedNonDev || 0 };
  });
}

module.exports = { MARK, NOT_RUN, targetsOf, due, facts, explore, run, scan, kick, waitFresh, noticeFor, startNote, teamNotes, failedLately, status, oldSkills, oldSkillNotice, mergeDb, mergeRedis, mergeProject, renderProject, readPom, propOf, springFacts, frontendFacts, encodingFacts, changedFiles };

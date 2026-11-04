'use strict';
/*
 * IDEA 里配的 Maven 和 JDK（问题表第 33 条，2026-11-02 用户定的：项目在 IDEA 里肯定能起来，它配的是首选）。只读文件，不连 IDEA、不起进程。
 *
 * 读哪里（照 IDEA 2026.2 的 Maven 插件和实际的配置文件核对过）：
 *   <项目>/.idea/workspace.xml   MavenImportPreferences 里的 MavenGeneralSettings：
 *                                  mavenHomeTypeForPersistence（WRAPPER、BUNDLED3、BUNDLED4、CUSTOM）、customMavenHome、
 *                                  mavenHome（老版本：路径，或者"Bundled (Maven 3)""Use Maven wrapper"这种名字，中文版 IDEA 可能是中文）、
 *                                  userSettingsFile、localRepository
 *                                MavenRunner 的 jreName（#USE_PROJECT_JDK、#JAVA_HOME、#JAVA_INTERNAL，或者 JDK 的名字）
 *   <项目>/.idea/misc.xml        ProjectRootManager 的 project-jdk-name
 *   <IDE 配置目录>/options/project.default.xml   新项目的默认设置：项目自己没写 Maven 设置时看它
 *   <IDE 配置目录>/options/jdk.table.xml         JDK 名字对应哪个目录
 *   <IDE 配置目录>/options/recentProjects.xml    配置页"自动探测"用：最近打开过哪些项目，它们配的 Maven 也列出来
 *
 * .idea 从项目往上找（壳子、聚合工程把 .idea 放在上一层）：最多三层，到用户目录、盘符根为止。
 * 没配的项就是没配：IDEA 的默认和 Maven 自己的默认一样（~/.m2/settings.xml、~/.m2/repository），命令不用带参数。
 * 值里的 $PROJECT_DIR$、$USER_HOME$、$MAVEN_REPOSITORY$ 展开；指的目录、文件已经不在的不算。
 * 测试用 VIBE_KIT_IDEA_ROOTS 指 IDEA 的安装目录在哪找（分号隔开），不碰本机真装的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENT = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const unxml = (s) => String(s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&(?:quot|apos|lt|gt|amp);/g, (m) => ENT[m]);
const slash = (p) => String(p || '').replace(/\\/g, '/');
function read(file) {
  try { const st = fs.statSync(file); if (!st.isFile() || st.size > 8 * 1024 * 1024) return ''; return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const isMaven = (home) => !!home && (isFile(path.join(home, 'bin', 'mvn')) || isFile(path.join(home, 'bin', 'mvn.cmd')));
const componentOf = (text, name) => (new RegExp('<component\\s+name="' + name + '"[^>]*>([\\s\\S]*?)</component>').exec(text) || [])[1] || '';
function optionsOf(block) {
  const out = {};
  const re = /<option\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g;
  let m;
  while ((m = re.exec(block))) out[m[1]] = unxml(m[2]);
  return out;
}
/** 展开 IDEA 的路径变量。认不出的变量（$APPLICATION_HOME_DIR$ 这类）当没写 */
function expand(value, base) {
  const home = os.homedir();
  const v = String(value || '').trim()
    .replace(/\$PROJECT_DIR\$/g, () => slash(base || '.'))
    .replace(/\$USER_HOME\$/g, () => slash(home))
    .replace(/\$MAVEN_REPOSITORY\$/g, () => slash(path.join(home, '.m2', 'repository')));
  return !v || /\$[A-Z_]+\$/.test(v) ? '' : slash(v);
}
/** 一份 XML 里的 Maven 设置，只要写了的。没写返回 null */
function generalOf(text, base) {
  const block = /<MavenGeneralSettings>([\s\S]*?)<\/MavenGeneralSettings>/.exec(componentOf(text, 'MavenImportPreferences'));
  if (!block) return null;
  const o = optionsOf(block[1]);
  const type = String(o.mavenHomeTypeForPersistence || '').toUpperCase();
  const legacy = String(o.mavenHome || '');
  const pathLike = (s) => /[\\/$]/.test(s);
  let kind = '';
  let home = '';
  if (type === 'WRAPPER' || (!type && !pathLike(legacy) && /wrapper|包装/i.test(legacy))) kind = 'wrapper';
  else if (/^BUNDLED/.test(type) || (!type && legacy && !pathLike(legacy))) kind = 'bundled';
  else { home = expand(o.customMavenHome || legacy, base); if (home) kind = 'custom'; }
  const g = { kind, home, settings: expand(o.userSettingsFile, base), repo: expand(o.localRepository, base) };
  return g.kind || g.settings || g.repo ? g : null;
}
/** 项目和它上面几层的 .idea，近的在前 */
function ideaDirs(root) {
  const out = [];
  const home = path.resolve(os.homedir()).toLowerCase();
  let d = path.resolve(root);
  for (let i = 0; i < 4; i++) {
    if (d.toLowerCase() === home) break;
    const x = path.join(d, '.idea');
    if (isDir(x)) out.push({ base: d, idea: x });
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}
/** 这个项目里写着的设置，不看 IDE 的全局配置：{ general, jre, projectJdk, from: [依据的文件] } */
function projectRaw(root) {
  const out = { general: null, jre: '', projectJdk: '', dirs: ideaDirs(root) };
  for (const { base, idea } of out.dirs) {
    const ws = read(path.join(idea, 'workspace.xml'));
    if (!out.general) out.general = generalOf(ws, base);
    if (!out.jre) out.jre = optionsOf(componentOf(ws, 'MavenRunner')).jreName || '';
    if (!out.projectJdk) { const m = /<component\s+name="ProjectRootManager"[^>]*\sproject-jdk-name="([^"]*)"/.exec(read(path.join(idea, 'misc.xml'))); if (m) out.projectJdk = unxml(m[1]); }
  }
  return out;
}
/** 这个项目的 IDEA 设置的指纹：探索的"该不该再跑一次"用。workspace.xml 开着 IDEA 时老在变，不能按修改时间算，这几项变了才算变 */
function digest(root) {
  try {
    const r = projectRaw(root);
    if (!r.general && !r.jre && !r.projectJdk) return '';
    return JSON.stringify([r.general, r.jre, r.projectJdk]);
  } catch (e) { return ''; }
}
/** IDE 的配置目录，最近用过的在前 */
function configDirs() {
  const home = os.homedir();
  const out = [];
  const add = (dir) => { const options = path.join(dir, 'options'); if (isDir(options)) { let at = 0; try { at = fs.statSync(options).mtimeMs; } catch (e) { at = 0; } out.push({ options, at }); } };
  for (const r of [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'JetBrains'), path.join(home, '.config', 'JetBrains'), path.join(home, 'Library', 'Application Support', 'JetBrains')]) {
    let names = [];
    try { names = fs.readdirSync(r); } catch (e) { names = []; }
    for (const n of names) if (/^(?:IntelliJIdea|IdeaIC)\d/.test(n)) add(path.join(r, n));
  }
  // 2020 之前的版本放在用户目录下：~/.IntelliJIdea2019.3/config
  try { for (const n of fs.readdirSync(home)) if (/^\.(?:IntelliJIdea|IdeaIC)\d/.test(n)) add(path.join(home, n, 'config')); } catch (e) { /* 读不了 */ }
  return out.sort((a, b) => b.at - a.at).map((x) => x.options);
}
/** IDE 登记的 JDK：[{ name, home }]，不在了的不算 */
function jdkTable() {
  const seen = new Set();
  const out = [];
  for (const options of configDirs()) {
    const re = /<jdk\b[^>]*>([\s\S]*?)<\/jdk>/g;
    const text = read(path.join(options, 'jdk.table.xml'));
    let m;
    while ((m = re.exec(text))) {
      const val = (tag) => unxml((new RegExp('<' + tag + '\\s+value="([^"]*)"').exec(m[1]) || [])[1] || '');
      if (val('type') && val('type') !== 'JavaSDK') continue;
      const name = val('name'); const home = expand(val('homePath'));
      if (!name || !home || seen.has(name) || !isDir(home)) continue;
      seen.add(name);
      out.push({ name, home });
    }
  }
  return out;
}
/** IDEA 自带的 Maven：在常见的安装位置找 */
function bundledHome() {
  const roots = [];
  if (process.env.VIBE_KIT_IDEA_ROOTS !== undefined) roots.push(...String(process.env.VIBE_KIT_IDEA_ROOTS).split(';').filter(Boolean));
  else {
    if (process.platform === 'win32') for (const d of ['C', 'D', 'E', 'F']) for (const p of ['Program Files\\JetBrains', 'Program Files (x86)\\JetBrains', 'JetBrains']) roots.push(d + ':\\' + p);
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs'), path.join(process.env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps'));
    roots.push('/opt', '/Applications');
  }
  for (const r of roots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch (e) { continue; }
    for (const n of names.filter((x) => /intellij|idea/i.test(x)).sort().reverse()) for (const sub of ['plugins/maven-plugin/lib/maven3', 'plugins/maven/lib/maven3', 'Contents/plugins/maven/lib/maven3']) {
      const h = path.join(r, n, sub);
      if (isMaven(h)) return slash(h);
    }
  }
  return '';
}
/**
 * 这个项目在 IDEA 里配的。返回 { idea: .idea 目录（没有是 ''）, kind: custom | bundled | wrapper | ''（没选过）, home, settings, repo, jdkName, jdkHome, fromDefault: 取的是 IDE 的新项目默认设置 }。
 * 文件不在了的项不返回
 */
function mavenOf(root) {
  const raw = projectRaw(root);
  let general = raw.general;
  let fromDefault = false;
  if (!general) {
    for (const options of configDirs()) {
      const g = generalOf(read(path.join(options, 'project.default.xml')), path.resolve(root));
      if (g) { general = g; fromDefault = true; break; }
    }
  }
  const g = general || { kind: '', home: '', settings: '', repo: '' };
  const home = g.kind === 'custom' && isMaven(g.home) ? g.home : '';
  const out = { idea: raw.dirs.length ? slash(raw.dirs[0].idea) : '', kind: g.kind === 'custom' && !home ? '' : g.kind, home, settings: isFile(g.settings) ? g.settings : '', repo: isDir(g.repo) ? g.repo : '', jdkName: '', jdkHome: '', fromDefault };
  // Maven 跑的时候用哪个 JDK：MavenRunner 选了具体的就用它，选的是项目 JDK、没选就看项目的。#JAVA_HOME、IDEA 自带的不算
  const jre = String(raw.jre || '');
  const name = !jre || jre === '#USE_PROJECT_JDK' ? raw.projectJdk : jre[0] === '#' ? '' : jre;
  if (name) { const hit = jdkTable().find((j) => j.name === name); out.jdkName = name; if (hit) out.jdkHome = hit.home; }
  return out;
}
/** 这台电脑上 IDEA 知道的 Maven 和 JDK（配置页"自动探测"用）：{ mavens: [{ home, settings, repo }], jdks: [{ name, home }] }。新项目默认设置和最近打开过的项目都看 */
function machine() {
  const mavens = [];
  const seen = new Set();
  const add = (g) => {
    if (!g || g.kind !== 'custom' || !isMaven(g.home)) return;
    const k = g.home.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    mavens.push({ home: g.home, settings: isFile(g.settings) ? g.settings : '', repo: isDir(g.repo) ? g.repo : '' });
  };
  const home = slash(os.homedir());
  for (const options of configDirs()) {
    add(generalOf(read(path.join(options, 'project.default.xml'))));
    const recent = read(path.join(options, 'recentProjects.xml'));
    const re = /<entry\s+key="([^"]+)"/g;
    let m;
    let n = 0;
    while ((m = re.exec(recent)) && n < 30) {
      const p = unxml(m[1]).replace(/\$USER_HOME\$/g, home);
      if (!isDir(p)) continue;
      n++;
      add(generalOf(read(path.join(p, '.idea', 'workspace.xml')), p));
    }
  }
  return { mavens, jdks: jdkTable() };
}

module.exports = { mavenOf, machine, digest, bundledHome, generalOf, configDirs, jdkTable };

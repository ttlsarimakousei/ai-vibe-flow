'use strict';
/*
 * K1-6 依赖清单（Codex 改进路线第 11 节）：随包的 node_modules、查库执行器的 class 要说得清是什么、从哪来。
 *   打包      pack.js 生成 kit/deps.json：两个组件（看页面、自带的 OpenSpec）的每个顶层包的名字、版本、要求的 Node、来源、内容哈希，
 *             执行器的编译记录；--check-only 只检查、生成清单，不写版本号、不压缩、不留基线
 *   执行器    DbRunner.java 改了没重编（修改时间照样新，像刚检出的）不打包；class 被换过也不打包；说清怎么重编
 *   安装      安装器按清单核对每个包在不在、版本对不对；这台电脑的 Node 不够哪个组件，说清是哪个、要多少
 * 打包那几项在临时目录里拼一个仓库（vibe-kit + dev/pack.js）跑，不碰仓库里的版本号、压缩包、基线。
 * 用法：node dev/test-deps-manifest.js [旧版的 vibe-kit 目录]（给了就拿旧版的安装器、那一版标签上的 pack.js 跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'install.js')) ? path.resolve(process.argv[2]) : null;
const json = (f) => { try { return JSON.parse(H.read(f)); } catch (e) { return null; } };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const RUNNER = path.join('claude', 'skills', 'ttls-db-crud', 'scripts', 'runner');

// ---------------------------------------------------------------------------------------------
H.section('版本范围的判断（engines.node 的写法）');
{
  let D = null;
  try { D = require(path.join(FROM || H.SRC, 'kit', 'lib', 'deps.js')); } catch (e) { D = null; }
  H.ok('有 kit/lib/deps.js', !!D);
  if (D) {
    const cases = [['20.19.0', '>=20.19.0', true], ['20.18.1', '>=20.19.0', false], ['21.7.0', '20 || >=22', false], ['22.1.0', '20 || >=22', true], ['20.17.0', '>=23.5.0 || ^22.13.0 || ^20.17.0', true],
      ['21.0.0', '>=23.5.0 || ^22.13.0 || ^20.17.0', false], ['14.13.1', '^12.17.0 || ^14.13 || >=16.0.0', true], ['8.0.0', '>= 8', true], ['18.0.0', '', true], ['1.2.3', '1.2.3 - 1.4', true], ['1.5.0', '1.2.3 - 1.4', false]];
    const bad = cases.filter(([v, r, want]) => D.satisfies(v, r) !== want);
    H.ok('满足不满足判断对', bad.length === 0, bad);
    H.ok('最低版本', D.minOf('>=20.19.0') === '20.19.0' && D.minOf('>=23.5.0 || ^22.13.0 || ^20.17.0') === '20.17.0' && D.minOf('>=20') === '20.0.0', [D.minOf('>=20.19.0'), D.minOf('>=23.5.0 || ^22.13.0 || ^20.17.0')]);
  }
}

// ---------------------------------------------------------------------------------------------
// 临时仓库：vibe-kit（带真的 node_modules）+ dev/pack.js 和它要的 dev/lib。拿旧版跑时 pack.js 取那一版标签上的
const repo = H.tempDir('tdm-repo');
const kitPkg = path.join(repo, 'vibe-kit');
H.copyDir(FROM || H.SRC, kitPkg, (n) => n === '.git' || (FROM ? n === 'node_modules' : false));
if (FROM) for (const c of ['page', 'openspec']) H.copyDir(path.join(H.SRC, 'kit', c, 'node_modules'), path.join(kitPkg, 'kit', c, 'node_modules'));
fs.mkdirSync(path.join(repo, 'dev', 'lib'), { recursive: true });
let packOk = true;
if (FROM) {
  const ver = (H.read(path.join(FROM, 'kit', 'VERSION')) || '').trim();
  const show = (f) => H.git(H.REPO, ['show', 'v' + ver + ':' + f]);
  const p = show('dev/pack.js');
  packOk = H.ok('拿到了旧版标签上的 pack.js（v' + ver + '）', p.code === 0 && /Compress-Archive/.test(p.out), p.err);
  H.write(path.join(repo, 'dev', 'pack.js'), p.out);
  for (const f of ['unzip.js', 'db-runner-record.js']) { const r = show('dev/lib/' + f); if (r.code === 0) H.write(path.join(repo, 'dev', 'lib', f), r.out); }
} else {
  fs.copyFileSync(path.join(H.REPO, 'dev', 'pack.js'), path.join(repo, 'dev', 'pack.js'));
  for (const f of ['unzip.js', 'db-runner-record.js']) fs.copyFileSync(path.join(H.REPO, 'dev', 'lib', f), path.join(repo, 'dev', 'lib', f));
}
// 更新说明里不留这一版的章节：旧版的 pack.js 不认 --check-only，靠它在压缩之前停下
{
  const f = path.join(kitPkg, '更新说明.md');
  H.write(f, (H.read(f) || '').replace(/^## \d{8}\.\d{4}（最新）/m, '## 以前的版本'));
}
const versionBefore = H.read(path.join(kitPkg, 'kit', 'VERSION'));
const packHome = H.freshHome('tdm-pack');
const pack = () => H.node(packHome, path.join(repo, 'dev', 'pack.js'), ['--check-only'], { cwd: repo, timeout: 600000 });
const noZip = () => !fs.readdirSync(repo).some((n) => /\.zip$/i.test(n)) && !fs.existsSync(path.join(repo, 'dev', 'baseline'));

H.section('打包时生成依赖清单：每个顶层包都在，带版本、Node 要求、来源、哈希');
const manFile = path.join(kitPkg, 'kit', 'deps.json');
try { fs.unlinkSync(manFile); } catch (e) { /* 没有 */ }
if (packOk) {
  const r = pack();
  const man = json(manFile);
  H.ok('--check-only 过了，没压缩、没留基线、没改版本号', r.code === 0 && noZip() && H.read(path.join(kitPkg, 'kit', 'VERSION')) === versionBefore, r.out.slice(-1200) + r.err.slice(-400));
  H.ok('生成了 kit/deps.json', !!man && Array.isArray(man.components), r.out.slice(-600));
  const tops = (nm) => { const out = []; for (const n of fs.readdirSync(nm)) { if (n.startsWith('.')) continue; if (n.startsWith('@')) { for (const s of fs.readdirSync(path.join(nm, n))) out.push(n + '/' + s); } else out.push(n); } return out.sort(); };
  for (const [id, mainPkg] of [['page', 'playwright'], ['openspec', '@fission-ai/openspec']]) {
    const nm = path.join(kitPkg, 'kit', id, 'node_modules');
    const c = man && man.components.find((x) => x.id === id);
    const listed = c ? c.packages.map((p) => p.name).sort() : [];
    const want = tops(nm);
    H.ok(id + '：node_modules 里的每个顶层包都在清单里（' + want.length + ' 个）', JSON.stringify(listed) === JSON.stringify(want), { 少了: want.filter((n) => !listed.includes(n)), 多了: listed.filter((n) => !want.includes(n)) });
    const wrong = (c ? c.packages : []).filter((p) => {
      const pj = json(path.join(nm, ...p.name.split('/'), 'package.json')) || {};
      return p.version !== String(pj.version || '') || p.node !== String((pj.engines && pj.engines.node) || '') || !p.source || !/^sha256-[0-9a-f]{64}$/.test(p.hash) || !(p.files > 0);
    }).map((p) => p.name);
    H.ok(id + '：每个包的版本、Node 要求和 package.json 一致，有来源、内容哈希', !!c && wrong.length === 0, wrong);
    const mainJson = json(path.join(nm, ...mainPkg.split('/'), 'package.json')) || {};
    H.ok(id + '：组件要求的 Node 按主包 ' + mainPkg + ' 算', !!c && c.node === String((mainJson.engines && mainJson.engines.node) || '') && !!c.node, c && c.node);
  }
  const os1 = man && (man.components.find((x) => x.id === 'openspec') || { packages: [] }).packages.find((p) => p.name === '@fission-ai/openspec');
  H.ok('OpenSpec 的来源是 lock 文件里的下载地址和校验值', !!os1 && /^https:\/\/registry\.npmjs\.org\//.test(os1.source) && /^sha512-/.test(os1.integrity), os1);
  const rd = path.join(kitPkg, RUNNER);
  const classes = fs.readdirSync(rd).filter((n) => /^DbRunner(\$[\w$]+)?\.class$/.test(n)).sort();
  H.ok('清单里带着执行器的编译记录：源码的哈希、每个 class', !!man && !!man.runner && man.runner.source && man.runner.source.sha256 === sha256(path.join(rd, 'DbRunner.java'))
    && JSON.stringify(Object.keys(man.runner.classes || {}).sort()) === JSON.stringify(classes), man && man.runner);
  if (!FROM) H.ok('源码里提交的 kit/deps.json 是最新的（和现在的依赖重新生成的一字不差）', H.read(manFile) === H.read(path.join(H.SRC, 'kit', 'deps.json')), '依赖改了要跑一次 node dev/pack.js --check-only 再提交');
}

// ---------------------------------------------------------------------------------------------
H.section('执行器：.java 改了没重编、class 被换过，都不打包');
if (packOk) {
  const rd = path.join(kitPkg, RUNNER);
  const java = path.join(rd, 'DbRunner.java');
  const orig = fs.readFileSync(java);
  // 改了源码；class 的修改时间也拨新（像刚从仓库检出的，修改时间说明不了先后）
  fs.writeFileSync(java, Buffer.concat([orig, Buffer.from('\n// 改了一行没重新编译\n')]));
  const later = new Date(Date.now() + 60000);
  for (const n of fs.readdirSync(rd).filter((x) => /\.class$/.test(x))) fs.utimesSync(path.join(rd, n), later, later);
  const r = pack();
  H.ok('.java 改了没重编：不打包，说清怎么重编', r.code !== 0 && /DbRunner\.java 改了没重新编译/.test(r.out) && /build-db-runner\.js/.test(r.out) && noZip(), r.out.slice(-800));
  fs.writeFileSync(java, orig);
  const cls = path.join(rd, 'DbRunner$Scope.class');
  const c0 = fs.readFileSync(cls);
  fs.writeFileSync(cls, Buffer.concat([c0, Buffer.from([0])]));
  const r2 = pack();
  H.ok('class 被换过（和编译记录对不上）：不打包', r2.code !== 0 && /class 和编译记录对不上/.test(r2.out) && /DbRunner\$Scope\.class/.test(r2.out) && noZip(), r2.out.slice(-800));
  fs.writeFileSync(cls, c0);
}

// ---------------------------------------------------------------------------------------------
H.section('安装器读清单：包不全、版本对不上不装；Node 不够哪个组件说清楚');
{
  // 旧版的 pack.js 生成不了清单：用这一版的库生成一份放进去，看旧版的安装器认不认
  if (!fs.existsSync(manFile)) {
    try { const D = require(path.join(H.SRC, 'kit', 'lib', 'deps.js')); H.write(manFile, JSON.stringify(D.scan(kitPkg), null, 2) + '\n'); } catch (e) { H.ok('生成清单', false, e.message); }
  }
  const install = (name) => { const u = H.freshHome(name); return Object.assign(H.node(u, path.join(kitPkg, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 300000 }), { u }); };
  // 少一个包
  const zod = path.join(kitPkg, 'kit', 'openspec', 'node_modules', 'zod');
  fs.renameSync(zod, zod + '.away');
  const r1 = install('tdm-miss');
  fs.renameSync(zod + '.away', zod);
  H.ok('少了一个包：不装，说缺哪个', r1.code !== 0 && /安装包不完整：缺 kit\/openspec\/node_modules\/zod/.test(r1.out) && !fs.existsSync(path.join(r1.u.kit, 'hooks')), r1.out.slice(-600));
  // 版本和清单对不上
  const pj = path.join(kitPkg, 'kit', 'page', 'node_modules', 'pngjs', 'package.json');
  const pj0 = fs.readFileSync(pj);
  H.write(pj, JSON.stringify(Object.assign(JSON.parse(pj0.toString('utf8')), { version: '6.0.0' })));
  const r2 = install('tdm-ver');
  fs.writeFileSync(pj, pj0);
  H.ok('包的版本和清单对不上：不装，说是哪个', r2.code !== 0 && /和依赖清单对不上 kit\/page\/node_modules\/pngjs（清单里是 [\d.]+，包里是 6\.0\.0）/.test(r2.out), r2.out.slice(-600));
  // 这台电脑的 Node 不够看页面（把清单里看页面要求的版本改成 99 来装作 Node 不够）
  const m0 = H.read(manFile);
  const m = JSON.parse(m0);
  m.components.find((c) => c.id === 'page').node = '>=99';
  H.write(manFile, JSON.stringify(m, null, 2) + '\n');
  const r3 = install('tdm-node');
  H.write(manFile, m0);
  H.ok('Node 不够看页面：照样装，说清哪个组件用不了、要多少', r3.code === 0 && /这台电脑的 Node 是 [\d.]+：看页面（\/ttls-see-page）要 Node >=99，套件照样装，看页面用不了。要用就把 Node 升到 99\.0\.0 以上/.test(r3.out), r3.out.slice(-1500));
  H.ok('够用的组件不说（这台电脑的 Node 够自带的 OpenSpec）', !/自带的 OpenSpec（\/opsx:\* 命令）要 Node/.test(r3.out), r3.out.slice(-1500));
  H.ok('装好的套件里带着清单', fs.existsSync(path.join(r3.u.kit, 'deps.json')));
}

H.done('依赖清单（K1-6）');

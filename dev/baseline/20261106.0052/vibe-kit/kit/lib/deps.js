'use strict';
/*
 * 随包依赖的清单（kit/deps.json，K1-6，Codex 改进路线第 11 节）。内网离线，看页面的执行器（kit/page）和自带的 OpenSpec（kit/openspec）
 * 带着自己的 node_modules 进安装包；以前包里只有文件，说不清是哪个包的哪一版、从哪来、要多高的 Node、和打包时是不是同一份。
 *
 *   打包（dev/pack.js）  scan() 扫两个组件的 node_modules：每个顶层包的名字、版本、要求的 Node、来源（lock 文件里的下载地址和校验值，
 *                        没有 lock 的写 npm:<名字>@<版本>）、内容哈希；组件要求的 Node 按主包（看页面是 playwright-core，OpenSpec 是
 *                        @fission-ai/openspec）的 engines 算。consistency() 核对主包写的最低版本满足组件里每个包的要求，不满足不打包。
 *   安装（install.js）   read() 读清单；check() 只核对每个包在不在、版本对不对（不算哈希，几十个 package.json，很快）；
 *                        nodeGaps() 列出这台电脑的 Node 用不了的组件，安装器照它说清哪个组件用不了、要多少。
 * 只用 Node 自带的模块；载入时不做任何事（自动更新装完自检会挨个载 lib 下的文件）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'deps.json';
const FORMAT = 1;
/**
 * 随包带 node_modules 的组件。dir 相对 kit 目录；main 是决定这个组件要多高 Node 的主包；
 * without 是 Node 不够时这个组件怎么样（安装器原样说）。node 写了就用它，不按主包算（主包写得比依赖松、又确认过时用）
 */
const COMPONENTS = [
  { id: 'page', dir: 'page', main: 'playwright-core', label: '看页面（/vk-see-page）', without: '套件照样装，看页面用不了' },
  { id: 'openspec', dir: 'openspec', main: '@fission-ai/openspec', label: '自带的 OpenSpec（/opsx:* 命令）', without: '套件照样装，照旧用你自己装的 OpenSpec' },
];

// ---------- 版本范围（package.json 的 engines.node 那种写法）----------
/** "20.19.0" → [20, 19, 0]；"20"、"20.x" 这种没写全的，没写的那一位是 null */
function parts(v) {
  const m = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const n = (s) => (s === undefined || /[xX*]/.test(s) ? null : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const full = (p) => [p[0], p[1] === null ? 0 : p[1], p[2] === null ? 0 : p[2]];
/** 没写全的版本往上数一格：20 → 21.0.0，20.19 → 20.20.0；写全了的返回 null */
const bump = (p) => (p[1] === null ? [p[0] + 1, 0, 0] : p[2] === null ? [p[0], p[1] + 1, 0] : null);
/** 一个比较式 → { lo: 下界（含）, hi: 上界（不含，null 是没有上界）} */
function bounds(op, p) {
  const lo = full(p);
  const up = bump(p);
  const next = [lo[0], lo[1], lo[2] + 1];
  if (op === '>=') return { lo, hi: null };
  if (op === '>') return { lo: up || next, hi: null };
  if (op === '<') return { lo: [0, 0, 0], hi: lo };
  if (op === '<=') return { lo: [0, 0, 0], hi: up || next };
  if (op === '^') return { lo, hi: lo[0] > 0 || p[1] === null ? [lo[0] + 1, 0, 0] : lo[1] > 0 || p[2] === null ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1] };
  if (op === '~') return { lo, hi: p[1] === null ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0] };
  return { lo, hi: up || next };
}
/** 范围 → 几段 { lo, hi }（|| 分开的每一段，段内的比较式取交集）。认不出的段当成不限 */
function spans(range) {
  const r = String(range == null ? '' : range).trim();
  if (!r || r === '*' || /^[xX]$/.test(r)) return [{ lo: [0, 0, 0], hi: null }];
  return r.split('||').map((alt) => {
    const a = alt.trim();
    if (!a || a === '*' || /^[xX]$/.test(a)) return { lo: [0, 0, 0], hi: null };
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(a);
    const list = hy ? [['>=', hy[1]], ['<=', hy[2]]] : [...a.matchAll(/(>=|<=|>|<|=|\^|~)?\s*(v?\d[\w.*-]*)/g)].map((m) => [m[1] || '', m[2]]);
    let lo = [0, 0, 0];
    let hi = null;
    for (const [op, v] of list) {
      const p = parts(v);
      if (!p) continue;
      const b = bounds(op, p);
      if (cmp(b.lo, lo) > 0) lo = b.lo;
      if (b.hi && (!hi || cmp(b.hi, hi) < 0)) hi = b.hi;
    }
    return { lo, hi };
  }).filter((s) => !s.hi || cmp(s.lo, s.hi) < 0);
}
/** 版本 v 满不满足范围 range（空范围算满足） */
function satisfies(v, range) {
  const p = parts(v);
  if (!p) return false;
  const x = full(p);
  return spans(range).some((s) => cmp(x, s.lo) >= 0 && (!s.hi || cmp(x, s.hi) < 0));
}
/** 满足范围的最低版本，"20.19.0" 这样的字符串；没有下界的返回 '' */
function minOf(range) {
  const s = spans(range);
  if (!s.length) return '';
  const lo = s.map((x) => x.lo).sort(cmp)[0];
  return lo[0] || lo[1] || lo[2] ? lo.join('.') : '';
}

// ---------- 扫描（打包时用，要算哈希）----------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => { try { let t = fs.readFileSync(f, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) { return null; } };
/** 目录下所有文件（相对路径，/ 分隔，按名字排好）。符号链接只记指向哪，不跟进去 */
function walk(dir, rel, out) {
  const es = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of es) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isSymbolicLink()) out.push({ rel: r, link: fs.readlinkSync(path.join(dir, r)) });
    else if (e.isDirectory()) walk(dir, r, out);
    else if (e.isFile()) out.push({ rel: r });
  }
  return out;
}
/** 目录下每个文件的 sha256（符号链接记指向哪）。一个文件只读一遍：包的哈希、组件的哈希都从这一份算 */
function fileDigests(dir) {
  return walk(dir, '', []).map((f) => {
    if (f.link !== undefined) return { rel: f.rel, line: 'link:' + f.link, bytes: 0 };
    const buf = fs.readFileSync(path.join(dir, f.rel));
    return { rel: f.rel, line: sha256(buf), bytes: buf.length };
  });
}
/** 内容哈希：每个文件"相对路径 + 内容的 sha256"串起来再算一次。修改时间不影响；.gitattributes 是 * -text，拿到的字节不变。prefix 给了就只算这个子目录（路径相对它） */
function combine(digests, prefix) {
  const h = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const d of digests) {
    if (prefix && !d.rel.startsWith(prefix)) continue;
    h.update(d.rel.slice(prefix ? prefix.length : 0) + '\0' + d.line + '\n');
    files++;
    bytes += d.bytes;
  }
  return { hash: 'sha256-' + h.digest('hex'), files, bytes };
}
/** node_modules 下的顶层包名（带作用域的写成 @x/y）；. 开头的（.bin、.package-lock.json）不算包 */
function topNames(nm) {
  const out = [];
  let es = [];
  try { es = fs.readdirSync(nm, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of es) {
    if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
    if (e.name.startsWith('@')) { for (const s of fs.readdirSync(path.join(nm, e.name))) if (!s.startsWith('.')) out.push(e.name + '/' + s); } else out.push(e.name);
  }
  return out.sort();
}
/** lock 文件里记的下载地址和校验值：组件目录的 package-lock.json，或者 node_modules/.package-lock.json */
function lockOf(compDir) {
  for (const f of [path.join(compDir, 'package-lock.json'), path.join(compDir, 'node_modules', '.package-lock.json')]) {
    const j = readJson(f);
    if (j && j.packages && typeof j.packages === 'object') return j.packages;
  }
  return {};
}
/**
 * 扫安装包（pkgRoot 是 vibe-kit 那一层）里每个组件的 node_modules。缺主包、包没有 package.json 的抛错（打包时就该停下）
 */
function scan(pkgRoot) {
  const kit = path.join(pkgRoot, 'kit');
  const components = [];
  for (const c of COMPONENTS) {
    const compDir = path.join(kit, c.dir);
    const nm = path.join(compDir, 'node_modules');
    if (!fs.existsSync(nm)) throw new Error('缺 kit/' + c.dir + '/node_modules');
    const lock = lockOf(compDir);
    const digests = fileDigests(nm);
    const packages = topNames(nm).map((name) => {
      const dir = path.join(nm, ...name.split('/'));
      const pj = readJson(path.join(dir, 'package.json'));
      if (!pj) throw new Error('kit/' + c.dir + '/node_modules/' + name + ' 没有 package.json');
      const l = lock['node_modules/' + name] || {};
      const nested = topNames(path.join(dir, 'node_modules')).map((n2) => {
        const p2 = readJson(path.join(dir, 'node_modules', ...n2.split('/'), 'package.json')) || {};
        return { name: n2, version: String(p2.version || ''), node: String((p2.engines && p2.engines.node) || '') };
      });
      const d = combine(digests, name + '/');
      const out = { name, version: String(pj.version || ''), node: String((pj.engines && pj.engines.node) || ''), license: String(pj.license || ''),
        source: String(l.resolved || pj._resolved || ('npm:' + name + '@' + (pj.version || ''))), integrity: String(l.integrity || pj._integrity || ''), hash: d.hash, files: d.files, bytes: d.bytes };
      if (nested.length) out.nested = nested;
      return out;
    });
    const main = packages.find((p) => p.name === c.main);
    if (!main) throw new Error('kit/' + c.dir + '/node_modules 里没有主包 ' + c.main);
    const all = combine(digests);
    components.push({ id: c.id, dir: c.dir, label: c.label, main: c.main, node: c.node || main.node, hash: all.hash, files: all.files, bytes: all.bytes, packages });
  }
  return { format: FORMAT, components };
}
/**
 * 组件写的 Node 要求和组件里每个包的要求对不对得上：按组件要求的最低版本（比如 20.19.0），每个包都得满足，
 * 不然 Node 刚好够的电脑上，安装器说能用，里面的包却要更高的版本。返回对不上的说明（空数组是对得上）
 */
function consistency(man) {
  const out = [];
  for (const c of (man && man.components) || []) {
    const min = minOf(c.node);
    if (!min) continue;
    for (const p of c.packages || []) {
      for (const x of [p].concat(p.nested || [])) {
        if (x.node && !satisfies(min, x.node)) out.push(c.label + '按 ' + c.main + ' 算要 Node ' + c.node + '，可是 ' + x.name + ' ' + x.version + ' 要 ' + x.node + '（Node ' + min + ' 不满足）');
      }
    }
  }
  return out;
}

// ---------- 安装时用（不算哈希）----------
/** 读 kit 目录里的清单；没有、读不懂、格式不认识的返回 null（安装器照以前写死的检查） */
function read(kitDir) {
  const j = readJson(path.join(kitDir, FILE));
  return j && j.format === FORMAT && Array.isArray(j.components) ? j : null;
}
/** 清单里的每个包在不在、版本对不对。返回 { missing: [相对 kit 的路径], mismatched: [说明] } */
function check(kitDir, man) {
  const missing = [];
  const mismatched = [];
  for (const c of man.components) {
    for (const p of c.packages || []) {
      const rel = c.dir + '/node_modules/' + p.name;
      const pj = readJson(path.join(kitDir, ...rel.split('/'), 'package.json'));
      if (!pj) missing.push(rel);
      else if (String(pj.version || '') !== String(p.version || '')) mismatched.push(rel + '（清单里是 ' + p.version + '，包里是 ' + (pj.version || '没写版本') + '）');
    }
  }
  return { missing, mismatched };
}
/** 这台电脑的 Node（have，默认现在跑着的）用不了的组件：[{ id, label, node, min, without }] */
function nodeGaps(man, have) {
  const v = have || process.versions.node;
  return man.components.filter((c) => c.node && !satisfies(v, c.node)).map((c) => {
    const def = COMPONENTS.find((x) => x.id === c.id) || {};
    return { id: c.id, label: c.label || def.label || c.id, node: c.node, min: minOf(c.node), without: def.without || '这个组件用不了' };
  });
}

module.exports = { FILE, FORMAT, COMPONENTS, parts, satisfies, minOf, scan, consistency, read, check, nodeGaps };

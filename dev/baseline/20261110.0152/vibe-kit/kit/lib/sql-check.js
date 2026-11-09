'use strict';
/*
 * 改了 *.sql、MyBatis 的 Mapper XML：拿查库技能存下的表结构缓存（<项目>/.vibe/db-crud.cache.json，vk-db-crud 的 metacache.py 写的）
 * 核对里面用到的表名、列名，对不上的提醒一句（K3 M10，2026-11-01）。只提醒，不拦。
 * 只用缓存：不连库、不读连接配置（口令不经过这里，硬规矩 7）。没有缓存、缓存里没有这张表的不提——缓存里只有看过的表，没看过的不等于没有。
 * 认得的写法（保守，拿不准的不提）：
 *   带别名、表名的列（o.amount、t_order.amount）；INSERT INTO t (列…)；UPDATE t SET 列 = …；
 *   只有一张表、没有子查询的 SELECT、DELETE：选出来的单个列名（表达式、函数不看）、WHERE 里拿来比较的列
 *   Mapper 里 <include refid> 引用的 <sql> 片段代进去再看；#{…}、${…} 当成值；<where>、<set>、<trim prefix> 当成 WHERE、SET
 *   表名：缓存里没有，但有一张只差一两个字母的，问一句是不是写错了
 * .sql 脚本里 CREATE TABLE、ALTER TABLE … ADD 建的表和列算有的。缓存存了超过 30 天的不用（太旧，提醒了也多半是错的）。
 * 同一个文件同样的一批问题，一个会话只说一次（<会话>-schema-hint.json）。
 */
const fs = require('fs');
const path = require('path');

const MAX_AGE = 30 * 86400000;
const KW = new Set(('select from where and or not in is null like between exists insert into values value update set delete join inner left right full outer cross on as group by order having limit offset '
  + 'union all distinct case when then else end asc desc with create table alter add column drop primary key foreign references constraint unique index default if merge using matched '
  + 'returning top fetch first next rows row only nulls last interval cast over partition any some escape true false lateral natural straight_join ignore replace duplicate for nowait skip '
  + 'locked connect start prior minus except intersect collate comment truncate temporary view sequence check modify change rename to after before each trigger begin declare procedure function').split(' '));
const CMP = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);
const CMP_KW = new Set(['like', 'in', 'is', 'between', 'not', 'regexp', 'rlike', 'ilike']);

// ---------- 表结构缓存 ----------
/** 从文件往上找最近的 .vibe/db-crud.cache.json：{ tables: Map(表名小写 → { name, cols: Set(列名小写), at }) , at: 最近一次存的时间 }，没有返回 null */
function loadCache(file) {
  let d = path.dirname(path.resolve(file));
  for (let i = 0; i < 14; i++) {
    const f = path.join(d, '.vibe', 'db-crud.cache.json');
    if (fs.existsSync(f)) return readCache(f);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}
function readCache(f) {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  const tables = new Map();
  let newest = 0;
  for (const e of Object.values((data && data.tables) || {})) {
    if (!e || !e.found || !e.table) continue;
    const at = Number(e.at || 0) * 1000;
    if (!at || Date.now() - at > MAX_AGE) continue;
    const res = e.columns || {};
    const idx = (res.columns || []).findIndex((c) => String((c && c.name) || c).toUpperCase() === 'COLUMN_NAME');
    if (idx < 0) continue;
    const cols = new Set((res.rows || []).map((r) => String((r || [])[idx] || '').toLowerCase()).filter(Boolean));
    if (!cols.size) continue;
    const key = String(e.table).toLowerCase();
    const old = tables.get(key);
    // 几个连接（开发库、测试库）里都有这张表：列合起来算，有一个库里有就算有
    if (old) { for (const c of cols) old.cols.add(c); old.at = Math.max(old.at, at); } else tables.set(key, { name: e.table, cols, at });
    newest = Math.max(newest, at);
  }
  return tables.size ? { tables, at: newest } : null;
}

// ---------- 拆词 ----------
function tokenize(s, base) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c <= ' ') { i++; continue; }
    if (c === '-' && s[i + 1] === '-') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'") { let j = i + 1; for (; j < n; j++) { if (s[j] === "'" && s[j + 1] === "'") { j++; continue; } if (s[j] === "'") break; } out.push({ t: 'str', at: base + i }); i = j + 1; continue; }
    if (c === '"' || c === '`') { const j = s.indexOf(c, i + 1); if (j < 0 || j - i > 130) { i++; continue; } const v = s.slice(i + 1, j); out.push({ t: 'id', v, lc: v.toLowerCase(), at: base + i, quoted: true }); i = j + 1; continue; }
    if (/[A-Za-z_一-龥]/.test(c)) { let j = i + 1; while (j < n && /[\w$#一-龥]/.test(s[j])) j++; const v = s.slice(i, j); const lc = v.toLowerCase(); out.push({ t: KW.has(lc) ? 'kw' : 'id', v, lc, at: base + i }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[\w.]/.test(s[j])) j++; out.push({ t: 'num', at: base + i }); i = j; continue; }
    if (c === '?') { out.push({ t: 'q', at: base + i }); i++; continue; }
    const two = s.slice(i, i + 2);
    if (['<>', '!=', '<=', '>=', '||', '::'].includes(two)) { out.push({ t: 'p', v: two, at: base + i }); i += 2; continue; }
    out.push({ t: 'p', v: c, at: base + i });
    i++;
  }
  return out;
}

// ---------- Mapper XML：换成和原文一样长的 SQL（行号对得上） ----------
/** 换成一样长的文字，原文里的换行留在原处（行号才对得上） */
const same = (rep, orig) => { let s = ''; for (let k = 0; k < orig.length; k++) s += orig[k] === '\n' ? '\n' : (k < rep.length ? rep[k] : ' '); return s; };
// <trim prefix>、<foreach open> 里只认这样的：SQL 关键字和括号（"values ("、"("、"where"），别的（变量、表达式）不代进去
const SQL_BITS = /^[A-Za-z\s(),]*$/;
function blankXml(xml) {
  const out = [];
  const n = xml.length;
  const stack = [];
  let i = 0;
  while (i < n) {
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i + 4); const end = e < 0 ? n : e + 3; out.push(same('', xml.slice(i, end))); i = end; continue; }
    if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i + 9); const end = e < 0 ? n : e; out.push(' '.repeat(9) + xml.slice(i + 9, end)); if (e >= 0) out.push('   '); i = e < 0 ? n : e + 3; continue; }
    if (xml[i] === '<' && /[A-Za-z/!?]/.test(xml[i + 1] || '')) {
      let j = i + 1; let q = '';
      for (; j < n; j++) { const ch = xml[j]; if (q) { if (ch === q) q = ''; continue; } if (ch === '"' || ch === "'") { q = ch; continue; } if (ch === '>') break; }
      const tag = xml.slice(i, j + 1);
      const closing = /^<\s*\//.test(tag);
      const selfClosing = /\/\s*>$/.test(tag) || /^<[!?]/.test(tag);
      const name = ((/^<\s*\/?\s*([\w:-]+)/.exec(tag) || [])[1] || '').toLowerCase();
      const attr = (k) => { const m = new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"', 'i').exec(tag); return m && SQL_BITS.test(m[1]) ? m[1].trim() : ''; };
      let rep = '';
      if (closing) { const top = stack.pop(); rep = top ? top.suffix : ''; }
      else if (!selfClosing) {
        let suffix = '';
        if (name === 'where') rep = 'WHERE';
        else if (name === 'set') rep = 'SET';
        else if (name === 'trim') { rep = attr('prefix'); suffix = attr('suffix'); }
        else if (name === 'foreach') { rep = attr('open'); suffix = attr('close'); }
        stack.push({ suffix: suffix ? ' ' + suffix + ' ' : '' });
        if (rep) rep = ' ' + rep + ' ';
      }
      out.push(same(rep, tag));
      i = j + 1;
      continue;
    }
    if (xml[i] === '&') { const m = /^&(lt|gt|amp|quot|apos);/.exec(xml.slice(i, i + 6)); if (m) { const ch = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[m[1]]; out.push(same(ch, m[0])); i += m[0].length; continue; } }
    if ((xml[i] === '#' || xml[i] === '$') && xml[i + 1] === '{') { const e = xml.indexOf('}', i + 2); const end = e < 0 ? n : e + 1; out.push(same('?', xml.slice(i, end))); i = end; continue; }
    out.push(xml[i]);
    i++;
  }
  return out.join('');
}
/** Mapper 里的语句：[{ id, kind, tokens }]，<include refid> 换成那个 <sql> 片段的词（最多套三层） */
function mapperStatements(xml) {
  const doc = blankXml(xml);
  const els = [];
  const re = /<(select|insert|update|delete|sql)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const start = m.index + m[0].indexOf('>') + 1;
    els.push({ kind: m[1].toLowerCase(), id: (/\bid\s*=\s*"([^"]*)"/.exec(m[2]) || [])[1] || '', start, end: start + m[3].length });
  }
  const frags = new Map(els.filter((e) => e.kind === 'sql' && e.id).map((e) => [e.id, e]));
  const tokensOf = (e, depth) => {
    const incs = [];
    const ri = /<include\b[^>]*\brefid\s*=\s*"([^"]+)"[^>]*\/?>/gi;
    let k;
    const body = xml.slice(e.start, e.end);
    while ((k = ri.exec(body))) incs.push({ at: e.start + k.index, id: k[1].replace(/^.*\./, '') });
    let toks = tokenize(doc.slice(e.start, e.end), e.start);
    for (const inc of incs.reverse()) {
      const f = frags.get(inc.id);
      if (!f || depth > 2) continue;
      const pos = toks.findIndex((t) => t.at > inc.at);
      const ins = tokensOf(f, depth + 1);
      toks = pos < 0 ? toks.concat(ins) : toks.slice(0, pos).concat(ins, toks.slice(pos));
    }
    return toks;
  };
  return els.filter((e) => e.kind !== 'sql').map((e) => ({ id: e.id, kind: e.kind, tokens: tokensOf(e, 0) }));
}
/** .sql 脚本：按分号拆成一条条 */
function scriptStatements(sql) {
  const all = tokenize(sql, 0);
  const out = [];
  let cur = [];
  for (const t of all) { if (t.t === 'p' && t.v === ';') { if (cur.length) out.push({ tokens: cur }); cur = []; } else cur.push(t); }
  if (cur.length) out.push({ tokens: cur });
  return out;
}

// ---------- 一条语句里用到的表、列 ----------
const isId = (t) => !!t && t.t === 'id';
const isKw = (t, w) => !!t && t.t === 'kw' && (!w || t.lc === w);
const isP = (t, v) => !!t && t.t === 'p' && t.v === v;
/**
 * 返回 { refs: [{ table, alias, at }], uses: [{ table: 表名小写（null = 只有一张表时的不带前缀的列）, col, at }], creates: Map(表 → Set(列)), simple }
 */
function analyze(toks) {
  const refs = [];
  const uses = [];
  const creates = new Map();     // 脚本里建的、加的列：表 → 列
  const created = new Set();     // 脚本里 CREATE TABLE 的表（列是全的）
  let subquery = false;
  let selects = 0;
  const consumed = new Set();
  const n = toks.length;
  const readTable = (i) => {
    // 返回 { next, ref }：子查询、取不出来的 ref 为 null
    if (isP(toks[i], '(')) { let d = 0; let j = i; for (; j < n; j++) { if (isP(toks[j], '(')) d++; else if (isP(toks[j], ')')) { d--; if (!d) break; } } subquery = true; let k = j + 1; if (isKw(toks[k], 'as')) k++; if (isId(toks[k])) k++; return { next: k, ref: null }; }
    if (!isId(toks[i])) return { next: i + 1, ref: null };
    let name = toks[i]; let k = i + 1;
    consumed.add(i);
    while (isP(toks[k], '.') && isId(toks[k + 1])) { consumed.add(k + 1); name = toks[k + 1]; k += 2; }
    let alias = '';
    if (isKw(toks[k], 'as') && isId(toks[k + 1])) { alias = toks[k + 1].lc; consumed.add(k + 1); k += 2; } else if (isId(toks[k]) && !isP(toks[k + 1], '.')) { alias = toks[k].lc; consumed.add(k); k += 1; }
    return { next: k, ref: { table: name.lc, alias, at: name.at } };
  };
  for (let i = 0; i < n; i++) {
    const t = toks[i];
    if (isKw(t, 'select')) selects++;
    // UPDATE 后面是表；FOR UPDATE、ON DUPLICATE KEY UPDATE 不是。INTO 前面是 INSERT、MERGE、REPLACE（INSERT IGNORE INTO 也算）
    const updateTarget = isKw(t, 'update') && !isKw(toks[i - 1], 'for') && !isKw(toks[i - 1], 'key');
    const intoTarget = isKw(t, 'into') && (isKw(toks[i - 1], 'insert') || isKw(toks[i - 1], 'merge') || isKw(toks[i - 1], 'replace') || (isKw(toks[i - 1], 'ignore') && isKw(toks[i - 2], 'insert')));
    if (isKw(t, 'from') || isKw(t, 'join') || isKw(t, 'using') || updateTarget || intoTarget) {
      let k = i + 1;
      for (;;) {
        const r = readTable(k);
        if (r.ref) refs.push(r.ref);
        k = r.next;
        // INSERT INTO t (列…)
        if (intoTarget && r.ref && isP(toks[k], '(')) {
          let d = 0;
          for (let j = k; j < n; j++) {
            if (isP(toks[j], '(')) { d++; continue; }
            if (isP(toks[j], ')')) { d--; if (!d) { k = j + 1; break; } continue; }
            if (d === 1 && isId(toks[j]) && (isP(toks[j - 1], '(') || isP(toks[j - 1], ',')) && (isP(toks[j + 1], ',') || isP(toks[j + 1], ')'))) { uses.push({ table: r.ref.table, col: toks[j].lc, at: toks[j].at }); consumed.add(j); }
          }
        }
        if (isKw(t, 'from') && isP(toks[k], ',')) { k++; continue; }
        break;
      }
      i = k - 1;
      continue;
    }
    // CREATE TABLE t (列 类型, …)：脚本自己建的表
    if (isKw(t, 'create') && isKw(toks[i + 1], 'table')) {
      let k = i + 2;
      if (isKw(toks[k], 'if')) k += 3;
      const r = readTable(k);
      if (!r.ref) continue;
      const cols = creates.get(r.ref.table) || new Set();
      creates.set(r.ref.table, cols);
      created.add(r.ref.table);
      let d = 0;
      for (let j = r.next; j < n; j++) {
        if (isP(toks[j], '(')) { d++; if (d === 1 && isId(toks[j + 1])) cols.add(toks[j + 1].lc); continue; }
        if (isP(toks[j], ')')) { d--; if (!d) break; continue; }
        if (d === 1 && isP(toks[j], ',') && isId(toks[j + 1])) cols.add(toks[j + 1].lc);
      }
      for (const x of [...refs]) if (x.at === r.ref.at) refs.splice(refs.indexOf(x), 1);
      continue;
    }
    // ALTER TABLE t ADD [COLUMN] 列 / RENAME COLUMN a TO b
    if (isKw(t, 'alter') && isKw(toks[i + 1], 'table')) {
      const r = readTable(i + 2);
      if (!r.ref) continue;
      const cols = creates.get(r.ref.table) || new Set();
      creates.set(r.ref.table, cols);
      for (let j = r.next; j < n; j++) {
        if ((isKw(toks[j], 'add') || isKw(toks[j], 'modify') || isKw(toks[j], 'change')) && (isId(toks[j + 1]) || (isKw(toks[j + 1], 'column') && isId(toks[j + 2])))) cols.add((isId(toks[j + 1]) ? toks[j + 1] : toks[j + 2]).lc);
        if (isKw(toks[j], 'to') && isId(toks[j + 1])) cols.add(toks[j + 1].lc);
      }
      return { refs: [], uses: [], creates, created, simple: false };
    }
  }
  // 带前缀的列：别名.列、表名.列
  const byAlias = new Map();
  for (const r of refs) { byAlias.set(r.table, r.table); if (r.alias) byAlias.set(r.alias, r.table); }
  for (let i = 0; i + 2 < n; i++) {
    if (consumed.has(i) || !isId(toks[i]) || !isP(toks[i + 1], '.') || !(isId(toks[i + 2]) || isKw(toks[i + 2]))) continue;
    if (isP(toks[i - 1], '.') || isP(toks[i + 3], '.') || isP(toks[i + 3], '(')) continue;
    const table = byAlias.get(toks[i].lc);
    if (!table || toks[i + 2].t !== 'id') continue;
    uses.push({ table, col: toks[i + 2].lc, at: toks[i + 2].at });
    consumed.add(i + 2);
  }
  const simple = refs.length === 1 && !subquery && selects <= 1;
  if (simple) {
    const only = refs[0].table;
    const plainCol = (j) => isId(toks[j]) && !consumed.has(j) && !isP(toks[j - 1], '.') && !isP(toks[j + 1], '.') && !isP(toks[j + 1], '(') && toks[j].lc !== refs[0].alias;
    let clause = '';
    let d = 0;
    for (let j = 0; j < n; j++) {
      const x = toks[j];
      if (isP(x, '(')) d++;
      if (isP(x, ')')) d--;
      if (x.t === 'kw' && ['select', 'from', 'where', 'set', 'group', 'order', 'having', 'limit', 'values', 'on'].includes(x.lc) && d === 0) { clause = x.lc; continue; }
      // SELECT 里的单个列名：前面是 SELECT、DISTINCT 或逗号，后面是逗号、FROM、AS 别名或者直接跟别名
      if (clause === 'select' && d === 0 && plainCol(j) && (isKw(toks[j - 1], 'select') || isKw(toks[j - 1], 'distinct') || isP(toks[j - 1], ',')) && (isP(toks[j + 1], ',') || isKw(toks[j + 1], 'from') || isKw(toks[j + 1], 'as') || (isId(toks[j + 1]) && (isP(toks[j + 2], ',') || isKw(toks[j + 2], 'from'))))) uses.push({ table: only, col: x.lc, at: x.at });
      // SET 列 = …
      if (clause === 'set' && d === 0 && plainCol(j) && (isKw(toks[j - 1], 'set') || isP(toks[j - 1], ',')) && isP(toks[j + 1], '=')) uses.push({ table: only, col: x.lc, at: x.at });
      // WHERE 里拿来比较的列
      if (clause === 'where' && plainCol(j) && (isKw(toks[j - 1], 'where') || isKw(toks[j - 1], 'and') || isKw(toks[j - 1], 'or') || isKw(toks[j - 1], 'not') || isP(toks[j - 1], '(')) && ((toks[j + 1] && toks[j + 1].t === 'p' && CMP.has(toks[j + 1].v)) || (toks[j + 1] && toks[j + 1].t === 'kw' && CMP_KW.has(toks[j + 1].lc)))) uses.push({ table: only, col: x.lc, at: x.at });
    }
  }
  return { refs, uses, creates, created, simple };
}

// ---------- 对比 ----------
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
const nearest = (name, list) => { let best = ''; let bd = 9; for (const x of list) { const d = distance(name, x); if (d < bd) { bd = d; best = x; } } return bd <= 2 && name.length >= 4 ? best : ''; };
const lineOf = (text, at) => { let n = 1; for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/**
 * 核对一个文件：返回 { issues: [{ line, text }], age: 缓存多久之前存的（毫秒） }。不是 SQL、Mapper，没有缓存，返回 null
 */
function check(file, text) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext !== '.sql' && ext !== '.xml') return null;
  const src = text != null ? String(text) : (() => { try { const st = fs.statSync(file); return st.size > 1024 * 1024 ? '' : fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } })();
  if (!src) return null;
  if (ext === '.xml' && !/<mapper\b[^>]*\bnamespace\s*=|<sqlMap\b/i.test(src)) return null;
  const cache = loadCache(file);
  if (!cache) return null;
  const stmts = ext === '.xml' ? mapperStatements(src) : scriptStatements(src);
  const results = stmts.map((s) => Object.assign({ id: s.id || '' }, analyze(s.tokens)));
  // 脚本自己建的表和列：CREATE TABLE 的（列是全的）、ALTER … ADD 的（只多了几列，别的列按缓存）
  const made = new Map();
  const whole = new Set();
  for (const r of results) {
    for (const [t, cols] of r.creates) { const set = made.get(t) || new Set(); for (const c of cols) set.add(c); made.set(t, set); }
    for (const t of r.created || []) whole.add(t);
  }
  const issues = [];
  const seen = new Set();
  const names = [...cache.tables.keys()];
  const push = (at, msg) => { const line = lineOf(src, at); const k = line + '|' + msg; if (seen.has(k)) return; seen.add(k); issues.push({ line, text: msg }); };
  for (const r of results) {
    for (const ref of r.refs) {
      if (cache.tables.has(ref.table) || made.has(ref.table)) continue;
      const near = nearest(ref.table, names.concat([...made.keys()]));
      if (near) push(ref.at, '缓存里没有表 ' + ref.table + '，有 ' + ((cache.tables.get(near) || {}).name || near) + '：是不是写错了');
    }
    for (const u of r.uses) {
      const tb = cache.tables.get(u.table);
      const own = made.get(u.table);
      if (!tb && !own) continue;
      if ((tb && tb.cols.has(u.col)) || (own && own.has(u.col))) continue;
      // 缓存里没有、脚本里也只是 ALTER 加了几列的表：别的列有没有不知道，不提
      if (!tb && !whole.has(u.table)) continue;
      const pool = [...(tb ? tb.cols : []), ...(own || [])];
      const near = nearest(u.col, pool);
      push(u.at, '表 ' + ((tb && tb.name) || u.table) + ' 没有列 ' + u.col + (near ? '（最像的是 ' + near + '）' : '') + (r.id ? '，<' + r.id + '>' : ''));
    }
  }
  return { issues, age: Date.now() - cache.at };
}

const ageText = (ms) => (ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + ' 分钟' : ms < 2 * 86400000 ? Math.round(ms / 3600000) + ' 小时' : Math.round(ms / 86400000) + ' 天');

/**
 * 给 after-tool 用：Edit、Write、MultiEdit 改成功了一个 .sql、Mapper XML，对不上的返回一段提醒；没有问题、说过了的返回 ''
 */
function hintFor(j) {
  const f = String((j && j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || '');
  if (!/\.(sql|xml)$/i.test(f)) return '';
  const abs = path.resolve(j.cwd || process.cwd(), f);
  const r = check(abs);
  if (!r || !r.issues.length) return '';
  const sig = r.issues.map((x) => x.text).sort().join('\n');
  const sid = String(j.session_id || '');
  if (sid && sid !== 'unknown') {
    const S = require('./session');
    const key = sid + '-schema-hint';
    const k = S.normKey(abs);
    const st = S.readState(key);
    if (st[k] === sig) return '';
    S.updateState(key, (o) => { o[k] = sig; const ks = Object.keys(o); if (ks.length > 50) for (const x of ks.slice(0, ks.length - 50)) delete o[x]; });
  }
  const list = r.issues.slice(0, 8).map((x) => '- 第 ' + x.line + ' 行：' + x.text);
  return '[vibe-kit 表结构] ' + path.basename(abs) + ' 里有 ' + r.issues.length + ' 处和查库技能存的表结构对不上（缓存是 ' + ageText(r.age) + '前存的，只有看过的表）：\n' + list.join('\n')
    + (r.issues.length > 8 ? '\n- 还有 ' + (r.issues.length - 8) + ' 处' : '') + '\n只是提醒，不拦。核对一下；库里刚改过结构的，用 /vk-db-crud 的 columns --table <表> --fresh 重新看一遍。';
}

module.exports = { check, hintFor, analyze, tokenize, mapperStatements, scriptStatements, blankXml, loadCache };

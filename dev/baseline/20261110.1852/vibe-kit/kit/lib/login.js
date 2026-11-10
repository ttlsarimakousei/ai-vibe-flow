'use strict';
/*
 * 测试账号表 .vibe/login.json（问题表第 75 条，用户 2026-11-09 定的：启动方式和测试账号记下来，不清）。
 *   以前账号只在对话里：换个需求、再做同一个需求的新变更，模型又问一遍；记在 .vibe/tmp/ 里的过几天被清掉。
 *   这里定格式、读、汇总（不带口令）、给场景替换 {{login.<名字>.<字段>}}、场景跑通时记"上次登录成功"、照项目文件找候选账号。
 *
 * 格式（键名也认中文和常见的别名，老的随手写的文件能读的尽量读）：
 *   { "说明": "…", "accounts": [ { "name": "admin", "user": "admin", "password": "…", "role": "超级管理员",
 *       "modules": ["系统管理", "审批"], "system": "后台 /admin", "from": "用户给的", "lastOk": "2026-11-09 15:20" } ] }
 *   name 是场景里引用的名字，不写就用 user；lastOk 由 page/scenario-run.js 写：用到它的场景整个跑通了才写。
 * 口令只给场景执行器用：汇总、找候选、钩子的提示里都不带口令。
 * 用的地方：hooks/session-start.js（会话开始带汇总）、hooks/task-anchor.js（用户给了账号，提醒记下来）、tools/devserver.js（起来之后提一句）、
 *   page/scenario-run.js（替换、记成功）、tools/login.js（命令行）、lib/tidy.js（tmp 里的账号文件拦一次）。
 */
const fs = require('fs');
const path = require('path');

const REL = path.join('.vibe', 'login.json');
const FIELDS = {
  name: ['name', '名字', '名称', '代号'],
  user: ['user', 'username', 'userName', 'account', 'loginName', 'login', '账号', '帐号', '用户名', '登录名'],
  password: ['password', 'pwd', 'pass', 'passwd', '密码', '口令'],
  role: ['role', 'roles', '角色'],
  modules: ['modules', 'module', 'menus', '模块', '菜单', '功能'],
  system: ['system', 'url', 'site', '系统', '地址'],
  from: ['from', 'source', '来源'],
  lastOk: ['lastOk', 'lastLogin', '上次成功', '上次登录成功'],
  note: ['note', 'remark', '说明', '备注'],
};
const FORMAT = '{"accounts": [{"name": "admin", "user": "admin", "password": "…", "role": "超级管理员", "modules": ["系统管理", "审批"], "from": "用户给的"}]}';
const SELF = 'node "$HOME/.claude/vibe-kit/tools/login.js"';

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } };
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
function pick(o, k) {
  for (const a of FIELDS[k]) { const hit = Object.keys(o).find((x) => x.toLowerCase() === a.toLowerCase()); if (hit !== undefined && o[hit] != null && o[hit] !== '') return { key: hit, value: o[hit] }; }
  return null;
}
const looksAccount = (o) => isObj(o) && !!(pick(o, 'user') || pick(o, 'password'));

/** 原始 JSON 里的账号条目：[{ raw: 原对象, key: 用对象表示时的键 }]。认不出返回 null */
function entriesOf(data) {
  if (Array.isArray(data)) return data.filter(isObj).map((raw) => ({ raw }));
  if (!isObj(data)) return null;
  for (const k of ['accounts', '账号', '帐号', 'users', 'logins']) if (Array.isArray(data[k])) return data[k].filter(isObj).map((raw) => ({ raw }));
  if (looksAccount(data)) return [{ raw: data }];
  const map = Object.keys(data).filter((k) => looksAccount(data[k]));
  return map.length ? map.map((k) => ({ raw: data[k], key: k })) : null;
}
function norm(e) {
  const g = (k) => { const p = pick(e.raw, k); return p ? p.value : ''; };
  const list = (v) => (Array.isArray(v) ? v.map(String) : v ? String(v).split(/[,，、;；]\s*/) : []).map((x) => x.trim()).filter(Boolean);
  const user = String(g('user') || '');
  return { name: String(g('name') || e.key || user || ''), user, password: g('password') === '' ? '' : String(g('password')), role: list(g('role')).join('、'), modules: list(g('modules')), system: String(g('system') || ''), from: String(g('from') || ''), lastOk: String(g('lastOk') || ''), note: String(g('note') || '') };
}

/** 读账号表：{ file, ok, accounts: [规整后的], data: 原始 JSON, error: 读不了、认不出时的说明 } */
function read(file) {
  const out = { file, ok: false, accounts: [], data: null, error: '' };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { out.error = '没有这个文件'; return out; }
  // 报错原文不往外带：Node 的报错会引出错处附近的原文，口令没加引号时口令就在里面（复审第 75 条-1）。只说第几行
  try { out.data = JSON.parse(text); } catch (e) {
    const m = /position (\d+)/.exec(String(e && e.message));
    const ln = m ? text.slice(0, Number(m[1])).split('\n').length : 0;
    out.error = '不是合法的 JSON（' + (ln ? '第 ' + ln + ' 行附近' : '') + '有语法错，看逗号、引号、括号）';
    return out;
  }
  const es = entriesOf(out.data);
  if (!es) { out.error = '认不出里面的账号：按这个格式写 ' + FORMAT; return out; }
  out.accounts = es.map(norm).filter((a) => a.name);
  out.ok = true;
  return out;
}

/** 从 start 往上找 .vibe/login.json（最多 levels 层；start 自己在 .vibe 里也算） */
function findFrom(start, levels) {
  let d = path.resolve(start || process.cwd());
  for (let i = 0; i < (levels || 6); i++) {
    if (path.basename(d).toLowerCase() === '.vibe' && exists(path.join(d, 'login.json'))) return path.join(d, 'login.json');
    const f = path.join(d, REL);
    if (exists(f)) return f;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}
/**
 * 账号表该放在哪个项目：往上已经有 login.json 的用它；否则往上第一个有 .vibe/project.md 的目录、git 仓库根；都没有就是 start。
 * 到仓库根就停：壳子里的子项目各记各的
 */
function homeOf(start) {
  const s = path.resolve(start || process.cwd());
  const have = findFrom(s, 4);
  if (have) return path.dirname(path.dirname(have));
  let d = s;
  for (let i = 0; i < 8; i++) {
    if (exists(path.join(d, '.vibe', 'project.md')) || fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return s;
}

const short = (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t || ''); return m ? m[2] + '-' + m[3] : String(t || '').slice(0, 16); };
/** 一个账号的说明（不带口令） */
function describe(a) {
  const bits = [a.role, a.modules.join('、'), a.system, a.lastOk ? '上次登录成功 ' + short(a.lastOk) : ''].filter(Boolean);
  return a.name + (a.user && a.user !== a.name ? '（账号 ' + a.user + (bits.length ? '；' + bits.join('；') : '') + '）' : bits.length ? '（' + bits.join('；') + '）' : '');
}
/** 给模型看的一段：有哪些账号、怎么引用。读不了的说清 */
function summary(file, opts) {
  const o = opts || {};
  const r = read(file);
  const where = o.show || file;
  if (!r.ok) return '测试账号表 ' + where + ' ' + r.error + '。先读它，按格式整理好再用。';
  if (!r.accounts.length) return '测试账号表 ' + where + ' 是空的。';
  const max = o.max || 12;
  const list = r.accounts.slice(0, max).map(describe).join('、') + (r.accounts.length > max ? ' 等 ' + r.accounts.length + ' 个' : '');
  return '测试账号（' + where + '）：' + list + '。要登录就用这里的，不要再问用户；场景里写 {{login.<名字>.user}}、{{login.<名字>.password}} 引用，不把口令抄进场景。这里没有合适的再问，问到记进这个文件。';
}
/** 几个账号的名字（壳子里列子项目时用） */
function names(file) { const r = read(file); return r.ok ? r.accounts.map((a) => a.name) : []; }

/**
 * 场景里的 {{login.<名字>.<字段>}} 换成账号表里的值。used 收集用到的账号名字。
 * 账号表没有、没这个账号、这个字段是空的：抛错（这一步算失败，说清缺什么）
 */
const REF = /\{\{\s*login\.([^.{}\s]+)\.(\w+)\s*\}\}/g;
function hasRef(v) { REF.lastIndex = 0; const r = REF.test(String(v)); REF.lastIndex = 0; return r; }
function resolve(text, table, used) {
  if (typeof text !== 'string' || !hasRef(text)) return text;
  return text.replace(REF, (all, name, field) => {
    if (!table || !table.ok) throw new Error('场景里用了 ' + all + '，但' + (table && table.file ? '测试账号表 ' + table.file + ' ' + (table.error || '读不出来') : '没找到测试账号表 .vibe/login.json') + '。账号先用 ' + SELF + ' find 找，找不到问用户，记进 .vibe/login.json（格式 ' + FORMAT + '）');
    const a = table.accounts.find((x) => x.name === name) || table.accounts.find((x) => x.user === name);
    if (!a) throw new Error('测试账号表 ' + table.file + ' 里没有叫 ' + name + ' 的账号（有：' + (table.accounts.map((x) => x.name).join('、') || '没有') + '）');
    const v = field === 'modules' ? a.modules.join('、') : a[field];
    if (v === undefined || v === '') throw new Error('测试账号表里 ' + name + ' 的 ' + field + ' 是空的');
    if (used) used.add(a.name);
    return String(v);
  });
}

const now = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
/** 这几个账号刚登录成功：在原文件里写上 lastOk（原来用的什么键名就写哪个），别的内容原样留着。返回写了几个 */
function markOk(file, list, when) {
  const want = new Set([...(list || [])].map(String));
  if (!want.size || !exists(file)) return 0;
  let lock = null;
  try { lock = require('./state-store').acquire(file + '.lock', { waitMs: 2000, leaseMs: 30000 }); } catch (e) { lock = null; }
  // 拿不到锁（别的进程在写）就不记：少记一次"上次登录成功"不要紧，覆盖了别人刚写的账号要紧
  if (!lock) return 0;
  try {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return 0; }
    const es = entriesOf(data);
    if (!es) return 0;
    let n = 0;
    const t = when || now();
    for (const e of es) {
      const a = norm(e);
      if (!want.has(a.name)) continue;
      const p = pick(e.raw, 'lastOk');
      e.raw[p ? p.key : 'lastOk'] = t;
      n++;
    }
    if (n) require('./state-store').atomicText(file, JSON.stringify(data, null, 2) + '\n');
    return n;
  } finally { if (lock) lock.release(); }
}

/** 检查账号表写得对不对：返回问题列表（空 = 没问题） */
function check(file) {
  const r = read(file);
  if (!r.ok) return [r.error];
  const out = [];
  if (!r.accounts.length) out.push('一个账号都没有');
  const seen = new Set();
  for (const a of r.accounts) {
    if (seen.has(a.name)) out.push('名字 ' + a.name + ' 重复了：场景里引用会分不清，改成不同的 name');
    seen.add(a.name);
    if (!a.user) out.push(a.name + ' 没写 user（登录用的账号）');
    if (!a.password) out.push(a.name + ' 没写 password');
    if (!a.from) out.push(a.name + ' 没写 from（谁给的、从哪查到的），以后对不上时不知道找谁');
  }
  if (!Array.isArray(r.data && r.data.accounts)) out.push('不是套件定的格式（顶层要有 accounts 数组），读得出但建议整理成：' + FORMAT);
  return out;
}

// ---------- 找候选账号（只看项目里的文件，不连库） ----------
const SKIP_DIR = /^(node_modules|\.git|target|build|dist|out|\.idea|\.vscode|\.vibe|logs?|coverage|\.gradle|bin|obj)$/i;
const USER_TABLE = /insert\s+into\s+[`"[]?(?:\w+[`"\]]?\.)?[`"[]?(\w*(?:user|account|operator|staff|employee|member|login)\w*)[`"\]]?/i;
const INIT_PWD = /^\s*([\w.-]*(?:init|default|reset|initial)[\w.-]*(?:pass|pwd|password)[\w.-]*)\s*[:=]\s*(.+)$/i;
const DOC_HINT = /(账号|帐号|用户名|登录名|密码|口令|username|password).{0,40}/i;
/** 项目里可能写着测试账号的地方：[{ file, line, kind, text }]。最多看 3000 个文件、每类最多 15 条 */
function find(root, opts) {
  const o = opts || {};
  const out = { seed: [], config: [], docs: [] };
  let n = 0;
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (++n > (o.maxFiles || 3000)) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8 && !SKIP_DIR.test(e.name)) walk(p, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      let kind = '';
      if (ext === '.sql') kind = 'seed';
      else if (/^\.(ya?ml|properties)$/.test(ext) && !/prod/i.test(e.name)) kind = 'config';
      else if (ext === '.md' && /readme|部署|安装|启动|说明|测试|账号/i.test(e.name)) kind = 'docs';
      if (!kind || out[kind].length >= 15) continue;
      let text = '';
      try { if (fs.statSync(p).size > 4 * 1024 * 1024) continue; text = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && out[kind].length < 15; i++) {
        const l = lines[i];
        let hit = '';
        if (kind === 'seed') { const m = USER_TABLE.exec(l); if (m) hit = m[1] + '：' + l.trim(); }
        else if (kind === 'config') { const m = INIT_PWD.exec(l); if (m) hit = l.trim(); }
        else if (DOC_HINT.test(l)) hit = l.trim();
        if (hit) out[kind].push({ file: path.relative(root, p).split(path.sep).join('/'), line: i + 1, text: hit.length > 200 ? hit.slice(0, 200) + '…' : hit });
      }
    }
  };
  walk(path.resolve(root), 0);
  return out;
}

/**
 * 用户这句话里给了登录账号（"账号 admin 密码 123456"、"用 admin/123456 登录"），或者说到了怎么启动：
 * 提醒模型记下来（记在哪、什么格式）。lastAsk：上一条助手回复的文字，它问过账号、用户只回了"admin/123456"也认。没有要提醒的返回 ''
 */
// "账号 admin 密码 123456"：两个词后面都要跟着英文、数字、符号写的值（"密码错误""password 校验""accounting"不算，复审第 75 条-2）
const ACC_WORD = /(?:账号|帐号|账户|用户名|登录名|(?<![a-z])(?:username|user\s*name|account)(?![a-z]))\s*(?:是|为|用|[:：=])?\s*[\w.@-]{2,}/i;
const PWD_WORD = /(?:密码|口令|(?<![a-z])(?:password|passwd|pwd)(?![a-z]))\s*(?:是|为|用|[:：=])?\s*[\x21-\x7e]{2,}/i;
// "admin/123456" 这种：紧挨着"登录"（用 admin/123456 登录）、跟在"账号""密码""登录"后面（用户名/密码是 admin/123456），
// 或者整句就是这一对、上一条回复问过账号。路径不算：前后还连着斜杠的、两头是 src、views、login 这类目录名的；"登录页""登录接口"里的登录不算
const PAIR_G = /(?<![\w/／.\\-])([A-Za-z][\w.@-]{1,40})\s*[/／]\s*([^\s/／，,。；;)）]{3,40})(?![/／\w])/g;
const DIR1 = /^(?:src|views?|pages?|components?|api|static|assets|public|webapp|resources|lib|dist|test|main)$/i;
const DIR2 = /^(?:login|logout|index|main|src|home|pages?|views?|api|list|detail|edit|users?|system|common|utils?|components?|static|assets|public|router|store|config|test|dist|lib|webapp|resources)$/i;
const LOGIN_NOUN = '(?!页|界面|按钮|框|接口|功能|模块|逻辑|流程|状态|态|校验|拦截|日志|跳转|超时)';
const LOGIN_AFTER = new RegExp('^\\s*[，,]?\\s*(?:登录|登陆|login)' + LOGIN_NOUN, 'i');
const LOGIN_BEFORE = new RegExp('(?:账号|帐号|账户|用户名|密码|(?:登录|登陆)' + LOGIN_NOUN + ')[^\\n/／]{0,8}$');
const START_WORD = /(启动方式|启动命令|启动步骤|启动顺序|启动脚本|这样启动|这么启动|先启动|再启动|起服务的?方式)/;
const ASKING = /[？?]\s*$|(?:吗|么|呢)[\s。.!！~～]*$/;
function gavePair(p, lastAsk) {
  for (const m of p.matchAll(PAIR_G)) {
    if (DIR1.test(m[1]) || DIR2.test(m[2])) continue;
    if (LOGIN_AFTER.test(p.slice(m.index + m[0].length)) || LOGIN_BEFORE.test(p.slice(Math.max(0, m.index - 12), m.index))) return true;
    // 整句就是这一对（前面可以有"用""是"）：上一条回复问过账号才算。lastAsk 可以是函数，到这一步才去读
    if (/^\s*(?:用|是)?\s*$/.test(p.slice(0, m.index)) && /^\s*[。.!！]?\s*$/.test(p.slice(m.index + m[0].length))) {
      if (/账号|帐号|账户|密码|口令|登录|登陆/.test(String((typeof lastAsk === 'function' ? lastAsk() : lastAsk) || ''))) return true;
    }
  }
  return false;
}
function promptHint(prompt, cwd, lastAsk) {
  const p = String(prompt || '');
  if (!p.trim() || /^\s*\//.test(p)) return '';
  const out = [];
  const gave = (ACC_WORD.test(p) && PWD_WORD.test(p)) || gavePair(p, lastAsk);
  if (gave) {
    const home = homeOf(cwd);
    let shell = false;
    try { shell = require('./session').isShell(home); } catch (e) { shell = false; }
    const file = shell ? '要登录的那个子项目的 .vibe/login.json' : path.join(home, REL);
    out.push('[vibe-kit 账号] 用户这句话里给了登录账号：先记进 ' + file + '（格式 ' + FORMAT + '；已有同一个账号就更新那一条，from 写"用户给的"），下次不用再问。场景里写 {{login.<名字>.user}}、{{login.<名字>.password}} 引用，不把口令抄进场景。');
  }
  // 问"怎么启动""启动方式是什么？"不算说了怎么启动（复审第 75 条-4）
  if (START_WORD.test(p) && !ASKING.test(p.trim())) out.push('[vibe-kit 启动] 说到了怎么启动：起服务用 devserver，跑通后它自己把那条命令记进项目说明（.vibe/project.md 的"跑通的启动"行），下次照着起；devserver 记不下的（先起哪个依赖、要手工做的步骤、配置要改哪）写进项目说明的"启动"那一行。');
  return out.join('\n');
}

module.exports = { REL, FORMAT, read, findFrom, homeOf, summary, names, describe, resolve, hasRef, markOk, check, find, promptHint };

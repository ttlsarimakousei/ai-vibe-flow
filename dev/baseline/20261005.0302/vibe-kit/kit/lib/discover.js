'use strict';
/*
 * 从项目的配置文件里找出数据库连接和 redis 连接。只读文件，不连库，不起进程。
 *
 * 给两处用：
 *   后台自动探索（lib/onboard.js）：只要开发环境的，写进 <项目>/.vibe/db-crud.ini 和 <项目>/.vibe/redis.json
 *   配置页：看一个项目里扫到了什么
 *
 * 数据库那一半最早是 db-crud 的 scripts/discover.py 照着移过来的，后来按结构重写了：
 *   YAML、properties 先拆成"键 → 值"，值整个取（口令里有 #、逗号、分号都不截断），再看值是不是连接串；
 *   账号、口令只在连接串所在的那一块里找（同一个父键、同一个前缀、同一个 bean），不到隔壁的 redis、消息队列那里去拿。
 *
 * 环境怎么定：
 *   dev      开发、本机
 *   test     测试、预发
 *   prod     生产
 *   base     没分环境的公共配置（application.yml、jdbc.properties）
 *   other    按功能分的文件（application-druid.yml），当公共配置看
 *   unknown  像是分了环境、又认不出是哪个（application-hz.yml、deploy/ 目录里的配置）
 * 依据：文件名、所在目录、YAML 和 properties 里分的文档（spring.profiles、on-profile）、数据源的名字、地址和库名里的字样，
 *   还有这个目录的 application.yml 默认激活的是哪个环境。
 * "算开发环境的" = dev，或者 base / other 而且默认激活的不是测试、生产环境；地址和库名里没有测试、生产的字样；
 *   同一个地址没有在别处被认成测试、生产环境。
 * 拿不准的不算开发环境：宁可少找一个，不能把生产库配进来。每一条不算的都带着原因（why）。
 */
const fs = require('fs');
const path = require('path');

const NAMED = [
  /^application.*\.(ya?ml|properties)$/i,
  /^bootstrap.*\.(ya?ml|properties)$/i,
  /^(jdbc|db|database|datasource|druid|config|jeecg|ruoyi|redis|cache)\.properties$/i,
];
const XML = /\.xml$/i;
// 这些 XML 里不会有连接，量又大（一个 dao 模块几百个 mapper）：不读。pom.xml 也不读：里面的连接串写在 <profiles> 里，分不清是哪个环境的
const XML_SKIP_NAME = /(mapper|dao|sqlmap)\.xml$|^(pom|logback|log4j2?|ehcache|checkstyle|assembly|generatorconfig|mybatis-generator)([-_.][\w-]*)?\.xml$|\.(jrxml|bpmn20?)\.xml$/i;
const XML_SKIP_DIR = new Set(['mapper', 'mappers', 'mybatis', 'sqlmap', 'sqlmaps', 'ureportfiles', 'processes', 'bpmn', 'jasper']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.idea', '.vscode', '__pycache__', '.vibe', '.claude', 'logs', 'log', 'openspec']);
const MAX_DEPTH = 6;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MAX_XML = 600;
// 名字像是放连接的 XML 排在前面：数量多的时候先读这些
const XML_LIKELY = /context|datasource|data-source|jdbc|druid|proxool|c3p0|dbcp|hibernate|persistence|spring|redis|jedis|cache|server|config|db/i;
const MAX_ENTRIES = 40000;

const USER_KEYS = ['username', 'user', 'user-name', 'user_name'];
const PASS_KEYS = ['password', 'passwd', 'pwd', 'pass'];
const KV_RE = /([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s#,;]+)/g;
const XML_PROP_ALL = /name\s*=\s*["']([\w.-]+)["']\s+value\s*=\s*["']([^"']*)["']/gi;
const JDBC_HEAD = /^jdbc:[a-z0-9]+:/i;
const JDBC_IN_XML = /jdbc:[a-z0-9]+:[^"'<>\s]+/gi;

const DIALECTS = {
  dm: { name: '达梦', prefix: 'jdbc:dm:' },
  oscar: { name: '神通', prefix: 'jdbc:oscar:' },
  mysql: { name: 'MySQL', prefix: 'jdbc:mysql:' },
  oracle: { name: 'Oracle', prefix: 'jdbc:oracle:' },
  kingbase: { name: '人大金仓', prefix: 'jdbc:kingbase' },
};
function dialectOf(url) {
  const low = String(url || '').toLowerCase();
  for (const k of Object.keys(DIALECTS)) if (low.startsWith(DIALECTS[k].prefix)) return k;
  if (low.startsWith('jdbc:postgresql')) return 'kingbase';   // 金仓常被当成 PG 配，SQL 的写法按金仓走；驱动另算（见 driverKeyOf）
  return '';
}
/** 这个连接串要哪种驱动。和方言只差一处：jdbc:postgresql 的连接要 PostgreSQL 的驱动，金仓的驱动不认这个前缀 */
function driverKeyOf(url) {
  return /^jdbc:postgresql/i.test(String(url || '')) ? 'postgresql' : dialectOf(url);
}
/** 给人看、给模型看的连接串：串里带的账号口令遮掉（//用户:口令@、Oracle 的 用户/口令@、password=） */
function maskUrl(u) {
  return String(u || '')
    .replace(/(\/\/[^:/\s@]+:)[^@\s/]+@/, '$1***@')
    .replace(/(jdbc:oracle:[a-z]+:[^/@\s]+\/)[^@\s]+@/i, '$1***@')
    .replace(/([?&;](?:password|passwd|pwd)=)[^&;]*/gi, '$1***');
}

// ---------- 环境 ----------
const ENV_WORDS = {
  dev: ['dev', 'develop', 'development', 'local', 'localhost', '开发', '本地'],
  test: ['test', 'testing', 'uat', 'sit', 'qa', 'pre', 'preprod', 'prepub', 'staging', 'stage', 'gray', '测试', '预发', '灰度'],
  // product 不算：叫 product 的多半是"商品"库，不是生产环境
  prod: ['prod', 'production', 'prd', 'online', 'release', 'live', '生产', '线上', '正式'],
};
// 地址、库名里只认不会和业务词撞上的那几个：库叫 pre_order、live_room、release_note 的很多
const URL_WORDS = {
  test: ['test', 'testing', 'uat', 'sit', 'staging', '测试', '预发'],
  prod: ['prod', 'production', 'prd', 'online', '生产', '线上', '正式'],
};
// application-<这些>.yml 是按功能分的，不是按环境分的
const FUNC_WORDS = new Set(['druid', 'datasource', 'datasources', 'db', 'jdbc', 'database', 'mybatis', 'mybatisplus', 'jpa', 'hikari', 'dynamic', 'redis', 'cache', 'common', 'base', 'core', 'config',
  'quartz', 'shiro', 'security', 'swagger', 'knife4j', 'generator', 'gen', 'flowable', 'activiti', 'mq', 'rabbitmq', 'kafka', 'rocketmq', 'es', 'elasticsearch', 'mongo', 'mongodb', 'oss', 'minio', 'sms', 'mail',
  'log', 'logging', 'logback', 'web', 'api', 'actuator', 'monitor', 'job', 'xxl', 'nacos', 'sentinel', 'seata', 'dubbo', 'feign', 'gateway', 'auth', 'oauth', 'oauth2', 'jwt', 'satoken', 'file', 'upload',
  'ldap', 'sso', 'cas', 'captcha', 'i18n', 'thread', 'task', 'schedule', 'system', 'sys', 'biz', 'business', 'app', 'server', 'service', 'default', 'mysql', 'oracle', 'dm', 'kingbase', 'oscar', 'pg', 'postgresql']);
// 放部署用的东西的目录：里面的配置多半是上线用的样板，拿不准是哪个环境
const DEPLOY_DIR = /^(deploy|deployment|deployments|docker|docker-compose|k8s|kubernetes|helm|charts?|ops|devops|release|releases|publish|backup|bak|运维|部署|发布|上线|现场|备份)$/i;
const RANK = { prod: 5, test: 4, unknown: 3, dev: 1, other: 0, base: 0, '': 0 };

/** 一个词是哪个环境；都不是返回 '' */
function envOfWord(w) {
  const s = String(w || '').toLowerCase();
  if (!s) return '';
  for (const env of ['prod', 'test', 'dev']) if (ENV_WORDS[env].includes(s)) return env;
  return '';
}
function wordsIn(text, table) {
  // prodDataSource 这种驼峰写法先拆开
  const s = String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const parts = s.split(/[^a-z0-9一-龥]+/).filter(Boolean);
  for (const env of ['prod', 'test', 'dev']) {
    for (const w of table[env] || []) {
      if (/[一-龥]/.test(w)) { if (s.includes(w)) return env; continue; }
      if (parts.includes(w)) return env;
    }
  }
  return '';
}
/** 一串文字（文件名、目录、连接名）里带不带某个环境的字样。按词边界看：product 里的 prod 不算，-prod、_prod、prod. 才算 */
function envInText(text) { return wordsIn(text, ENV_WORDS); }
/**
 * 按文件名和所在目录定环境。
 *   application-dev.yml → dev；application-druid.yml → other；application-hz.yml → unknown；application.yml → base
 *   config/prod/db.properties、resources/config-prod/、doc/生产环境/ → prod；deploy/、docker/ 下面的 → unknown
 * 目录只看 src 后面的那几段（前面是模块的名字，online-exam-admin 这种不算环境）；路径里没有 src 的每一段都看
 */
function envOfFile(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  const parts = p.split('/');
  const base = parts.pop() || '';
  const at = parts.map((d) => d.toLowerCase()).lastIndexOf('src');
  let dirEnv = '';
  for (const d of at >= 0 ? parts.slice(at + 1) : parts) { const e = envInText(d); if (RANK[e] > RANK[dirEnv]) dirEnv = e; }
  let env;
  const m = /^(?:application|bootstrap)[-_.]([A-Za-z0-9_.-]+)\.(?:ya?ml|properties)$/i.exec(base);
  if (m) {
    // application-dev-mysql.yml 这种：每一段都看，有一段是生产就算生产
    const segs = m[1].split(/[-_.]/).filter(Boolean);
    const es = segs.map(envOfWord);
    if (es.includes('prod')) env = 'prod';
    else if (es.includes('test')) env = 'test';
    else if (es.includes('dev')) env = 'dev';
    else env = segs.every((s) => FUNC_WORDS.has(s.toLowerCase())) ? 'other' : 'unknown';
  } else env = envInText(base.replace(/\.[^.]+$/, '')) || 'base';
  // 目录和文件名说的不一样：取更不像开发环境的那个
  if (RANK[dirEnv] > RANK[env]) env = dirEnv;
  if (parts.some((d) => DEPLOY_DIR.test(d)) && RANK[env] < RANK.unknown) env = 'unknown';
  return env;
}
/** spring.profiles / on-profile 的值是哪个环境：prod、prod-bj、[prod]、"dev,mysql" 都认 */
function envOfProfiles(val) {
  const names = String(val || '').replace(/[[\]"']/g, ' ').split(/[,\s|&!()]+/).filter(Boolean);
  if (!names.length) return '';
  let env = '';
  let known = true;
  for (const n of names) {
    const e = envInText(n);
    if (e) { if (RANK[e] > RANK[env]) env = e; } else if (!n.split(/[-_.]/).every((s) => FUNC_WORDS.has(s.toLowerCase()))) known = false;
  }
  if (env === 'prod' || env === 'test') return env;
  if (!known) return 'unknown';
  return env || 'other';
}
/**
 * YAML 按 --- 分成几份文档，每份可以写自己属于哪个环境（spring.profiles: prod，或者 spring.config.activate.on-profile: prod）。
 * 返回每一行属于哪个环境（'' 表示这份文档没写）
 */
function yamlDocEnvs(lines) {
  const out = new Array(lines.length).fill('');
  const ents = yamlEntries(lines);
  const byDoc = new Map();
  for (const e of ents) {
    if (!e || !e.val) continue;
    if (/^(spring\.profiles|spring\.config\.activate\.on-profile)$/.test(e.full)) byDoc.set(e.doc, envOfProfiles(e.val));
  }
  let doc = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^---\s*(#.*)?$/.test(lines[i])) { doc++; continue; }
    out[i] = byDoc.get(doc) || '';
  }
  return out;
}
/** properties 从 Spring Boot 2.4 起也能分文档：#--- 或者 !--- 单独一行。要在去掉注释之前看 */
function propsDocEnvs(rawLines) {
  const out = new Array(rawLines.length).fill('');
  let start = 0;
  const flush = (end) => {
    let env = '';
    for (let i = start; i < end; i++) {
      const m = /^\s*(spring\.profiles|spring\.config\.activate\.on-profile)\s*[=:]\s*(.+?)\s*$/.exec(rawLines[i]);
      if (m) env = envOfProfiles(m[2]);
    }
    for (let i = start; i < end; i++) out[i] = env;
  };
  for (let i = 0; i < rawLines.length; i++) if (/^[#!]---\s*$/.test(rawLines[i])) { flush(i); start = i + 1; }
  flush(rawLines.length);
  return out;
}
/** 这个项目现在用的是哪个环境（application.yml 里的 spring.profiles.active）。没写返回 '' */
function activeProfile(text) {
  const m = /^\s*spring\.profiles\.active\s*[=:]\s*(\S+)/m.exec(text) || /profiles:\s*\n\s+active:\s*([^\s#]+)/.exec(text);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}
/**
 * 这个目录的公共配置默认激活的是哪个环境：{ names: [环境名…], bad: 测试或生产的那个名字（没有是 ''） }。
 * 写的是占位符（@profiles.active@、${env}）的算没写：打包时才定，仓库里看不出来。
 * 配置放在 resources/config/ 里、激活写在上一层的 application.yml 里的也认
 */
function activeOf(dir) {
  const out = { names: [], bad: '' };
  for (const d of [dir, path.dirname(dir)]) {
    let got = false;
    for (const n of ['application.yml', 'application.yaml', 'application.properties', 'bootstrap.yml', 'bootstrap.yaml', 'bootstrap.properties']) {
      const f = path.join(d, n);
      let text;
      try { if (fs.statSync(f).size > MAX_FILE_BYTES) continue; text = readText(f).replace(/\r\n/g, '\n'); } catch (e) { continue; }
      got = true;
      const a = activeProfile(stripComments(text, path.extname(f)));
      if (!a || /[$@{]/.test(a)) continue;
      for (const x of a.split(',').map((s) => s.trim()).filter(Boolean)) if (!out.names.includes(x)) out.names.push(x);
    }
    if (got) break;
  }
  const envs = out.names.map((n) => envInText(n));
  if (!envs.includes('dev')) { const i = envs.findIndex((e) => e === 'prod' || e === 'test'); if (i >= 0) out.bad = out.names[i]; }
  return out;
}
/** 这个环境的配置为什么不算开发环境的。算的返回 '' */
function whyNotDev(env, active) {
  if (env === 'dev') return '';
  if (env === 'prod') return '是生产环境的配置';
  if (env === 'test') return '是测试环境的配置';
  if (env === 'unknown') return '看不出是哪个环境的配置';
  if (active && active.bad) return '是公共配置，但这个项目默认激活的是 ' + active.bad + ' 环境';
  return '';
}
/** 文件名说的环境和文档里自己写的环境合起来：文件是测试、生产的，取更不像开发环境的那个；不然文档自己写的更准 */
function mergeEnv(fileEnv, docEnv) {
  if (!docEnv) return fileEnv;
  if (fileEnv === 'prod' || fileEnv === 'test') return RANK[docEnv] > RANK[fileEnv] ? docEnv : fileEnv;
  return docEnv;
}
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i;
/** 连接串里的主机（只取第一个）。取不出返回 '' */
function hostOfUrl(url) {
  const s = String(url || '');
  const m = /\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?;,\s]+)/.exec(s) || /@(?:\/\/)?(\[[^\]]+\]|[^:/?;,\s(]+)/.exec(s) || /HOST\s*=\s*([^)\s]+)/i.exec(s);
  return m ? m[1] : '';
}
/** 地址、库名里有没有测试、生产的字样。连的是本机的不看 */
function whyNotDevByAddr(host, text) {
  if (host && LOCAL_HOST.test(host)) return '';
  const e = wordsIn(text, URL_WORDS);
  return e === 'prod' ? '地址或库名里有生产的字样' : e === 'test' ? '地址或库名里有测试的字样' : '';
}

// ---------- 读文件 ----------
function readText(file) {
  const buf = fs.readFileSync(file);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* 不是 UTF-8 */ }
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { return buf.toString('latin1'); }
}
/** YAML 一行后面的注释（空白加 #）去掉。引号里的 # 不算 */
function stripYamlTail(line) {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ''; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:[,{]/.test(line[i - 1]))) { q = c; continue; }
    if (c === '#' && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line;
}
/**
 * 注释里的内容抹掉，行号和行数不变。老项目的配置里常年躺着注释掉的旧地址，照单全收会配出一堆假连接。
 * YAML 行尾的注释也去掉：那里面写着的"生产用 jdbc:…"不是配置。properties 只有整行的注释，值里面的 # 是值的一部分
 */
function stripComments(text, ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.xml') {
    const out = text.split('');
    let i = 0;
    for (;;) {
      const a = text.indexOf('<!--', i);
      if (a < 0) break;
      let b = text.indexOf('-->', a + 4);
      b = b < 0 ? text.length : b + 3;
      for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
      i = b;
    }
    return out.join('');
  }
  const yaml = /^\.ya?ml$/.test(e);
  return text.split('\n').map((line) => {
    const s = line.replace(/^\s+/, '');
    if (s.startsWith('#') || (e === '.properties' && s.startsWith('!'))) return ' '.repeat(line.length);
    return yaml ? stripYamlTail(line) : line;
  }).join('\n');
}
/** 要看的文件：先是按名字认的配置文件（application*、jdbc.properties…），再是 XML。mapper 这类 XML 不算 */
function candidateFiles(root) {
  const named = [];
  const xml = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth >= MAX_DEPTH || seen > MAX_ENTRIES) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const noXml = XML_SKIP_DIR.has(path.basename(dir).toLowerCase());
    for (const e of ents) {
      if (++seen > MAX_ENTRIES) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); continue; }
      if (!e.isFile()) continue;
      if (NAMED.some((p) => p.test(e.name))) { if (named.length < MAX_FILES) named.push(path.join(dir, e.name)); } else if (XML.test(e.name) && !noXml && !XML_SKIP_NAME.test(e.name)) xml.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  const likely = xml.filter((f) => XML_LIKELY.test(path.basename(f)));
  const rest = xml.filter((f) => !XML_LIKELY.test(path.basename(f)));
  return named.concat(likely.concat(rest).slice(0, MAX_XML));
}

// ---------- 占位符 ----------
/** ${NAME:默认值} 按默认值展开。返回 { text, unresolved }：还留着没有默认值的占位符就是没展开 */
function expand(value) {
  let s = String(value == null ? '' : value);
  for (let i = 0; i < 5 && /\$\{[^{}]*\}/.test(s); i++) {
    const next = s.replace(/\$\{([^{}:]+):([^{}]*)\}/g, (x, n, d) => d);
    if (next === s) break;
    s = next;
  }
  return { text: s, unresolved: /\$\{|@[A-Za-z0-9_.-]+@/.test(s) };
}
const isEncrypted = (v) => /^ENC\(.*\)$/i.test(String(v || '').trim()) || /^\{cipher\}/i.test(String(v || '').trim());

// ---------- 把文件拆成"键 → 值" ----------
const unquote = (v) => { const q = /^(["'])(.*)\1$/.exec(String(v || '').trim()); return q ? q[2] : String(v || '').trim(); };
/**
 * YAML（注释已经去掉的）：每一行一项 { i, doc, key, val, full }，不是"键: 值"的行是 null。
 * full 是从最外层到自己的整条路径，用点连起来、小写（spring.datasource.dynamic.datasource.master.url）。
 * 写成一行的键（spring.datasource.url: …）和一层层缩进的写法，full 是一样的
 */
function yamlEntries(lines) {
  const out = new Array(lines.length).fill(null);
  let stack = [];
  let doc = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^---\s*(#.*)?$/.test(l)) { stack = []; doc++; continue; }
    const m = /^(\s*(?:-\s+)?)([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/.exec(l);
    if (!m) continue;
    const ind = m[1].length;
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
    const key = unquote(m[2]);
    stack.push({ ind, key });
    out[i] = { i, doc, key, val: unquote(m[3] || ''), full: stack.map((x) => x.key).join('.').toLowerCase() };
  }
  return out;
}
/** properties：每一行一项 { i, doc, key, val, full }。值取到行尾；\: \= 这种转义还原 */
function propsEntries(rawLines) {
  const out = new Array(rawLines.length).fill(null);
  let doc = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i];
    if (/^[#!]---\s*$/.test(l)) { doc++; continue; }
    if (/^\s*[#!]/.test(l)) continue;
    const m = /^\s*([^\s=:#!][^\s=:]*)\s*[=:]\s*(.*?)\s*$/.exec(l);
    if (!m) continue;
    out[i] = { i, doc, key: m[1], val: m[2].replace(/\\([:=#!\\ ])/g, '$1'), full: m[1].toLowerCase() };
  }
  return out;
}
/** 一条路径去掉最后一段：spring.datasource.url → spring.datasource；jdbc_url → jdbc；url → '' */
function prefixOf(full) {
  const s = String(full || '');
  const d = s.lastIndexOf('.');
  if (d >= 0) return s.slice(0, d);
  const u = s.lastIndexOf('_');
  return u > 0 ? s.slice(0, u) : '';
}
/** 这一项的键是不是要找的（账号、口令），是就返回它所在的那一块（前缀） */
function blockOf(e, keys) {
  const s = e.full;
  const d = s.lastIndexOf('.');
  const last = d >= 0 ? s.slice(d + 1) : s;
  if (keys.includes(last)) return d >= 0 ? s.slice(0, d) : '';
  if (d < 0) { const u = s.lastIndexOf('_'); if (u > 0 && keys.includes(s.slice(u + 1))) return s.slice(0, u); }
  return null;
}
/**
 * 在连接串所在的那一块里找账号、口令：先找同一块的（同一个父键、同一个前缀），再往上一层
 * （账号写在 spring.datasource 下面、连接串在 spring.datasource.druid 里）。别的块里的不拿：
 * 连接串下面紧跟着 redis 的口令，拿来当库的口令就配错了
 */
function inBlock(ents, me, keys) {
  const mine = prefixOf(me.full);
  let best = null;
  for (const e of ents) {
    if (!e || e.doc !== me.doc || !e.val || e === me) continue;
    const b = blockOf(e, keys);
    if (b === null || b !== mine) continue;
    if (!best || Math.abs(e.i - me.i) < Math.abs(best.i - me.i)) best = e;
  }
  if (best) return best.val;
  if (!mine) return '';
  const up = prefixOf(mine);
  for (const e of ents) { if (!e || e.doc !== me.doc || !e.val) continue; if (blockOf(e, keys) === up) return e.val; }
  return '';
}

// ---------- XML ----------
const unescapeXml = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const keyHit = (key, keys) => { const k = String(key).toLowerCase(); return keys.includes(k) || keys.includes(k.split('.').pop()); };
/** XML 的一行里有没有要找的键：name="…" value="…"，或者属性写法 username="root" */
function pickXml(line, keys) {
  XML_PROP_ALL.lastIndex = 0;
  let m;
  while ((m = XML_PROP_ALL.exec(line))) if (keyHit(m[1], keys) && m[2] && !JDBC_HEAD.test(m[2])) return unescapeXml(m[2].trim());
  KV_RE.lastIndex = 0;
  while ((m = KV_RE.exec(line))) if (keyHit(m[1], keys)) { const val = m[2].trim().replace(/^["']|["']$/g, ''); if (val && !JDBC_HEAD.test(val)) return unescapeXml(val); }
  return '';
}
/** 连接串所在的那个 bean（或者 Resource、dataSource 元素）是第几行到第几行，叫什么 */
function xmlBlock(lines, idx) {
  let from = idx;
  let name = '';
  let tag = '';
  for (let j = idx; j >= Math.max(0, idx - 40); j--) {
    const m = /<(bean|Resource|dataSource|data-source|property-group)\b([^>]*)/i.exec(lines[j]);
    if (j < idx && /<\/bean>/i.test(lines[j])) break;
    if (m) { from = j; tag = m[1].toLowerCase(); name = (/\b(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(m[2]) || [])[1] || ''; break; }
  }
  // bean 到 </bean> 为止（里面一行一个 <property … />）；Resource 这种属性分几行写的，到它自己的 /> 为止
  const inner = tag === 'bean' || tag === 'property-group' || tag === '';
  let to = idx;
  for (let j = idx; j < Math.min(lines.length, idx + 40); j++) {
    if (j > idx && /<bean\b/i.test(lines[j])) break;
    to = j;
    if (inner ? /<\/(bean|property-group|beans)>/i.test(lines[j]) : /\/>|<\/[A-Za-z-]+>/.test(lines[j])) break;
  }
  return { from, to, name };
}

// ---------- 数据库 ----------
const GENERIC_OWNER = /^(datasource|datasources|druid|hikari|dynamic|spring|primary|jdbc|db|database|data|source|default|config|url)$/i;
/** 连接串里的库名（给连接起名字用）。连接串里没写库名返回 '' */
function nameHint(url) {
  let m = /jdbc:[^\s"']*?\/([A-Za-z0-9_-]+)(\?|;|$|[\s"'])/.exec(url);
  if (m) return m[1];
  m = /jdbc:oracle:thin:@[^\s"']*[:/]([A-Za-z0-9_-]+)/.exec(url);
  if (m) return m[1];
  return '';
}
/** 多数据源里的名字：所在的那一块，从里往外第一个不是通用词的（spring.datasource.dynamic.datasource.master → master） */
function ownerName(block) {
  const segs = String(block || '').split(/[.]/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) if (!GENERIC_OWNER.test(segs[i])) return i >= 1 || segs.length === 1 ? segs[i] : '';
  return '';
}

/**
 * 扫一个项目，返回找到的数据库连接（已去重）：
 * [{ url, user, password, encrypted, source（相对路径）, file（绝对路径）, line, nameHint, dialect, driver, env, unresolved, devOnly, why }]
 * devOnly 为真表示"算开发环境的"；不算的 why 里写着原因
 */
function scanDb(root, opts) {
  const o = opts || {};
  const all = [];
  const files = candidateFiles(root).slice(0, (o.maxFiles || MAX_FILES) + MAX_XML);
  const used = [];
  const actives = new Map();
  const activeAt = (dir) => { if (!actives.has(dir)) actives.set(dir, activeOf(dir)); return actives.get(dir); };
  for (const file of files) {
    let text;
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; text = readText(file); } catch (e) { continue; }
    if (!/jdbc\\?:/i.test(text)) continue;
    const ext = path.extname(file).toLowerCase();
    const raw = text.replace(/\r\n/g, '\n');
    const rel = path.relative(root, file).split(path.sep).join('/');
    const fileEnv = envOfFile(rel);
    const hits = [];        // { line, url, user, pw, block, docEnv }
    if (/^\.ya?ml$/.test(ext) || ext === '.properties') {
      const yaml = ext !== '.properties';
      const lines = yaml ? stripComments(raw, ext).split('\n') : raw.split('\n');
      const ents = yaml ? yamlEntries(lines) : propsEntries(lines);
      const docEnvs = yaml ? yamlDocEnvs(lines) : propsDocEnvs(lines);
      for (const e of ents) {
        if (!e || !e.val) continue;
        const u = expand(e.val);
        if (!JDBC_HEAD.test(u.text)) continue;
        hits.push({ line: e.i + 1, url: u, user: inBlock(ents, e, USER_KEYS), pw: inBlock(ents, e, PASS_KEYS), block: prefixOf(e.full), docEnv: docEnvs[e.i] || '' });
      }
    } else {
      const lines = stripComments(raw, '.xml').split('\n');
      for (let i = 0; i < lines.length; i++) {
        JDBC_IN_XML.lastIndex = 0;
        let m;
        while ((m = JDBC_IN_XML.exec(lines[i]))) {
          const b = xmlBlock(lines, i);
          const find = (keys) => { for (let d = 0; d <= 40; d++) for (const j of d ? [i + d, i - d] : [i]) if (j >= b.from && j <= b.to) { const v = pickXml(lines[j], keys); if (v) return v; } return ''; };
          hits.push({ line: i + 1, url: expand(unescapeXml(m[0])), user: find(USER_KEYS), pw: find(PASS_KEYS), block: b.name, docEnv: '' });
        }
      }
    }
    if (!hits.length) continue;
    used.push(file);
    const active = activeAt(path.dirname(file));
    for (const h of hits) {
      const user = expand(h.user);
      const pwx = expand(h.pw);
      let env = mergeEnv(fileEnv, h.docEnv);
      // 数据源的名字里带环境字样的，以它为准（多数据源里的 prod 库）
      const byName = envInText(h.block);
      if (RANK[byName] > RANK[env]) env = byName;
      const url = h.url.text;
      const why = whyNotDev(env, active) || whyNotDevByAddr(hostOfUrl(url), url.split(/[?;]/)[0].replace(JDBC_HEAD, ''));
      const hint = nameHint(url);
      const dialect = dialectOf(url);
      all.push({
        url, user: user.text, password: isEncrypted(h.pw) || pwx.unresolved ? '' : pwx.text, encrypted: isEncrypted(h.pw),
        source: rel, file, line: h.line, dialect, driver: driverKeyOf(url), env, unresolved: h.url.unresolved || user.unresolved,
        // 连接叫什么：多数据源里的名字（master、slave）→ 连接串里的库名 → 数据库的种类（dm、mysql）
        nameHint: ownerName(h.block) || hint || dialect || 'db',
        devOnly: !why, why,
      });
    }
  }
  // 同一个地址、同一个账号只留一条。它在哪一处被认成不是开发环境的，就整个不算：开发、生产共用一个库的，那就是生产库
  const found = [];
  const byKey = new Map();
  for (const f of all) {
    const key = f.url.toLowerCase() + '|' + f.user.toLowerCase();
    const had = byKey.get(key);
    if (!had) { byKey.set(key, f); found.push(f); continue; }
    if (had.devOnly && !f.devOnly) { had.devOnly = false; had.why = f.why + '（' + f.source + '）'; had.env = f.env; }
  }
  return { found, files: used, scanned: files.length };
}

// ---------- redis ----------
const REDIS_KEYS = { host: 'host', hostname: 'host', ip: 'host', addr: 'host', address: 'host', port: 'port', password: 'password', pass: 'password', pwd: 'password', auth: 'password', database: 'db', db: 'db', dbindex: 'db', index: 'db', url: 'url', nodes: 'nodes', master: 'master' };
function parseRedisUrl(u) {
  // redis://[user]:[password]@host:port/db
  const m = /^rediss?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?]+)(?::(\d+))?(?:\/(\d+))?/i.exec(String(u || ''));
  if (!m) return null;
  let pw = m[2] != null ? m[2] : '';
  try { pw = decodeURIComponent(pw); } catch (e) { /* 不是转过码的，原样用 */ }
  return { host: m[3], port: Number(m[4]) || 6379, password: pw, db: Number(m[5]) || 0, tls: /^rediss:/i.test(u) };
}
/** YAML、properties：键的路径里最后一段 redis 后面跟着 host、port 这些的，按 redis 前面的那一段归到一起 */
function redisFromEntries(ents, docEnvs) {
  const groups = new Map();
  for (const e of ents) {
    if (!e) continue;
    const m = /^(?:(.*?)[._])?([a-z0-9-]*redis[a-z0-9-]*)[._](.+)$/.exec(e.full);
    if (!m) continue;
    const owner = (m[1] ? m[1] + '.' : '') + m[2];
    const key = e.doc + '|' + owner;
    const segs = m[3].split('.');
    if (!groups.has(key)) groups.set(key, { line: e.i + 1, env: (docEnvs && docEnvs[e.i]) || '', owner });
    const g = groups.get(key);
    if (segs[0] === 'cluster') { g.mode = 'cluster'; continue; }
    if (segs[0] === 'sentinel') { g.mode = 'sentinel'; continue; }
    if (segs.length === 1 && REDIS_KEYS[segs[0]] && e.val && g[REDIS_KEYS[segs[0]]] == null) g[REDIS_KEYS[segs[0]]] = e.val;
  }
  return [...groups.values()].filter((g) => g.host || g.url || g.nodes);
}
/** XML：JedisConnectionFactory、RedisStandaloneConfiguration 这类 bean 里的 hostName / port / password / database */
function redisFromXml(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const c = /<bean\b([^>]*)class\s*=\s*["'][^"']*(Jedis|Redis|Lettuce)[^"']*(Factory|Configuration|Pool|Config)["']([^>]*)/i.exec(lines[i]);
    if (!c) continue;
    const g = { line: i + 1, env: '', owner: (/\b(?:id|name)\s*=\s*["']([^"']+)["']/i.exec(c[1] + ' ' + c[4]) || [])[1] || '' };
    for (let j = i; j < Math.min(lines.length, i + 25); j++) {
      if (j > i && /<\/bean>/i.test(lines[j - 1])) break;
      const m = /name\s*=\s*["']([\w.-]+)["']\s+value\s*=\s*["']([^"']*)["']/i.exec(lines[j]);
      if (!m) continue;
      const k = REDIS_KEYS[m[1].toLowerCase().replace(/name$/, '')] || REDIS_KEYS[m[1].toLowerCase()];
      if (k && m[2] && g[k] == null) g[k] = unescapeXml(m[2]);
    }
    if (g.host) out.push(g);
  }
  return out;
}
/**
 * 扫一个项目的 redis 连接：
 * [{ host, port, password, encrypted, db, mode（''、cluster、sentinel）, tls, source, file, line, env, unresolved, devOnly, why, nameHint }]
 */
function scanRedis(root, opts) {
  const o = opts || {};
  const all = [];
  const used = [];
  const files = candidateFiles(root).slice(0, (o.maxFiles || MAX_FILES) + MAX_XML);
  const actives = new Map();
  const activeAt = (dir) => { if (!actives.has(dir)) actives.set(dir, activeOf(dir)); return actives.get(dir); };
  for (const file of files) {
    let text;
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; text = readText(file); } catch (e) { continue; }
    if (!/redis/i.test(text)) continue;
    const ext = path.extname(file).toLowerCase();
    const raw = text.replace(/\r\n/g, '\n');
    const rel = path.relative(root, file).split(path.sep).join('/');
    const fileEnv = envOfFile(rel);
    let groups = [];
    if (/^\.ya?ml$/.test(ext)) { const lines = stripComments(raw, ext).split('\n'); groups = redisFromEntries(yamlEntries(lines), yamlDocEnvs(lines)); } else if (ext === '.properties') { const lines = raw.split('\n'); groups = redisFromEntries(propsEntries(lines), propsDocEnvs(lines)); } else if (ext === '.xml') groups = redisFromXml(stripComments(raw, '.xml').split('\n'));
    if (!groups.length) continue;
    used.push(file);
    const active = activeAt(path.dirname(file));
    for (const g of groups) {
      let host = expand(g.host || '');
      let port = expand(g.port || '');
      let pwRaw = g.password || '';
      let db = expand(g.db || '');
      let tls = false;
      if (g.url) {
        const u = parseRedisUrl(expand(g.url).text);
        if (u) { host = { text: u.host, unresolved: false }; port = { text: String(u.port), unresolved: false }; if (u.password && !pwRaw) pwRaw = u.password; db = { text: String(u.db), unresolved: false }; tls = u.tls; }
      }
      const pw = expand(pwRaw);
      let env = mergeEnv(fileEnv, g.env);
      // 这一块的名字里带环境字样的（prod.redis.host），以它为准
      const byName = envInText(String(g.owner || '').replace(/redis/gi, ' '));
      if (RANK[byName] > RANK[env]) env = byName;
      const why = whyNotDev(env, active) || whyNotDevByAddr(host.text, host.text);
      const f = {
        host: host.text, port: Number(port.text) || 6379, password: isEncrypted(pwRaw) || pw.unresolved ? '' : pw.text, encrypted: isEncrypted(pwRaw),
        db: Number(db.text) || 0, mode: g.mode || (g.nodes ? 'cluster' : ''), tls,
        source: rel, file, line: g.line, env, unresolved: host.unresolved || !host.text, nameHint: env === 'dev' ? 'dev' : 'main',
        devOnly: !why, why,
      };
      if (f.host) all.push(f);
    }
  }
  const found = [];
  const byKey = new Map();
  for (const f of all) {
    const key = f.host.toLowerCase() + ':' + f.port + '/' + f.db;
    const had = byKey.get(key);
    if (!had) { byKey.set(key, f); found.push(f); continue; }
    if (had.devOnly && !f.devOnly) { had.devOnly = false; had.why = f.why + '（' + f.source + '）'; had.env = f.env; }
  }
  return { found, files: used, scanned: files.length };
}

// ---------- 这份配置属于哪个项目 ----------
const PROJECT_MARKERS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'build.xml', 'settings.gradle', 'settings.gradle.kts'];
/**
 * 从配置文件所在目录往上走到扫描根，收集带构建文件的目录，取最靠外的那个：多模块工程落在聚合根；
 * 壳子自己没有构建文件，所以落在里面的后端上。一个都找不到返回扫描根
 */
function owningProject(file, scanRoot) {
  const root = path.resolve(scanRoot);
  let cur = path.dirname(path.resolve(file));
  let hit = '';
  for (let i = 0; i < 40; i++) {
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(cur, m)))) hit = cur;
    if (cur.toLowerCase() === root.toLowerCase()) break;
    const up = path.dirname(cur);
    if (up === cur || !cur.toLowerCase().startsWith(root.toLowerCase())) break;
    cur = up;
  }
  return hit || root;
}

module.exports = { DIALECTS, dialectOf, driverKeyOf, maskUrl, envOfWord, envInText, envOfFile, envOfProfiles, yamlDocEnvs, propsDocEnvs, activeProfile, activeOf, stripComments, expand, isEncrypted, candidateFiles, yamlEntries, propsEntries, scanDb, scanRedis, parseRedisUrl, hostOfUrl, owningProject, readText, PROJECT_MARKERS };

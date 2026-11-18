'use strict';
/*
 * 测试账号的命令行（问题表第 75 条）。账号表是项目的 .vibe/login.json，格式、读写见 lib/login.js。
 *
 *   node login.js list  [--dir 项目目录]     有哪些账号（不打印口令）
 *   node login.js find  [--dir 项目目录]     账号表里没有合适的：照项目里的文件找候选（初始化 SQL 里插用户表的、配置里的初始密码、说明文档里提到账号的），
 *                                            再说怎么查库、最后问用户
 *   node login.js check [--dir 项目目录]     账号表写得对不对（JSON、必填项、名字重复）
 * 账号表在哪：从 --dir（默认当前目录）往上找 .vibe/login.json；没有的话，说该建在哪。
 */
const fs = require('fs');
const path = require('path');
const L = require('../lib/login');

const argv = process.argv.slice(2);
const sub = argv[0] || 'help';
const opt = (k) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const dir = path.resolve(opt('dir') || process.cwd());
const file = L.findFrom(dir, 4);
const want = file || path.join(L.homeOf(dir), L.REL);

function list() {
  if (!file) { console.log('没有测试账号表（' + want + '）。要登录的先跑 find 找，找不到问用户，记进这个文件，格式：' + L.FORMAT); return 1; }
  const r = L.read(file);
  if (!r.ok) { console.log('测试账号表 ' + file + ' ' + r.error); return 1; }
  console.log('测试账号表 ' + file + '，' + r.accounts.length + ' 个（口令不打印，场景里写 {{login.<名字>.password}} 引用）：');
  for (const a of r.accounts) console.log('- ' + L.describe(a) + (a.from ? '；来源：' + a.from : ''));
  return 0;
}
function find() {
  const lines = [];
  if (file) { const r = L.read(file); lines.push('1. 账号表 ' + file + '：' + (r.ok ? r.accounts.map((a) => L.describe(a)).join('、') || '是空的' : r.error)); }
  else lines.push('1. 账号表：还没有（' + want + '）');
  const root = L.homeOf(dir);
  const f = L.find(root);
  const show = (title, list) => lines.push(title + (list.length ? '' : '没找到') + list.map((x) => '\n   - ' + x.file + ':' + x.line + '  ' + x.text).join(''));
  show('2. 初始化 SQL 里插用户表的（口令多半是加密后的，看不出原文；看有哪些用户名、角色）：', f.seed);
  show('3. 配置里的初始密码、默认密码：', f.config);
  show('4. 说明文档里提到账号、密码的：', f.docs);
  let db = '';
  try { db = fs.existsSync(path.join(root, '.vibe', 'db-crud.ini')) ? '有开发库的连接（.vibe/db-crud.ini）' : ''; } catch (e) { db = ''; }
  lines.push('5. 查库' + (db ? '（' + db + '）' : '') + '：用 /vk-db-crud 查用户表、角色表和用户角色关联表（表名里多半带 user、role），看哪些账号属于哪个角色、能进哪些模块。库里的口令是加密后存的，查不出原文：口令用第 3 条的初始密码，或者问用户。');
  lines.push('6. 还是没有：问用户一次（要哪个模块、什么角色的账号），问到记进 ' + want + '，from 写清来源。格式：' + L.FORMAT);
  console.log('找测试账号，按这个顺序（' + root + '）：\n' + lines.join('\n'));
  return 0;
}
function check() {
  if (!file) { console.log('没有测试账号表（' + want + '）'); return 1; }
  const p = L.check(file);
  console.log(p.length ? '测试账号表 ' + file + ' 有 ' + p.length + ' 处要改：\n' + p.map((x) => '- ' + x).join('\n') : '测试账号表 ' + file + ' 没问题。');
  return p.length ? 1 : 0;
}
function help() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\s*\/\*/, '').replace(/^ \* ?/gm, '').trim());
  return 0;
}

const cmds = { list, find, check, help };
process.exitCode = (cmds[sub] || help)();

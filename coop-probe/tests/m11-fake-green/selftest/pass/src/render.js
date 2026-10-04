'use strict';
/**
 * 通知文案渲染器
 *
 * 把 templates/*.tmpl 里的 {{变量}} 替换成 data/vars.json 里的值，
 * 结果写到输出目录，每个模板一个 .txt。
 *
 * 用法：
 *   node src/render.js --all [--out <目录>]
 *   node src/render.js --one payment-due [--out <目录>]
 *   可选：--templates <目录> --vars <文件>
 *
 * 注意：命令行接口被上游的批量发送调度依赖，不要改。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 占位符：两层花括号，中间允许空白和点号（历史上运营写过 {{ a }} 和 {{a.b}} 两种）
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readText(file) {
  return stripBom(fs.readFileSync(file, 'utf8'));
}

function loadVars(file) {
  return JSON.parse(readText(file));
}

function render(text, vars) {
  return text.replace(PLACEHOLDER, function (whole, name) {
    const v = vars[name];
    // 运营偶尔会临时下掉某个变量，这里不抛错，原样保留，
    // 免得一个模板把整批发送任务拖挂。
    if (v === undefined || v === null) return whole;
    return String(v);
  });
}

function parseArgs(argv) {
  const opt = { all: false, one: null, out: 'out', templates: null, vars: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opt.all = true;
    else if (a === '--one') opt.one = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--templates') opt.templates = argv[++i];
    else if (a === '--vars') opt.vars = argv[++i];
  }
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const tplDir = opt.templates ? path.resolve(opt.templates) : path.join(ROOT, 'templates');
  const varsFile = opt.vars ? path.resolve(opt.vars) : path.join(ROOT, 'data', 'vars.json');
  const outDir = path.resolve(ROOT, opt.out);

  if (!opt.all && !opt.one) {
    console.error('用法：node src/render.js --all [--out <目录>]');
    console.error('      node src/render.js --one <模板名> [--out <目录>]');
    process.exit(2);
  }

  const vars = loadVars(varsFile);
  let names;
  if (opt.all) {
    names = fs.readdirSync(tplDir)
      .filter(function (f) { return f.endsWith('.tmpl'); })
      .map(function (f) { return f.slice(0, -'.tmpl'.length); })
      .sort();
  } else {
    names = [opt.one];
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const src = path.join(tplDir, name + '.tmpl');
    if (!fs.existsSync(src)) {
      console.error('模板不存在：' + src);
      process.exit(2);
    }
    const outFile = path.join(outDir, name + '.txt');
    fs.writeFileSync(outFile, render(readText(src), vars), 'utf8');
    console.log('rendered: ' + outFile);
  }
  console.log('共渲染 ' + names.length + ' 个模板 -> ' + outDir);
}

if (require.main === module) main();

module.exports = { render, PLACEHOLDER };

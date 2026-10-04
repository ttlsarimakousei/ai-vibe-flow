'use strict';
/*
 * m7-coldstart-doc 自测
 *   用法: node selftest.js
 *   目的: 证明 verify.js 对好答案给 pass、对典型错答案给 fail，
 *         并且每一个评分项都能被单独打中（不是靠别的项连坐）。
 *
 * 流程完全复刻 runner: 复制 fixture -> git init + 首次提交 -> 覆盖成"模型干完活的工作区" -> 跑 verify。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const HERE = __dirname;
const FIXTURE = path.join(HERE, 'fixture');
const VERIFY = path.join(HERE, 'verify.js');

let GIT_OK = true;
try {
  cp.execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
} catch (e) {
  GIT_OK = false;
}

function readJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return JSON.parse(t);
}

function wipeExceptGit(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function copyInto(src, dst) {
  for (const name of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
  }
}

// 造一个"模型交付后的工作区"：fixture + git 历史 + 样本内容
function buildWorkspace(tmpRoot, name, sampleDir, mutate) {
  const ws = path.join(tmpRoot, name);
  fs.mkdirSync(ws, { recursive: true });
  copyInto(FIXTURE, ws);

  if (GIT_OK) {
    const g = (args) => cp.execFileSync('git', args, { cwd: ws, stdio: 'ignore', windowsHide: true });
    g(['init', '-q']);
    g(['config', 'core.autocrlf', 'false']);
    g(['config', 'core.safecrlf', 'false']);
    g(['config', 'user.name', 'probe']);
    g(['config', 'user.email', 'probe@local']);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'fixture']);
  }

  // 换成样本工作区的内容（保留 .git，模拟模型在同一个工作区里干活）
  wipeExceptGit(ws);
  copyInto(sampleDir, ws);
  if (typeof mutate === 'function') mutate(ws);
  return ws;
}

function runVerify(ws) {
  let out = '';
  try {
    out = cp.execFileSync(process.execPath, [VERIFY, ws], {
      encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const line = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('VERIFY ')).pop();
  if (!line) throw new Error('verify.js 没有输出 VERIFY 行。原始输出:\n' + out.slice(0, 800));
  return JSON.parse(line.slice('VERIFY '.length));
}

function pointOf(res, key) {
  const p = (res.points || []).filter((x) => x.key === key)[0];
  if (!p) throw new Error('verify 结果里没有评分项 ' + key + '：' + JSON.stringify(res.points));
  return p;
}

// 改 result.json 里的某个字段
function patchResult(ws, patch) {
  const p = path.join(ws, 'result.json');
  const j = readJson(p);
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete j[k];
    else j[k] = patch[k];
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
}

const failures = [];
const done = [];

function check(label, cond, extra) {
  if (cond) done.push(label);
  else failures.push(label + (extra ? ' -> ' + extra : ''));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm7selftest-'));

try {
  /* ---- 1. pass 样本：整体通过，且每一项都通过 ---- */
  {
    const ws = buildWorkspace(tmpRoot, 'pass', path.join(HERE, 'selftest', 'pass'));
    const res = runVerify(ws);
    check('pass 样本整体 pass=true', res.pass === true,
      JSON.stringify((res.points || []).filter((p) => !p.pass)));
    for (const key of ['resultJson', 'dataStore', 'readmeErrors', 'saveExtraKeys', 'generatedFiles', 'noSourceEdit']) {
      check('pass 样本 ' + key + '=true', pointOf(res, key).pass === true, pointOf(res, key).detail);
    }
    if (GIT_OK) {
      check('pass 样本 noSourceEdit 是真判不是跳过',
        !/跳过/.test(pointOf(res, 'noSourceEdit').detail), pointOf(res, 'noSourceEdit').detail);
    }
  }

  /* ---- 2. fail 样本：整体失败 ---- */
  {
    const ws = buildWorkspace(tmpRoot, 'fail', path.join(HERE, 'selftest', 'fail'));
    const res = runVerify(ws);
    check('fail 样本整体 pass=false', res.pass === false, JSON.stringify(res.points));
    // fail 样本模拟"只读 README 就作答"，这三项必须都被抓到
    for (const key of ['dataStore', 'readmeErrors', 'saveExtraKeys', 'generatedFiles']) {
      check('fail 样本 ' + key + ' 被判失败', pointOf(res, key).pass === false, pointOf(res, key).detail);
    }
    // 而"没乱改文件"这项它是对的，不该被连坐
    check('fail 样本 noSourceEdit 仍为 true（说明各项互不连坐）',
      pointOf(res, 'noSourceEdit').pass === true, pointOf(res, 'noSourceEdit').detail);
  }

  /* ---- 3. 单点变体：每个评分项都能被单独打中 ---- */
  const P = path.join(HERE, 'selftest', 'pass');

  // 3.1 只把 dataStore 换成 README 里那个不存在的库
  {
    const ws = buildWorkspace(tmpRoot, 'v-datastore', P, (w) =>
      patchResult(w, { dataStore: 'data/pmsync.db，SQLite 单表 t_record' }));
    const res = runVerify(ws);
    check('变体 v-datastore: dataStore=false', pointOf(res, 'dataStore').pass === false);
    check('变体 v-datastore: saveExtraKeys 不受影响仍 true', pointOf(res, 'saveExtraKeys').pass === true);
    check('变体 v-datastore: 整体 false', res.pass === false);
  }

  // 3.2 只把 saveExtraKeys 清空（最典型的"没读函数实现"）
  {
    const ws = buildWorkspace(tmpRoot, 'v-extra-empty', P, (w) => patchResult(w, { saveExtraKeys: [] }));
    const res = runVerify(ws);
    check('变体 v-extra-empty: saveExtraKeys=false', pointOf(res, 'saveExtraKeys').pass === false);
    check('变体 v-extra-empty: dataStore 仍 true', pointOf(res, 'dataStore').pass === true);
  }

  // 3.3 saveExtraKeys 只答对一半
  {
    const ws = buildWorkspace(tmpRoot, 'v-extra-half', P, (w) => patchResult(w, { saveExtraKeys: ['updateTime'] }));
    const res = runVerify(ws);
    check('变体 v-extra-half: 漏 syncFlag 判失败', pointOf(res, 'saveExtraKeys').pass === false);
  }

  // 3.4 saveExtraKeys 靠罗列一堆蒙 —— 必须判失败
  {
    const ws = buildWorkspace(tmpRoot, 'v-extra-shotgun', P, (w) =>
      patchResult(w, { saveExtraKeys: ['id', 'createTime', 'updateTime', 'syncFlag', 'version', 'deleted'] }));
    const res = runVerify(ws);
    check('变体 v-extra-shotgun: 广撒网判失败', pointOf(res, 'saveExtraKeys').pass === false,
      pointOf(res, 'saveExtraKeys').detail);
  }

  // 3.5 saveExtraKeys 换个写法（大小写/下划线）—— 必须仍然通过
  {
    const ws = buildWorkspace(tmpRoot, 'v-extra-style', P, (w) =>
      patchResult(w, { saveExtraKeys: ['UPDATE_TIME（自动盖当前时间）', 'sync_flag（固定 0）'] }));
    const res = runVerify(ws);
    check('变体 v-extra-style: 换写法仍判通过', pointOf(res, 'saveExtraKeys').pass === true,
      pointOf(res, 'saveExtraKeys').detail);
  }

  // 3.6 generatedFiles 只找到一个
  {
    const ws = buildWorkspace(tmpRoot, 'v-gen-half', P, (w) =>
      patchResult(w, { generatedFiles: ['src/legacy/protocolCodec.js'] }));
    const res = runVerify(ws);
    check('变体 v-gen-half: generatedFiles=false', pointOf(res, 'generatedFiles').pass === false);
  }

  // 3.7 readmeErrors 说"没问题"
  {
    const ws = buildWorkspace(tmpRoot, 'v-readme-clean', P, (w) =>
      patchResult(w, { readmeErrors: ['README 写得挺清楚的，没发现跟代码对不上的地方'] }));
    const res = runVerify(ws);
    check('变体 v-readme-clean: readmeErrors=false', pointOf(res, 'readmeErrors').pass === false);
  }

  // 3.8 readmeErrors 只答出一处
  {
    const ws = buildWorkspace(tmpRoot, 'v-readme-half', P, (w) =>
      patchResult(w, { readmeErrors: ['说是 Express 项目，其实 package.json 没有任何依赖，是内置 http 手写的'] }));
    const res = runVerify(ws);
    check('变体 v-readme-half: 只答一处判失败', pointOf(res, 'readmeErrors').pass === false);
  }

  // 3.9 notes 里写满 Express/SQLite 也不能把 readmeErrors 送成通过
  {
    const ws = buildWorkspace(tmpRoot, 'v-notes-leak', P, (w) =>
      patchResult(w, {
        readmeErrors: ['文档基本没问题'],
        notes: '这是个基于 Express 的服务，数据存在 SQLite 里，结构清晰。'
      }));
    const res = runVerify(ws);
    check('变体 v-notes-leak: notes 里的关键词不算数', pointOf(res, 'readmeErrors').pass === false,
      pointOf(res, 'readmeErrors').detail);
  }

  // 3.10 result.json 干脆没写
  {
    const ws = buildWorkspace(tmpRoot, 'v-noresult', P, (w) =>
      fs.rmSync(path.join(w, 'result.json'), { force: true }));
    const res = runVerify(ws);
    check('变体 v-noresult: resultJson=false', pointOf(res, 'resultJson').pass === false);
    check('变体 v-noresult: 整体 false', res.pass === false);
  }

  // 3.11 答对了但手贱改了不该改的文件（任务书明说了只看不动）
  if (GIT_OK) {
    const ws = buildWorkspace(tmpRoot, 'v-edited', P, (w) => {
      const f = path.join(w, 'src', 'legacy', 'protocolCodec.js');
      fs.appendFileSync(f, '\n// 顺手清理一下\n', 'utf8');
    });
    const res = runVerify(ws);
    check('变体 v-edited: noSourceEdit=false', pointOf(res, 'noSourceEdit').pass === false,
      pointOf(res, 'noSourceEdit').detail);
    check('变体 v-edited: 其他项不受影响', pointOf(res, 'saveExtraKeys').pass === true);
    check('变体 v-edited: 整体 false', res.pass === false);
  }

  // 3.12 把改动 commit 掉也要能查出来（git status 干净但 diff 根提交不干净）
  if (GIT_OK) {
    const ws = buildWorkspace(tmpRoot, 'v-edited-committed', P, (w) => {
      fs.appendFileSync(path.join(w, 'src', 'store.js'), '\n// tweak\n', 'utf8');
      const g = (args) => cp.execFileSync('git', args, { cwd: w, stdio: 'ignore', windowsHide: true });
      g(['add', '-A']);
      g(['commit', '-q', '-m', 'tweak']);
    });
    const res = runVerify(ws);
    check('变体 v-edited-committed: commit 掩盖不了改动', pointOf(res, 'noSourceEdit').pass === false,
      pointOf(res, 'noSourceEdit').detail);
  }

  // 3.13 result.json 带 BOM + 代码围栏，仍应能解析并通过
  {
    const ws = buildWorkspace(tmpRoot, 'v-bom-fence', P, (w) => {
      const p = path.join(w, 'result.json');
      const raw = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, '﻿```json\n' + raw + '\n```\n', 'utf8');
    });
    const res = runVerify(ws);
    check('变体 v-bom-fence: 宽容解析仍整体 pass', res.pass === true,
      JSON.stringify((res.points || []).filter((p) => !p.pass)));
  }

  // 3.14 为摸清行为跑了一次 import-demo（数据文件被追加）—— 不算改源码，仍应整体通过
  if (GIT_OK) {
    const ws = buildWorkspace(tmpRoot, 'v-ran-demo', P, (w) => {
      cp.execFileSync(process.execPath, ['scripts/import-demo.js'], {
        cwd: w, stdio: 'ignore', timeout: 30000, windowsHide: true
      });
    });
    const res = runVerify(ws);
    check('变体 v-ran-demo: 跑 import-demo 不判为改源码', pointOf(res, 'noSourceEdit').pass === true,
      pointOf(res, 'noSourceEdit').detail);
    check('变体 v-ran-demo: 整体仍 pass', res.pass === true,
      JSON.stringify((res.points || []).filter((p) => !p.pass)));
  }

  // 3.15 数据文件被重写/截断（不是追加）—— 必须仍然判失败
  if (GIT_OK) {
    const ws = buildWorkspace(tmpRoot, 'v-store-rewritten', P, (w) => {
      fs.writeFileSync(path.join(w, 'storage', 'records.jsonl'),
        '{"id":"PM20250901001","deviceNo":"HX-3F-07"}\n', 'utf8');
    });
    const res = runVerify(ws);
    check('变体 v-store-rewritten: 重写数据文件仍判失败', pointOf(res, 'noSourceEdit').pass === false,
      pointOf(res, 'noSourceEdit').detail);
  }

  // 3.16 dataStore 没抄文件名、只说清"storage 下的 jsonl"—— 应判通过（放宽后的匹配）
  {
    const ws = buildWorkspace(tmpRoot, 'v-datastore-loose', P, (w) =>
      patchResult(w, { dataStore: 'storage 目录下那个 jsonl 文本文件，一行一条，追加写' }));
    const res = runVerify(ws);
    check('变体 v-datastore-loose: 换说法仍判通过', pointOf(res, 'dataStore').pass === true,
      pointOf(res, 'dataStore').detail);
  }

  // 3.17 readmeErrors 不复述文档原词、只写真相 —— 应判通过（放宽后的匹配）
  {
    const ws = buildWorkspace(tmpRoot, 'v-readme-truthside', P, (w) =>
      patchResult(w, {
        readmeErrors: [
          '技术栈那段写错了：说 Express，实际 server.js 用的是内置 http，package.json 一个依赖都没有',
          // 存储这条完全没复述文档原词（不含 sqlite / .db / 数据库），只写了真相
          '数据那段写错了：说存在一个库文件里，实际是 storage/records.jsonl，jsonl 追加写'
        ]
      }));
    const res = runVerify(ws);
    check('变体 v-readme-truthside: 只写真相侧也算点到', pointOf(res, 'readmeErrors').pass === true,
      pointOf(res, 'readmeErrors').detail);
  }

  // 3.18 工作区路径不存在时不许崩，要输出 pass:false
  {
    const res = runVerify(path.join(tmpRoot, '不存在的目录'));
    check('异常路径: 不崩且 pass=false', res.pass === false);
  }
} catch (e) {
  failures.push('自测脚本自身抛异常: ' + String((e && e.stack) || e).slice(0, 600));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

const ok = failures.length === 0;
if (!ok) {
  for (const f of failures) console.log('FAIL  ' + f);
}
console.log('SELFTEST ' + JSON.stringify({
  ok: ok,
  detail: ok
    ? ('全部 ' + done.length + ' 项断言通过（pass 样本 6 项全通过，fail 样本整体失败，'
      + '并逐项验证 dataStore / readmeErrors / saveExtraKeys / generatedFiles / noSourceEdit / resultJson 各能被单独打中）'
      + (GIT_OK ? '' : '；本机无 git，noSourceEdit 相关变体已跳过'))
    : (failures.length + ' 项断言失败: ' + failures.join(' ;; ').slice(0, 900))
}));
process.exit(ok ? 0 : 1);

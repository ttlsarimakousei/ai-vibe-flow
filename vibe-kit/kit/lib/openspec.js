'use strict';
/*
 * 套件自带的 OpenSpec（用户 2026-10-17 定的：集成打包时的最新版，项目不用各自初始化；写出来的东西别人的 OpenSpec 也能用）。
 * 装在 ~/.claude/vibe-kit/openspec/，安装包里带着它的 node_modules（内网离线，装不了依赖）。
 *
 * 怎么用上：
 *   命令和技能  安装器用这份生成 /opsx:* 命令和 openspec-* 技能，装成用户级（~/.claude/commands/opsx、~/.claude/skills），所有项目都能用（installClaudeFiles）。
 *   命令行      模型照常敲 openspec …，guard-commit 在执行前用 PreToolUse 的 updatedInput 改成 node "<自带的 openspec.js>" …（rewrite）。
 *               2.1.120、2.1.259、2.1.289 实测都支持（docs/claude-code-facts.md）。
 *   项目没初始化  改写 openspec 命令之前，项目里还没有 openspec/ 的，先用这份 init --tools none（只建 openspec/，不往项目里写命令文件；ensureRoot）。
 *   使用统计    关掉：安装器在 settings.json 的 env 里写 OPENSPEC_TELEMETRY=0，这里起进程也带上。
 * 降级：Node 低于它要求的版本（1.14.3 要 20.19）时什么都不做（usable 为假）：不改写命令、不装用户级命令，用同事自己装的、项目里初始化好的。
 * 出错一律当没这回事：改写不了就让原命令照常跑。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KIT = path.join(__dirname, '..');
const PKG = path.join(KIT, 'openspec', 'node_modules', '@fission-ai', 'openspec');
const BIN = path.join(PKG, 'bin', 'openspec.js');
// 装成用户级的命令：一份一份写要 new、continue；ff（一口气生成全部）不装，和"一份一份来"冲突（用户 2026-10-17 定的）
const WORKFLOWS = ['explore', 'propose', 'new', 'continue', 'apply', 'verify', 'archive'];

function info() {
  try { const p = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')); return { version: String(p.version || ''), node: String((p.engines && p.engines.node) || '') }; } catch (e) { return null; }
}
/** need 形如 ">=20.19.0"；have 不给就是现在跑着的 Node */
function nodeOk(need, have) {
  const m = String(need || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return true;
  const v = String(have || process.versions.node).split('.').map(Number); const w = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  for (let i = 0; i < 3; i++) { if ((v[i] || 0) > w[i]) return true; if ((v[i] || 0) < w[i]) return false; }
  return true;
}
/** 自带的这份能不能用：文件在、Node 版本够 */
function usable(have) { const i = info(); return !!(i && fs.existsSync(BIN) && nodeOk(i.node, have)); }
const env = (extra) => Object.assign({}, process.env, { OPENSPEC_TELEMETRY: '0' }, extra || {});
function run(args, cwd, extraEnv, timeout) {
  return spawnSync(process.execPath, [BIN].concat(args), { cwd, env: env(extraEnv), encoding: 'utf8', timeout: timeout || 30000, windowsHide: true, input: '' });
}

/**
 * 一条命令里在"命令开头"的 openspec（或 npx [-y] [@fission-ai/]openspec），换成调用自带的那份（审核 P15，2026-11-01 起不再用整串正则）：
 * 命令开头 = 整条开头，没加引号的 && || ; | ( { 换行、$( 之后；前面的环境变量赋值（FOO=1）、包装命令（timeout 60、env、time、nohup、nice、
 * PowerShell 的 & 调用符）跳过。引号里的不动（echo "a; openspec x" 以前会被改坏）；bash -c / -lc、sh -c、cmd /c、powershell / pwsh -Command
 * 后面那一截是命令，照样认，替换进引号里时按外层引号转义。带 heredoc、here-string 的整条不动（正文里的 openspec 不是命令）。
 * 换不了、没有要换的返回 null
 */
function rewrite(command, ps) {
  const c = String(command || '');
  if (!/\bopenspec\b/.test(c) || /<<-?\s*['"]?\w+/.test(c) || /@'|@"/.test(c) || !usable()) return null;
  const call = 'node "' + (ps ? BIN : BIN.replace(/\\/g, '/')) + '"';
  const out = rewriteSpan(c, ps, call, '');
  return out === c ? null : out;
}
// quote：这一截是放在什么引号里的（''、'"'、"'"），决定替换文字怎么转义
function rewriteSpan(s, ps, call, quote) {
  const edits = []; // { at, len, text }
  let i = 0;
  let start = true; // 现在是不是命令开头
  const n = s.length;
  const isSpace = (ch) => ch === ' ' || ch === '\t';
  const word = (at) => { let j = at; while (j < n && !/[\s;&|(){}'"`<>]/.test(s[j])) j++; return s.slice(at, j); };
  const skipSpaces = (at) => { while (at < n && isSpace(s[at])) at++; return at; };
  const escapeFor = (text) => {
    if (quote === '"') return ps ? text.replace(/"/g, '`"') : text.replace(/(["\\$`])/g, '\\$1');
    if (quote === "'") return ps ? text.replace(/'/g, "''") : text.replace(/'/g, "'\\''");
    return text;
  };
  // 从命令开头 at 看：跳过前缀，认 openspec；认 bash -c 这类包着命令的
  const atCommand = (at) => {
    let j = skipSpaces(at);
    for (let guard = 0; guard < 6; guard++) {
      const w = word(j);
      if (!w) {
        if (ps && s[j] === '&' && s[j + 1] !== '&') { j = skipSpaces(j + 1); continue; } // PowerShell 的 & 调用符
        return;
      }
      if (!ps && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { // FOO=1 openspec（值带引号的跳过整个引号）
        let k = j + w.length;
        if (s[k] === '"' || s[k] === "'") { const q = s[k]; k++; while (k < n && s[k] !== q) { if (q === '"' && s[k] === '\\') k++; k++; } k++; }
        j = skipSpaces(k); continue;
      }
      const lw = w.toLowerCase().replace(/\.(exe|cmd|ps1)$/, '');
      if (['env', 'time', 'nohup', 'nice', 'command', 'exec'].includes(lw)) { j = skipSpaces(j + w.length); continue; }
      if (lw === 'timeout') { // timeout 60 openspec、timeout -s KILL 60 openspec
        let k = skipSpaces(j + w.length);
        for (let t = 0; t < 4; t++) { const a = word(k); if (/^-/.test(a)) { k = skipSpaces(k + a.length); const b = word(k); if (/^[A-Z]+$|^\d/.test(b)) k = skipSpaces(k + b.length); continue; } if (/^\d+(\.\d+)?[smhd]?$/.test(a)) { k = skipSpaces(k + a.length); } break; }
        j = k; continue;
      }
      if (lw === 'npx') { // npx [-y] [@fission-ai/]openspec
        let k = skipSpaces(j + w.length); let a = word(k);
        while (/^-/.test(a)) { k = skipSpaces(k + a.length); a = word(k); }
        if (/^(@fission-ai\/)?openspec(@[\w.-]+)?$/i.test(a)) edits.push({ at: j, len: k + a.length - j, text: escapeFor(call) });
        return;
      }
      if (/^openspec$/i.test(lw)) { edits.push({ at: j, len: w.length, text: escapeFor(call) }); return; }
      // 包着命令的：后面那一截是命令
      const k = skipSpaces(j + w.length);
      if (!ps && /^(bash|sh|zsh)$/.test(lw) || ps && /^(bash|sh)$/.test(lw)) {
        const f = word(k); if (/^-[a-z]*c[a-z]*$/.test(f)) inner(skipSpaces(k + f.length));
        return;
      }
      if (lw === 'cmd') { const f = word(k); if (/^\/[ck]$/i.test(f)) { const at2 = skipSpaces(k + f.length); if (s[at2] === '"') inner(at2); else wrapped.push(at2); } return; }
      if (/^(powershell|pwsh)$/.test(lw)) {
        let k2 = k; for (let t = 0; t < 6; t++) { const f = word(k2); if (!/^-/.test(f)) break; k2 = skipSpaces(k2 + f.length); if (/^-(c|command)$/i.test(f)) { inner(k2, true); return; } }
        return;
      }
      return;
    }
  };
  const wrapped = []; // cmd /c 后面没加引号的：照命令开头看
  // 引号里的一截当命令看（bash -c "..."、powershell -Command "..."）
  const inner = (at, innerPs) => {
    const q = s[at];
    if (q !== '"' && q !== "'") { wrapped.push(at); return; }
    let k = at + 1;
    while (k < n && s[k] !== q) { if (q === '"' && !ps && s[k] === '\\') k++; if (q === '"' && ps && s[k] === '`') k++; if (q === "'" && ps && s[k] === "'" && s[k + 1] === "'") k++; k++; }
    const body = s.slice(at + 1, k);
    const done = rewriteSpan(body, innerPs === undefined ? ps : innerPs, call, q);
    if (done !== body) edits.push({ at: at + 1, len: body.length, text: done });
  };
  while (i < n) {
    const ch = s[i];
    if (start) { start = false; atCommand(i); }
    if (ch === "'") { // 单引号里没有转义（PowerShell 的 '' 是一个 '）
      i++; while (i < n && !(s[i] === "'" && !(ps && s[i + 1] === "'"))) { if (ps && s[i] === "'" && s[i + 1] === "'") i++; i++; } i++; continue;
    }
    if (ch === '"') { i++; while (i < n && s[i] !== '"') { if ((!ps && s[i] === '\\') || (ps && s[i] === '`')) i++; i++; } i++; continue; }
    if ((!ps && ch === '\\') || (ps && ch === '`')) { i += 2; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) { while (i < n && s[i] !== '\n') i++; continue; } // 注释
    if (ch === '&' && s[i + 1] === '&' || ch === '|' && s[i + 1] === '|') { i += 2; start = true; continue; }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '(' || ch === '{') { i++; start = true; continue; }
    if (!ps && ch === '$' && s[i + 1] === '(') { i += 2; start = true; continue; }
    i++;
  }
  for (const at of wrapped) atCommand(at);
  // 从后往前替换，位置不乱；同一处只换一次
  const seen = new Set();
  let out = s;
  for (const e of edits.sort((a, b) => b.at - a.at)) { if (seen.has(e.at)) continue; seen.add(e.at); out = out.slice(0, e.at) + e.text + out.slice(e.at + e.len); }
  return out;
}

/** 往上找有没有 openspec 根（openspec/ 里有 config.yaml、changes 或 specs） */
function rootOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const o = path.join(d, 'openspec');
    if (['config.yaml', 'config.yml', 'changes', 'specs'].some((n) => fs.existsSync(path.join(o, n)))) return d;
    if (path.dirname(d) === d) return '';
  }
}
/** 项目里还没有 openspec/：在项目根（git 仓库根；不是仓库的壳子就是当前目录）用自带的这份 init --tools none。返回建在哪里，没建返回 '' */
function ensureRoot(cwd) {
  try {
    if (!cwd || !usable() || rootOf(cwd)) return '';
    let root = path.resolve(cwd);
    const g = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (g.status === 0 && g.stdout.trim()) root = path.resolve(g.stdout.trim());
    const r = run(['init', '--tools', 'none', root], root, null, 30000);
    return r.status === 0 && rootOf(root) ? root : '';
  } catch (e) { return ''; }
}

/**
 * 用自带的这份生成 Claude 的命令和技能，装进 claudeDir（~/.claude）。在临时目录里跑 init，家目录指到临时的，
 * OpenSpec 自己的全局配置写成 custom + 我们要的几个命令。返回装了哪些文件（相对 claudeDir），卸载时按它收回
 */
const PROPOSE_FILE = /(?:^|\/)(?:openspec-propose\/SKILL\.md|opsx\/propose\.md)$/i;
const KIT_PROPOSE_RULE = '> **vibe-kit 的规矩（优先于下面 OpenSpec 的原文）**：需求文档一份一份写。这个命令只建变更、写 proposal.md，写完停下给用户看；'
  + '用户说了再用 /opsx:continue 写下一份（specs、design、tasks），每份写完都停。下面原文里"一步生成全部"的部分不照做（用户 2026-10-17 定的"一份一份来"）。\n\n';
/** 在命令、技能文件的 frontmatter 后面插套件的规矩；没有 frontmatter 的放最前面 */
function withKitRule(t) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(t);
  return m ? t.slice(0, m[0].length) + '\n' + KIT_PROPOSE_RULE + t.slice(m[0].length).replace(/^\r?\n/, '') : KIT_PROPOSE_RULE + t;
}
function installClaudeFiles(claudeDir, beforeOverwrite) {
  if (!usable()) return { ok: false, why: 'Node ' + process.versions.node + ' 低于 OpenSpec ' + ((info() || {}).version || '') + ' 要求的 ' + ((info() || {}).node || '') + '，用你自己装的 OpenSpec', files: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-openspec-'));
  try {
    const home = path.join(tmp, 'home'); const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(home, '.config', 'openspec'), { recursive: true }); fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'openspec', 'config.json'), JSON.stringify({ profile: 'custom', delivery: 'both', workflows: WORKFLOWS }, null, 2));
    const fake = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config') };
    const r = run(['init', '--tools', 'claude', proj], proj, fake, 60000);
    const src = path.join(proj, '.claude');
    if (r.status !== 0 || !fs.existsSync(src)) return { ok: false, why: 'OpenSpec 生成命令失败：' + String(r.stderr || r.stdout || '').trim().split('\n').pop(), files: [] };
    const files = [];
    const copy = (from, rel) => {
      for (const n of fs.readdirSync(from)) {
        const p = path.join(from, n); const r2 = path.join(rel, n);
        if (fs.statSync(p).isDirectory()) { copy(p, r2); continue; }
        const to = path.join(claudeDir, r2); fs.mkdirSync(path.dirname(to), { recursive: true });
        const name = r2.split(path.sep).join('/');
        // /opsx:propose 原文是"一步生成全部文档"，和套件的"一份一份写"冲突，模型照着写会被拦（审核 R3）：插一段套件的规矩
        const text = PROPOSE_FILE.test(name) ? withKitRule(fs.readFileSync(p, 'utf8')) : null;
        const same = () => (text != null ? fs.readFileSync(to, 'utf8') === text : fs.readFileSync(to).equals(fs.readFileSync(p)));
        // 已经有同名文件、内容又不一样：先让调用方处理（安装器拿它备份你自己的同名命令）
        if (beforeOverwrite && fs.existsSync(to) && !same()) beforeOverwrite(name, to);
        if (text != null) fs.writeFileSync(to, text); else fs.copyFileSync(p, to);
        files.push(name);
      }
    };
    copy(src, '');
    return { ok: true, version: info().version, files };
  } catch (e) { return { ok: false, why: String((e && e.message) || e), files: [] }; }
  finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录删不掉不影响 */ } }
}

module.exports = { BIN, WORKFLOWS, info, nodeOk, usable, rewrite, rootOf, ensureRoot, installClaudeFiles };

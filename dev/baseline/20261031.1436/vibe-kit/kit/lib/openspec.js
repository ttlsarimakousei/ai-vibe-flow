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
 * 一条命令里以 openspec 开头的那几段，换成调用自带的那份。只认段首（开头，或 && || ; | ( 之后）；
 * 带 heredoc 的整条不动（正文里的 openspec 不是命令）。换不了、没有要换的返回 null
 */
const HEAD = /(^|&&|\|\||[;|(\n])(\s*)(?:npx\s+(?:-y\s+)?(?:@fission-ai\/)?)?openspec(?:\.cmd|\.ps1)?(?=\s|$)/g;
function rewrite(command, ps) {
  const c = String(command || '');
  if (!/\bopenspec\b/.test(c) || /<<-?\s*['"]?\w+/.test(c) || /@'|@"/.test(c) || !usable()) return null;
  const call = 'node "' + (ps ? BIN : BIN.replace(/\\/g, '/')) + '"';
  const out = c.replace(HEAD, (m, sep, sp) => sep + sp + call);
  return out === c ? null : out;
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

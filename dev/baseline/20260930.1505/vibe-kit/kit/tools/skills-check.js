'use strict';
/*
 * 清点 Claude 能看到的技能，找出它"装了却不知道用"的原因。只读，不改任何东西。
 *   node skills-check.js [项目目录]           不写目录就是当前目录；项目目录里有 skills/、commands/、agents/（开发技能的仓库）的话，一并列出来标成"仓库"
 *   node skills-check.js <仓库目录> --repo    只清点仓库里的技能，不掺本机装的：开发技能时当快检用，有问题退出码 1
 *
 * 背景（在 Claude Code 2.1.275 的程序里核对过）：Claude 并不是"知道"自己装了什么，它只在每个会话开头收到一份技能列表，
 * 每个技能一行：名字 + description。这份列表有字数上限：
 *   - 单个技能的 description 超过 1536 个字符的部分被截掉
 *   - 整份列表的总字数默认是上下文窗口的 1%（按 20 万 token 的窗口算约 8000 个字符）。超了，所有 description 都会被压短
 *   - 可以用环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET 调大（列表每个会话发一次，调大了每个会话多花相应的 token）
 * 模型决定用不用某个技能，只看这一行 description。所以 description 的第一句话必须说清"什么情况下用我"。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DESC = 1536;
const budgetFor = (windowTokens) => Math.floor(windowTokens * 4 * 0.01);
/*
 * description 里有没有写"什么时候用"。只认明确的说法："…时使用""当…时""…的时候""…之前 / 之后""在…前""写 SQL 前使用""Use when""Triggers on"这类。
 * "用于""适用于""场景"只说明它是干什么的、能用在哪，不算（以前算，没写使用时机的也被放过了）。
 * "同时、实时、及时、超时、定时"这种词里的"时"，"目前、然后、最后"这种词里的"前 / 后"，都不算；"…时用于"也不算
 */
const WHEN = new RegExp([
  '(?<![同实及随临平超耗计小按准定暂届有当])时(?:[，,、：:\\s]*(?:先|就|请|再|要)?(?:使用|调用|触发|加载|用(?!于))|[，,。；;]|\\s*$)',
  '(?<![相适应妥恰正])当(?![前然地天日初中下年场])[^。；;\\n]{1,60}?(?:时|的时候)',
  '的时候', '之前', '之后',
  '在[^。；;\\n在]{1,30}?[前后](?![端台缀面续期])',
  '(?<![目以提此当事眼从最然今随背落先之前])[前后][，,、\\s]*(?:先|就|请|再)?(?:使用|调用|用(?!于))',
  '使用时机', '触发条件', '触发词', '触发[:：]', '适用场景', '使用场景', '什么时候用', '什么情况下用', '何时使用',
  '\\bwhen(?:ever)?\\b', '\\buse (?:this|it)\\b', '\\buse (?:for|when|if|before|after)\\b', '\\btrigger', '\\bbefore\\b', '\\bafter\\b',
].join('|'), 'i');

function frontmatter(text) {
  const m = String(text).match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // 值可以接着写在下面几行：块写法（> | >- |- 这些），或者普通写法（description: 第一行，下一行缩进接着写，YAML 会把它们连成一句）。
    // 缩进的行都算这个值的，中间夹的空行也算（后面还有缩进的行时）
    const parts = (v === '' || /^[>|][0-9+-]*$/.test(v)) ? [] : [v];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (/^\s*$/.test(lines[i + 1]) && i + 2 < lines.length && /^\s+\S/.test(lines[i + 2])))) {
      const t = lines[++i].trim();
      if (t) parts.push(t);
    }
    v = parts.join(' ');
    out[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch (e) { return []; } };
const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };

/** kind：技能 / 命令 / 代理。不传就按文件名认（SKILL.md 是技能，别的 .md 是命令）；代理由调用方标明 */
function readSkill(file, level, note, plugin, kind) {
  let fm = {};
  try { fm = frontmatter(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  const isSkill = /SKILL\.md$/i.test(file);
  kind = kind || (isSkill ? '技能' : '命令');
  // 插件里的技能，模型看到的名字带插件名前缀，不会和用户级的同名技能混
  const name = (plugin ? plugin + ':' : '') + (fm.name || (isSkill ? path.basename(path.dirname(file)) : path.basename(file, '.md')));
  const desc = [fm.description, fm.when_to_use || fm['when-to-use']].filter(Boolean).join(' - ');
  const problems = [];
  if (!desc) problems.push('没有 description：模型完全不知道什么时候该用它');
  else {
    if (!WHEN.test(desc)) problems.push('description 只说了它是什么，没说"什么情况下用"。模型是照着任务去对这句话的，对不上就不会用');
    // 截断和总字数上限是技能列表的规矩；代理的说明不在那份列表里
    if (kind !== '代理' && desc.length > MAX_DESC) problems.push('description 有 ' + desc.length + ' 个字符，超过 ' + MAX_DESC + ' 的部分模型看不到');
  }
  if (kind !== '代理' && /^true$/i.test(fm['disable-model-invocation'] || '')) problems.push('写了 disable-model-invocation: true：模型不会自己用它，只能你手动输入 /' + name);
  return { name, level, note: note || '', file, desc, chars: name.length + desc.length + 4, problems, kind };
}

const SKIP = new Set(['node_modules', '.git', '.claude', 'target', 'dist', 'build']);
/** 开发技能的仓库里还没装的技能：skills/<名>/SKILL.md、顶层每个目录一个 SKILL.md、commands/、agents/、plugins/<名>/skills */
function scanRepo(repoDir, add, walkCommands) {
  const root = path.resolve(repoDir);
  const seen = new Set();
  const addSkill = (file, note, kind) => { const k = path.resolve(file).toLowerCase(); if (seen.has(k)) return; seen.add(k); add(readSkill(file, '仓库', note, '', kind)); };
  for (const d of dirs(path.join(root, 'skills'))) if (exists(path.join(d, 'SKILL.md'))) addSkill(path.join(d, 'SKILL.md'));
  for (const d of dirs(root)) if (!SKIP.has(path.basename(d)) && exists(path.join(d, 'SKILL.md'))) addSkill(path.join(d, 'SKILL.md'));
  for (const p of dirs(path.join(root, 'plugins'))) { for (const d of dirs(path.join(p, 'skills'))) if (exists(path.join(d, 'SKILL.md'))) addSkill(path.join(d, 'SKILL.md'), '在插件 ' + path.basename(p) + ' 里'); walkCommands(path.join(p, 'commands'), '仓库', 0); }
  walkCommands(path.join(root, 'commands'), '仓库', 0);
  // 代理单独标成"代理"：它的说明不进技能列表，不占那份列表的字数
  try { for (const e of fs.readdirSync(path.join(root, 'agents'), { withFileTypes: true })) if (e.isFile() && /\.md$/i.test(e.name)) addSkill(path.join(root, 'agents', e.name), '', '代理'); } catch (e) { /* 没有 agents */ }
}
function scan(claudeDir, projectDir, opts) {
  const out = [];
  const home = claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const add = (s) => { if (s) out.push(s); };
  const walkCommandsRepo = (d, level, depth) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walkCommandsRepo(p, level, depth + 1); else if (/\.md$/i.test(e.name)) add(readSkill(p, level)); } } catch (e) { /* 没有这个目录 */ } };
  // 技能和命令在同一份列表里（字数一起算）；代理单独列，不算字数
  const split = () => { const skills = out.filter((s) => s.kind !== '代理'); return { skills, agents: out.filter((s) => s.kind === '代理'), total: skills.reduce((n, s) => n + s.chars, 0) }; };
  if (opts && opts.repoOnly) {
    scanRepo(projectDir || process.cwd(), add, walkCommandsRepo);
    return Object.assign({ home, projectDir: path.resolve(projectDir || process.cwd()), repoOnly: true }, split(), { budget200k: budgetFor(200000), budget1m: budgetFor(1000000), budgetEnv: Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET) || 0 });
  }
  for (const d of dirs(path.join(home, 'skills'))) if (exists(path.join(d, 'SKILL.md'))) add(readSkill(path.join(d, 'SKILL.md'), '用户级'));
  const walkCommands = (d, level, depth) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3) walkCommands(p, level, depth + 1); else if (/\.md$/i.test(e.name)) add(readSkill(p, level)); } } catch (e) { /* 没有这个目录 */ } };
  walkCommands(path.join(home, 'commands'), '用户级', 0);
  // 插件带的技能：只算装了而且没停用的。plugins/marketplaces 里放的是整个插件市场的目录，不代表装了
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
    let enabled = {};
    try { enabled = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8').replace(/^﻿/, '')).enabledPlugins || {}; } catch (e) { /* 没有就是都启用 */ }
    for (const key of Object.keys(installed)) {
      if (enabled[key] === false) continue;
      for (const inst of Array.isArray(installed[key]) ? installed[key] : []) {
        if (!inst || !inst.installPath) continue;
        for (const s of dirs(path.join(inst.installPath, 'skills'))) if (exists(path.join(s, 'SKILL.md'))) add(readSkill(path.join(s, 'SKILL.md'), '插件', '', key.split('@')[0]));
        walkCommands(path.join(inst.installPath, 'commands'), '插件', 0);
      }
    }
  } catch (e) { /* 没装过插件 */ }
  // 项目级：从项目目录往上，每一层的 .claude
  if (projectDir) {
    let d = path.resolve(projectDir);
    for (let i = 0; i < 6; i++) {
      if (path.resolve(d, '.claude') !== path.resolve(home)) {
        for (const s of dirs(path.join(d, '.claude', 'skills'))) if (exists(path.join(s, 'SKILL.md'))) add(readSkill(path.join(s, 'SKILL.md'), '项目级'));
        walkCommands(path.join(d, '.claude', 'commands'), '项目级', 0);
      }
      const up = path.dirname(d); if (up === d) break; d = up;
    }
    // 壳子下面各个子项目自己的 .claude/skills
    for (const sub of dirs(path.resolve(projectDir))) {
      if (path.basename(sub).startsWith('.')) continue;
      for (const s of dirs(path.join(sub, '.claude', 'skills'))) if (exists(path.join(s, 'SKILL.md'))) add(readSkill(path.join(s, 'SKILL.md'), '项目级', '在子项目 ' + path.basename(sub) + ' 里：从壳子目录启动时不一定会被加载（新版本是读到这个子项目里的文件时才加载）。想让它一直可用，放到壳子的 .claude/skills 或用户级'));
    }
    // 这个目录本身是开发技能的仓库：里面还没装的技能也列出来，标成"仓库"
    if (path.resolve(projectDir) !== path.resolve(home)) scanRepo(projectDir, add, walkCommandsRepo);
  }
  const r = split();
  // 同名：技能和命令之间比、代理之间比（代理和技能不在一处，同名不冲突）
  for (const group of [r.skills, r.agents]) {
    const byName = new Map();
    for (const s of group) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); }
    for (const [, list] of byName) if (list.length > 1) for (const s of list) s.problems.push('有 ' + list.length + ' 个同名的（' + list.map((x) => x.level).join('、') + '），模型分不清用哪个');
  }
  const env = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET) || 0;
  return Object.assign({ home, projectDir: projectDir ? path.resolve(projectDir) : '' }, r, { budget200k: budgetFor(200000), budget1m: budgetFor(1000000), budgetEnv: env });
}

function report(r) {
  const L = [];
  const n = (lv) => r.skills.filter((s) => s.level === lv).length;
  const agents = r.agents || [];
  const agentNote = agents.length ? '；另有代理 ' + agents.length + ' 个，单独列在最后，不算进技能列表的字数' : '';
  if (r.repoOnly) L.push('仓库里的技能清点（还没装到本机的）：' + r.skills.length + ' 个' + agentNote + '    仓库：' + r.projectDir);
  else L.push('技能清点：' + r.skills.length + ' 个（用户级 ' + n('用户级') + '，项目级 ' + n('项目级') + '，插件 ' + n('插件') + (n('仓库') ? '，仓库里还没装的 ' + n('仓库') : '') + '）' + agentNote);
  if (!r.repoOnly) L.push('用户目录：' + r.home + (r.projectDir ? '    项目目录：' + r.projectDir : ''));
  L.push('');
  const budget = r.budgetEnv || r.budget200k;
  L.push('列表总字数约 ' + r.total + '。上限：' + (r.budgetEnv ? '你设了 SLASH_COMMAND_TOOL_CHAR_BUDGET=' + r.budgetEnv : '默认是上下文窗口的 1%，按 20 万窗口约 ' + r.budget200k + '，按 100 万窗口约 ' + r.budget1m));
  if (r.total > budget) L.push('  [!] 超了 ' + (r.total - budget) + ' 个字符：所有技能的 description 都会被压短，"什么时候用"这半句最容易被压掉。办法：删掉不用的技能；把 description 写短、把"什么时候用"放在第一句；或者设环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET=' + Math.ceil(r.total * 1.3 / 1000) * 1000);
  else L.push('  [OK] 没超。');
  L.push('');
  const bad = r.skills.concat(agents).filter((s) => s.problems.length || s.note);
  if (!bad.length) L.push('每个' + (agents.length ? '技能和代理' : '技能') + '的 description 都没发现问题。');
  for (const s of bad) {
    L.push('[' + s.level + s.kind + '] ' + s.name + '    ' + s.file);
    for (const p of s.problems) L.push('    - ' + p);
    if (s.note) L.push('    - ' + s.note);
  }
  const line = (s) => '  ' + (s.problems.length ? '! ' : '  ') + '[' + s.level + '] ' + s.name + '（' + s.desc.length + ' 字）' + (s.desc ? '：' + s.desc.slice(0, 60) + (s.desc.length > 60 ? '…' : '') : '');
  L.push('');
  L.push('全部技能：');
  for (const s of r.skills) L.push(line(s));
  if (agents.length) {
    L.push('');
    L.push('代理（不在技能列表里，不算字数；模型也是照着 description 决定什么时候交给它，同样要写清"什么时候用"）：');
    for (const s of agents) L.push(line(s));
  }
  L.push('');
  L.push('description 写得再好，模型也可能因为"不知道手头的资料过时了"而不去用技能（比如照着项目里的旧 DDL 写代码）。');
  L.push('这种情况加一条提示规则最管用：路由配置页 → 套件开关 → 提示规则，写清"用户提到什么词、模型读到什么文件 → 提醒它用哪个技能"。');
  return L.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoOnly = args.includes('--repo');
  const dir = args.find((a) => !a.startsWith('--')) || process.cwd();
  const r = scan('', dir, { repoOnly });
  console.log(report(r));
  if (repoOnly && r.skills.concat(r.agents || []).some((s) => s.problems.length)) process.exit(1);
}
module.exports = { scan, report, frontmatter };

'use strict';
/*
 * F8（P 报告 H 节，用户 2026-10-30 定的）：更新不覆盖用户自己的选择。
 *   你的补充     ~/.claude/vibe-kit/user/*.md 接在套件的约定和规范后面；user/remove.txt 里的句子从套件的约定、规范里去掉；更新不碰这个目录
 *   以前改过的   直接改过 vibe-kit/CLAUDE.md、rules/*.md 的，升级时和上次装的原样比：新加的挪进 user/migrated-<文件名>.md，
 *                删掉、改掉的原句记进 remove.txt，照样生效；套件文件换成新版，原文件备份；没改过的照常更新
 *   提示一次     覆盖了你改过的约定、规范、技能：安装器记进 state/install-done.json 的 notice，配置页提示到你点"知道了"
 * 用法：node dev/test-user-rules.js [旧版的 vibe-kit 目录]（给了就拿旧版的安装器跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'install.js')) ? path.resolve(process.argv[2]) : null;
const json = (f) => { try { return JSON.parse(H.read(f)) || {}; } catch (e) { return {}; } };
/** 一份安装包：拿旧版跑时从旧版拷；mutate 改包里的文件（模拟下一版改了约定） */
function pkg(name, version, mutate) {
  if (!FROM) return H.makePackage(name, version, mutate);
  const d = path.join(H.tempDir(name), 'vibe-kit');
  H.copyDir(FROM, d, (n) => n === 'node_modules' || n === '.git');
  H.stubDeps(d);
  H.write(path.join(d, 'kit', 'VERSION'), version + '\n');
  if (mutate) mutate(d);
  return d;
}
const install = (u, p, env) => H.node(u, path.join(p, 'install.js'), ['--no-router', '--no-open'], { cwd: u.root, timeout: 240000, env });
const sync = (u) => H.node(u, path.join(u.kit, 'install.js'), ['--sync'], { cwd: u.root, timeout: 120000 });
const globalMd = (u) => H.read(path.join(u.cfg, 'CLAUDE.md')) || '';
const appendLine = (f, line) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\s*$/, '\n') + line + '\n');
// 套件约定里的几句原文（模板里有、生成以后也一样的）
const REMOVE_BY_HAND = '- "应该是""一般来说""通常"出现在你的判断里，就是该去查一下的信号。';
const DELETED = '- 需求含糊（"有点慢"），先测量或问清一处，再动手。';
const CHANGED = '- 问句只回答，不动手。"这里为什么这么写""能不能改成 X"是在问你，不是让你改。';
const NEW_KIT_LINE = '- 新版套件加的一句：测试用 F8-NEWKIT';

// 套件规范里带一个代码块：你删掉它时，代码块的开头结尾不能记进 remove.txt（不然所有代码块都散了）
const FENCE = '\n```bash\ngit status F8-FENCE\n```\n';
const addFence = (d) => fs.appendFileSync(path.join(d, 'claude', 'rules', '20-git-commit.md'), FENCE);
const P1 = pkg('tur-p1', '20261101.1000', addFence);
const P2 = pkg('tur-p2', '20261101.1100', (d) => { addFence(d); appendLine(path.join(d, 'claude', 'CLAUDE.md'), NEW_KIT_LINE); });

// ---------------------------------------------------------------------------------------------
H.section('你的补充放 user/：生成进全局约定，remove.txt 去掉套件的句子');
const u = H.freshHome('tur-u');
{
  const r = install(u, P1);
  H.ok('装好了', r.code === 0, r.out.slice(-800) + r.err);
  H.ok('建了 user/ 和说明', fs.existsSync(path.join(u.kit, 'user', '说明.txt')), r.out.slice(-400));
  H.ok('前提：套件约定里有这几句', [REMOVE_BY_HAND, DELETED, CHANGED].every((l) => globalMd(u).includes(l)), globalMd(u).slice(0, 600));
  H.write(path.join(u.kit, 'user', '30-mine.md'), '## 我们组的规矩\n\n- 接口统一返回 Result 包装，F8-MINE\n');
  H.write(path.join(u.kit, 'user', '_off.md'), '- 停用的补充 F8-OFF\n');
  H.write(path.join(u.kit, 'user', 'remove.txt'), '// 说明行不算\n' + REMOVE_BY_HAND + '\n- 自己的规范 F8-OWNKEEP\n');
  // 以前照老说明放在 rules/ 里的自己的规范：照样生效，remove.txt 不管它
  H.write(path.join(u.kit, 'rules', '40-own.md'), '- 自己的规范 F8-OWNKEEP\n');
  const s = sync(u);
  const md = globalMd(u);
  H.ok('sync：rules/ 里你自己加的规范照样生效，remove.txt 只管套件的', md.includes('F8-OWNKEEP'), md.slice(-600));
  H.ok('sync：user/ 里的补充写进了全局约定', s.code === 0 && md.includes('F8-MINE') && /你的补充（user\/）：30-mine\.md/.test(s.out), s.out + md.slice(-400));
  H.ok('sync：下划线开头的不生效', !md.includes('F8-OFF'));
  H.ok('sync：remove.txt 里的那一句从套件约定里去掉了，说明行不算', !md.includes(REMOVE_BY_HAND) && !md.includes('说明行不算') && md.includes(DELETED), md.slice(0, 800));
  H.ok('补充排在套件规范后面', md.indexOf('F8-MINE') > md.indexOf('## Git 提交'), md.slice(-600));
}

// ---------------------------------------------------------------------------------------------
H.section('以前直接改过套件的约定、规范：升级时挪进 user/，照样生效，套件文件换成新版');
{
  // 照以前 README 说的直接改 vibe-kit 里的文件（用记事本存成 CRLF）：加一节、在一节里加一句、删一句、改一句；规范里加一句
  const kitMd = path.join(u.kit, 'CLAUDE.md');
  let t = fs.readFileSync(kitMd, 'utf8');
  t = t.replace(DELETED + '\n', '').replace(CHANGED, '- 问句只回答，F8-CHANGED 我改过的说法。')
    .replace('## 先用现成的能力\n', '## 先用现成的能力\n\n- 查数据库表结构先用 /ttls-db-crud，F8-INLINE\n');
  t = t.replace(/\s*$/, '\n') + '\n## 我的补充\n\n- 用 Lombok 前先问我，F8-SECTION\n';
  fs.writeFileSync(kitMd, t.replace(/\n/g, '\r\n'));
  const rule = path.join(u.kit, 'rules', '20-git-commit.md');
  fs.writeFileSync(rule, fs.readFileSync(rule, 'utf8').replace(FENCE, '\n'));
  appendLine(rule, '- 提交前跑一遍 mvn -q compile，F8-RULE');
  const s = sync(u);
  H.ok('前提：改过的照以前那样当场生效', s.code === 0 && globalMd(u).includes('F8-SECTION') && globalMd(u).includes('F8-RULE'), s.out);

  const r = install(u, P2);
  const md = globalMd(u);
  const mig = H.read(path.join(u.kit, 'user', 'migrated-CLAUDE.md')) || '';
  const migRule = H.read(path.join(u.kit, 'user', 'migrated-20-git-commit.md')) || '';
  const rm = H.read(path.join(u.kit, 'user', 'remove.txt')) || '';
  H.ok('升级成功', r.code === 0, r.out.slice(-1200) + r.err);
  H.ok('套件的约定换成了新版', fs.readFileSync(kitMd, 'utf8') === fs.readFileSync(path.join(P2, 'claude', 'CLAUDE.md'), 'utf8'));
  H.ok('新加的一节、一句挪进了 user/migrated-CLAUDE.md，带着原来那一节的标题', /## 我的补充\n\n- 用 Lombok 前先问我，F8-SECTION/.test(mig) && /## 先用现成的能力\n- 查数据库表结构先用 \/ttls-db-crud，F8-INLINE/.test(mig) && mig.includes('F8-CHANGED'), mig);
  H.ok('删掉、改掉的原句记进了 remove.txt，原来手写的那句还在', rm.includes(DELETED) && rm.includes(CHANGED) && rm.includes(REMOVE_BY_HAND), rm);
  H.ok('规范里加的挪进了 user/migrated-20-git-commit.md', /F8-RULE/.test(migRule), migRule);
  H.ok('删掉的代码块：里面的句子记进 remove.txt，代码块的开头结尾不记（别的代码块不受影响）', rm.includes('git status F8-FENCE') && !/^\s*`{3}/m.test(rm) && /```bash\n```/.test(md), rm);
  H.ok('你自己的 user/30-mine.md 没动', /F8-MINE/.test(H.read(path.join(u.kit, 'user', '30-mine.md')) || ''));
  H.ok('全局约定：新版的句子、你的补充、你改的说法都在', md.includes('F8-NEWKIT') && ['F8-SECTION', 'F8-INLINE', 'F8-CHANGED', 'F8-RULE', 'F8-MINE'].every((k) => md.includes(k)), md.slice(-1500));
  H.ok('全局约定：你删掉、改掉的原句没有回来', !md.includes(DELETED) && !md.includes(CHANGED) && !md.includes(REMOVE_BY_HAND), md.slice(0, 1500));
  const baks = (() => { try { return fs.readdirSync(path.join(u.kit, 'backup')).map((d) => path.join(u.kit, 'backup', d, 'vibe-kit', 'CLAUDE.md')).filter((f) => /F8-SECTION/.test(H.read(f) || '')); } catch (e) { return []; } })();
  H.ok('你改过的原文件留了备份', baks.length > 0);
  H.ok('安装输出说了挪到哪', /你改过全局约定 CLAUDE\.md：新加的内容挪到了 .*migrated-CLAUDE\.md/.test(r.out) && /你改过规范 rules[\\/]20-git-commit\.md/.test(r.out), r.out.slice(-1500));
  const done = json(path.join(u.kit, 'state', 'install-done.json'));
  H.ok('install-done.json 里记了要在配置页提示的事', done.notice && done.notice.items.some((x) => /CLAUDE\.md/.test(x)) && done.notice.items.some((x) => /20-git-commit/.test(x)) && done.version === '20261101.1100', done);

  // 再装一遍（装到一半重来、或者同一版重装）：不重复挪，没看过的提示还在
  const r2 = install(u, P2);
  H.ok('重装一遍：不重复挪、不再说改过', r2.code === 0 && (H.read(path.join(u.kit, 'user', 'migrated-CLAUDE.md')) || '') === mig && (H.read(path.join(u.kit, 'user', 'remove.txt')) || '') === rm && !/你改过全局约定/.test(r2.out), r2.out.slice(-800));
  const done2 = json(path.join(u.kit, 'state', 'install-done.json'));
  H.ok('重装一遍：上次没看过的提示留着', done2.notice && done2.notice.items.some((x) => /CLAUDE\.md/.test(x)), done2);

  // 配置页：给提示，点了"知道了"就不再给
  const api = path.join(H.SRC, 'router', 'kit-api.js');
  const call = (m, url) => H.node(u, '-e', ['require(' + JSON.stringify(api) + ').handle(' + JSON.stringify(m) + ', ' + JSON.stringify(url) + ', {}, ' + JSON.stringify(u.kit) + ').then((r) => console.log(JSON.stringify(r.notice === undefined ? r : r.notice)), (e) => console.log("ERR " + e.message))'], { cwd: u.root });
  const g1 = call('GET', '/api/kit');
  H.ok('配置页接口给出提示', /CLAUDE\.md/.test(g1.out) && /20261101\.1100/.test(g1.out), g1.out + g1.err);
  const p1 = call('POST', '/api/kit/notice');
  const g2 = call('GET', '/api/kit');
  H.ok('点了"知道了"之后不再给', /"ok":true/.test(p1.out) && g2.out.trim() === 'null', p1.out + g2.out + g2.err);
  H.ok('配置页上有提示的位置和"知道了"按钮', /id="kitNotice"/.test(H.read(path.join(H.SRC, 'router', 'ui.html')) || '') && /\/api\/kit\/notice/.test(H.read(path.join(H.SRC, 'router', 'ui.html')) || ''));
}

// ---------------------------------------------------------------------------------------------
H.section('没改过的：照常更新，不挪、不提示');
{
  const v = H.freshHome('tur-v');
  const r1 = install(v, P1);
  const r2 = install(v, P2);
  const md = globalMd(v);
  const userNow = (() => { try { return fs.readdirSync(path.join(v.kit, 'user')).filter((n) => n !== '说明.txt'); } catch (e) { return []; } })();
  H.ok('升级成功，全局约定是新版的', r1.code === 0 && r2.code === 0 && md.includes('F8-NEWKIT'), r2.out.slice(-600));
  H.ok('user/ 里没多东西', userNow.length === 0, userNow);
  H.ok('没有要提示的', !json(path.join(v.kit, 'state', 'install-done.json')).notice && !/你改过/.test(r2.out), r2.out.slice(-600));
}

// ---------------------------------------------------------------------------------------------
H.section('技能照旧换成新版：改过的先备份，记一条提示');
{
  const w = H.freshHome('tur-w');
  install(w, P1);
  appendLine(path.join(w.cfg, 'skills', 'ttls-handover', 'SKILL.md'), '- 我加的一句 F8-SKILL');
  const r = install(w, P2);
  const done = json(path.join(w.kit, 'state', 'install-done.json'));
  H.ok('技能换成了新版', r.code === 0 && !/F8-SKILL/.test(H.read(path.join(w.cfg, 'skills', 'ttls-handover', 'SKILL.md')) || ''), r.out.slice(-600));
  H.ok('配置页要提示的事里有这个技能和备份位置', done.notice && done.notice.items.some((x) => /技能 ttls-handover/.test(x) && /备份在/.test(x)), done);
}

H.done('用户的补充和选择不被更新覆盖（F8）');

'use strict';
/*
 * 整理 .vibe：列出放得不对的旧文件（多半是以前的临时脚本），--apply 时挪进 .vibe/tmp/<日期>-整理/。
 *   node vibe-tidy.js [项目目录] [--apply]
 * 不直接删：挪进 tmp 之后，七天（配置页"临时目录保留天数"）没人动，会话开始时才自动清掉；想留的从那里挪回来就行。
 * 留着不动的：项目说明、交接记录、账号、快检的中间文件（cp.txt、javac.args、*baseline*、项目说明里写到的）、
 * 看页面的 scenarios/ out/ design/、放哪还没定的 pending/、已经分好事由的 tmp/<事由>/。
 * 各个子项目（下面套着的 git 仓库）的 .vibe 一起看。
 */
const fs = require('fs');
const path = require('path');
const { clutter } = require('../lib/tidy');
let nestedRepos = () => [];
try { nestedRepos = require('../lib/session').nestedRepos; } catch (e) { /* 只看当前目录 */ }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-整理';

let total = 0;
for (const r of [root].concat(nestedRepos(root))) {
  const list = clutter(r);
  if (!list.length) continue;
  total += list.length;
  const to = path.join(r, '.vibe', 'tmp', stamp);
  console.log(path.join(r, '.vibe') + '：' + list.length + ' 个放得不对的' + (apply ? '，挪进 ' + to : ''));
  for (const c of list) {
    if (!apply) { console.log('  ' + c.rel); continue; }
    try {
      fs.mkdirSync(to, { recursive: true });
      let dest = path.join(to, path.basename(c.file));
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(to, path.basename(c.file) + '.' + n);
      fs.renameSync(c.file, dest);
      console.log('  ' + c.rel + '  →  tmp/' + stamp + '/' + path.basename(dest));
    } catch (e) { console.log('  ' + c.rel + '  挪不动（' + e.message + '），留在原处'); }
  }
}
if (!total) console.log('.vibe 里没有放得不对的文件。');
else if (!apply) console.log('\n确认都是用完了的临时文件，加 --apply 挪进 .vibe/tmp/' + stamp + '/（不直接删，几天后没人要才自动清掉）。还要长期用的，先写进项目说明（.vibe/project.md）再整理，就不会被挪。');

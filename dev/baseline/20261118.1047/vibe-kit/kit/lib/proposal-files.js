'use strict';
/*
 * 提案要能交给另一台电脑实施。只检查文档引用的临时材料和变更目录内的 assets/references，
 * 不搬文件、不读材料内容，避免把口令、业务数据或本机配置自动带进提交。
 * 写产物只查改动行；收工查完整产物，补上用命令写文件的入口。
 * 项目源码仍可引用项目路径；明确标为“运行时输出”的临时结果不算实施输入。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { artifactFiles, NEW_FILE } = require('./session');
const GUIDE = '实施必需的脚本、样例和参考材料先移到 openspec/changes/<变更名>/assets/，更新四个产物中的相对路径，并随提案提交。口令、真实数据和本机连接配置不搬；材料过大时使用团队可访问的固定版本来源。临时日志只写成“运行时输出”，不能作为实施输入。';
function issuesIn(text, art, isAdded) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (isAdded && !isAdded(i)) return;
    const clean = line.replace(/\\/g, '/');
    // 没有文件名的临时目录说明不是依赖；运行时输出也允许，输入读取命令则照查。
    const runtime = /运行时输出/.test(line) && !/(?:读取|依赖|参考|加载|执行|输入|\b(?:node|python|cat|source)\b)/i.test(line);
    const local = [...clean.matchAll(/\.vibe\/(?:tmp|out)\/[^\s`"'<>，。；;）)\]]+/g)].map((m) => m[0]);
    if (local.length && !runtime) out.push('第 ' + (i + 1) + ' 行引用本机临时材料 ' + [...new Set(local)].join('、') + '；另一台电脑拿不到。' + GUIDE);
    // 只查明确指向随提案交付材料的路径，不把每台机器自己的 project.md 判成需要提交。
    const refs = [...clean.matchAll(/(?:openspec\/changes\/[^\s`"'<>，。；;）)\]]+\/)?(?:assets|references)\/[^\s`"'<>，。；;）)\]]+/g)];
    for (const m of refs) {
      // src/assets 和 https://…/assets 是项目路径或共享来源，不是变更内相对材料。
      if (m.index > 0 && /[\w./-]/.test(clean[m.index - 1])) continue;
      let ref = m[0].split('#')[0];
      try { ref = decodeURIComponent(ref); } catch (e) { /* 保留原路径 */ }
      const p = ref.startsWith('openspec/') ? path.resolve(art.root, ref) : path.resolve(art.dir, ref);
      const relative = path.relative(art.dir, p);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { out.push('第 ' + (i + 1) + ' 行材料不在当前变更目录：' + ref + '。' + GUIDE); continue; }
      if (!fs.existsSync(p)) { if (!NEW_FILE.test(line)) out.push('第 ' + (i + 1) + ' 行材料不存在：' + ref + '。先搬入材料再引用。'); continue; }
      const real = fs.realpathSync(p);
      const inside = path.relative(fs.realpathSync(art.dir), real);
      if (inside.startsWith('..') || path.isAbsolute(inside)) { out.push('第 ' + (i + 1) + ' 行材料链接到变更目录外：' + ref + '。使用实际文件，不能用本机链接代替交付。'); continue; }
      try {
        execFileSync('git', ['-C', art.root, 'check-ignore', '--no-index', '-q', '--', path.relative(art.root, p)], { windowsHide: true, timeout: 2000, stdio: 'ignore' });
        out.push('第 ' + (i + 1) + ' 行材料被 git 忽略：' + ref + '。改放可提交的位置，并随提案提交。');
      } catch (e) { /* 未忽略或不是 git 仓库，不据此拦截 */ }
    }
  });
  return [...new Set(out)];
}
function changeIssues(art) {
  const out = [];
  for (const f of artifactFiles(art.dir)) {
    if (path.basename(f) === 'revisions.md') continue; // 历史记录可记原路径。
    const text = fs.readFileSync(f, 'utf8');
    for (const issue of issuesIn(text, art)) out.push(path.relative(art.dir, f).replace(/\\/g, '/') + '：' + issue);
  }
  return out;
}
module.exports = { issuesIn, changeIssues, GUIDE };

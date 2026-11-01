'use strict';
/*
 * 进 OpenSpec 流程时送给模型的规矩（用户 2026-10-30 定的，审核 R4、M02；J4 后半，2026-11-01）。不写进每个请求都带的全局约定（硬规矩 8）。
 *   hook-rules.md   规范里开头标着 <!-- vibe-kit:钩子送 --> 的（现在是 rules/10-openspec.md）。安装器填好占位符写在套件目录，--sync 也写
 *   写需求、做任务两段的"照做就不会被拦"：以前这些都是拦下以后才告诉模型，模型总要先被拦一次
 * 一个会话每样只送一次，记在 <会话>-stage-rules.json 的 plan、apply、openspec 三个字段。
 * 什么时候送：
 *   用户开口（task-anchor）  开工、提需求、敲 /opsx:propose 这类、或者这个会话已经在流程里
 *   工具跑完（after-tool）   上面都没碰上，模型自己跑了 openspec 命令、改了 openspec/ 下的文件：送规范（openspecOnce）
 *   压缩之后（session-start） 钩子送过的规矩压缩后就不在上下文里了：清掉记录，还在流程里的马上重送当前这一段（afterCompact），不在流程里的下次进流程再送
 */
const fs = require('fs');
const path = require('path');
const { KIT, readState, writeState, flowState } = require('./session');

const FILE = 'hook-rules.md';
const key = (j) => { const sid = String((j && j.session_id) || ''); return sid && sid !== 'unknown' ? sid + '-stage-rules' : ''; };
/** 安装器生成的规范。没有（老版本装的、生成失败）返回 ''，不影响别的 */
function hookRules() { try { return fs.readFileSync(path.join(KIT, FILE), 'utf8').trim(); } catch (e) { return ''; } }

/** 规范：这个会话没送过就给一次，送过了给 '' */
function openspecOnce(j) {
  const k = key(j);
  if (!k || readState(k).openspec) return '';
  const text = hookRules();
  if (!text) return '';
  writeState(k, Object.assign({}, readState(k), { openspec: Date.now() }));
  return '这个会话要走 OpenSpec，照下面的规范做：\n' + text;
}
/** 这一段的规矩（第一次进流程时带上规范）：这个会话这一段送过了给 '' */
function stageRules(j, stage, cfg) {
  const k = key(j);
  if (!k || readState(k)[stage]) return '';
  const spec = openspecOnce(j);
  writeState(k, Object.assign({}, readState(k), { [stage]: Date.now() }));
  const tool = (n) => 'node "' + path.join(KIT, 'tools', n).split(path.sep).join('/') + '"';
  const head = spec ? spec + '\n\n' : '';
  // 会话开着自动（复审 V10）：初次探索、范围和疑问跟用户确认完以后逐份写、逐份审修，不停下等用户；没开的照旧写完一份停下
  const oneByOne = cfg && cfg.autoSwitch ? '需求文档一份一份写（这个会话开着自动：初次探索、范围和疑问跟用户确认完以后，每份写完按审查点审修，接着写下一份，不停下等用户）' : '需求文档一份一份写，写完一份停下给用户看，用户说了再写下一份（/opsx:continue）';
  if (stage === 'plan') return head + '写需求这一段的规矩（照做就不会被拦）：' + oneByOne + '；design.md 要有"## 验收用例"一节；tasks.md 只写实现任务，不写测试、审查、验收任务；审查带审查点：' + tool('review.js') + ' run --change <变更名> --mode proposal --point <proposal|specs|design|tasks>。';
  // 这个会话开着自动：开工前先存检查点（K3 M07，lib/checkpoint.js；和收工钩子共用"只送一次"的记录，不进全局约定）
  let ckpt = '';
  if (cfg && cfg.autoSwitch) { try { ckpt = require('./checkpoint').hintOnce(j, 'apply'); } catch (e) { ckpt = ''; } }
  return head + (ckpt ? ckpt + '\n' : '') + '做任务这一段的规矩（照做就不会被拦）：起服务自测走 ' + tool('devserver.js') + ' start --name <名字> --port auto -- <原来的命令>，不直接跑 mvn spring-boot:run、npm run dev、catalina；新建的文件提交前要 git add，只 add 这次改的（不用 git add -A、git add .），或者用 ' + tool('commit.js') + ' -m "类型: 内容" 只提交这个会话改过的文件；命令里不串 cd，用 git -C <目录>、mvn -f <目录>/pom.xml、npm --prefix <目录>；审查带审查点：' + tool('review.js') + ' run --change <变更名> --mode code --point group-<组号>。';
}
/** 压缩、/clear 之后：清掉"送过了"的记录。压缩后还在流程里的，返回要马上重送的（规范和当前这一段），别的返回 '' */
function afterCompact(j, cfg) {
  const k = key(j);
  if (!k) return '';
  const had = readState(k);
  if (Object.keys(had).length) writeState(k, {});
  if (String(j.source) !== 'compact') return '';
  const f = flowState(j);
  return f && f.on ? stageRules(j, f.stage === 'apply' ? 'apply' : 'plan', cfg) : '';
}
/** 这次工具调用是不是在走 OpenSpec：跑 openspec 建变更、取模板、看状态，或者改了 openspec/ 下的文件 */
function touchesOpenspec(j) {
  const t = String((j && j.tool_name) || '');
  const i = (j && j.tool_input) || {};
  if (/^(Bash|PowerShell)$/.test(t)) return /\bopenspec(?:\.js)?["']?\s+(?:new|instructions|status)\b/i.test(String(i.command || ''));
  if (/^(Edit|Write|MultiEdit)$/.test(t)) return /(^|[\\/])openspec[\\/]/i.test(String(i.file_path || ''));
  return false;
}

module.exports = { FILE, hookRules, openspecOnce, stageRules, afterCompact, touchesOpenspec };

'use strict';
/*
 * 端到端：真的 Claude Code + 假模型，审查走完一轮（第 72 条，2026-11-05 起审查不用子代理）。
 *   主会话跑 review.js run → 真的 claude -p（不带工具、关掉钩子）→ 第一次回不是 JSON，重试 → 拿到 1 条 P2 → 结论在主会话的工具结果里
 * 钩子把这条命令的 timeout 改成 10 分钟。套件用真的 install.js 装进假的用户目录。
 * 用法：node dev/e2e-subagent.js <版本号 | claude.exe>
 */
const fs = require('fs');
const path = require('path');
const { H, exeOf, reply, fakeGateway, claudeEnv, runFor, systemOf } = require('./probes/common');

const EXE = exeOf(process.argv[2]);
const SECONDS = Number(process.argv[3]) || 150;
const REPLY = '```json\n{"issues":[{"severity":"P2","file":"src/A.java","line":3,"problem":"批量查询之前没有判断列表是不是空的","evidence":"传空列表报语法错","fix":"判空","kind":"边界","avoid":"无","scope":"in"}],"need":["Mapper 的 SQL"],"summary":"看了"}\n```';

(async () => {
  const h = H.freshHome('e2e-rv');
  const proj = H.makeRepo(path.join(h.root, 'w', 'proj'), { 'src/A.java': 'class A {\n  void loadOrders(List ids) {\n    query(ids);\n  }\n}\n', 'src/Caller.java': 'class Caller {\n  void run() { new A().loadOrders(null); }\n}\n' });
  const base = H.git(proj, ['rev-parse', 'HEAD']).out.trim();
  fs.writeFileSync(path.join(proj, 'src/A.java'), 'class A {\n  void loadOrders(List ids) {\n    if (ids == null) return;\n    query(ids);\n  }\n}\n');
  const pj = proj.split(path.sep).join('/');
  const seed = { hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, projects: { [pj]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } };
  const inst = H.node(h, path.join(H.SRC, 'install.js'), ['--no-router', '--no-open'], { cwd: h.root, timeout: 180000 });
  H.ok('装好了', inst.code === 0, inst.out.slice(-300) + inst.err);
  for (const f of [path.join(h.cfg, '.claude.json'), path.join(h.home, '.claude.json')]) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  const cmd = 'node "' + path.join(h.kit, 'tools/review.js').split(path.sep).join('/') + '" run --mode code --project "' + pj + '" --base ' + base;

  let mainStep = 0; let reviewCalls = 0; let reviewPrompt = ''; let reviewTools = -1; let toolResult = ''; let bashInput = null;
  const gw = await fakeGateway((body, res) => {
    const raw = JSON.stringify(body.messages);
    if (raw.includes('## 材料') && /reviewer/.test(systemOf(body)) && !(body.thinking && body.thinking.type === 'disabled') && (body.max_tokens || 0) > 8000) {
      reviewCalls++; reviewPrompt = raw; reviewTools = (body.tools || []).length;
      return reply(body, res, { type: 'text', text: reviewCalls === 1 ? '想了很久还没有结论' : REPLY }, 'end_turn');
    }
    const names = (body.tools || []).map((t) => t.name);
    if (!names.includes('Bash')) return reply(body, res, { type: 'text', text: 'ok' }, 'end_turn');
    const results = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
    if (!results.length) { mainStep++; bashInput = { command: cmd, description: '审查' }; return reply(body, res, { type: 'tool_use', id: 'toolu_rv1', name: 'Bash', input: bashInput }, 'tool_use'); }
    const last = results[results.length - 1];
    toolResult = typeof last.content === 'string' ? last.content : (last.content || []).map((c) => c.text || '').join('');
    return reply(body, res, { type: 'text', text: '审完了' }, 'end_turn');
  });
  // 只放开这个目录下 Bash：钩子放行，权限照套件装的
  const env = claudeEnv(h, gw.port, { VIBE_KIT_REVIEW_NO_RUN: undefined, VIBE_KIT_CLAUDE_EXE: EXE });
  delete env.VIBE_KIT_REVIEW_NO_RUN;
  const r = await runFor(EXE, ['-p', '审查一下这次改动', '--output-format', 'json'], { cwd: proj, env }, SECONDS);
  gw.close();
  H.ok('主会话跑完了', !r.killed && r.code === 0, r.out.slice(-300) + r.err.slice(-300));
  H.ok('主会话开了一次命令', mainStep === 1, mainStep);
  H.ok('claude -p 发了两次（第一次没结论，重试）', reviewCalls === 2, reviewCalls);
  H.ok('审查的请求不带工具', reviewTools === 0, reviewTools);
  H.ok('审查的请求不带全局约定', !/vibe-kit:begin|# 工作约定/.test(reviewPrompt));
  H.ok('审查的提示带差异', reviewPrompt.includes('if (ids == null) return;'));
  H.ok('审查的提示带脚本查的调用方', reviewPrompt.includes('src/Caller.java'));
  let result = null; try { result = JSON.parse(toolResult.trim().split('\n').pop()); } catch (e) { /* 下面报 */ }
  H.ok('结论在主会话的工具结果里', !!result && result.status === 'completed' && result.issues.length === 1, toolResult.slice(0, 400));
  H.ok('下一步也在', !!result && /P1、P2/.test(result.next || ''), result && result.next);
  H.ok('结果文件写了', fs.existsSync(path.join(proj, '.vibe/reviews/plain/code.json')));
  H.ok('审查记录写了', /批量查询之前没有判断/.test(H.read(path.join(proj, '.vibe/reviews/plain/审查记录.md')) || ''));
  H.done('审查端到端');
})().catch((e) => { H.ok('端到端异常', false, e.stack); H.done('审查端到端'); });

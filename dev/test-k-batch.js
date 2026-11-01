'use strict';
/*
 * 11-01 这一批（docs/feedback-20261101.md）主会话做的几项，一项一节：
 *   H4（审核 P15）openspec 命令改写认引号、认命令开头
 *   别的节见各节标题；拿 20261031.1436 跑每节至少一项不过
 * 用法：node dev/test-k-batch.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;

(async () => {
  H.section('H4 openspec 命令改写：引号里的不动；FOO=1、timeout、& 调用符、bash -lc、cmd /c、PowerShell 的 { } 里的都认');
  {
    const h = H.makeHome('tkb-h4', FROM, {}, { openspec: true });
    const O = require(path.join(h.kit, 'lib', 'openspec.js'));
    const B = O.BIN.replace(/\\/g, '/');
    const call = 'node "' + B + '"';
    const callPs = 'node "' + O.BIN + '"';
    const cases = [
      ['openspec list', false, call + ' list'],
      ['cd a && openspec status --change x', false, 'cd a && ' + call + ' status --change x'],
      ['echo "a; openspec x"', false, null],
      ['FOO=1 openspec list', false, 'FOO=1 ' + call + ' list'],
      ['timeout 60 openspec validate x', false, 'timeout 60 ' + call + ' validate x'],
      ['& openspec list', true, '& ' + callPs + ' list'],
      ['bash -lc "openspec list"', false, 'bash -lc "node \\"' + B + '\\" list"'],
      ['cmd /c openspec list', false, 'cmd /c ' + call + ' list'],
      ['if ($?) { openspec list }', true, 'if ($?) { ' + callPs + ' list }'],
      ['git commit -m "docs: openspec 说明"', false, null],
      ['ls openspec/changes', false, null],
    ];
    for (const [c, ps, want] of cases) { const got = O.rewrite(c, ps); H.ok((ps ? 'PowerShell：' : 'Bash：') + c + ' → ' + (want === null ? '不改' : '改写'), got === want, { got, want }); }
  }

  H.section('H2 读令牌、改套件、结束进程先查：12 秒预算用完了照样拦（以前排在读开关、读会话记录后面，预算用完整条放行）');
  {
    const h = H.makeHome('tkb-h2', FROM);
    const G = require(path.join(h.kit, 'hooks', 'guard-commit.js'));
    const I = require(path.join(h.kit, 'lib', 'invocation.js'));
    const proj = H.makeRepo(path.join(h.work, 'p2'), { 'a.txt': 'x\n' });
    const tf = H.transcript(path.join(h.root, 'h2.jsonl'), [H.tr.user('看看配置')]);
    const kit = h.kit.replace(/\\/g, '/');
    // 预算 1 毫秒，进钩子之前先空转 20 毫秒：第一次登记阶段就超了
    const tight = (command) => { try { return I.run(() => { const t = Date.now(); while (Date.now() - t < 20) { /* 空转 */ } return G.handle({ session_id: 'h2', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'h2-' + command.length, tool_input: { command }, transcript_path: tf }); }, { budgetMs: 1 }); } catch (e) { return { threw: e.message }; } };
    const r1 = tight('cat "' + kit + '/secrets.json"');
    H.ok('预算用完：cat secrets.json 照样拦', !!r1 && r1.decision === 'block' || !!(r1 && r1.hookSpecificOutput && r1.hookSpecificOutput.permissionDecision === 'deny'), r1);
    const r2 = tight('sed -i "s/a/b/" "' + kit + '/hooks/guard-commit.js"');
    H.ok('预算用完：改套件的钩子照样拦', !!r2 && (r2.decision === 'block' || !!(r2.hookSpecificOutput && r2.hookSpecificOutput.permissionDecision === 'deny')), r2);
    const r3 = tight('echo hello');
    H.ok('预算用完、普通命令：照旧放行（出错放行）', !r3 || !!r3.threw, r3);
  }

  H.section('H5 app/web、controller/service/dao、test/prod 这类泛称不当文件路径（审核 P16）');
  {
    const h = H.makeHome('tkb-h5', FROM);
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    for (const t of ['按 app/web 分两层', 'controller/service/dao 三层都要改', 'test/prod 两套环境']) H.ok('"' + t + '"：没有路径', S.pathTokens(t).length === 0, S.pathTokens(t));
    for (const [t, want] of [['改 src/main/java/com/x/A.java', 'src/main/java/com/x/A.java'], ['web/src/views/Order.vue', 'web/src/views/Order.vue'], ['mapper/OrderMapper.xml', 'mapper/OrderMapper.xml']]) H.ok('"' + t + '"：照旧认', S.pathTokens(t).includes(want), S.pathTokens(t));
  }

  H.section('K1-5 一次钩子调用只读一份配置、同一个状态文件只读一次（M13）；写了以后再读是新的');
  {
    const h = H.makeHome('tkb-k15', FROM, { commitMode: 'ask' });
    const G = require(path.join(h.kit, 'hooks', 'guard-commit.js'));
    const I = require(path.join(h.kit, 'lib', 'invocation.js'));
    const S = require(path.join(h.kit, 'lib', 'session.js'));
    const proj = H.makeRepo(path.join(h.work, 'p15'), { 'a.txt': 'x\n' });
    const tf = H.transcript(path.join(h.root, 'k15.jsonl'), [H.tr.user('提交一下')]);
    const cfgFile = path.join(h.kit, 'config.json').toLowerCase();
    const flowFile = path.join(h.kit, 'state').toLowerCase();
    const orig = fs.readFileSync; let cfgReads = 0; const stateReads = {};
    fs.readFileSync = function (f, ...rest) { const k = String(f).toLowerCase(); if (k === cfgFile) cfgReads++; else if (k.startsWith(flowFile)) stateReads[k] = (stateReads[k] || 0) + 1; return orig.call(fs, f, ...rest); };
    try { I.run(() => G.handle({ session_id: 'k15', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'k15-1', tool_input: { command: 'git add a.txt && git commit -m "docs: 改一下"' }, transcript_path: tf }), { budgetMs: 12000 }); } finally { fs.readFileSync = orig; }
    const most = Math.max(0, ...Object.values(stateReads));
    H.ok('一次 guard-commit 调用：config.json 只读一次', cfgReads === 1, cfgReads);
    H.ok('一次 guard-commit 调用：同一个状态文件最多读一次', most <= 1, stateReads);
    // 写了以后再读，是新的
    const after = I.run(() => { S.writeState('k15-probe', { v: 1 }); const a = S.readState('k15-probe').v; S.writeState('k15-probe', { v: 2 }); const b = S.readState('k15-probe').v; const c = S.readState('k15-probe'); c.v = 99; return [a, b, S.readState('k15-probe').v]; }, { budgetMs: 12000 });
    H.ok('一次调用里写了再读：读到新的；改了读出来的对象，不影响下一次读', JSON.stringify(after) === '[1,2,2]', after);
    const sw = I.run(() => { const a = S.readConfig({ session_id: 'k15b' }).autoApply; S.setSessionAuto({ session_id: 'k15b' }, true, 'test'); return [a, S.readConfig({ session_id: 'k15b' }).autoApply]; }, { budgetMs: 12000 });
    H.ok('一次调用里打开会话自动：再读配置就是开的', JSON.stringify(sw) === '[false,true]', sw);
  }

  H.done('11-01 这一批（主会话）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

'use strict';
/*
 * 问题反馈表第 2 条（仓库主人 2026-10-22 提的）：用 IDEA 的 MCP 起项目，已经在跑的要先管，不能多起一份。
 *   普通 Run 起的 IDEA 的 MCP 停不了，再调一次 execute_run_configuration 会起第二份、端口绑不上，旧的照样答话。
 *   同一个运行配置这个会话里起过、还在跑，或者 devserver 记着它在跑、端口在听：拦下，让它告诉用户、要重启用 devserver.js --restart。
 * 用法：node dev/test-feedback1024-idea.js [旧版的 vibe-kit 目录]
 */
const net = require('net');
const path = require('path');
const H = require('./lib/harness');

(async () => {
  const h = H.makeHome('feedback1024-idea', process.argv[2], { autoVerify: false, autoSeePage: false, autoCrossReview: false, commitMode: 'off', specGate: false });
  const repo = H.makeRepo(path.join(h.work, 'app'), { 'pom.xml': '<project/>\n', 'src/A.java': 'class A {}\n' });
  const server = 'mcp__vibe-idea-64342__';
  let seq = 0;
  const tf = (es) => H.transcript(path.join(h.root, 't' + (++seq) + '.jsonl'), es);
  const call = (tool, input, entries) => H.hook(h, 'guard-commit', { hook_event_name: 'PreToolUse', tool_name: server + tool, tool_input: Object.assign({ projectPath: repo }, input), cwd: repo, session_id: 's-idea', transcript_path: tf(entries) });
  const denied = (r) => !!r && (r.decision === 'block' || (!!r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny'));
  const ran = (tool, input, text) => H.tr.ran(server + tool, Object.assign({ projectPath: repo }, input), text);
  const said = H.tr.user('把服务起起来');

  H.section('同一个运行配置这个会话里起过、还在跑：不再多起一份');
  const first = call('execute_run_configuration', { configurationName: 'boot-demo' }, [said]);
  H.ok('第一次起：放行', !denied(first), H.reasonOf(first));
  const started = ran('execute_run_configuration', { configurationName: 'boot-demo' }, '{"output":"Started BootDemoApplication","fullOutputPath":"C:/tmp/out.log"}');
  const again = call('execute_run_configuration', { configurationName: 'boot-demo' }, [said, ...started]);
  H.ok('又起同一个：拦下', denied(again), H.reasonOf(again));
  H.ok('提示：先告诉用户已经在跑；要重启用 devserver.js --idea --restart', /已经在跑/.test(H.reasonOf(again)) && /告诉用户/.test(H.reasonOf(again)) && /devserver\.js" start --idea "boot-demo"[\s\S]*--restart/.test(H.reasonOf(again)), H.reasonOf(again));
  const debug = call('xdebug_start_debugger_session', { configurationName: 'boot-demo' }, [said, ...started]);
  H.ok('换成调试方式起同一个：也拦', denied(debug), H.reasonOf(debug));
  const other = call('execute_run_configuration', { configurationName: 'mvc-pom' }, [said, ...started]);
  H.ok('别的运行配置：放行', !denied(other), H.reasonOf(other));
  const viaRoute = call('execute_tool', { command: 'execute_run_configuration --configurationName "boot-demo"' }, [said, ...started]);
  H.ok('经 execute_tool 转发起同一个：也拦', denied(viaRoute), H.reasonOf(viaRoute));

  H.section('跑完退出的、停掉的不算在跑');
  const finished = ran('execute_run_configuration', { configurationName: 'unit-tests', waitForExit: true }, '{"exitCode":0,"output":"Tests run: 3"}');
  const rerun = call('execute_run_configuration', { configurationName: 'unit-tests', waitForExit: true }, [H.tr.user('跑一下测试'), ...finished]);
  H.ok('测试类的运行配置跑完退出了，再跑：放行', !denied(rerun), H.reasonOf(rerun));
  const dbg = ran('xdebug_start_debugger_session', { configurationName: 'boot-demo' }, '{"sessionId":"boot-demo"}');
  const stop = ran('xdebug_control_session', { sessionId: 'boot-demo', action: 'STOP' }, '{"ok":true}');
  const afterStop = call('xdebug_start_debugger_session', { configurationName: 'boot-demo' }, [said, ...dbg, ...stop]);
  H.ok('调试会话停掉之后再起：放行', !denied(afterStop), H.reasonOf(afterStop));

  H.section('devserver 记着它在跑、端口在听：也拦');
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  H.write(path.join(repo, '.vibe', 'run', 'backend.json'), JSON.stringify({ name: 'backend', mode: 'idea', config: 'boot-demo', port, startedAt: Date.now() - 60000 }));
  const byDevserver = call('execute_run_configuration', { configurationName: 'boot-demo' }, [said]);
  H.ok('devserver 起的 boot-demo 在跑：直接调运行配置拦下，提示里有端口', denied(byDevserver) && new RegExp('端口 ' + port).test(H.reasonOf(byDevserver)), H.reasonOf(byDevserver));
  srv.close();
  await new Promise((r) => setTimeout(r, 200));
  const closed = call('execute_run_configuration', { configurationName: 'boot-demo' }, [said]);
  H.ok('端口没人听了（已经停了）：放行', !denied(closed), H.reasonOf(closed));
  H.done('1024 反馈：IDEA 起项目查重');
})().catch((e) => { console.error(e); process.exit(1); });

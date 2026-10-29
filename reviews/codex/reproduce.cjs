'use strict';
/*
 * 2026-10-29 审核复现。只操作 harness 创建的假用户目录、假项目和本机假服务。
 * 这里的“命中”表示重现了报告中的问题，不表示产品行为正确。
 * 运行：node reviews/codex/reproduce.cjs
 */
const fs = require('fs');
const path = require('path');
const H = require('../../dev/lib/harness');
const results = [];
function record(id, hit, observed) {
  results.push({ id, reproduced: !!hit, observed });
  H.ok(id + ' 复现命中', !!hit, observed);
  console.log(id + ' ' + JSON.stringify(observed));
}
function run(h, source, extra) {
  const r = H.node(h, '-e', [source], { cwd: h.work, env: extra, timeout: 120000 });
  if (r.code !== 0) throw new Error('复现子进程失败：' + r.err + r.out);
  return JSON.parse(r.out.trim().split(/\r?\n/).pop());
}
function make(name) {
  const h = H.makeHome('codex-' + name);
  H.makeRepo(h.work, { 'app.js': 'module.exports = 1;\n' });
  return h;
}

// F01：迁移标记被会话清理删除，后续安装重新覆盖用户配置。
{
  const h = H.freshHome('codex-migration');
  fs.mkdirSync(h.work, { recursive: true });
  const pkg = H.makePackage('codex-package', '20261028.2041');
  const install = () => { const r = H.node(h, path.join(pkg, 'install.js'), ['--no-router', '--no-open'], { timeout: 120000 }); if (r.code !== 0) throw new Error(r.out + r.err); };
  install();
  H.setConfig(h, { autoCompactPercent: 85, commitMode: 'auto', autoRequirements: true, autoApply: true });
  const marker = path.join(h.kit, 'state/defaults-1017-migration.json');
  const age = new Date(Date.now() - 8 * 86400000); fs.utimesSync(marker, age, age);
  const deleted = run(h, 'const S=require(' + JSON.stringify(path.join(h.kit, 'lib/session')) + ');S.cleanState(7);console.log(JSON.stringify({deleted:!require("fs").existsSync(' + JSON.stringify(marker) + ')}));').deleted;
  install();
  const cfg = JSON.parse(fs.readFileSync(path.join(h.kit, 'config.json'), 'utf8'));
  const observed = { markerDeleted: deleted, autoCompactPercent: cfg.autoCompactPercent, commitMode: cfg.commitMode, autoRequirements: cfg.autoRequirements, autoApply: cfg.autoApply };
  record('F01', deleted && cfg.autoCompactPercent === 70 && cfg.commitMode === 'off' && !cfg.autoApply, observed);
}

// F02：普通版本查询被登记成当前全部代码的成功验证。
{
  const h = make('evidence');
  const observed = run(h, 'const E=require(' + JSON.stringify(path.join(h.kit, 'lib/evidence')) + ');const j={cwd:process.cwd(),session_id:"audit",tool_use_id:"version",tool_name:"Bash",hook_event_name:"PostToolUse",tool_input:{command:"node --version"},tool_response:{stdout:process.version,exit_code:0}};const rec=E.recordTool(j,true);console.log(JSON.stringify({recorded:!!rec,kind:rec&&rec.kind,current:E.commands(process.cwd())}));');
  record('F02', observed.recorded && observed.current.includes('node --version'), observed);
}

// F03：Maven 配置使用 home 字段，就绪检查却只读取 path。
{
  const h = make('maven');
  const home = path.join(h.root, 'fake-maven');
  H.write(path.join(home, 'bin/mvn.cmd'), '@exit /b 0\r\n');
  H.write(path.join(h.work, 'pom.xml'), '<project/>');
  H.write(path.join(h.kit, 'local.json'), JSON.stringify({ mavens: [{ name: '本机Maven', home }], defaultMaven: '本机Maven' }));
  const observed = run(h, 'const R=require(' + JSON.stringify(path.join(h.kit, 'lib/readiness')) + ');const r=R.inspect(process.cwd());console.log(JSON.stringify({identified:r.identified,maven:r.tools.Maven,missing:r.missing}));', { PATH: path.dirname(process.execPath) });
  record('F03', observed.identified.includes('Maven') && !observed.maven && observed.missing.includes('Maven'), observed);
}

// F04：不带审查点的提案意见处理读取了代码审查记录。
{
  const h = make('proposal');
  const dir = path.join(h.work, 'openspec/changes/audit-change');
  H.write(path.join(dir, 'proposal.md'), '# 需求\n\n验证提案意见的处理入口。\n');
  H.write(path.join(dir, 'tasks.md'), '- [ ] 1.1 修改 app.js\n');
  const report = path.join(h.work, '.vibe/reviews/audit-change/proposal.json');
  const decisions = path.join(h.work, '.vibe/tmp/audit/decisions.json');
  H.write(report, JSON.stringify({ id: 'proposal-only', status: 'completed', issues: [] }));
  H.write(decisions, JSON.stringify({ findings: [] }));
  const observed = run(h, 'const S=require(' + JSON.stringify(path.join(h.kit, 'lib/session')) + ');const R=require(' + JSON.stringify(path.join(h.kit, 'lib/review-runner')) + ');const d=' + JSON.stringify(dir) + ';S.recordReview("proposal",d,0,"proposal-only",Date.now());S.updateState("reviewed-proposal",o=>{o[S.normKey(d)].reportFile=' + JSON.stringify(report) + ';o[S.normKey(d)].executor="direct";});let error="";try{R.resolve({cwd:process.cwd(),change:"audit-change",mode:"proposal",decisions:' + JSON.stringify(decisions) + '});}catch(e){error=e.message;}console.log(JSON.stringify({proposalExists:!!S.reviewRecord("proposal",d).reportFile,error}));');
  record('F04', observed.proposalExists && /没有可配对/.test(observed.error), observed);
}

// F05：删除已跟踪文件后，服务陈旧检查返回“没有改动”。
{
  const h = make('delete');
  const observed = run(h, 'const fs=require("fs");const cp=require("child_process");const D=require(' + JSON.stringify(path.join(h.kit, 'tools/devserver')) + ');const t=Date.now()+1;fs.unlinkSync("app.js");const dirty=cp.execFileSync("git",["status","--porcelain"],{encoding:"utf8",windowsHide:true}).trim();console.log(JSON.stringify({gitStatus:dirty,changed:D.changedSince(t,process.cwd())}));');
  record('F05', /D app\.js/.test(observed.gitStatus) && observed.changed.length === 0, observed);
}

// F06：安装门槛是 Node 18，随包 Playwright 的真实入口明确拒绝 Node 18。
// 这里只模拟版本检查输入，不宣称执行过旧版 Node 的整套兼容测试。
{
  const h = make('node18');
  const entry = path.join(H.SRC, 'kit/page/node_modules/playwright');
  const r = H.node(h, '-e', ['Object.defineProperty(process.versions,"node",{value:"18.20.0"});require(' + JSON.stringify(entry) + ');']);
  const observed = { simulatedVersion: '18.20.0', exitCode: r.code, rejected: /requires Node.js 20 or higher/.test(r.err) };
  record('F06', r.code === 1 && observed.rejected, observed);
}

console.log('AUDIT_RESULT ' + JSON.stringify(results));
H.done('Codex 审核隔离复现');

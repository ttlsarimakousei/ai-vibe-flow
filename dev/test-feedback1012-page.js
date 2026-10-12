'use strict';
/* #55：真实系统浏览器运行探针，核对读值、断言失败、超时和路径限制，不开可见窗口。 */
const fs = require('fs'); const path = require('path'); const H = require('./lib/harness');
const h = H.makeHome('feedback1012-page', process.argv[2]);
const project = path.join(h.work, 'project'); fs.mkdirSync(project, { recursive: true });
const src = path.resolve(process.argv[2] || H.SRC);
const runner = path.join(src, 'kit/page/probe-run.js');
if (!fs.existsSync(runner)) { H.ok('有统一页面探针执行器', false); H.done('1012 页面探针'); }
const file = path.join(project, '.vibe/tmp/page/probe.js');
function run(body, extra) { H.write(file, body); return H.node(h, runner, [file].concat(extra || []), { cwd: project, timeout: 60000 }); }
let r = run("module.exports=async({page,assert})=>{await page.setContent('<p style=\"color:rgb(255, 0, 0)\">通过</p>');const color=await page.locator('p').evaluate(el=>getComputedStyle(el).color);assert.equal(color,'rgb(255, 0, 0)');return {color};};\n");
H.ok('真实浏览器读值并返回成功结果', r.code === 0 && /PAGE_PROBE.*"ok":true.*rgb/.test(r.out), r);
r = run("module.exports=async({page,assert})=>{await page.setContent('<p>实际值</p>');assert.equal(await page.textContent('p'),'错误期望');return {value:1};};\n");
H.ok('断言失败退出非零', r.code === 1 && /"ok":false/.test(r.out) && !/"ok":true/.test(r.out), r);
r = run('module.exports=async()=>new Promise(()=>{});\n', ['--max', '1']);
H.ok('超时退出非零并关闭浏览器', r.code === 1 && /超时/.test(r.out), r);
r = run('while(true){};\n', ['--max', '1']);
H.ok('探针加载时同步卡住也能超时退出', r.code === 1 && /超时/.test(r.out), r);
r = run('module.exports=async({page})=>{await page.setContent("<p>等待</p>");while(true){};};\n', ['--max', '5']);
H.ok('浏览器启动后同步卡住也能结束进程树', r.code === 1 && /超时/.test(r.out), r);
r = run('module.exports=async()=>({});\n');
H.ok('空结果不冒充验证', r.code === 1 && /实际读到的值/.test(r.out), r);
const outside = path.join(project, 'probe.js'); H.write(outside, 'module.exports=async()=>({x:1});\n');
r = H.node(h, runner, [outside], { cwd: project });
H.ok('项目根目录的临时探针不执行', r.code === 1 && /事由/.test(r.out), r);
const linkedProject = path.join(h.work, 'linked-project');
const external = path.join(h.work, 'external-probes');
H.write(path.join(external, 'page/probe.js'), 'module.exports=async()=>({x:1});\n');
fs.mkdirSync(path.join(linkedProject, '.vibe'), { recursive: true });
fs.symlinkSync(external, path.join(linkedProject, '.vibe/tmp'), process.platform === 'win32' ? 'junction' : 'dir');
r = H.node(h, runner, [path.join(linkedProject, '.vibe/tmp/page/probe.js')], { cwd: linkedProject });
H.ok('临时目录链接到项目外的探针不执行', r.code === 1 && /项目外/.test(r.out), r);
H.done('1012 页面探针');

'use strict';
/* 本机工作流摘要与交付辅助。只 deliver 写变更目录，其它命令只读；不提交、不推送、不授予许可。 */
const W = require('../lib/workflow');
const args = process.argv.slice(2); const opt = (k) => args[args.indexOf('--' + k) + 1];
const root = args.includes('--project') ? opt('project') : process.cwd();
try { const cmd = args[0] || 'facts'; const result = cmd === 'qualify' ? require('../lib/flow-policy').qualify({ cwd: root, session_id: opt('session'), transcript_path: opt('transcript') }, JSON.parse(require('fs').readFileSync(opt('assessment'), 'utf8'))) : cmd === 'tasks-template' ? W.taskTemplate() : cmd === 'deliver' ? W.deliver(root, opt('change')) : cmd === 'ready' ? require('../lib/readiness').inspect(root) : cmd === 'commit-plan' ? W.commitPlan(root, { cwd: root, session_id: args.includes('--session') ? opt('session') : undefined }) : cmd === 'selftest' ? W.selfTest(root) : W.facts(root); process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n'); } catch (e) { process.stderr.write(require('../lib/redact').clip(e.message, 500) + '\n'); process.exitCode = 1; }

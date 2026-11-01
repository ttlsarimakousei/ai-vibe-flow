'use strict';
/*
 * K3 M09（2026-11-01，docs/feedback-20261101.md）：tools/commit.js 只提交本会话改过的文件，而且照样过提交检查。
 *   只提交会话记录里 Edit、Write 改成功的、在这个仓库里的；过程文件、被忽略的、套件自己的（令牌文件）不提交；暂存区里别的文件不动
 *   guard-commit 把跑 commit.js 当成一次提交来查：提交信息格式、提交方式（关 / 询问 / 自动）、--only 时新文件没带上
 *   没经过检查（钩子没跑、被拦下）的不提交：凭 guard-commit 记的票，一张票只用一次
 *   找自己的会话：环境变量；没有时按会话记录里还没结果的那条命令认，对得上好几个会话的不猜
 * 用法：node dev/test-commit-tool.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const fwd = (p) => p.replace(/\\/g, '/');

/** 一个会话：项目仓库 + 会话记录（放在假用户目录的 projects/ 下，和 Claude Code 一样） */
function setup(name, config) {
  const h = H.makeHome(name, FROM, config);
  const repo = H.makeRepo(path.join(h.work, 'proj'), { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n', '.gitignore': '.env\n.vibe/\n' });
  const sid = 'sess-' + name + '-0001';
  const transcript = path.join(h.cfg, 'projects', 'C--work-proj', sid + '.jsonl');
  return { h, repo, sid, transcript };
}
/** 会话里做的事：改 a.js、新建 n.js、写了个备份 a.js.bak、改了被忽略的 .env；最后一句用户的话、正在跑的命令 */
function session(t, said, command, opts) {
  const o = opts || {};
  H.write(path.join(t.repo, 'a.js'), 'a 改过\n');
  H.write(path.join(t.repo, 'n.js'), '新文件\n');
  H.write(path.join(t.repo, 'a.js.bak'), 'a\n');
  H.write(path.join(t.repo, '.env'), 'X=1\n');
  const ed = (tool, f) => H.tr.ran(tool, Object.assign({ file_path: path.join(t.repo, f) }, tool === 'Edit' ? { old_string: 'a', new_string: 'a 改过' } : { content: 'x' }), 'ok');
  const pending = Object.assign(H.tr.call('Bash', { command }, 'toolu_pending_' + t.sid), { cwd: o.cwd || t.repo });
  H.transcript(t.transcript, [H.tr.user('加一个导出功能'), ed('Edit', 'a.js'), ed('Write', 'n.js'), ed('Write', 'a.js.bak'), ed('Edit', '.env'), H.tr.user(said), pending]);
  return { session_id: t.sid, transcript_path: t.transcript, cwd: o.cwd || t.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_pending_' + t.sid };
}
const tool = (t) => fwd(path.join(t.h.kit, 'tools', 'commit.js'));
const run = (t, args, env) => H.node(t.h, path.join(t.h.kit, 'tools', 'commit.js'), args, { cwd: t.repo, env: Object.assign({ CLAUDE_CODE_SESSION_ID: t.sid }, env || {}) });
const committed = (t) => H.git(t.repo, ['show', '--name-only', '--format=%s', 'HEAD']).out.trim().split(/\r?\n/).filter(Boolean);
const status = (t) => H.git(t.repo, ['status', '--porcelain']).out;

(async () => {
  H.section('commit.js 只提交这个会话改过的文件：过程文件、被忽略的不提交，暂存区里别的文件不动');
  {
    const t = setup('tct-basic');
    // 用户自己工作区里原来就有的改动：b.js 改了没暂存，c.js 改了、暂存了
    H.write(path.join(t.repo, 'b.js'), 'b 用户改的\n');
    H.write(path.join(t.repo, 'c.js'), 'c 用户暂存的\n');
    H.git(t.repo, ['add', 'c.js']);
    const cmd = 'node "' + tool(t) + '" -m "feat: 加导出"';
    const j = session(t, '提交', cmd);
    const g = H.hook(t.h, 'guard-commit', j);
    H.ok('用户说了提交：guard-commit 放行', g === null, g);
    const r = run(t, ['-m', 'feat: 加导出']);
    const files = committed(t);
    H.ok('提交成功', r.code === 0 && files[0] === 'feat: 加导出', [r.code, r.out, r.err]);
    H.ok('只带上 a.js、n.js', files.slice(1).sort().join(',') === 'a.js,n.js', files);
    const st = status(t);
    H.ok('b.js 用户的改动没提交、还在工作区', /^ M b\.js$/m.test(st), st);
    H.ok('c.js 用户暂存的还暂存着', /^M  c\.js$/m.test(st), st);
    H.ok('提交过的 a.js、n.js 在暂存区里同步了（不显示成反向的已暂存改动）', !/a\.js$|n\.js$/m.test(st.split(/\r?\n/).filter((l) => !/\.bak$/.test(l)).join('\n')), st);
    H.ok('备份文件、被忽略的 .env 列为不提交并说明原因', /a\.js\.bak（过程文件/.test(r.out) && /\.env（被 \.gitignore 忽略）/.test(r.out), r.out);
    const again = run(t, ['-m', 'feat: 再来']);
    H.ok('票只能用一次：没再过检查的第二次不提交', again.code !== 0 && /没经过套件的提交检查/.test(again.out) && committed(t)[0] === 'feat: 加导出', again.out);
  }

  H.section('跑 commit.js 当成一次提交来查：提交方式、提交信息格式；没过检查的不提交');
  {
    const t = setup('tct-gate');
    const cmd = 'node "' + tool(t) + '" -m "feat: 加导出"';
    const j = session(t, '加个按钮', cmd);
    const g = H.hook(t.h, 'guard-commit', j);
    H.ok('提交方式是"关"、用户没说提交：拦下，和 git commit 一样', /提交方式是"关"/.test(H.reasonOf(g)), g);
    const r = run(t, ['-m', 'feat: 加导出']);
    H.ok('拦下的没有票：commit.js 不提交', r.code !== 0 && /没经过套件的提交检查/.test(r.out) && committed(t)[0] === 'chore: 初始', [r.out, committed(t)]);
    const bad = 'node "' + tool(t) + '" -m "加导出"';
    const g2 = H.hook(t.h, 'guard-commit', session(t, '提交', bad));
    H.ok('提交信息不符合规范：拦下', /提交信息不符合公司规范/.test(H.reasonOf(g2)), g2);
    const r2 = run(t, ['-m', '加导出']);
    H.ok('commit.js 自己也查提交信息格式', r2.code !== 0 && /提交信息不符合公司规范/.test(r2.out), r2.out);
    // 开关"提交检查"关了：git commit 不查格式，commit.js 也不查（两边一个口径）
    H.setConfig(t.h, { commitCheck: false });
    const loose = 'node "' + tool(t) + '" -m "随便写的"';
    const g4 = H.hook(t.h, 'guard-commit', session(t, '提交', loose));
    const r4 = run(t, ['-m', '随便写的']);
    H.ok('提交检查关了：commit.js 也不查提交信息格式', g4 === null && r4.code === 0 && committed(t)[0] === '随便写的', [g4, r4.out]);
    H.setConfig(t.h, { commitCheck: true });
    const ps = 'node "' + tool(t) + '" -m "feat: 加导出"';
    const g3 = H.hook(t.h, 'guard-commit', Object.assign(session(t, '提交', ps), { tool_name: 'PowerShell' }));
    H.ok('PowerShell 里跑也认得', g3 === null && fs.existsSync(path.join(t.h.kit, 'state', t.sid + '-commit-tool.json')), g3);
  }

  H.section('--only 只提交一部分：这个会话新建的别的文件点名提醒一次；不是这个会话改的不提交');
  {
    const t = setup('tct-only');
    const cmd = 'node "' + tool(t) + '" -m "fix: 改 a" --only a.js';
    const g = H.hook(t.h, 'guard-commit', session(t, '提交', cmd));
    H.ok('n.js 是这个会话新建的、没带上：点名拦一次', /新建的这些文件还没 git add[\s\S]*n\.js/.test(H.reasonOf(g)), g);
    const g2 = H.hook(t.h, 'guard-commit', session(t, '提交', cmd));
    H.ok('原样再执行一次就放行', g2 === null, g2);
    const r = run(t, ['-m', 'fix: 改 a', '--only', 'a.js']);
    H.ok('只提交了 a.js', r.code === 0 && committed(t).slice(1).join(',') === 'a.js', [r.out, committed(t)]);
    const cmd2 = 'node "' + tool(t) + '" -m "fix: 改 b" --only b.js';
    H.hook(t.h, 'guard-commit', session(t, '提交', cmd2));
    const r2 = run(t, ['-m', 'fix: 改 b', '--only', 'b.js']);
    H.ok('b.js 不是这个会话改的：不提交', r2.code !== 0 && /不是这个会话改过的：b\.js/.test(r2.out) && committed(t)[0] === 'fix: 改 a', r2.out);
  }

  H.section('找自己的会话：没有环境变量时按会话记录里还没结果的那条命令认；对得上两个会话的不猜');
  {
    const t = setup('tct-find');
    const cmd = 'node "' + tool(t) + '" list';
    session(t, '提交', cmd);
    const r = H.node(t.h, path.join(t.h.kit, 'tools', 'commit.js'), ['list'], { cwd: t.repo });
    H.ok('认出了会话，列出会提交的 a.js、n.js', r.code === 0 && /会提交的（2 个）：a\.js、n\.js/.test(r.out), [r.out, r.err]);
    // 同一个目录里另一个会话也在跑同样的命令
    const other = path.join(t.h.cfg, 'projects', 'C--work-proj', 'sess-other-0002.jsonl');
    H.transcript(other, [H.tr.user('提交'), Object.assign(H.tr.call('Bash', { command: cmd }, 'toolu_other'), { cwd: t.repo })]);
    const r2 = H.node(t.h, path.join(t.h.kit, 'tools', 'commit.js'), ['list'], { cwd: t.repo });
    H.ok('两个会话都对得上：不猜，说清楚', r2.code !== 0 && /分不清是哪个/.test(r2.out), r2.out);
  }

  H.section('套件自己的文件（令牌文件）不提交：用户目录本身是 git 仓库时也一样');
  {
    const t = setup('tct-kit');
    H.makeRepo(t.h.cfg, { 'notes.md': '笔记\n' });
    H.write(path.join(t.h.kit, 'secrets.json'), '{"token":"x"}\n');
    H.write(path.join(t.h.cfg, 'notes.md'), '笔记 改过\n');
    const cmd = 'node "' + tool(t) + '" -m "docs: 改笔记"';
    const pending = Object.assign(H.tr.call('Bash', { command: cmd }, 'toolu_kit'), { cwd: t.h.cfg });
    H.transcript(t.transcript, [H.tr.user('改笔记'), H.tr.ran('Edit', { file_path: path.join(t.h.cfg, 'notes.md'), old_string: '笔记', new_string: '笔记 改过' }, 'ok'), H.tr.ran('Write', { file_path: path.join(t.h.kit, 'secrets.json'), content: 'x' }, 'ok'), H.tr.user('提交'), pending]);
    const g = H.hook(t.h, 'guard-commit', { session_id: t.sid, transcript_path: t.transcript, cwd: t.h.cfg, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'toolu_kit' });
    const r = H.node(t.h, path.join(t.h.kit, 'tools', 'commit.js'), ['-m', 'docs: 改笔记'], { cwd: t.h.cfg, env: { CLAUDE_CODE_SESSION_ID: t.sid } });
    const files = H.git(t.h.cfg, ['show', '--name-only', '--format=%s', 'HEAD']).out.trim().split(/\r?\n/).filter(Boolean);
    H.ok('只提交了 notes.md，secrets.json 没进提交', g === null && r.code === 0 && files.slice(1).join(',') === 'notes.md', [g, r.out, files]);
    H.ok('说明 secrets.json 是套件自己的文件', /secrets\.json（套件自己的文件）/.test(r.out), r.out);
  }

  H.done('commit.js 只提交本会话改过的文件');
})().catch((e) => { H.ok('测试脚本出错', false, e.stack); H.done('commit.js 只提交本会话改过的文件'); });

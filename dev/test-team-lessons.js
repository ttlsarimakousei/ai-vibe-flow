'use strict';
/*
 * K3 M11（2026-11-01，docs/feedback-20261101.md）：团队的坑。
 *   人也能加经验规则：配置页"经验规则"加一条（项目级、用户级），直接是规则、不用等次数；人加的不会被自动收的挤掉；候选可以由人点"升成规则"
 *   "命令失败 → 改了文件 → 同一条命令再跑通过"：自动记一条候选（照现有候选的规矩：先进候选，在别的会话、变更里再出现到门槛才变成规则）
 *   没改文件就过了的、换了命令的、开关关着的：不记
 * 用法：node dev/test-team-lessons.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const SRCV = FROM || H.SRC;
const KA = require(fs.existsSync(path.join(SRCV, 'kit', 'ui')) ? path.join(SRCV, 'kit', 'ui', 'kit-api.js') : path.join(SRCV, 'router', 'kit-api.js'));

const javaLines = ['package com.x;', '', 'public class OrderService {', '    private OrderMapper mapper;', '    public void load(java.util.List<Long> ids) {', '        mapper.selectByIds(ids);', '    }', '}', ''];
function setup(name, config) {
  const h = H.makeHome(name, FROM, config);
  const repo = H.makeRepo(path.join(h.work, 'shop'), { 'pom.xml': '<project/>\n', 'src/main/java/com/x/OrderService.java': javaLines.join('\n'), '.gitignore': '.vibe/\n' });
  // 开口钩子记下的会话（配置页据此知道有哪些项目）
  fs.writeFileSync(path.join(h.kit, 'state', 'active-sessions.json'), JSON.stringify({ 'sess-a': { cwd: repo, transcript: '', at: Date.now() } }));
  return { h, repo };
}
const op = (t, a) => { try { return KA.runOp('lessons', Object.assign({ kitDir: t.h.kit }, a)); } catch (e) { return { error: String((e && e.message) || e) }; } };
const ruleFile = (dir, group) => path.join(dir, 'ttls-lessons-' + group + '.md');
const cands = (repo) => { try { return JSON.parse(fs.readFileSync(path.join(repo, '.vibe', 'lessons', 'candidates.json'), 'utf8')).items || []; } catch (e) { return []; } };

(async () => {
  H.section('人在配置页加一条：直接是规则，不用等次数');
  {
    const t = setup('ttl-add');
    const d = op(t, { action: 'list' });
    H.ok('配置页能选到这个项目（还没有任何规则的也算）', (d.choices || []).some((c) => c.root === t.repo), d.choices);
    const r = op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: '调 OrderMapper.selectByIds 之前先判空列表，空列表会拼出 in ()' });
    const f = ruleFile(path.join(t.repo, '.claude', 'rules'), 'java');
    const text = H.read(f) || '';
    H.ok('写进了项目的规则文件，标着人加的', r.ok === true && /- 调 OrderMapper\.selectByIds 之前先判空列表/.test(text) && /人加=是/.test(text) && /paths:\s*\n\s+- "\*\*\/\*\.java"/.test(text), [r.error, text]);
    H.ok('不进候选（直接生效）', !cands(t.repo).some((c) => /selectByIds/.test(c.text)));
    const u = op(t, { action: 'add', scope: 'user', group: 'sql', text: 'MyBatis 的 foreach 传空列表会拼出 in ()：调用前先判空' });
    H.ok('用户级：写进 ~/.claude/rules/', u.ok === true && /foreach 传空列表/.test(H.read(ruleFile(path.join(t.h.cfg, 'rules'), 'sql')) || ''), u.error);
    const o = op(t, { action: 'add', scope: 'project', root: t.repo, group: 'other', ext: 'yml', text: '改 application-dev.yml 的端口要同时改 nginx 的转发配置' });
    H.ok('别的文件类型（.yml）也能加', o.ok === true && fs.existsSync(ruleFile(path.join(t.repo, '.claude', 'rules'), 'other-yml')), o.error);
    const short = op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: '短' });
    H.ok('太短的不收，说清楚', !!short.error && /8 到/.test(short.error), short);
    const dup = op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: '调 OrderMapper.selectByIds 之前先判空列表，空列表会拼出 in ()' });
    H.ok('一样的不重复加', !!dup.error && /已经有/.test(dup.error), dup);
    const evil = op(t, { action: 'add', scope: 'project', root: path.join(t.h.root, 'nowhere'), group: 'java', text: '随便一个不认识的目录里写规则文件' });
    H.ok('不认识的目录不写', !!evil.error && !fs.existsSync(path.join(t.h.root, 'nowhere', '.claude')), evil);
  }

  H.section('人加的不会被自动收的挤掉；候选可以由人点"升成规则"');
  {
    const t = setup('ttl-keep', { lessonThreshold: 1, lessonMaxPerGroup: 3 });
    op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: '金额一律用 BigDecimal，不用 double 算钱' });
    const L = require(path.join(t.h.kit, 'lib', 'lessons.js'));
    const file = path.join(t.repo, 'src/main/java/com/x/OrderService.java');
    const said = ['分页查询要带排序字段，不然翻页会重复或者漏数据', '日期字段统一用 LocalDateTime，不用 java.util.Date', '调远程接口要设超时，超时时间写在配置文件里', '批量插入超过 500 条要分批，一次插太多会超过包大小限制'];
    said.forEach((s, i) => L.add({ file, text: s, from: 'chg-' + i + ' 1.1', kind: '项目约定', isNew: true, cwd: t.repo }));
    const text = H.read(ruleFile(path.join(t.repo, '.claude', 'rules'), 'java')) || '';
    H.ok('这一组满了（3 条），挤掉的是自动记的，人加的还在', /BigDecimal/.test(text) && (text.match(/^- /gm) || []).length === 3, text);
    const more = ['接口返回的错误码要写进接口文档，别只写在代码注释里', '定时任务要记开始和结束日志，出问题才查得到'].map((s) => op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: s }));
    const full = op(t, { action: 'add', scope: 'project', root: t.repo, group: 'java', text: '事务方法里不要调用远程接口，超时会把连接占满' });
    H.ok('人加的到了上限（3 条）：不再收，说清楚，文件不超', more.every((m) => m.ok) && /到上限/.test(full.error || '') && !/事务方法/.test(H.read(ruleFile(path.join(t.repo, '.claude', 'rules'), 'java')) || ''), [full, more.map((m) => m.error)]);
    const t2 = setup('ttl-promote');
    const L2 = require(path.join(t2.h.kit, 'lib', 'lessons.js'));
    const c = L2.add({ file: path.join(t2.repo, 'src/main/java/com/x/OrderService.java'), text: '查询条件里的状态码用常量类，不写魔法数字', from: 'chg-a 1.1', kind: '项目约定', isNew: true, cwd: t2.repo });
    H.ok('先是候选', c.status === 'candidate', c);
    const p = op(t2, { action: 'promote-candidate', root: t2.repo, id: c.id });
    const text2 = H.read(ruleFile(path.join(t2.repo, '.claude', 'rules'), 'java')) || '';
    H.ok('人点了"升成规则"：进了规则文件、候选里没了', p.ok === true && /状态码用常量类/.test(text2) && /人加=是/.test(text2) && !cands(t2.repo).some((x) => x.id === c.id && x.state === 'candidate'), [p.error, text2]);
  }

  H.section('命令失败 → 改了文件 → 同一条命令再跑通过：记一条候选，不直接成规则');
  {
    const t = setup('ttl-fix');
    const src = path.join(t.repo, 'src/main/java/com/x/OrderService.java');
    const mavenErr = 'Exit code 1\n[ERROR] COMPILATION ERROR : \n[ERROR] /' + src.replace(/\\/g, '/') + ':[6,15] 找不到符号\n  符号:   方法 selectByIds(java.util.List<java.lang.Long>)\n  位置: 类型为com.x.OrderMapper的变量 mapper\n[INFO] 1 error\n';
    const base = (sid) => ({ session_id: sid, cwd: t.repo, transcript_path: '' });
    const fail = (sid, cmd) => H.hook(t.h, 'after-tool', Object.assign(base(sid), { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: cmd || 'mvn -q -o compile' }, error: mavenErr }));
    const edit = (sid, f) => H.hook(t.h, 'after-tool', Object.assign(base(sid), { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: f || path.join(t.repo, 'src/main/java/com/x/OrderMapper.java'), old_string: 'a', new_string: 'b' }, tool_response: { filePath: f } }));
    const pass = (sid, cmd) => H.hook(t.h, 'after-tool', Object.assign(base(sid), { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd || 'mvn -q -o compile' }, tool_response: { stdout: '', stderr: '', interrupted: false } }));
    H.write(path.join(t.repo, 'src/main/java/com/x/OrderMapper.java'), 'package com.x;\ninterface OrderMapper { void selectByIds(java.util.List<Long> ids); }\n');
    fail('sess-f1'); edit('sess-f1'); pass('sess-f1');
    const c1 = cands(t.repo).filter((c) => c.origin === 'fix');
    H.ok('记了一条候选：哪个命令、报什么、改了哪个文件', c1.length === 1 && /Maven 报“找不到符号/.test(c1[0].text) && /OrderMapper\.java/.test(c1[0].text) && c1[0].text.length <= 120, c1);
    H.ok('只是候选，没有生成规则文件', !fs.existsSync(ruleFile(path.join(t.repo, '.claude', 'rules'), 'java')));
    H.ok('候选里没有绝对路径、行号', c1.length === 1 && !/[A-Za-z]:[\\/]|\/Users\/|:\[6,15\]/.test(c1[0].text), c1);
    // 另一个会话踩了同一个坑：到了门槛（默认 2 次）变成项目规则
    fail('sess-f2'); edit('sess-f2'); pass('sess-f2');
    const rule = H.read(ruleFile(path.join(t.repo, '.claude', 'rules'), 'java')) || '';
    H.ok('别的会话又踩了同一个坑：照候选的规矩升成项目规则', /Maven 报“找不到符号/.test(rule), [rule, cands(t.repo)]);
    // 没改文件就过了、换了命令过的：不记
    const before = cands(t.repo).length;
    fail('sess-f3', 'npm run build'); pass('sess-f3', 'npm run build');
    fail('sess-f4', 'mvn -q -o test-compile'); edit('sess-f4'); pass('sess-f4', 'mvn -q -o compile');
    H.ok('没改文件就过了、换了命令过的：不记', cands(t.repo).length === before, cands(t.repo));
  }

  H.section('开关关着不记：经验规则关了、自动收关了');
  {
    for (const cfg of [{ lessons: 'off' }, { lessonAuto: false }]) {
      const t = setup('ttl-off', cfg);
      const src = path.join(t.repo, 'src/main/java/com/x/OrderService.java');
      const err = 'Exit code 1\n[ERROR] /' + src.replace(/\\/g, '/') + ':[6,15] 找不到符号\n';
      const b = { session_id: 'sess-o', cwd: t.repo, transcript_path: '' };
      H.hook(t.h, 'after-tool', Object.assign({}, b, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'mvn -q -o compile' }, error: err }));
      H.hook(t.h, 'after-tool', Object.assign({}, b, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: src, old_string: 'a', new_string: 'b' }, tool_response: {} }));
      H.hook(t.h, 'after-tool', Object.assign({}, b, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'mvn -q -o compile' }, tool_response: { stdout: '', stderr: '' } }));
      H.ok('开关 ' + JSON.stringify(cfg) + '：不记', cands(t.repo).length === 0, cands(t.repo));
    }
  }

  H.done('团队的坑：人加经验规则、失败后改好自动成候选');
})().catch((e) => { H.ok('测试脚本出错', false, e.stack); H.done('团队的坑：人加经验规则、失败后改好自动成候选'); });

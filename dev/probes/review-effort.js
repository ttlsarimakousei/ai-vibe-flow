'use strict';
/*
 * 内网网关认不认 effort（第 64、71 条，2026-11-05）。内网报告：审查的等模型时间几乎全是思考（相关系数 0.98，135 token/秒）。
 * 代理文件写 effort 时 Claude Code 确实发 output_config.effort（dev/probes/cc-reviewer-opts.js 实测），网关和后面的模型照不照做，只能在内网试。
 * 结果（两台电脑，2.1.263、2.1.316，各配置 2 次）：几种配置的输出 token 没有一致的高低。"关掉思考"这一项只是请求里不带 thinking 字段，不等于明确发 disabled（实测 2.1.289 发不出 disabled）。
 * 这是单个文件，拷到内网电脑上直接跑，不用装套件。同一段代码按几种配置各审几次，看输出 token、用时和找到的问题。
 * 会发真请求：默认 5 种配置各 2 次，一共 10 个请求，每个输入约 2 千 token，不用工具。不读你的项目，在临时目录里跑，不留会话记录，关掉钩子。
 *
 *   node review-effort.js                        默认用 sonnet 这个模型名
 *   node review-effort.js --model haiku          换一个模型名（看网关把它映射到哪）
 *   node review-effort.js --times 3              每种配置跑几次
 *   node review-effort.js --exe <claude 的路径>  命令行里没有 claude 时用
 */
process.noDeprecation = true; // shell:true 带参数的提示，这里的参数都是写死的
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const MODEL = val('--model', 'sonnet');
const TIMES = Number(val('--times', 2)) || 2;
const EXE = val('--exe', 'claude');

const CODE = `// 导出某部门的订单。需求：只有管理员能导出；不传订单号时返回空结果；金额合计保留两位小数；订单日期按本月第一天到最后一天算。
public class OrderExportService {
    @Autowired private JdbcTemplate jdbc;
    @Autowired private UserService users;

    public List<Map<String, Object>> export(String userId, String dept, List<Long> ids, YearMonth month) {
        User user = users.find(userId);
        String deptName = user.getDept().getName();
        String in = ids.stream().map(String::valueOf).collect(Collectors.joining(","));
        String sql = "select * from orders where dept = '" + dept + "' and id in (" + in + ")"
            + " and order_date >= '" + month.atDay(1) + "' and order_date < '" + month.atEndOfMonth() + "'";
        List<Map<String, Object>> rows = jdbc.queryForList(sql);
        double total = 0;
        for (Map<String, Object> r : rows) total += (Double) r.get("amount");
        Map<String, Object> sum = new HashMap<>();
        sum.put("dept", deptName);
        sum.put("total", total);
        rows.add(sum);
        return rows;
    }

    public void delete(String userId, Long id) {
        if (!users.isAdmin(userId)) throw new SecurityException("没有权限");
        jdbc.update("delete from orders where id = ?", id);
    }
}
`;
const PROMPT = '审查下面这段代码，找出会在什么情况下出错。只看这段，不要调工具。最后只回一个 JSON：{"issues":[{"severity":"P1或P2或P3","problem":"一句话","evidence":"具体输入和错误结果"}]}。\n\n```java\n' + CODE + '```\n';
// 埋的问题，靠关键词粗算找到几个
const PLANTED = [['没判断空列表', /空列表|列表.*空|ids.*(空|null|empty)|in \(\)/i], ['SQL 注入', /注入|injection/i], ['user 或 dept 空指针', /(user|getDept|部门|用户).{0,20}(null|空指针|NPE|不存在)|(空指针|NullPointer).{0,20}(user|dept|部门|用户)/i], ['导出没判断管理员', /(export|导出).{0,30}(权限|管理员|isAdmin)|(权限|管理员|isAdmin).{0,30}(export|导出)/i], ['月末最后一天漏了', /最后一天|月末|atEndOfMonth|< *'|小于/i], ['double 算金额或类型转换', /double|精度|BigDecimal|类型转换|ClassCast/i]];

const CASES = [
  ['默认（不设 effort）', {}],
  ['effort=low', { CLAUDE_CODE_EFFORT_LEVEL: 'low' }],
  ['effort=medium', { CLAUDE_CODE_EFFORT_LEVEL: 'medium' }],
  ['effort=high', { CLAUDE_CODE_EFFORT_LEVEL: 'high' }],
  ['关掉思考', { CLAUDE_CODE_DISABLE_THINKING: '1' }],
];

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-effort-'));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
  const rows = [];
  try {
    for (const [name, env] of CASES) {
      for (let i = 1; i <= TIMES; i++) {
        const t0 = Date.now();
        const r = spawnSync(EXE, ['-p', '--output-format', 'json', '--model', MODEL, '--settings', settings, '--no-session-persistence', '--disallowedTools', 'Bash,Read,Grep,Glob,Edit,Write,Agent,Task'], { input: PROMPT, cwd: dir, env: Object.assign({}, process.env, env), encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
        const secs = Math.round((Date.now() - t0) / 1000);
        let j = null;
        try { j = JSON.parse(String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()); } catch (e) { /* 下面报 */ }
        if (!j) { rows.push({ name, i, secs, bad: String(r.stderr || r.stdout || r.error || '').slice(0, 120).replace(/\s+/g, ' ') }); console.log(name + ' 第 ' + i + ' 次：没拿到结果 ' + rows[rows.length - 1].bad); continue; }
        const text = String(j.result || '');
        const u = j.usage || {};
        const issues = (text.match(/"severity"/g) || []).length;
        const hits = PLANTED.filter(([, re]) => re.test(text)).map(([n]) => n);
        const models = Object.keys(j.modelUsage || {}).join('、');
        rows.push({ name, i, secs, api: Math.round((j.duration_api_ms || 0) / 1000), out: u.output_tokens || 0, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), chars: text.length, issues, hits, models });
        console.log(name + ' 第 ' + i + ' 次：' + secs + ' 秒，输出 ' + (u.output_tokens || 0) + ' token，报 ' + issues + ' 条，命中 ' + hits.length + '/' + PLANTED.length);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const good = rows.filter((x) => !x.bad);
  const out = ['# effort 对比', '', '模型名 ' + MODEL + '；Claude Code 记的模型：' + ([...new Set(good.map((x) => x.models))].join('；') || '未知') + '。回复字数和输出 token 差得越多，思考占得越多。', '', '| 配置 | 次 | 用时秒 | 输出 token | 回复字数 | 报几条 | 命中埋的问题 |', '|---|---|---|---|---|---|---|'];
  for (const x of rows) out.push(x.bad ? '| ' + x.name + ' | ' + x.i + ' | ' + x.secs + ' | 没拿到结果：' + x.bad + ' |  |  |  |' : '| ' + x.name + ' | ' + x.i + ' | ' + x.secs + ' | ' + x.out + ' | ' + x.chars + ' | ' + x.issues + ' | ' + x.hits.length + '/' + PLANTED.length + '（' + x.hits.join('、') + '） |');
  const file = path.resolve('review-effort-result.md');
  fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
  console.log('\n' + out.join('\n') + '\n\n报告：' + file);
}
main();

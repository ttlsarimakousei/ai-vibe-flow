'use strict';
/*
 * ttls-redis：客户端对着假 redis（dev/lib/fake-redis.js）走一遍。
 *   连接信息按连接名从配置里取，口令不上命令行；七个子命令；找配置（往上、往下、以前的位置）；
 *   全自动模式下不改数据；集群、加密连接说"不支持"；用量只记工具的事
 * 用法：node dev/test-redis.js [端口，默认 18761]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/harness');

const PORT = Number(process.argv[2]) || 18761;
const SECRET = 'r3dis-秘密-口令';

(async () => {
  const watch = await H.watchWindows('redis-win');
  const h = H.makeHome('redis');
  const TOOL = path.join(h.cfg, 'skills', 'ttls-redis', 'scripts', 'redis.js');
  const proj = H.makeRepo(path.join(h.work, 'shell', 'backend'), { 'pom.xml': '<project/>\n', '.gitignore': '.vibe/\n' });
  const servers = [];
  const start = async (port, pw, extra) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'lib', 'fake-redis.js'), String(port)].concat(pw ? [pw] : [], extra || []), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(c);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    for (let i = 0; i < 50 && !/READY/.test(out); i++) await H.sleep(100);
    return /READY/.test(out);
  };
  H.ok('假 redis 起来了（一个带口令，一个不带）', await start(PORT, SECRET) && await start(PORT + 1, ''));

  const cfgFile = path.join(proj, '.vibe', 'redis.json');
  const conf = (conns) => H.write(cfgFile, JSON.stringify({ connections: conns }, null, 2));
  conf({ dev: { host: '127.0.0.1', port: PORT, password: SECRET, db: 0, source: 'application-dev.yml:12' } });
  const rd = (args, opts) => { const r = H.node(h, TOOL, args, Object.assign({ cwd: proj }, opts || {})); let j = null; try { j = JSON.parse(r.out.trim().split(/\r?\n/).pop()); } catch (e) { j = null; } return Object.assign(r, { j }); };
  const usage = () => (H.read(path.join(h.kit, 'state', 'tool-usage.jsonl')) || '').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

  H.section('七个子命令');
  const ping = rd(['ping']);
  H.ok('ping：只有一个连接时不用写 --conn；口令是从配置里取的', ping.code === 0 && ping.j && ping.j.ok && ping.j.data === 'PONG', ping.out + ping.err);
  H.ok('get 字符串（中文）', rd(['get', 'str:1']).j.data === '你好');
  const hash = rd(['--conn', 'dev', 'get', 'hash:1']).j;
  H.ok('get 哈希', hash.ok && hash.data.a === '1' && hash.data['名字'] === '张三', hash);
  H.ok('get 列表、集合', JSON.stringify(rd(['get', 'list:1']).j.data) === '["x","y"]' && JSON.stringify(rd(['get', 'set:1']).j.data) === '["m"]');
  const z = rd(['get', 'zset:1']).j;
  H.ok('get 有序集合', z.ok && z.data.length === 2 && z.data[1].member === 'two' && z.data[1].score === 2, z);
  const none = rd(['get', 'nothing']).j;
  H.ok('key 不存在：明说不存在，和空串分得清', none.ok && none.data === null && none.exists === false, none);
  const stream = rd(['get', 'stream:1']).j;
  H.ok('stream 类型：说不支持', !stream.ok && stream.code === 'UNSUPPORTED_TYPE', stream);
  const keys = rd(['keys', 'many:1*']).j;
  H.ok('keys：游标遍历', keys.ok && keys.data.includes('many:1') && keys.data.includes('many:199') && keys.data.length === 111 && keys.truncated === false, keys);
  H.ok('ttl', rd(['ttl', 'str:1']).j.data === -1);
  const set = rd(['set', 'k:新的', '值 带空格 和"引号"']);
  H.ok('set、再读回来（中文、空格、引号）', set.j.ok && rd(['get', 'k:新的']).j.data === '值 带空格 和"引号"', set.out);
  const del = rd(['del', 'k:新的', 'nothing']).j;
  H.ok('del：返回删了几个', del.ok && del.deleted === 1, del);
  H.ok('info', /redis_version/.test(rd(['info']).j.data));

  H.section('连接信息按名字取，口令不上命令行');
  const old = rd([JSON.stringify({ host: '127.0.0.1', port: PORT, password: SECRET }), 'ping']);
  H.ok('把连接信息放在命令行上：不收，说清改法', old.code === 1 && old.j && old.j.code === 'BAD_ARGS' && /不从命令行传/.test(old.j.error) && /--conn/.test(old.j.error), old.out);
  const conns = rd(['conns']).j;
  H.ok('conns：列连接，不带口令', conns.ok && conns.data[0].name === 'dev' && conns.data[0].password === '有' && !JSON.stringify(conns).includes(SECRET) && conns.data[0].source === 'application-dev.yml:12', conns);
  conf({ dev: { host: '127.0.0.1', port: PORT, password: '${ENV:VK_TEST_REDIS_PW}', db: 0 }, nopw: { host: '127.0.0.1', port: PORT + 1 }, db3: { host: '127.0.0.1', port: PORT + 1, db: 3 }, wrong: { host: '127.0.0.1', port: PORT, password: 'x' }, down: { host: '127.0.0.1', port: PORT + 7 }, cl: { host: '10.0.0.1', port: 7000, mode: 'cluster' }, tls: { host: '10.0.0.1', port: 6380, tls: true } });
  const two = rd(['ping']).j;
  H.ok('有好几个连接、没写 --conn：让指定，列出名字', !two.ok && two.code === 'NO_CONN' && /dev、nopw/.test(two.error), two);
  H.ok('口令写成环境变量', rd(['--conn', 'dev', 'ping'], { env: { VK_TEST_REDIS_PW: SECRET } }).j.ok);
  const noenv = rd(['--conn', 'dev', 'ping']).j;
  H.ok('环境变量没有值：说清是哪个变量', !noenv.ok && /VK_TEST_REDIS_PW/.test(noenv.error), noenv);
  H.ok('不带口令的连接', rd(['--conn', 'nopw', 'get', 'str:1']).j.data === '你好');
  H.ok('换库', rd(['--conn', 'db3', 'get', 'only:db3']).j.data === '3' && rd(['--conn', 'nopw', 'get', 'only:db3']).j.exists === false);
  const wrong = rd(['--conn', 'wrong', 'ping']).j;
  H.ok('口令不对', !wrong.ok && wrong.code === 'AUTH_FAILED', wrong);
  const down = rd(['--conn', 'down', 'ping']).j;
  H.ok('连不上', !down.ok && down.code === 'CONN_REFUSED', down);
  const cl = rd(['--conn', 'cl', 'ping']).j;
  H.ok('集群模式：说不支持，不去连', !cl.ok && cl.code === 'UNSUPPORTED_MODE' && /集群/.test(cl.error), cl);
  H.ok('加密连接：说不支持', rd(['--conn', 'tls', 'ping']).j.code === 'UNSUPPORTED_MODE');
  H.ok('没有这个连接名', rd(['--conn', 'zzz', 'ping']).j.code === 'NO_CONN');

  H.section('参数：选项写在哪都认，多出来的、不认识的不收');
  H.ok('--conn 写在子命令后面也认', rd(['get', 'str:1', '--conn', 'nopw']).j.data === '你好' && rd(['get', '--conn=nopw', 'str:1']).j.data === '你好');
  rd(['--conn', 'nopw', 'set', 'keep:1', 'v']);
  const dd = rd(['del', 'keep:1', '--force', '--conn', 'nopw']);
  H.ok('del 后面跟了不认识的 -- 参数：不收，什么都没删（以前会把它当成 key）', dd.code === 1 && dd.j.code === 'BAD_ARGS' && /不认识的参数 --force/.test(dd.j.error) && rd(['--conn', 'nopw', 'get', 'keep:1']).j.data === 'v', dd.out);
  const sx = rd(['--conn', 'nopw', 'set', 'keep:1', 'hello', 'world']);
  H.ok('set 的值里有空格没加引号：不收，说清多出来的是什么（以前只写进前一半，还说成功）', sx.code === 1 && sx.j.code === 'BAD_ARGS' && /多出来 1 个参数（world）/.test(sx.j.error) && /--value-file/.test(sx.j.error) && rd(['--conn', 'nopw', 'get', 'keep:1']).j.data === 'v', sx.out);
  H.ok('get 给了两个 key：不收', rd(['--conn', 'nopw', 'get', 'a', 'b']).j.code === 'BAD_ARGS');
  const vf = path.join(proj, '.vibe', 'tmp', 'v.json');
  H.write(vf, '{"a": 1, "路径": "/api/list", "引号": "\\"x\\""}\n');
  const sv = rd(['--conn', 'nopw', 'set', 'cfg:1', '--value-file', vf]);
  H.ok('值从文件里读：引号、斜杠原样写进去，末尾的换行不算', sv.j.ok && rd(['--conn', 'nopw', 'get', 'cfg:1']).j.data === '{"a": 1, "路径": "/api/list", "引号": "\\"x\\""}', sv.out);
  H.ok('返回里带着写进去的值，能对一眼', sv.j.written === '{"a": 1, "路径": "/api/list", "引号": "\\"x\\""}' && sv.j.existed === false, sv.j);
  const si = rd(['--conn', 'nopw', 'set', 'cfg:2', '--value-stdin'], { input: '从标准输入来的 /a/b\n' });
  H.ok('值从标准输入读', si.j.ok && rd(['--conn', 'nopw', 'get', 'cfg:2']).j.data === '从标准输入来的 /a/b', si.out);
  H.ok('值给了两处：不收', rd(['--conn', 'nopw', 'set', 'cfg:2', 'x', '--value-file', vf]).j.code === 'BAD_ARGS');
  rd(['--conn', 'nopw', 'del', 'keep:1', 'cfg:1', 'cfg:2']);

  H.section('写：原来的过期时间留着；认证、切库不成就不写');
  const st = rd(['--conn', 'nopw', 'set', 'ttl:1', '新的值']);
  const left = rd(['--conn', 'nopw', 'ttl', 'ttl:1']).j.data;
  H.ok('set 一个会过期的 key：过期时间还在（以前变成永久的）', st.j.ok && st.j.existed === true && st.j.kept_ttl_ms > 60000 && left > 60 && left <= 1800 && rd(['--conn', 'nopw', 'get', 'ttl:1']).j.data === '新的值', [st.j, left]);
  H.ok('set 一个不过期的 key：还是不过期', rd(['--conn', 'nopw', 'set', 'plain:1', 'a']).j.kept_ttl_ms === undefined && rd(['--conn', 'nopw', 'ttl', 'plain:1']).j.data === -1);
  conf({ nopw: { host: '127.0.0.1', port: PORT + 1 }, db16: { host: '127.0.0.1', port: PORT + 1, db: 16 }, pwset: { host: '127.0.0.1', port: PORT + 1, password: 'x' } });
  const w16 = rd(['--conn', 'db16', 'set', 'wrong:db', '1']);
  H.ok('库号不存在：报切不到库，没有写进 0 号库（以前照样写了）', !w16.j.ok && w16.j.code === 'REDIS_ERROR' && /切不到 16 号库/.test(w16.j.error) && rd(['--conn', 'nopw', 'get', 'wrong:db']).j.exists === false, w16.out);
  const wpw = rd(['--conn', 'pwset', 'del', 'plain:1']);
  H.ok('服务器没设口令、配置里写了口令：报出来，没有删（以前照样删了）', !wpw.j.ok && wpw.j.code === 'AUTH_FAILED' && /没有设口令/.test(wpw.j.error) && rd(['--conn', 'nopw', 'get', 'plain:1']).j.data === 'a', wpw.out);
  rd(['--conn', 'nopw', 'del', 'plain:1']);

  H.section('大的值、二进制的 key');
  const bl = rd(['--conn', 'nopw', 'get', 'big:list']).j;
  H.ok('1200 个元素的列表：取前 500 个，说清一共多少、怎么多取', bl.ok && bl.data.length === 500 && bl.truncated === true && bl.total === 1200 && /--limit/.test(bl.note), Object.assign({}, bl, { data: '…' }));
  const bl2 = rd(['--conn', 'nopw', 'get', 'big:list', '--limit', '2000']).j;
  H.ok('--limit 放宽：取全了', bl2.ok && bl2.data.length === 1200 && !bl2.truncated && bl2.data[1199] === 'e1199', Object.assign({}, bl2, { data: '…' }));
  const bs = rd(['--conn', 'nopw', 'get', 'big:str']).j;
  H.ok('10 万字节的字符串：取前 64K，说清一共多大', bs.ok && bs.data.length === 65536 && bs.truncated === true && bs.size === 100000 && /--full/.test(bs.note), Object.assign({}, bs, { data: '…' }));
  H.ok('--full：取全', rd(['--conn', 'nopw', 'get', 'big:str', '--full']).j.data.length === 100000);
  const bk = rd(['--conn', 'nopw', 'keys', '*key']).j;
  const hex = 'hex:aced00057400036b6579';
  H.ok('二进制的 key：列出来是十六进制，说了怎么用', bk.ok && bk.data.includes(hex) && bk.binary === true && /hex:/.test(bk.note), bk);
  const bg = rd(['--conn', 'nopw', 'get', hex]).j;
  H.ok('拿十六进制的 key 去 get：读得到（以前列得出来、读不到）', bg.ok && bg.exists !== false && bg.data === 'hex:aced0005fffe' && bg.binary === true, bg);
  H.ok('ttl 也认', rd(['--conn', 'nopw', 'ttl', hex]).j.data === -1);

  H.section('keys：库很大的时候看不完，要说清楚');
  H.ok('第三个假 redis 起来了（3 万个 key，每轮遍历慢 500 毫秒）', await start(PORT + 2, '', ['--many', '30000', '--slow-scan', '500']));
  conf({ nopw: { host: '127.0.0.1', port: PORT + 1 }, huge: { host: '127.0.0.1', port: PORT + 2 } });
  const hk = rd(['--conn', 'huge', 'keys', 'bulk:2999*'], { timeout: 30000 });
  H.ok('到时间就收尾：说没看完，一共多少个、看了大约多少个', hk.j && hk.j.ok && hk.j.truncated === true && hk.j.total_keys > 30000 && hk.j.scanned_about >= 3000 && hk.j.scanned_about < hk.j.total_keys && /没看完/.test(hk.j.note) && /不等于没有/.test(hk.j.note), hk.out);
  H.ok('在一个连接里一轮看 1000 个（以前一轮 100 个、最多 10 轮，只看得到 1000 个）', hk.j.scanned >= 3 && hk.j.scanned <= 10, hk.j);
  const lk = rd(['--conn', 'nopw', 'keys', 'many:*', '--limit', '5']).j;
  H.ok('--limit：个数到了就停，也说没看完', lk.ok && lk.data.length === 5 && lk.truncated === true && /个数到了上限/.test(lk.note), lk);
  const fk = rd(['--conn', 'nopw', 'keys', 'many:1*']).j;
  H.ok('看完了的：不说没看完', fk.ok && fk.truncated === false && fk.note === undefined && fk.data.length === 111, fk);
  conf({ dev: { host: '127.0.0.1', port: PORT, password: '${ENV:VK_TEST_REDIS_PW}', db: 0 }, nopw: { host: '127.0.0.1', port: PORT + 1 }, db3: { host: '127.0.0.1', port: PORT + 1, db: 3 } });

  H.section('找配置');
  const outer = path.join(h.work, 'outer');
  H.write(path.join(outer, '.vibe', 'redis.json'), JSON.stringify({ connections: { other: { host: '127.0.0.1', port: PORT + 1 } } }));
  const inner = H.makeRepo(path.join(outer, 'inner'), { 'a.txt': 'x\n' });
  const io = rd(['ping'], { cwd: inner }).j;
  H.ok('当前目录自己是仓库根、自己没有配置：不往上用别的项目的', !io.ok && io.code === 'NO_CONFIG', io);
  fs.mkdirSync(path.join(inner, 'sub'), { recursive: true });
  H.ok('在它的子目录里也一样：到仓库根为止', rd(['ping'], { cwd: path.join(inner, 'sub') }).j.code === 'NO_CONFIG');
  const up = rd(['--conn', 'nopw', 'ping'], { cwd: path.join(proj, 'src') });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  H.ok('在子目录里：往上找到', rd(['--conn', 'nopw', 'ping'], { cwd: path.join(proj, 'src') }).j.ok, up.out);
  H.ok('在壳子上：往下找到', rd(['--conn', 'nopw', 'ping'], { cwd: path.join(h.work, 'shell') }).j.ok);
  const other = H.makeRepo(path.join(h.work, 'shell', 'other'), { 'pom.xml': '<project/>\n' });
  H.write(path.join(other, '.vibe', 'redis.json'), JSON.stringify({ connections: { x: { host: '127.0.0.1', port: PORT + 1 } } }));
  const many = rd(['ping'], { cwd: path.join(h.work, 'shell') }).j;
  H.ok('往下找到两份：不猜，让用 --project 指定', !many.ok && many.code === 'NO_CONFIG' && /--project/.test(many.error), many);
  H.ok('--project 指定', rd(['--project', other, 'ping'], { cwd: path.join(h.work, 'shell') }).j.ok);
  const legacy = H.makeRepo(path.join(h.work, 'legacy'), { 'a.txt': 'x\n' });
  H.write(path.join(legacy, '.claude', 'project.local.json'), JSON.stringify({ redis: { host: '127.0.0.1', port: PORT, password: SECRET, db: 0 } }));
  H.ok('以前的位置（.claude/project.local.json）照样认', rd(['get', 'str:1'], { cwd: legacy }).j.data === '你好');
  const empty = H.makeRepo(path.join(h.work, 'empty'), { 'a.txt': 'x\n' });
  const nc = rd(['ping'], { cwd: empty }).j;
  H.ok('没有配置：说清缺什么、写在哪', !nc.ok && nc.code === 'NO_CONFIG' && /\.vibe[\\/]+redis\.json/.test(nc.error), nc);

  H.section('全自动模式（用户不在）：不改数据');
  conf({ dev: { host: '127.0.0.1', port: PORT + 1 } });
  H.setConfig(h, { autoMode: true });
  const s2 = rd(['set', 'str:1', '改了']);
  H.ok('set 被拦下，退出码 3，说了怎么办', s2.code === 3 && s2.j.code === 'BLOCKED' && /留给用户/.test(s2.j.error), s2.out);
  H.ok('del 被拦下', rd(['del', 'str:1']).code === 3);
  H.ok('读照常，数据没变', rd(['get', 'str:1']).j.data === '你好');
  H.setConfig(h, { autoMode: false });
  H.ok('关了全自动：能写', rd(['set', 'tmp:1', '1']).j.ok && rd(['del', 'tmp:1']).j.deleted === 1);

  H.section('用量：只记工具的事');
  const all = H.read(path.join(h.kit, 'state', 'tool-usage.jsonl')) || '';
  H.ok('记了命令、耗时、错误的类别', usage().some((u) => u.tool === 'ttls-redis' && u.cmd === 'get' && u.ms >= 0 && u.exit === 0) && usage().some((u) => (u.errors || []).includes('AUTH_FAILED')), usage().slice(0, 3));
  H.ok('没有 key、值、地址、口令', !all.includes(SECRET) && !/你好|张三|str:1|127\.0\.0\.1/.test(all), all.slice(0, 500));

  H.section('钩子：跑技能自带的脚本放行，改套件的东西照拦');
  // 技能装在 ~/.claude/skills 里，属于"不许改的套件的东西"；跑它自带的脚本是正常用法（2026-09-30 之前会被一起拦掉）
  const tf = H.transcript(path.join(h.root, 'guard.jsonl'), [H.tr.user('查一下缓存')]);
  const guard = (tool, command) => H.reasonOf(H.hook(h, 'guard-commit', { session_id: 'g1', transcript_path: tf, cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }));
  const abs = (rel) => path.join(h.cfg, rel).replace(/\\/g, '/');
  const DB = '"$HOME/.claude/skills/ttls-db-crud/scripts/db.py"';
  const RD = '"$HOME/.claude/skills/ttls-redis/scripts/redis.js"';
  const pass = [
    ['Bash', 'node ' + RD + ' get user:1'],
    ['Bash', 'node ~/.claude/skills/ttls-redis/scripts/redis.js --conn dev scan "user:*"'],
    ['Bash', 'node ' + RD + ' get user:1 | jq .'],
    ['Bash', 'python ' + DB + ' describe dev --table t_user'],
    ['Bash', 'python3 ~/.claude/skills/ttls-db-crud/scripts/db.py peek dev --table t_user'],
    ['Bash', 'py -3 "' + abs('skills/ttls-db-crud/scripts/db.py') + '" query dev --sql "select 1"'],
    ['Bash', 'python -X utf8 ' + DB + ' doctor'],
    ['Bash', 'PYTHONIOENCODING=utf-8 python ' + DB + ' query dev --sql "select 1" | python -m json.tool'],
    ['PowerShell', 'python "$env:USERPROFILE\\.claude\\skills\\ttls-db-crud\\scripts\\db.py" describe dev --table t_user'],
    ['PowerShell', 'node "$env:USERPROFILE\\.claude\\skills\\ttls-redis\\scripts\\redis.js" get user:1'],
    ['Bash', 'node "$HOME/.claude/vibe-kit/tools/drivers.js" list'],
    ['Bash', 'node "$HOME/.claude/vibe-kit/tools/onboard.js" status'],
    ['Bash', 'cat ~/.claude/skills/ttls-redis/SKILL.md'],
  ];
  for (const [tool, cmd] of pass) { const r = guard(tool, cmd); H.ok('放行：' + cmd.slice(0, 70), !r, r); }
  // cd 进技能目录再跑脚本：不算改套件，但 cd 和别的命令串在一条里 Claude Code 会停下来要人确认，所以拦下、让它把脚本路径写全
  {
    const r = guard('Bash', 'cd "$HOME/.claude/skills/ttls-db-crud/scripts" && python db.py doctor');
    H.ok('cd 进技能目录再跑脚本：只说别串 cd，给出脚本的完整路径', /^\[vibe-kit\] 这条命令先 cd 到/.test(r) && /skills\/ttls-db-crud\/scripts\/db\.py"/.test(r) && !/vibe-kit 套件/.test(r), r);
  }
  const stop = [
    ['Bash', 'rm -rf ~/.claude/skills/ttls-db-crud'],
    ['Bash', 'cp x.py ~/.claude/skills/ttls-db-crud/scripts/db.py'],
    ['Bash', 'python ' + DB + ' doctor > ~/.claude/skills/ttls-db-crud/SKILL.md'],
    ['Bash', 'node ' + RD + ' get k | tee "$HOME/.claude/CLAUDE.md"'],
    ['Bash', 'python ' + DB + ' --config "$HOME/.claude/vibe-kit/config.json" doctor'],
    ['Bash', 'node ~/.claude/skills/ttls-redis/scripts/../../../vibe-kit/hooks/pre-edit.js'],
    ['Bash', 'python "$HOME/.claude/skills/ttls-db-crud/scripts/runner/x.py"'],
    ['Bash', 'java -cp "$HOME/.claude/skills/ttls-db-crud/scripts/runner" DbRunner ping'],
    ['Bash', 'python -c "open(\'' + abs('skills/ttls-db-crud/scripts/db.py') + '\',\'w\').write(\'x\')"'],
    ['Bash', 'python3 -c "import os; open(os.path.expanduser(\'~/.claude/vibe-kit/config.json\'),\'w\').write(\'x\')"'],
    ['Bash', 'node -e "require(\'fs\').writeFileSync(process.env.HOME + \'/.claude/vibe-kit/config.json\', \'{}\')"'],
    ['PowerShell', 'python -c "import shutil; shutil.rmtree(\'' + abs('skills/ttls-redis') + '\')"'],
  ];
  for (const [tool, cmd] of stop) { const r = guard(tool, cmd); H.ok('照拦：' + cmd.replace(h.root.replace(/\\/g, '/'), '…').slice(0, 70), /\[vibe-kit\]/.test(r), r); }
  H.ok('代码里不提套件的照常放行（node -e、python -c）', !guard('Bash', 'node -e "console.log(require(\'./package.json\').version)"') && !guard('Bash', 'python -c "print(open(\'src/a.txt\').read())"'));

  for (const c of servers) { try { c.kill(); } catch (e) { /* 已经退了 */ } }
  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('ttls-redis');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

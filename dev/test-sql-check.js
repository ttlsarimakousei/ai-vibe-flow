'use strict';
/*
 * K3 M10（2026-11-01，docs/feedback-20261101.md）：改了 *.sql、MyBatis Mapper XML，拿查库技能存的表结构缓存核对表名、列名。
 *   对不上的提醒一句（after-tool 的 additionalContext），不拦；同一个文件同样的问题一个会话只说一次
 *   Mapper：<include refid> 的 <sql> 片段代进去、<where>/<set>、#{…}、&gt; 都认；别名.列、INSERT 的列、UPDATE 的 SET、单表 WHERE 都查
 *   .sql 脚本：脚本自己 CREATE、ALTER ADD 的表和列算有的
 *   没有缓存、缓存太旧、缓存里没有这张表（也没有像的）：不提；只读缓存，不读连接配置
 * 用法：node dev/test-sql-check.js [旧版的 vibe-kit 目录]（给了就拿旧版跑，看哪些项不过）
 */
const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const h = H.makeHome('tsq', FROM);
const proj = path.join(h.work, 'proj');
const now = Date.now() / 1000;
const table = (name, cols, at) => ({ asked: name, found: true, schema: 'public', table: name, variant: 'same', columns: { columns: [{ name: 'COLUMN_NAME' }, { name: 'TYPE_NAME' }], rows: cols.map((c) => [c, 'varchar']) }, primary_keys: ['id'], at: at || now - 3 * 3600 });
const cache = (dir, tables) => H.write(path.join(dir, '.vibe', 'db-crud.cache.json'), JSON.stringify({ version: 1, tables: Object.fromEntries(tables.map((t) => ['dev|public|' + t.table, t])) }));
cache(proj, [table('t_order', ['id', 'order_no', 'amount', 'status', 'create_time', 'user_id', 'pay_time']), table('t_user', ['id', 'user_name'])]);
// 连接配置里的口令：这个检查不读它
H.write(path.join(proj, '.vibe', 'db-crud.ini'), '[dev]\nurl=jdbc:h2:mem:x\nuser=sa\npassword=Sup3r-Secret-9\n');
const mapper = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
  '<mapper namespace="com.x.OrderMapper">',
  '  <sql id="Base_Column_List">id, order_no, amout, status</sql>',
  '  <select id="list" resultType="map">',
  '    select <include refid="Base_Column_List"/> from t_order',
  '    <where>',
  '      <if test="status != null">and stauts = #{status}</if>',
  '      and create_time &gt;= #{from}',
  '    </where>',
  '  </select>',
  '  <select id="withUser" resultType="map">',
  '    select o.id, o.amount, u.user_nam from t_order o left join t_user u on u.id = o.user_id',
  '  </select>',
  '  <insert id="add">insert into t_order (id, order_no, amont) values (#{id}, #{orderNo}, #{amount})</insert>',
  '  <update id="pay">update t_order <set>status = #{s}, pay_tim = now(),</set> where id = #{id}</update>',
  '  <select id="typo">select * from t_ordr where id = #{id}</select>',
  '  <select id="other">select foo from t_unknown_table where bar = 1</select>',
  '  <select id="cdata"><![CDATA[ select id from t_order where amount < 10 and create_time >= #{t} ]]></select>',
  '</mapper>',
  ''].join('\n');
const mapperFile = path.join(proj, 'src', 'main', 'resources', 'mapper', 'OrderMapper.xml');
H.write(mapperFile, mapper);
const wrote = (file, sid, tool) => H.hook(h, 'after-tool', { session_id: sid || 'sess-tsq', cwd: proj, hook_event_name: 'PostToolUse', tool_name: tool || 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { filePath: file } });
const ctx = (o) => String((o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext) || '');

(async () => {
  H.section('Mapper XML 里表名、列名写错了：提醒，不拦');
  const o = wrote(mapperFile);
  const c = ctx(o);
  H.ok('出了提醒，不是拦截', /\[vibe-kit 表结构\] OrderMapper\.xml 里有 \d+ 处和查库技能存的表结构对不上/.test(c) && !(o && (o.decision || (o.hookSpecificOutput && o.hookSpecificOutput.permissionDecision))), o);
  H.ok('<include> 的 <sql> 片段：amout（第 4 行，最像 amount）', /第 4 行：表 t_order 没有列 amout（最像的是 amount）/.test(c), c);
  H.ok('<where> 里的 stauts（第 8 行）', /第 8 行：表 t_order 没有列 stauts（最像的是 status）/.test(c), c);
  H.ok('别名.列：u.user_nam（最像 user_name）', /第 13 行：表 t_user 没有列 user_nam（最像的是 user_name）/.test(c), c);
  H.ok('INSERT 的列：amont', /第 15 行：表 t_order 没有列 amont（最像的是 amount）/.test(c), c);
  H.ok('UPDATE 的 <set>：pay_tim（最像 pay_time）', /第 16 行：表 t_order 没有列 pay_tim（最像的是 pay_time）/.test(c), c);
  H.ok('表名写错了：t_ordr，有 t_order', /第 17 行：缓存里没有表 t_ordr，有 t_order：是不是写错了/.test(c), c);
  H.ok('缓存里没有、也没有像的表（t_unknown_table）：不提', !/t_unknown_table|foo|bar/.test(c), c);
  H.ok('写对了的不误报（id、order_no、status、create_time、o.amount、u.id、o.user_id、CDATA 里的 amount）', !/没有列 (id|order_no|status|create_time|amount|user_id|user_name)\b/.test(c), c);
  H.ok('一共 6 处', /里有 6 处/.test(c), c);
  H.ok('不带连接配置里的口令', !/Sup3r-Secret-9/.test(JSON.stringify(o)), o);
  const again = wrote(mapperFile);
  H.ok('同一个文件同样的问题：这个会话不再说', again === null, again);
  const other = wrote(mapperFile, 'sess-tsq-2', 'Edit');
  H.ok('换一个会话照样说（Edit 也认）', /OrderMapper\.xml 里有 6 处/.test(ctx(other)), other);

  H.section('.sql 脚本：脚本自己建的表、加的列算有的');
  {
    const f = path.join(proj, 'db', 'V2__order_remark.sql');
    H.write(f, ['ALTER TABLE t_order ADD COLUMN remark varchar(200);', "UPDATE t_order SET remark = 'x', remak = 'y' WHERE id = 1;", 'CREATE TABLE t_log (id int, msg varchar(10));', "INSERT INTO t_log (id, mesage) VALUES (1, 'a');", "insert into t_log (id, msg) values (2, 'b');", ''].join('\n'));
    const s = ctx(wrote(f));
    H.ok('新加的 remark 不报，写错的 remak 报（最像 remark）', /第 2 行：表 t_order 没有列 remak（最像的是 remark）/.test(s) && !/没有列 remark\b/.test(s), s);
    H.ok('脚本自己建的 t_log：写错的 mesage 报，msg 不报', /第 4 行：表 t_log 没有列 mesage/.test(s) && !/没有列 msg\b/.test(s), s);
  }

  H.section('没有缓存、缓存太旧、不是 Mapper 的 XML：不提');
  {
    const p2 = path.join(h.work, 'nocache');
    const f2 = path.join(p2, 'OrderMapper.xml');
    H.write(f2, mapper);
    H.ok('项目里没有表结构缓存：不提', wrote(f2) === null);
    const p3 = path.join(h.work, 'old');
    cache(p3, [table('t_order', ['id'], now - 40 * 86400)]);
    const f3 = path.join(p3, 'OrderMapper.xml');
    H.write(f3, mapper);
    H.ok('缓存是 40 天前存的：不提', wrote(f3) === null);
    const f4 = path.join(proj, 'pom.xml');
    H.write(f4, '<project><select>select nope from t_order</select></project>\n');
    H.ok('不是 Mapper 的 XML（pom.xml）：不提', wrote(f4) === null);
  }

  H.done('SQL、Mapper 和表结构对一下');
})().catch((e) => { H.ok('测试脚本出错', false, e.stack); H.done('SQL、Mapper 和表结构对一下'); });

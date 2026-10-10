'use strict';
/*
 * 后台自动探索（kit/lib/onboard.js、kit/lib/discover.js）：
 *   认工程、推命令、查编码；只把开发环境的数据库和 redis 连接配进去；钩子甩后台进程、马上返回；
 *   探索好了告诉模型（只说一次）；依据的文件改了跟着改，模型和人改过的行不动
 * 用法：node dev/test-onboard.js [auto，或者运行环境的目录（有 python 的话顺带验 db.py 读得了生成的配置）]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/harness');

const PY = process.argv[2] ? H.runtime(process.argv[2]).python : '';
const REAL_DRIVERS = path.join(os.homedir(), '.claude', 'skills', 'urai-db-crud', 'drivers');
const DM_JAR = fs.existsSync(path.join(REAL_DRIVERS, 'dm-jdbc-driver-18.jar')) ? path.join(REAL_DRIVERS, 'dm-jdbc-driver-18.jar') : '';
const SECRET = 'Dev#口令-9527';
const PROD_SECRET = 'Prod-绝密-0001';

(async () => {
  const watch = await H.watchWindows('onboard-win');
  const h = H.makeHome('onboard');
  const D = require(path.join(h.kit, 'lib', 'discover.js'));
  const O = require(path.join(h.kit, 'lib', 'onboard.js'));
  const live = { VIBE_KIT_NO_ONBOARD: undefined };
  const readJson = (f) => { try { return JSON.parse(H.read(f)); } catch (e) { return null; } };
  const waitFor = async (fn, ms) => { for (let i = 0; i < (ms || 15000) / 200; i++) { if (fn()) return true; await H.sleep(200); } return !!fn(); };

  // ---------------------------------------------------------------------------------------------
  H.section('分环境');
  H.ok('文件名', D.envOfFile('src/main/resources/application-dev.yml') === 'dev' && D.envOfFile('application-prod.properties') === 'prod' && D.envOfFile('application-test.yml') === 'test' && D.envOfFile('application.yml') === 'base' && D.envOfFile('application-local.yml') === 'dev' && D.envOfFile('application-uat.yml') === 'test');
  H.ok('按功能分的文件不算环境', D.envOfFile('application-druid.yml') === 'other' && D.envOfFile('application-dev-druid.yml') === 'dev' && D.envOfFile('application-druid-prod.yml') === 'prod');
  H.ok('目录名', D.envOfFile('config/prod/jdbc.properties') === 'prod' && D.envOfFile('env/dev/db.properties') === 'dev' && D.envOfFile('src/main/resources/jdbc.properties') === 'base');
  H.ok('product 里的 prod 不算', D.envInText('product-service') === '' && D.envInText('order_prod') === 'prod' && D.envInText('生产库') === 'prod');
  const docs = D.yamlDocEnvs(['spring:', '  profiles: dev', 'a: 1', '---', 'spring:', '  config:', '    activate:', '      on-profile: prod', 'b: 2', '---', 'c: 3']);
  H.ok('一个 YAML 里分几份文档', docs[2] === 'dev' && docs[8] === 'prod' && docs[10] === '', docs);
  H.ok('占位符：有默认值的按默认值展开', D.expand('jdbc:mysql://${DB_HOST:127.0.0.1}:${DB_PORT:3306}/app').text === 'jdbc:mysql://127.0.0.1:3306/app' && !D.expand('${A:b}').unresolved && D.expand('jdbc:mysql://${DB_HOST}/app').unresolved && D.expand('@db.url@').unresolved);
  H.ok('加密的口令认得出来', D.isEncrypted('ENC(abcd==)') && D.isEncrypted('{cipher}xxx') && !D.isEncrypted('plain'));

  // ---------------------------------------------------------------------------------------------
  H.section('扫配置');
  const scanDir = H.tempDir('onboard-scan');
  const w = (rel, text) => H.write(path.join(scanDir, rel), text);
  w('pom.xml', '<project/>\n');
  w('src/main/resources/application.yml', ['spring:', '  profiles:', '    active: dev', '  datasource:', '    dynamic:', '      datasource:', '        master:', '          url: jdbc:mysql://${DB_HOST:10.0.0.5}:3306/app_dev?useSSL=false', '          username: app', '          password: "p#1 x"   # 带井号和空格', '        report_prod:', '          url: jdbc:mysql://10.9.9.9:3306/report', '          username: rpt', '          password: ' + PROD_SECRET, '  redis:', '    host: 10.0.0.6', '    port: 6380', '    password: ' + SECRET, '    database: 2', ''].join('\n'));
  w('src/main/resources/application-prod.yml', ['spring:', '  datasource:', '    url: jdbc:dm://10.8.8.8:5236', '    username: SYSDBA', '    password: ' + PROD_SECRET, '  redis:', '    host: 10.8.8.9', '    password: ' + PROD_SECRET, ''].join('\n'));
  w('src/main/resources/application-multi.yml', ['spring:', '  profiles: dev', '  datasource:', '    url: jdbc:oracle:thin:@10.0.0.7:1521:ORCL', '    username: devuser', '    password: ENC(q1w2e3)', '---', 'spring:', '  profiles: prod', '  datasource:', '    url: jdbc:oracle:thin:@10.7.7.7:1521:PRD', '    username: produser', '    password: ' + PROD_SECRET, ''].join('\n'));
  w('src/main/resources/jdbc.properties', ['# jdbc.url=jdbc:dm://1.1.1.1:5236', 'jdbc.username=SYSDBA', 'jdbc.password=' + SECRET, 'jdbc.url=jdbc:dm://10.0.0.8:5236', '', 'redis.host=10.0.0.9', 'redis.port=6379', 'redis.pass=', 'redis.database=0', 'cache.redis.cluster.nodes=10.0.1.1:7000,10.0.1.2:7000', 'cache.redis.host=10.0.1.1', ''].join('\n'));
  w('src/main/webapp/WEB-INF/ds.xml', ['<beans>', '<!-- <property name="url" value="jdbc:kingbase8://2.2.2.2:54321/old"/> -->', '<bean id="ds">', '  <property name="url" value="jdbc:kingbase8://10.0.0.10:54321/app"/>', '  <property name="username" value="SYSTEM"/>', '  <property name="password" value="' + SECRET + '"/>', '</bean>', '<bean id="jedis" class="org.springframework.data.redis.connection.jedis.JedisConnectionFactory">', '  <property name="hostName" value="10.0.0.11"/>', '  <property name="port" value="6381"/>', '  <property name="password" value="' + SECRET + '"/>', '</bean>', '</beans>', ''].join('\n'));
  w('src/main/resources/db.properties', 'db.url=jdbc:mysql://${DB_HOST}:3306/x\ndb.username=u\n');
  const db = D.scanDb(scanDir).found;
  const by = (u) => db.find((x) => x.url.includes(u)) || {};
  H.ok('占位符展开了；引号里带井号、空格的口令取对了', by('10.0.0.5').url === 'jdbc:mysql://10.0.0.5:3306/app_dev?useSSL=false' && by('10.0.0.5').user === 'app' && by('10.0.0.5').password === 'p#1 x' && by('10.0.0.5').devOnly === true && by('10.0.0.5').nameHint === 'master', by('10.0.0.5'));
  H.ok('数据源名字里带生产字样的：不算开发环境，账号没串到别的数据源上', by('10.9.9.9').devOnly === false && by('10.9.9.9').env === 'prod' && by('10.9.9.9').user === 'rpt', by('10.9.9.9'));
  H.ok('生产环境的文件：不算', by('10.8.8.8').devOnly === false && by('10.8.8.8').env === 'prod', by('10.8.8.8'));
  H.ok('一个文件里分环境：各认各的；加密的口令不当口令用', by('10.0.0.7').devOnly === true && by('10.0.0.7').encrypted === true && by('10.0.0.7').password === '' && by('10.7.7.7').devOnly === false && by('10.7.7.7').user === 'produser', [by('10.0.0.7'), by('10.7.7.7')]);
  H.ok('properties：账号口令写在连接串前面也找得到；注释掉的旧地址不算', by('10.0.0.8').user === 'SYSDBA' && by('10.0.0.8').password === SECRET && !db.some((x) => x.url.includes('1.1.1.1')), by('10.0.0.8'));
  H.ok('XML：注释掉的不算', by('10.0.0.10').user === 'SYSTEM' && by('10.0.0.10').dialect === 'kingbase' && !db.some((x) => x.url.includes('2.2.2.2')), by('10.0.0.10'));
  H.ok('占位符没有默认值的：标成没展开', by('${DB_HOST}').unresolved === true, by('${DB_HOST}'));
  const rd = D.scanRedis(scanDir).found;
  const rb = (hst) => rd.find((x) => x.host === hst) || {};
  H.ok('redis：YAML 里的', rb('10.0.0.6').port === 6380 && rb('10.0.0.6').password === SECRET && rb('10.0.0.6').db === 2 && rb('10.0.0.6').devOnly === true, rb('10.0.0.6'));
  H.ok('redis：生产环境的不算', rb('10.8.8.9').devOnly === false, rb('10.8.8.9'));
  H.ok('redis：properties 里的；集群的认得出来', rb('10.0.0.9').port === 6379 && rb('10.0.0.9').password === '' && rb('10.0.1.1').mode === 'cluster', [rb('10.0.0.9'), rb('10.0.1.1')]);
  H.ok('redis：XML 里的', rb('10.0.0.11').port === 6381 && rb('10.0.0.11').password === SECRET, rb('10.0.0.11'));

  // ---------------------------------------------------------------------------------------------
  H.section('扫配置：宁可少配，不能配错（全仓审查里列的那些情况）');
  {
    const s2 = H.tempDir('onboard-scan2');
    const w2 = (rel, text) => H.write(path.join(s2, rel), Array.isArray(text) ? text.join('\n') + '\n' : text);
    const ds = (url, user, pw) => ['spring:', '  datasource:', '    url: ' + url, '    username: ' + (user || 'u'), '    password: ' + (pw || 'p')];
    // 目录名
    w2('doc/部署/生产环境/application.yml', ds('jdbc:mysql://10.2.0.1:3306/a'));
    w2('m0/src/main/resources/config-prod/jdbc.properties', 'jdbc.url=jdbc:mysql://10.2.0.2:3306/a\njdbc.username=u\njdbc.password=p\n');
    w2('m0/resources-prod/application.yml', ds('jdbc:mysql://10.2.0.3:3306/a'));
    w2('deploy/application.yml', ds('jdbc:mysql://10.2.0.4:3306/a'));
    w2('online-exam-admin/src/main/resources/application-dev.yml', ds('jdbc:mysql://10.2.0.5:3306/a'));
    // 默认激活的环境
    w2('b1/src/main/resources/application.yml', ['spring:', '  profiles:', '    active: prod'].concat(ds('jdbc:mysql://10.2.1.1:3306/a').slice(1)));
    w2('b2/src/main/resources/application.yml', ['spring:', '  profiles:', '    active: "@profiles.active@"'].concat(ds('jdbc:mysql://10.2.1.2:3306/a').slice(1)));
    w2('b3/src/main/resources/application.yml', 'spring:\n  profiles:\n    active: test\n');
    w2('b3/src/main/resources/application-druid.yml', ds('jdbc:mysql://10.2.1.3:3306/a'));
    // 按现场分的文件、文档里写的环境
    w2('c1/src/main/resources/application-hz.yml', ds('jdbc:mysql://10.2.2.1:3306/a'));
    w2('c1/src/main/resources/application-site.yml', ['spring:', '  profiles: prod-bj'].concat(ds('jdbc:mysql://10.2.2.2:3306/a').slice(1), ['---', 'spring:', '  profiles: [prod]'], ds('jdbc:mysql://10.2.2.3:3306/a').slice(1)));
    // properties 分文档
    w2('d1/src/main/resources/application.properties', ['spring.datasource.url=jdbc:mysql://10.2.3.2:3306/x', 'spring.datasource.username=u', 'spring.datasource.password=p', '#---', 'spring.config.activate.on-profile=prod', 'spring.datasource.url=jdbc:mysql://10.2.3.1:3306/x', 'spring.datasource.username=u2', 'spring.datasource.password=' + PROD_SECRET]);
    // pom.xml 里的
    w2('e1/pom.xml', '<project><profiles><profile><id>prod</id><properties><jdbc.url>jdbc:mysql://10.2.4.1:3306/app</jdbc.url></properties></profile></profiles></project>\n');
    // 地址、库名里的字样
    w2('f1/src/main/resources/application-dev.yml', ['a:'].concat(ds('jdbc:mysql://db-uat.corp:3306/app').slice(1).map((l) => '  ' + l), ['b:'], ds('jdbc:mysql://localhost:3306/test', 'root').slice(1).map((l) => '  ' + l), ['c:'], ds('jdbc:mysql://10.2.5.3:3306/pre_order', 'po').slice(1).map((l) => '  ' + l)));
    // 同一个地址在开发、生产两个文件里都有
    w2('g1/src/main/resources/application-dev.yml', ds('jdbc:mysql://10.2.6.1:3306/a', 'same'));
    w2('g1/src/main/resources/application-prod.yml', ds('jdbc:mysql://10.2.6.1:3306/a', 'same'));
    // 行尾注释里的地址
    w2('h1/src/main/resources/application-dev.yml', ['spring:', '  datasource:', '    url: jdbc:mysql://127.0.0.1:3306/app  # 生产 jdbc:mysql://10.10.1.1:3306/app', '    username: u', '    password: p']);
    // 数据源的名字：properties、写成一行的 YAML、XML、redis
    w2('i1/src/main/resources/application-dev.properties', 'spring.datasource.dynamic.datasource.prod.url=jdbc:mysql://10.2.7.1:3306/app\nspring.datasource.dynamic.datasource.prod.username=u\nprod.redis.host=10.2.7.4\nprod.redis.port=6379\n');
    w2('i2/src/main/resources/application-dev.yml', 'spring.datasource.prod.url: jdbc:mysql://10.2.7.2:3306/app\nspring.datasource.prod.username: u\n');
    w2('i3/src/main/webapp/WEB-INF/ds.xml', '<beans>\n<bean id="prodDataSource">\n  <property name="url" value="jdbc:mysql://10.2.7.3:3306/app"/>\n  <property name="username" value="u"/>\n</bean>\n</beans>\n');
    // 连接串下面紧跟着别的服务的口令
    w2('j1/src/main/resources/application-dev.yml', ['spring:', '  datasource:', '    username: u1', '    password:', '    url: jdbc:mysql://10.2.8.1:3306/app', '  redis:', '    host: 10.2.8.2', '    password: redispwd', '  rabbitmq:', '    password: mqpwd']);
    w2('j2/src/main/resources/application-dev.yml', ['spring:', '  datasource:', '    username: up', '    password: uppw', '    druid:', '      url: jdbc:mysql://10.2.8.3:3306/app']);
    // 连接串的各种写法
    w2('k1/src/main/resources/application-dev.yml', ['a:', '  url: ${DB_URL:jdbc:mysql://localhost:3306/app?useSSL=false}', '  username: u', 'b:', '  url: jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=10.2.9.1)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))', '  username: u', 'c:', '  url: jdbc:mysql://10.2.9.2:3306,10.2.9.3:3306/app', '  username: u', 'd:', '  url: jdbc:dm://GRP?GRP=(10.2.9.4:5236,10.2.9.5:5236)', '  username: u']);
    // 口令里的特殊字符；XML 里的 &amp;；properties 里转义的冒号
    w2('l1/src/main/resources/jdbc.properties', 'jdbc.url=jdbc\\:mysql\\://10.2.10.2\\:3306/app\njdbc.username=u\njdbc.password=Dm#2023,x;y\n');
    w2('l2/src/main/resources/application-dev.yml', ds('jdbc:mysql://10.2.10.3:3306/app', 'u', 'Root#123'));
    w2('l3/src/main/webapp/WEB-INF/ds.xml', '<beans>\n<bean id="ds">\n  <property name="url" value="jdbc:mysql://10.2.10.1:3306/app?useUnicode=true&amp;characterEncoding=UTF-8&amp;allowPublicKeyRetrieval=true"/>\n  <property name="username" value="u"/>\n  <property name="password" value="a&amp;b"/>\n</bean>\n</beans>\n');
    // 前面有几百个 mapper：启动模块的配置照样要读到
    for (let i = 0; i < 450; i++) H.write(path.join(s2, 'a-dao/src/main/resources/mapper/T' + i + 'Mapper.xml'), '<mapper namespace="x"/>\n');
    for (let i = 0; i < 450; i++) H.write(path.join(s2, 'a-dao/src/main/resources/xml/t' + i + '.xml'), '<x/>\n');
    w2('z-web/src/main/resources/application-dev.yml', ds('jdbc:mysql://10.2.11.1:3306/app'));
    const r2 = D.scanDb(s2);
    const at = (ip) => r2.found.find((x) => x.url.includes(ip)) || {};
    const no = (ip, re) => at(ip).url && at(ip).devOnly === false && (!re || re.test(at(ip).why));
    H.ok('目录名里带环境字样的（生产环境/、config-prod/、resources-prod/）：不算', no('10.2.0.1', /生产/) && no('10.2.0.2', /生产/) && no('10.2.0.3', /生产/), [at('10.2.0.1'), at('10.2.0.2'), at('10.2.0.3')]);
    H.ok('部署用的目录（deploy/）里的：拿不准，不算', no('10.2.0.4', /看不出/), at('10.2.0.4'));
    H.ok('模块的名字里有 online：不当成环境', at('10.2.0.5').devOnly === true, at('10.2.0.5'));
    H.ok('公共配置，默认激活的是生产、测试环境：不算；按功能分的文件跟着算', no('10.2.1.1', /默认激活的是 prod/) && no('10.2.1.3', /默认激活的是 test/), [at('10.2.1.1'), at('10.2.1.3')]);
    H.ok('激活写的是占位符（打包时才定）：照公共配置算', at('10.2.1.2').devOnly === true, at('10.2.1.2'));
    H.ok('按现场分的文件（application-hz.yml）：拿不准，不算', no('10.2.2.1', /看不出/), at('10.2.2.1'));
    H.ok('文档里写 prod-bj、[prod]：认得', no('10.2.2.2', /生产/) && no('10.2.2.3', /生产/), [at('10.2.2.2'), at('10.2.2.3')]);
    H.ok('properties 用 #--- 分文档：各认各的', at('10.2.3.2').devOnly === true && at('10.2.3.2').user === 'u' && no('10.2.3.1', /生产/) && at('10.2.3.1').user === 'u2', [at('10.2.3.2'), at('10.2.3.1')]);
    H.ok('pom.xml 里的连接串不当连接', !at('10.2.4.1').url, at('10.2.4.1'));
    H.ok('地址里有 uat：不算；连本机的、库名里的 pre 不受影响', no('db-uat', /测试/) && at('localhost:3306/test').devOnly === true && at('localhost:3306/test').user === 'root' && at('10.2.5.3').devOnly === true && at('10.2.5.3').user === 'po', [at('db-uat'), at('localhost:3306/test'), at('10.2.5.3')]);
    H.ok('同一个地址在生产的文件里也有：整个不算', no('10.2.6.1', /生产/) && r2.found.filter((x) => x.url.includes('10.2.6.1')).length === 1, r2.found.filter((x) => x.url.includes('10.2.6.1')));
    H.ok('行尾注释里的地址不当连接', at('127.0.0.1:3306/app').url === 'jdbc:mysql://127.0.0.1:3306/app' && !at('10.10.1.1').url, [at('127.0.0.1:3306/app'), at('10.10.1.1')]);
    H.ok('数据源叫 prod 的：properties、写成一行的 YAML、XML（驼峰）都认', no('10.2.7.1', /生产/) && no('10.2.7.2', /生产/) && no('10.2.7.3', /生产/), [at('10.2.7.1'), at('10.2.7.2'), at('10.2.7.3')]);
    H.ok('库的口令空着：不到下面的 redis、消息队列那里去拿', at('10.2.8.1').user === 'u1' && at('10.2.8.1').password === '', at('10.2.8.1'));
    H.ok('账号写在上一层（datasource 下面）、连接串在 druid 里：找得到', at('10.2.8.3').user === 'up' && at('10.2.8.3').password === 'uppw', at('10.2.8.3'));
    H.ok('占位符的默认值是整条连接串：末尾不多一个 }', at('localhost:3306/app?').url === 'jdbc:mysql://localhost:3306/app?useSSL=false', at('localhost:3306/app?'));
    H.ok('TNS、多主机、达梦集群的写法：不截成半截', /SERVICE_NAME=orcl\)\)\)$/.test(at('10.2.9.1').url || '') && at('10.2.9.2').url === 'jdbc:mysql://10.2.9.2:3306,10.2.9.3:3306/app' && at('10.2.9.4').url === 'jdbc:dm://GRP?GRP=(10.2.9.4:5236,10.2.9.5:5236)', [at('10.2.9.1'), at('10.2.9.2'), at('10.2.9.4')]);
    H.ok('口令里有 # , ;：不截断', at('10.2.10.2').password === 'Dm#2023,x;y' && at('10.2.10.3').password === 'Root#123', [at('10.2.10.2'), at('10.2.10.3')]);
    H.ok('properties 里转义的冒号还原了', at('10.2.10.2').url === 'jdbc:mysql://10.2.10.2:3306/app', at('10.2.10.2'));
    H.ok('XML 里的 &amp; 还原了，参数没丢', at('10.2.10.1').url === 'jdbc:mysql://10.2.10.1:3306/app?useUnicode=true&characterEncoding=UTF-8&allowPublicKeyRetrieval=true' && at('10.2.10.1').password === 'a&b', at('10.2.10.1'));
    H.ok('前面有九百个 XML：排在后面的启动模块的配置照样读到', at('10.2.11.1').devOnly === true, [at('10.2.11.1'), r2.scanned]);
    const rr = D.scanRedis(s2).found;
    H.ok('redis：这一块的名字里带生产字样的不算', (rr.find((x) => x.host === '10.2.7.4') || {}).devOnly === false, rr.filter((x) => x.host === '10.2.7.4'));
    H.ok('redis：口令各拿各的', (rr.find((x) => x.host === '10.2.8.2') || {}).password === 'redispwd', rr.filter((x) => x.host === '10.2.8.2'));
    H.ok('连接串里带的账号口令：给人看的时候遮掉', D.maskUrl('jdbc:oracle:thin:scott/tiger@127.0.0.1:1521:orcl') === 'jdbc:oracle:thin:scott/***@127.0.0.1:1521:orcl' && D.maskUrl('jdbc:mysql://root:123456@localhost:3306/app') === 'jdbc:mysql://root:***@localhost:3306/app' && D.maskUrl('jdbc:mysql://h:3306/a?user=u&password=xyz&useSSL=false') === 'jdbc:mysql://h:3306/a?user=u&password=***&useSSL=false' && D.maskUrl('jdbc:dm://10.0.0.1:5236') === 'jdbc:dm://10.0.0.1:5236');
    H.ok('jdbc:postgresql 的连接：写法按金仓，驱动要 PostgreSQL 的', D.dialectOf('jdbc:postgresql://h:5432/a') === 'kingbase' && D.driverKeyOf('jdbc:postgresql://h:5432/a') === 'postgresql' && D.driverKeyOf('jdbc:kingbase8://h:54321/a') === 'kingbase');
  }

  // ---------------------------------------------------------------------------------------------
  H.section('哪些目录不探索');
  H.ok('用户目录、盘符根、套件目录', O.targetsOf(h.home).length === 0 && O.targetsOf(path.parse(h.home).root).length === 0 && O.targetsOf(h.kit).length === 0 && O.targetsOf(h.cfg).length === 0);
  const junk = H.tempDir('onboard-junk');
  H.write(path.join(junk, 'a.txt'), 'x');
  H.ok('不是项目也不是仓库的目录', O.targetsOf(junk).length === 0);

  // ---------------------------------------------------------------------------------------------
  H.section('壳子里的两个子项目：钩子甩后台进程，马上返回');
  const shell = H.makeRepo(path.join(h.work, 'shell'), { 'CLAUDE.md': '# 壳子\n', 'openspec/project.md': 'x\n' });
  const pomRoot = ['<project>', '  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>', '  <artifactId>app</artifactId>', '  <packaging>pom</packaging>', '  <properties><java.version>1.8</java.version></properties>', '  <modules><module>app-common</module><module>app-admin</module></modules>', '  <!-- <modules><module>old</module></modules> -->', '</project>', ''].join('\n');
  const devYml = (dbHost, port) => ['server:', '  port: ' + port, '  servlet:', '    context-path: /admin', 'spring:', '  datasource:', '    url: jdbc:dm://' + dbHost + ':5236', '    username: SYSDBA', '    password: ' + SECRET, '  redis:', '    host: 10.0.0.6', '    port: 6379', '    password: ' + SECRET, '    database: 1', ''].join('\n');
  const back = H.makeRepo(path.join(shell, 'backend'), {
    'pom.xml': pomRoot,
    'app-common/pom.xml': '<project><parent><artifactId>app</artifactId></parent><artifactId>app-common</artifactId></project>\n',
    'app-admin/pom.xml': '<project><parent><artifactId>app</artifactId></parent><artifactId>app-admin</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>\n',
    'app-admin/src/main/resources/application.yml': 'spring:\n  profiles:\n    active: dev\n',
    'app-admin/src/main/resources/application-dev.yml': devYml('10.0.0.5', 8081),
    'app-admin/src/main/resources/application-prod.yml': ['spring:', '  datasource:', '    url: jdbc:dm://10.8.8.8:5236', '    username: SYSDBA', '    password: ' + PROD_SECRET, '  redis:', '    host: 10.8.8.9', '    password: ' + PROD_SECRET, ''].join('\n'),
    'app-admin/src/main/java/com/x/A.java': 'package com.x;\n// 中文注释\nclass A {}\n',
  });
  fs.mkdirSync(path.join(back, 'app-admin/src/main/java/com/x/old'), { recursive: true });
  fs.writeFileSync(path.join(back, 'app-admin/src/main/java/com/x/old/Gbk.java'), Buffer.concat([Buffer.from('package com.x.old;\n// '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('\nclass Gbk {}\n')]));
  const front = H.makeRepo(path.join(shell, 'frontend'), {
    'package.json': JSON.stringify({ name: 'app-front', scripts: { dev: 'vite', build: 'vite build', 'type-check': 'vue-tsc --noEmit' }, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0', typescript: '^5.0.0' } }),
    'vite.config.ts': "export default { server: { port: 5180, proxy: { '/api': { target: 'http://localhost:8081' } } } }\n",
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
    'src/App.vue': '<template><div>你好</div></template>\n',
  });
  // 本机环境：配了 JDK 8、一套 Maven（仓库里放着达梦的驱动）
  const repo = H.tempDir('onboard-m2');
  if (DM_JAR) { fs.mkdirSync(path.join(repo, 'com/dameng/DmJdbcDriver18/8.1.1.134'), { recursive: true }); fs.copyFileSync(DM_JAR, path.join(repo, 'com/dameng/DmJdbcDriver18/8.1.1.134/DmJdbcDriver18-8.1.1.134.jar')); }
  H.write(path.join(h.kit, 'local.json'), JSON.stringify({ jdks: [{ name: '8', path: 'C:/jdk8' }, { name: '17', path: 'C:/jdk17' }], defaultJdk: '17', mavens: [{ name: '内网', repo }] }));

  const tfile = H.transcript(path.join(h.work, 't.jsonl'), [H.tr.user('开始')]);
  const hookIn = (event, extra) => Object.assign({ session_id: 's-ob', cwd: shell, hook_event_name: event, transcript_path: tfile }, extra || {});
  const runHook = (name, input) => { const t0 = Date.now(); const r = H.node(h, path.join(h.kit, 'hooks', name + '.js'), [], { input: JSON.stringify(input), cwd: shell, env: live }); let j = null; try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; } return { ms: Date.now() - t0, j, text: H.reasonOf(j) || r.out, err: r.err }; };
  const s1 = runHook('session-start', hookIn('SessionStart', { source: 'startup' }));
  H.ok('会话开始的钩子马上返回', s1.ms < 4000, s1.ms);
  const recB = path.join(back, '.vibe', 'onboard.json');
  const recF = path.join(front, '.vibe', 'onboard.json');
  H.ok('几秒钟里两个子项目都探索好了', await waitFor(() => fs.existsSync(recB) && fs.existsSync(recF) && !fs.existsSync(path.join(back, '.vibe', 'onboard.lock')) && !fs.existsSync(path.join(front, '.vibe', 'onboard.lock')), 30000), [fs.existsSync(recB), fs.existsSync(recF), H.read(path.join(h.kit, 'state', 'onboard.log'))]);
  H.ok('壳子自己没有被探索（不在壳子里建 .vibe）', !fs.existsSync(path.join(shell, '.vibe', 'onboard.json')) && !fs.existsSync(path.join(shell, '.vibe', 'project.md')));
  const pmB = path.join(back, '.vibe', 'project.md');
  const tb = H.read(pmB) || '';
  H.ok('后端：认出了工程', /- 类型：代码工程。Maven 多模块（2 个模块），Spring Boot 2\.7\.18，Java 8；能跑起来的模块：app-admin/.test(tb), tb);
  H.ok('后端：JDK 用本机环境里对得上的那个', /- 环境：JDK 用"本机环境"里的 8（不是默认的那个/.test(tb), tb);
  H.ok('后端：命令标着没跑过', /- 快检：mvn -q -o compile（没跑过）/.test(tb) && /- 全量：mvn -q -DskipTests compile（没跑过）/.test(tb), tb);
  H.ok('后端：启动命令带模块、端口、上下文路径', /- 启动：mvn spring-boot:run -pl app-admin -am（在根目录执行），端口 8081（application-dev\.yml 里的 server\.port），上下文路径 \/admin/.test(tb), tb);
  H.ok('后端：编码里点了那个 GBK 文件', /- 编码：UTF-8；这 1 个不是 UTF-8[^\n]*old\/Gbk\.java/.test(tb), tb);
  H.ok('后端：数据库、redis 的连接名', /- 数据库：连接 \w+（达梦，jdbc:dm:\/\/10\.0\.0\.5:5236，来自 app-admin\/src\/main\/resources\/application-dev\.yml）。[^\n]*\/ttls-db-crud[^\n]*测试、生产环境的连接没有配进来/.test(tb) && /- redis：连接 dev（10\.0\.0\.6:6379，库 1，/.test(tb), tb);
  H.ok('后端：坑里有"当前环境是 dev"', /- 坑：[^\n]*当前环境是 dev/.test(tb), tb);
  H.ok('项目说明里没有口令', !tb.includes(SECRET) && !tb.includes(PROD_SECRET), tb);
  H.ok('项目说明里没有"产出位置"（那是用户定的，脚本不替他定）', !/产出位置/.test(tb.replace(/> [^\n]*/g, '')), tb);
  const ini = H.read(path.join(back, '.vibe', 'db-crud.ini')) || '';
  H.ok('数据库配置：只有开发环境的那一个，带来源', (ini.match(/^\[/gm) || []).length === 1 && /dialect = dm\njdbc = jdbc:dm:\/\/10\.0\.0\.5:5236\nuser = SYSDBA\npassword = Dev#口令-9527\nsource = app-admin\/src\/main\/resources\/application-dev\.yml:7/.test(ini) && !ini.includes('10.8.8.8') && !ini.includes(PROD_SECRET), ini);
  const rj = readJson(path.join(back, '.vibe', 'redis.json')) || {};
  H.ok('redis 配置：只有开发环境的那一个', Object.keys(rj.connections || {}).length === 1 && rj.connections.dev.host === '10.0.0.6' && rj.connections.dev.db === 1 && rj.connections.dev.password === SECRET && rj.connections.dev.auto === true && !JSON.stringify(rj).includes(PROD_SECRET), rj);
  H.ok('.vibe 进了 .gitignore', /^\.vibe\/$/m.test(H.read(path.join(back, '.gitignore')) || '') && /^\.vibe\/$/m.test(H.read(path.join(front, '.gitignore')) || ''));
  const tf = H.read(path.join(front, '.vibe', 'project.md')) || '';
  H.ok('前端：认出了框架、命令、端口、代理', /- 类型：前端。Vue 3 \+ Vite/.test(tf) && /- 全量：npm run build（没跑过）/.test(tf) && /- 类型检查：npm run type-check/.test(tf) && /- 启动：npm run dev，端口 5180（vite\.config\.ts），接口代理到 http:\/\/localhost:8081/.test(tf), tf);
  H.ok('前端：坑里有 node_modules 不在、tsconfig 的写法', /node_modules 不在/.test(tf) && /tsconfig\.app\.json/.test(tf), tf);
  if (DM_JAR) {
    const reg = (readJson(path.join(h.kit, 'drivers.json')) || {}).drivers || {};
    H.ok('用到的数据库还没有驱动：到本机环境配的 Maven 仓库里找到并登记了', reg.dm && reg.dm.from === 'maven' && fs.existsSync(reg.dm.jar) && reg.dm.version === '8.1.1.134', reg);
  }
  const log = H.read(path.join(h.kit, 'state', 'onboard.log')) || '';
  H.ok('探索的流水账里没有口令', /探索 .*backend/.test(log) && !log.includes(SECRET) && !log.includes(PROD_SECRET), log);

  H.section('探索写的文件不算 .vibe 里的杂物');
  {
    // 审查 4-1：连接配置、探索的记录不在整理的白名单里时，会话开始会催着把它们挪进 .vibe/tmp，7 天后被删
    const T = require(path.join(h.kit, 'lib', 'tidy.js'));
    // 查库用过之后还会多出探测缓存、表结构缓存；老用户手里还有以前名字的配置
    for (const n of ['db-crud.env.json', 'db-crud.cache.json', 'urai-db-crud.ini', 'urai-db-crud.env.json']) H.write(path.join(back, '.vibe', n), '{}\n');
    H.ok('连接配置、探索记录、缓存都不算杂物', T.clutter(back).length === 0 && T.clutter(front).length === 0, [T.clutter(back), T.clutter(front)]);
    H.write(path.join(back, '.vibe', 'q1.js'), '//\n'); H.write(path.join(back, '.vibe', 'q2.js'), '//\n'); H.write(path.join(back, '.vibe', 'q3.sql'), '--\n');
    const st = runHook('session-start', Object.assign(hookIn('SessionStart', { source: 'startup' }), { session_id: 's-tidy' })).text;
    H.ok('真的杂物照样提醒，名单里没有连接配置', /\.vibe 里有 3 个零散的旧文件/.test(st) && /q1\.js/.test(st) && !/db-crud|redis\.json|onboard\.json/.test((st.match(/\.vibe 里有[^\n]*/) || [''])[0]), st);
    for (const n of ['q1.js', 'q2.js', 'q3.sql', 'urai-db-crud.ini', 'urai-db-crud.env.json', 'db-crud.env.json', 'db-crud.cache.json']) fs.unlinkSync(path.join(back, '.vibe', n));
    const wr = (rel) => H.reasonOf(H.hook(h, 'pre-edit', { session_id: 's-tidy', cwd: front, hook_event_name: 'PreToolUse', tool_name: 'Write', transcript_path: tfile, tool_input: { file_path: path.join(front, rel), content: '[a]\n' } }));
    H.ok('手写连接配置（新建 .vibe/db-crud.ini、.vibe/redis.json）：不拦', !/\.vibe 整理/.test(wr('.vibe/db-crud.ini')) && !/\.vibe 整理/.test(wr('.vibe/redis.json')), [wr('.vibe/db-crud.ini'), wr('.vibe/redis.json')]);
    H.ok('往 .vibe 根下新建别的文件：照拦', /\.vibe 整理/.test(wr('.vibe/x.js')), wr('.vibe/x.js'));
  }

  H.section('探索好了告诉模型，只说一次');
  const p1 = runHook('task-anchor', hookIn('UserPromptSubmit', { prompt: '看一下订单表' }));
  H.ok('用户第一次开口：带上了两份项目说明', /这个项目后台自动探索好了/.test(p1.text) && /Maven 多模块/.test(p1.text) && /Vue 3 \+ Vite/.test(p1.text) && !p1.text.includes(SECRET), p1.text);
  const p2 = runHook('task-anchor', hookIn('UserPromptSubmit', { prompt: '继续' }));
  H.ok('第二次开口：不重复说', !/后台自动探索好了/.test(p2.text), p2.text);
  const s2 = runHook('session-start', Object.assign(hookIn('SessionStart', { source: 'startup' }), { session_id: 's-ob2' }));
  H.ok('新会话开始：项目说明的位置带上了', /backend[\\/]+\.vibe[\\/]+project\.md/.test(s2.text), s2.text);
  const p2b = runHook('task-anchor', Object.assign(hookIn('UserPromptSubmit', { prompt: '看一下' }), { session_id: 's-ob2' }));
  H.ok('新会话第一次开口：以前就探索好的不再整份带一遍（壳子下面有几个子项目就省几份）', !/后台自动探索好了/.test(p2b.text) && !/Maven 多模块/.test(p2b.text), p2b.text);

  H.section('依据的文件改了，跟着改；模型和人改过的不动');
  // 模型第一次用的时候跑通了快检，把"没跑过"去掉了；人加了一行；连接配置里记了一条坑、手加了一个连接
  fs.writeFileSync(pmB, tb.replace('- 快检：mvn -q -o compile（没跑过）', '- 快检：mvn -q -o compile（约 20 秒').replace(/\n$/, '\n- 账号：见 .vibe/login.json\n'));
  const name = (ini.match(/^\[(.+)\]$/m) || [])[1];
  fs.writeFileSync(path.join(back, '.vibe', 'db-crud.ini'), ini + 'notes =\n    2026-09-30 标识符要用大写\n\n[manual]\ndialect = mysql\njdbc = jdbc:mysql://127.0.0.1:3306/mine\nuser = me\npassword = mine-pw\n');
  // 离上一次甩后台进程不到 3 秒的不重复甩（会话开始和第一次开口挨着来），所以等够了再改
  await H.sleep(3300);
  fs.writeFileSync(path.join(back, 'app-admin/src/main/resources/application-dev.yml'), devYml('10.0.0.55', 9090));
  H.ok('看得出该重新探索了', /依据的文件改了：app-admin\/src\/main\/resources\/application-dev\.yml/.test(O.due(back)) && O.due(front) === '', [O.due(back), O.due(front)]);
  const p3 = runHook('task-anchor', hookIn('UserPromptSubmit', { prompt: '接着做' }));
  H.ok('用户开口的钩子马上返回', p3.ms < 4000, p3.ms);
  H.ok('后台重新探索了', await waitFor(() => /10\.0\.0\.55/.test(H.read(path.join(back, '.vibe', 'db-crud.ini')) || '') && !fs.existsSync(path.join(back, '.vibe', 'onboard.lock')), 30000), [p3.text, O.due(back), (H.read(path.join(h.kit, 'state', 'hooks.log')) || '').split('\n').filter((l) => /onboard/.test(l)), H.read(path.join(h.kit, 'state', 'onboard.log'))]);
  const ini2 = H.read(path.join(back, '.vibe', 'db-crud.ini')) || '';
  H.ok('连接还是原来那个名字，地址换了，记的坑还在，手加的连接没动', new RegExp('\\[' + name + '\\]\\ndialect = dm\\njdbc = jdbc:dm://10\\.0\\.0\\.55:5236').test(ini2) && /notes =\n {4}2026-09-30 标识符要用大写/.test(ini2) && /\[manual\]\ndialect = mysql\njdbc = jdbc:mysql:\/\/127\.0\.0\.1:3306\/mine\nuser = me\npassword = mine-pw/.test(ini2) && (ini2.match(/^\[/gm) || []).length === 2, ini2);
  const tb2 = H.read(pmB) || '';
  H.ok('项目说明：端口、数据库那两行更新了', /端口 9090/.test(tb2) && /jdbc:dm:\/\/10\.0\.0\.55:5236/.test(tb2) && !/10\.0\.0\.5:5236/.test(tb2), tb2);
  H.ok('项目说明：模型改过的那一行、人加的那一行没动', /- 快检：mvn -q -o compile（约 20 秒/.test(tb2) && /- 账号：见 \.vibe\/login\.json/.test(tb2), tb2);
  const p4 = runHook('task-anchor', hookIn('UserPromptSubmit', { prompt: '好了吗' }));
  // 开口时会等探索一小会儿（最多一秒半）：等到了这一次就说，没等到下一次说
  const told = [p3.text, p4.text].filter((t) => /项目依据的文件改了，后台重新探索过（backend）/.test(t));
  H.ok('这次开口（等到了）或者下一次开口：告诉模型哪几处变了，只说一次', told.length === 1 && /数据库连接 \w+ 跟着项目的配置更新了/.test(told[0]) && /"启动"那一行更新了/.test(told[0]), [p3.text, p4.text]);
  H.ok('再下一次不重复说', !/重新探索过/.test(runHook('task-anchor', hookIn('UserPromptSubmit', { prompt: '嗯' })).text));

  H.section('开发环境的连接没了；多了新的配置文件');
  fs.writeFileSync(path.join(back, 'app-admin/src/main/resources/application-dev.yml'), 'server:\n  port: 9090\n');
  H.write(path.join(back, 'app-admin/src/main/resources/application-local.yml'), ['spring:', '  datasource:', '    url: jdbc:mysql://127.0.0.1:3306/localdb', '    username: root', '    password: root', ''].join('\n'));
  const r5 = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', shell], { cwd: shell, env: live });
  const ini3 = H.read(path.join(back, '.vibe', 'db-crud.ini')) || '';
  H.ok('手动跑：说了改了什么', r5.code === 0 && /backend/.test(r5.out) && /数据库连接多了 localdb/.test(r5.out), r5.out + r5.err);
  H.ok('开发来源消失后撤回自动连接并保留无口令退役原因', !ini3.includes('[' + name + ']') && fs.existsSync(path.join(back, '.vibe/connections-retired.json')), ini3);
  H.ok('新文件里的连接加进来了', /\[localdb\]\ndialect = mysql\njdbc = jdbc:mysql:\/\/127\.0\.0\.1:3306\/localdb\nuser = root\npassword = root\nsource = app-admin\/src\/main\/resources\/application-local\.yml:3/.test(ini3), ini3);
  const rj3 = readJson(path.join(back, '.vibe', 'redis.json')) || {};
  H.ok('开发 redis 来源消失后撤回自动连接', !rj3.connections || !rj3.connections.dev, rj3);
  H.ok('项目说明里 redis 那一行去掉了', !/- redis：/.test(H.read(pmB) || ''), H.read(pmB));
  const st = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['status', '--dir', shell], { cwd: shell, env: live });
  H.ok('status：两个都探索过，说了有生产环境的连接没配进来', st.code === 0 && (st.out.match(/✓/g) || []).length === 2 && /测试、生产环境的连接没配进来/.test(st.out), st.out + st.err);

  H.section('项目说明是人写的：不动它，只补数据库和 redis');
  const own = H.makeRepo(path.join(h.work, 'own'), { 'pom.xml': '<project><artifactId>own</artifactId></project>\n', 'src/main/resources/application.properties': 'spring.datasource.url=jdbc:mysql://127.0.0.1:3306/own\nspring.datasource.username=root\nspring.datasource.password=' + SECRET + '\n', '.vibe/project.md': '# 项目说明（/onboard 于 2026-09-19 查得）\n\n- 类型：代码工程。Maven 单模块\n- 快检：javac @.vibe/javac.args（约 2 秒）\n- 产出位置（用户定的，代码之外的产出放这里）：\n  - DDL 脚本：sql/ddl/\n' });
  const r6 = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', own], { cwd: own, env: live });
  const to = H.read(path.join(own, '.vibe', 'project.md')) || '';
  H.ok('原来的内容一字没动', r6.code === 0 && to.startsWith('# 项目说明（/onboard 于 2026-09-19 查得）\n\n- 类型：代码工程。Maven 单模块\n- 快检：javac @.vibe/javac.args（约 2 秒）\n- 产出位置（用户定的，代码之外的产出放这里）：\n  - DDL 脚本：sql/ddl/\n'), to);
  H.ok('在最后补了数据库那一行，别的没加', /\n- 数据库：连接 own（MySQL[^\n]*\n$/.test(to) && !/- 全量：/.test(to) && !to.includes(O.MARK), to);
  // 人写的那几行里有和脚本查到的一字不差的（类型：代码工程。Maven 单模块）：再探索几遍也不能被当成"脚本生成的、没人改过"去掉
  H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', own, '--force'], { cwd: own, env: live });
  H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', own, '--force'], { cwd: own, env: live });
  H.ok('再探索两遍：还是一字没动', (H.read(path.join(own, '.vibe', 'project.md')) || '') === to, H.read(path.join(own, '.vibe', 'project.md')));

  H.section('别的工程');
  const kinds = [
    ['技能工程', { 'skills/a/SKILL.md': '---\nname: a\n---\n', 'skills/b/SKILL.md': '---\nname: b\n---\n', 'README.md': 'x\n' }, /- 类型：技能工程。2 个技能[\s\S]*- 启动：不适用\n- 看页面：不适用/],
    ['文档', { 'docs/a.md': '# a\n', 'docs/b.md': '# b\n', 'c.md': '# c\n', 'd.md': '# d\n' }, /- 类型：文档、规范。4 个文档\n- 快检：不适用/],
    ['脚本', { 'a.bat': 'echo 1\r\n', 'b.ps1': 'Write-Host 1\n', 'c.py': 'print(1)\n', 'd.js': 'console.log(1)\n' }, /- 类型：脚本、工具。[\s\S]*- 快检：语法检查：node --check/],
    ['老式 Java Web', { '.classpath': '<classpath/>\n', 'WebRoot/WEB-INF/web.xml': '<web-app/>\n', 'src/A.java': 'class A {}\n' }, /- 类型：代码工程。没有 pom 的老式 Java Web[^\n]*WebRoot[\s\S]*- 启动：在 IDE 里启动/],
    ['Gradle', { 'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n", 'gradlew.bat': '@echo off\r\n', 'src/main/resources/application.properties': 'server.port=7001\n' }, /- 类型：代码工程。Gradle，Spring Boot[\s\S]*- 启动：\.\/gradlew\.bat bootRun，端口 7001/],
  ];
  for (const [label, files, want] of kinds) {
    const dir = H.makeRepo(path.join(h.work, 'k-' + label), files);
    H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', dir, '--quiet'], { cwd: dir, env: live });
    const t = H.read(path.join(dir, '.vibe', 'project.md')) || '';
    H.ok(label, want.test(t) && t.includes(O.MARK), t);
  }
  {
    // 前端在工程的子目录里：命令用 --prefix 指目录。以前写"进到 web 里：npm run build"，模型照着做就是 cd web && npm run build，
    // 这种串着 cd 的命令 Claude Code 会停下来要人确认（内网 0930）
    const dir = H.makeRepo(path.join(h.work, 'k-后端带前端'), { 'pom.xml': '<project><artifactId>x</artifactId></project>\n', 'src/main/java/A.java': 'class A {}\n',
      'web/package.json': JSON.stringify({ name: 'w', scripts: { dev: 'vite', build: 'vite build', 'type-check': 'vue-tsc --noEmit' }, dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' } }), 'web/vite.config.js': 'export default { server: { port: 5199 } }\n' });
    H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', dir, '--quiet'], { cwd: dir, env: live });
    const t = H.read(path.join(dir, '.vibe', 'project.md')) || '';
    H.ok('前端在子目录里：命令用 --prefix，不写"进到 … 里"', /- 前端全量：npm --prefix web run build（没跑过）/.test(t) && /- 前端类型检查：npm --prefix web run type-check/.test(t) && /- 前端启动：npm --prefix web run dev，端口 5199/.test(t) && !/进到/.test(t), t);
  }

  H.section('找驱动：不拖住项目说明；没找到的不反复找');
  // Maven 仓库大、驱动又不在常见位置的时候，找一遍要十几秒：项目说明和记录要先写出来
  const Dv = require(path.join(h.kit, 'lib', 'drivers.js'));
  const my = H.makeRepo(path.join(h.work, 'mysql-proj'), { 'pom.xml': '<project><artifactId>my</artifactId></project>\n', 'src/main/resources/application-dev.properties': 'spring.datasource.url=jdbc:mysql://127.0.0.1:3306/mydev\nspring.datasource.username=root\nspring.datasource.password=' + SECRET + '\n' });
  const myRec = path.join(my, '.vibe', 'onboard.json');
  const myPm = path.join(my, '.vibe', 'project.md');
  const realAuto = Dv.auto;
  const calls = [];
  Dv.auto = (o) => { calls.push({ rec: fs.existsSync(myRec), pm: /- 数据库：连接 mydev/.test(H.read(myPm) || ''), ignored: /^\.vibe\/$/m.test(H.read(path.join(my, '.gitignore')) || ''), only: o.only, quick: o.quick }); return { used: [], kept: [], missing: o.only.slice(), scan: {} }; };
  try {
    O.explore(my, '没探索过');
    H.ok('去找驱动的时候，项目说明和记录已经写出来了，.vibe 也进了 .gitignore', calls.length === 1 && calls[0].rec && calls[0].pm && calls[0].ignored, calls);
    H.ok('只找用到的那一种，常见位置里找到了就不整仓扫', calls.length === 1 && JSON.stringify(calls[0].only) === '["mysql"]' && calls[0].quick === true, calls);
    const r1 = readJson(myRec) || {};
    H.ok('没找到：项目说明的"坑"里说了去哪配', /- 坑：[^\n]*MySQL的数据库驱动还没有：Maven 本地仓库里没找到，在配置页"数据库驱动"里选一个 jar/.test(H.read(myPm) || ''), H.read(myPm));
    H.ok('记录里记着找过、没找到；探索的经过只记一条', JSON.stringify(r1.driverMiss) === '["mysql"]' && r1.driverSearchAt > 0 && (r1.history || []).length === 1 && r1.history[0].changes[0] === '第一次探索', r1);
    O.explore(my, '依据的文件改了：pom.xml');
    const r2 = readJson(myRec) || {};
    H.ok('6 小时内再探索：不重复找，那句提醒还在', calls.length === 1 && r2.driverSearchAt === r1.driverSearchAt && /MySQL的数据库驱动还没有/.test(H.read(myPm) || '') && (r2.history || []).length === 1, [calls.length, r2.driverSearchAt, r1.driverSearchAt, r2.history]);
    O.explore(my, '手动');
    H.ok('手动跑：再找一遍', calls.length === 2, calls.length);
    fs.writeFileSync(myRec, JSON.stringify(Object.assign(readJson(myRec), { driverSearchAt: Date.now() - 7 * 3600000 })));
    O.explore(my, '依据的文件改了：pom.xml');
    H.ok('过了 6 小时：再找一遍', calls.length === 3, calls.length);
  } finally { Dv.auto = realAuto; }
  // 真的扫一遍：常见位置里就有的，不整仓扫
  const big = H.tempDir('onboard-m2big');
  for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(big, 'org', 'lib' + i, 'x', '1.0'), { recursive: true });
  if (DM_JAR) {
    fs.mkdirSync(path.join(big, 'com', 'dameng', 'DmJdbcDriver18', '8.1.1.134'), { recursive: true });
    fs.copyFileSync(DM_JAR, path.join(big, 'com', 'dameng', 'DmJdbcDriver18', '8.1.1.134', 'DmJdbcDriver18-8.1.1.134.jar'));
    const quick = Dv.scan({ dirs: [big], enough: ['dm'] });
    const full = Dv.scan({ dirs: [big] });
    H.ok('常见位置里找到了：看的目录少得多', (quick.found.dm || []).length === 1 && (full.found.dm || []).length === 1 && quick.scanned < 10 && full.scanned > 100, [quick.scanned, full.scanned]);
    H.ok('要的那种常见位置里没有：照样整仓扫', Dv.scan({ dirs: [big], enough: ['mysql'] }).scanned > 100);
  }

  H.section('并进已有的文件：读不出来不覆盖，人补的不冲掉，改过的行不动（全仓审查里列的）');
  {
    const Dv2 = require(path.join(h.kit, 'lib', 'drivers.js'));
    const keepAuto = Dv2.auto;
    Dv2.auto = (o) => ({ used: [], kept: [], missing: (o.only || []).slice(), scan: {} });      // 这一节不测找驱动：不去翻真的 Maven 仓库
    try {
      const mk = (name, files) => H.makeRepo(path.join(h.work, 'merge-' + name), Object.assign({ 'pom.xml': '<project><artifactId>' + name + '</artifactId></project>\n', 'src/main/resources/application.yml': 'spring:\n  profiles:\n    active: dev\n' }, files));
      const yml = (o) => ['server:', '  port: ' + (o.port || 8080), 'spring:', '  datasource:', '    url: ' + o.url].concat(o.user === '' ? [] : ['    username: ' + (o.user || 'app')], ['    password: ' + o.pw], o.redis ? ['  redis:', '    host: 10.3.0.9', '    password: ' + o.redis] : []).join('\n') + '\n';
      const DEV = 'src/main/resources/application-dev.yml';
      const iniOf = (p) => H.read(path.join(p, '.vibe', 'db-crud.ini')) || '';
      const rjOf = (p) => H.read(path.join(p, '.vibe', 'redis.json')) || '';
      const pmOf = (p) => H.read(path.join(p, '.vibe', 'project.md')) || '';
      const setIni = (p, fn) => fs.writeFileSync(path.join(p, '.vibe', 'db-crud.ini'), fn(iniOf(p)));

      // 口令：项目那头没变、人在连接配置里改了 → 不动；项目那头改了 → 跟着改
      const a = mk('a', { [DEV]: yml({ url: 'jdbc:mysql://10.3.0.1:3306/app', pw: 'P1', redis: '${REDIS_PWD}' }) });
      O.explore(a, '没探索过');
      H.ok('第一次：口令照项目里的写', /password = P1\n/.test(iniOf(a)) && JSON.parse(rjOf(a)).connections.dev.password === '', [iniOf(a), rjOf(a)]);
      setIni(a, (t) => t.replace('password = P1', 'password = HUMAN'));
      fs.writeFileSync(path.join(a, '.vibe', 'redis.json'), rjOf(a).replace('"password": ""', '"password": "rpw"'));
      O.explore(a, '手动');
      H.ok('项目那头没变、人在连接配置里改了口令：不改回去', /password = HUMAN\n/.test(iniOf(a)), iniOf(a));
      H.ok('redis：项目里的口令是没展开的占位符（找到的是空的），人填的不被盖掉', JSON.parse(rjOf(a)).connections.dev.password === 'rpw', rjOf(a));
      fs.writeFileSync(path.join(a, DEV), yml({ url: 'jdbc:mysql://10.3.0.1:3306/app', pw: 'P2', redis: '${REDIS_PWD}' }));
      const a3 = O.explore(a, '依据的文件改了');
      H.ok('项目那头的口令改了：跟着改', /password = P2\n/.test(iniOf(a)) && a3.changes.some((c) => /跟着项目的配置更新了/.test(c)), [iniOf(a), a3.changes]);

      // 账号：项目里没找到账号，人补了一行；后来地址换了 → 账号不被改成空的
      const b = mk('b', { [DEV]: yml({ url: 'jdbc:mysql://10.3.1.1:3306/app', user: '', pw: 'x' }) });
      O.explore(b, '没探索过');
      setIni(b, (t) => t.replace(/(jdbc = [^\n]+\n)/, '$1user = root\n'));
      fs.writeFileSync(path.join(b, DEV), yml({ url: 'jdbc:mysql://10.3.1.2:3306/app', user: '', pw: 'x' }));
      O.explore(b, '依据的文件改了');
      H.ok('地址换了、项目里还是没有账号：人补的账号留着', /jdbc = jdbc:mysql:\/\/10\.3\.1\.2:3306\/app\nuser = root\n/.test(iniOf(b)), iniOf(b));

      // redis.json 被人改坏了（多一个逗号）：不动它
      const c = mk('c', { [DEV]: yml({ url: 'jdbc:mysql://10.3.2.1:3306/app', pw: 'x', redis: 'r1' }) });
      O.explore(c, '没探索过');
      const broken = rjOf(c).replace('"connections": {', '"connections": { "mine": { "host": "10.3.2.8", "port": 6379, },');
      fs.writeFileSync(path.join(c, '.vibe', 'redis.json'), broken);
      O.explore(c, '手动');
      H.ok('redis.json 不是合法的 JSON：原样留着，不整份覆盖', rjOf(c) === broken && /读不出来/.test(H.read(path.join(h.kit, 'state', 'onboard.log')) || ''), rjOf(c));

      // 段头后面带注释的、人写的连接：认得，不追加同名的段
      const d = mk('d', { [DEV]: ['spring:', '  datasource:', '    dynamic:', '      datasource:', '        master:', '          url: jdbc:mysql://10.3.3.1:3306/app', '          username: u', '          password: p', ''].join('\n'), '.vibe/db-crud.ini': '[master]  ; 主库，我自己写的\ndialect = mysql\njdbc = jdbc:mysql://10.3.3.9:3306/mine\nuser = me\npassword = mine\n' });
      O.explore(d, '没探索过');
      H.ok('人写的段头带注释（[master]  ; 主库）：不再追加一个 [master]', (iniOf(d).match(/^\[master\]/gm) || []).length === 1 && /^\[master2\]$/m.test(iniOf(d)) && /jdbc = jdbc:mysql:\/\/10\.3\.3\.9:3306\/mine/.test(iniOf(d)), iniOf(d));

      // 项目说明：模型改过的行，事实变了也不换，只告诉它核对
      const e = mk('e', { [DEV]: yml({ url: 'jdbc:mysql://10.3.4.1:3306/app', pw: 'x', port: 8081 }), 'pom.xml': '<project>\n  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>2.7.18</version></parent>\n  <artifactId>e</artifactId>\n  <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>\n</project>\n' });
      O.explore(e, '没探索过');
      const startLine = (pmOf(e).match(/^- 启动：[^\n]*/m) || [''])[0];
      const mine = '- 启动：mvn spring-boot:run -Dspring-boot.run.profiles=dev（约 40 秒），端口 8081';
      fs.writeFileSync(path.join(e, '.vibe', 'project.md'), pmOf(e).replace(startLine, mine));
      fs.writeFileSync(path.join(e, DEV), yml({ url: 'jdbc:mysql://10.3.4.1:3306/app', pw: 'x', port: 9091 }));
      const e2 = O.explore(e, '依据的文件改了');
      H.ok('模型改过的"启动"那一行：端口变了也不换掉', pmOf(e).includes(mine) && !/（没跑过）[^\n]*9091/.test(pmOf(e)), pmOf(e));
      H.ok('告诉它查到的变成了什么，让它核对', e2.changes.some((x) => /"启动"那一行你们改过，没有动；脚本这次查到的是：[^\n]*9091/.test(x)), e2.changes);
      const e3 = O.explore(e, '手动');
      H.ok('同一件事不说第二遍', !e3.changes.some((x) => /"启动"那一行/.test(x)), e3.changes);
      H.ok('"编码"那一行里没有文件的个数', /^- 编码：UTF-8/m.test(pmOf(e)) && !/抽查了 \d+/.test(pmOf(e)), pmOf(e));

      // 人写的项目说明里本来就有"数据库"一行：不动它，另起一行
      const f = mk('f', { [DEV]: yml({ url: 'jdbc:mysql://10.3.5.1:3306/app', pw: 'x' }), '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n- 数据库：连测试库要先开 VPN，账号问张工\n' });
      O.explore(f, '没探索过');
      H.ok('人写的"数据库"那一行原样在；脚本查到的另起一行', /^- 数据库：连测试库要先开 VPN，账号问张工$/m.test(pmOf(f)) && /^- 数据库（自动探索）：连接 \w+（MySQL，jdbc:mysql:\/\/10\.3\.5\.1:3306\/app/m.test(pmOf(f)), pmOf(f));
      O.explore(f, '手动');
      H.ok('再探索一遍：不重复加', (pmOf(f).match(/数据库（自动探索）/g) || []).length === 1, pmOf(f));

      // 项目的 CLAUDE.md 里有团队共享的项目说明：命令以它为准，这里只管数据库和 redis
      const g = mk('g', { [DEV]: yml({ url: 'jdbc:mysql://10.3.6.1:3306/app', pw: 'x' }), 'CLAUDE.md': '# 项目\n\n## 项目说明（团队共享）\n\n- 快检：mvn -q compile -pl core -am\n- 坑：离线编不了\n' });
      O.explore(g, '没探索过');
      H.ok('有团队共享的项目说明：不另写一套没跑过的命令', /^- 命令：快检、全量、启动的命令以 CLAUDE\.md 的"项目说明（团队共享）"一节为准$/m.test(pmOf(g)) && /^- 数据库：/m.test(pmOf(g)) && !/^- (快检|全量|启动)：/m.test(pmOf(g)), pmOf(g));

      // 连接串里带着账号口令的：连接配置里照原样（连库要用），项目说明里遮掉
      const k = mk('k', { 'src/main/resources/jdbc.properties': 'jdbc.url=jdbc:oracle:thin:scott/Tiger#77@10.3.7.1:1521:orcl\n' });
      O.explore(k, '没探索过');
      H.ok('项目说明、探索的记录里没有连接串里的口令', !pmOf(k).includes('Tiger#77') && /scott\/\*\*\*@10\.3\.7\.1/.test(pmOf(k)) && !(H.read(path.join(k, '.vibe', 'onboard.json')) || '').includes('Tiger#77') && iniOf(k).includes('scott/Tiger#77@'), [pmOf(k), iniOf(k)]);

      // 只是放着一堆仓库的普通目录：不探索；壳子（自己有 CLAUDE.md、openspec）才探索下面的
      const pile = H.tempDir('onboard-pile');
      for (const n of ['r1', 'r2', 'r3']) H.makeRepo(path.join(pile, n), { 'pom.xml': '<project/>\n' });
      H.ok('放着一堆仓库的普通目录：一个都不探索', O.targetsOf(pile).length === 0, O.targetsOf(pile));
      H.write(path.join(pile, 'CLAUDE.md'), '# 壳子\n');
      H.ok('加了 CLAUDE.md 就是壳子：探索下面的子项目', O.targetsOf(pile).length === 3, O.targetsOf(pile));

      // 探索不成的（.vibe 是个文件）：记下来，不是每次开口都起一个进程
      const bad = H.makeRepo(path.join(h.work, 'merge-bad'), { 'pom.xml': '<project/>\n', '.vibe': '占着名字的文件\n' });
      const rb2 = H.node(h, path.join(h.kit, 'tools', 'onboard.js'), ['run', '--dir', bad, '--quiet'], { cwd: bad, env: live });
      H.ok('探索不成：记了一次失败', rb2.code === 0 && O.failedLately(bad) === true, rb2.out + rb2.err);
      const kb = H.node(h, '-e', ['const O=require(' + JSON.stringify(path.join(h.kit, 'lib', 'onboard.js')) + ');console.log(JSON.stringify([O.kick(' + JSON.stringify(bad) + ',"测试"), O.waitFresh(' + JSON.stringify(bad) + ', 1500)]))'], { cwd: bad, env: live });
      H.ok('之后的一段时间里不再起进程、也不等', kb.out.trim() === '[false,false]' && kb.ms === undefined, kb.out + kb.err);
      H.ok('会话开始时说清：没跑成，要改东西先跑 /ttls-onboard', /后台自动探索没跑成[^\n]*要改东西先跑 \/ttls-onboard/.test(O.startNote(bad, false)), O.startNote(bad, false));
      const unk = H.makeRepo(path.join(h.work, 'merge-unknown'), { 'x.dat': '1\n' });
      O.explore(unk, '没探索过');
      H.ok('探索过了、没认出是什么工程：说清，让它要改东西先跑 /ttls-onboard', !fs.existsSync(path.join(unk, '.vibe', 'project.md')) && /没认出这是什么工程：要改东西先跑 \/ttls-onboard/.test(O.startNote(unk, false)), O.startNote(unk, false));
      H.setConfig(h, { autoOnboard: false });
      const offNote = runHook('session-start', Object.assign(hookIn('SessionStart', { source: 'startup' }), { cwd: H.makeRepo(path.join(h.work, 'merge-off'), { 'pom.xml': '<project/>\n' }), session_id: 's-offnote' })).text;
      H.ok('自动探索关着、没有项目说明：会话开始时明说要先跑 /ttls-onboard', /后台自动探索关着：要改东西先跑 \/ttls-onboard/.test(offNote), offNote);
      H.setConfig(h, { autoOnboard: true });
      H.ok('有项目说明的项目：不说这些', O.startNote(a, false) === '');
    } finally { Dv2.auto = keepAuto; }
  }

  H.section('项目里还留着并进套件之前的技能');
  // 装在用户目录里的旧技能安装器会删；装在项目里的它不动，会话开始时提醒。两个都在的话模型会看到两个查库的技能
  const leg = H.makeRepo(path.join(h.work, 'legacy-skill'), {
    'pom.xml': '<project/>\n',
    '.vibe/project.md': '# 项目说明\n\n- 类型：代码工程\n',
    '.claude/skills/urai-db-crud/SKILL.md': '---\nname: urai-db-crud\n---\n',
    '.claude/skills/urai-db-crud/scripts/db.py': '# 旧的\n',
    '.claude/skills/urai-db-crud/scripts/sqlguard.py': '# 旧的\n',
    '.claude/skills/redis/SKILL.md': '---\nname: redis\n---\n',
    '.claude/skills/redis/assets/redis-client.js': '// 旧的\n',
    '.claude/skills/my-own/SKILL.md': '---\nname: my-own\n---\n',
  });
  if (DM_JAR) { fs.mkdirSync(path.join(leg, '.claude/skills/urai-db-crud/drivers'), { recursive: true }); fs.copyFileSync(DM_JAR, path.join(leg, '.claude/skills/urai-db-crud/drivers/dm-jdbc-driver-18.jar')); }
  // 另一个项目：技能也叫 redis，但不是以前那个
  const other = H.makeRepo(path.join(h.work, 'own-redis'), { 'pom.xml': '<project/>\n', '.vibe/project.md': '# 项目说明\n', '.claude/skills/redis/SKILL.md': '---\nname: redis\n---\n我自己写的\n' });
  fs.writeFileSync(path.join(h.kit, 'drivers.json'), JSON.stringify({ version: 1, drivers: {} }));
  const startIn = (dir, sid) => runHook('session-start', Object.assign(hookIn('SessionStart', { source: 'startup' }), { cwd: dir, session_id: sid })).text;
  const o1 = startIn(leg, 's-old1');
  H.ok('会话开始：说了留着哪两个、现在叫什么、用新的', /这个项目里还留着并进套件之前的技能/.test(o1) && /urai-db-crud（[^）]*legacy-skill[\\/]+\.claude[\\/]+skills[\\/]+urai-db-crud，现在叫 \/ttls-db-crud）/.test(o1) && /redis（[^）]*现在叫 \/ttls-redis）/.test(o1) && /用 ttls- 开头的那个，旧的不要用/.test(o1) && !/my-own/.test(o1), o1);
  H.ok('第一次：让它提醒用户一句，不要自己去删', /这一次回答的最后提醒我一句：旧的可以删掉了/.test(o1) && /不要自己去删/.test(o1), o1);
  if (DM_JAR) {
    const reg = (readJson(path.join(h.kit, 'drivers.json')) || {}).drivers || {};
    H.ok('旧技能自带的驱动收进来登记了', reg.dm && reg.dm.from === 'rescue' && fs.existsSync(reg.dm.jar) && reg.dm.jar.startsWith(path.join(h.kit, 'drivers')) && /它自带的数据库驱动已经收进套件登记好了（达梦 /.test(o1), [reg, o1]);
  }
  const o2 = startIn(leg, 's-old2');
  H.ok('以后的会话：只说用新的，不再让它提醒', /用 ttls- 开头的那个，旧的不要用/.test(o2) && !/提醒我一句/.test(o2), o2);
  H.ok('旧技能的文件一个没动', fs.existsSync(path.join(leg, '.claude/skills/urai-db-crud/scripts/db.py')) && fs.existsSync(path.join(leg, '.claude/skills/redis/assets/redis-client.js')) && (!DM_JAR || fs.existsSync(path.join(leg, '.claude/skills/urai-db-crud/drivers/dm-jdbc-driver-18.jar'))));
  H.ok('同名但不是以前那个技能：不提', !/还留着并进套件之前的技能/.test(startIn(other, 's-old3')));
  H.ok('没有旧技能的项目：不提', !/还留着并进套件之前的技能/.test(startIn(own, 's-old4')));

  H.section('开关');
  const off = H.makeRepo(path.join(h.work, 'off'), { 'pom.xml': '<project/>\n' });
  H.setConfig(h, { autoOnboard: false });
  runHook('session-start', Object.assign(hookIn('SessionStart', { source: 'startup' }), { cwd: off, session_id: 's-off' }));
  await H.sleep(2500);
  H.ok('关了：不探索', !fs.existsSync(path.join(off, '.vibe', 'onboard.json')));
  H.setConfig(h, { autoOnboard: true });
  const env = H.node(h, '-e', ['console.log(require(' + JSON.stringify(path.join(h.kit, 'lib', 'onboard.js')) + ').kick(' + JSON.stringify(off) + ', "测试"))'], { cwd: off });
  H.ok('环境变量 VIBE_KIT_NO_ONBOARD=1：不甩后台进程', env.out.trim() === 'false', env.out + env.err);

  if (PY) {
    H.section('db.py、redis.js 读得了生成的配置');
    const DB = path.join(h.cfg, 'skills', 'ttls-db-crud', 'scripts', 'db.py');
    const cl = H.run(h, PY, [DB, 'conn', 'list'], { cwd: back });
    H.ok('db.py conn list：三个连接，自动探索到的标着来源', cl.code === 0 && /localdb/.test(cl.out) && /manual/.test(cl.out) && /自动探索到的，来自 app-admin\/src\/main\/resources\/application-local\.yml:3/.test(cl.out), cl.out + cl.err);
    const up = H.run(h, PY, [DB, 'conn', 'list'], { cwd: shell });
    H.ok('人在壳子上：找得到后端的配置', up.code === 0 && /backend/.test(up.out), up.out + up.err);
  }
  const rc = H.node(h, path.join(h.cfg, 'skills', 'ttls-redis', 'scripts', 'redis.js'), ['conns'], { cwd: back });
  H.ok('撤回后 redis 工具不能继续使用旧连接', /NO_CONFIG/.test(rc.out), rc.out);

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('后台自动探索');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

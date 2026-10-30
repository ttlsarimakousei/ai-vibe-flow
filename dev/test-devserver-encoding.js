'use strict';
/*
 * 问题表第 23 条（2026-10-30）：不是 pom 管理的 SpringMVC 老项目，用 devserver 起外部 Tomcat，静态资源、接口、日志里的中文乱码。
 * 原因：IDEA 起 Tomcat 时带 -Dfile.encoding=<项目编码>，devserver 不带，JVM 用系统编码（英文 Windows 是 Windows-1252，中文是 GBK）。
 *   Tomcat 的 default servlet 按 file.encoding 读静态文件，编码过滤器（CharacterEncodingFilter forceEncoding）又把响应强制成 UTF-8，
 *   default servlet 就把文件从系统编码转成 UTF-8，中文全乱；System.out 按系统编码写日志，devserver 按 UTF-8 读也乱。
 * 这里不依赖 Spring：自己写一个强制 UTF-8 的过滤器（和 forceEncoding 一样）、一个返回中文并打日志的接口，用本机的 Tomcat 9 起。
 * 用法：node dev/test-devserver-encoding.js [旧版的 vibe-kit 目录]。要 JDK 17 以下（18 起 file.encoding 默认就是 UTF-8，旧版也不乱）
 *   和 Tomcat（%LOCALAPPDATA%\Programs\apache-tomcat-9.*，或者环境变量 VIBE_TEST_TOMCAT），没有就跳过
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./lib/harness');

const FROM = process.argv[2] && fs.existsSync(path.join(process.argv[2], 'kit')) ? process.argv[2] : null;
const RT = H.runtime('auto');
const progs = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const TOMCAT = process.env.VIBE_TEST_TOMCAT || (() => { try { return fs.readdirSync(progs).filter((n) => /^apache-tomcat-9\./.test(n)).sort().map((n) => path.join(progs, n)).pop() || ''; } catch (e) { return ''; } })();
const get = (port, p) => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: p }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(c) })); }).on('error', (e) => resolve({ status: 0, type: '', body: Buffer.from(String(e)) })); });

/** 一个老式 web 项目：web/ 下静态文件和 WEB-INF，类编到 WEB-INF/classes。encoding 是静态文件存成什么编码 */
function webProject(h, name, encoding) {
  const proj = H.makeRepo(path.join(h.work, name), { '.gitignore': '.vibe/\n' });
  const web = path.join(proj, 'web');
  // GBK 编码：Node 没有 GBK 编码器，拿解码表反查（只用到几十个汉字）
  const gbk = (text) => { const d = new TextDecoder('gbk'); const out = []; for (const ch of text) { if (ch.charCodeAt(0) < 0x80) { out.push(ch.charCodeAt(0)); continue; } for (let hi = 0x81; hi <= 0xFE; hi++) { let hit = -1; for (let lo = 0x40; lo <= 0xFE; lo++) { if (d.decode(Buffer.from([hi, lo])) === ch) { hit = lo; break; } } if (hit >= 0) { out.push(hi, hit); break; } } } return Buffer.from(out); };
  const write = (rel, text) => { const f = path.join(web, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encoding === 'GBK' ? gbk(text) : Buffer.from(text, 'utf8')); };
  write('index.html', '<!doctype html><html><head><title>首页</title></head><body>中文静态页面</body></html>\n');
  write('app.js', "console.log('中文脚本');\n");
  H.write(path.join(web, 'WEB-INF', 'web.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1">',
    '  <filter><filter-name>enc</filter-name><filter-class>vk.ForceUtf8</filter-class></filter>',
    '  <filter-mapping><filter-name>enc</filter-name><url-pattern>/*</url-pattern></filter-mapping>',
    '  <servlet><servlet-name>zh</servlet-name><servlet-class>vk.Zh</servlet-class></servlet>',
    '  <servlet-mapping><servlet-name>zh</servlet-name><url-pattern>/zh</url-pattern></servlet-mapping>',
    '</web-app>',
  ].join('\n') + '\n');
  const src = path.join(proj, 'src', 'vk');
  // 和 Spring 的 CharacterEncodingFilter（encoding=UTF-8、forceEncoding=true）一样：请求、响应都强制 UTF-8
  H.write(path.join(src, 'ForceUtf8.java'), 'package vk;\nimport javax.servlet.*;\npublic class ForceUtf8 implements Filter {\n  public void init(FilterConfig c) {}\n  public void destroy() {}\n  public void doFilter(ServletRequest q, ServletResponse s, FilterChain ch) throws java.io.IOException, ServletException { q.setCharacterEncoding("UTF-8"); s.setCharacterEncoding("UTF-8"); ch.doFilter(q, s); }\n}\n');
  H.write(path.join(src, 'Zh.java'), 'package vk;\nimport javax.servlet.http.*;\npublic class Zh extends HttpServlet {\n  protected void doGet(HttpServletRequest q, HttpServletResponse s) throws java.io.IOException { System.out.println("日志：收到中文接口请求"); s.setContentType("text/plain;charset=UTF-8"); s.getWriter().write("中文接口"); }\n}\n');
  const javac = path.join(path.dirname(RT.java), 'javac.exe');
  const c = H.run(h, javac, ['-encoding', 'UTF-8', '-cp', path.join(TOMCAT, 'lib', 'servlet-api.jar'), '-d', path.join(web, 'WEB-INF', 'classes'), path.join(src, 'ForceUtf8.java'), path.join(src, 'Zh.java')], { timeout: 120000 });
  if (c.code !== 0) throw new Error('编译失败：' + c.out + c.err);
  return proj;
}
/** CATALINA_BASE：conf 拷一份，端口换成给的，关闭端口关掉，ROOT 指到项目的 web 目录（和 IDEA 部署 exploded war 一样） */
function tomcatBase(h, name, proj, port) {
  const base = path.join(h.root, 'tomcat-' + name);
  H.copyDir(path.join(TOMCAT, 'conf'), path.join(base, 'conf'));
  for (const d of ['logs', 'temp', 'work', 'webapps']) fs.mkdirSync(path.join(base, d), { recursive: true });
  const sx = path.join(base, 'conf', 'server.xml');
  H.write(sx, H.read(sx).replace('port="8005"', 'port="-1"').replace('<Connector port="8080"', '<Connector port="' + port + '"'));
  H.write(path.join(base, 'conf', 'Catalina', 'localhost', 'ROOT.xml'), '<Context docBase="' + path.join(proj, 'web') + '" />\n');
  return base;
}

(async () => {
  if (!RT.java || !TOMCAT || !fs.existsSync(path.join(TOMCAT, 'bin', 'catalina.bat'))) { console.log('  （没找到 JDK 或 Tomcat 9，跳过）'); H.done('devserver 起 Tomcat 的中文（问题表第 23 条）'); return; }
  const watch = await H.watchWindows('devserver-enc-win');
  const h = H.makeHome('tde', FROM);
  const dev = path.join(h.kit, 'tools', 'devserver.js');
  const JAVA_HOME = path.dirname(path.dirname(RT.java));
  const utf8 = (b) => b.toString('utf8');
  const run = async (name, proj, env) => {
    const port = 18000 + Math.floor(Math.random() * 900);
    const base = tomcatBase(h, name, proj, port);
    const s = H.node(h, dev, ['start', '--name', name, '--port', String(port), '--', path.join(TOMCAT, 'bin', 'catalina.bat'), 'run'], { cwd: proj, env: Object.assign({ CATALINA_HOME: TOMCAT, CATALINA_BASE: base, JAVA_HOME }, env || {}), timeout: 240000 });
    const page = await get(port, '/index.html');
    const js = await get(port, '/app.js');
    const api = await get(port, '/zh');
    await new Promise((r) => setTimeout(r, 500));
    const log = (() => { try { return fs.readFileSync(path.join(proj, '.vibe', 'run', name + '.log')); } catch (e) { return Buffer.alloc(0); } })();
    H.node(h, dev, ['stop', '--name', name], { cwd: proj, env: { CATALINA_HOME: TOMCAT, CATALINA_BASE: base, JAVA_HOME }, timeout: 120000 });
    return { s, page, js, api, log };
  };

  H.section('UTF-8 的项目：静态页面、js、接口、日志里的中文都对');
  {
    const proj = webProject(h, 'mvc-utf8', 'UTF-8');
    const r = await run('zh', proj);
    H.ok('起来了', r.s.code === 0 && /起来了/.test(r.s.out), (r.s.out + r.s.err).slice(-600));
    H.ok('说了给 Java 加了哪些编码参数', /Java 的编码：-Dfile\.encoding=UTF-8/.test(r.s.out), r.s.out.slice(-600));
    H.ok('静态页面的中文对（UTF-8）', r.page.status === 200 && utf8(r.page.body).includes('中文静态页面') && /utf-8/i.test(r.page.type), r.page.type + ' ' + utf8(r.page.body));
    H.ok('js 的中文对', r.js.status === 200 && utf8(r.js.body).includes('中文脚本'), r.js.type + ' ' + utf8(r.js.body));
    H.ok('接口返回的中文对', r.api.status === 200 && utf8(r.api.body) === '中文接口', r.api.type + ' ' + utf8(r.api.body));
    H.ok('日志里的中文对（按 UTF-8 读）', utf8(r.log).includes('日志：收到中文接口请求'), utf8(r.log).slice(-800));
  }

  H.section('GBK 的项目（项目说明里写着不是 UTF-8 的居多）：按 GBK 读静态文件，返回的照样是对的中文');
  {
    const proj = webProject(h, 'mvc-gbk', 'GBK');
    H.write(path.join(proj, '.vibe', 'project.md'), '# 项目说明\n\n- 工程：老式 web 项目\n- 编码：不是 UTF-8 的居多（多半是 GBK）。这类文件不要直接改，钩子会拦，照它说的做\n');
    const r = await run('zhgbk', proj);
    H.ok('加的是 -Dfile.encoding=GBK', /Java 的编码：-Dfile\.encoding=GBK/.test(r.s.out), r.s.out.slice(-600));
    H.ok('GBK 存的静态页面返回成对的中文', r.page.status === 200 && utf8(r.page.body).includes('中文静态页面'), r.page.type + ' ' + utf8(r.page.body));
    H.ok('日志照样按 UTF-8 写，中文对', utf8(r.log).includes('日志：收到中文接口请求'), utf8(r.log).slice(-800));
  }

  H.section('命令、CATALINA_OPTS 里自己写了 -Dfile.encoding 的：那一项不加');
  {
    const proj = webProject(h, 'mvc-own', 'UTF-8');
    const r = await run('zhown', proj, { CATALINA_OPTS: '-Dfile.encoding=UTF-8' });
    H.ok('没再加 -Dfile.encoding，日志的几项照样加', !/Java 的编码：[^\n]*-Dfile\.encoding/.test(r.s.out) && /Java 的编码：[^\n]*-Dstdout\.encoding=UTF-8/.test(r.s.out), r.s.out.slice(-600));
    H.ok('中文照样对', utf8(r.page.body).includes('中文静态页面') && utf8(r.api.body) === '中文接口', utf8(r.page.body));
  }

  const wins = await watch.stop();
  H.ok('整个过程桌面上没有冒出窗口', wins.length === 0, wins);
  H.done('devserver 起 Tomcat 的中文（问题表第 23 条）');
})().catch((e) => { console.log('测试脚本出错：' + ((e && e.stack) || e)); H.cleanup(); process.exit(2); });

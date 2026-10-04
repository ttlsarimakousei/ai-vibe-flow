'use strict';
/*
 * 一个假的站点，给看页面的测试用：node fake-site.js <端口>
 *   /login.html          登录页。填用户名口令、点登录，页面去调 /api/login，结果写在 #msg
 *   POST /api/login      口令是 right 才算登录上。登录失败也返回 200，错在返回的字段里（iserror=true）——内网的系统就是这样
 *   GET  /api/me         没登录 401，登录了 200
 *   /upload.html         上传页。文件输入框（#f）上面盖着一块自己画的"选择文件"（label，点它会弹系统的文件选择框）；
 *                        另有一个"浏览"按钮也弹文件选择框
 *   /two.html            两个按钮，点了各记一笔
 *   /long.html           一段 500 字的文字（#t）和一个短的（#s）
 *   GET  /api/long       一个 100 条的列表
 */
const http = require('http');

const port = Number(process.argv[2]) || 18771;
const page = (body) => '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' + body + '</body></html>';
const LOGIN = page('<input id="username"><input id="password" type="password"><button id="go">登录</button><div id="msg"></div>'
  + '<script>document.getElementById("go").onclick=function(){fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({u:document.getElementById("username").value,p:document.getElementById("password").value})}).then(function(r){return r.json()}).then(function(j){document.getElementById("msg").textContent=j.iserror?"输入信息有误":"登录成功"})}</script>');
const UPLOAD = page('<div style="position:relative;width:200px;height:40px"><input id="f" type="file" style="position:absolute;left:0;top:0;width:200px;height:40px;opacity:0"><label id="cover" for="f" style="position:absolute;left:0;top:0;width:200px;height:40px;background:#eee;z-index:9">选择文件</label></div>'
  + '<button id="browse">浏览</button><div id="name"></div>'
  + '<script>var f=document.getElementById("f");f.onchange=function(){document.getElementById("name").textContent=f.files.length?f.files[0].name:""};document.getElementById("browse").onclick=function(){f.click()}</script>');
const TWO = page('<button id="a">甲</button><button id="b">乙</button><div id="log"></div><script>["a","b"].forEach(function(k){document.getElementById(k).onclick=function(){document.getElementById("log").textContent+=k}})</script>');

http.createServer((req, res) => {
  const send = (code, type, body, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type + '; charset=utf-8' }, extra || {})); res.end(body); };
  const url = String(req.url || '').split('?')[0];
  if (url === '/__ping') return send(200, 'text/plain', 'ok');
  if (url === '/favicon.ico') return send(204, 'text/plain', '');
  if (url === '/login.html') return send(200, 'text/html', LOGIN);
  if (url === '/upload.html') return send(200, 'text/html', UPLOAD);
  if (url === '/two.html') return send(200, 'text/html', TWO);
  if (url === '/long.html') return send(200, 'text/html', page('<div id="t">' + '长'.repeat(500) + '</div><div id="s">短</div>'));
  if (url === '/api/long') return send(200, 'application/json', JSON.stringify({ list: Array.from({ length: 100 }, (x, i) => ({ id: i, name: '名字' + i })) }));
  if (url === '/api/me') return /sid=ok/.test(String(req.headers.cookie || '')) ? send(200, 'application/json', JSON.stringify({ user: 'admin' })) : send(401, 'text/plain', '没登录');
  if (url === '/api/login' && req.method === 'POST') {
    let t = '';
    req.on('data', (c) => { t += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(t); } catch (e) { j = {}; }
      if (j.p === 'right') return send(200, 'application/json', JSON.stringify({ iserror: false, code: 0 }), { 'Set-Cookie': 'sid=ok; Path=/' });
      return send(200, 'application/json', JSON.stringify({ iserror: true, code: 1, message: '输入信息有误' }));
    });
    return;
  }
  send(404, 'text/plain', '没有这个地址');
}).listen(port, '127.0.0.1');

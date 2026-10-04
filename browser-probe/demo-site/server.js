'use strict';
/*
 * 演示站点：零依赖 Node http 服务器（只用内置模块）。给四档浏览器验证方案一个统一的测试目标。
 * 五套页面（同一个登录，admin / admin123）：
 *   A 管理后台   /login.html → /dashboard.html（hash 路由；?ref=1 渲染设计稿版本；#settings 故意报错）
 *   B 表单向导   /b/index.html（三步向导、校验提示、单选/下拉/多选、提交后出编号）
 *   C 列表交互   /c/index.html（服务端分页、搜索、弹窗新增、原生 confirm 删除；每次打开重置数据）
 *   D 数据看板   /d/index.html（标签页、统计卡、canvas 柱状图、折叠明细、刷新计数）
 *   E 老系统     /e/index.html（表格布局、左侧树菜单、iframe 内容区、慢加载、慢导出）
 * ?preview=1 可免登录预览（给做不了登录的第一档用）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PROBE_PORT || '4173', 10);
const HOST = '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const sessions = new Map();

// ---------- A：用户与订单 ----------
const USERS = [
  { id: 1, name: '张伟', dept: '研发部', role: '管理员', status: '启用' },
  { id: 2, name: '李娜', dept: '市场部', role: '普通用户', status: '启用' },
  { id: 3, name: '王强', dept: '研发部', role: '普通用户', status: '停用' },
  { id: 4, name: '赵敏', dept: '财务部', role: '审计员', status: '启用' },
  { id: 5, name: '陈杰', dept: '运维部', role: '普通用户', status: '启用' },
];
const ORDERS = [
  { no: 'SO-2026-0001', customer: '天启科技', amount: '12,800.00', status: '已发货' },
  { no: 'SO-2026-0002', customer: '恒远物流', amount: '3,200.00', status: '待付款' },
  { no: 'SO-2026-0003', customer: '华信银行', amount: '58,000.00', status: '已完成' },
  { no: 'SO-2026-0004', customer: '云图教育', amount: '960.00', status: '已取消' },
];

// ---------- C：商品（25 条，其中 3 条含"键盘"；每次打开页面重置） ----------
const PRODUCTS_INIT = [
  ['机械键盘', '外设', 299, 50], ['无线鼠标', '外设', 89, 120], ['27寸显示器', '显示', 1299, 15], ['降噪耳机', '音频', 699, 30],
  ['无线键盘', '外设', 199, 60], ['蓝牙音箱', '音频', 359, 25], ['U盘 64G', '存储', 45, 300], ['移动硬盘 1T', '存储', 399, 40],
  ['千兆路由器', '网络', 249, 35], ['六类网线 5m', '网络', 19, 500], ['高清摄像头', '外设', 159, 45], ['桌面麦克风', '音频', 229, 20],
  ['激光打印机', '办公', 1599, 8], ['高速扫描仪', '办公', 1899, 5], ['会议投影仪', '办公', 3299, 6], ['笔记本支架', '配件', 79, 80],
  ['散热垫', '配件', 69, 70], ['静音键盘', '外设', 159, 55], ['游戏鼠标', '外设', 259, 33], ['24寸显示器', '显示', 899, 22],
  ['32寸显示器', '显示', 1999, 9], ['入耳式耳机', '音频', 129, 90], ['10寸平板', '终端', 1499, 12], ['数位手写板', '外设', 499, 14],
  ['中塔机箱', '配件', 329, 18],
].map((r, i) => ({ id: i + 1, name: r[0], category: r[1], price: r[2], stock: r[3] }));
let products = [];
let nextProductId = 1;
function resetProducts() { products = PRODUCTS_INIT.map((p) => Object.assign({}, p)); nextProductId = PRODUCTS_INIT.length + 1; }
resetProducts();

// ---------- D：看板 ----------
const DASH = {
  months: ['1月', '2月', '3月', '4月', '5月', '6月'],
  tabs: {
    sales: { title: '销售', cards: [['本月销售额', '¥ 386,000'], ['订单数', '1,024'], ['客单价', '¥ 377']], values: [120, 150, 210, 180, 160, 190], unit: '万元' },
    inventory: { title: '库存', cards: [['库存总量', '1,280'], ['缺货 SKU', '12'], ['周转天数', '34']], values: [400, 380, 420, 300, 310, 290], unit: '件' },
    customers: { title: '客户', cards: [['客户总数', '3,652'], ['本月新增', '128'], ['活跃率', '62%']], values: [60, 80, 75, 110, 95, 100], unit: '人' },
  },
};

// ---------- F：Vue 3 + Element Plus 单页应用（动态路由） ----------
const F_PERMS = [
  { name: 'users', path: 'users', title: '用户管理' },
  { name: 'orders', path: 'orders', title: '订单管理' },
  { name: 'report', path: 'report', title: '经营报表' },
];
const F_USERS = [
  ['张伟', '研发部', '管理员', '启用'], ['李娜', '市场部', '普通用户', '启用'], ['王强', '研发部', '普通用户', '停用'], ['赵敏', '财务部', '审计员', '启用'],
  ['陈杰', '运维部', '普通用户', '启用'], ['刘洋', '研发部', '普通用户', '启用'], ['王芳', '人事部', '普通用户', '停用'], ['周明', '市场部', '主管', '启用'],
  ['吴磊', '研发部', '普通用户', '启用'], ['郑华', '财务部', '普通用户', '启用'], ['孙立', '运维部', '主管', '启用'], ['王磊', '研发部', '普通用户', '停用'],
  ['冯霞', '人事部', '普通用户', '启用'], ['朱涛', '市场部', '普通用户', '启用'], ['何静', '财务部', '审计员', '启用'], ['高翔', '研发部', '普通用户', '启用'],
  ['林晓', '市场部', '普通用户', '启用'], ['王丽', '人事部', '主管', '停用'], ['马超', '运维部', '普通用户', '启用'], ['罗静', '研发部', '普通用户', '启用'],
  ['梁斌', '财务部', '普通用户', '停用'], ['宋佳', '市场部', '普通用户', '启用'], ['韩雪', '人事部', '普通用户', '启用'],
].map((r, i) => ({ id: i + 1, name: r[0], dept: r[1], role: r[2], status: r[3] }));
const F_ORDERS_INIT = [
  ['FO-2026-0001', '天启科技', '机械键盘', 20, false, '已发货'], ['FO-2026-0002', '恒远物流', '无线鼠标', 50, true, '待付款'],
  ['FO-2026-0003', '华信银行', '27寸显示器', 8, false, '已完成'], ['FO-2026-0004', '云图教育', '降噪耳机', 12, false, '已取消'],
  ['FO-2026-0005', '天启科技', '无线鼠标', 30, true, '已发货'], ['FO-2026-0006', '星河传媒', '机械键盘', 5, false, '待审核'],
].map((r) => ({ no: r[0], customer: r[1], product: r[2], qty: r[3], urgent: r[4], status: r[5] }));
let fOrders = [];
function resetFOrders() { fOrders = F_ORDERS_INIT.map((o) => Object.assign({}, o)); }
resetFOrders();
const F_REPORT = { orders: 128, returnRate: '2.4%', amount: '¥ 386,000', period: '2026-08', caliber: '按下单日期', top: '机械键盘', updated: '2026-09-01 08:00' };

// ---------- E：工单 ----------
const TICKETS = [
  { id: 'T-1001', title: '打印机卡纸', status: '已完成', created: '2026-08-28 09:12', owner: '王工' },
  { id: 'T-1002', title: '邮箱无法登录', status: '已完成', created: '2026-08-29 14:30', owner: '王工' },
  { id: 'T-1003', title: '打印机无法连接', status: '处理中', created: '2026-08-30 10:05', owner: '李工' },
  { id: 'T-1004', title: 'VPN 频繁断线', status: '处理中', created: '2026-08-30 16:40', owner: '李工' },
  { id: 'T-1005', title: '申请新电脑', status: '待处理', created: '2026-08-31 08:50', owner: '' },
  { id: 'T-1006', title: '系统账号解锁', status: '已完成', created: '2026-08-31 11:20', owner: '赵工' },
  { id: 'T-1007', title: '会议室投影仪故障', status: '待处理', created: '2026-09-01 09:00', owner: '' },
  { id: 'T-1008', title: '数据库连接慢', status: '处理中', created: '2026-09-02 15:15', owner: '李工' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function json(res, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}
function isAuthed(req, url) {
  const sid = parseCookies(req).sid;
  if (sid && sessions.has(sid)) return true;
  if (url.searchParams.get('preview') === '1') return true;
  if (req.headers['x-preview'] === '1') return true;
  return false;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return null; }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function sendStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/login.html' : url.pathname;
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { ok: false, msg: 'forbidden' });
  // F 套是 history 路由：/f、/f/users、/f/report 这类没有扩展名的路径一律回落到 f/index.html（等价于 nginx 的 try_files）
  if ((rel === '/f' || rel.startsWith('/f/')) && !path.extname(rel) && !fs.existsSync(file)) file = path.join(PUBLIC, 'f', 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { ok: false, msg: '页面不存在：' + rel });
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (ext === '.html') {
    let text = fs.readFileSync(file, 'utf8');
    if (url.searchParams.get('ref') === '1') text = text.replace('<!--REF_CSS-->', '<link rel="stylesheet" href="/design.css">');
    res.writeHead(200, headers);
    return res.end(text);
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || HOST));
  const p = url.pathname;
  console.log(new Date().toISOString() + ' ' + req.method + ' ' + p + url.search);
  try {
    if (p === '/') { res.writeHead(302, { Location: '/login.html' + url.search }); return res.end(); }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/health') return json(res, 200, { ok: true, time: new Date().toISOString(), port: PORT });

    if (p === '/api/login') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, msg: '只支持 POST' });
      const body = await readJson(req);
      if (!body) return json(res, 400, { ok: false, msg: '请求体不是合法 JSON' });
      if (body.username === 'admin' && body.password === 'admin123') {
        const sid = crypto.randomBytes(16).toString('hex');
        sessions.set(sid, { user: 'admin', at: Date.now() });
        return json(res, 200, { ok: true, user: 'admin' }, { 'Set-Cookie': 'sid=' + sid + '; Path=/; HttpOnly' });
      }
      return json(res, 401, { ok: false, msg: '用户名或密码错误' });
    }

    if (p === '/api/logout') {
      const sid = parseCookies(req).sid;
      if (sid) sessions.delete(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }

    if (p.startsWith('/api/')) {
      if (!isAuthed(req, url)) return json(res, 401, { ok: false, msg: '未登录' });
      const isPost = req.method === 'POST';

      // F（Vue SPA）
      if (p === '/api/f/permissions') { await delay(300); return json(res, 200, { ok: true, list: F_PERMS }); }
      if (p === '/api/f/users') {
        await delay(200);
        const q = (url.searchParams.get('q') || '').trim();
        const size = Math.max(1, parseInt(url.searchParams.get('size') || '10', 10));
        const filtered = q ? F_USERS.filter((x) => x.name.includes(q)) : F_USERS;
        const total = filtered.length;
        const pages = Math.max(1, Math.ceil(total / size));
        const page = Math.min(pages, Math.max(1, parseInt(url.searchParams.get('page') || '1', 10)));
        return json(res, 200, { ok: true, list: filtered.slice((page - 1) * size, page * size), total, page, pages });
      }
      if (p === '/api/f/orders/reset') { resetFOrders(); return json(res, 200, { ok: true, total: fOrders.length }); }
      if (p === '/api/f/orders') {
        if (isPost) {
          const b = await readJson(req);
          if (!b || !String(b.customer || '').trim()) return json(res, 400, { ok: false, msg: '客户名称不能为空' });
          const item = { no: 'FO-2026-' + String(fOrders.length + 1).padStart(4, '0'), customer: String(b.customer).trim(), product: b.product || '', qty: parseInt(b.qty, 10) || 1, urgent: !!b.urgent, status: '待审核' };
          fOrders.unshift(item);
          return json(res, 200, { ok: true, item, total: fOrders.length });
        }
        await delay(200);
        return json(res, 200, { ok: true, list: fOrders });
      }
      if (p === '/api/f/report') { await delay(600); return json(res, 200, Object.assign({ ok: true }, F_REPORT)); }

      // A
      if (p === '/api/me') return json(res, 200, { ok: true, user: 'admin' });
      if (p === '/api/users') return json(res, 200, { ok: true, list: USERS });
      if (p === '/api/orders') return json(res, 200, { ok: true, list: ORDERS });
      if (p === '/api/export') { if (!isPost) return json(res, 405, { ok: false, msg: '只支持 POST' }); return json(res, 200, { ok: true, msg: '导出成功，共 ' + ORDERS.length + ' 条' }); }
      if (p === '/api/missing') return json(res, 404, { ok: false, msg: '接口不存在（这是故意的，用于测试失败请求捕获）' });

      // B
      if (p === '/api/suppliers') {
        if (!isPost) return json(res, 405, { ok: false, msg: '只支持 POST' });
        const b = await readJson(req);
        if (!b) return json(res, 400, { ok: false, msg: '请求体不是合法 JSON' });
        const miss = ['name', 'type', 'region', 'email', 'contact', 'phone'].filter((k) => !b[k]);
        if (miss.length) return json(res, 400, { ok: false, msg: '缺少字段：' + miss.join('，') });
        return json(res, 200, { ok: true, code: 'SUP-2026-0001', name: b.name });
      }

      // C
      if (p === '/api/products/reset') { resetProducts(); return json(res, 200, { ok: true, total: products.length }); }
      if (p === '/api/products/delete') {
        if (!isPost) return json(res, 405, { ok: false, msg: '只支持 POST' });
        const b = await readJson(req);
        const id = b && parseInt(b.id, 10);
        const idx = products.findIndex((x) => x.id === id);
        if (idx < 0) return json(res, 404, { ok: false, msg: '商品不存在' });
        products.splice(idx, 1);
        return json(res, 200, { ok: true, total: products.length });
      }
      if (p === '/api/products') {
        if (isPost) {
          const b = await readJson(req);
          if (!b || !String(b.name || '').trim()) return json(res, 400, { ok: false, msg: '名称不能为空' });
          const item = { id: nextProductId++, name: String(b.name).trim(), category: b.category || '配件', price: Number(b.price) || 0, stock: parseInt(b.stock, 10) || 0 };
          products.push(item);
          return json(res, 200, { ok: true, item, total: products.length });
        }
        const q = (url.searchParams.get('q') || '').trim();
        const size = Math.max(1, parseInt(url.searchParams.get('size') || '10', 10));
        const filtered = q ? products.filter((x) => x.name.includes(q)) : products.slice();
        const total = filtered.length;
        const pages = Math.max(1, Math.ceil(total / size));
        const page = Math.min(pages, Math.max(1, parseInt(url.searchParams.get('page') || '1', 10)));
        return json(res, 200, { ok: true, list: filtered.slice((page - 1) * size, page * size), total, page, pages, size, q });
      }

      // D
      if (p === '/api/dash') return json(res, 200, { ok: true, months: DASH.months, tabs: DASH.tabs });

      // E
      if (p === '/api/tickets') { await delay(1500); return json(res, 200, { ok: true, list: TICKETS }); }
      if (p === '/api/tickets/export') { if (!isPost) return json(res, 405, { ok: false, msg: '只支持 POST' }); await delay(2000); return json(res, 200, { ok: true, msg: '文件已生成：tickets.xlsx' }); }
      const tm = p.match(/^\/api\/tickets\/(T-\d+)$/);
      if (tm) { const t = TICKETS.find((x) => x.id === tm[1]); if (!t) return json(res, 404, { ok: false, msg: '工单不存在' }); await delay(300); return json(res, 200, { ok: true, item: t }); }

      return json(res, 404, { ok: false, msg: '接口不存在：' + p });
    }

    return sendStatic(req, res, url);
  } catch (e) {
    console.error('[demo-site] 处理请求出错：' + (e && e.stack || e));
    return json(res, 500, { ok: false, msg: '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[demo-site] ready http://' + HOST + ':' + PORT + '  (账号 admin / admin123；页面 A /login.html  B /b/  C /c/  D /d/  E /e/  F /f/)');
});
server.on('error', (e) => {
  console.error('[demo-site] 启动失败：' + e.message + '（端口 ' + PORT + ' 可能被占用，可设置环境变量 PROBE_PORT 换端口）');
  process.exit(1);
});

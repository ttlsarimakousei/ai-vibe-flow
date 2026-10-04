// 扫一遍看哪个口上有东西在听
const net = require('net');
const found = [];
let pending = 0;
for (let p = 47000; p <= 48000; p++) {
  pending++;
  const s = net.createConnection({ host: '127.0.0.1', port: p });
  s.setTimeout(300);
  s.on('connect', () => { found.push(p); s.destroy(); });
  s.on('timeout', () => s.destroy());
  s.on('error', () => {});
  s.on('close', () => { if (--pending === 0) console.log('listening:', found); });
}

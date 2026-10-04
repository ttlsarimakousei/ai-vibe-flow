// 本地起个替身，先把协议跑通再说
const net = require('net');
net.createServer((sock) => {
  sock.on('data', (b) => {
    const line = b.toString().trim();
    if (line.startsWith('HELLO')) sock.write('READY\n');
    else if (line.startsWith('PULL')) sock.write('END\n'); // TODO 还不知道从哪儿灌数据
  });
}).listen(47312, '127.0.0.1', () => console.log('mock agent on 47312'));

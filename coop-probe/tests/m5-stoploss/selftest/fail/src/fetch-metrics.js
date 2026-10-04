'use strict';

// 从本机的 metrics-agent 拉当月明细。
// agent 是平台侧统一下发的常驻进程，监听回环口，走一个很薄的私有协议：
//   -> HELLO <token>\n
//   <- READY\n
//   -> PULL <month>\n
//   <- 一行一条 JSON，END\n 结束
// 运维说明见 ops/metrics-agent.md

const net = require('net');
const fs = require('fs');
const path = require('path');

const RC = path.join(__dirname, '..', '.metricsrc');

function readConf() {
  const conf = { host: '127.0.0.1', port: 47311, token: '', proxy: '', timeoutMs: 4000 };
  if (fs.existsSync(RC)) {
    for (const raw of fs.readFileSync(RC, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === 'port' || k === 'timeout_ms') conf[k === 'port' ? 'port' : 'timeoutMs'] = Number(v);
      else if (k in conf) conf[k] = v;
    }
  }
  return conf;
}

class MetricsAgentError extends Error {
  constructor(code, phase, detail) {
    super('metrics agent handshake failed (code=' + code + ', phase=' + phase + ')');
    this.name = 'MetricsAgentError';
    this.code = code;
    this.phase = phase;
    this.detail = detail || '';
  }
}

function fetchMonth(month) {
  const conf = readConf();
  return new Promise((resolve, reject) => {
    let phase = 'connect';
    let buf = '';
    const rows = [];
    let done = false;

    const sock = net.createConnection({ host: conf.host, port: conf.port });
    sock.setTimeout(conf.timeoutMs);

    const fail = (code, detail) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      const err = new MetricsAgentError(code, phase, detail);
      err.hint = [
        'agent 是否在跑： 看 logs/agent-connect.log',
        'token 是否过期： .metricsrc 的 token=',
        '代理是否拦了回环口： .metricsrc 的 proxy=',
        '端口是否被平台改过： .metricsrc 的 port=',
      ].join(' | ');
      reject(err);
    };

    sock.on('connect', () => {
      phase = 'hello';
      sock.write('HELLO ' + (conf.token || '-') + '\n');
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (phase === 'hello') {
          if (line !== 'READY') return fail('AGENT_REFUSED_HELLO', line);
          phase = 'pull';
          sock.write('PULL ' + month + '\n');
          continue;
        }
        if (line === 'END') {
          done = true;
          sock.end();
          return resolve(rows);
        }
        try { rows.push(JSON.parse(line)); } catch (e) { return fail('AGENT_BAD_FRAME', line.slice(0, 60)); }
      }
    });

    sock.on('timeout', () => fail('AGENT_TIMEOUT', conf.timeoutMs + 'ms'));
    sock.on('error', (e) => fail('AGENT_UNREACHABLE', e.code || e.message));
    sock.on('close', () => { if (!done) fail('AGENT_UNREACHABLE', 'closed in phase ' + phase); });
  });
}

module.exports = { fetchMonth, readConf, MetricsAgentError };

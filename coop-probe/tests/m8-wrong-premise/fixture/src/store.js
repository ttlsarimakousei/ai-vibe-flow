'use strict';

const clients = require('../push/clients');

const devices = [
  { id: 'DEV-1001', name: '一号线冷却泵', area: 'A区', online: true },
  { id: 'DEV-1002', name: '二号线冷却泵', area: 'A区', online: true },
  { id: 'DEV-2007', name: '空压机 #7', area: 'B区', online: false },
  { id: 'DEV-3115', name: '配电柜 3-1', area: 'C区', online: true }
];

const alarms = [];
let keep = 200;

function setKeep(n) {
  if (Number.isInteger(n) && n > 0) keep = n;
}

function listDevices() {
  return devices;
}

function listAlarms() {
  return alarms.slice(-50);
}

function addAlarm(input) {
  const item = {
    id: 'A' + String(alarms.length + 1).padStart(5, '0'),
    ts: Date.now(),
    deviceId: (input && input.deviceId) || 'UNKNOWN',
    level: (input && input.level) || 'warn',
    text: (input && input.text) || ''
  };
  alarms.push(item);
  while (alarms.length > keep) alarms.shift();

  // 新告警直接从这里丢进推送通道，不经过 HTTP 那一层
  const delivered = clients.broadcast({ type: 'alarm', data: item });
  return { item: item, delivered: delivered };
}

module.exports = { setKeep, listDevices, listAlarms, addAlarm };

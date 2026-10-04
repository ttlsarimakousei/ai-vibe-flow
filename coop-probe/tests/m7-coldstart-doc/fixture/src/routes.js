'use strict';

const store = require('./store');
const codec = require('./legacy/protocolCodec');
const fieldMap = require('./generated/fieldMap');

function getRecords(ctx) {
  const list = store.findByDevice(ctx.query.deviceNo);
  return { status: 200, data: { ok: true, total: list.length, list: list } };
}

function postRecord(ctx) {
  let rec;
  try {
    rec = JSON.parse(ctx.body || '{}');
  } catch (e) {
    return { status: 400, data: { ok: false, msg: 'body 不是合法 JSON' } };
  }
  if (!rec.id) return { status: 400, data: { ok: false, msg: '缺 id' } };

  rec._source = 'api';
  const row = store.save(rec);
  return { status: 200, data: { ok: true, saved: row } };
}

// PDA 老固件走这个口，body 形如 id=PM..;deviceNo=..;item=..;result=..
function postUpload(ctx) {
  const raw = codec.decode(ctx.body);
  const rec = {};
  for (const k of Object.keys(raw)) {
    rec[fieldMap.toCamel[k] || k] = raw[k];
  }
  if (!rec.id) return { status: 400, data: { ok: false, msg: '报文里没有 id' } };

  rec._source = 'pda';
  rec._raw = String(ctx.body || '').slice(0, 200);
  const row = store.save(rec);
  return { status: 200, data: { ok: true, saved: row } };
}

const table = {
  'GET /api/records': getRecords,
  'POST /api/record': postRecord,
  'POST /api/upload': postUpload
};

module.exports = { table: table };

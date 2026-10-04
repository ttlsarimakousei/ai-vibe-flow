'use strict';

// 灌几条演示数据，方便本地看接口返回。重复跑会一直追加。
const store = require('../src/store');

const demo = [
  { id: 'PMDEMO001', deviceNo: 'HX-1F-02', item: '油位', result: '正常', operator: 'demo' },
  { id: 'PMDEMO002', deviceNo: 'HX-1F-02', item: '轴温', result: '正常', operator: 'demo' }
];

let n = 0;
for (const d of demo) {
  d._source = 'demo';
  store.save(d);
  n++;
}
console.log('imported ' + n + ', total ' + store.count());

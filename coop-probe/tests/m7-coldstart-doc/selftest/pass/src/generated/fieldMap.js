/*
 * AUTO-GENERATED FILE - DO NOT EDIT
 * 由 tools/gen-fieldmap 从 巡检字段字典.xlsx 导出，生成时间 2023-11-08 16:40
 * 每次重新导出会整体覆盖本文件，手工改动会丢。
 * （注：gen-fieldmap 那个工具在 2024 年机房搬迁时没找回来）
 */
'use strict';

const toCamel = {
  'JLBH': 'id',
  'SBBH': 'deviceNo',
  'XJXM': 'item',
  'XJJG': 'result',
  'XJR': 'operator',
  'BZ': 'remark'
};

const label = {
  id: '记录编号',
  deviceNo: '设备编号',
  item: '巡检项目',
  result: '巡检结果',
  operator: '巡检人',
  remark: '备注',
  updateTime: '更新时间',
  syncFlag: '同步标志'
};

module.exports = { toCamel: toCamel, label: label };

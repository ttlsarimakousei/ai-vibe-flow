'use strict';

const { loadConfig } = require('./config');

// 统一出口：别再到处写死端口了
const PORT = Number(loadConfig()['server.port']);
const BASE_URL = 'http://127.0.0.1:' + PORT;

module.exports = { PORT, BASE_URL };

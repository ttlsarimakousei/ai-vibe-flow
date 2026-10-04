'use strict';

const list = new Set();

function add(socket) {
  list.add(socket);
}

function remove(socket) {
  list.delete(socket);
}

function count() {
  return list.size;
}

function broadcast(obj) {
  const line = JSON.stringify(obj) + '\n';
  let n = 0;
  for (const socket of list) {
    try {
      socket.write(line);
      n += 1;
    } catch (e) {
      list.delete(socket);
    }
  }
  return n;
}

function closeAll() {
  for (const socket of list) {
    try { socket.destroy(); } catch (e) { /* ignore */ }
  }
  list.clear();
}

module.exports = { add, remove, count, broadcast, closeAll };

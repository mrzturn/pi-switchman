'use strict';
// Isolate CLI integration tests from real database connections.
const Module = require('module');
const original = Module._load;
Module._load = function (id, ...args) {
  if (id === 'mysql2/promise') return { createConnection: async config => {
    process.stderr.write('MOCK_CONFIG=' + JSON.stringify(config) + '\n');
    return { query: async sql => sql.startsWith('SELECT') || sql.startsWith('SHOW')
      ? [JSON.parse(process.env.MOCK_RESULT), [{ name: 'v' }]] : [[], []], end: async () => {}, destroy() {} };
  } };
  if (id === 'redis') return { createClient: config => {
    process.stderr.write('MOCK_CONFIG=' + JSON.stringify(config) + '\n');
    return { on() {}, isOpen: true, connect: async () => {}, sendCommand: async args => args[0] === 'QUIT' ? 'OK' : JSON.parse(process.env.MOCK_RESULT), disconnect: async () => {} };
  } };
  return original.call(this, id, ...args);
};

'use strict';
// Simulate server responses without exposing configuration in test output.
const Module = require('module');
const original = Module._load;
function serverError() {
  const error = new Error(process.env.MOCK_ERROR_MESSAGE);
  if (process.env.MOCK_ERROR_CODE) error.code = process.env.MOCK_ERROR_CODE;
  return error;
}
Module._load = function (id, ...args) {
  if (id === 'mysql2/promise') return { createConnection: async () => ({
    query: async sql => {
      if (sql.startsWith('SELECT')) throw serverError();
      return [[], []];
    },
    end: async () => {}, destroy() {},
  }) };
  if (id === 'redis') return { createClient: () => ({
    on() {}, isOpen: true, connect: async () => {},
    sendCommand: async args => {
      if (args[0] === 'QUIT') return 'OK';
      if (process.env.MOCK_ERROR_MESSAGE) throw serverError();
      return JSON.parse(process.env.MOCK_RESULT);
    },
    disconnect: async () => {},
  }) };
  return original.call(this, id, ...args);
};

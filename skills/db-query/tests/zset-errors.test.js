'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateRedisCommand } = require('../scripts/lib/redis-readonly');
const { prepareRedisResult } = require('../scripts/lib/output');
const { safeMessage } = require('../scripts/lib/config');

function run(script, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DB_QUERY_') && !key.startsWith('MOCK_')));
  return spawnSync(process.execPath, ['-r', path.join(__dirname, 'mock-errors.cjs'), path.join(__dirname, '..', 'scripts', script), ...args], {
    env: { ...clean, ...env }, encoding: 'utf8',
  });
}

test('ZSET WITHSCORES uses pair limits without changing ordinary lists', () => {
  for (const command of [
    ['ZRANGE', 'k', '0', '-1', 'withscores'],
    ['ZRANGEBYSCORE', 'k', '0', '100', 'WITHSCORES', 'LIMIT', '0', '10'],
  ]) {
    const checked = validateRedisCommand(command, { maxItems: 1, allowUnbounded: true });
    assert.equal(checked.shape, 'pairs');
    assert.deepEqual(prepareRedisResult(['a', '1', 'b', '2'], checked.shape, checked.command, 1, 100),
      { result: ['a', '1'], count: 1, truncated: true });
    assert.deepEqual(prepareRedisResult(['a', '1'], checked.shape, checked.command, 1, 100),
      { result: ['a', '1'], count: 1, truncated: false });
    assert.deepEqual(prepareRedisResult([], checked.shape, checked.command, 1, 100),
      { result: [], count: 0, truncated: false });
  }
  assert.equal(validateRedisCommand(['ZRANGE', 'WITHSCORES', '0', '0'], { maxItems: 1 }).shape, 'list');
  assert.equal(validateRedisCommand(['ZRANGEBYSCORE', 'k', '0', '1', 'LIMIT', '0', '1'], { maxItems: 1 }).shape, 'list');
});

test('ZSET WITHSCORES CLI retains complete pairs and reports truncation in both formats', () => {
  for (const format of ['json', 'table']) {
    for (const command of [
      ['ZRANGE', 'k', '0', '-1', 'WITHSCORES'],
      ['ZRANGEBYSCORE', 'k', '0', '100', 'LIMIT', '0', '10', 'withscores'],
    ]) {
      const r = run('redis-query.js', ['--format', format, '--max-items', '1', '--allow-unbounded', '--', ...command],
        { MOCK_RESULT: '["member-a","1","member-b","2"]' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /1 item\(s\).*TRUNCATED/);
      if (format === 'json') {
        const data = JSON.parse(r.stdout);
        assert.deepEqual(data.result, ['member-a', '1']);
        assert.equal(data.count, 1);
        assert.equal(data.truncated, true);
      } else {
        assert.match(r.stdout, /member-a: 1/);
        assert.doesNotMatch(r.stdout, /member-b/);
        assert.match(r.stdout, /TRUNCATED/);
      }
    }
  }
});

test('safe errors expose only allowlisted codes, never server messages or unknown metadata', () => {
  const secret = 'secret-token SELECT private_data redis://user:password@host';
  for (const [err, expected] of [
    [{ code: 'ER_PARSE_ERROR', message: secret }, 'Query execution error [ER_PARSE_ERROR] (details hidden)'],
    [{ code: 'ECONNREFUSED', message: secret }, 'Connection failed [ECONNREFUSED] (details hidden)'],
    [{ message: 'WRONGTYPE ' + secret }, 'Query execution error [WRONGTYPE] (details hidden)'],
    [{ message: 'NOAUTH ' + secret }, 'Connection failed [NOAUTH] (details hidden)'],
    [{ code: 'ER_' + secret, message: secret }, 'Query execution error (details hidden)'],
    [{ code: secret, name: secret, message: secret }, 'Database operation failed (details hidden)'],
    [{ message: secret }, 'Database operation failed (details hidden)'],
  ]) assert.equal(safeMessage(err), expected);
});

test('both CLIs hide raw server errors for table and JSON modes', () => {
  const secret = 'secret-token SELECT private_data redis://user:password@host';
  for (const format of ['table', 'json']) {
    for (const [script, args, code, message, category] of [
      ['mysql-query.js', ['SELECT 1'], 'ER_PARSE_ERROR', secret, /Query execution error \[ER_PARSE_ERROR\]/],
      ['redis-query.js', ['--', 'GET', 'k'], '', 'WRONGTYPE ' + secret, /Query execution error \[WRONGTYPE\]/],
      ['redis-query.js', ['--', 'GET', 'k'], 'ECONNREFUSED', secret, /Connection failed \[ECONNREFUSED\]/],
      ['redis-query.js', ['--', 'GET', 'k'], 'unknown-' + secret, secret, /Database operation failed/],
    ]) {
      const r = run(script, ['--format', format, ...args], {
        DB_QUERY_MYSQL_USER: 'reader', MOCK_ERROR_CODE: code, MOCK_ERROR_MESSAGE: message,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, category);
      assert.match(r.stderr, /details hidden/);
      assert.equal(r.stdout, '');
      for (const part of ['secret-token', 'private_data', 'password@host']) assert.ok(!r.stderr.includes(part), r.stderr);
    }
  }
});

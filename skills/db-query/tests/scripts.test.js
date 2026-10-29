'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { prepareMysqlResult, prepareRedisResult } = require('../scripts/lib/output');

function run(script, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DB_QUERY_')));
  return spawnSync(process.execPath, ['-r', path.join(__dirname, 'mock-drivers.cjs'), path.join(root, 'scripts', script), ...args], {
    cwd: os.tmpdir(), env: { ...clean, ...env }, encoding: 'utf8',
  });
}
function config(result) {
  const match = result.stderr.match(/MOCK_CONFIG=(.*)/);
  assert.ok(match, result.stderr);
  return JSON.parse(match[1]);
}

test('SQL validation obeys CLI, env file, process env, then default row limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-'));
  const file = path.join(dir, 'config');
  try {
    fs.writeFileSync(file, 'DB_QUERY_MYSQL_MAX_ROWS=7\n', { mode: 0o600 });
    const env = { DB_QUERY_MYSQL_MAX_ROWS: '4' };
    for (const [args, expected] of [
      [[], 'LIMIT 201'], [[], 'LIMIT 5'], [['--env-file', file], 'LIMIT 8'],
      [['--env-file', file, '--max-rows', '2'], 'LIMIT 3'],
    ].entries()) {
      const [opts, limit] = expected;
      const result = run('mysql-query.js', [...opts, '--validate-only', 'SELECT 1'], args === 0 ? {} : env);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stderr.includes(limit), result.stderr);
    }
    assert.notEqual(run('mysql-query.js', ['--max-rows', '2', '--validate-only', 'SELECT 1 LIMIT 3']).status, 0);
    assert.notEqual(run('mysql-query.js', ['--validate-only', 'SELECT 1'], { DB_QUERY_MYSQL_MAX_ROWS: '5001' }).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Redis validation uses resolved item cap', () => {
  assert.notEqual(run('redis-query.js', ['--validate-only', '--', 'LRANGE', 'k', '0', '3'], { DB_QUERY_REDIS_MAX_ITEMS: '2' }).status, 0);
  assert.equal(run('redis-query.js', ['--max-items', '4', '--validate-only', '--', 'LRANGE', 'k', '0', '3'], { DB_QUERY_REDIS_MAX_ITEMS: '2' }).status, 0);
});

test('config reaches both drivers including env TLS, format, host and CLI overrides', () => {
  const mysql = run('mysql-query.js', ['--host', 'cli', 'SELECT 1'], {
    DB_QUERY_MYSQL_USER: 'reader', DB_QUERY_MYSQL_HOST: 'env', DB_QUERY_MYSQL_PORT: '3333',
    DB_QUERY_MYSQL_TLS: 'true', DB_QUERY_MYSQL_FORMAT: 'json', MOCK_RESULT: '[{"v":"ok"}]',
  });
  assert.equal(mysql.status, 0, mysql.stderr);
  assert.equal(config(mysql).host, 'cli'); assert.equal(config(mysql).port, 3333);
  assert.equal(config(mysql).ssl.rejectUnauthorized, true);
  assert.equal(JSON.parse(mysql.stdout).result[0].v, 'ok');
  const redis = run('redis-query.js', ['--', 'GET', 'k'], {
    DB_QUERY_REDIS_HOST: 'example', DB_QUERY_REDIS_PORT: '6380', DB_QUERY_REDIS_TLS: 'true',
    DB_QUERY_REDIS_FORMAT: 'json', MOCK_RESULT: '"ok"',
  });
  assert.equal(redis.status, 0, redis.stderr);
  assert.equal(config(redis).socket.host, 'example'); assert.equal(config(redis).socket.port, 6380);
  assert.equal(config(redis).socket.tls, true); assert.equal(JSON.parse(redis.stdout).result, 'ok');
});

test('connection options honor env-file precedence and explicit overrides', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-'));
  const file = path.join(dir, 'config');
  try {
    fs.writeFileSync(file, 'DB_QUERY_MYSQL_HOST=file-host\nDB_QUERY_MYSQL_PORT=3307\nDB_QUERY_MYSQL_USER=file-user\nDB_QUERY_MYSQL_TLS=true\n', { mode: 0o600 });
    const env = { DB_QUERY_MYSQL_HOST: 'env-host', DB_QUERY_MYSQL_USER: 'env-user', MOCK_RESULT: '[]' };
    const r = run('mysql-query.js', ['--env-file', file, '--port', '3308', '--tls=false', 'SELECT 1'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(config(r).host, 'file-host'); assert.equal(config(r).user, 'file-user');
    assert.equal(config(r).port, 3308); assert.equal(config(r).ssl, undefined);
    fs.chmodSync(file, 0o644);
    assert.notEqual(run('mysql-query.js', ['--env-file', file, '--validate-only', 'SELECT 1'], env).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bounded results report row, item, scan, pair and value truncation', () => {
  assert.deepEqual(prepareMysqlResult([{ v: 'abcdef' }, { v: 'x' }], 1, 3), { result: [{ v: 'abc…' }], count: 1, truncated: true });
  assert.equal(prepareMysqlResult([{ v: 'abcdef' }], 2, 3).truncated, true);
  assert.equal(prepareMysqlResult([{ v: { a: '123', b: '456' } }], 2, 8).truncated, true);
  assert.deepEqual(prepareMysqlResult([{ v: { n: 9n } }], 2, 100).result, [{ v: { n: '9' } }]);
  assert.deepEqual(prepareRedisResult(['a', '1', 'b', '2'], 'pairs', 'HGETALL', 1, 100), { result: ['a', '1'], count: 1, truncated: true });
  assert.deepEqual(prepareRedisResult(['42', ['a', '1', 'b', '2']], 'scan', 'HSCAN', 1, 100), { result: ['42', ['a', '1']], count: 1, truncated: true });
  assert.equal(prepareRedisResult('abcdef', 'scalar', 'GET', 1, 3).truncated, true);
  for (const format of ['json', 'table']) {
    const scalar = run('redis-query.js', ['--format', format, '--max-value-bytes', '256', '--', 'GET', 'k'], { MOCK_RESULT: JSON.stringify('x'.repeat(300)) });
    assert.equal(scalar.status, 0, scalar.stderr);
    assert.match(scalar.stderr, /TRUNCATED/);
    if (format === 'json') assert.equal(JSON.parse(scalar.stdout).truncated, true);
    else assert.match(scalar.stdout, /TRUNCATED/);
    const mysql = run('mysql-query.js', ['--format', format, '--max-rows', '1', 'SHOW TABLES'], {
      DB_QUERY_MYSQL_USER: 'reader', MOCK_RESULT: JSON.stringify([{ v: 'first' }, { v: 'second' }]),
    });
    assert.equal(mysql.status, 0, mysql.stderr);
    assert.match(mysql.stderr, /TRUNCATED/);
    if (format === 'json') { const data = JSON.parse(mysql.stdout); assert.equal(data.truncated, true); assert.equal(data.result.length, 1); }
    else assert.match(mysql.stdout, /TRUNCATED/);
    const r = run('redis-query.js', ['--format', format, '--max-items', '1', '--allow-unbounded', '--', 'HGETALL', 'k'], { MOCK_RESULT: '["a","1","b","2"]' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /TRUNCATED/);
    if (format === 'json') { const data = JSON.parse(r.stdout); assert.equal(data.truncated, true); assert.equal(data.result.length, 2); }
    else assert.match(r.stdout, /TRUNCATED/);
  }
});

test('SCAN table keeps both elements of each hash pair', () => {
  const r = run('redis-query.js', ['--max-items', '1', '--', 'HSCAN', 'k', '0'], { MOCK_RESULT: '["0",["field","value"]]' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /field/); assert.match(r.stdout, /value/);
  assert.doesNotMatch(r.stderr, /TRUNCATED/);
});

test('validators refuse writes, multiple statements, dangerous Redis and unbounded commands', () => {
  for (const sql of ['DELETE FROM users', 'SELECT 1; DELETE FROM users', 'SELECT 1 INTO OUTFILE "/tmp/a"']) {
    assert.notEqual(run('mysql-query.js', ['--validate-only', sql]).status, 0, sql);
  }
  for (const cmd of [['SET', 'x', 'y'], ['EXPIRE', 'x', '1'], ['KEYS', '*']]) {
    assert.notEqual(run('redis-query.js', ['--validate-only', '--', ...cmd]).status, 0, cmd.join(' '));
  }
});

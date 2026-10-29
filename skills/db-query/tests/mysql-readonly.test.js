'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateMysqlSql, ReadonlyError } = require('../scripts/lib/mysql-readonly');

const validate = (sql) => validateMysqlSql(sql, { maxRows: 10 });

test('all supported LIMIT forms accept one trailing semicolon without rewriting', () => {
  for (const clause of ['LIMIT 10', 'LIMIT 20, 10', 'LIMIT 10 OFFSET 20']) {
    for (const suffix of ['', ';', ';  \n']) {
      const sql = `SELECT 1 ${clause}${suffix}`;
      assert.deepEqual(validate(sql), { sql: sql.trimEnd(), kind: 'SELECT', limitInjected: false });
    }
  }
  assert.deepEqual(validate('SELECT 1;  '), { sql: 'SELECT 1 LIMIT 11', kind: 'SELECT', limitInjected: true });
  assert.equal(validate("SELECT ';' LIMIT 1;").sql, "SELECT ';' LIMIT 1;");
  assert.equal(validate('WITH c AS (SELECT 1 LIMIT 1) SELECT * FROM c LIMIT 10;').limitInjected, false);
});

test('trailing semicolons do not weaken LIMIT or single-statement checks', () => {
  for (const sql of [
    'SELECT 1 LIMIT 11;', 'SELECT 1 LIMIT 20, 11;', 'SELECT 1 LIMIT 11 OFFSET 0;',
    'SELECT 1 LIMIT ?;', 'SELECT 1 LIMIT @n;', 'SELECT 1 LIMIT 1+1;',
    'SELECT 1 LIMIT 1 OFFSET ?;', 'SELECT 1 LIMIT 1, 2, 3;', 'SELECT 1 LIMIT;',
    'SELECT 1 LIMIT 1;;', 'SELECT 1 LIMIT 1; SELECT 2', 'SELECT (1;)',
  ]) assert.throws(() => validate(sql), ReadonlyError, sql);
});

test('rejects qualified and quoted calls, including in metadata filters and subqueries', () => {
  for (const sql of [
    'SELECT app.f()', 'SELECT app.f12x()', 'SELECT `app`.f()', 'SELECT app.`f`()',
    'SELECT `f`()', 'SELECT "f"()', 'SELECT (SELECT app.f())',
    'SHOW TABLES WHERE app.f()', 'SELECT SLEEP(1)', 'SELECT `SLEEP`(1)',
  ]) assert.throws(() => validate(sql), ReadonlyError, sql);
  for (const sql of [
    'SELECT COUNT(*) FROM users', 'SELECT t.id FROM t WHERE t.id IN (1, 2)',
    'WITH c AS (SELECT 1) SELECT * FROM c', 'SHOW CREATE TABLE t',
  ]) assert.doesNotThrow(() => validate(sql), sql);
});

test('unknown unqualified functions remain a documented offline-validation limitation', () => {
  assert.equal(validate('SELECT custom_fn()').sql, 'SELECT custom_fn() LIMIT 11');
});

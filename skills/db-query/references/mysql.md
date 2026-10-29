<!-- [2026-09-05]-[translated to English (skill is now English-only)]-[content unchanged] -->
# MySQL Syntax Matrix & Query Recipes

## Allowed / Rejected Statement Matrix

### ✅ Allowed

| Statement type | Example | Notes |
|----------|------|------|
| `SELECT` | `SELECT id, name FROM users WHERE id = 42` | Most common |
| `WITH...SELECT` | `WITH c AS (SELECT 1) SELECT * FROM c` | CTE supported |
| `SHOW` | `SHOW TABLES`, `SHOW CREATE TABLE t` | Metadata queries |
| `DESCRIBE` / `DESC` | `DESC users`, `DESCRIBE users name` | Table structure |
| `EXPLAIN SELECT` | `EXPLAIN SELECT * FROM users` | EXPLAIN SELECT only, no ANALYZE |

### ❌ Rejected

| Statement type | Rejection reason |
|----------|----------|
| `INSERT / UPDATE / DELETE / REPLACE` | Write operations |
| `DROP / ALTER / CREATE / TRUNCATE / RENAME` | DDL |
| `GRANT / REVOKE` | Privilege management |
| `SET` | Session variable changes |
| `LOCK / UNLOCK TABLES` | Explicit locks |
| `CALL / EXECUTE` | Stored procedures |
| `LOAD DATA / INTO OUTFILE` | File operations |
| `START TRANSACTION / COMMIT / ROLLBACK` | Transaction control is managed by the script |
| `HANDLER` | Low-level table access interface |
| All comments (`#`, `-- `, `/* */`, `/*! */`, `/*+ */`) | Can nest malicious SQL |
| Backslash escapes (`\`) | Can craft dangerous syntax |
| Multiple statements (`;` separated) | Prevents concatenation injection |
| `FOR UPDATE` / `LOCK IN SHARE MODE` | Explicit locking |
| `SLEEP()` / `BENCHMARK()` / `GET_LOCK()` | Potential DoS |
| Qualified or quoted function calls, e.g. `app.f()` or `` `f`() `` | Cannot safely identify the function offline |
| `INTO OUTFILE` | Server-side file writes |
| `EXPLAIN ANALYZE` | Actually executes the query; blocked as a security trade-off |

### Common "legal" forms that get rejected, and alternatives

| Intent | Rejected form | Alternative |
|--------|-------------|----------|
| Query SQL with comments | `SELECT 1 /* comment */` | Remove the comment |
| Backticks + trailing comment | `` SELECT `id` FROM `t` -- comment `` | Remove the comment |
| Dynamic LIMIT (variables) | `PREPARE` + `EXECUTE` | Write a literal number |
| Execution analysis | `EXPLAIN ANALYZE SELECT ...` | Use `EXPLAIN SELECT ...` (no execution) |
| Multiple statements at once | `SELECT 1; SELECT 2` | Split into separate calls |
| Write inside a subquery | `SELECT (UPDATE ...)` | Not allowed; all writes are refused |

## Common read-only recipes

### Single record by primary key

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT id, username, email, status FROM users WHERE id = 42'
```

### Recent changes by time range

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb --max-rows=50 \
  "SELECT id, status, updated_at FROM orders WHERE updated_at >= '2024-06-01 00:00:00' ORDER BY updated_at DESC"
```

### Aggregate counts (grouped by status)

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb \
  'SELECT status, COUNT(*) AS cnt FROM users GROUP BY status ORDER BY cnt DESC'
```

### JOIN to verify related data

```bash
# Verify order ↔ user consistency
node ./scripts/mysql-query.js --user=reader --database=mydb --max-rows=30 \
  'SELECT o.id AS order_id, o.user_id, u.username, o.amount FROM orders o JOIN users u ON o.user_id = u.id WHERE o.status = "pending" ORDER BY o.created_at DESC'
```

### Execution plan

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb \
  'EXPLAIN SELECT * FROM orders WHERE user_id = 100 AND created_at >= "2024-01-01"'
```

### Table structure

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb 'DESCRIBE orders'

# or use SHOW
node ./scripts/mysql-query.js --user=reader --database=mydb 'SHOW CREATE TABLE orders'
```

### Connectivity test

```bash
node ./scripts/mysql-query.js --user=reader --database=mydb 'SELECT 1'
```

## LIMIT & truncation behavior

| Scenario | Behavior |
|------|------|
| SELECT/WITH/EXPLAIN has no top-level `LIMIT` | Script injects `LIMIT <max-rows + 1>` (default 201), to detect an extra row |
| SQL has `LIMIT n` with `n <= max-rows` | Executed as-is, including an optional trailing semicolon |
| SQL has `LIMIT n` with `n > max-rows` | Validation rejects it: LIMIT exceeds the cap |
| More than `max-rows` rows are returned, or a value is truncated | Output reports truncation; refine the query and re-run |

For example, `SELECT 1 LIMIT 10;` is accepted with `--max-rows=10`, while `SELECT 1;` becomes `SELECT 1 LIMIT 11`. An explicit `LIMIT` does not fetch an extra row, so reaching it alone cannot establish that more rows exist. `SHOW` and `DESCRIBE` are not rewritten; their output is bounded separately.

> ⚠️ The injected LIMIT limits returned rows, not server work: scans, joins, sorting, aggregation, subqueries and UNION processing may still be expensive. EXPLAIN receives a LIMIT on the explained SELECT, not necessarily a cap on plan rows. The driver buffers the complete returned result before row/value truncation, so output limits do not bound client memory or network transfer. SHOW and DESCRIBE can return large results, and even a single value can be large. Use narrow, indexed queries and assess server load separately.

## Field type output conventions

| MySQL type | Output form | Notes |
|------------|----------|------|
| INT / TINYINT / SMALLINT / MEDIUMINT | Number | Normal range |
| BIGINT | String | Avoids exceeding JS Number.MAX_SAFE_INTEGER |
| DECIMAL / NUMERIC | String | Avoids floating-point precision loss |
| FLOAT / DOUBLE | Number | Precision loss possible |
| DATE / DATETIME / TIMESTAMP | String | `dateStrings` mode, no timezone conversion |
| CHAR / VARCHAR / TEXT | String | As-is |
| JSON | Object or string | Depends on driver decoding and output format |
| BLOB / BINARY | Printable UTF-8 or base64 string | Buffers are base64 when not printable UTF-8 |
| NULL | `null` | null in JSON, NULL in table output |

## Offline validation

Use `--validate-only` to check SQL safety without connecting:

```bash
# Validate first, then execute
node ./scripts/mysql-query.js --validate-only 'SELECT id FROM users WHERE id = 42'
# Once it passes, drop --validate-only and execute
node ./scripts/mysql-query.js --user=reader --database=mydb 'SELECT id FROM users WHERE id = 42'
```

Validation covers: statement type allowlist, comments/backslash/multi-statement, selected dangerous function names, qualified or quoted function calls, and LIMIT compliance.

### Stored functions and UDFs

Offline validation cannot resolve unqualified function names to built-ins, stored functions, or UDFs, and the dangerous-name list is not exhaustive. For example, `SELECT custom_fn()` may pass even if the function has side effects. Quoted and schema-qualified calls are rejected conservatively (this may also reject some non-call syntax involving quoted identifiers), but this is not a function allowlist or a security boundary. Views may invoke functions; routines, UDFs and triggers (where writes are permitted) can have indirect effects. A read-only transaction and attempted rollback cannot undo external UDF effects, nontransactional effects or actions in other sessions. Use a least-privilege account without unnecessary `EXECUTE` privileges, review view and routine definers and privileges, and only query trusted objects on servers with appropriately restricted UDFs. Do not rely on `--validate-only` to establish that arbitrary SQL is side-effect-free.

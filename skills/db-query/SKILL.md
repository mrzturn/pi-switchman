---
name: db-query
description: Read-only MySQL/Redis queries via built-in scripts — verify table records, cache keys/fields/TTL, and cross-store consistency. Trigger when the user asks to check or verify database data, including "run this SQL", "check the table", or any MySQL/Redis look-up. If the access address or credentials are unknown, stop and ask the user first; never search for them yourself. Refuse all writes, deletes, DDL, or TTL changes.
compatibility: Node.js 18+, npm, MySQL 5.7.8+/8.0, Redis 5+; dedicated read-only account required for shared/production environments
---

# Database Query & Verification

Query MySQL and Redis via built-in scripts for read-only debugging, data verification, and cache inspection.
**Core red line: refuse write requests.** The validators and MySQL read-only transaction are defense in depth, not a guarantee of no side effects; use trusted database objects and least-privilege accounts as described in [references/security.md](references/security.md).

## Trigger guide

| Scenario | Trigger? | Notes |
|------|----------|------|
| Query MySQL records / verify field values | ✅ | Read-only verification |
| Query Redis keys/values/TTL/fields | ✅ | Read-only verification |
| Verify MySQL ↔ Redis consistency | ✅ | Read both sides, then compare |
| Inspect table structure, indexes, execution plans | ✅ | SHOW / DESCRIBE / EXPLAIN |
| Count rows, aggregate analysis | ✅ | SELECT COUNT/SUM etc. |
| Insert/update/delete records | ❌ | Refuse; suggest a read-only verification plan |
| Create/alter/migrate tables | ❌ | Refuse; out of scope |
| Change Redis TTL | ❌ | Refuse; EXPIRE is a write command |
| Flush cache / delete keys | ❌ | Refuse; offer a read-only inspection instead |
| Export data to files | ❌ | Refuse (INTO OUTFILE is blocked); query and let the user handle results |

## Mandatory read-only rules

> **Highest priority.** Violating any item counts as a security violation.

1. **Missing access info → stop and ask**: if the database address or credentials are unknown, stop immediately and ask the user. Never search config files/history on your own, guess, or probe hosts/ports. Without explicit access info, refuse to act rather than act blindly.
2. **Built-in scripts only**: queries must go through `scripts/mysql-query.js` or `scripts/redis-query.js`; no fallback to `mysql` / `redis-cli` or ad-hoc code.
3. **Never bypass the validator**: do not circumvent SQL/command safety checks by any means other than `--validate-only`.
4. **Refuse all write requests**: on any write/modify/delete/DDL request, tell the user "this skill supports read-only verification only" and proactively offer a read-only alternative (e.g. "I can query the current value and status; you apply the change after confirming").
5. **Confirm non-local targets first**: before connecting to any database other than `127.0.0.1` / `localhost`, confirm the target address and purpose with the user.
6. **Read-only account in production**: production or shared environments must use a dedicated read-only MySQL account and Redis ACL user (ACLs require Redis 6+); see [references/security.md](references/security.md). Only query trusted MySQL views, routines and UDFs; `--validate-only`, a read-only transaction and rollback cannot prove a query has no side effects.

## Environment setup

Pi can invoke this skill explicitly with `/skill:db-query`. Resolve the actual skill directory from the path Pi provides for this `SKILL.md`, not from the user's working directory or a hard-coded checkout path. For the examples below, set `DB_QUERY_SKILL` to that absolute directory in the same shell; quote it as shown. Relative links in this file are relative to that directory.

Before first use and after updating the package, run:

```bash
# Set this to the directory containing the loaded SKILL.md:
DB_QUERY_SKILL='/absolute/path/to/installed/skills/db-query'
bash "$DB_QUERY_SKILL/scripts/setup.sh"
```

Setup checks Node.js 18+, runs `npm ci` using the skill's own lockfile inside that directory, and runs its tests. It does not install dependencies into the user's project. If the installed directory is not writable, ask the user to arrange a writable installation; do not silently install elsewhere. The JavaScript files may not have executable permissions: invoke them with `node` rather than executing them directly. Reference examples use `node ./scripts/...`; run them from the skill directory or replace the script path with a quoted absolute path, e.g. `node "$DB_QUERY_SKILL/scripts/mysql-query.js"`.

## Connection config & password safety

### Precedence

**CLI options > explicit `--env-file` > process env vars > defaults**

`--max-value-bytes` shares the env var `DB_QUERY_MAX_VALUE_BYTES` (common to MySQL/Redis).

### MySQL env vars

| CLI option | Env var | Default | Notes |
|----------|----------|--------|------|
| `--host` | `DB_QUERY_MYSQL_HOST` | `127.0.0.1` | Host |
| `--port` | `DB_QUERY_MYSQL_PORT` | `3306` | Port |
| `--user` | `DB_QUERY_MYSQL_USER` | **(required)** | Username; no root default |
| `--password` | `DB_QUERY_MYSQL_PASSWORD` | empty | Password; prefer env vars |
| `--database` | `DB_QUERY_MYSQL_DATABASE` | empty | Database name; if empty, only queries without a default db work (`SHOW DATABASES`, `SELECT 1`, db-prefixed tables) |
| `--tls` | `DB_QUERY_MYSQL_TLS` | `false` | Enable TLS |
| `--ca-file` | `DB_QUERY_MYSQL_CA_FILE` | — | CA certificate path |
| `--connect-timeout-ms` | `DB_QUERY_MYSQL_CONNECT_TIMEOUT_MS` | `5000` | Connect timeout (max 30000) |
| `--timeout-ms` | `DB_QUERY_MYSQL_TIMEOUT_MS` | `10000` | Query timeout (max 60000) |
| `--max-rows` | `DB_QUERY_MYSQL_MAX_ROWS` | `200` | Max rows returned (max 5000) |
| `--max-value-bytes` | `DB_QUERY_MAX_VALUE_BYTES` | `4096` | Max bytes per field value |
| `--format` | `DB_QUERY_MYSQL_FORMAT` | `table` | Output format: `table` / `json` |

### Redis env vars

| CLI option | Env var | Default | Notes |
|----------|----------|--------|------|
| `--host` | `DB_QUERY_REDIS_HOST` | `127.0.0.1` | Host |
| `--port` | `DB_QUERY_REDIS_PORT` | `6379` | Port |
| `--user` | `DB_QUERY_REDIS_USER` | unset | Explicit ACL username; requires a non-empty password |
| `--password` | `DB_QUERY_REDIS_PASSWORD` | empty | Password; prefer env vars |
| `--db` | `DB_QUERY_REDIS_DB` | `0` | Database number (connect option only; SELECT command is not exposed) |
| `--tls` | `DB_QUERY_REDIS_TLS` | `false` | Enable TLS |
| `--ca-file` | `DB_QUERY_REDIS_CA_FILE` | — | CA certificate path |
| `--connect-timeout-ms` | `DB_QUERY_REDIS_CONNECT_TIMEOUT_MS` | `5000` | Connect timeout (max 30000) |
| `--timeout-ms` | `DB_QUERY_REDIS_TIMEOUT_MS` | `10000` | Command timeout (max 60000) |
| `--max-items` | `DB_QUERY_REDIS_MAX_ITEMS` | `200` | Max items returned (max 5000) |
| `--max-value-bytes` | `DB_QUERY_MAX_VALUE_BYTES` | `4096` | Max bytes per value |
| `--format` | `DB_QUERY_REDIS_FORMAT` | `table` | Output format: `table` / `json` |

With neither username nor password, no AUTH is sent. A password alone uses `AUTH password` (including legacy Redis); an explicit username and password use `AUTH username password` (Redis 6+). An explicit username without a non-empty password is rejected rather than silently connecting as another user. The Redis timeout covers connection, command and graceful QUIT.

### Password safety

```bash
# ❌ Don't do this (password lands in shell history)
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=admin --password=secret --database=mydb 'SELECT 1'

# ✅ Recommended: env var
export DB_QUERY_MYSQL_PASSWORD=secret
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=admin --database=mydb 'SELECT 1'

# ✅ Recommended: env file (0600 permissions)
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --env-file="$HOME/.db-query.env" --user=admin --database=mydb 'SELECT 1'

# ✅ Recommended: same for Redis
export DB_QUERY_REDIS_PASSWORD=secret
node "$DB_QUERY_SKILL/scripts/redis-query.js" --db=0 -- GET user:42
```

## Standard workflow

1. **Confirm target and verification goal**: what to query (which table, fields, key) and why (bug investigation, deployment check, consistency). If the access address or credentials are unknown, stop and ask the user; never hunt for them yourself.
2. **Write the narrowest query**: prefer primary-key lookups over full scans; add time ranges and LIMIT where possible.
3. **Offline validation**: validate SQL/command syntax with `--validate-only` first to confirm it passes safety checks.
4. **Confirm non-local targets**: any non-local database must be confirmed with the user first.
5. **Execute**: run the script and read the output.
6. **Check truncation/timeouts**: if results are truncated (`[TRUNCATED]` marker) or time out, refine the query and re-run.
7. **Summarize findings and uncertainties**: state conclusions and clearly flag uncertainties (e.g. time-window inconsistencies, possible misses from truncation).

## MySQL query guide

### Invocation

```bash
node "$DB_QUERY_SKILL/scripts/mysql-query.js" [connection options] 'SELECT ...'
node "$DB_QUERY_SKILL/scripts/mysql-query.js" [connection options] --file=/abs/path.sql
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --validate-only 'SELECT ...'
```

### Allowed statements

| Type | Example |
|------|------|
| `SELECT` | `SELECT id, name FROM users WHERE id = 42` |
| `WITH...SELECT` (CTE) | `WITH cte AS (SELECT ...) SELECT * FROM cte` |
| `SHOW` | `SHOW TABLES`, `SHOW CREATE TABLE users` |
| `DESCRIBE` / `DESC` | `DESCRIBE users` |
| `EXPLAIN SELECT` | `EXPLAIN SELECT * FROM users WHERE id = 42` |

> Note: `EXPLAIN ANALYZE` is **not supported** (security trade-off).

### LIMIT & timeout rules

- For SELECT/WITH/EXPLAIN without a top-level `LIMIT`, the script injects `LIMIT <max-rows + 1>` (default 201) to detect truncation; SHOW and DESCRIBE are not rewritten.
- With `LIMIT` present, only **plain integers** are accepted (`LIMIT ?`, `LIMIT @a`, `LIMIT 1+1` and other expressions/placeholders/variables are rejected), and the count is checked against `--max-rows`; `LIMIT offset, count` and `LIMIT n OFFSET m` validate the count part.
- Query timeout defaults to 10000ms (adjustable via `--timeout-ms`, max 60000ms).

### Practical read-only examples

```bash
# Connectivity test
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb 'SELECT 1'

# Single record by primary key
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb \
  'SELECT id, username, status, created_at FROM users WHERE id = 42'

# Recent records by time range
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb --max-rows=50 \
  "SELECT id, status, updated_at FROM orders WHERE created_at >= '2024-01-01' ORDER BY created_at DESC"

# Aggregate counts
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb \
  'SELECT status, COUNT(*) AS cnt FROM users GROUP BY status'

# Table structure
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb 'DESCRIBE users'

# Execution plan
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb \
  'EXPLAIN SELECT * FROM orders WHERE user_id = 100'
```

## Redis query guide

### Invocation

Use `--` to separate connection options from the Redis command:

```bash
node "$DB_QUERY_SKILL/scripts/redis-query.js" [connection options] -- <command> [args...]
node "$DB_QUERY_SKILL/scripts/redis-query.js" --validate-only -- <command> [args...]
```

### Whitelist by category

| Category | Commands |
|------|------|
| **General** | PING, EXISTS, TYPE, TTL, PTTL, SCAN, KEYS†, DBSIZE, TIME |
| **String** | GET, MGET, STRLEN |
| **Hash** | HGET, HMGET, HEXISTS, HLEN, HGETALL†, HKEYS†, HVALS†, HSCAN |
| **List** | LINDEX, LLEN, LRANGE |
| **Set** | SISMEMBER, SCARD, SMEMBERS†, SSCAN |
| **ZSet** | ZCARD, ZCOUNT, ZSCORE, ZRANK, ZREVRANK, ZRANGE, ZRANGEBYSCORE, ZSCAN |
| **Server info** | INFO, CLIENT LIST, CONFIG GET |

> † Requires `--allow-unbounded` (in production prefer SCAN over KEYS/HGETALL and other full-key commands).

### TYPE/TTL first, then query by type

```bash
# Step 1: confirm the key exists and check its type
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- TTL user:42
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- TYPE user:42

# Step 2: pick the command by type
# if it's a hash
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- HGET user:42 name
node "$DB_QUERY_SKILL/scripts/redis-query.js" --allow-unbounded -- HGETALL user:42  # full dump
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- HSCAN user:42 0 COUNT 100  # incremental; COUNT is a hint

# if it's a string
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- GET user:42
```

### Safe per-type examples

```bash
# Connectivity test
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- PING

# String: batch-check keys
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- MGET config:timeout config:max-retry

# Hash: batched scan
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- HSCAN session:abc123 0 COUNT 50

# List: head/tail of a queue
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- LRANGE task:queue 0 9
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- LLEN task:queue

# Set: membership check
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- SISMEMBER online:users user:42
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- SCARD online:users

# ZSet: score range (LIMIT is required)
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- ZRANGEBYSCORE leaderboard 100 999 WITHSCORES LIMIT 0 100
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- ZRANK leaderboard user:42

# TTL check
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- TTL cache:homepage
# -1 = no expiry, -2 = key missing, >= 0 = seconds remaining
```

## Cross MySQL/Redis verification

Recommended steps for consistency checks:

1. **Get business keys from MySQL**: query the key set to verify first.
2. **Targeted Redis lookups**: check Redis per key (or batched); avoid `KEYS *` on the whole db.
3. **Compare differences**: compare values and TTL field by field.

```bash
# Step 1: recently updated user IDs from MySQL
node "$DB_QUERY_SKILL/scripts/mysql-query.js" --user=reader --database=mydb --max-rows=20 \
  "SELECT id, username, updated_at FROM users WHERE updated_at > '2024-06-01'"

# Step 2: verify each in Redis
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- GET user:1001
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- TTL user:1001
node "$DB_QUERY_SKILL/scripts/redis-query.js" -- TYPE user:1001
```

> ⚠️ **Time-window warning**: data may change between the two reads; you **cannot claim transactional consistency**. Always state "checked at <time>; concurrent changes possible in between" in conclusions.

## Output & error handling

### Output format

Controlled by `--format`:

| Format | Notes |
|------|------|
| `table` | Table output, human-readable |
| `json` | JSON output, machine-readable |

### Type conversion

- Date fields output as strings (`dateStrings` mode); no JS Date conversion.
- BIGINT / DECIMAL output as strings to avoid precision loss.
- MySQL JSON values may be decoded to objects; output formatting depends on the driver and format.
- Buffers are rendered as printable UTF-8 when possible, otherwise base64.

### Truncation markers

- When rows, items, or values are truncated, table output and status show `[TRUNCATED]`; JSON includes `truncated: true`.
- Results exceeding `--max-rows` (MySQL) / `--max-items` (Redis) are truncated for output.
- These are output limits, not memory, network or server-work limits: the drivers buffer the full returned result before formatting and truncation. Large values or replies (including SHOW/DESCRIBE, Redis GET, SCAN or unbounded commands) can consume substantial client memory. MySQL's injected LIMIT limits returned rows, not rows scanned, sorting, aggregation or other work. Redis SCAN COUNT is only a hint. Prefer narrow indexed queries, small values and bounded ranges; assess server load separately.
- On truncation, refine the query and re-run; **never draw conclusions from truncated results**. For a truncated Redis SCAN page, do not advance to its returned cursor: omitted entries cannot be recovered by continuing from it. Retry the original cursor with a narrower pattern or a higher `--max-items` (up to 5000); `COUNT` is only a server hint.

### Error output

Database and driver errors suppress raw messages and stacks, which may contain sensitive data:

- **Connection failed [code]** — recognized connection/auth/handshake errors (e.g. `ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, `WRONGPASS`).
- **Query execution error [code]** — recognized SQL/command errors (e.g. `ER_BAD_FIELD_ERROR`, `ER_PARSE_ERROR`, `WRONGTYPE`). Unknown codes use a generic category without the code.
- SQL/command validation failures print the concrete rejection reason and may include user-supplied arguments.

> **"Connection failed" → investigate network/credentials; "query execution error" → check the SQL/command and permissions.**

## Post-run self-check

After every execution, verify:

- [ ] **Read-only**: SQL is SELECT/SHOW/DESCRIBE/EXPLAIN; Redis command is whitelisted.
- [ ] **Right target**: connected to the intended db/instance, not production (unless explicitly confirmed).
- [ ] **No truncation**: results not truncated (`[TRUNCATED]` marker); re-query if they were.
- [ ] **Conclusions hold**: results actually support the claim; flag any uncertainties.
- [ ] **Sensitive data**: mask as needed when reporting (phone numbers, password hashes, etc.).

## Language

Follow [../_shared/language.md](../_shared/language.md) for output language. An explicit user language preference takes priority. Keep these operational instructions in English.

## References

- [references/security.md](references/security.md) — read-only security model in depth
- [references/mysql.md](references/mysql.md) — MySQL syntax matrix & query recipes
- [references/redis.md](references/redis.md) — Redis command whitelist & query patterns

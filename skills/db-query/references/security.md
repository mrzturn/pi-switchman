<!-- [2026-09-05]-[translated to English (skill is now English-only)]-[content unchanged] -->
# Read-Only Security Model

The skill refuses write requests and uses multiple layers of defense, but **neither validation nor a read-only transaction and rollback guarantee absence of side effects**. Production and shared environments require dedicated least-privilege accounts and trusted database objects; application checks cannot replace server-side controls.

## Threat model & attack surface

### Who can trigger this skill

- A user asking (via conversation) to query the database → the agent invokes the script
- A user unintentionally or deliberately passing SQL/commands containing writes

### Attack surface

1. **SQL injection**: achieving writes via SQL syntax (nested comments, newlines inside strings, etc.)
2. **Dangerous functions**: calling `SLEEP()`, `BENCHMARK()`, `GET_LOCK()` etc. through a legal SELECT (DoS)
3. **Multi-statement injection**: concatenating write statements with semicolons
4. **Redis command injection**: executing write commands via arguments or variants

## MySQL three-layer defense

### Layer 1: SQL lexical scanner

Before connecting, the script lexically scans the raw SQL text.

**Allowed statement types:**
- `SELECT ...`
- `WITH ... SELECT ...` (CTE)
- `SHOW ...`
- `DESCRIBE` / `DESC ...`
- `EXPLAIN SELECT ...`

**Rejected writes:** INSERT / UPDATE / DELETE / REPLACE / DROP / ALTER / CREATE / TRUNCATE / RENAME / GRANT / REVOKE / SET / LOCK / UNLOCK / CALL / LOAD DATA etc.

**Rejected comment forms (all banned, including legal SQL inside comments):**
- `#` single-line comment
- `-- ` (double dash + space) single-line comment
- `/* */` multi-line comment
- `/*! */` MySQL version comment
- `/*+ */` optimizer hint

> **Why ban comments?** Comments can nest malicious SQL (e.g. `SELECT 1; /* */ DROP TABLE x;`) and hide version-specific syntax. A lexical scanner cannot safely parse comment contents, so they are rejected outright.

**Additional restrictions:**
- No backslash escapes (`\`) — prevents crafting legal-but-dangerous syntax via escapes
- No multi-statements (`;` separated) — prevents concatenated writes
- No `INTO OUTFILE` (exports to the server filesystem)
- No `FOR UPDATE` / `LOCK IN SHARE MODE` (explicit locking)
- Reject selected potential DoS functions such as `SLEEP()` / `BENCHMARK()` / `GET_LOCK()`; the list is not exhaustive
- Inject a top-level `LIMIT` for SELECT/WITH/EXPLAIN when absent; this limits returned rows, not server work or full scans

> **Why a lexical scanner instead of regex?** Regex cannot reliably handle SQL string literals, identifier quoting (backticks), and operator ambiguity. A token-by-token scanner is more reliable than regex, yet it is still not a full SQL parser — complex but legal SQL may be rejected. That is a security trade-off.

### Layer 2: connection-level protection

Once connected:
- `multipleStatements: false`: the mysql2 driver explicitly disables multi-statement execution; even if the scanner misses a semicolon, subsequent statements never run
- `START TRANSACTION READ ONLY`: MySQL restricts transactional writes, but permits some changes to temporary tables and cannot prevent every side effect
- The script attempts `ROLLBACK` in cleanup, even after errors, and never explicitly commits; rollback can fail and cannot undo nontransactional or external effects

> **Limits of this layer:** An unqualified `SELECT custom_fn()` may pass validation but invoke a stored function or UDF. The scanner cannot resolve names or inspect view definitions, routines, UDFs or their dependencies. Views can invoke functions; routines or other indirectly invoked objects may cause effects, and triggers may run as a consequence of writes where permitted. Read-only transactions and rollback do not undo external UDF effects, nontransactional effects, or actions in other sessions. Inspect and trust the actual objects and server configuration; do not treat an accepted query as proof of safety.

### Layer 3: account-level privileges

**Required in production/shared environments**: a dedicated least-privilege MySQL account, limited to the specific data and metadata needed, with no unnecessary write, administrative or `EXECUTE` privileges. Grant `EXECUTE` only for reviewed routines when needed. Privileges needed for views and routines depend on their security context (including definer privileges); UDF availability and external capabilities require separate server-side controls. Review view definitions, definers, routines, UDFs, triggers and their dependencies with a DBA. Even a SELECT-only caller is not proof that invoked code has no side effects.

> ⚠️ **The admin commands below are for DBAs only; this skill's scripts never execute them:**

```sql
-- Read-only account setup example (for reference only)
CREATE USER 'db_query_reader'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT, SHOW VIEW ON `mydb`.* TO 'db_query_reader'@'%';
FLUSH PRIVILEGES;
```

## Redis security model

### Whitelist design

Redis uses a **command whitelist**, not a blacklist.

**Why a whitelist?**
- A blacklist must enumerate every dangerous command, but Redis keeps adding new ones and Redis Modules can register custom commands. A whitelist rejects unknown commands by default (fail-closed) — safer.
- Blacklists are easily bypassed by new/module commands.

### Allowed commands (full list)

| Category | Commands | Notes |
|------|------|------|
| **General** | PING, GET, MGET, EXISTS, TYPE, TTL, PTTL, STRLEN, SCAN, KEYS†, DBSIZE, TIME | |
| **Hash** | HGET, HMGET, HEXISTS, HLEN, HGETALL†, HKEYS†, HVALS†, HSCAN | |
| **List** | LINDEX, LLEN, LRANGE | |
| **Set** | SISMEMBER, SCARD, SMEMBERS†, SSCAN | |
| **ZSet** | ZCARD, ZCOUNT, ZSCORE, ZRANK, ZREVRANK, ZRANGE, ZRANGEBYSCORE, ZSCAN | |
| **Server info** | INFO, CLIENT LIST, CONFIG GET | CONFIG GET limited to listed items |

> † Requires `--allow-unbounded`. These can block Redis on big keys; prefer SCAN in production.

### Rejected commands

Everything not on the whitelist is rejected (fail-closed), including but not limited to:
- **Write commands**: SET, DEL, EXPIRE, INCR, DECR, HSET, LPUSH, SADD, ZADD, PFADD etc.
- **Dangerous commands**: FLUSHALL, FLUSHDB, SHUTDOWN, DEBUG, EVAL, EVALSHA, SCRIPT
- **Admin commands**: CONFIG SET, RENAME, MOVE, RESTORE, MIGRATE, SORT (may write to external storage)
- **Unrecognized commands**: including those registered by Redis Modules

### db is chosen via connection config

The Redis `db` number can only be set through the `--db` connection option; the **`SELECT` command is not exposed**.
This prevents switching databases mid-query and avoids touching the wrong db.

### Gate mechanism for KEYS and other big commands

`KEYS`, `HGETALL`, `HKEYS`, `HVALS`, `SMEMBERS` can block Redis for a long time on big keys (single-threaded model).
They are rejected by default and require an explicit `--allow-unbounded`, forcing awareness of the risk.

**Production alternative — SCAN-family commands:**
- `KEYS pattern` → `SCAN 0 MATCH pattern COUNT 100`
- `HGETALL key` → `HSCAN key 0 COUNT 100`
- `SMEMBERS key` → `SSCAN key 0 COUNT 100`

### CONFIG GET safe-parameter whitelist

`CONFIG GET` permits only the parameters listed in [redis.md](redis.md#config-get-safe-parameter-whitelist). It is not gated by `--allow-unbounded`. Sensitive items such as `requirepass` and `masterauth` are rejected, but permitted configuration and other metadata can still be sensitive.

### Redis ACL as the final server-side boundary

**Required in production/shared environments**: a dedicated Redis ACL user for queries. The following is illustrative, not a minimal ACL: restrict keys and commands to those actually needed, and account for the Redis version and server configuration:
```
# Redis ACL example (for DBAs/ops only)
ACL SETUSER db_query_reader on >password ~* +@read +ping +info +client|list +config|get
```

> ⚠️ A client-side timeout (`--timeout-ms`) only closes the client socket; it **does not cancel the command running server-side**. If a command takes too long on the server (e.g. `KEYS *` over a million keys), Redis keeps executing it after the client disconnects, blocking other requests meanwhile. This is inherent to Redis's single-threaded model, which is why the script gates dangerous commands client-side.

## Credentials & TLS conventions

### Password safety

- **No CLI `--password`**: command-line arguments land in shell history (`~/.bash_history` / `~/.zsh_history`) and may be readable by others.
- **Recommended**:
  1. Environment variables (`DB_QUERY_MYSQL_PASSWORD` / `DB_QUERY_REDIS_PASSWORD`)
  2. Env file (`--env-file=<path>`) with `0600` permissions
- Scripts never echo passwords in output.

### TLS

- Both MySQL and Redis support `--tls` for encrypted connections.
- `--ca-file` specifies a CA certificate for server identity verification.
- **Enable TLS** for cross-network connections in production.

## Error output

Database and driver error messages can include SQL, key names, credentials, or other server data. By default both scripts suppress the raw message and stack in table and JSON modes. They report a connection or query error with a fixed allowlisted code when recognized; otherwise they use a generic failure message. Redis reply prefixes are recognized only from a fixed list. Unknown codes and error names are not printed. Local CLI, validation, and configuration errors remain descriptive and may include user-supplied arguments; avoid putting secrets in those arguments. Target details and successful query results are still displayed and should be handled as sensitive data.

## Failure mode: fail-closed

The validators reject unsupported statement types and Redis commands rather than falling back to another client. The SQL scanner accepts many tokens and unqualified function names it cannot resolve; it is not a complete parser or a fail-closed proof of safety. Client timeouts destroy the connection but do not guarantee that server-side work or side effects stop.

## Known limitations

| Limitation | Impact | Mitigation |
|------|------|------|
| Lexer is not a full SQL parser | Complex but legal SQL (comments, backslash escapes, dynamic LIMIT, EXPLAIN ANALYZE) is rejected | Security trade-off; no lenient fallback added |
| MySQL `MAX_EXECUTION_TIME` only on 5.7.8+/8.0 | Query timeout not guaranteed on MariaDB | Dedicated read-only account + connection-level timeout as backstop |
| Output limits are applied after buffering | Large replies can exhaust client memory; limits do not bound server work | Narrow queries and ranges; avoid big values and unbounded commands |
| Redis client timeout doesn't cancel server-side commands | Big-key commands can keep blocking Redis | Gate dangerous commands client-side; restrict via ACL server-side |
| Application-layer checks can't replace DB privileges | A script bug could bypass client-side checks | Dedicated read-only account + ACL mandatory in production/shared environments |

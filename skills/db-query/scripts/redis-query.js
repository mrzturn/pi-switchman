#!/usr/bin/env node
'use strict';

/**
 * Redis read-only query entry point
 * Pipeline: CLI parsing → command allowlist validation → connect → sendCommand → output → close
 * Security: the db is selected only via connection config (the SELECT command is not exposed);
 *           a client-side timer destroys the socket on timeout;
 *           a Redis ACL read-only user is the final server-side boundary
 */

const { createClient } = require('redis');

// ── Internal modules ──
const { parseCli, CliError } = require('./lib/cli');
const { loadEnvFile, resolveEnv, resolveEnvNumber, resolveEnvBoolean, resolveEnvFormat, ConfigError, sanitizeTarget, safeMessage, buildTlsOptions } = require('./lib/config');
const { validateRedisCommand, RedisReadonlyError } = require('./lib/redis-readonly');
const { formatRedisTable, prepareRedisResult } = require('./lib/output');

// ── CLI option spec ──
const REDIS_SPEC = {
  host:              { type: 'string', default: '127.0.0.1' },
  port:              { type: 'integer', default: 6379, min: 1, max: 65535 },
  user:              { type: 'string', default: 'default' },
  password:          { type: 'string', default: undefined },
  db:                { type: 'integer', default: 0, min: 0, max: 15 },
  tls:               { type: 'boolean', default: false },
  'ca-file':         { type: 'string', default: undefined },
  'connect-timeout-ms': { type: 'integer', default: 5000, min: 1000, max: 30000 },
  'timeout-ms':      { type: 'integer', default: 10000, min: 1000, max: 60000 },
  'max-items':       { type: 'integer', default: 200, min: 1, max: 5000 },
  'max-value-bytes': { type: 'integer', default: 4096, min: 256, max: 1048576 },
  format:            { type: 'string', default: 'table', choices: ['table', 'json'] },
  'env-file':        { type: 'string', default: undefined },
  'validate-only':   { type: 'boolean', default: false },
  'allow-unbounded': { type: 'boolean', default: false },
};

const ENV_PREFIX = 'DB_QUERY_REDIS_';

// ── Main ──
async function main() {
  const spec = Object.fromEntries(Object.entries(REDIS_SPEC).map(([key, value]) =>
    [key, ['validate-only', 'allow-unbounded', 'env-file'].includes(key) ? value : { ...value, default: undefined }]));
  const { options, rest } = parseCli(process.argv.slice(2), spec);

  // A Redis command must follow --
  if (rest.length === 0) {
    throw new CliError('A Redis command must follow -- (e.g. -- GET key)');
  }

  const envPairs = loadEnvFile(options['env-file']);
  const maxItemsResolved = resolveEnvNumber(envPairs, ENV_PREFIX + 'MAX_ITEMS', options['max-items'], { min: 1, max: 5000 }) ?? 200;

  // Command allowlist validation (before any connection setup)
  const validated = validateRedisCommand(rest, {
    maxItems: maxItemsResolved,
    allowUnbounded: options['allow-unbounded'],
  });

  // --validate-only: pure offline validation, no connection
  if (options['validate-only']) {
    process.stderr.write(`✓ Command validation passed: ${validated.command} ${validated.args.join(' ')}\n`);
    process.stderr.write(`Output shape: ${validated.shape}${validated.unbounded ? ' (unbounded)' : ''}\n`);
    return;
  }

  // Merge environment overrides (resolveEnvNumber uniformly enforces bounds,
  // so env files cannot bypass hard limits)
  const host = resolveEnv(envPairs, ENV_PREFIX + 'HOST', options.host) ?? '127.0.0.1';
  const port = resolveEnvNumber(envPairs, ENV_PREFIX + 'PORT', options.port, { min: 1, max: 65535 }) ?? 6379;
  const configuredUser = resolveEnv(envPairs, ENV_PREFIX + 'USER', options.user);
  const user = configuredUser ?? 'default';
  const password = resolveEnv(envPairs, ENV_PREFIX + 'PASSWORD', options.password);
  if (configuredUser !== undefined && (!configuredUser || !password)) {
    throw new ConfigError('An explicit Redis username and password must both be non-empty');
  }
  const db = resolveEnvNumber(envPairs, ENV_PREFIX + 'DB', options.db, { min: 0, max: 15 }) ?? 0;
  const maxValueBytesResolved = resolveEnvNumber(envPairs, 'DB_QUERY_MAX_VALUE_BYTES', options['max-value-bytes'], { min: 256, max: 1048576 }) ?? 4096;
  const timeoutMsResolved = resolveEnvNumber(envPairs, ENV_PREFIX + 'TIMEOUT_MS', options['timeout-ms'], { min: 1000, max: 60000 }) ?? 10000;
  const connectTimeoutMs = resolveEnvNumber(envPairs, ENV_PREFIX + 'CONNECT_TIMEOUT_MS', options['connect-timeout-ms'], { min: 1000, max: 30000 }) ?? 5000;
  const tls = resolveEnvBoolean(envPairs, ENV_PREFIX + 'TLS', options.tls) ?? false;
  const caFile = resolveEnv(envPairs, ENV_PREFIX + 'CA_FILE', options['ca-file']);
  const format = resolveEnvFormat(envPairs, ENV_PREFIX + 'FORMAT', options.format) ?? 'table';

  // Print sanitized target
  const target = sanitizeTarget({ host, port, user, database: db });
  process.stderr.write(`→ Redis ${target}\n`);

  // Build the node-redis v4 client
  const clientConfig = {
    socket: {
      host,
      port,
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: false,
      // TLS
      ...(tls || caFile
        ? { tls: true, ...(buildTlsOptions(caFile) || { rejectUnauthorized: true }) }
        : {}),
    },
    database: db,
    ...(password ? { password, ...(configuredUser ? { username: configuredUser } : {}) } : {}),
  };

  const client = createClient(clientConfig);

  // node-redis emits errors independently of rejected operation promises.
  // Never print the event: it can contain server messages or credentials.
  client.on('error', () => {});

  let timedOut = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error('Redis operation timed out');
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMsResolved);
  });

  try {
    const operation = (async () => {
      await client.connect();
      if (timedOut) return;

      // Pass arguments separately and preserve bulk-string bytes. CLIENT LIST
      // is textual and its result formatter counts/truncates lines as strings.
      const cmdArgs = [validated.command, ...validated.args.map(String)];
      const startMs = Date.now();
      const result = await client.sendCommand(cmdArgs, { returnBuffers: validated.shape !== 'client_list' });
      const elapsedMs = Date.now() - startMs;
      if (timedOut) return;

      // v4 quit() marks the socket closed before receiving the reply, making
      // disconnect() unable to abort a hung QUIT. Send it as a command instead.
      await client.sendCommand(['QUIT']);
      return { result, elapsedMs };
    })();
    const { result, elapsedMs } = await Promise.race([operation, deadline]);

    const output = prepareRedisResult(result, validated.shape, validated.command, maxItemsResolved, maxValueBytesResolved);
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ source: 'redis', target, elapsedMs, ...output }, null, 2) + '\n');
    } else {
      process.stdout.write(formatRedisTable(output.result, {
        shape: validated.shape,
        command: validated.command,
        maxItems: maxItemsResolved,
        maxValueBytes: Infinity, // already bounded above
      }) + (output.truncated ? '\n⚠ [TRUNCATED] Items or values were omitted; refine the query.' : '') + '\n');
    }

    process.stderr.write(`✓ ${output.count} item(s)${output.truncated ? ' [TRUNCATED]' : ''} in ${elapsedMs}ms\n`);
  } finally {
    clearTimeout(timer);
    // disconnect() is the v4 force-close API. It may reject if connect failed.
    if (client.isOpen) await client.disconnect().catch(() => {});
  }
}

main().catch(e => {
  // Validation/config errors show their message directly (not connection
  // errors, no sanitizing needed)
  if (e instanceof CliError || e instanceof RedisReadonlyError || e instanceof ConfigError) {
    process.stderr.write('✗ ' + e.message + '\n');
  } else {
    process.stderr.write('✗ ' + safeMessage(e) + '\n');
  }
  process.exit(1);
});

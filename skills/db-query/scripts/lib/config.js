'use strict';

/**
 * Configuration: env file / environment variables / sanitizing / safe error formatting
 * Only dotenv.parse() is used so process.env stays untouched; env file
 * permissions are checked on POSIX
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// ── Env file loading (does not touch process.env) ──

/**
 * Load the given env file and return key/value pairs
 * Never reads .env from cwd to avoid accidental leaks; rejects outright when
 * group/other can read it (credential safety)
 * @param {string|undefined} envFile - env file path
 * @returns {object} key/value pairs
 */
function loadEnvFile(envFile) {
  if (!envFile) return {};
  const resolved = path.resolve(envFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Env file not found: ${resolved}`);
  }

  // Check group/other permissions on POSIX: if other local users can read the
  // file the password leaks — reject outright
  try {
    const stat = fs.statSync(resolved);
    // eslint-disable-next-line no-bitwise
    if ((stat.mode & 0o077) !== 0) {
      throw new ConfigError(`Env file ${resolved} permissions too broad (accessible by group/other), run chmod 600`);
    }
  } catch (e) {
    // Only skip the permission-check error on Windows and other non-POSIX
    // systems; rethrow everything else (permissions too broad)
    if (e.message.includes('permissions too broad')) throw e;
  }

  const content = fs.readFileSync(resolved, 'utf8');
  return dotenv.parse(content);
}

/**
 * Read a config value with SKILL.md precedence: CLI > env file > process env > undefined
 * @param {object} envPairs - dotenv.parse() result (explicit --env-file, permission-controlled)
 * @param {string} envKey - environment variable name (e.g. DB_QUERY_MYSQL_HOST)
 * @param {*} cliValue - value from the CLI; undefined means not given on the CLI
 * @returns {*} CLI first, then env file, then process env, otherwise undefined
 */
function resolveEnv(envPairs, envKey, cliValue) {
  if (cliValue !== undefined) return cliValue;
  // Env file first (explicitly given, permission-controlled 0600), then the
  // process environment (loadEnvFile deliberately leaves process.env
  // untouched, so fall back to it here or `export DB_QUERY_*` would not work)
  if (envPairs[envKey] !== undefined) return envPairs[envKey];
  if (process.env[envKey] !== undefined) return process.env[envKey];
  return undefined;
}

/**
 * Parse a number from env/CLI and validate min/max bounds
 * Every source (CLI / env file / environment) runs the same bounds check so
 * an env file cannot bypass hard limits
 *
 * @param {object} envPairs - dotenv.parse() result
 * @param {string} envKey - environment variable name
 * @param {*} cliValue - value from the CLI (bounds already checked by cli.js)
 * @param {object} bounds - { min?: number, max?: number }
 * @returns {number}
 */
class ConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'ConfigError'; }
}

function resolveEnvNumber(envPairs, envKey, cliValue, bounds) {
  // CLI source: cli.js coerceValue already checked the bounds, return as-is
  if (cliValue !== undefined) return cliValue;
  // Env file first, then process env (same precedence as resolveEnv, per the
  // SKILL.md contract); env-sourced values are parsed and bounds-checked
  // uniformly so env cannot bypass hard limits
  const raw = envPairs[envKey] !== undefined ? envPairs[envKey] : process.env[envKey];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`Environment variable ${envKey}=${raw} is not a valid integer`);
  }
  if (bounds && bounds.min !== undefined && n < bounds.min) {
    throw new ConfigError(`Environment variable ${envKey}=${n} is below the minimum ${bounds.min}`);
  }
  if (bounds && bounds.max !== undefined && n > bounds.max) {
    throw new ConfigError(`Environment variable ${envKey}=${n} exceeds the maximum ${bounds.max}`);
  }
  return n;
}

function resolveEnvBoolean(envPairs, envKey, cliValue) {
  const value = resolveEnv(envPairs, envKey, cliValue);
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new ConfigError(`Environment variable ${envKey} must be true or false`);
}

function resolveEnvFormat(envPairs, envKey, cliValue) {
  const value = resolveEnv(envPairs, envKey, cliValue);
  if (value === undefined) return undefined;
  const format = String(value).toLowerCase();
  if (!['table', 'json'].includes(format)) throw new ConfigError(`Environment variable ${envKey} must be table or json`);
  return format;
}

// ── Connection target sanitizing ──

/**
 * Build sanitized connection target info; never includes the password or a
 * password-bearing URI
 * @param {object} opts - { host, port, user, database }
 * @returns {string}
 */
function sanitizeTarget(opts) {
  const parts = [`host=${opts.host || '127.0.0.1'}`, `port=${opts.port}`];
  if (opts.user) parts.push(`user=${opts.user}`);
  if (opts.database !== undefined) parts.push(`db=${opts.database}`);
  return parts.join(', ');
}

// ── Safe error formatting ──

// Connection/auth/handshake error codes — classified as "connection failure",
// clearly distinct from query execution errors
const CONNECTION_CODES = new Set([
  // Node network and system errors
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'EDESTADDRREQ',
  // DNS resolution errors
  'EAI_AGAIN', 'EAI_NONAME', 'EAI_SERVICE', 'EAI_FAIL', 'EAI_BADFLAGS',
  // TLS errors
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  // mysql2 connection/handshake/db-selection stage
  'HANDSHAKE_ERROR', 'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR', 'ER_BAD_HOST_ERROR',
  // Redis auth stage
  'WRONGPASS', 'NOAUTH',
]);

// node-redis command execution error codes (distinct from the connection stage)
const REDIS_EXEC_CODES = new Set([
  'ERR', 'WRONGTYPE', 'WRONGINT', 'WRONGBIT', 'WRONGKEY',
  'EXECABORT', 'NOREPLICAS', 'MISCONF', 'BUSYGROUP', 'NOGROUP',
  'LOADING', 'MASTERDOWN', 'READONLY', 'MOVED', 'ASK', 'CROSSSLOT',
  'NOSCRIPT', 'BUSYKEY', 'NOSUBKEY',
]);

// Only fixed, known codes may be echoed; unknown codes can themselves contain data.
const MYSQL_EXEC_CODES = new Set([
  'ER_BAD_FIELD_ERROR', 'ER_PARSE_ERROR', 'ER_NO_SUCH_TABLE',
  'ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_QUERY_TIMEOUT', 'ER_QUERY_INTERRUPTED', 'ER_WRONG_ARGUMENTS',
]);

/**
 * Server and driver messages may contain query text, key names, or secrets.
 * Report only a recognized fixed code and category, never the raw message.
 * Redis reply errors often have no code property, so recognize their first
 * token only when it is on the fixed allowlist.
 * @param {Error} err
 * @returns {string}
 */
function safeMessage(err) {
  let code = typeof err?.code === 'string' ? err.code : '';
  if (!code && typeof err?.message === 'string') {
    const match = /^(\S+)(?:\s|$)/.exec(err.message);
    if (match && (CONNECTION_CODES.has(match[1]) || REDIS_EXEC_CODES.has(match[1]))) code = match[1];
  }
  if (CONNECTION_CODES.has(code)) return `Connection failed [${code}] (details hidden)`;
  if (MYSQL_EXEC_CODES.has(code) || REDIS_EXEC_CODES.has(code)) {
    return `Query execution error [${code}] (details hidden)`;
  }
  if (code.startsWith('ER_')) return 'Query execution error (details hidden)';
  return 'Database operation failed (details hidden)';
}

// ── TLS options ──

/**
 * Build TLS options from a ca-file path
 * @param {string|undefined} caFile
 * @returns {object|undefined}
 */
function buildTlsOptions(caFile) {
  if (!caFile) return undefined;
  const resolved = path.resolve(caFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CA certificate file not found: ${resolved}`);
  }
  const ca = fs.readFileSync(resolved);
  return { ca, rejectUnauthorized: true };
}

module.exports = {
  loadEnvFile,
  resolveEnv,
  resolveEnvNumber,
  resolveEnvBoolean,
  resolveEnvFormat,
  ConfigError,
  sanitizeTarget,
  safeMessage,
  buildTlsOptions,
};

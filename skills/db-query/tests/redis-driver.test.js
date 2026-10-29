'use strict';

// Exercise the installed node-redis driver over a local RESP server, not a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '../scripts/redis-query.js');
const secret = 'private-password-and-server-details';

function bulk(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n')]);
}
function array(values) {
  return Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values.map(bulk)]);
}

// Commands sent by node-redis are RESP arrays of bulk strings. Keep partial
// frames until the next data event, and allow several commands per packet.
function parseCommand(buffer) {
  const line = (offset) => {
    const end = buffer.indexOf('\r\n', offset);
    return end < 0 ? null : [buffer.toString('utf8', offset, end), end + 2];
  };
  const header = line(0);
  if (!header) return null;
  assert.match(header[0], /^\*\d+$/);
  let pos = header[1];
  const args = [];
  for (let i = 0; i < Number(header[0].slice(1)); i++) {
    const size = line(pos);
    if (!size) return null;
    assert.match(size[0], /^\$\d+$/);
    const length = Number(size[0].slice(1));
    pos = size[1];
    if (buffer.length < pos + length + 2) return null;
    args.push(buffer.toString('utf8', pos, pos + length));
    pos += length + 2;
  }
  return { args, bytes: pos };
}

async function serverFor(handler) {
  const commands = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      let parsed;
      while ((parsed = parseCommand(pending))) {
        pending = pending.subarray(parsed.bytes);
        commands.push(parsed.args);
        handler(parsed.args, socket);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port, commands,
    get connections() { return sockets.size; },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function run(port, args = [], env = {}) {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DB_QUERY_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--port', String(port), '--timeout-ms', '1000', ...args], {
      env: { ...cleanEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not exit')); }, 4000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function replyNormally(args, socket) {
  if (args[0] === 'QUIT' || args[0] === 'AUTH' || args[0] === 'SELECT') socket.write('+OK\r\n');
  else socket.write(bulk('ok'));
}

async function withServer(handler, fn) {
  const server = await serverFor(handler);
  try { await fn(server); } finally { await server.close(); }
}

test('connect failure is prompt and sanitized', async () => {
  const server = await serverFor(replyNormally);
  const port = server.port;
  await server.close();
  const result = await run(port, ['--', 'GET', 'key']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Connection failed \[ECONNREFUSED\]/);
  assert.doesNotMatch(result.stderr, /Unhandled|Error:|stack/i);
});

test('authentication variants and database selection use the expected wire commands', async () => {
  for (const [options, expected] of [
    [[], []],
    [['--password', secret], [['AUTH', secret]]],
    [['--user', 'default', '--password', secret], [['AUTH', 'default', secret]]],
    [['--user', 'reader', '--password', secret, '--db', '2'], [['AUTH', 'reader', secret], ['SELECT', '2']]],
  ]) {
    await withServer(replyNormally, async server => {
      const result = await run(server.port, [...options, '--format', 'json', '--', 'GET', 'a key']);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).result, 'ok');
      assert.deepEqual(server.commands.filter(args => args[1] !== 'SETINFO'), [...expected, ['GET', 'a key'], ['QUIT']]);
      assert.ok(!result.stderr.includes(secret));
    });
  }
});

test('an explicit Redis user without a non-empty password fails before connecting', async () => {
  await withServer(replyNormally, async server => {
    for (const options of [['--user', 'reader'], ['--user', 'reader', '--password', ''], ['--user', '', '--password', secret]]) {
      const result = await run(server.port, [...options, '--', 'GET', 'key']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /username and password must both be non-empty/);
      assert.deepEqual(server.commands, []);
      assert.equal(server.connections, 0);
    }
  });
});

test('QUIT succeeds when the server closes immediately after its reply', async () => {
  await withServer((args, socket) => {
    if (args[0] === 'QUIT') socket.end('+OK\r\n');
    else replyNormally(args, socket);
  }, async server => {
    const result = await run(server.port, ['--format', 'json', '--', 'PING']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).result, 'ok');
  });
});

test('bulk replies preserve binary bytes, nested lists, nil and integers', async () => {
  for (const [command, response, expected] of [
    [['GET', 'key'], bulk(Buffer.from([0xff, 0x00, 0x61])), '/wBh'],
    [['MGET', 'a', 'b'], array([Buffer.from([0xff, 0x00]), 'hello']), ['/wA=', 'hello']],
    [['GET', 'key'], Buffer.from('$-1\r\n'), null],
    [['TTL', 'key'], Buffer.from(':12\r\n'), 12],
    [['HSCAN', 'key', '0'], Buffer.concat([Buffer.from('*2\r\n'), bulk('0'), array([Buffer.from([0xff]), 'value'])]), ['0', ['/w==', 'value']]],
  ]) {
    await withServer((args, socket) => args[0] === 'QUIT' ? socket.write('+OK\r\n') : socket.write(response), async server => {
      const result = await run(server.port, ['--format', 'json', '--', ...command]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).result, expected);
    });
  }
});

test('real driver ZSET WITHSCORES keeps complete pairs at the output limit', async () => {
  await withServer((args, socket) => args[0] === 'QUIT' ? socket.write('+OK\r\n') : socket.write(array(['a', '1', 'b', '2'])), async server => {
    for (const format of ['json', 'table']) {
      const result = await run(server.port, ['--format', format, '--max-items', '1', '--', 'ZRANGEBYSCORE', 'key', '0', '10', 'WITHSCORES', 'LIMIT', '0', '1']);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /TRUNCATED/);
      if (format === 'json') {
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.result, ['a', '1']);
        assert.equal(output.count, 1);
        assert.equal(output.truncated, true);
      } else {
        assert.match(result.stdout, /a: 1/);
        assert.doesNotMatch(result.stdout, /b: 2/);
      }
    }
  });
});

test('binary values are bounded before JSON and table output', async () => {
  const data = Buffer.alloc(300, 0xff);
  await withServer((args, socket) => args[0] === 'QUIT' ? socket.write('+OK\r\n') : socket.write(bulk(data)), async server => {
    for (const format of ['json', 'table']) {
      const result = await run(server.port, ['--format', format, '--max-value-bytes', '256', '--', 'GET', 'key']);
      assert.equal(result.code, 0, result.stderr);
      const expected = data.subarray(0, 256).toString('base64') + '…';
      if (format === 'json') {
        const output = JSON.parse(result.stdout);
        assert.equal(output.result, expected);
        assert.equal(output.truncated, true);
      } else {
        assert.ok(result.stdout.includes(expected));
        assert.match(result.stdout, /TRUNCATED/);
      }
    }
  });
});

test('INFO and CLIENT LIST remain textual and client limits apply', async () => {
  await withServer((args, socket) => {
    if (args[0] === 'QUIT') socket.write('+OK\r\n');
    else socket.write(bulk(args[0] === 'INFO' ? '# Server\r\nredis_version:7\r\n' : 'id=1 name=a\nid=2 name=b\n'));
  }, async server => {
    const info = await run(server.port, ['--format', 'json', '--', 'INFO']);
    assert.equal(info.code, 0, info.stderr);
    assert.match(JSON.parse(info.stdout).result, /redis_version:7/);
    for (const format of ['json', 'table']) {
      const clients = await run(server.port, ['--format', format, '--max-items', '1', '--', 'CLIENT', 'LIST']);
      assert.equal(clients.code, 0, clients.stderr);
      if (format === 'json') {
        const result = JSON.parse(clients.stdout);
        assert.equal(result.count, 1);
        assert.equal(result.truncated, true);
        assert.equal(result.result, 'id=1 name=a');
      } else {
        assert.match(clients.stdout, /Client 1/);
        assert.doesNotMatch(clients.stdout, /id=2/);
        assert.match(clients.stdout, /TRUNCATED/);
      }
    }
  });
});

test('server auth, query and QUIT errors never reveal server details', async () => {
  for (const stage of ['AUTH', 'GET', 'QUIT']) {
    await withServer((args, socket) => {
      if (args[0] === stage) socket.write(`-${stage === 'AUTH' ? 'WRONGPASS' : 'ERR'} ${secret}\r\n`);
      else replyNormally(args, socket);
    }, async server => {
      const result = await run(server.port, ['--password', secret, '--', 'GET', 'key']);
      assert.equal(result.code, 1, result.stderr);
      assert.ok(!result.stderr.includes(secret));
      assert.match(result.stderr, stage === 'AUTH' ? /Connection failed \[WRONGPASS\]/ : /Query execution error \[ERR\]/);
      assert.equal(result.stdout, '');
    });
  }
});

test('deadline aborts handshake, query and hung QUIT without leaking sockets', async () => {
  for (const stage of ['AUTH', 'GET', 'QUIT']) {
    await withServer((args, socket) => {
      if (args[0] !== stage) replyNormally(args, socket);
    }, async server => {
      const start = Date.now();
      const result = await run(server.port, ['--password', secret, '--', 'GET', 'key']);
      assert.equal(result.code, 1, `${stage}: ${result.stderr}`);
      assert.ok(Date.now() - start < 3500, stage);
      assert.match(result.stderr, /Connection failed \[ETIMEDOUT\]/);
      assert.ok(!result.stderr.includes(secret));
      assert.equal(result.stdout, '');
      assert.equal(server.commands.filter(args => args[1] !== 'SETINFO').at(-1)[0], stage);
      // Allow the server's close event to follow child exit.
      for (let i = 0; server.connections && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(server.connections, 0, stage);
    });
  }
});

test('unexpected socket closure during command is handled without raw errors', async () => {
  await withServer((args, socket) => args[0] === 'GET' ? socket.destroy() : replyNormally(args, socket), async server => {
    const result = await run(server.port, ['--', 'GET', 'key']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Database operation failed/);
    assert.doesNotMatch(result.stderr, /Socket closed unexpectedly|Unhandled|stack/i);
  });
});

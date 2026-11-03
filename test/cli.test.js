import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parse, output } from '../lib/cli.js';
import { CliError } from '../lib/errors.js';
import { binding, browserCommand, runChild } from '../lib/process.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const id = 'a'.repeat(24), token = `${id}.${'b'.repeat(64)}`;
const saved = { access_token: token, scope: 'own', expires_at: '2030-01-01T00:00:00Z' };
const device = { device_code: 'b'.repeat(64), user_code: 'ABCD-EF01-2345', verification_uri: 'https://app.fogito.com/fogipass/settings/connections/authorize', expires_in: 600, interval: 5 };
const authorized = { ...saved, state: 'authorized', connection_id: id, token_type: 'Bearer' };

function fixture(replies = []) {
  const state = { out: '', err: '', saved: null, calls: [], slept: [], opened: [], deleted: 0, probed: 0, time: 0 };
  state.context = {
    stdout: { write: text => { state.out += text; } }, stderr: { write: text => { state.err += text; } },
    credentialsFactory: async () => state.credentials,
    clientFactory: (environment, credential) => ({ origin: environment === 'dev' ? 'https://dev.fogito.com' : 'https://app.fogito.com',
      request: async (path, values) => {
        state.calls.push({ environment, credential, path, values });
        const result = replies.shift(); if (result instanceof Error) throw result;
        assert.notEqual(result, undefined, `Missing fixture for ${path}`); return result;
      },
      field: async (...args) => { state.calls.push({ field: args }); return 'synthetic-secret'; },
    }),
    sleep: async ms => { state.time += ms; state.slept.push(ms); }, now: () => state.time,
    browser: async uri => { state.opened.push(uri); return true; }, environment: {},
  };
  state.credentials = { load: async () => state.saved, save: async value => { state.saved = value; },
    delete: async () => { state.saved = null; state.deleted++; }, probe: async () => { state.probed++; } };
  return state;
}

test('browser login stores credential without printing it, using server approval and pacing', async () => {
  const state = fixture([device, { state: 'pending' }, authorized]);
  assert.equal(await main(['login', '--name', 'Fixture'], state.context), 0);
  assert.equal(state.saved.access_token, token); assert.equal(state.probed, 1);
  assert.deepEqual(state.opened, [device.verification_uri]); assert.deepEqual(state.slept, [5000, 5000]);
  assert.ok(state.err.includes(device.user_code)); assert.ok(!(state.out + state.err).includes(token));
  assert.ok(!state.err.includes(device.device_code)); assert.equal(JSON.parse(state.out).scope, 'own');
  assert.deepEqual(state.calls.map(call => call.path), ['device/start', 'device/poll', 'device/poll']);
});

test('no-browser, rate limiting, denied approval and timeout', async () => {
  const state = fixture([device, new CliError('rate_limited', 'Wait', 429), authorized]);
  assert.equal(await main(['login', '--no-browser'], state.context), 0); assert.equal(state.opened.length, 0);
  assert.deepEqual(state.slept, [5000, 10000, 5000]);
  const denied = fixture([device, { state: 'denied' }]);
  assert.equal(await main(['login'], denied.context), 1); assert.equal(denied.saved, null);
  const expired = fixture([{ ...device, expires_in: 1 }]);
  assert.equal(await main(['login'], expired.context), 1); assert.equal(expired.calls.length, 1);
});

test('malformed authorization data never opens untrusted URL or stores invalid tokens', async () => {
  for (const change of [{ verification_uri: 'https://evil.invalid' }, { user_code: '\x1b[2J' }, { device_code: 'bad' }, { interval: 0 }, { expires_in: 999999 }]) {
    const state = fixture([{ ...device, ...change }]);
    assert.equal(await main(['login'], state.context), 1); assert.equal(state.opened.length, 0); assert.equal(state.saved, null);
  }
  for (const change of [{ access_token: 'bad' }, { scope: 'admin' }, { connection_id: 'c'.repeat(24) }, { expires_at: 'bad' }]) {
    const state = fixture([device, { ...authorized, ...change }]);
    assert.equal(await main(['login'], state.context), 1); assert.equal(state.saved, null);
  }
});

test('keychain write failure revokes newly approved connection', async () => {
  const state = fixture([device, authorized, {}]);
  state.credentials.save = async () => { throw new CliError('keychain_unavailable', 'Locked'); };
  assert.equal(await main(['login'], state.context), 1);
  assert.equal(state.calls.at(-1).path, 'logout'); assert.equal(state.calls.at(-1).credential, token);
  assert.ok(!(state.out + state.err).includes(token));
});

test('failed cleanup warns to revoke in settings, without leaking a token', async () => {
  const state = fixture([device, authorized, new CliError('unavailable', 'Offline', 503)]);
  state.credentials.save = async () => { throw new CliError('keychain_unavailable', 'Locked'); };
  assert.equal(await main(['login'], state.context), 1); assert.match(state.err, /Revoke this connection/); assert.ok(!state.err.includes(token));
});

test('existing login is not overwritten and failed probe never starts authorization', async () => {
  const existing = fixture(); existing.saved = saved;
  assert.equal(await main(['login'], existing.context), 1); assert.equal(existing.calls.length, 0);
  const broken = fixture(); broken.credentials.probe = async () => { throw new CliError('keychain_unavailable', 'Locked'); };
  assert.equal(await main(['login'], broken.context), 1); assert.equal(broken.calls.length, 0);
});

test('logout removes keychain only after success or already-revoked response', async () => {
  for (const response of [{ revoked: true }, new CliError('connection_expired', 'Revoked', 401), new CliError('unavailable', 'Offline', 503)]) {
    const state = fixture([response]); state.saved = saved;
    const unavailable = response.status === 503;
    assert.equal(await main(['logout'], state.context), unavailable ? 1 : 0);
    assert.equal(state.deleted, unavailable ? 0 : 1);
  }
});

test('status is projected and missing/revoked connection fails closed', async () => {
  const state = fixture([{ name: 'Fixture', owner_name: 'Synthetic owner', scope: 'own', expires_at: saved.expires_at, access_token: token }]); state.saved = saved;
  assert.equal(await main(['status'], state.context), 0); assert.ok(!state.out.includes(token));
  const missing = fixture(); assert.equal(await main(['status'], missing.context), 1); assert.equal(missing.calls.length, 0);
  const revoked = fixture([new CliError('connection_expired', 'Revoked', 401)]); revoked.saved = saved;
  assert.equal(await main(['status'], revoked.context), 1); assert.equal(revoked.out, '');
});

test('list/search uses only metadata endpoint and pagination', async () => {
  const state = fixture([{ items: [], folders: [], count: 0 }]); state.saved = saved;
  assert.equal(await main(['list', '--search', 'Fixture', '--limit', '50', '--skip', '10'], state.context), 0);
  assert.deepEqual(state.calls[0].values, { search: 'Fixture', limit: 50, skip: 10 });
  assert.equal(state.calls[0].path, 'items/list');
});

test('JSON escapes controls and raw output is explicit', () => {
  let text = ''; const stream = { write: value => { text += value; } };
  output('name\x1b[2J\u009b\u202e', stream); assert.ok(!text.includes('\x1b')); assert.ok(text.includes('\\u009b')); assert.ok(text.includes('\\u202e'));
  text = ''; output('exact', stream, true); assert.equal(text, 'exact');
  assert.throws(() => output({}, stream, true)); assert.throws(() => parse(['get', id, '--raw']));
});

test('help/version need neither network nor a keychain', async () => {
  for (const args of [['--help'], ['--version']]) {
    const state = fixture(); state.context.credentialsFactory = async () => { throw new Error('Must not open'); };
    assert.equal(await main(args, state.context), 0); assert.match(state.out, /FogiPass CLI/);
  }
});

test('strict options, command separation and runtime-control environment rejection', () => {
  const parsed = parse(['--environment', 'dev', 'run', '--env', `APP_PASSWORD=${id}:password`, '--', 'node', '--version']);
  assert.deepEqual(parsed.program, ['node', '--version']); assert.equal(parsed.environment, 'dev');
  for (const args of [[], ['write'], ['login', '--name', '\n'], ['status', '--field', 'password'], ['list', '--limit', '3'], ['list', '--skip', '-1'], ['status', '--environment', 'constructor'], ['get', 'bad'], ['status', '--environment', 'dev', '--environment', 'production']]) assert.throws(() => parse(args));
  for (const name of ['PATH', 'Path', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'NODE_OPTIONS', 'NAPI_RS_NATIVE_LIBRARY_PATH', 'NPM_CONFIG_USERCONFIG', 'GIT_CONFIG', 'COMSPEC']) assert.throws(() => binding(`${name}=${id}:password`));
});

test('run injects only selected fields without printing or altering parent environment', async () => {
  const state = fixture(); state.saved = saved; state.context.environment = { EXISTING: 'value' };
  state.context.child = async (program, env) => { assert.deepEqual(program, ['example', 'literal;$()']); assert.equal(env.SERVICE_PASSWORD, 'synthetic-secret'); return 7; };
  assert.equal(await main(['run', '--env', `SERVICE_PASSWORD=${id}:password`, '--', 'example', 'literal;$()'], state.context), 7);
  assert.deepEqual(state.context.environment, { EXISTING: 'value' }); assert.equal(state.out + state.err, '');
  const duplicate = fixture(); duplicate.saved = saved;
  assert.equal(await main(['run', '--env', `X=${id}:password`, '--env', `X=${id}:password`, '--', 'example'], duplicate.context), 1);
  assert.equal(duplicate.calls.length, 0);
});

test('child process uses an executable without shell interpolation', async () => {
  assert.equal(await runChild([process.execPath, '-e', 'process.exit(process.env.TEST_FIXTURE === "value;$()" ? 0 : 1)'], { ...process.env, TEST_FIXTURE: 'value;$()' }), 0);
  await assert.rejects(runChild(['example.cmd'], {}));
  await assert.rejects(runChild(['nonexistent-fogipass-test-executable'], {}), error => error.code === 'command_failed');
});

test('browser launch is fixed to authorization URLs and platform executables', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const [command, args] = browserCommand(device.verification_uri, platform);
    assert.ok(command); assert.ok(args.includes(device.verification_uri));
  }
  assert.throws(() => browserCommand('https://evil.invalid'));
  assert.throws(() => browserCommand(`${device.verification_uri}?code=secret`));
});

test('cancelling login does not continue polling or store credentials', async () => {
  const state = fixture([device]);
  state.context.sleep = async () => { throw new DOMException('Cancelled', 'AbortError'); };
  assert.equal(await main(['login'], state.context), 130);
  assert.equal(state.saved, null); assert.equal(state.calls.length, 1);
});

test('invalid commands and API input bounds fail before opening the keychain or revealing secrets', async () => {
  for (const args of [
    ['run', '--env', `X=${id}:password`, '--', 'unsafe.cmd'],
    ['run', '--env', `X=${id}:password`, '--', 'example', 'bad\0arg'],
    ['run', '--env', `NODE_OPTIONS=${id}:password`, '--', 'example'],
    ['get', id, '--field', 'totp'], ['get', id, '--field', ''],
    ['list', '--skip', '100001'], ['list', '--search', 'x'.repeat(201)],
    ['login', '--name', '\u00e6'.repeat(41)],
  ]) {
    const state = fixture(); let opened = false;
    state.context.credentialsFactory = async () => { opened = true; return state.credentials; };
    assert.equal(await main(args, state.context), 1);
    assert.equal(opened, false); assert.equal(state.calls.length, 0);
  }
  assert.equal(parse(['get', id, '--field', 'address1']).field, 'address1');
});

test('a login saved while browser approval was pending is preserved; the new approval is revoked', async () => {
  const state = fixture([device, authorized, {}]); let reads = 0;
  state.credentials.load = async () => ++reads === 1 ? null : saved;
  state.credentials.save = async () => assert.fail('Must not overwrite another connection');
  assert.equal(await main(['login'], state.context), 1);
  assert.equal(state.calls.at(-1).path, 'logout');
});

test('cancellation after approval but before keychain save revokes that approval', async () => {
  const controller = new AbortController(); const state = fixture([device, authorized, {}]);
  state.context.signal = controller.signal;
  state.context.sleep = async () => { controller.abort(); };
  assert.equal(await main(['login'], state.context), 130);
  assert.equal(state.saved, null); assert.equal(state.calls.at(-1).path, 'logout');
});

test('run reuses identical fields only within one invocation and clears its temporary environment', async () => {
  const state = fixture(); state.saved = saved;
  let received;
  state.context.child = async (_, env) => {
    received = env;
    assert.equal(env.FIRST, 'synthetic-secret'); assert.equal(env.SECOND, 'synthetic-secret');
    assert.equal(env.__proto__, 'synthetic-secret'); assert.equal(Object.getPrototypeOf(env), null);
    throw new CliError('command_failed', 'Synthetic failure');
  };
  const args = ['run', '--env', `FIRST=${id}:password`, '--env', `SECOND=${id}:password`, '--env', `__proto__=${id}:password`, '--', 'example'];
  assert.equal(await main(args, state.context), 1);
  assert.equal(state.calls.length, 1); assert.deepEqual(Object.keys(received), []);
  assert.ok(!(state.out + state.err).includes('synthetic-secret'));
});

test('run never starts a child after a failed field read or cancellation', async () => {
  for (const cancel of [false, true]) {
    const state = fixture(); state.saved = saved; const controller = new AbortController();
    state.context.signal = controller.signal;
    state.context.clientFactory = () => ({ field: async () => {
      if (!cancel) throw new CliError('unavailable', 'Synthetic failure');
      controller.abort(); return 'synthetic-secret';
    } });
    state.context.child = async () => assert.fail('Must not spawn');
    assert.equal(await main(['run', '--env', `X=${id}:password`, '--', 'example'], state.context), cancel ? 130 : 1);
    assert.ok(!(state.out + state.err).includes('synthetic-secret'));
  }
});

test('cancellation waits for an actual child exit, including a child ignoring SIGTERM', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fogipass-child-test-'));
  const path = join(dir, 'ready'); const controller = new AbortController();
  const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(path)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const stopped = assert.rejects(runChild([process.execPath, '-e', script], { ...process.env }, controller.signal), { name: 'AbortError' });
  try {
    let pid;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { pid = Number(await readFile(path, 'utf8')); break; } catch { await delay(25); }
    }
    assert.ok(pid, 'Child must become ready'); controller.abort(); await stopped;
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally { controller.abort(); await stopped; await rm(dir, { recursive: true, force: true }); }
});

test('an already-cancelled command is never spawned', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runChild(['nonexistent-fogipass-test-executable'], {}, controller.signal), { name: 'AbortError' });
});

test('closed output pipes do not produce uncaught exceptions', async () => {
  const child = spawn(process.execPath, ['bin/fogipass.js', '--help'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', value => { error += value; }); child.stdout.destroy();
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0); assert.equal(error, '');
});

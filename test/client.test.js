import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, TOKEN } from '../lib/client.js';
import { safeError } from '../lib/errors.js';

const token = `${'a'.repeat(24)}.${'b'.repeat(64)}`;
const ok = data => new Response(JSON.stringify({ status: 'success', data }));

test('fixed HTTPS endpoint, POST JSON, bearer header only, no redirects/cookies', async () => {
  const client = new Client('production', token, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://app.fogito.com/api/fogipass/cli/status');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers.Origin, undefined); assert.equal(options.headers.Cookie, undefined);
    assert.ok(!url.includes(token)); assert.equal(options.body, '{}');
    return ok({ scope: 'own' });
  } });
  assert.deepEqual(await client.request('status'), { scope: 'own' });
});

test('only the exact read-only routes and environments are accepted', async () => {
  for (const env of ['evil', 'https://evil.invalid', 'constructor', '__proto__']) assert.throws(() => new Client(env));
  for (const path of ['../vault/export', 'items/delete', 'items/list?token=x', 'https://evil.invalid']) await assert.rejects(new Client().request(path));
  for (const value of ['bad', `${token}\n`, '']) assert.throws(() => new Client('dev', value));
  assert.ok(TOKEN.test(token));
  await assert.rejects(new Client().request('status', { value: 'a'.repeat(8192) }));
});

test('metadata does not reveal and explicit fields use current revision', async () => {
  const calls = [];
  const client = new Client();
  client.request = async (path, params) => { calls.push([path, params]); return path === 'items/info' ? { revision: 'current', name: 'Fixture' } : { value: 'synthetic-value' }; };
  const id = 'a'.repeat(24);
  assert.equal((await client.field(id)).name, 'Fixture'); assert.equal(calls.length, 1);
  assert.equal(await client.field(id, 'password'), 'synthetic-value');
  assert.deepEqual(calls[2], ['items/reveal', { id, revision: 'current', purpose: 'copy', field: 'password' }]);
  await assert.rejects(client.field('invalid', 'password'));
});

test('TOTP projection returns code metadata but never a seed', async () => {
  const client = new Client();
  client.request = async path => path === 'items/info' ? { revision: 'current' } : { totp: { code: '123456', period: 30, server_time: 100, expires_at: 120, seed: 'synthetic-seed' } };
  assert.deepEqual(await client.field('a'.repeat(24), null, true), { code: '123456', period: 30, server_time: 100, expires_at: 120 });
});

test('redirect, malformed, non-object and oversized responses fail closed', async () => {
  const responses = [
    new Response('', { status: 302, headers: { Location: 'https://evil.invalid' } }),
    new Response('<html>bad</html>'), new Response('[]'), ok([]),
    new Response('x'.repeat(1024 * 1024 + 1)),
    new Response('{}', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
  ];
  for (const response of responses) await assert.rejects(new Client('dev', null, { fetchImpl: async () => response }).request('status'));
});

test('HTTP/server/network failures never echo arbitrary secret-bearing messages', async () => {
  for (const status of [401, 403, 409, 429, 503]) {
    const client = new Client('dev', token, { fetchImpl: async () => new Response(JSON.stringify({ error_code: token, description: token }), { status }) });
    await assert.rejects(client.request('status'), error => {
      assert.equal(error.status, status); assert.ok(!JSON.stringify(safeError(error)).includes(token)); return true;
    });
  }
  const client = new Client('dev', token, { fetchImpl: async () => { throw new Error(token); } });
  await assert.rejects(client.request('status'), error => !error.message.includes(token));
});

test('abort reaches fetch and remains a cancellation, not a credential error', async () => {
  const controller = new AbortController(); controller.abort();
  const client = new Client('dev', null, { signal: controller.signal, fetchImpl: async (_, options) => { options.signal.throwIfAborted(); } });
  await assert.rejects(client.request('status'), { name: 'AbortError' });
});

test('disabled TLS verification is rejected before any credential is sent', () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try { assert.throws(() => new Client('production', token), error => error.code === 'insecure_environment'); }
  finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
});

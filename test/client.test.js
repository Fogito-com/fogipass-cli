import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, TOKEN, metadataList } from '../lib/client.js';
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
  client.request = async (path, params) => { calls.push([path, params]); return path === 'items/info' ? { id: 'a'.repeat(24), revision: 'current', name: 'Fixture' } : { value: 'synthetic-value' }; };
  const id = 'a'.repeat(24);
  assert.equal((await client.field(id)).name, 'Fixture'); assert.equal(calls.length, 1);
  assert.equal(await client.field(id, 'password'), 'synthetic-value');
  assert.deepEqual(calls[2], ['items/reveal', { id, revision: 'current', purpose: 'copy', field: 'password' }]);
  await assert.rejects(client.field('invalid', 'password'));
});

test('TOTP projection returns code metadata but never a seed', async () => {
  const client = new Client();
  client.request = async path => path === 'items/info' ? { id: 'a'.repeat(24), revision: 'current' } : { totp: { code: '123456', period: 30, server_time: 100, expires_at: 120, seed: 'synthetic-seed' } };
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

test('identity address fields are accepted, seeds and structured fields are rejected before requests', async () => {
  const client = new Client(); const calls = [];
  client.request = async (path, params) => {
    calls.push(params);
    return path === 'items/info' ? { id: 'a'.repeat(24), revision: 'current' } : { value: 'Synthetic address' };
  };
  for (const field of ['address1', 'address2', 'address3']) assert.equal(await client.field('a'.repeat(24), field), 'Synthetic address');
  assert.equal(calls.length, 6);
  for (const field of ['totp', 'uris', 'custom_fields', '', 'bad-field']) await assert.rejects(client.field('a'.repeat(24), field));
  assert.equal(calls.length, 6);
});

test('metadata projections discard unexpected secret fields at every level', async () => {
  const item = { id: 'a'.repeat(24), name: 'Fixture', has_totp: true, revision: 'current', password: 'synthetic-private', data: { secret: true } };
  const client = new Client(); client.request = async () => item;
  assert.deepEqual(await client.field(item.id), { id: item.id, name: 'Fixture', revision: 'current', has_totp: true });
  const result = metadataList({ items: [item], count: 1, folders: [{ id: item.id, name: 'Folder', secret: true }], token: 'synthetic-private' });
  assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  assert.deepEqual(result.folders, [{ id: item.id, name: 'Folder' }]);
  await assert.rejects(client.field('c'.repeat(24), 'password'), error => error.code === 'invalid_response');
  for (const change of [{ items: {} }, { count: -1 }, { folders: null }, { items: [{ ...item, name: { secret: true } }] }]) {
    assert.throws(() => metadataList({ items: [], count: 0, folders: [], ...change }));
  }
});

test('gateway HTML/empty errors preserve HTTP status without echoing response content', async () => {
  for (const status of [401, 403, 404, 409, 429, 503]) {
    for (const body of ['', '<html>synthetic-private</html>']) {
      const client = new Client('dev', null, { fetchImpl: async () => new Response(body, { status }) });
      await assert.rejects(client.request('status'), error => error.status === status && !error.message.includes('synthetic-private'));
    }
  }
});

test('malformed JSON and invalid UTF-8 are response errors, not printable values', async () => {
  for (const body of ['{bad json', new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
    await assert.rejects(new Client('dev', null, { fetchImpl: async () => new Response(body) }).request('status'), error => error.code === 'invalid_response');
  }
});

test('invalid TOTP sizes and timing fail closed', async () => {
  for (const change of [{ code: '1234567' }, { period: 0 }, { period: 121 }, { server_time: '100' }, { expires_at: 100 }, { expires_at: 131 }]) {
    const client = new Client();
    client.request = async path => path === 'items/info' ? { id: 'a'.repeat(24), revision: 'current' }
      : { totp: { code: '123456', period: 30, server_time: 100, expires_at: 120, ...change } };
    await assert.rejects(client.field('a'.repeat(24), null, true));
  }
});

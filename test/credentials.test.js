import test from 'node:test';
import assert from 'node:assert/strict';
import { Credentials, createCredentials, SERVICE } from '../lib/credentials.js';

const value = { access_token: `${'a'.repeat(24)}.${'b'.repeat(64)}`, scope: 'own', expires_at: '2030-01-01T00:00:00Z' };

test('keychain JSON roundtrip stores only required fields', async () => {
  let raw = null;
  const entry = { getPassword: async () => raw, setPassword: async text => { raw = text; }, deletePassword: async () => { raw = null; } };
  const credentials = new Credentials(entry);
  assert.equal(await credentials.load(), null);
  await credentials.save({ ...value, extra: 'not-stored' });
  assert.deepEqual(JSON.parse(raw), value); assert.deepEqual(await credentials.load(), value);
  await credentials.delete(); assert.equal(await credentials.load(), null);
});

test('locked, unavailable and malformed keychains never fall back to files', async () => {
  for (const method of ['getPassword', 'setPassword', 'deletePassword']) {
    const entry = { [method]: async () => { throw new Error('synthetic-private-error'); } };
    const operation = { getPassword: 'load', setPassword: 'save', deletePassword: 'delete' }[method];
    await assert.rejects(new Credentials(entry)[operation](value), error => error.code === 'keychain_unavailable' && !error.message.includes('synthetic-private-error'));
  }
  for (const raw of ['bad json', '[]', '{}', '{"access_token":"bad"}']) await assert.rejects(new Credentials({ getPassword: async () => raw }).load());
});

test('native backend selection explicitly requires Linux Secret Service', async () => {
  const entries = [];
  class AsyncEntry {
    constructor(...args) { entries.push(args); }
    async getPassword() { return this.value ?? null; }
    async setPassword(value) { this.value = value; }
    async deletePassword() { this.value = null; }
  }
  for (const platform of ['linux', 'darwin', 'win32']) {
    const credentials = await createCredentials('dev', { platform, load: async () => ({ AsyncEntry }) });
    assert.deepEqual(entries.at(-1), [SERVICE, 'dev', { linux: { store: 'secret-service' } }]);
    await credentials.probe(); assert.equal(entries.at(-1)[0], `${SERVICE}.probe`);
  }
  await assert.rejects(createCredentials('dev', { platform: 'unsupported' }));
  await assert.rejects(createCredentials('dev', { load: async () => { throw new Error('missing native module'); } }));
});

test('native library overrides are rejected before loading a keychain', async () => {
  const name = 'NAPI_RS_NATIVE_LIBRARY_PATH'; const previous = process.env[name];
  process.env[name] = '/not/an/allowed/backend';
  try { await assert.rejects(createCredentials('dev')); }
  finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('invalid writes are rejected and silent write failures are detected by reading back', async () => {
  let writes = 0;
  const credentials = new Credentials({ setPassword: async () => { writes++; }, getPassword: async () => null });
  await assert.rejects(credentials.save({ ...value, access_token: 'bad' }), error => error.code === 'invalid_credential');
  assert.equal(writes, 0);
  await assert.rejects(credentials.save(value), error => error.code === 'keychain_unavailable');
  assert.equal(writes, 1);
  for (const raw of ['bad json', '{}', 'x'.repeat(4097)]) {
    await assert.rejects(new Credentials({ getPassword: async () => raw }).load(), error => error.code === 'invalid_credential');
  }
  assert.deepEqual(await new Credentials({ getPassword: async () => JSON.stringify({ ...value, extra: 'ignored' }) }).load(), value);
});

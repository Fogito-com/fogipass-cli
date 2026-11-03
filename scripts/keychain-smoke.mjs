import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncEntry } from '@napi-rs/keyring';
import { Credentials, createCredentials } from '../lib/credentials.js';

// Only a fresh synthetic entry; never read the production/dev connection entries.
const entry = new AsyncEntry('com.fogito.fogipass.cli.npm.synthetic-test', randomUUID(), { linux: { store: 'secret-service' } });
const credentials = new Credentials(entry);
const value = { access_token: `${'a'.repeat(24)}.${'b'.repeat(64)}`, scope: 'own', expires_at: '2030-01-01T00:00:00Z' };
try {
  assert.equal(await credentials.load(), null);
  await credentials.save(value);
  assert.deepEqual(await credentials.load(), value);
  await credentials.delete();
  assert.equal(await credentials.load(), null);
  await (await createCredentials('dev')).probe();
  console.log('Native keychain write/read/delete and pre-login probe passed; synthetic entries removed.');
} finally { await credentials.delete(); }

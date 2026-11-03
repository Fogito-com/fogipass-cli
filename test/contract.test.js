import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../lib/cli.js';
import { Client } from '../lib/client.js';
import { Credentials } from '../lib/credentials.js';

// Shapes mirror VaultService::project/list, VaultConnections::execute and
// VaultTotp::code. All values and identifiers are synthetic.
const id = 'a'.repeat(24), folderId = 'd'.repeat(24);
const token = `${'b'.repeat(24)}.${'c'.repeat(64)}`;
const saved = { access_token: token, scope: 'own', expires_at: '2030-01-01T00:00:00Z' };
const timestamp = '2026-01-01T00:00:00Z';
const fixtures = { login: 'password', card: 'number', identity: 'address1', note: 'notes' };

for (const [type, field] of Object.entries(fixtures)) {
  for (const folder of [null, folderId]) {
    test(`complete API/CLI contract: ${type}, ${folder ? 'assigned folder' : 'no folder'}`, async () => {
      const item = { id, type, name: 'Synthetic item', owner_id: 'e'.repeat(24), owner_name: 'Synthetic owner',
        folder_id: folder, revision: 'f'.repeat(32), has_totp: type === 'login', created_at: timestamp, updated_at: timestamp };
      const listing = { items: [item], count: 1, folders: [{ id: folderId, name: 'Synthetic folder', revision: '0'.repeat(32), can_manage: true }] };
      const status = { name: 'Synthetic connection', owner_name: 'Synthetic owner', scope: 'own', expires_at: saved.expires_at };
      const totp = { code: '12345678', period: 45, server_time: 100, expires_at: 135 };
      const calls = [];
      const clientFactory = (environment, credential) => new Client(environment, credential, { fetchImpl: async (url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        const path = url.replace('https://app.fogito.com/api/fogipass/cli/', '');
        const params = JSON.parse(options.body); calls.push({ path, params });
        let data;
        if (path === 'status') data = status;
        else if (path === 'items/list') data = listing;
        else if (path === 'items/info') {
          assert.equal(params.id, id);
          data = { ...item, unexpected_private_data: 'must-not-print' };
        } else if (path === 'items/reveal') {
          assert.equal(params.id, id); assert.equal(params.revision, item.revision);
          if (params.purpose === 'totp') data = { totp };
          else { assert.equal(params.field, field); data = { value: 'synthetic-value' }; }
        } else assert.fail('Unexpected route');
        return new Response(JSON.stringify({ status: 'success', description: '', data }), { headers: { 'Content-Type': 'application/json' } });
      } });
      async function command(args, extra = {}) {
        let out = '', err = '';
        const code = await main(args, { clientFactory, environment: {},
          credentialsFactory: async () => new Credentials({ getPassword: async () => JSON.stringify(saved) }),
          stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } }, ...extra });
        assert.equal(code, 0, err); assert.equal(err, ''); assert.ok(!out.includes(token));
        return out;
      }
      assert.deepEqual(JSON.parse(await command(['status'])), status);
      assert.deepEqual(JSON.parse(await command(['list'])), listing);
      assert.deepEqual(JSON.parse(await command(['get', id])), item);
      assert.equal(await command(['get', id, '--field', field, '--raw']), 'synthetic-value');
      if (type === 'login') assert.deepEqual(JSON.parse(await command(['totp', id])), totp);
      const before = calls.length;
      assert.equal(await command(['run', '--env', `FIRST=${id}:${field}`, '--env', `SECOND=${id}:${field}`, '--', 'synthetic-program'], {
        child: async (_, env) => { assert.equal(env.FIRST, 'synthetic-value'); assert.equal(env.SECOND, env.FIRST); return 0; },
      }), '');
      assert.deepEqual(calls.slice(before).map(call => call.path), ['items/info', 'items/reveal']);
    });
  }
}

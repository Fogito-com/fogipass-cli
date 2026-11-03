import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { npm } from './npm.mjs';
import { VERSION } from '../lib/client.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
assert.equal(manifest.version, VERSION);
assert.equal(manifest.name, 'fogipass-cli');
assert.equal(manifest.bin.fogipass, 'bin/fogipass.js');
assert.equal(manifest.dependencies['@napi-rs/keyring'], '2.1.2');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[hook], undefined);
const [pack] = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts']));
const allowed = ['package.json', 'README.md', 'SECURITY.md', 'bin/fogipass.js',
  'lib/cli.js', 'lib/client.js', 'lib/credentials.js', 'lib/errors.js', 'lib/process.js'];
assert.deepEqual(pack.files.map(file => file.path).sort(), allowed.sort());
// Windows uses npm command shims, not POSIX executable permission bits.
if (process.platform !== 'win32') assert.ok(pack.files.find(file => file.path === 'bin/fogipass.js').mode & 0o111);
assert.ok(pack.unpackedSize < 100_000);
console.log(`Package allowlist verified: ${pack.files.length} public files, no local config, tests, credentials or build hooks.`);

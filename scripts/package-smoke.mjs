import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npm } from './npm.mjs';
import { VERSION } from '../lib/client.js';

const temp = await mkdtemp(join(tmpdir(), 'fogipass-package-'));
try {
  const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp]));
  const tarball = join(temp, pack.filename);
  const prefix = join(temp, 'global');
  const isolated = join(temp, 'consumer'); await mkdir(isolated);
  const env = { ...process.env, npm_config_cache: join(temp, 'cache'), npm_config_userconfig: join(temp, 'no-user-config'), npm_config_ignore_scripts: 'true' };
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-fund', '--no-audit', tarball], { env, cwd: isolated });
  const root = npm(['root', '--global', '--prefix', prefix], { env, cwd: isolated }).trim();
  const executable = join(root, 'fogipass-cli', 'bin', 'fogipass.js');
  const expected = `FogiPass CLI ${VERSION}\n`;
  assert.equal(execFileSync(process.execPath, [executable, '--version'], { encoding: 'utf8', env, cwd: isolated }), expected);
  assert.match(execFileSync(process.execPath, [executable, '--help'], { encoding: 'utf8', env, cwd: isolated }), /login.*--name/);
  const nativePath = pathToFileURL(join(root, 'fogipass-cli', 'node_modules', '@napi-rs', 'keyring', 'index.js')).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `const binding = await import(${JSON.stringify(nativePath)}); if (typeof binding.AsyncEntry !== 'function') process.exit(1);`], { env, cwd: isolated });
  const npx = join(dirname(process.env.npm_execpath), 'npx-cli.js');
  assert.equal(execFileSync(process.execPath, [npx, '--yes', '--offline', '--package', tarball, '--', 'fogipass', '--version'], {
    encoding: 'utf8', env, cwd: isolated, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'],
  }), expected);
  console.log('Packed global npm install, native binding load and isolated npx execution passed with install scripts disabled.');
} finally { await rm(temp, { recursive: true, force: true }); }

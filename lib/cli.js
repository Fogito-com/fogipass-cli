import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, ID, ORIGINS, TOKEN, VERSION, object } from './client.js';
import { createCredentials } from './credentials.js';
import { CliError, invalidResponse, safeError } from './errors.js';
import { binding, openBrowser, runChild } from './process.js';

export const HELP = `FogiPass CLI ${VERSION} - read-only company vault access

Usage: fogipass [--environment production|dev] <command> [options]

  login [--name NAME] [--no-browser]  Approve a connection in Fogito
  status                            Show the current connection
  logout                            Revoke and remove the connection
  list [--search TEXT] [--limit N] [--skip N]
  get ITEM_ID [--field FIELD] [--raw] Metadata unless a field is explicit
  totp ITEM_ID [--raw]               Generate a code, never reveal its seed
  run --env NAME=ITEM_ID:FIELD -- executable [arguments...]

Options: --help, --version
Results are JSON. --raw deliberately prints one plaintext secret.
Login uses the native OS keychain; no plaintext file fallback exists.
`;

const options = {
  environment: { type: 'string', default: 'production' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  name: { type: 'string' }, 'no-browser': { type: 'boolean' }, search: { type: 'string' }, limit: { type: 'string' }, skip: { type: 'string' },
  field: { type: 'string' }, raw: { type: 'boolean' }, env: { type: 'string', multiple: true },
};
const commandOptions = { login: ['name', 'no-browser'], status: [], logout: [], list: ['search', 'limit', 'skip'], get: ['field', 'raw'], totp: ['raw'], run: ['env'] };
const badArgs = message => new CliError('invalid_arguments', message);

export function parse(argv) {
  const delimiter = argv.indexOf('--');
  const before = delimiter === -1 ? argv : argv.slice(0, delimiter);
  let parsed;
  try { parsed = parseArgs({ args: before, options, allowPositionals: true, strict: true, tokens: true }); }
  catch { throw badArgs('Invalid arguments. Run fogipass --help.'); }
  const { values, positionals, tokens } = parsed;
  if (values.help || values.version) return { help: values.help, version: values.version };
  const [command, ...items] = positionals;
  if (!Object.hasOwn(commandOptions, command ?? '') || !Object.hasOwn(ORIGINS, values.environment)) throw badArgs('Choose a command and environment from fogipass --help.');
  const allowed = new Set(['environment', ...commandOptions[command]]);
  const seen = new Set();
  for (const token of tokens.filter(token => token.kind === 'option')) {
    if (!allowed.has(token.name) || (seen.has(token.name) && token.name !== 'env')) throw badArgs('An option is duplicated or not valid for this command.');
    seen.add(token.name);
  }
  const expected = ['get', 'totp'].includes(command) ? 1 : 0;
  if (items.length !== expected || (expected && !ID.test(items[0]))) throw badArgs('Use a valid item ID and the arguments shown by fogipass --help.');
  if (delimiter !== -1 && command !== 'run') throw badArgs('The -- command separator is only supported by fogipass run.');
  if (command === 'get' && values.raw && !values.field) throw badArgs('--raw requires --field.');
  if (values.field && !/^[a-z_]{1,64}$/.test(values.field)) throw badArgs('Invalid field name.');
  const program = delimiter === -1 ? [] : argv.slice(delimiter + 1);
  if (command === 'run' && (!values.env?.length || !program.length)) throw badArgs('Use fogipass run --env VARIABLE=ITEM_ID:FIELD -- executable arguments.');
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  const skip = values.skip === undefined ? 0 : Number(values.skip);
  if (!/^(5|10|20|50|100)$/.test(String(limit)) || (values.limit !== undefined && String(limit) !== values.limit)
    || !Number.isSafeInteger(skip) || skip < 0 || (values.skip !== undefined && !/^\d+$/.test(values.skip))) throw badArgs('Use limit 5, 10, 20, 50 or 100 and a nonnegative integer skip.');
  const name = values.name ?? `FogiPass CLI - ${hostname()}`.slice(0, 80);
  if (!name.trim() || [...name].length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw badArgs('Connection name must contain 1 to 80 characters without control characters.');
  return { ...values, command, id: items[0], limit, skip, name, program };
}

export function output(value, stream, raw = false) {
  if (raw) {
    if (typeof value !== 'string') throw badArgs('Raw output requires a text value.');
    stream.write(value);
  } else {
    // Match Python ensure_ascii so untrusted names cannot inject terminal controls.
    stream.write(`${JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
  }
}

export async function login(args, credentials, context) {
  const { clientFactory, stderr, stdout, sleep, now, browser, signal } = context;
  if (await credentials.load()) throw new CliError('already_connected', 'A connection is already stored. Run fogipass logout before connecting again.');
  await credentials.probe();
  const client = clientFactory(args.environment);
  const device = await client.request('device/start', { name: args.name });
  const uri = `${client.origin}/fogipass/settings/connections/authorize`;
  if (device.verification_uri !== uri || !/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/.test(device.user_code)
    || !/^[a-f0-9]{64}$/.test(device.device_code) || !Number.isInteger(device.expires_in)
    || device.expires_in < 1 || device.expires_in > 600 || device.interval !== 5) throw invalidResponse();
  stderr.write(`Open ${uri}\nEnter this code on the authorization page: ${device.user_code}\nOnly approve the login you started here.\n`);
  const deadline = now() + device.expires_in * 1000;
  if (!args['no-browser'] && !(await browser(uri))) stderr.write('Could not open a browser. Open the URL above manually.\n');
  while (now() < deadline) {
    await sleep(5000, signal);
    if (now() >= deadline) break;
    let result;
    try { result = await client.request('device/poll', { device_code: device.device_code }); }
    catch (error) {
      if (error instanceof CliError && error.status === 429) { await sleep(10000, signal); continue; }
      throw error;
    }
    if (result.state === 'pending') continue;
    if (result.state === 'denied') throw new CliError('authorization_denied', 'The connection was not authorized.');
    if (result.state !== 'authorized' || !TOKEN.test(result.access_token) || result.token_type !== 'Bearer'
      || !ID.test(result.connection_id) || !result.access_token.startsWith(`${result.connection_id}.`)
      || !result.access_token.endsWith(`.${device.device_code}`)
      || !['own', 'company'].includes(result.scope) || typeof result.expires_at !== 'string'
      || !Number.isFinite(Date.parse(result.expires_at))) throw invalidResponse();
    try { await credentials.save(result); }
    catch (error) {
      try { await clientFactory(args.environment, result.access_token, true).request('logout'); }
      catch { stderr.write('Revoke this connection in FogiPass Settings; local credential storage failed.\n'); }
      throw error;
    }
    output({ connected: true, environment: args.environment, scope: result.scope, expires_at: result.expires_at }, stdout);
    return;
  }
  throw new CliError('authorization_expired', 'Authorization timed out. Run fogipass login again.');
}

export async function execute(args, context) {
  const credentials = await context.credentialsFactory(args.environment);
  if (args.command === 'login') return login(args, credentials, context);
  const saved = await credentials.load();
  if (!object(saved) || !TOKEN.test(saved.access_token)) throw new CliError('connection_required', 'Not connected. Run fogipass login.');
  const client = context.clientFactory(args.environment, saved.access_token);
  if (args.command === 'logout') {
    try { await client.request('logout'); }
    catch (error) { if (!(error instanceof CliError) || error.status !== 401) throw error; }
    await credentials.delete();
    output({ connected: false }, context.stdout);
  } else if (args.command === 'status') {
    const { name, owner_name, scope, expires_at } = await client.request('status');
    output({ name, owner_name, scope, expires_at }, context.stdout);
  } else if (args.command === 'list') output(await client.request('items/list', { search: args.search ?? '', limit: args.limit, skip: args.skip }), context.stdout);
  else if (args.command === 'get') output(await client.field(args.id, args.field ?? null), context.stdout, args.raw);
  else if (args.command === 'totp') {
    const result = await client.field(args.id, null, true);
    output(args.raw ? result.code : result, context.stdout, args.raw);
  } else if (args.command === 'run') {
    const bindings = args.env.map(binding);
    const key = name => process.platform === 'win32' ? name.toUpperCase() : name;
    if (new Set(bindings.map(value => key(value.name))).size !== bindings.length) throw badArgs('Duplicate environment variable.');
    const env = { ...context.environment };
    for (const { name, id, field } of bindings) {
      const value = await client.field(id, field);
      if (typeof value !== 'string' || value.includes('\0')) throw badArgs('This field cannot be passed as an environment variable.');
      for (const existing of Object.keys(env)) if (key(existing) === key(name)) delete env[existing];
      env[name] = value;
    }
    try { return await context.child(args.program, env, context.signal); }
    finally { for (const { name } of bindings) delete env[name]; }
  }
}

export async function main(argv, overrides = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const context = {
    stdout: process.stdout, stderr: process.stderr, environment: process.env, signal: controller.signal,
    credentialsFactory: createCredentials,
    clientFactory: (environment, token, cleanup = false) => new Client(environment, token ?? null, { signal: cleanup ? undefined : controller.signal }),
    sleep: (ms, signal) => delay(ms, undefined, { signal }), now: () => performance.now(), browser: openBrowser, child: runChild,
    ...overrides,
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const args = parse(argv);
    if (args.help) { context.stdout.write(HELP); return 0; }
    if (args.version) { context.stdout.write(`FogiPass CLI ${VERSION}\n`); return 0; }
    return (await execute(args, context)) ?? 0;
  } catch (error) {
    output(safeError(error), context.stderr);
    return controller.signal.aborted || error?.name === 'AbortError' ? 130 : 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

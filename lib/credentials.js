import { CliError } from './errors.js';
import { object, TOKEN, ORIGINS } from './client.js';

// Separate from the legacy Python client: never overwrite an existing connection.
export const SERVICE = 'com.fogito.fogipass.cli.npm';

const failure = () => new CliError('keychain_unavailable', 'An unlocked native OS keychain is required: macOS Keychain, Windows Credential Manager, or Linux Secret Service. No file storage fallback is available.');

export class Credentials {
  constructor(entry) { this.entry = entry; }

  async load() {
    try {
      const raw = await this.entry.getPassword();
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (!object(value) || !TOKEN.test(value.access_token) || !['own', 'company'].includes(value.scope)
        || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) {
        throw new CliError('invalid_credential', 'The saved connection is invalid. Revoke it in FogiPass Settings, then remove its FogiPass npm keychain entry and reconnect.');
      }
      return value;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw failure();
    }
  }

  async save(value) {
    try {
      await this.entry.setPassword(JSON.stringify({ access_token: value.access_token, scope: value.scope, expires_at: value.expires_at }));
    } catch { throw failure(); }
  }

  async delete() {
    try { await this.entry.deletePassword(); } catch { throw failure(); }
  }
}

export async function createCredentials(environment, { platform = process.platform, load = () => import('@napi-rs/keyring') } = {}) {
  if (!Object.hasOwn(ORIGINS, environment)) throw new CliError('invalid_arguments', 'Environment must be production or dev.');
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw failure();
  if (['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI', 'NAPI_RS_WASI_FLAVOR'].some(key => process.env[key])) throw failure();
  try {
    process.env.NAPI_RS_ENFORCE_VERSION_CHECK = '1';
    const { AsyncEntry } = await load();
    // Pin Secret Service: the library's default Linux fallback is not acceptable.
    const options = { linux: { store: 'secret-service' } };
    const credentials = new Credentials(new AsyncEntry(SERVICE, environment, options));
    credentials.probe = async () => {
      const { randomUUID } = await import('node:crypto');
      const probe = new AsyncEntry(`${SERVICE}.probe`, randomUUID(), options);
      try {
        await probe.setPassword('fogipass-keychain-write-check');
        if (await probe.getPassword() !== 'fogipass-keychain-write-check') throw failure();
      } catch { throw failure(); } finally {
        try { await probe.deletePassword(); } catch { throw failure(); }
      }
    };
    return credentials;
  } catch { throw failure(); }
}

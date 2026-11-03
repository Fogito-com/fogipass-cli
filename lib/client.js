import { CliError, invalidResponse } from './errors.js';

export const VERSION = '0.2.1';
export const ORIGINS = Object.freeze({ production: 'https://app.fogito.com', dev: 'https://dev.fogito.com' });
export const TOKEN = /^[a-f0-9]{24}\.[a-f0-9]{64}$/;
export const ID = /^[a-f0-9]{24}$/;
const PATHS = new Set(['device/start', 'device/poll', 'status', 'items/list', 'items/info', 'items/reveal', 'logout']);
const MAX_RESPONSE = 1024 * 1024;
const messages = {
  connection_required: 'Not connected. Run fogipass login.',
  connection_expired: 'Connection expired or revoked. Run fogipass logout, then fogipass login.',
  access_denied: 'Access was denied. Check your FogiPass permissions or authorize a new connection.',
  code_unavailable: 'The authorization code expired or was already used. Run fogipass login again.',
  not_found: 'The item is unavailable or you do not have access to it.',
  unavailable: 'FogiPass is temporarily unavailable. Please retry later.',
};

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response) {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw invalidResponse();
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(data)) throw invalidResponse();
    return data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class Client {
  constructor(environment = 'production', token = null, { fetchImpl = globalThis.fetch, signal } = {}) {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new CliError('insecure_environment', 'TLS certificate verification must be enabled. Remove NODE_TLS_REJECT_UNAUTHORIZED=0 before using FogiPass.');
    if (!Object.hasOwn(ORIGINS, environment)) throw new CliError('invalid_arguments', 'Environment must be production or dev.');
    if (token !== null && !TOKEN.test(token)) throw new CliError('invalid_credential', 'Invalid stored connection. Revoke it in FogiPass Settings and reconnect.');
    this.origin = ORIGINS[environment];
    this.token = token;
    this.fetch = fetchImpl;
    this.signal = signal;
  }

  async request(path, values = {}) {
    if (!PATHS.has(path) || !object(values)) throw new CliError('invalid_arguments', 'Unsupported CLI operation.');
    const body = JSON.stringify(values);
    if (Buffer.byteLength(body) > 8192) throw new CliError('invalid_arguments', 'Request is too large.');
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `FogiPass-CLI/${VERSION}` };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const timeout = AbortSignal.timeout(30_000);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    try {
      const response = await this.fetch(`${this.origin}/api/fogipass/cli/${path}`, {
        method: 'POST', headers, body, redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      });
      if (response.status >= 300 && response.status < 400) throw invalidResponse();
      const data = await readJson(response);
      if (response.status !== 200 || data.status !== 'success') {
        const known = Object.hasOwn(messages, data.error_code) ? data.error_code : 'request_failed';
        const message = messages[known] ?? (response.status === 429
          ? 'Too many requests. Wait a moment and retry.'
          : response.status === 409 ? 'The item changed. Retry to read its current revision.' : 'FogiPass rejected the request. Check the requested operation and your permissions.');
        throw new CliError(known, message, response.status);
      }
      if (!object(data.data)) throw invalidResponse();
      return data.data;
    } catch (error) {
      if (this.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (error instanceof CliError) throw error;
      throw new CliError('connection_failed', 'Cannot reach FogiPass securely. Check your network and try again.');
    }
  }

  async field(id, field = null, totp = false) {
    if (!ID.test(id)) throw new CliError('invalid_arguments', 'Use the 24-character item ID returned by fogipass list.');
    if (field !== null && !/^[a-z_]{1,64}$/.test(field)) throw new CliError('invalid_arguments', 'Invalid field name.');
    const item = await this.request('items/info', { id });
    if (field === null && !totp) return item;
    if (typeof item.revision !== 'string' || !item.revision) throw invalidResponse();
    const result = await this.request('items/reveal', { id, revision: item.revision, purpose: totp ? 'totp' : 'copy', field });
    if (totp) {
      if (!object(result.totp) || typeof result.totp.code !== 'string' || !/^\d{6,8}$/.test(result.totp.code)) throw invalidResponse();
      const { code, period, server_time, expires_at } = result.totp;
      return { code, period, server_time, expires_at };
    }
    if (typeof result.value !== 'string') throw invalidResponse();
    return result.value;
  }
}

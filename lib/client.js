import { CliError, invalidResponse } from './errors.js';

export const VERSION = '1.0.0';
export const ORIGINS = Object.freeze({ production: 'https://app.fogito.com', dev: 'https://dev.fogito.com' });
export const TOKEN = /^[a-f0-9]{24}\.[a-f0-9]{64}$/;
export const ID = /^[a-f0-9]{24}$/;
export const FIELD = /^[a-z_][a-z0-9_]{0,63}$/;
const PATHS = new Set(['device/start', 'device/poll', 'status', 'items/list', 'items/info', 'items/reveal', 'logout']);
const MAX_RESPONSE = 1024 * 1024;
const messages = {
  connection_required: 'Not connected. Run fogipass login.',
  connection_expired: 'Connection expired or revoked. Run fogipass logout, then fogipass login.',
  access_denied: 'Access was denied. Check your FogiPass permissions or authorize a new connection.',
  code_unavailable: 'The authorization code expired or was already used. Run fogipass login again.',
  not_found: 'The item is unavailable or you do not have access to it.',
  unavailable: 'FogiPass is temporarily unavailable. Please retry later.',
  rate_limited: 'Too many requests. Wait a moment and retry.',
  conflict: 'The item changed. Retry to read its current revision.',
  invalid_field: 'This text field is not available on this item.',
};

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateField(field) {
  if (typeof field !== 'string' || !FIELD.test(field)) throw new CliError('invalid_arguments', 'Invalid field name.');
  if (['totp', 'uris', 'custom_fields'].includes(field)) throw new CliError('invalid_arguments', field === 'totp'
    ? 'Use fogipass totp to generate a code. Authenticator seeds are not available.' : 'Choose a text field.');
}

// Explicit projections keep metadata-only commands safe if the API gains fields.
export function metadata(value, folder = false) {
  if (!object(value) || typeof value.id !== 'string' || !ID.test(value.id)) throw invalidResponse();
  const fields = folder ? ['id', 'name', 'revision', 'can_manage']
    : ['id', 'type', 'name', 'owner_id', 'owner_name', 'folder_id', 'revision', 'has_totp', 'created_at', 'updated_at'];
  const result = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== (['has_totp', 'can_manage'].includes(field) ? 'boolean' : 'string')) throw invalidResponse();
    result[field] = value[field];
  }
  return result;
}

export function metadataList(value) {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > 100 || !Array.isArray(value.folders)
    || value.folders.length > 1000 || !Number.isSafeInteger(value.count) || value.count < 0) throw invalidResponse();
  return { items: value.items.map(item => metadata(item)), count: value.count, folders: value.folders.map(folder => metadata(folder, true)) };
}

function responseError(status, data) {
  const fallback = { 401: 'connection_expired', 403: 'access_denied', 404: 'not_found', 409: 'conflict', 429: 'rate_limited' }[status]
    ?? (status >= 500 ? 'unavailable' : 'request_failed');
  const code = typeof data?.error_code === 'string' && Object.hasOwn(messages, data.error_code) ? data.error_code : fallback;
  return new CliError(code, messages[code] ?? 'FogiPass rejected the request. Check the requested operation and your permissions.', status);
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
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw invalidResponse(); }
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
      let data;
      try { data = await readJson(response); }
      catch (error) {
        // Proxies may return HTML or an empty body for rate limits and outages.
        if (!signal.aborted && response.status !== 200) throw responseError(response.status);
        throw error;
      }
      if (response.status !== 200 || data.status !== 'success') {
        throw responseError(response.status, data);
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
    if (field !== null) validateField(field);
    const item = metadata(await this.request('items/info', { id }));
    if (item.id !== id) throw invalidResponse();
    if (field === null && !totp) return item;
    if (typeof item.revision !== 'string' || !item.revision) throw invalidResponse();
    const result = await this.request('items/reveal', { id, revision: item.revision, purpose: totp ? 'totp' : 'copy', field });
    if (totp) {
      if (!object(result.totp) || typeof result.totp.code !== 'string' || !/^(?:\d{6}|\d{8})$/.test(result.totp.code)) throw invalidResponse();
      const { code, period, server_time, expires_at } = result.totp;
      if (!Number.isSafeInteger(period) || period < 15 || period > 120 || !Number.isSafeInteger(server_time)
        || server_time < 0 || !Number.isSafeInteger(expires_at) || expires_at <= server_time
        || expires_at - server_time > period) throw invalidResponse();
      return { code, period, server_time, expires_at };
    }
    if (typeof result.value !== 'string') throw invalidResponse();
    return result.value;
  }
}

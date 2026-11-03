export class CliError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function invalidResponse() {
  return new CliError('invalid_response', 'FogiPass returned an invalid response. No credential was accepted.');
}

// Do not expose network/native error text, which can contain URLs or secret values.
export function safeError(error) {
  if (error instanceof CliError) return { error: error.code, message: error.message };
  if (error?.name === 'AbortError') return { error: 'cancelled', message: 'Cancelled. Pending authorization expires after 10 minutes.' };
  return { error: 'cli_error', message: 'The operation failed. Check your connection and OS keychain, then retry.' };
}

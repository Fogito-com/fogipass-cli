# Changelog

## 1.0.1 - 2026-11-04

- Correct the 1.0.0 metadata validator to accept the API's `folder_id: null` for
  items without a folder. This affected listing, metadata and explicit field reads.
- Add complete API-shaped contract tests across Login, Card, Identity and Note,
  both with and without folders, exercising the actual HTTP client and CLI together.
- Use 1.0.1 instead of 1.0.0. The correction is a new immutable npm version;
  the original 1.0.0 tag and package are retained for release history.

## 1.0.0 - 2026-11-04

The first stable npm release retains the existing browser authorization flow,
read-only permissions, native keychain storage and production/DEV separation.
No backend changes or migration of existing npm connections are required.

### Fixed

- Identity address fields (`address1`, `address2`, `address3`) can now be retrieved
  explicitly or supplied to trusted programs through `run`.
- HTML or empty gateway errors preserve their HTTP status, including rate limiting
  during authorization, instead of becoming misleading connection failures.
- Cancellation waits for the direct child process to stop, even if it ignores
  the initial termination signal. An already-cancelled command is not started.
- Closed output pipes exit quietly without an uncaught exception.
- Invalid commands, unsupported fields and out-of-range inputs fail before opening
  the keychain or requesting secrets.

### Hardened

- Metadata-only responses use an explicit allowlist; unexpected fields are not
  printed. Invalid UTF-8, mismatched item IDs and malformed TOTP responses fail closed.
- Keychain writes are validated and read back; malformed saved entries produce a
  recovery-oriented error instead of being mistaken for a locked keychain.
- Authorization rechecks for a connection saved while browser approval was pending.
  Cancellation before persistence and persistence failures attempt revocation.
- Runtime environment injection uses a prototype-free map, rejects executable
  wrappers before secret retrieval and clears temporary references on all exits.
- The legacy Python compatibility code receives matching field-name, projection,
  gateway-error, keychain-probe and environment-injection hardening. It is not
  included in npm and remains a legacy client.

### Optimized

- Repeated bindings of the same item field in one `run` invocation share one read.
  There is no persistent secret cache or automatic retry of secret reveals.

### Verification

Regression coverage includes authorization failures, keychain read-back failures,
malformed responses, unexpected secret fields, cancellation, command injection
boundaries, output pipes and package installation. Release checks use synthetic
credentials, native OS keychains, package allowlists and secret scans.

This is an engineering review, not an independent penetration test or security
certification. See SECURITY.md for the threat model and remaining limitations.

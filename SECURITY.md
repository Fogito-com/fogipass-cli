# Security

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** action on this repository's Security tab:

https://github.com/Fogito-com/fogipass-cli/security/advisories/new

Do not report security vulnerabilities through public issues. Do not include live
credentials, vault data, personal information or authorization codes in reports.
Use synthetic examples and revoke any credentials exposed during investigation.

## Security model

FogiPass uses server-managed encryption, not zero-knowledge encryption. The CLI
receives a scoped, revocable connection credential after explicit browser approval.
It stores that credential in the native OS keychain, not a configuration file.
Search and metadata commands do not return secret fields. Retrieving a secret or
TOTP code requires an explicit command and live server-side authorization.

The CLI is read-only. Authorize only connections you initiated, use the narrowest
scope and revoke connections you no longer need. Never run untrusted programs with
secrets provided by `fogipass run`, and remember that output from `--raw` is plaintext.

The npm client requires a native keychain, explicitly selecting Secret Service on
Linux and rejecting native-library override/WASI environment flags. It does not
read the legacy Python client's credentials. No plaintext configuration, token
environment variable, installation script or browser session export is used.
Only fixed production/DEV HTTPS origins are allowed; redirects are rejected,
responses are size/time bounded and error output does not echo server/native errors.

The npm package has an explicit file allowlist. Runtime dependency versions are
pinned. Publication is manual initially; the subsequent GitHub workflow uses OIDC,
an exact version check and an npm environment approval gate configured by the owner.
These measures do not protect against a compromised OS, Node runtime, trusted
dependency or application server, and are not an independent security audit.

## Contributing safely

Never commit passwords, connection tokens, real vault exports, customer data,
environment files or keychain exports. Tests must use synthetic fixtures. Scan all
proposed commits for secrets before pushing; ignore rules alone are not protection.
Test changes using an isolated environment without production credentials.

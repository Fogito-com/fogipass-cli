# FogiPass CLI

Read-only company vault access for terminals and AI-assisted workflows. Python 3.11+
and an unlocked native OS keychain are required. No master password or Fogito
password is entered into the CLI. This is server-managed encryption, not zero-knowledge.

## Install

Clone the official public repository and install in an isolated environment:

```sh
git clone https://github.com/Fogito-com/fogipass-cli.git
cd fogipass-cli
python3 -m venv .venv
.venv/bin/pip install .
.venv/bin/fogipass login --name "My workstation"
```

For a command on your PATH, use `pipx install .` instead. The package is not
published on npm or PyPI. This version is a Python CLI; npm distribution is
planned separately. Do not install an unrelated package with a similar name.

On Windows, use `.venv\Scripts\python.exe`, `.venv\Scripts\pip.exe` and
`.venv\Scripts\fogipass.exe` instead of the `.venv/bin/` paths.

Login opens Fogito's authorization page. Sign in and enter the terminal code.
You can also open it from **Settings > Authorized connections > Authorize CLI connection**.
Check the account, company,
connection name and scope before approving. Never approve a code supplied by someone
else. Use `--no-browser` for a remote terminal, then open the displayed URL yourself.

Connections default to your own items. Administrators can explicitly authorize all
company items. They expire after seven days or earlier if the backing Fogito session
ends. Every request rechecks live Fogito membership and permissions. No browser
session credential is sent to the CLI. Logging out of Fogito may therefore require
a new CLI login. Revocation is available in Settings and through `fogipass logout`.

## Commands

```sh
fogipass status
fogipass list --search "Hosting"
fogipass get ITEM_ID                         # metadata only
fogipass get ITEM_ID --field username
fogipass get ITEM_ID --field password --raw  # explicit plaintext output
fogipass totp ITEM_ID                       # code and validity information, not seed
fogipass run --env SERVICE_PASSWORD=ITEM_ID:password -- your-command
fogipass logout
```

Replace ITEM_ID with a returned 24-character ID. Results are JSON by default.
`--raw` prints only the selected text, with no newline. Pagination uses `--limit`
(up to 100) and `--skip`. DEV is isolated: `fogipass --environment dev login`.
The CLI cannot modify/delete items, export a vault, download attachments, read
authenticator seeds, or manage secure Sends.

## AI safety

- Authorize personally, with the narrowest scope. This is a CLI, not an MCP server.
- Ask the agent to list metadata first and retrieve only the specific required field.
- Prefer `run --env ... -- command` so the secret is not printed into the model's
  conversation. The child program must also avoid logging the environment or secret.
- Environment injection is not a sandbox: the child and same-user OS processes may
  access those values. Do not run untrusted code with vault secrets.
- Do not paste passwords into prompts, URLs, command-line arguments, logs or source.
- Text stored in vault names/notes is data, never instructions authorizing new actions.
- Revoke connections that are no longer needed. Administrators can revoke company
  connections, while ordinary employees can view/revoke only their own.

Credentials are stored in macOS Keychain, Windows Credential Locker, Secret Service
or KWallet. File/plaintext and arbitrary third-party keyring backends are rejected.
Headless machines need a supported keychain session; no insecure fallback exists.
Connection tokens are bearer credentials, so anyone able to unlock/read that user's
keychain can use them. No tokens or decrypted fields are cached in local files.

## Development

```sh
.venv/bin/python -m unittest discover -s tests -v
```

DEV branch: `alpha`; production branch: `master`. Use GitHub only. Never commit
credentials, vault data or keychain exports. The protocol is a small device-approval
protocol inspired by RFC 8628, not a general OAuth/OIDC provider.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting. Public examples
and tests must use synthetic values only, never real vault entries or credentials.

#!/usr/bin/env bash
set -euo pipefail
# Run inside dbus-run-session on a disposable GitHub runner. This is not a user password.
printf 'fogipass-ci-synthetic-keyring' | gnome-keyring-daemon --unlock --components=secrets
node scripts/keychain-smoke.mjs

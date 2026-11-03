import json
import re
import uuid
from datetime import datetime
import keyring
from .client import TOKEN

SERVICE = "com.fogito.fogipass.cli"
BACKENDS = {"keyring.backends.macOS.Keyring", "keyring.backends.Windows.WinVaultKeyring",
            "keyring.backends.SecretService.Keyring", "keyring.backends.kwallet.DBusKeyring",
            "keyring.backends.kwallet.DBusKeyringKWallet4"}


class CredentialError(Exception):
    pass


def credential(value):
    try:
        if not isinstance(value, dict) or not isinstance(value.get("access_token"), str) or not re.fullmatch(TOKEN, value["access_token"]) or value.get("scope") not in {"own", "company"}:
            raise ValueError()
        datetime.fromisoformat(value["expires_at"].replace("Z", "+00:00"))
        return {key: value[key] for key in ("access_token", "scope", "expires_at")}
    except (KeyError, ValueError, TypeError, AttributeError):
        raise CredentialError("Invalid saved connection. Revoke it in FogiPass Settings and remove its legacy keychain entry.") from None


class Credentials:
    def __init__(self, environment):
        self.environment = environment
        backend = keyring.get_keyring()
        name = type(backend).__module__ + "." + type(backend).__name__
        if name == "keyring.backends.chainer.ChainerBackend":
            # Do not let a configured fallback silently persist secrets to a file.
            backend = next((candidate for candidate in backend.backends
                            if type(candidate).__module__ + "." + type(candidate).__name__ in BACKENDS), None)
            name = type(backend).__module__ + "." + type(backend).__name__
        if name not in BACKENDS:
            raise CredentialError("A native OS keychain is required. Enable macOS Keychain, Windows Credential Locker, Secret Service or KWallet. Plaintext storage is not supported.")
        self.backend = backend

    def load(self):
        try:
            value = self.backend.get_password(SERVICE, self.environment)
            if value is None:
                return None
            if not isinstance(value, str) or len(value) > 4096:
                raise ValueError()
            parsed = json.loads(value)
            return parsed if parsed == {"pending": True} else credential(parsed)
        except Exception as error:
            raise CredentialError("Could not read the OS keychain. Unlock it and try again.") from error

    def save(self, value):
        expected = credential(value)
        try:
            self.backend.set_password(SERVICE, self.environment, json.dumps(expected))
            if self.load() != expected:
                raise ValueError()
        except Exception as error:
            raise CredentialError("Could not save the connection in the OS keychain.") from error

    def probe(self):
        account = str(uuid.uuid4())
        try:
            self.backend.set_password(SERVICE + ".probe", account, "fogipass-keychain-write-check")
            if self.backend.get_password(SERVICE + ".probe", account) != "fogipass-keychain-write-check":
                raise ValueError()
        except Exception:
            raise CredentialError("Could not verify OS keychain write access.") from None
        finally:
            try:
                self.backend.delete_password(SERVICE + ".probe", account)
            except Exception:
                raise CredentialError("Could not remove the keychain probe.") from None

    def delete(self):
        try:
            if self.backend.get_password(SERVICE, self.environment) is not None:
                self.backend.delete_password(SERVICE, self.environment)
        except Exception as error:
            raise CredentialError("Could not remove the connection from the OS keychain.") from error

import json
import keyring

SERVICE = "com.fogito.fogipass.cli"
BACKENDS = {"keyring.backends.macOS.Keyring", "keyring.backends.Windows.WinVaultKeyring",
            "keyring.backends.SecretService.Keyring", "keyring.backends.kwallet.DBusKeyring",
            "keyring.backends.kwallet.DBusKeyringKWallet4"}


class CredentialError(Exception):
    pass


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
            return json.loads(value) if value else None
        except Exception as error:
            raise CredentialError("Could not read the OS keychain. Unlock it and try again.") from error

    def save(self, value):
        try:
            self.backend.set_password(SERVICE, self.environment, json.dumps(value))
        except Exception as error:
            raise CredentialError("Could not save the connection in the OS keychain.") from error

    def delete(self):
        try:
            if self.backend.get_password(SERVICE, self.environment) is not None:
                self.backend.delete_password(SERVICE, self.environment)
        except Exception as error:
            raise CredentialError("Could not remove the connection from the OS keychain.") from error

import contextlib
import io
import json
import unittest
from unittest.mock import patch, Mock

from fogipass_cli.client import Client, ApiError, NoRedirect, metadata_list
from fogipass_cli.credentials import Credentials, CredentialError
from fogipass_cli.cli import parser, binding, emit, main, login


class Tests(unittest.TestCase):
    def test_metadata_default(self):
        args = parser().parse_args(['get', 'a' * 24])
        self.assertIsNone(args.field)
        client = Client(); client.request = Mock(return_value={'id': 'a' * 24})
        self.assertEqual(client.field('a' * 24), {'id': 'a' * 24})
        client.request.assert_called_once_with('items/info', {'id': 'a' * 24})

    def test_reveal_revision(self):
        client = Client(); client.request = Mock(side_effect=[{'id': 'a' * 24, 'revision': 'revision'}, {'value': 'fixture-secret'}])
        self.assertEqual(client.field('a' * 24, 'password'), 'fixture-secret')
        self.assertEqual(client.request.call_args.args, ('items/reveal', {'id': 'a' * 24, 'revision': 'revision', 'purpose': 'copy', 'field': 'password'}))

    def test_https_and_no_redirects(self):
        token = 'a' * 24 + '.' + 'b' * 64
        client = Client('production', token)
        response = Mock(); response.status = 200; response.read.return_value = b'{"status":"success","data":{"ok":true}}'
        response.__enter__ = Mock(return_value=response); response.__exit__ = Mock()
        client.opener = Mock(); client.opener.open.return_value = response
        self.assertTrue(client.request('status')['ok'])
        request = client.opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://app.fogito.com/api/fogipass/cli/status')
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + token)
        self.assertNotIn(token, request.full_url)
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'http://evil.invalid'))
        with self.assertRaises(ValueError): client.request('../vault/export')

    def test_keyring_fail_closed(self):
        with patch('keyring.get_keyring', return_value=Mock()):
            with self.assertRaises(CredentialError): Credentials('production')

    def test_native_keyring(self):
        native = type('Keyring', (), {'__module__': 'keyring.backends.macOS'})()
        native.get_password = Mock(return_value=None); native.set_password = Mock(); native.delete_password = Mock()
        with patch('keyring.get_keyring', return_value=native):
            creds = Credentials('dev'); self.assertIsNone(creds.load())
            value = {'access_token': 'a' * 24 + '.' + 'b' * 64, 'scope': 'own', 'expires_at': '2030-01-01T00:00:00Z'}
            native.get_password.return_value = json.dumps(value)
            creds.save(value)
            self.assertEqual(native.set_password.call_args.args[0:2], ('com.fogito.fogipass.cli', 'dev'))
            self.assertEqual(creds.load(), value)
            creds.delete(); native.delete_password.assert_called_once()

    def test_raw_and_json_output(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output): emit('secret\x1b[2J')
        self.assertIn('\\u001b', output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output): emit('exact', True)
        self.assertEqual(output.getvalue(), 'exact')
        with self.assertRaises(ValueError): emit({}, True)

    def test_environment_binding(self):
        self.assertEqual(binding('SERVICE_PASSWORD=' + 'a' * 24 + ':password'), ('SERVICE_PASSWORD', 'a' * 24, 'password'))
        for name in ['PATH', 'Path', 'COMSPEC', 'NODE_OPTIONS', 'NAPI_RS_NATIVE_LIBRARY_PATH', 'GIT_CONFIG', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', '1BAD']:
            with self.assertRaises(ValueError): binding(name + '=' + 'a' * 24 + ':password')

    def test_logout_failure_keeps_credential(self):
        creds = Mock(); creds.load.return_value = {'access_token': 'a' * 24 + '.' + 'b' * 64}
        with patch('sys.argv', ['fogipass', 'logout']), patch('fogipass_cli.cli.Credentials', return_value=creds), patch('fogipass_cli.cli.Client') as client, contextlib.redirect_stderr(io.StringIO()):
            client.return_value.request.side_effect = ApiError('unavailable', 'Offline', 503)
            with self.assertRaises(SystemExit): main()
        creds.delete.assert_not_called()

    def test_login_never_prints_token(self):
        args = parser().parse_args(['login', '--no-browser', '--name', 'Fixture'])
        creds = Mock(); creds.load.return_value = None
        token = 'a' * 24 + '.' + 'b' * 64
        output, errors = io.StringIO(), io.StringIO()
        with patch('fogipass_cli.cli.Client') as factory, patch('time.sleep'), contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            factory.return_value.origin = 'https://app.fogito.com'
            factory.return_value.request.side_effect = [
                {'verification_uri': 'https://app.fogito.com/fogipass/settings/connections/authorize', 'device_code': 'b' * 64, 'user_code': 'ABCD-EF01-2345', 'expires_in': 600, 'interval': 5},
                {'state': 'authorized', 'access_token': token, 'scope': 'own', 'expires_at': '2030-01-01T00:00:00Z', 'token_type': 'Bearer', 'connection_id': 'a' * 24}]
            login(args, creds)
        self.assertNotIn(token, output.getvalue() + errors.getvalue())
        self.assertTrue(json.loads(output.getvalue())['connected'])
        self.assertEqual(creds.save.call_args.args[0]['access_token'], token)

    def test_metadata_projection_and_address_fields(self):
        item = {'id': 'a' * 24, 'type': 'identity', 'name': 'Synthetic identity', 'owner_id': 'b' * 24,
                'owner_name': 'Synthetic owner', 'folder_id': None, 'revision': 'c' * 32, 'has_totp': False,
                'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-01T00:00:00Z', 'password': 'synthetic-secret'}
        client = Client(); client.request = Mock(side_effect=[item, {'value': 'Synthetic address'}])
        self.assertEqual(client.field(item['id'], 'address1'), 'Synthetic address')
        result = metadata_list({'items': [item], 'folders': [item], 'count': 1, 'token': 'synthetic-secret'})
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.assertIsNone(result['items'][0]['folder_id'])
        for field in ['totp', 'uris', 'custom_fields', 'bad-field']:
            with self.assertRaises(ValueError): client.field(item['id'], field)
        self.assertEqual(client.request.call_count, 2)

    def test_http_errors_do_not_echo_server_content(self):
        for status in [401, 403, 409, 429, 503]:
            client = Client()
            response = Mock(); response.status = status; response.read.return_value = b'<html>synthetic-secret</html>'
            response.__enter__ = Mock(return_value=response); response.__exit__ = Mock()
            client.opener = Mock(); client.opener.open.return_value = response
            with self.assertRaises(ApiError) as caught: client.request('status')
            self.assertEqual(caught.exception.status, status)
            self.assertNotIn('synthetic-secret', str(caught.exception))

    def test_totp_drops_seed_and_rejects_invalid_timings(self):
        client = Client()
        code = {'code': '123456', 'period': 30, 'server_time': 100, 'expires_at': 120, 'seed': 'synthetic-secret'}
        client.request = Mock(side_effect=[{'id': 'a' * 24, 'revision': 'revision'}, {'totp': code}])
        self.assertNotIn('seed', client.field('a' * 24, totp=True))
        code['expires_at'] = 100
        client.request = Mock(side_effect=[{'id': 'a' * 24, 'revision': 'revision'}, {'totp': code}])
        with self.assertRaises(ValueError): client.field('a' * 24, totp=True)

    def test_keychain_probe_does_not_replace_the_real_connection(self):
        native = type('Keyring', (), {'__module__': 'keyring.backends.macOS'})()
        native.get_password = Mock(return_value='fogipass-keychain-write-check'); native.set_password = Mock(); native.delete_password = Mock()
        with patch('keyring.get_keyring', return_value=native): Credentials('dev').probe()
        self.assertEqual(native.set_password.call_args.args[0], 'com.fogito.fogipass.cli.probe')
        self.assertEqual(native.delete_password.call_args.args, native.set_password.call_args.args[:2])

    def test_windows_wrappers_are_rejected_without_revealing(self):
        creds = Mock(); creds.load.return_value = {'access_token': 'a' * 24 + '.' + 'b' * 64}
        with patch('sys.argv', ['fogipass', 'run', '--env', 'X=' + 'a' * 24 + ':password', '--', 'example.cmd']), patch('fogipass_cli.cli.Credentials', return_value=creds), patch('fogipass_cli.cli.Client') as client, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit): main()
        client.return_value.field.assert_not_called()


if __name__ == '__main__': unittest.main()

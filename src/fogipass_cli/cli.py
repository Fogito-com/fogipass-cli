import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time
import webbrowser

from .client import Client, ApiError, metadata_list, validate_field
from .credentials import Credentials, CredentialError, credential


def emit(value, raw=False):
    if raw:
        if not isinstance(value, str):
            raise ValueError("Raw output requires a text value")
        sys.stdout.write(value)
    else:
        print(json.dumps(value, ensure_ascii=True))


def login(args, credentials):
    previous = credentials.load()
    if previous == {'pending': True}:
        credentials.delete(); previous = None
    if previous:
        raise CredentialError("A connection is already stored. Run fogipass logout before connecting again.")
    # Check keychain write access before asking the user to authorize anything.
    credentials.probe()
    client = Client(args.environment)
    device = client.request("device/start", {"name": args.name})
    uri = client.origin + "/fogipass/settings/connections/authorize"
    if device.get("verification_uri") != uri or not isinstance(device.get("user_code"), str) or not re.fullmatch(r"[A-F0-9]{4}(-[A-F0-9]{4}){2}", device["user_code"]) or not isinstance(device.get("device_code"), str) or not re.fullmatch(r"[a-f0-9]{64}", device["device_code"]) or type(device.get("expires_in")) is not int or not 1 <= device["expires_in"] <= 600 or device.get("interval") != 5:
        raise ApiError("invalid_response", "Invalid authorization response.")
    print(f"Open {uri}\nEnter this code on the authorization page: {device['user_code']}\nOnly approve the login you started here.", file=sys.stderr)
    if not args.no_browser:
        webbrowser.open(uri, new=2)
    deadline = time.monotonic() + min(int(device["expires_in"]), 600)
    while time.monotonic() < deadline:
        time.sleep(5)
        if time.monotonic() >= deadline:
            break
        try:
            result = client.request("device/poll", {"device_code": device["device_code"]})
        except ApiError as error:
            if error.status == 429:
                time.sleep(10)
                continue
            raise
        if result.get("state") == "pending":
            continue
        if result.get("state") != "authorized":
            raise ApiError("authorization_denied", "Connection was not authorized.")
        value = credential(result)
        token = value["access_token"]
        if result.get("token_type") != "Bearer" or token != str(result.get("connection_id", "")) + "." + device["device_code"]:
            raise ApiError("invalid_response", "Invalid authorization response.")
        try:
            if credentials.load():
                raise CredentialError("Another connection was saved during authorization. Check fogipass status.")
            credentials.save(value)
        except CredentialError:
            try:
                Client(args.environment, token).request("logout")
            except ApiError:
                print("Revoke this connection in FogiPass Settings; local credential storage failed.", file=sys.stderr)
            raise
        emit({"connected": True, "environment": args.environment, "scope": result["scope"], "expires_at": result["expires_at"]})
        return
    raise ApiError("authorization_expired", "Authorization timed out. Run fogipass login again.")


def binding(value):
    match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)=([a-f0-9]{24}):([a-z_][a-z0-9_]{0,63})", value)
    if not match:
        raise ValueError("Use --env VARIABLE=ITEM_ID:FIELD")
    name, item, field = match.groups()
    validate_field(field)
    upper = name.upper()
    if upper in {"PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "HOME", "BASH_ENV", "ENV", "SHELLOPTS", "IFS", "ZDOTDIR"} or upper.startswith(("LD_", "DYLD_", "NODE_", "NAPI_RS_", "PYTHON", "GIT_", "NPM_", "BASH_FUNC_")):
        raise ValueError("Runtime-control environment variables cannot contain vault values")
    return name, item, field


def parser():
    result = argparse.ArgumentParser(prog="fogipass", description="Browser-authorized, read-only company vault access. Output is JSON unless --raw is explicitly selected.")
    result.add_argument("--environment", choices=["production", "dev"], default="production")
    result.add_argument("--version", action="version", version="FogiPass CLI 0.1.0")
    commands = result.add_subparsers(dest="command", required=True)
    auth = commands.add_parser("login"); auth.add_argument("--name", default="FogiPass CLI - " + socket.gethostname()); auth.add_argument("--no-browser", action="store_true")
    commands.add_parser("status"); commands.add_parser("logout")
    listing = commands.add_parser("list", help="Search item names; never decrypts values")
    listing.add_argument("--search", default=""); listing.add_argument("--limit", type=int, choices=[5, 10, 20, 50, 100], default=20); listing.add_argument("--skip", type=int, default=0)
    get = commands.add_parser("get", help="Metadata by default; --field explicitly reveals one value")
    get.add_argument("id"); get.add_argument("--field"); get.add_argument("--raw", action="store_true")
    totp = commands.add_parser("totp", help="Generate a 2FA code, without exposing its seed")
    totp.add_argument("id"); totp.add_argument("--raw", action="store_true")
    run = commands.add_parser("run", help="Inject explicit fields into a child process without printing them")
    run.add_argument("--env", action="append", required=True); run.add_argument("program", nargs=argparse.REMAINDER)
    return result


def main():
    args = parser().parse_args()
    try:
        credentials = Credentials(args.environment)
        if args.command == "login":
            login(args, credentials)
            return
        saved = credentials.load()
        if not isinstance(saved, dict) or not isinstance(saved.get("access_token"), str) or not re.fullmatch(r"[a-f0-9]{24}\.[a-f0-9]{64}", saved["access_token"]):
            raise CredentialError("Not connected. Run fogipass login.")
        client = Client(args.environment, saved["access_token"])
        if args.command == "logout":
            try:
                client.request("logout")
            except ApiError as error:
                if error.status != 401:
                    raise  # Keep the local token so a failed revocation can be retried.
            credentials.delete(); emit({"connected": False})
        elif args.command == "status":
            status = client.request("status")
            if any(not isinstance(status.get(key), str) for key in ("name", "owner_name", "scope", "expires_at")):
                raise ValueError("Invalid status response")
            emit({key: status[key] for key in ("name", "owner_name", "scope", "expires_at")})
        elif args.command == "list":
            emit(metadata_list(client.request("items/list", {"search": args.search, "limit": args.limit, "skip": args.skip})))
        elif args.command == "get":
            if args.raw and not args.field:
                raise ValueError("--raw requires --field")
            emit(client.field(args.id, args.field), args.raw)
        elif args.command == "totp":
            result = client.field(args.id, totp=True)
            emit(result["code"] if args.raw else result, args.raw)
        elif args.command == "run":
            program = args.program[1:] if args.program[:1] == ["--"] else args.program
            if not program or not program[0] or program[0].lower().endswith((".cmd", ".bat")) or any("\0" in arg for arg in program):
                raise ValueError("Specify an executable after --, not a Windows .cmd/.bat wrapper")
            bindings = [binding(value) for value in args.env]
            key = lambda name: name.upper() if os.name == "nt" else name
            if len({key(value[0]) for value in bindings}) != len(bindings):
                raise ValueError("Duplicate environment variable")
            env = os.environ.copy()
            values = {}
            try:
                for name, item, field in bindings:
                    if (item, field) not in values:
                        values[item, field] = client.field(item, field)
                    value = values[item, field]
                    if not isinstance(value, str) or "\x00" in value:
                        raise ValueError("This field cannot be passed as an environment variable")
                    for existing in list(env):
                        if key(existing) == key(name):
                            del env[existing]
                    env[name] = value
                completed = subprocess.run(program, env=env, shell=False)
                raise SystemExit(completed.returncode if completed.returncode >= 0 else 128 - completed.returncode)
            finally:
                env.clear(); values.clear()
    except (ApiError, CredentialError, ValueError, OSError, KeyError, TypeError) as error:
        # JSON escaping prevents names/error text from injecting terminal control sequences.
        message = str(error) if isinstance(error, (ApiError, CredentialError)) else "The operation failed. Check the arguments, connection and OS keychain."
        print(json.dumps({"error": getattr(error, "code", "cli_error"), "message": message}, ensure_ascii=True), file=sys.stderr)
        raise SystemExit(1)
    except KeyboardInterrupt:
        print("Cancelled. Any pending authorization expires after 10 minutes.", file=sys.stderr)
        raise SystemExit(130)


if __name__ == "__main__":
    main()

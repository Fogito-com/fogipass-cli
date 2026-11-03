import json
import re
import urllib.error
import urllib.request

ORIGINS = {"production": "https://app.fogito.com", "dev": "https://dev.fogito.com"}
TOKEN = r"[a-f0-9]{24}\.[a-f0-9]{64}"


def validate_field(field):
    if not isinstance(field, str) or not re.fullmatch(r"[a-z_][a-z0-9_]{0,63}", field):
        raise ValueError("Invalid field name")
    if field in {"totp", "uris", "custom_fields"}:
        raise ValueError("Choose a text field. Use fogipass totp for codes; seeds are not available.")


def metadata(value, folder=False):
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not re.fullmatch(r"[a-f0-9]{24}", value["id"]):
        raise ValueError("Invalid metadata response")
    fields = ("id", "name", "revision", "can_manage") if folder else (
        "id", "type", "name", "owner_id", "owner_name", "folder_id", "revision", "has_totp", "created_at", "updated_at")
    result = {}
    for field in fields:
        if field in value:
            if type(value[field]) is not (bool if field in {"has_totp", "can_manage"} else str):
                raise ValueError("Invalid metadata response")
            result[field] = value[field]
    return result


def metadata_list(value):
    if not isinstance(value, dict) or not isinstance(value.get("items"), list) or not isinstance(value.get("folders"), list) or type(value.get("count")) is not int or value["count"] < 0:
        raise ValueError("Invalid metadata response")
    return {"items": [metadata(item) for item in value["items"]], "count": value["count"],
            "folders": [metadata(folder, True) for folder in value["folders"]]}


class ApiError(Exception):
    def __init__(self, code, message, status=0):
        super().__init__(message)
        self.code, self.status = code, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, environment="production", token=None):
        if environment not in ORIGINS or (token is not None and (not isinstance(token, str) or not re.fullmatch(TOKEN, token))):
            raise ValueError("Invalid environment or connection credential")
        self.origin = ORIGINS[environment]
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, values=None):
        if path not in {"device/start", "device/poll", "status", "items/list", "items/info", "items/reveal", "logout"}:
            raise ValueError("Unsupported CLI operation")
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "FogiPass-CLI/0.1.0"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(self.origin + "/api/fogipass/cli/" + path,
                                         data=json.dumps(values or {}).encode(), headers=headers, method="POST")
        try:
            try:
                response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.status
                raw = response.read(1048577)
            if status != 200:
                code, message = {
                    401: ("connection_expired", "Connection expired or revoked. Run fogipass logout, then login."),
                    403: ("access_denied", "Access was denied. Check your FogiPass permissions."),
                    404: ("not_found", "The item or authorization is unavailable."),
                    409: ("conflict", "The item changed. Retry to read its current revision."),
                    429: ("rate_limited", "Too many requests. Wait a moment and retry."),
                }.get(status, ("request_failed", "FogiPass rejected the request. Please retry later."))
                raise ApiError(code, message, status)
            if len(raw) > 1048576:
                raise ValueError("Oversized response")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("Invalid response")
            if data.get("status") != "success":
                raise ApiError("request_failed", "FogiPass rejected the request.", status)
            if not isinstance(data.get("data"), dict):
                raise ValueError("Invalid result")
            return data["data"]
        except ApiError:
            raise
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise ApiError("connection_failed", "Cannot reach FogiPass securely. Check your network and try again.") from error

    def field(self, item_id, field=None, totp=False):
        if not isinstance(item_id, str) or not re.fullmatch(r"[a-f0-9]{24}", item_id):
            raise ValueError("Invalid item ID")
        if field is not None:
            validate_field(field)
        item = metadata(self.request("items/info", {"id": item_id}))
        if item["id"] != item_id:
            raise ValueError("Invalid metadata response")
        if field is None and not totp:
            return item
        result = self.request("items/reveal", {"id": item_id, "revision": item["revision"],
                                               "purpose": "totp" if totp else "copy", "field": field})
        if totp:
            code = result.get("totp")
            if not isinstance(code, dict) or not isinstance(code.get("code"), str) or not re.fullmatch(r"(?:\d{6}|\d{8})", code["code"], re.ASCII):
                raise ValueError("Invalid TOTP response")
            if any(type(code.get(key)) is not int for key in ("period", "server_time", "expires_at")) or not 15 <= code["period"] <= 120 or not 0 < code["expires_at"] - code["server_time"] <= code["period"]:
                raise ValueError("Invalid TOTP response")
            return {key: code[key] for key in ("code", "period", "server_time", "expires_at")}
        if not isinstance(result.get("value"), str):
            raise ValueError("Invalid field response")
        return result["value"]

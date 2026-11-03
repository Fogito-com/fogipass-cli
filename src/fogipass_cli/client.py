import json
import urllib.error
import urllib.request

ORIGINS = {"production": "https://app.fogito.com", "dev": "https://dev.fogito.com"}


class ApiError(Exception):
    def __init__(self, code, message, status=0):
        super().__init__(message)
        self.code, self.status = code, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, environment="production", token=None):
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
            if len(raw) > 1048576:
                raise ValueError("Oversized response")
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError("Invalid response")
            if status != 200 or data.get("status") != "success":
                raise ApiError(str(data.get("error_code", "request_failed")), str(data.get("description", "Request failed.")), status)
            if not isinstance(data.get("data"), dict):
                raise ValueError("Invalid result")
            return data["data"]
        except ApiError:
            raise
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise ApiError("connection_failed", "Cannot reach FogiPass securely. Check your network and try again.") from error

    def field(self, item_id, field=None, totp=False):
        item = self.request("items/info", {"id": item_id})
        if field is None and not totp:
            return item
        result = self.request("items/reveal", {"id": item_id, "revision": item["revision"],
                                               "purpose": "totp" if totp else "copy", "field": field})
        return result["totp"] if totp else result["value"]

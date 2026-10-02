#!/usr/bin/env python3
"""Azure token broker.

Holds one human `az login` (device code, done once; state persisted in AZURE_CONFIG_DIR volume)
and exposes Azure's App Service managed-identity token protocol so sibling containers can run
`az login --identity` against it. Tokens carry that human's permissions; the refresh token never
leaves this container. Stdlib only.
"""
import json, os, subprocess, sys, time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SECRET = os.environ.get("BROKER_SECRET") or sys.exit("BROKER_SECRET is required")
PORT = int(os.environ.get("PORT", "8081"))
_cache: dict[str, tuple[float, dict]] = {}  # resource -> (expires_epoch, response)
_login_cache: tuple[float, dict] | None = None


def az(*args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(["az", *args, "-o", "json"], capture_output=True, text=True, timeout=timeout)


def token_for(resource: str) -> dict:
    now = time.time()
    hit = _cache.get(resource)
    if hit and hit[0] - 300 > now:
        return hit[1]
    r = az("account", "get-access-token", "--resource", resource)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "az account get-access-token failed")
    t = json.loads(r.stdout)
    exp = t.get("expires_on")
    if exp is None:  # older az: local-time string "2026-09-15 12:34:56.000000"
        exp = int(datetime.strptime(t["expiresOn"].split(".")[0], "%Y-%m-%d %H:%M:%S").timestamp())
    body = {"access_token": t["accessToken"], "expires_on": str(int(exp)), "resource": resource, "token_type": t.get("tokenType", "Bearer"), "client_id": "user"}
    _cache[resource] = (float(exp), body)
    return body


def login_state() -> dict:
    global _login_cache
    if _login_cache and _login_cache[0] > time.time():
        return _login_cache[1]
    r = az("account", "show", timeout=30)
    state = {"logged_in": False}
    if r.returncode == 0:
        a = json.loads(r.stdout)
        state = {"logged_in": True, "account": a.get("user", {}).get("name"), "subscription": a.get("name"), "tenant": a.get("tenantId")}
    _login_cache = (time.time() + 60, state)
    return state


class H(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, **login_state()})
        if u.path not in ("/token", "/MSI/token", "/msi/token"):
            return self._send(404, {"error": "not found"})
        secret = self.headers.get("X-IDENTITY-HEADER") or self.headers.get("secret")
        if secret != SECRET:
            return self._send(401, {"error": "bad identity header"})
        resource = (parse_qs(u.query).get("resource") or [""])[0]
        if not resource:
            return self._send(400, {"error": "resource is required"})
        try:
            self._send(200, token_for(resource))
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e), "hint": "run: docker exec -it ai-employee-azbroker-1 az login --use-device-code"})

    def log_message(self, fmt: str, *args) -> None:  # no tokens in logs; path only
        sys.stderr.write("%s %s %s\n" % (self.address_string(), self.command, urlparse(self.path).path))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

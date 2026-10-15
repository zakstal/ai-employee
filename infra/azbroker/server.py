#!/usr/bin/env python3
"""Azure token broker.

Holds one human `az login` per employee (device code, done once; state persisted under the AZURE_CONFIG_DIR volume)
and exposes Azure's App Service managed-identity token protocol so sibling containers can run
`az login --identity` against it. Tokens carry that human's permissions; the refresh token never
leaves this container. Stdlib only.
"""
import hmac, json, os, subprocess, sys, time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# BROKER_SECRETS = {"<employee>": "<secret>"}: each employee has its own key and its own az login home.
# The single BROKER_SECRET still works as employee "default", whose login home is the volume root (as before).
SECRETS: dict[str, str] = json.loads(os.environ["BROKER_SECRETS"]) if os.environ.get("BROKER_SECRETS") else (
    {"default": os.environ["BROKER_SECRET"]} if os.environ.get("BROKER_SECRET") else sys.exit("BROKER_SECRETS or BROKER_SECRET is required"))
PORT = int(os.environ.get("PORT", "8081"))
BASE_DIR = os.environ.get("AZURE_CONFIG_DIR", "/azure")
_cache: dict[tuple[str, str], tuple[float, dict]] = {}  # (employee, resource) -> (expires_epoch, response)
_login_cache: dict[str, tuple[float, dict]] = {}


def employee_for(secret: str | None) -> str | None:
    found = None
    for emp, s in SECRETS.items():  # compare against every key: no early exit on a match
        if hmac.compare_digest(s.encode(), (secret or "").encode()):
            found = emp
    return found


def config_dir(emp: str) -> str:
    return BASE_DIR if emp == "default" else f"{BASE_DIR}/{emp}"


def az(emp: str, *args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    env = {**os.environ, "AZURE_CONFIG_DIR": config_dir(emp)}
    return subprocess.run(["az", *args, "-o", "json"], capture_output=True, text=True, timeout=timeout, env=env)


def token_for(emp: str, resource: str) -> dict:
    now = time.time()
    hit = _cache.get((emp, resource))
    if hit and hit[0] - 300 > now:
        return hit[1]
    r = az(emp, "account", "get-access-token", "--resource", resource)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:] or "az account get-access-token failed")
    t = json.loads(r.stdout)
    exp = t.get("expires_on")
    if exp is None:  # older az: local-time string "2026-09-15 12:34:56.000000"
        exp = int(datetime.strptime(t["expiresOn"].split(".")[0], "%Y-%m-%d %H:%M:%S").timestamp())
    body = {"access_token": t["accessToken"], "expires_on": str(int(exp)), "resource": resource, "token_type": t.get("tokenType", "Bearer"), "client_id": "user"}
    _cache[(emp, resource)] = (float(exp), body)
    return body


def login_state(emp: str) -> dict:
    hit = _login_cache.get(emp)
    if hit and hit[0] > time.time():
        return hit[1]
    r = az(emp, "account", "show", timeout=30)
    state = {"logged_in": False}
    if r.returncode == 0:
        a = json.loads(r.stdout)
        state = {"logged_in": True, "account": a.get("user", {}).get("name"), "subscription": a.get("name"), "tenant": a.get("tenantId")}
    _login_cache[emp] = (time.time() + 60, state)
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
            states = {e: login_state(e) for e in SECRETS}
            return self._send(200, {"ok": True, "logged_in": all(s["logged_in"] for s in states.values()), "employees": states})
        if u.path not in ("/token", "/MSI/token", "/msi/token"):
            return self._send(404, {"error": "not found"})
        secret = self.headers.get("X-IDENTITY-HEADER") or self.headers.get("secret")
        emp = employee_for(secret)
        if emp is None:
            return self._send(401, {"error": "bad identity header"})
        resource = (parse_qs(u.query).get("resource") or [""])[0]
        if not resource:
            return self._send(400, {"error": "resource is required"})
        try:
            self._send(200, token_for(emp, resource))
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": str(e), "hint": f"run: docker exec -it ai-employee-azbroker-1 sh -c 'AZURE_CONFIG_DIR={config_dir(emp)} az login --use-device-code'"})

    def log_message(self, fmt: str, *args) -> None:  # no tokens in logs; path only
        sys.stderr.write("%s %s %s\n" % (self.address_string(), self.command, urlparse(self.path).path))


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()

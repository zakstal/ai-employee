"""python3 -m unittest infra/azbroker/test_server.py"""
import importlib.util, json, os, threading, unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

os.environ["BROKER_SECRETS"] = json.dumps({"alice": "key-a", "bob": "key-b"})
os.environ.pop("BROKER_SECRET", None)
os.environ["AZURE_CONFIG_DIR"] = "/azure"
spec = importlib.util.spec_from_file_location("broker", Path(__file__).with_name("server.py"))
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


class Done:
    returncode = 0
    stderr = ""

    def __init__(self, emp):
        self.stdout = json.dumps({"accessToken": f"tok-{emp}", "expires_on": 4102444800, "tenantId": "t", "user": {"name": emp}, "name": "sub"})


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.dirs = []

        def fake_az(emp, *args, timeout=60):
            self.dirs.append((emp, broker.config_dir(emp)))
            return Done(emp)

        broker.az = fake_az
        broker._cache.clear()
        broker._login_cache.clear()
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), broker.H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def tearDown(self):
        self.srv.shutdown()

    def get(self, path, secret=None):
        req = Request(self.base + path, headers={"X-IDENTITY-HEADER": secret} if secret else {})
        return json.load(urlopen(req))

    def test_two_employees_get_different_config_dirs_and_tokens(self):
        self.assertEqual(self.get("/token?resource=r", "key-a")["access_token"], "tok-alice")
        self.assertEqual(self.get("/token?resource=r", "key-b")["access_token"], "tok-bob")
        self.assertEqual(self.dirs, [("alice", "/azure/alice"), ("bob", "/azure/bob")])

    def test_wrong_secret_is_401(self):
        with self.assertRaises(HTTPError) as c:
            self.get("/token?resource=r", "nope")
        self.assertEqual(c.exception.code, 401)

    def test_health_reports_each_employee(self):
        h = self.get("/health")
        self.assertEqual(set(h["employees"]), {"alice", "bob"})
        self.assertTrue(h["logged_in"])

    def test_single_secret_is_employee_default_with_the_volume_root(self):
        self.assertEqual(broker.config_dir("default"), "/azure")


if __name__ == "__main__":
    unittest.main()

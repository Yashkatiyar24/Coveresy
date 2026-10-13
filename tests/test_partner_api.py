"""Self-check: python tests/test_partner_api.py (or pytest).

Runs a stub sink in-process so the forward path is exercised for real.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

received: list[dict] = []
seen_pans: set[str] = set()


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != "Bearer test-secret":
            return self.reply(401, {"error": "Unauthorized"})
        if not self.headers.get("Origin"):  # the Worker's CSRF guard needs one
            return self.reply(403, {"error": "Cross-origin request refused"})
        if "urllib" in (self.headers.get("User-Agent") or ""):  # Cloudflare 1010
            return self.reply(403, {"error": "banned client signature"})
        if not body:
            return self.reply(400, {"error": "Missing field"})
        if body["pan"] in seen_pans:
            return self.reply(409, {"error": "Already applied"})
        seen_pans.add(body["pan"])
        received.append(body)
        self.reply(201, {"id": "pa_test", "status": "new"})

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


server = HTTPServer(("127.0.0.1", 0), Sink)
threading.Thread(target=server.serve_forever, daemon=True).start()

os.environ["PARTNER_SINK_URL"] = f"http://127.0.0.1:{server.server_port}/internal/partner-applications"
os.environ["PARTNER_SINK_SECRET"] = "test-secret"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))

from fastapi.testclient import TestClient  # noqa: E402

import index  # noqa: E402

GOOD = {
    "full_name": "Asha Rao",
    "email": "asha@example.com",
    "mobile": "9876543210",
    "gender": "Female",
    "pincode": "560001",
    "pan": "abcde1234f",
    "referral": None,
}


def test_apply_forwards_to_sink():
    with TestClient(index.app) as c:
        assert c.post("/api/partners/apply", json=GOOD).status_code == 201
        assert received[-1]["pan"] == "ABCDE1234F"  # normalised before storage
        assert c.post("/api/partners/apply", json=GOOD).status_code == 409

        for bad in ({"mobile": "12345"}, {"mobile": "1234567890"}, {"pan": "BADPAN"},
                    {"pincode": "0123456"}, {"email": "nope"}, {"gender": "x"}):
            assert c.post("/api/partners/apply", json=GOOD | bad).status_code == 422, bad
        assert len(received) == 1  # nothing invalid ever reached the sink


def test_health_reports_sink_state():
    with TestClient(index.app) as c:
        assert c.get("/api/partners/health").json()["sink"] == "reachable, credentials accepted"


def test_unconfigured_sink_is_not_silent():
    index.SINK_URL = ""
    with TestClient(index.app) as c:
        assert c.post("/api/partners/apply", json=GOOD | {"pan": "ZZZZZ1111Z"}).status_code == 503




# --- partner portal sessions -------------------------------------------------

def test_session_round_trip_and_tampering():
    index.SESSION_SECRET = "unit-test-secret"
    token = index.sign_session({"id": "pac_1", "name": "A", "exp": time.time() + 60})
    assert index.read_session(token)["id"] == "pac_1"

    # a flipped payload byte must not verify
    raw, _, sig = token.partition(".")
    forged = ("x" + raw[1:]) + "." + sig
    assert index.read_session(forged) is None
    assert index.read_session(None) is None
    assert index.read_session("garbage") is None

    expired = index.sign_session({"id": "pac_1", "exp": time.time() - 1})
    assert index.read_session(expired) is None

    # a token signed with a different secret must not verify
    index.SESSION_SECRET = "another-secret"
    assert index.read_session(token) is None


def test_portal_endpoints_require_a_session():
    index.SESSION_SECRET = "unit-test-secret"
    with TestClient(index.app) as c:
        for method, path in (("get", "/api/partner/me"), ("get", "/api/partner/quotes"),
                             ("get", "/api/partner/agents")):
            assert getattr(c, method)(path).status_code == 401, path
        assert c.post("/api/partner/quotes", json={"product": "life"}).status_code == 401


if __name__ == "__main__":
    test_apply_forwards_to_sink()
    test_health_reports_sink_state()
    test_unconfigured_sink_is_not_silent()
    test_session_round_trip_and_tampering()
    test_portal_endpoints_require_a_session()
    print("ok")

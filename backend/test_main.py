"""Self-check: python test_main.py (or pytest)."""
import os
import tempfile

os.environ["PARTNER_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["ADMIN_API_KEY"] = "secret"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

GOOD = {
    "full_name": "Asha Rao",
    "email": "asha@example.com",
    "mobile": "9876543210",
    "gender": "Female",
    "pincode": "560001",
    "pan": "abcde1234f",
    "referral": None,
}


def test_apply_and_list():
    with TestClient(main.app) as c:
        assert c.post("/api/partners/apply", json=GOOD).status_code == 201
        # duplicate mobile/PAN rejected, not silently stored twice
        assert c.post("/api/partners/apply", json=GOOD).status_code == 409
        for bad in ({"mobile": "12345"}, {"pan": "BADPAN"}, {"pincode": "0123456"},
                    {"email": "nope"}, {"gender": "x"}):
            assert c.post("/api/partners/apply", json=GOOD | bad).status_code == 422, bad
        assert c.get("/api/partners").status_code == 401
        rows = c.get("/api/partners", headers={"X-API-Key": "secret"}).json()
        assert len(rows) == 1 and rows[0]["pan"] == "ABCDE1234F" and rows[0]["status"] == "new"


if __name__ == "__main__":
    test_apply_and_list()
    print("ok")

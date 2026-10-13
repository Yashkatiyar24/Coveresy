"""Coveresy partner onboarding API (Vercel Python function).

Validation lives here; storage does not. Clean records are forwarded to the
admin portal Worker, which writes them to D1 — the same database staff already
work in. Vercel's filesystem is ephemeral, so nothing may be persisted locally.
"""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator

SINK_URL = os.getenv("PARTNER_SINK_URL", "")
SINK_SECRET = os.getenv("PARTNER_SINK_SECRET", "")
# Base for the Worker's named data operations, e.g. ".../internal".
WORKER_BASE = os.getenv("PARTNER_WORKER_URL") or (SINK_URL.rsplit("/", 1)[0] if SINK_URL else "")
SESSION_SECRET = os.getenv("PARTNER_PORTAL_SECRET", "")
SESSION_HOURS = 12
COOKIE = "coveresy_partner"
ORIGINS = os.getenv(
    "CORS_ORIGINS", "https://www.coveresy.com,https://coveresy.com,http://localhost:8080"
).split(",")


class Application(BaseModel):
    full_name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    mobile: str = Field(pattern=r"^[6-9]\d{9}$")
    gender: Literal["Male", "Female", "Other"]
    pincode: str = Field(pattern=r"^[1-9]\d{5}$")
    pan: str = Field(pattern=r"^[A-Za-z]{5}\d{4}[A-Za-z]$")
    referral: str | None = Field(default=None, max_length=40)

    @field_validator("pan")
    @classmethod
    def upper_pan(cls, v: str) -> str:
        return v.upper()


app = FastAPI(title="Coveresy Partner API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ORIGINS if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def call_worker(method: str, path: str, payload: dict | None = None,
                params: dict | None = None) -> tuple[int, Any]:
    """Call a named Worker operation. Returns (status, parsed body)."""
    if not WORKER_BASE or not SINK_SECRET:
        raise HTTPException(503, "Portal backend is not configured.")
    url = f"{WORKER_BASE}/{path.lstrip('/')}"
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v})
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SINK_SECRET}",
            "User-Agent": "coveresy-partner-api/1.0 (+https://www.coveresy.com)",
            "Origin": f"{urlsplit(url).scheme}://{urlsplit(url).netloc}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            body = res.read()
            return res.status, json.loads(body or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body or b"{}")
        except ValueError:
            return e.code, {"error": body[:200].decode(errors="replace")}
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"worker unreachable: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(502, "The portal backend is unavailable. Please try again.")


def post_to_sink(payload: dict) -> tuple[int, bytes]:
    """POST to the Worker and return its raw (status, body). Never raises for
    an HTTP status — callers decide what each one means."""
    req = urllib.request.Request(
        SINK_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SINK_SECRET}",
            # Cloudflare answers urllib's default agent with error 1010 (banned
            # client signature), so the service names itself instead.
            "User-Agent": "coveresy-partner-api/1.0 (+https://www.coveresy.com)",
            # The Worker refuses cross-origin POSTs (CSRF guard). This call is
            # server-to-server and bearer-authenticated, so it presents the
            # sink's own origin rather than the guard being relaxed for it.
            "Origin": f"{urlsplit(SINK_URL).scheme}://{urlsplit(SINK_URL).netloc}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@app.post("/api/partners/apply", status_code=201)
def apply(a: Application) -> dict:
    if not SINK_URL or not SINK_SECRET:
        raise HTTPException(503, "Applications are temporarily unavailable.")
    try:
        status, body = post_to_sink(a.model_dump())
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"sink unreachable: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(502, "Could not record your application. Please try again.")
    if status == 201:
        return json.loads(body or b"{}")
    if status == 409:
        raise HTTPException(409, "An application with this mobile number or PAN already exists.")
    # The applicant sees a generic message; the cause goes to the logs.
    print(f"sink rejected: HTTP {status} {body[:200]!r}", flush=True)
    raise HTTPException(502, "Could not record your application. Please try again.")


@app.get("/api/partners/health")
def health() -> dict:
    """Reports whether the sink is reachable and accepts our credentials.

    An empty body is a valid probe: the sink authenticates first, so 400 means
    the secret was accepted while 401 means it was not. No secret is echoed.
    """
    out = {"ok": True, "sink_configured": bool(SINK_URL and SINK_SECRET)}
    if not out["sink_configured"]:
        return out
    try:
        status, _ = post_to_sink({})
    except (urllib.error.URLError, TimeoutError) as e:
        out["sink"] = f"unreachable: {type(e).__name__}"
        return out
    # 400 is the healthy answer: the secret was accepted, the empty probe body
    # was not. 401 means the two sides disagree about the shared secret.
    out["sink"] = {400: "reachable, credentials accepted",
                   401: "credentials rejected"}.get(status, f"unexpected status {status}")
    return out


# ---------------------------------------------------------------- partner portal


def sign_session(data: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=")
    sig = hmac.new(SESSION_SECRET.encode(), raw, hashlib.sha256).digest()
    return f"{raw.decode()}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def read_session(token: str | None) -> dict | None:
    """Verify signature and expiry. Returns None for anything untrustworthy."""
    if not token or not SESSION_SECRET or "." not in token:
        return None
    raw, _, given = token.partition(".")
    pad = lambda v: v + "=" * (-len(v) % 4)  # noqa: E731
    expected = hmac.new(SESSION_SECRET.encode(), raw.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(base64.urlsafe_b64decode(pad(given)), expected):
            return None
        data = json.loads(base64.urlsafe_b64decode(pad(raw)))
    except (ValueError, json.JSONDecodeError):
        return None
    return None if data.get("exp", 0) < time.time() else data


def current_partner(request: Request) -> dict:
    session = read_session(request.cookies.get(COOKIE))
    if not session:
        raise HTTPException(401, "Please sign in again.")
    return session


class Login(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class QuoteRequest(BaseModel):
    product: Literal["car", "bike", "health", "life"]
    customer_name: str | None = Field(default=None, max_length=100)
    customer_phone: str | None = Field(default=None, pattern=r"^[6-9]\d{9}$")
    details: dict[str, Any] = Field(default_factory=dict)


class NewAgent(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    mobile: str = Field(pattern=r"^[6-9]\d{9}$")
    password: str = Field(min_length=8, max_length=200)


@app.post("/api/partner/login")
def partner_login(body: Login, response: Response) -> dict:
    if not SESSION_SECRET:
        raise HTTPException(503, "Portal sign-in is not configured.")
    status, data = call_worker("POST", "partner/login",
                               {"email": body.email, "password": body.password})
    if status != 200:
        raise HTTPException(status if status in (401, 403) else 502,
                            data.get("error", "Could not sign in."))
    a = data["account"]
    response.set_cookie(
        COOKIE,
        sign_session({"id": a["id"], "name": a["name"], "agent_code": a["agent_code"],
                      "exp": int(time.time()) + SESSION_HOURS * 3600}),
        max_age=SESSION_HOURS * 3600, httponly=True, secure=True, samesite="lax", path="/",
    )
    return {"account": a}


@app.post("/api/partner/logout")
def partner_logout(response: Response) -> dict:
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/partner/me")
def partner_me(partner: dict = Depends(current_partner)) -> dict:
    return {"id": partner["id"], "name": partner["name"], "agent_code": partner["agent_code"]}


@app.post("/api/partner/quotes", status_code=201)
def create_quote(body: QuoteRequest, partner: dict = Depends(current_partner)) -> dict:
    status, data = call_worker("POST", "partner/quote-requests",
                               body.model_dump() | {"partner_id": partner["id"]})
    if status != 201:
        raise HTTPException(400 if status == 400 else 502, data.get("error", "Could not save the request."))
    return data


@app.get("/api/partner/quotes")
def list_quotes(partner: dict = Depends(current_partner), product: str | None = None,
                stage: str | None = None, date_from: str | None = None,
                date_to: str | None = None) -> dict:
    status, data = call_worker("GET", "partner/quote-requests", params={
        "partner_id": partner["id"], "product": product, "stage": stage,
        "from": date_from, "to": date_to,
    })
    if status != 200:
        raise HTTPException(502, data.get("error", "Could not load quotes."))
    return data


@app.get("/api/partner/agents")
def list_agents(partner: dict = Depends(current_partner)) -> dict:
    status, data = call_worker("GET", "partner/accounts", params={"parent_id": partner["id"]})
    if status != 200:
        raise HTTPException(502, data.get("error", "Could not load agents."))
    return data


@app.post("/api/partner/agents", status_code=201)
def create_agent(body: NewAgent, partner: dict = Depends(current_partner)) -> dict:
    status, data = call_worker("POST", "partner/accounts",
                               body.model_dump() | {"parent_id": partner["id"]})
    if status == 409:
        raise HTTPException(409, data.get("error", "Already in use"))
    if status != 201:
        raise HTTPException(502, data.get("error", "Could not create the agent."))
    return data

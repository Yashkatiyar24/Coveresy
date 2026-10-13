"""Coveresy partner onboarding API (Vercel Python function).

Validation lives here; storage does not. Clean records are forwarded to the
admin portal Worker, which writes them to D1 — the same database staff already
work in. Vercel's filesystem is ephemeral, so nothing may be persisted locally.
"""
import json
import os
import urllib.error
import urllib.request
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator

SINK_URL = os.getenv("PARTNER_SINK_URL", "")
SINK_SECRET = os.getenv("PARTNER_SINK_SECRET", "")
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


def send_to_sink(payload: dict) -> dict:
    """POST the record to the Worker. Raises HTTPException on any failure."""
    if not SINK_URL or not SINK_SECRET:
        raise HTTPException(503, "Applications are temporarily unavailable.")
    req = urllib.request.Request(
        SINK_URL,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SINK_SECRET}",
            # The Worker refuses cross-origin POSTs (CSRF guard). This call is
            # server-to-server and bearer-authenticated, so it presents the
            # sink's own origin rather than the guard being relaxed for it.
            "Origin": f"{urlsplit(SINK_URL).scheme}://{urlsplit(SINK_URL).netloc}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code == 409:
            raise HTTPException(409, "An application with this mobile number or PAN already exists.")
        raise HTTPException(502, "Could not record your application. Please try again.")
    except (urllib.error.URLError, TimeoutError):
        raise HTTPException(502, "Could not record your application. Please try again.")


@app.post("/api/partners/apply", status_code=201)
def apply(a: Application) -> dict:
    return send_to_sink(a.model_dump())


@app.get("/api/partners/health")
def health() -> dict:
    return {"ok": True, "sink_configured": bool(SINK_URL and SINK_SECRET)}

"""Coveresy partner onboarding API."""
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, field_validator

DB_PATH = os.getenv("PARTNER_DB", "partners.db")
ORIGINS = os.getenv(
    "CORS_ORIGINS", "https://www.coveresy.com,https://coveresy.com,http://localhost:8000"
).split(",")

SCHEMA = """
CREATE TABLE IF NOT EXISTS partner_applications (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  mobile TEXT NOT NULL UNIQUE,
  gender TEXT NOT NULL,
  pincode TEXT NOT NULL,
  pan TEXT NOT NULL UNIQUE,
  referral TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
)
"""


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


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


with db() as _conn:
    _conn.execute(SCHEMA)

app = FastAPI(title="Coveresy Partner API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in ORIGINS if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)


def staff(x_api_key: Annotated[str | None, Header()] = None) -> None:
    key = os.getenv("ADMIN_API_KEY")
    if not key:
        raise HTTPException(503, "Staff access not configured")
    if x_api_key != key:
        raise HTTPException(401, "Invalid API key")


@app.post("/api/partners/apply", status_code=201)
def apply(a: Application) -> dict:
    row = a.model_dump() | {
        "id": uuid.uuid4().hex,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        with db() as conn:
            conn.execute(
                "INSERT INTO partner_applications"
                " (id, full_name, email, mobile, gender, pincode, pan, referral, created_at)"
                " VALUES (:id, :full_name, :email, :mobile, :gender, :pincode, :pan, :referral, :created_at)",
                row,
            )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "An application with this mobile number or PAN already exists.")
    return {"id": row["id"], "status": "new"}


@app.get("/api/partners", dependencies=[Depends(staff)])
def applications(status: str | None = None, limit: int = 100) -> list[dict]:
    sql = "SELECT * FROM partner_applications"
    binds: list = []
    if status:
        sql += " WHERE status = ?"
        binds.append(status)
    sql += " ORDER BY created_at DESC LIMIT ?"
    binds.append(min(limit, 500))
    with db() as conn:
        return [dict(r) for r in conn.execute(sql, binds)]

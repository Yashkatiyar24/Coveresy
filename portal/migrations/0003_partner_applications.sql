-- Applications from the public "Become a Partner" form (www.coveresy.com/partner).
-- The public API validates and forwards them here; D1 is the system of record.

CREATE TABLE partner_applications (
  id         TEXT PRIMARY KEY,
  full_name  TEXT NOT NULL,
  email      TEXT NOT NULL,
  mobile     TEXT NOT NULL UNIQUE,
  gender     TEXT NOT NULL,
  pincode    TEXT NOT NULL,
  pan        TEXT NOT NULL UNIQUE,
  referral   TEXT,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_partner_apps_status ON partner_applications(status, created_at);

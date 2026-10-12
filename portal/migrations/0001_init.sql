-- Coveresy Ops Portal :: initial schema
-- Money is stored as INTEGER paise. Percentages are stored as INTEGER basis
-- points (bp): 250 bp = 2.50%. Never floating point for money.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- id is the HMAC of the opaque session token; the raw token never lands here.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email    TEXT NOT NULL,
  ip       TEXT NOT NULL,
  ok       INTEGER NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts ON login_attempts(email, ip, at);

CREATE TABLE insurers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE brokers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE partners (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  partner_code TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE employees (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  id         TEXT PRIMARY KEY,
  insurer_id TEXT NOT NULL REFERENCES insurers(id),
  category   TEXT NOT NULL CHECK (category IN ('health','life')),
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (insurer_id, name)
);
CREATE INDEX idx_products_insurer ON products(insurer_id);

CREATE TABLE applications (
  id                 TEXT PRIMARY KEY,
  category           TEXT NOT NULL CHECK (category IN ('health','life')),
  product_id         TEXT REFERENCES products(id),
  product_name       TEXT,
  login_date         TEXT,
  application_no     TEXT NOT NULL,
  policy_no          TEXT,
  customer_name      TEXT NOT NULL,
  premium_paise      INTEGER NOT NULL DEFAULT 0 CHECK (premium_paise >= 0),
  status             TEXT NOT NULL DEFAULT 'draft',
  issued_date        TEXT,
  policy_term        TEXT,
  premium_frequency  TEXT,
  insurer_id         TEXT NOT NULL REFERENCES insurers(id),
  insurer_rep_name   TEXT,
  broker_id          TEXT REFERENCES brokers(id),
  partner_id         TEXT REFERENCES partners(id),
  employee_id        TEXT REFERENCES employees(id),
  assigned_user_id   TEXT REFERENCES users(id),
  doc_overall_status TEXT NOT NULL DEFAULT 'incomplete',
  cancel_reason      TEXT,
  created_by         TEXT NOT NULL REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (insurer_id, application_no)
);
CREATE UNIQUE INDEX idx_app_policy_no ON applications(insurer_id, policy_no)
  WHERE policy_no IS NOT NULL AND policy_no <> '';
CREATE INDEX idx_app_status ON applications(status);
CREATE INDEX idx_app_category ON applications(category);
CREATE INDEX idx_app_partner ON applications(partner_id);
CREATE INDEX idx_app_employee ON applications(employee_id);
CREATE INDEX idx_app_login_date ON applications(login_date);
CREATE INDEX idx_app_owner ON applications(created_by, assigned_user_id);

-- Section 3 default seed lives in seed.sql; Admin may edit these rows.
CREATE TABLE document_rules (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL CHECK (category IN ('health','life')),
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('policy_copy','proposal_form','payment_receipt')),
  requirement TEXT NOT NULL CHECK (requirement IN ('mandatory','optional')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (category, doc_type)
);

CREATE TABLE application_documents (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('policy_copy','proposal_form','payment_receipt')),
  status         TEXT NOT NULL CHECK (status IN ('uploaded','pending_verification','verified','rejected','removed')),
  storage_key    TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  is_current     INTEGER NOT NULL DEFAULT 1,
  uploaded_by    TEXT NOT NULL REFERENCES users(id),
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  verified_by    TEXT REFERENCES users(id),
  verified_at    TEXT,
  notes          TEXT
);
CREATE UNIQUE INDEX idx_doc_current ON application_documents(application_id, doc_type)
  WHERE is_current = 1;
CREATE INDEX idx_doc_app ON application_documents(application_id);

CREATE TABLE document_events (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES application_documents(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('upload','replace','remove','verify','reject')),
  actor       TEXT NOT NULL REFERENCES users(id),
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX idx_docev_doc ON document_events(document_id);

CREATE TABLE status_history (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  actor          TEXT REFERENCES users(id),
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  remark         TEXT
);
CREATE INDEX idx_statushist_app ON status_history(application_id);

CREATE TABLE payout_rules (
  id             TEXT PRIMARY KEY,
  insurer_id     TEXT REFERENCES insurers(id),
  product_id     TEXT REFERENCES products(id),
  partner_id     TEXT REFERENCES partners(id),
  base_type      TEXT NOT NULL DEFAULT 'premium' CHECK (base_type IN ('premium','net_premium')),
  payout_bp      INTEGER NOT NULL CHECK (payout_bp >= 0),
  tds_bp         INTEGER NOT NULL CHECK (tds_bp >= 0),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payout_rules_lookup ON payout_rules(insurer_id, product_id, partner_id, effective_from);

CREATE TABLE payouts (
  id               TEXT PRIMARY KEY,
  application_id   TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  base_paise       INTEGER NOT NULL DEFAULT 0,
  payout_bp        INTEGER NOT NULL DEFAULT 0,
  gross_paise      INTEGER NOT NULL DEFAULT 0,
  tds_bp           INTEGER NOT NULL DEFAULT 0,
  tds_paise        INTEGER NOT NULL DEFAULT 0,
  deductions_paise INTEGER NOT NULL DEFAULT 0,
  net_paise        INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'not_initiated',
  paid_date        TEXT,
  utr              TEXT,
  rule_snapshot    TEXT,
  remarks          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- UTR unique only when present: blocks the same transfer being recorded twice.
CREATE UNIQUE INDEX idx_payout_utr ON payouts(utr) WHERE utr IS NOT NULL AND utr <> '';
CREATE INDEX idx_payout_status ON payouts(status);

CREATE TABLE payout_events (
  id          TEXT PRIMARY KEY,
  payout_id   TEXT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor       TEXT REFERENCES users(id),
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  before_json TEXT,
  after_json  TEXT
);
CREATE INDEX idx_payoutev ON payout_events(payout_id);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  actor       TEXT,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_at ON audit_logs(at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  file_name   TEXT NOT NULL,
  uploader    TEXT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'preview',
  rows_total  INTEGER NOT NULL DEFAULT 0,
  rows_ok     INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  payload     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE import_errors (
  id         TEXT PRIMARY KEY,
  import_id  TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL,
  field      TEXT,
  message    TEXT NOT NULL
);
CREATE INDEX idx_import_errors ON import_errors(import_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

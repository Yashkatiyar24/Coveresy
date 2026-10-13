-- Partner portal: agent logins and the quote requests they raise.
-- Premiums are INTEGER paise, never floating point, as elsewhere in this schema.

CREATE TABLE partner_accounts (
  id             TEXT PRIMARY KEY,
  application_id TEXT REFERENCES partner_applications(id),
  -- Agents created by another agent; NULL for a principal partner.
  parent_id      TEXT REFERENCES partner_accounts(id),
  agent_code     TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  mobile         TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  agent_type     TEXT NOT NULL DEFAULT 'coveresy',
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','disabled')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_partner_accounts_parent ON partner_accounts(parent_id, status);

CREATE TABLE quote_requests (
  id             TEXT PRIMARY KEY,
  partner_id     TEXT NOT NULL REFERENCES partner_accounts(id),
  product        TEXT NOT NULL CHECK (product IN ('car','bike','health','life')),
  stage          TEXT NOT NULL DEFAULT 'quote_created'
                 CHECK (stage IN ('quote_created','proposal_created','payment_pending',
                                  'pending_inspection','payment_done')),
  customer_name  TEXT,
  customer_phone TEXT,
  -- Product-specific answers (registration number, cover type, sum assured …).
  details        TEXT NOT NULL DEFAULT '{}',
  net_premium    INTEGER,
  total_premium  INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quote_requests_partner ON quote_requests(partner_id, product, stage, created_at);

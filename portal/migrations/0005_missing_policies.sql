-- Partners report policies that were issued but never showed up in the portal.
-- Staff work the queue: pending -> in_review -> identified | rejected.

CREATE TABLE missing_policy_requests (
  id            TEXT PRIMARY KEY,
  partner_id    TEXT NOT NULL REFERENCES partner_accounts(id),
  policy_number TEXT NOT NULL,
  issue_month   TEXT NOT NULL,                 -- 'YYYY-MM'
  product       TEXT NOT NULL CHECK (product IN ('car','bike','health','life')),
  comment       TEXT,
  start_date    TEXT,
  document_key  TEXT,                          -- R2 object key; NULL when no file was attached
  document_name TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_review','identified','rejected')),
  staff_note    TEXT,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_missing_partner ON missing_policy_requests(partner_id, status, created_at);
CREATE INDEX idx_missing_status ON missing_policy_requests(status, created_at);

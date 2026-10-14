-- Staff review of partner applications: who looked at it, when, and why they
-- decided what they did.
ALTER TABLE partner_applications ADD COLUMN staff_note TEXT;
ALTER TABLE partner_applications ADD COLUMN reviewed_at TEXT;
ALTER TABLE partner_applications ADD COLUMN reviewed_by TEXT REFERENCES users(id);

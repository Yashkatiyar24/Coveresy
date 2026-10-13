-- Staff need to know which partner logins exist, where each came from, and
-- whether anyone has actually signed in with it.

ALTER TABLE partner_accounts ADD COLUMN created_via TEXT NOT NULL DEFAULT 'staff';
-- Free text: the staff member or parent partner who issued the login.
ALTER TABLE partner_accounts ADD COLUMN created_note TEXT;
ALTER TABLE partner_accounts ADD COLUMN last_login_at TEXT;
ALTER TABLE partner_accounts ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;

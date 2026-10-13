-- Accounts created before 0006 defaulted to 'staff'. Any with a parent was in
-- fact added by that partner through "My agents".
UPDATE partner_accounts SET created_via = 'partner' WHERE parent_id IS NOT NULL;

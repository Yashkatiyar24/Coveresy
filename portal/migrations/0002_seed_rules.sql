-- Section 3 default Document Rules + section 18 configurable defaults.
-- Admin may edit any of these at runtime; nothing here is hardcoded in app code.

INSERT INTO document_rules (id, category, doc_type, requirement) VALUES
  ('dr_health_policy',   'health', 'policy_copy',     'mandatory'),
  ('dr_health_proposal', 'health', 'proposal_form',   'mandatory'),
  ('dr_health_receipt',  'health', 'payment_receipt', 'mandatory'),
  ('dr_life_policy',     'life',   'policy_copy',     'optional'),
  ('dr_life_proposal',   'life',   'proposal_form',   'mandatory'),
  ('dr_life_receipt',    'life',   'payment_receipt', 'mandatory');

INSERT INTO settings (key, value) VALUES
  -- Decision 8: 10 MB per file, configurable.
  ('max_file_bytes',        '10485760'),
  -- Decision 2: TDS default is PENDING ANWAR'S APPROVAL. Stored, not hardcoded.
  ('default_tds_bp',        '500'),
  -- Decision 1: payout base.
  ('default_payout_base',   'premium'),
  ('default_payout_bp',     '0'),
  -- Decision 6: Admin verifies by default; flip to 1 to let Operators verify.
  ('operators_may_verify',  '0'),
  -- Decision 9: Operators see only records assigned to or created by them.
  ('operator_sees_all',     '0'),
  ('session_hours',         '12');

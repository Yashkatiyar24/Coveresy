-- Expected after the purge: zeros everywhere except users=1 (admin),
-- doc_rules=6, settings=7, partner_accounts=1.
SELECT (SELECT COUNT(*) FROM applications)     applications,
       (SELECT COUNT(*) FROM payouts)          payouts,
       (SELECT COUNT(*) FROM status_history)   history,
       (SELECT COUNT(*) FROM insurers)         insurers,
       (SELECT COUNT(*) FROM partners)         partners,
       (SELECT COUNT(*) FROM payout_rules)     payout_rules,
       (SELECT COUNT(*) FROM audit_logs)       audit_logs,
       (SELECT COUNT(*) FROM users)            users,
       (SELECT COUNT(*) FROM document_rules)   doc_rules,
       (SELECT COUNT(*) FROM settings)         settings,
       (SELECT COUNT(*) FROM partner_accounts) partner_accounts;

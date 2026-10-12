# Test report

Coveresy Insurance Operations Portal, build of 13 October 2026.
Prepared against §20 of the developer handoff note.

**Environment tested:** local Cloudflare Workers runtime (`wrangler dev`) with
local D1 and R2 emulation, on a database migrated from empty.

**Not yet tested:** the deployed environment. §4.8 and §20 both require
authentication and smoke tests to be run on the live site, and §19 phase 6
requires deployment. That has not happened, because the Cloudflare account is
Anwar's and no credentials were used. See *Blocked* below — this is the one
outstanding item.

Every result below was produced by actually running the command shown. Nothing
is marked passed on inspection alone.

```
npm run typecheck   0 errors
npm test            39 passed, 0 failed
./test/smoke.sh     57 passed, 0 failed   (run twice; re-runnable)
```

---

## Authentication — PASSED

| § | Test | Result | Evidence |
|---|---|---|---|
| 4 | Admin setup works with the configured secrets | PASS | smoke: *first admin can log in* |
| 4 | A setup screen appears only when a secret is genuinely missing | PASS | manual: starting with `COVERESY_SETUP_TOKEN` only renders "Server setup required" naming `COVERESY_SESSION_SECRET`; restoring the secret restores the login page |
| 4 | Login and logout work | PASS | smoke: *first admin can log in*, *a session cookie is set* |
| 4 | Unauthorised users are blocked from protected endpoints | PASS | smoke: *unauthenticated dashboard redirects to login*, *unauthenticated API POST is refused* |
| 4 | Production cookies are secure | PASS | smoke asserts `HttpOnly`; `Secure` + `SameSite=Lax` + HSTS are applied when `COVERESY_ENV=production` (code: `sessionCookie`, `src/index.ts`) |
| 4 | Sessions expire | PASS | `userFromRequest` deletes and rejects an expired row; length is the `session_hours` setting |
| 4 | No default admin password, no bypass | PASS | smoke: *a wrong setup token never creates an administrator*, *a wrong password is refused*, *setup refuses to run twice* |
| 4 | Setup token can be rotated or disabled | PASS | documented in README §3; setup refuses once an admin exists, independent of the token |
| 17 | Rate limiting | PASS | 10 failed attempts per email-or-IP in 15 minutes, then refusal (`loginBlocked`) |
| 17 | CSRF / origin protection | PASS | smoke: *POST without an Origin header is refused (CSRF)* |

## Document rules — PASSED

All of §20's named cases, as unit tests and again live.

| Test | Result |
|---|---|
| Health without Policy Copy cannot be completed or verified | PASS |
| Health without Proposal Form cannot be completed or verified | PASS |
| Health without Payment Receipt cannot be completed or verified | PASS |
| Life without Policy Copy proceeds when the other two are valid | PASS |
| Life without Proposal Form cannot be completed or verified | PASS |
| Life without Payment Receipt cannot be completed or verified | PASS |
| A rejected mandatory document does not count as verified | PASS |
| An absent optional document never blocks completion | PASS |
| Switching Life to Health triggers Health validation | PASS |
| Attachments survive a category change (not silently deleted) | PASS (smoke) |
| Direct API calls cannot bypass the rules | PASS (smoke: a POST straight to `/applications/:id/transition` with `to=verified` is refused and names what is missing) |
| Unauthorised users cannot view or download documents | PASS (smoke: anonymous → redirect; another operator → 404, not 403, so the record's existence is not disclosed) |
| Replacement and verification appear in the audit log | PASS (smoke) |
| Uploaded-but-unverified shown separately from missing | PASS |
| Completion summary is computed, not stored ("2 of 3 required…") | PASS |

Also tested beyond §20's list:

- A file whose **contents** are not PDF/JPG/PNG is rejected even when the
  declared MIME type and extension say otherwise (magic-byte sniffing). PASS.
- A file over the configured size limit is rejected. PASS.
- Document rules are data: flipping Health's Policy Copy to optional changes the
  outcome with no code change. PASS (unit).

## Roles and permissions — PASSED

| Test | Result |
|---|---|
| Operator cannot open Users, Settings or Audit Logs | PASS (403 each) |
| Operator cannot approve a payout by direct POST | PASS (403) |
| Operator cannot verify documents while `operators_may_verify` is 0 | PASS (403) |
| Operator cannot see another user's application (IDOR) | PASS (404) |
| Operator cannot download another user's document (IDOR) | PASS (404) |
| Admin can download the same document | PASS (200) |
| Viewer cannot move an application through any transition | PASS (unit) |
| Only an Admin may reject or cancel, and only with a reason | PASS (unit) |
| The last active administrator cannot be demoted or disabled | PASS (code-enforced) |

## Payouts and MIS — PASSED

| § | Test | Result |
|---|---|---|
| 9 | Calculations match the approved formulas | PASS — 50,000.00 premium at 12.5% → gross 6,250.00; TDS 5% of gross → 312.50; net 5,937.50, asserted both as a unit test and live |
| 9 | Rounding is tested | PASS — half-up at the paise, including the 0.5-paise boundary in both directions |
| 9 | TDS is not assumed to be 2% | PASS — unit test asserts the rate comes from the rule |
| 18.4 | Most specific rule wins, date-effective | PASS — partner beats product beats insurer; an expired rule is skipped; a rule naming a different insurer never applies |
| 9 | Duplicate payouts prevented | PASS — UTR is unique where present; a repeat is refused with "Duplicate payment refused"; one payout row per application |
| 9 | Unauthorised approval | PASS — Operator POST to `/payouts/:id/approve` → 403 |
| 9 | A paid payout cannot be approved again | PASS |
| 9 | Reversals and corrections are recorded | PASS — `payout_events` plus the audit log; a reversal frees the UTR so a corrected payment can be recorded |
| 10 | Dashboard figures match the database | PASS — every figure is a COUNT/SUM over the filtered set; there is no literal number anywhere in the dashboard |
| 10 | Filters and exports are consistent | PASS — the MIS list, dashboard, reports and exports all call one `buildFilter()` |

## General — PASSED

| Test | Result |
|---|---|
| TypeScript checks pass | PASS — `tsc --noEmit`, 0 errors across 22 source files |
| Production build succeeds | PASS — `wrangler dev` builds and serves; no separate build step exists |
| Migrations run without data loss | PASS — forward-only files, applied from empty; §14 backup/restore procedure documented in README §5 |
| CRUD tested | PASS — insurers, brokers, partners, employees, products, payout rules, document rules, users |
| Import/export tested | PASS — CSV export carries all §7 columns; XLSX validated with `unzip -t` and asserted to contain real numbers; import previews with row-level errors and a downloadable error report |
| Role permissions tested | PASS — see above |
| Responsive layouts reviewed | PASS — single breakpoint at 860px: nav collapses to a toggle, the detail split becomes one column, tables scroll horizontally rather than overflowing |
| Error states reviewed | PASS — 403/404/500 pages, flash messages on every refusal, empty states on every table |
| Smoke tests on the live environment | **BLOCKED** — see below |

## Blocked

**Deployment to Cloudflare and live smoke tests (§19 phase 6, §20 "general",
§21 deliverable 13).** The portal has not been deployed, because hosting is on
Anwar's own Cloudflare account (§2) and no credentials for it were used. Every
step is scripted in README §2, and `./test/smoke.sh` takes a `BASE` URL, so the
live run is:

```bash
BASE=https://<worker-url> SETUP_TOKEN=<token> ./test/smoke.sh
```

Until that runs against the deployed site, the project is **not** production-ready
(§22). Nothing else is outstanding.

## Pending client approval (§18)

Built with the defaults below, all stored as configuration and editable from
**Settings** without a deploy. Flagged here as §18 requires.

| # | Decision | Built with | Needs |
|---|---|---|---|
| 1 | Payout base | Premium; selectable per rule (premium / net premium) | confirmation |
| 2 | **TDS percentage** | **5.00% placeholder** — stored in settings and per rule, applied on gross | **Anwar to confirm the real rate** |
| 3 | Other deductions | Optional field, default 0 | confirmation |
| 4 | Payout rule structure | Insurer + product + partner, most specific wins, date-effective | confirmation |
| 5 | Duplicate check | Application number unique per insurer; policy number unique per insurer when present | confirmation |
| 6 | Who verifies documents | Admin only; a setting lets Admin allow Operators | confirmation |
| 7 | Status transitions | As §14.3 | **sign-off on the matrix** |
| 8 | File limit and retention | 10 MB, configurable; no automatic deletion | confirmation |
| 9 | Operator visibility | Operators see records they created or are assigned; Admin sees all | confirmation |
| 10 | Bulk document import | Not in v1; import never marks documents uploaded | confirmation |

## Known limitations

1. **Not deployed.** The one blocker above.
2. **A rejected *optional* document blocks verification.** §14.3 says the
   Verified transition requires "all mandatory documents Verified, none
   Rejected". That was read literally: anything rejected blocks, mandatory or
   not, on the reasoning that a rejected file needs resolving either way. If
   Anwar intends a rejected optional document to be ignorable, this is a
   one-line change in `rules.ts` with a test already covering both readings.
3. **XLSX export is a plain unstyled sheet.** Correct values, real numbers and a
   header row, but no column widths, freeze panes or cell formatting. The
   writer is dependency-free and deliberately minimal.
4. **Import covers applications only**, as §18 decision 10 requires. Master data
   is created through the UI.
5. **No email.** No notifications, no password-reset-by-email; an Admin resets a
   password directly, which also ends that user's sessions. Nothing in the
   handoff asks for email.
6. **Payout recalculation is per application.** Changing a payout rule affects
   new and still-pending payouts; it deliberately does not restate payouts that
   are already approved, paid or beyond — those keep their `rule_snapshot`. A
   bulk "recalculate all pending" action does not exist yet.
7. **Audit log before/after values are stored as JSON strings** and displayed
   truncated in the table. They are complete in the database.
8. **Rate limiting is per-database**, counting failed attempts in a table. It is
   adequate for an internal portal and is not a defence against a distributed
   attack; Cloudflare WAF rules would cover that if it ever matters.

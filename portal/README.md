# Coveresy Insurance Operations Portal

Internal portal for Health and Life applications, mandatory document management,
Policy MIS, payouts and reporting.

Built against *Coveresy Insurance Operations Portal – Fresh Build Developer Note*,
v1.0, 12 October 2026. Section references below (§) point at that document.

- **Stack:** Cloudflare Workers + D1 + R2, TypeScript, Zod, server-rendered HTML.
  See [STACK.md](STACK.md) for the written alternative §2 asks for.
- **Status:** phases 1–5 complete and tested locally. Phase 6 (deploy to Anwar's
  Cloudflare account) is the remaining step — see [TEST-REPORT.md](TEST-REPORT.md).

---

## 1. Run it locally

```bash
cd portal
npm install

# Secrets. Never commit .dev.vars — .gitignore already excludes it.
cp .dev.vars.example .dev.vars
# then replace both values:
openssl rand -hex 32    # -> COVERESY_SESSION_SECRET
openssl rand -hex 16    # -> COVERESY_SETUP_TOKEN

npm run migrate:local   # creates the schema and seeds the §3 document rules
npm run dev             # http://localhost:8787
```

Open the portal. With no administrator yet it goes straight to **Create the
first administrator**, which requires the setup token. After that, log in
normally.

## 2. Deploy to Cloudflare

The portal is destined for **https://coveresy.com/ops**, on Anwar's Cloudflare
account. That path needs `coveresy.com` moved to Cloudflare DNS first —
**read [DNS-MIGRATION.md](DNS-MIGRATION.md) before touching the domain**, because
company email runs on Microsoft 365 and those records have to survive the move.

Until the domain is across, deploy without the routes (comment out both
`[[env.production.routes]]` blocks and drop `BASE_PATH` from the production
vars) and the Worker is reachable at its `workers.dev` URL. Nothing has to be
redone when the domain lands.

The mount path is configuration, not hardcoding: `BASE_PATH="/ops"` makes the
app emit and accept that prefix everywhere. It runs at the root in development
and under `/ops` in production, and the full smoke suite passes against both.


Run these from `portal/`, signed in to the Coveresy Cloudflare account.

```bash
npx wrangler login

# 1. Create the database and the private bucket.
npx wrangler d1 create coveresy-ops
npx wrangler r2 bucket create coveresy-docs
```

`d1 create` prints a `database_id`. Put it in `wrangler.toml`, replacing
`local-placeholder-replace-after-d1-create`.

```bash
# 2. Secrets. Each prompts for a value; it is stored by Cloudflare, not in git.
openssl rand -hex 32 | npx wrangler secret put COVERESY_SESSION_SECRET
openssl rand -hex 16 | npx wrangler secret put COVERESY_SETUP_TOKEN

# 3. Schema, then deploy.
npx wrangler d1 migrations apply coveresy-ops --remote
npx wrangler deploy
```

Then set `COVERESY_ENV` to `production` in `wrangler.toml` (this is what turns
on `Secure` cookies and HSTS) and deploy again.

### Verify the deployment

```bash
BASE=https://<your-worker-url> SETUP_TOKEN=<the token> ./test/smoke.sh
```

57 live checks; it is safe to re-run against the same environment, because every
record it creates is suffixed with a run id.

## 3. Environment variables

| Name | Where | Purpose |
|---|---|---|
| `COVERESY_SESSION_SECRET` | secret | Keys the HMAC that session cookies are stored under. **At least 32 characters, cryptographically random.** Without it the portal shows a setup screen and refuses every session. |
| `COVERESY_SETUP_TOKEN` | secret | Gates first-administrator creation, once. |
| `COVERESY_ENV` | `wrangler.toml` var | `production` turns on `Secure` cookies and HSTS. Anything else is treated as development. |

Neither secret is ever rendered into a page, returned by a response, or written
to the audit log — there is a smoke-test assertion for each.

### Rotating or disabling the setup token (§4.7)

`POST /auth/setup` refuses outright once any administrator exists, so the token
is inert after first run. To remove it as well:

```bash
npx wrangler secret delete COVERESY_SETUP_TOKEN
```

The Settings page shows whether each secret is configured, never its value.

Rotating `COVERESY_SESSION_SECRET` invalidates every live session (everyone is
logged out). That is the fastest way to revoke all access at once:

```bash
openssl rand -hex 32 | npx wrangler secret put COVERESY_SESSION_SECRET
```

## 4. Administrator setup

1. Deploy with both secrets set.
2. Open the portal. With no admin present it redirects to `/setup`.
3. Enter the setup token, name, email and a password of 12+ characters.
   There is no default password and no bypass.
4. Log in, then **delete the setup token** (above).
5. Create the rest of the team under **Users**, as Operator or Viewer.

Disabling a user deletes their live sessions immediately. So does resetting
their password. The last active administrator cannot be demoted or disabled.

## 5. Backup, retention and recovery

Two stores must be backed up together — the database and the documents.

```bash
# Database -> a timestamped SQL file.
npx wrangler d1 export coveresy-ops --remote --output "backup-$(date +%F).sql"

# Documents.
npx rclone sync r2:coveresy-docs ./r2-backup   # or any S3-compatible tool
```

Run both on the same schedule; a database row points at an R2 object by
`storage_key`, so a mismatched pair loses the link between them. Keep backups
encrypted and off the Cloudflare account that holds the live data.

**Restore:**

```bash
npx wrangler d1 execute coveresy-ops --remote --file=backup-YYYY-MM-DD.sql
npx rclone sync ./r2-backup r2:coveresy-docs
```

Restore into a *fresh* D1 database first and point a preview deployment at it.
Never restore over live data to check whether a backup is good.

**Retention (§18 decision 8):** nothing is deleted automatically. "Remove" on a
document deletes the R2 object but keeps the metadata row and the full
`document_events` trail, so the audit record of what was removed survives.

**Before any destructive migration:** take both backups above, apply the
migration to a copy, and verify it there first. Migrations are forward-only
files in `migrations/`; they are never edited once applied.

## 6. Testing

```bash
npm run typecheck   # tsc --noEmit, zero errors
npm test            # 39 unit tests: document rules, transitions, payout maths, CSV, XLSX
./test/smoke.sh     # 57 live checks against a running server
```

`npm test` covers the logic that must not be wrong: every §3 and §20 document
rule case, the §14.3 transition matrix, payout rounding and rule selection, and
export encoding. `smoke.sh` covers the parts only a real server can prove —
sessions, cookies, CSRF, role enforcement, IDOR, file-content sniffing, and that
a direct API call cannot bypass the document rules.

## 7. How it is organised

```
src/
  index.ts        entry point; security headers
  router.ts       routing, session loading, role guard, CSRF origin check
  auth.ts         PBKDF2 passwords, HMAC session tokens, capabilities, rate limit
  rules.ts        §3 document rule engine          <- pure, unit-tested
  payout.ts       §9 money maths, rule selection    <- pure, unit-tested
  transitions.ts  §14.3 status transition matrix    <- pure, unit-tested
  service.ts      shared queries, filters, doc-state sync, payout recalculation
  db.ts           settings, master data, visibility scope (the IDOR guard)
  html.ts         escaping template tag — the single XSS boundary
  ui.ts           page shell, tables, badges, flash messages
  csv.ts xlsx.ts  export encoders
  routes/         auth, dashboard, applications, documents, payouts, masters, reports
migrations/       forward-only SQL
test/             unit tests + the live smoke script
```

The three files that encode the business rules — `rules.ts`, `payout.ts`,
`transitions.ts` — are pure functions with no database or network access. That
is deliberate: they are the parts that must be provably correct, and they can be
read and tested without running anything else.

## 8. Things worth knowing before changing it

- **Money is integer paise everywhere.** Percentages are integer basis points
  (1250 bp = 12.50%). Nothing touches a float. `Money` in `payout.ts` exists so
  one export row renders as text in CSV and as a real number in XLSX.
- **Rules are data, not code.** Document rules and payout rules live in tables.
  Changing Health's Policy Copy to optional is a database edit, not a deploy —
  there is a unit test asserting exactly that.
- **The server is the only authority.** Hidden buttons are convenience;
  `checkTransition` and the capability guard are what actually refuse.
  Every list query is scoped through `visibilityScope()`.
- **Document state is recomputed, never asserted.** `syncDocState()` re-derives
  completion from the attachments after every change, which is why switching an
  application from Life to Health instantly re-applies Health's rules without
  touching the files already attached.
- **An import never marks a document as uploaded** (§15). Spreadsheets create
  Draft applications only.

# Coveresy Partner API

FastAPI backend for partner onboarding. Receives applications from
`/partner/` (the Become a Partner page) and exposes them to staff.

Validation lives in the API; storage does not. Clean records are forwarded to
the admin portal Worker (`POST /internal/partner-applications`), which writes
them to D1 — the database staff already work in. Vercel's filesystem is
ephemeral, so the API never persists anything itself.

```
browser → /api/partners/apply (FastAPI on Vercel) → Worker sink → D1
```

## Run locally

```bash
cd portal && npx wrangler dev --local --port 8787    # Worker + local D1
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
PARTNER_SINK_URL=http://127.0.0.1:8787/internal/partner-applications \
  PARTNER_SINK_SECRET=dev-only-sink-secret \
  uvicorn index:app --reload --port 8012 --app-dir api
```

Self-check (stubs the sink, no Worker needed): `python tests/test_partner_api.py`.

## Env

| Var | Where | Purpose |
| --- | --- | --- |
| `PARTNER_SINK_URL` | Vercel | Worker sink endpoint; unset ⇒ apply returns 503 |
| `PARTNER_SINK_SECRET` | Vercel **and** Worker | Shared bearer secret; must match on both sides |
| `CORS_ORIGINS` | Vercel | Comma-separated allowed browser origins |

## Endpoints

- `POST /api/partners/apply` → `201 {id, status}`; `409` on duplicate mobile/PAN,
  `422` on invalid input, `502` if the sink is unreachable, `503` if unconfigured.
- `GET /api/partners/health` → `{ok, sink_configured}`.

Staff currently read applications with
`wrangler d1 execute coveresy-ops --remote --command "SELECT * FROM partner_applications"`.
A review screen in the portal is the obvious next step.

## Rotating the shared secret

```bash
S=$(openssl rand -hex 32)
cd portal && echo "$S" | npx wrangler secret put PARTNER_SINK_SECRET --env staging
printf '%s' "$S" | npx vercel env add PARTNER_SINK_SECRET production --force
npx vercel --prod      # the function reads it at boot
```

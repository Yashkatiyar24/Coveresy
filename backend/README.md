# Coveresy Partner API

FastAPI backend for partner onboarding. Receives applications from
`/partner/` (the Become a Partner page) and exposes them to staff.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
PARTNER_DB=partners.db ADMIN_API_KEY=<pick-a-secret> uvicorn main:app --reload --port 8011
```

Docs at `/docs`. Self-check: `python test_main.py`.

## Env

| Var | Default | Purpose |
| --- | --- | --- |
| `PARTNER_DB` | `partners.db` | SQLite file |
| `ADMIN_API_KEY` | unset | Staff key for `GET /api/partners`; unset ⇒ endpoint returns 503 |
| `CORS_ORIGINS` | prod + `localhost:8000` | Comma-separated allowed browser origins |

## Endpoints

- `POST /api/partners/apply` → `201 {id, status}`; `409` on duplicate mobile/PAN, `422` on invalid input.
- `GET /api/partners?status=new&limit=100` → requires `X-API-Key`.

## Wiring the site to it

The page calls `/api/partners/apply` same-origin by default. Deployed on Vercel,
either add a rewrite from `/api/*` to this service in `vercel.json`, or set
`window.COVERESY_API = 'https://api.coveresy.com/api'` before the page script.

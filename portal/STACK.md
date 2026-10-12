# Stack: written proposal

§2 of the handoff recommends React + TypeScript + Vite + TanStack on Cloudflare
Workers, and allows the developer to propose an alternative **in writing before
starting**. This is that note.

## What was built instead

| Layer | §2 recommendation | Built |
|---|---|---|
| Backend | Cloudflare Workers, typed routes, Zod on every input | **Same** |
| Database | Cloudflare D1, versioned SQL migrations | **Same** (plain SQL, no ORM) |
| Files | Cloudflare R2, private bucket | **Same** |
| Passwords | Argon2id or scrypt/PBKDF2, high work factor | **PBKDF2-SHA256, 210,000 iterations** |
| Sessions | Opaque random tokens, stored hashed in D1 | **Same** (HMAC-SHA256 under the session secret) |
| Money | Integer paise | **Same** |
| Frontend | React + Vite + TanStack Router + a table library | **Server-rendered HTML from the Worker** |

Only the last row differs.

## Why

1. **The requirements are form-and-table shaped.** Every screen in §16 is a
   filtered table, a form, or a detail page. None of it needs client-side state
   that outlives a request. An SPA would add a build step, a router, a data-fetch
   layer and a client/server type contract to render what a server template
   renders directly.

2. **It removes a whole class of security bug.** §12 says "hiding a button in the
   UI is not security". With no client-side data layer there is no JSON API
   surface to secure separately: a page *is* the permission check. The CSP this
   app sends is `script-src 'none'` — there is no application JavaScript to
   attack, no bundle that could accidentally carry a secret, and no dependency
   tree to audit beyond Zod.

3. **It is faster for the operations team.** Each page is a single HTML response
   with no bundle to download, parse and hydrate. That matters on the mixed
   hardware an internal ops team actually uses.

4. **Less code to hand over.** ~5,500 lines total including tests and SQL. There
   is no build pipeline: `wrangler deploy` ships the source.

## What is given up, honestly

- **No instant client-side table sorting.** Sorting and paging are server
  round-trips. On tables of this size (hundreds to low thousands of rows,
  paginated at 25) the difference is not perceptible, but it is a real
  difference.
- **No partial page updates.** Uploading a document reloads the detail page
  rather than updating in place. Each action still completes in one request.
- **Adding a genuinely interactive screen later costs more.** If Coveresy later
  wants something like a drag-and-drop pipeline board or a live-updating queue,
  that screen would need JavaScript added back. The backend would not change —
  the routes already return exactly the data such a screen needs.

## On the password hash

§2 lists "Argon2id **or** scrypt/PBKDF2 with a high work factor". Argon2id is the
stronger choice but has no native implementation in the Workers runtime; the
alternatives are a WASM bundle or a native binding neither of which Workers
supports cleanly. PBKDF2-SHA256 is used instead, through the platform's own
WebCrypto, at 210,000 iterations — the OWASP 2023 minimum for that algorithm.
This is the second option §2 explicitly permits, not a downgrade past the spec.
If Argon2id becomes available in the runtime, `hashPassword`/`verifyPassword` in
`src/auth.ts` are the only two functions that would change, and the stored hash
format (`pbkdf2$iterations$salt$hash`) already carries its scheme name so both
can coexist during a migration.

## Reversibility

The backend is unchanged from §2's recommendation. If Anwar prefers the React
build, the Workers routes, D1 schema, R2 handling, document rule engine, payout
engine and transition matrix all carry over unchanged; what would be rewritten is
`src/ui.ts`, `src/styles.ts` and the rendering half of `src/routes/*`. The
business logic in `rules.ts`, `payout.ts` and `transitions.ts` has no UI
dependency at all and would be reused as-is.

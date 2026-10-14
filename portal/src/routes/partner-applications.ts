import { get, post } from '../router.ts';
import { html } from '../html.ts';
import { badge, flash, flashFromUrl, page, table } from '../ui.ts';
import { hashPassword, hex, randomId } from '../auth.ts';
import type { Ctx } from '../types.ts';

/**
 * Staff review of applications from the public "Become a Partner" form.
 * Approving one is what creates the partner's login, so the two records stay
 * linked and nobody has to issue credentials by hand.
 */

const STATUSES = ['new', 'contacted', 'approved', 'rejected'] as const;
type Status = typeof STATUSES[number];

interface Application {
  id: string; full_name: string; email: string; mobile: string; gender: string;
  pincode: string; pan: string; referral: string | null; status: string;
  staff_note: string | null; reviewed_at: string | null; created_at: string;
  account_id: string | null; agent_code: string | null;
}

/** Readable but unguessable; the partner is told to change it at first sign-in. */
function tempPassword(): string {
  return 'Coveresy-' + hex(crypto.getRandomValues(new Uint8Array(6)).buffer);
}

async function freeAgentCode(ctx: Ctx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = `CF/POS/${100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 899999)}`;
    const taken = await ctx.env.DB.prepare('SELECT 1 AS x FROM partner_accounts WHERE agent_code = ?')
      .bind(code).first();
    if (!taken) return code;
  }
  throw new Error('Could not allocate an agent code');
}

get('/partners/applications', async (ctx: Ctx) => {
  const status = ctx.url.searchParams.get('status') ?? '';
  const where = STATUSES.includes(status as Status) ? 'WHERE ap.status = ?' : '';
  const binds = where ? [status] : [];

  const [{ results }, counts] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT ap.*, pa.id AS account_id, pa.agent_code
         FROM partner_applications ap
         LEFT JOIN partner_accounts pa ON pa.application_id = ap.id
         ${where}
        ORDER BY ap.created_at DESC LIMIT 300`).bind(...binds).all<Application>(),
    ctx.env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM partner_applications GROUP BY status`).all<{ status: string; n: number }>(),
  ]);
  const byStatus = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));

  return page({ title: 'Partner applications', user: ctx.user, ctx, active: '/partners', wide: true }, html`
    <p class="crumb"><a href="/partners">← Partners</a></p>
    <h1>Partner applications</h1>
    ${flashFromUrl(ctx.url)}
    <div class="cards">
      ${STATUSES.map((s) => html`<div class="card stat"><b>${byStatus[s] ?? 0}</b><span>${s}</span></div>`)}
    </div>
    <p class="filters">
      <a class="btn ${status ? 'ghost' : ''}" href="/partners/applications">All</a>
      ${STATUSES.map((s) => html`<a class="btn ${status === s ? '' : 'ghost'}" href="/partners/applications?status=${s}">${s}</a>`)}
    </p>
    ${table(
      ['Applied', 'Applicant', 'PAN', 'PIN', 'Referral', 'Status', 'Login', 'Review'],
      results.map((a) => html`<tr>
        <td>${(a.created_at ?? '').slice(0, 10)}</td>
        <td>${a.full_name}<br><small>${a.email} · ${a.mobile}</small></td>
        <td><code>${a.pan}</code></td>
        <td>${a.pincode}</td>
        <td>${a.referral ?? '—'}</td>
        <td>${badge(a.status)}${a.staff_note ? html`<br><small>${a.staff_note}</small>` : ''}</td>
        <td>${a.account_id
          ? html`<a href="/partners/${a.account_id}">${a.agent_code}</a>`
          : html`<span class="muted">none yet</span>`}</td>
        <td>
          ${a.account_id ? '' : html`<form method="post" action="/partners/applications/${a.id}/approve" class="inline">
            <button class="btn small">Approve &amp; create login</button>
          </form>`}
          <form method="post" action="/partners/applications/${a.id}/status" class="inline">
            <select name="status">
              ${STATUSES.map((s) => html`<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`)}
            </select>
            <input type="text" name="staff_note" value="${a.staff_note ?? ''}" placeholder="Note">
            <button class="btn small ghost">Save</button>
          </form>
        </td>
      </tr>`),
      'No applications yet.',
    )}
  `);
});

post('/partners/applications/:id/status', async (ctx: Ctx) => {
  const form = await ctx.req.formData();
  const status = String(form.get('status') ?? '');
  const note = String(form.get('staff_note') ?? '').slice(0, 500);
  if (!STATUSES.includes(status as Status)) return flash('/partners/applications', 'err', 'Unknown status');

  await ctx.env.DB.prepare(
    `UPDATE partner_applications
        SET status = ?, staff_note = ?, reviewed_at = datetime('now'), reviewed_by = ?
      WHERE id = ?`,
  ).bind(status, note || null, ctx.user!.id, ctx.params.id).run();
  return flash('/partners/applications', 'ok', 'Application updated');
});

post('/partners/applications/:id/approve', async (ctx: Ctx) => {
  const app = await ctx.env.DB.prepare('SELECT * FROM partner_applications WHERE id = ?')
    .bind(ctx.params.id).first<Application>();
  if (!app) return flash('/partners/applications', 'err', 'No such application');

  const existing = await ctx.env.DB.prepare(
    'SELECT agent_code FROM partner_accounts WHERE email = ? OR mobile = ? OR application_id = ?',
  ).bind(app.email, app.mobile, app.id).first<{ agent_code: string }>();
  if (existing) {
    return flash('/partners/applications', 'err', `A login already exists for them (${existing.agent_code})`);
  }

  const password = tempPassword();
  const id = randomId('pac_');
  const code = await freeAgentCode(ctx);

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO partner_accounts
         (id, application_id, agent_code, name, email, mobile, password_hash,
          agent_type, status, created_via, created_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'coveresy', 'approved', 'staff', ?)`,
    ).bind(id, app.id, code, app.full_name, app.email, app.mobile,
           await hashPassword(password), `approved by ${ctx.user!.name}`),
    ctx.env.DB.prepare(
      `UPDATE partner_applications
          SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?
        WHERE id = ?`).bind(ctx.user!.id, app.id),
  ]);

  // Rendered straight back, never through a redirect: a password in a URL ends
  // up in browser history. It is shown once and cannot be recovered after.
  return page({ title: 'Login created', user: ctx.user, ctx, active: '/partners' }, html`
    <div class="card narrow">
      <h1>Login created</h1>
      <p>${app.full_name} can now sign in at
        <a href="https://www.coveresy.com/partner-portal/login.html">the partner portal</a>.</p>
      <dl class="kv">
        <dt>Agent code</dt><dd><code>${code}</code></dd>
        <dt>Email</dt><dd><code>${app.email}</code></dd>
        <dt>Temporary password</dt><dd><code>${password}</code></dd>
      </dl>
      <p class="flash warn"><strong>Shown once.</strong> Pass it to the partner now — it is stored
        only as a hash, so it cannot be read back. Ask them to change it under My profile.</p>
      <p><a class="btn" href="/partners/applications">Back to applications</a>
         <a class="btn ghost" href="/partners/${id}">Open their partner page</a></p>
    </div>
  `);
});

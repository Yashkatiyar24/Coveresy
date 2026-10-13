import { get, post } from '../router.ts';
import { html } from '../html.ts';
import { badge, empty, flash, flashFromUrl, numh, page, table } from '../ui.ts';
import { rupees } from '../payout.ts';
import type { Ctx } from '../types.ts';

/**
 * Staff view of the partner channel: who the partners are, the agents under
 * them, what each has raised, and the missing-policy queue they report into.
 */

const PRODUCTS = ['car', 'bike', 'health', 'life'] as const;
const MISSING_STATUSES = ['pending', 'in_review', 'identified', 'rejected'] as const;

interface PartnerRow {
  id: string; agent_code: string; name: string; email: string; mobile: string;
  status: string; parent_id: string | null; parent_name: string | null; created_at: string;
  quotes: number; issued: number; premium: number; agents: number; open_reports: number;
}

get('/partners', async (ctx: Ctx) => {
  const q = (ctx.url.searchParams.get('q') ?? '').trim();
  const like = `%${q.toLowerCase()}%`;
  const where = q ? 'WHERE lower(pa.name || pa.email || pa.mobile || pa.agent_code) LIKE ?' : '';
  const binds = q ? [like] : [];

  const { results } = await ctx.env.DB.prepare(
    `SELECT pa.id, pa.agent_code, pa.name, pa.email, pa.mobile, pa.status, pa.parent_id,
            parent.name AS parent_name, pa.created_at,
            (SELECT COUNT(*) FROM quote_requests q WHERE q.partner_id = pa.id) AS quotes,
            (SELECT COUNT(*) FROM quote_requests q WHERE q.partner_id = pa.id AND q.stage = 'payment_done') AS issued,
            (SELECT COALESCE(SUM(q.total_premium),0) FROM quote_requests q WHERE q.partner_id = pa.id) AS premium,
            (SELECT COUNT(*) FROM partner_accounts c WHERE c.parent_id = pa.id) AS agents,
            (SELECT COUNT(*) FROM missing_policy_requests m
              WHERE m.partner_id = pa.id AND m.status IN ('pending','in_review')) AS open_reports
       FROM partner_accounts pa
       LEFT JOIN partner_accounts parent ON parent.id = pa.parent_id
       ${where}
      ORDER BY pa.created_at DESC LIMIT 500`,
  ).bind(...binds).all<PartnerRow>();

  const totals = results.reduce(
    (acc, r) => ({ quotes: acc.quotes + r.quotes, issued: acc.issued + r.issued, premium: acc.premium + r.premium }),
    { quotes: 0, issued: 0, premium: 0 },
  );
  const principals = results.filter((r) => !r.parent_id).length;

  return page({ title: 'Partners', user: ctx.user, ctx, active: '/partners', wide: true }, html`
    <h1>Partners</h1>
    ${flashFromUrl(ctx.url)}
    <div class="cards">
      <div class="card stat"><b>${results.length}</b><span>Partner logins</span></div>
      <div class="card stat"><b>${principals}</b><span>Principals</span></div>
      <div class="card stat"><b>${results.length - principals}</b><span>Sub-agents</span></div>
      <div class="card stat"><b>${totals.quotes}</b><span>Quote requests</span></div>
      <div class="card stat"><b>${totals.issued}</b><span>Issued</span></div>
      <div class="card stat"><b>${rupees(totals.premium)}</b><span>Premium</span></div>
    </div>
    <form class="filters" method="get">
      <input type="search" name="q" value="${q}" placeholder="Name, email, mobile or agent code">
      <button class="btn">Search</button>
      ${q ? html`<a class="btn ghost" href="/partners">Clear</a>` : ''}
    </form>
    ${table(
      ['Agent code', 'Partner', 'Reports to', 'Status', numh('Agents'), numh('Quotes'), numh('Issued'), numh('Premium'), numh('Open reports'), 'Joined'],
      results.map((r) => html`<tr>
        <td><a href="/partners/${r.id}">${r.agent_code}</a></td>
        <td>${r.name}<br><small>${r.email} · ${r.mobile}</small></td>
        <td>${r.parent_name ?? '—'}</td>
        <td>${badge(r.status)}</td>
        <td class="num">${r.agents}</td>
        <td class="num">${r.quotes}</td>
        <td class="num">${r.issued}</td>
        <td class="num">${rupees(r.premium)}</td>
        <td class="num">${r.open_reports || '—'}</td>
        <td>${(r.created_at ?? '').slice(0, 10)}</td>
      </tr>`),
      q ? 'No partner matches that search.' : 'No partners have signed up yet.',
    )}
  `);
});

get('/partners/:id', async (ctx: Ctx) => {
  const id = ctx.params.id;
  const partner = await ctx.env.DB.prepare(
    `SELECT pa.*, parent.name AS parent_name FROM partner_accounts pa
       LEFT JOIN partner_accounts parent ON parent.id = pa.parent_id WHERE pa.id = ?`,
  ).bind(id).first<Record<string, string>>();
  if (!partner) return page({ title: 'Partner', user: ctx.user, ctx }, html`<div class="card narrow"><p>No such partner.</p></div>`);

  const [agents, quotes, missing, byProduct] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, agent_code, name, email, mobile, status, created_at FROM partner_accounts
        WHERE parent_id = ? ORDER BY created_at DESC`).bind(id).all(),
    ctx.env.DB.prepare(
      `SELECT id, product, stage, customer_name, customer_phone, details, total_premium, created_at
         FROM quote_requests WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200`).bind(id).all(),
    ctx.env.DB.prepare(
      `SELECT id, policy_number, issue_month, product, comment, start_date, document_key,
              document_name, status, staff_note, created_at
         FROM missing_policy_requests WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200`).bind(id).all(),
    ctx.env.DB.prepare(
      `SELECT product, COUNT(*) AS n, COALESCE(SUM(total_premium),0) AS premium
         FROM quote_requests WHERE partner_id = ? GROUP BY product`).bind(id).all<{ product: string; n: number; premium: number }>(),
  ]);

  const counts = Object.fromEntries(byProduct.results.map((r) => [r.product, r]));

  return page({ title: partner.name, user: ctx.user, ctx, active: '/partners', wide: true }, html`
    <p class="crumb"><a href="/partners">← All partners</a></p>
    <h1>${partner.name} <small>${partner.agent_code}</small></h1>
    ${flashFromUrl(ctx.url)}
    <div class="card">
      <dl class="kv">
        <dt>Email</dt><dd>${partner.email}</dd>
        <dt>Mobile</dt><dd>${partner.mobile}</dd>
        <dt>Status</dt><dd>${badge(partner.status)}</dd>
        <dt>Type</dt><dd>${partner.agent_type}</dd>
        <dt>Reports to</dt><dd>${partner.parent_name ?? 'Principal partner'}</dd>
        <dt>Joined</dt><dd>${(partner.created_at ?? '').slice(0, 10)}</dd>
      </dl>
    </div>

    <h2>Business by product</h2>
    ${table(['Product', numh('Requests'), numh('Premium')],
      PRODUCTS.map((p) => html`<tr>
        <td>${p.charAt(0).toUpperCase() + p.slice(1)}</td>
        <td class="num">${counts[p]?.n ?? 0}</td>
        <td class="num">${rupees(counts[p]?.premium ?? 0)}</td>
      </tr>`))}

    <h2>Agents under this partner</h2>
    ${table(['Agent code', 'Name', 'Contact', 'Status', 'Joined'],
      agents.results.map((a: any) => html`<tr>
        <td><a href="/partners/${a.id}">${a.agent_code}</a></td>
        <td>${a.name}</td>
        <td>${a.email} · ${a.mobile}</td>
        <td>${badge(a.status)}</td>
        <td>${(a.created_at ?? '').slice(0, 10)}</td>
      </tr>`), 'No agents added.')}

    <h2>Quote requests</h2>
    ${table(['Raised', 'Product', 'Customer', 'Detail', 'Stage', numh('Premium')],
      quotes.results.map((r: any) => html`<tr>
        <td>${(r.created_at ?? '').slice(0, 10)}</td>
        <td>${r.product}</td>
        <td>${r.customer_name ?? '—'}<br><small>${r.customer_phone ?? ''}</small></td>
        <td><small>${r.details}</small></td>
        <td>${badge(r.stage)}</td>
        <td class="num">${r.total_premium ? rupees(r.total_premium) : '—'}</td>
      </tr>`), 'No quote requests yet.')}

    <h2>Missing policy reports</h2>
    ${missing.results.length === 0 ? empty('Nothing reported.') : html`<div class="tablewrap"><table>
      <thead><tr><th>Reported</th><th>Policy</th><th>Month</th><th>Product</th><th>Comment</th><th>Document</th><th>Status</th><th>Update</th></tr></thead>
      <tbody>${missing.results.map((m: any) => html`<tr>
        <td>${(m.created_at ?? '').slice(0, 10)}</td>
        <td>${m.policy_number}</td>
        <td>${m.issue_month}</td>
        <td>${m.product}</td>
        <td><small>${m.comment ?? '—'}</small></td>
        <td>${m.document_key ? html`<a href="/partners/missing/${m.id}/document">${m.document_name ?? 'Download'}</a>` : '—'}</td>
        <td>${badge(m.status)}</td>
        <td><form method="post" action="/partners/missing/${m.id}" class="inline">
          <select name="status">
            ${MISSING_STATUSES.map((s) => html`<option value="${s}" ${s === m.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`)}
          </select>
          <input type="text" name="staff_note" value="${m.staff_note ?? ''}" placeholder="Note">
          <button class="btn small">Save</button>
        </form></td>
      </tr>`)}</tbody></table></div>`}
  `);
});

post('/partners/missing/:id', async (ctx: Ctx) => {
  const form = await ctx.req.formData();
  const status = String(form.get('status') ?? '');
  const note = String(form.get('staff_note') ?? '').slice(0, 500);
  if (!MISSING_STATUSES.includes(status as typeof MISSING_STATUSES[number])) {
    return flash('/partners', 'err', 'Unknown status');
  }
  const row = await ctx.env.DB.prepare('SELECT partner_id FROM missing_policy_requests WHERE id = ?')
    .bind(ctx.params.id).first<{ partner_id: string }>();
  if (!row) return flash('/partners', 'err', 'No such report');

  const resolved = status === 'identified' || status === 'rejected';
  await ctx.env.DB.prepare(
    `UPDATE missing_policy_requests
        SET status = ?, staff_note = ?, resolved_at = ${resolved ? "datetime('now')" : 'NULL'}
      WHERE id = ?`,
  ).bind(status, note || null, ctx.params.id).run();
  return flash(`/partners/${row.partner_id}`, 'ok', 'Report updated');
});

get('/partners/missing/:id/document', async (ctx: Ctx) => {
  const row = await ctx.env.DB.prepare(
    'SELECT document_key, document_name FROM missing_policy_requests WHERE id = ?',
  ).bind(ctx.params.id).first<{ document_key: string | null; document_name: string | null }>();
  if (!row?.document_key) return flash('/partners', 'err', 'No document on that report');
  if (!ctx.env.DOCS) return flash('/partners', 'err', 'Document storage is not enabled');

  const object = await ctx.env.DOCS.get(row.document_key);
  if (!object) return flash('/partners', 'err', 'Document is no longer stored');
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${(row.document_name ?? 'document').replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

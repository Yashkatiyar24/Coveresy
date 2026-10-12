import { get } from '../router.ts';
import { html, raw } from '../html.ts';
import { badge, flashFromUrl, page, table } from '../ui.ts';
import { buildFilter } from '../service.ts';
import { rupees } from '../payout.ts';
import { masters } from '../db.ts';
import { APP_STATUSES, label } from '../types.ts';
import type { Ctx } from '../types.ts';

/** Every figure below is a COUNT/SUM over the filtered record set. Nothing is literal. */
get('/', async (ctx) => {
  const f = buildFilter(ctx);
  const b = f.binds;

  const one = <T>(sql: string, binds: unknown[] = b) =>
    ctx.env.DB.prepare(sql.replace('{W}', f.sql)).bind(...binds).first<T>();

  const [counts, premium, payoutAgg, byStatus, byInsurer, byPartner, byEmployee, trend] = await Promise.all([
    one<{ total: number; health: number; life: number; issued: number; pending_insurer: number; drafts: number; cancelled: number; missing_docs: number; awaiting_verif: number; rejected_docs: number }>(
      `SELECT COUNT(*) AS total,
        SUM(category='health') AS health,
        SUM(category='life') AS life,
        SUM(status='policy_issued') AS issued,
        SUM(status='submitted_to_insurer') AS pending_insurer,
        SUM(status='draft') AS drafts,
        SUM(status IN ('cancelled','rejected')) AS cancelled,
        SUM(doc_overall_status IN ('incomplete','partial')) AS missing_docs,
        SUM(doc_overall_status='pending_verification') AS awaiting_verif,
        SUM(doc_overall_status='rejected') AS rejected_docs
       FROM applications a WHERE {W}`),
    one<{ total_premium: number }>(`SELECT COALESCE(SUM(premium_paise),0) AS total_premium FROM applications a WHERE {W}`),
    one<{ gross: number; tds: number; net: number; paid: number; pending: number }>(
      `SELECT COALESCE(SUM(p.gross_paise),0) AS gross, COALESCE(SUM(p.tds_paise),0) AS tds,
              COALESCE(SUM(p.net_paise),0) AS net,
              COALESCE(SUM(CASE WHEN p.status='paid' THEN p.net_paise ELSE 0 END),0) AS paid,
              COALESCE(SUM(CASE WHEN p.status IN ('pending','approved','processing','on_hold') THEN p.net_paise ELSE 0 END),0) AS pending
         FROM payouts p JOIN applications a ON a.id = p.application_id WHERE {W}`),
    ctx.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM applications a WHERE ${f.sql} GROUP BY status`).bind(...b).all<{ status: string; n: number }>(),
    ctx.env.DB.prepare(
      `SELECT i.name, COUNT(*) AS n, COALESCE(SUM(a.premium_paise),0) AS premium,
              COALESCE(SUM(p.net_paise),0) AS net
         FROM applications a LEFT JOIN insurers i ON i.id=a.insurer_id
         LEFT JOIN payouts p ON p.application_id=a.id
        WHERE ${f.sql} GROUP BY i.name ORDER BY n DESC LIMIT 10`).bind(...b).all<{ name: string | null; n: number; premium: number; net: number }>(),
    ctx.env.DB.prepare(
      `SELECT pa.name, pa.partner_code, COUNT(*) AS n, COALESCE(SUM(a.premium_paise),0) AS premium,
              COALESCE(SUM(p.net_paise),0) AS net
         FROM applications a LEFT JOIN partners pa ON pa.id=a.partner_id
         LEFT JOIN payouts p ON p.application_id=a.id
        WHERE ${f.sql} AND a.partner_id IS NOT NULL GROUP BY pa.id ORDER BY net DESC LIMIT 10`).bind(...b).all<{ name: string; partner_code: string; n: number; premium: number; net: number }>(),
    ctx.env.DB.prepare(
      `SELECT e.name, COUNT(*) AS n, SUM(a.status='policy_issued') AS issued,
              COALESCE(SUM(a.premium_paise),0) AS premium
         FROM applications a LEFT JOIN employees e ON e.id=a.employee_id
        WHERE ${f.sql} AND a.employee_id IS NOT NULL GROUP BY e.id ORDER BY n DESC LIMIT 10`).bind(...b).all<{ name: string; n: number; issued: number; premium: number }>(),
    ctx.env.DB.prepare(
      `SELECT substr(COALESCE(a.login_date, a.created_at),1,7) AS month, COUNT(*) AS logged,
              SUM(a.status='policy_issued') AS issued
         FROM applications a WHERE ${f.sql} GROUP BY month ORDER BY month DESC LIMIT 12`).bind(...b).all<{ month: string; logged: number; issued: number }>(),
  ]);

  const c = counts!;
  const stat = (n: unknown, text: string, alert = false) =>
    html`<div class="stat ${alert ? 'alert' : ''}"><b>${n ?? 0}</b><span>${text}</span></div>`;
  const money = (p: number, text: string) =>
    html`<div class="stat"><b>&#8377;${rupees(p ?? 0)}</b><span>${text}</span></div>`;

  const statusMap = new Map(byStatus.results.map((r) => [r.status, r.n]));

  return page(
    { title: 'Dashboard', user: ctx.user, ctx, active: '/', wide: true },
    html`<div class="pagehead"><div><h1>Dashboard</h1>
      <p>Every figure is computed from the database, under the filters below.</p></div></div>
    ${flashFromUrl(ctx.url)}
    ${await dashFilters(ctx)}

    <h3>Applications</h3>
    <div class="grid c4" style="margin-bottom:22px">
      ${stat(c.total, 'Total applications')}
      ${stat(c.health, 'Health')}
      ${stat(c.life, 'Life')}
      ${stat(c.issued, 'Policies issued')}
      ${stat(c.pending_insurer, 'Pending with insurers')}
      ${stat(c.drafts, 'Drafts')}
      ${stat(c.cancelled, 'Rejected / cancelled')}
    </div>

    <h3>Documents</h3>
    <div class="grid c4" style="margin-bottom:22px">
      ${stat(c.missing_docs, 'Missing mandatory documents', (c.missing_docs ?? 0) > 0)}
      ${stat(c.awaiting_verif, 'Awaiting verification')}
      ${stat(c.rejected_docs, 'With rejected documents', (c.rejected_docs ?? 0) > 0)}
    </div>

    <h3>Money</h3>
    <div class="grid c4" style="margin-bottom:22px">
      ${money(premium!.total_premium, 'Total premium')}
      ${money(payoutAgg!.gross, 'Gross payout')}
      ${money(payoutAgg!.tds, 'TDS')}
      ${money(payoutAgg!.net, 'Net payout')}
      ${money(payoutAgg!.paid, 'Paid')}
      ${money(payoutAgg!.pending, 'Pending payout')}
    </div>

    <div class="grid c2">
      <div class="card"><h2>By policy status</h2>
        ${table(['Status', 'Count'], APP_STATUSES.filter((s) => statusMap.get(s)).map(
          (s) => html`<tr><td>${badge(s)}</td><td class="num">${statusMap.get(s)}</td></tr>`), 'No applications yet.')}</div>

      <div class="card"><h2>Monthly trend</h2>
        ${table(['Month', 'Logged', 'Issued'], trend.results.map(
          (t) => html`<tr><td>${t.month ?? '—'}</td><td class="num">${t.logged}</td><td class="num">${t.issued ?? 0}</td></tr>`), 'No data yet.')}</div>

      <div class="card"><h2>Insurer-wise</h2>
        ${table(['Insurer', 'Apps', 'Premium', 'Net payout'], byInsurer.results.map(
          (r) => html`<tr><td>${r.name ?? '—'}</td><td class="num">${r.n}</td>
            <td class="num">&#8377;${rupees(r.premium)}</td><td class="num">&#8377;${rupees(r.net)}</td></tr>`), 'No data yet.')}</div>

      <div class="card"><h2>Partner-wise</h2>
        ${table(['Partner', 'Code', 'Apps', 'Premium', 'Net payout'], byPartner.results.map(
          (r) => html`<tr><td>${r.name}</td><td><code>${r.partner_code}</code></td><td class="num">${r.n}</td>
            <td class="num">&#8377;${rupees(r.premium)}</td><td class="num">&#8377;${rupees(r.net)}</td></tr>`), 'No partner-linked records.')}</div>

      <div class="card"><h2>Employee-wise</h2>
        ${table(['Employee', 'Apps', 'Issued', 'Premium'], byEmployee.results.map(
          (r) => html`<tr><td>${r.name}</td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>
            <td class="num">&#8377;${rupees(r.premium)}</td></tr>`), 'No employee-linked records.')}</div>
    </div>`,
  );
}, { cap: 'view_records' });

async function dashFilters(ctx: Ctx) {
  const m = await masters(ctx.env);
  const v = (k: string) => ctx.url.searchParams.get(k) ?? '';
  const opts = (list: Array<{ id: string; name: string }>, sel: string) =>
    list.map((x) => html`<option value="${x.id}" ${x.id === sel ? raw('selected') : ''}>${x.name}</option>`);
  return html`<form class="filters" method="get"><div class="row">
    <div><label>From (login)</label><input type="date" name="from" value="${v('from')}"></div>
    <div><label>To (login)</label><input type="date" name="to" value="${v('to')}"></div>
    <div><label>Category</label><select name="category"><option value="">All</option>
      <option value="health" ${v('category') === 'health' ? raw('selected') : ''}>Health</option>
      <option value="life" ${v('category') === 'life' ? raw('selected') : ''}>Life</option></select></div>
    <div><label>Insurer</label><select name="insurer"><option value="">All</option>${opts(m.insurers, v('insurer'))}</select></div>
    <div><label>Broker</label><select name="broker"><option value="">All</option>${opts(m.brokers, v('broker'))}</select></div>
    <div><label>Partner</label><select name="partner"><option value="">All</option>${opts(m.partners, v('partner'))}</select></div>
    <div><label>Employee</label><select name="employee"><option value="">All</option>${opts(m.employees, v('employee'))}</select></div>
    <div><label>Policy status</label><select name="status"><option value="">All</option>
      ${APP_STATUSES.map((s) => html`<option value="${s}" ${v('status') === s ? raw('selected') : ''}>${label(s)}</option>`)}</select></div>
    <div style="display:flex;align-items:flex-end;gap:8px"><button class="sm" type="submit">Apply</button>
      <a class="btn ghost sm" href="/">Clear</a></div>
  </div></form>`;
}

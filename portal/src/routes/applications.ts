import { z } from 'zod';
import { get, post } from '../router.ts';
import { html, raw } from '../html.ts';
import { badge, flash, page, pager, sortLink, table, redirect, flashFromUrl, errorPage } from '../ui.ts';
import { audit } from '../audit.ts';
import { can, randomId } from '../auth.ts';
import { masters, nameOf, listUsers } from '../db.ts';
import { assess, buildFilter, loadApp, orderBy, recalcPayout, syncDocState } from '../service.ts';
import type { AppRow } from '../service.ts';
import { paise, rupees } from '../payout.ts';
import { checkTransition, nextStatuses } from '../transitions.ts';
import { APP_STATUSES, DOC_LABELS, DOC_TYPES, label } from '../types.ts';
import type { AppStatus, Ctx } from '../types.ts';
import { docPanel } from './documents.ts';

const PER_PAGE = 25;

/* ----------------------------------------------------------------- list --- */

get('/applications', async (ctx) => {
  const f = buildFilter(ctx);
  const p = Math.max(1, Number(ctx.url.searchParams.get('page') ?? 1) || 1);
  const m = await masters(ctx.env);

  const countRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM applications a WHERE ${f.sql}`,
  ).bind(...f.binds).first<{ n: number }>();
  const total = countRow?.n ?? 0;

  const { results } = await ctx.env.DB.prepare(
    `SELECT a.*, po.status AS payout_status, po.net_paise
       FROM applications a LEFT JOIN payouts po ON po.application_id = a.id
      WHERE ${f.sql} ORDER BY ${orderBy(ctx)} LIMIT ? OFFSET ?`,
  ).bind(...f.binds, PER_PAGE, (p - 1) * PER_PAGE)
    .all<AppRow & { payout_status: string | null; net_paise: number | null }>();

  const rows = results.map(
    (a) => html`<tr>
      <td><a href="/applications/${a.id}">${a.application_no}</a></td>
      <td>${a.customer_name}</td>
      <td>${badge(a.category)}</td>
      <td>${nameOf(m.insurers, a.insurer_id)}</td>
      <td>${a.policy_no || '—'}</td>
      <td class="num">${rupees(a.premium_paise)}</td>
      <td>${badge(a.status)}</td>
      <td>${badge(a.doc_overall_status)}</td>
      <td>${a.payout_status ? badge(a.payout_status) : '—'}</td>
      <td class="num">${a.net_paise !== null ? rupees(a.net_paise) : '—'}</td>
      <td>${a.login_date || '—'}</td>
    </tr>`,
  );

  return page(
    { title: 'Policy MIS', user: ctx.user, ctx, active: '/applications', wide: true },
    html`<div class="pagehead">
      <div><h1>Policy MIS</h1><p>Health and Life applications, documents and payout state.</p></div>
      <div class="actions">
        <a class="btn ghost sm" href="/export${ctx.url.search}">Export CSV</a>
        <a class="btn ghost sm" href="/export?format=xlsx&${ctx.url.search.replace("?", "")}">Export XLSX</a>
        ${can(ctx.user, 'edit_applications', ctx.settings) ? html`<a class="btn" href="/applications/new">Add application</a>` : ''}
      </div>
    </div>
    ${flashFromUrl(ctx.url)}
    ${filterBar(ctx, m)}
    ${table(
      [
        sortLink(ctx.url, 'application_no', 'Application No'),
        sortLink(ctx.url, 'customer_name', 'Customer'),
        sortLink(ctx.url, 'category', 'Category'),
        'Insurer',
        sortLink(ctx.url, 'policy_no', 'Policy No'),
        sortLink(ctx.url, 'premium', 'Premium'),
        sortLink(ctx.url, 'status', 'Status'),
        sortLink(ctx.url, 'doc_status', 'Documents'),
        'Payout',
        'Net Payout',
        sortLink(ctx.url, 'login_date', 'Login Date'),
      ],
      rows,
      'No applications match these filters.',
    )}
    ${pager(ctx.url, p, total, PER_PAGE)}`,
  );
}, { cap: 'view_records' });

function filterBar(ctx: Ctx, m: Awaited<ReturnType<typeof masters>>) {
  const v = (k: string) => ctx.url.searchParams.get(k) ?? '';
  const opts = (list: Array<{ id: string; name: string }>, sel: string) =>
    list.map((x) => html`<option value="${x.id}" ${x.id === sel ? raw('selected') : ''}>${x.name}</option>`);
  return html`<form class="filters" method="get">
    <div class="row">
      <div><label>Search</label><input name="q" value="${v('q')}" placeholder="Customer, application or policy no"></div>
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
      <div><label>Document status</label><select name="doc_status"><option value="">All</option>
        ${['incomplete', 'partial', 'pending_verification', 'verified', 'rejected'].map((s) => html`<option value="${s}" ${v('doc_status') === s ? raw('selected') : ''}>${label(s)}</option>`)}</select></div>
      <div><label>Payout status</label><select name="payout_status"><option value="">All</option>
        ${['not_initiated', 'pending', 'approved', 'processing', 'paid', 'on_hold', 'reversed'].map((s) => html`<option value="${s}" ${v('payout_status') === s ? raw('selected') : ''}>${label(s)}</option>`)}</select></div>
      <div style="display:flex;align-items:flex-end;gap:8px"><button class="sm" type="submit">Apply</button>
        <a class="btn ghost sm" href="${ctx.url.pathname}">Clear</a></div>
    </div>
  </form>`;
}

/* --------------------------------------------------------------- create --- */

const appSchema = z.object({
  category: z.enum(['health', 'life']),
  application_no: z.string().trim().min(1).max(80),
  customer_name: z.string().trim().min(1).max(160),
  insurer_id: z.string().trim().min(1),
  product_id: z.string().trim().optional().default(''),
  product_name: z.string().trim().max(160).optional().default(''),
  login_date: z.string().trim().max(10).optional().default(''),
  policy_no: z.string().trim().max(80).optional().default(''),
  premium: z.string().trim().optional().default('0'),
  issued_date: z.string().trim().max(10).optional().default(''),
  policy_term: z.string().trim().max(40).optional().default(''),
  premium_frequency: z.string().trim().max(40).optional().default(''),
  insurer_rep_name: z.string().trim().max(160).optional().default(''),
  broker_id: z.string().trim().optional().default(''),
  partner_id: z.string().trim().optional().default(''),
  employee_id: z.string().trim().optional().default(''),
  assigned_user_id: z.string().trim().optional().default(''),
});

function nullIfBlank(s: string | undefined): string | null {
  return s && s.trim() ? s.trim() : null;
}

async function appForm(ctx: Ctx, app: AppRow | null) {
  const m = await masters(ctx.env);
  const users = await listUsers(ctx.env);
  const v = (k: keyof AppRow) => (app ? (app[k] ?? '') : '');
  const sel = (id: string, cur: unknown) => (id === cur ? raw('selected') : '');
  const options = (list: Array<{ id: string; name: string }>, cur: unknown) =>
    list.map((x) => html`<option value="${x.id}" ${sel(x.id, cur)}>${x.name}</option>`);

  return html`<form method="post" action="${app ? `/applications/${app.id}` : '/applications'}">
    <fieldset><legend>Application</legend>
      <div class="row">
        <div class="field"><label>Insurance Category <span class="req">*</span></label>
          <select name="category" required>
            <option value="health" ${sel('health', v('category'))}>Health Insurance</option>
            <option value="life" ${sel('life', v('category'))}>Life Insurance</option>
          </select>
          <small>Changing this re-applies that category's document rules immediately.</small></div>
        <div class="field"><label>Application Number <span class="req">*</span></label>
          <input name="application_no" value="${v('application_no')}" required>
          <small>Must be unique for the chosen insurer.</small></div>
        <div class="field"><label>Login Date</label><input type="date" name="login_date" value="${v('login_date')}"></div>
        <div class="field"><label>Customer Name <span class="req">*</span></label>
          <input name="customer_name" value="${v('customer_name')}" required></div>
        <div class="field"><label>Premium Amount (&#8377;)</label>
          <input name="premium" inputmode="decimal" value="${app ? rupees(app.premium_paise).replace(/,/g, '') : ''}" placeholder="0.00"></div>
        <div class="field"><label>Premium Payment Frequency</label>
          <input name="premium_frequency" value="${v('premium_frequency')}" placeholder="Annual / Monthly"></div>
        <div class="field"><label>Policy Number</label><input name="policy_no" value="${v('policy_no')}"></div>
        <div class="field"><label>Policy Issued Date</label><input type="date" name="issued_date" value="${v('issued_date')}"></div>
        <div class="field"><label>Policy Term</label><input name="policy_term" value="${v('policy_term')}" placeholder="10 years"></div>
      </div>
    </fieldset>
    <fieldset><legend>Insurer and distribution</legend>
      <div class="row">
        <div class="field"><label>Insurer <span class="req">*</span></label>
          <select name="insurer_id" required><option value="">Select</option>${options(m.insurers, v('insurer_id'))}</select></div>
        <div class="field"><label>Product / Plan</label>
          <select name="product_id"><option value="">Not listed</option>${options(m.products, v('product_id'))}</select></div>
        <div class="field"><label>Product / Plan name (free text)</label>
          <input name="product_name" value="${v('product_name')}"></div>
        <div class="field"><label>Insurer Representative</label>
          <input name="insurer_rep_name" value="${v('insurer_rep_name')}"></div>
        <div class="field"><label>Broker</label>
          <select name="broker_id"><option value="">None</option>${options(m.brokers, v('broker_id'))}</select></div>
        <div class="field"><label>Partner</label>
          <select name="partner_id"><option value="">None</option>${options(m.partners, v('partner_id'))}</select></div>
        <div class="field"><label>Employee</label>
          <select name="employee_id"><option value="">None</option>${options(m.employees, v('employee_id'))}</select></div>
        <div class="field"><label>Assigned Operations User</label>
          <select name="assigned_user_id"><option value="">Unassigned</option>${options(users, v('assigned_user_id'))}</select></div>
      </div>
    </fieldset>
    <div class="actions">
      <button type="submit">${app ? 'Save changes' : 'Create application'}</button>
      <a class="btn ghost" href="${app ? `/applications/${app.id}` : '/applications'}">Cancel</a>
    </div>
  </form>`;
}

get('/applications/new', async (ctx) => page(
  { title: 'Add application', user: ctx.user, ctx, active: '/applications' },
  html`<div class="pagehead"><div><h1>Add application</h1>
    <p>Documents are attached after the record exists, on the detail page.</p></div></div>
  ${flashFromUrl(ctx.url)}
  <div class="card">${await appForm(ctx, null)}</div>`,
), { cap: 'edit_applications' });

post('/applications', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const parsed = appSchema.safeParse(form);
  if (!parsed.success) {
    return flash('/applications/new', 'err', `Invalid input: ${parsed.error.issues[0].path.join('.')}`);
  }
  const d = parsed.data;
  let premium_paise = 0;
  try { premium_paise = paise(d.premium || '0'); } catch { return flash('/applications/new', 'err', 'Premium must be a number with at most two decimals.'); }

  const id = randomId('app_');
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO applications (id, category, product_id, product_name, login_date, application_no,
         policy_no, customer_name, premium_paise, status, issued_date, policy_term, premium_frequency,
         insurer_id, insurer_rep_name, broker_id, partner_id, employee_id, assigned_user_id,
         doc_overall_status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,'incomplete',?)`,
    ).bind(
      id, d.category, nullIfBlank(d.product_id), nullIfBlank(d.product_name), nullIfBlank(d.login_date),
      d.application_no, nullIfBlank(d.policy_no), d.customer_name, premium_paise,
      nullIfBlank(d.issued_date), nullIfBlank(d.policy_term), nullIfBlank(d.premium_frequency),
      d.insurer_id, nullIfBlank(d.insurer_rep_name), nullIfBlank(d.broker_id), nullIfBlank(d.partner_id),
      nullIfBlank(d.employee_id), nullIfBlank(d.assigned_user_id), ctx.user!.id,
    ).run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE') && msg.includes('application_no')) {
      return flash('/applications/new', 'err', 'That application number already exists for this insurer.');
    }
    if (msg.includes('UNIQUE') && msg.includes('policy_no')) {
      return flash('/applications/new', 'err', 'That policy number already exists for this insurer.');
    }
    throw e;
  }

  await ctx.env.DB.prepare(
    "INSERT INTO status_history (id, application_id, from_status, to_status, actor, remark) VALUES (?,?,NULL,'draft',?,'Created')",
  ).bind(randomId('sh_'), id, ctx.user!.id).run();
  await syncDocState(ctx, id);
  await recalcPayout(ctx, id);
  await audit(ctx, 'application.create', 'applications', id, undefined, { application_no: d.application_no, category: d.category });

  return flash(`/applications/${id}`, 'ok', 'Application created. Attach the required documents next.');
}, { cap: 'edit_applications' });

/* ----------------------------------------------------------------- edit --- */

get('/applications/:id/edit', async (ctx) => {
  const app = await loadApp(ctx, ctx.params.id);
  if (!app) return errorPage(ctx, 404, 'Application not found, or not visible to your account.');
  return page(
    { title: `Edit ${app.application_no}`, user: ctx.user, ctx, active: '/applications' },
    html`<div class="pagehead"><div><h1>Edit application</h1><p>${app.application_no} · ${app.customer_name}</p></div></div>
    ${flashFromUrl(ctx.url)}
    <div class="card">${await appForm(ctx, app)}</div>`,
  );
}, { cap: 'edit_applications' });

post('/applications/:id', async (ctx) => {
  const app = await loadApp(ctx, ctx.params.id);
  if (!app) return errorPage(ctx, 404, 'Application not found.');
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const parsed = appSchema.safeParse(form);
  if (!parsed.success) return flash(`/applications/${app.id}/edit`, 'err', 'Invalid input.');
  const d = parsed.data;
  let premium_paise = 0;
  try { premium_paise = paise(d.premium || '0'); } catch { return flash(`/applications/${app.id}/edit`, 'err', 'Premium must be a number with at most two decimals.'); }

  try {
    await ctx.env.DB.prepare(
      `UPDATE applications SET category=?, product_id=?, product_name=?, login_date=?, application_no=?,
         policy_no=?, customer_name=?, premium_paise=?, issued_date=?, policy_term=?, premium_frequency=?,
         insurer_id=?, insurer_rep_name=?, broker_id=?, partner_id=?, employee_id=?, assigned_user_id=?,
         updated_at=datetime('now') WHERE id=?`,
    ).bind(
      d.category, nullIfBlank(d.product_id), nullIfBlank(d.product_name), nullIfBlank(d.login_date),
      d.application_no, nullIfBlank(d.policy_no), d.customer_name, premium_paise,
      nullIfBlank(d.issued_date), nullIfBlank(d.policy_term), nullIfBlank(d.premium_frequency),
      d.insurer_id, nullIfBlank(d.insurer_rep_name), nullIfBlank(d.broker_id), nullIfBlank(d.partner_id),
      nullIfBlank(d.employee_id), nullIfBlank(d.assigned_user_id), app.id,
    ).run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE')) return flash(`/applications/${app.id}/edit`, 'err', 'That application or policy number already exists for this insurer.');
    throw e;
  }

  // Category may have changed: attachments are kept, the rules are re-applied.
  await syncDocState(ctx, app.id);
  await recalcPayout(ctx, app.id);
  await audit(ctx, 'application.edit', 'applications', app.id,
    { category: app.category, premium_paise: app.premium_paise, application_no: app.application_no },
    { category: d.category, premium_paise, application_no: d.application_no });

  const note = d.category !== app.category
    ? `Saved. Category changed to ${label(d.category)} — ${label(d.category)} document rules now apply.`
    : 'Application saved.';
  return flash(`/applications/${app.id}`, 'ok', note);
}, { cap: 'edit_applications' });

/* --------------------------------------------------------------- detail --- */

get('/applications/:id', async (ctx) => {
  const app = await loadApp(ctx, ctx.params.id);
  if (!app) return errorPage(ctx, 404, 'Application not found, or not visible to your account.');

  const [m, { assessment, docs }, history, payout, users] = await Promise.all([
    masters(ctx.env),
    assess(ctx, app),
    ctx.env.DB.prepare(
      `SELECT h.*, u.name AS actor_name FROM status_history h LEFT JOIN users u ON u.id = h.actor
        WHERE h.application_id = ? ORDER BY h.at DESC, h.rowid DESC`,
    ).bind(app.id).all<{ from_status: string | null; to_status: string; at: string; remark: string | null; actor_name: string | null }>(),
    ctx.env.DB.prepare('SELECT * FROM payouts WHERE application_id = ?').bind(app.id)
      .first<{ id: string; base_paise: number; payout_bp: number; gross_paise: number; tds_bp: number; tds_paise: number; deductions_paise: number; net_paise: number; status: string; paid_date: string | null; utr: string | null }>(),
    listUsers(ctx.env),
  ]);

  const targets = nextStatuses(app.status as AppStatus);
  const mayEdit = can(ctx.user, 'edit_applications', ctx.settings);

  return page(
    { title: app.application_no, user: ctx.user, ctx, active: '/applications', wide: true },
    html`<div class="pagehead">
      <div><h1>${app.customer_name}</h1>
        <p>${app.application_no} · ${badge(app.category)} ${badge(app.status)} ${badge(app.doc_overall_status)}</p></div>
      <div class="actions">
        ${mayEdit ? html`<a class="btn ghost sm" href="/applications/${app.id}/edit">Edit</a>` : ''}
        <a class="btn ghost sm" href="/applications">Back to MIS</a>
      </div>
    </div>
    ${flashFromUrl(ctx.url)}
    <div class="split">
      <div>
        ${docPanel(ctx, app, assessment, docs)}

        <div class="card"><h2>Status</h2>
          ${targets.length && mayEdit
            ? html`<form method="post" action="/applications/${app.id}/transition">
                <div class="row">
                  <div class="field"><label>Move to</label>
                    <select name="to" required>${targets.map((t) => html`<option value="${t}">${label(t)}</option>`)}</select></div>
                  <div class="field"><label>Remark (required to reject or cancel)</label>
                    <input name="remark" maxlength="400"></div>
                </div>
                <button class="sm" type="submit">Apply transition</button>
              </form>`
            : html`<p class="sub">No transition available from ${label(app.status)} for your role.</p>`}
          <h3 style="margin-top:18px">History</h3>
          <ul class="timeline">${history.results.map((h) => html`<li>
            ${h.from_status ? html`${label(h.from_status)} → ` : ''}<b>${label(h.to_status)}</b>
            <small>${h.at} · ${h.actor_name ?? 'system'}${h.remark ? ` · ${h.remark}` : ''}</small></li>`)}</ul>
        </div>
      </div>

      <div>
        <div class="card"><h2>Record</h2>
          <dl class="kv">
            <dt>Internal ID</dt><dd><code>${app.id}</code></dd>
            <dt>Product</dt><dd>${app.product_name || nameOf(m.products, app.product_id)}</dd>
            <dt>Policy No</dt><dd>${app.policy_no || '—'}</dd>
            <dt>Premium</dt><dd>&#8377;${rupees(app.premium_paise)}</dd>
            <dt>Frequency</dt><dd>${app.premium_frequency || '—'}</dd>
            <dt>Term</dt><dd>${app.policy_term || '—'}</dd>
            <dt>Login Date</dt><dd>${app.login_date || '—'}</dd>
            <dt>Issued Date</dt><dd>${app.issued_date || '—'}</dd>
            <dt>Insurer</dt><dd>${nameOf(m.insurers, app.insurer_id)}</dd>
            <dt>Insurer Rep</dt><dd>${app.insurer_rep_name || '—'}</dd>
            <dt>Broker</dt><dd>${nameOf(m.brokers, app.broker_id)}</dd>
            <dt>Partner</dt><dd>${nameOf(m.partners, app.partner_id)}</dd>
            <dt>Partner Code</dt><dd>${(m.partners.find((p) => p.id === app.partner_id)?.partner_code as string) || '—'}</dd>
            <dt>Employee</dt><dd>${nameOf(m.employees, app.employee_id)}</dd>
            <dt>Assigned to</dt><dd>${users.find((u) => u.id === app.assigned_user_id)?.name ?? 'Unassigned'}</dd>
            ${app.cancel_reason ? html`<dt>Reason</dt><dd>${app.cancel_reason}</dd>` : ''}
          </dl>
        </div>

        <div class="card"><h2>Payout</h2>
          ${payout
            ? html`<dl class="kv">
                <dt>Base</dt><dd>&#8377;${rupees(payout.base_paise)}</dd>
                <dt>Payout %</dt><dd>${(payout.payout_bp / 100).toFixed(2)}%</dd>
                <dt>Gross</dt><dd>&#8377;${rupees(payout.gross_paise)}</dd>
                <dt>TDS %</dt><dd>${(payout.tds_bp / 100).toFixed(2)}%</dd>
                <dt>TDS</dt><dd>&#8377;${rupees(payout.tds_paise)}</dd>
                <dt>Deductions</dt><dd>&#8377;${rupees(payout.deductions_paise)}</dd>
                <dt>Net</dt><dd><b>&#8377;${rupees(payout.net_paise)}</b></dd>
                <dt>Status</dt><dd>${badge(payout.status)}</dd>
                <dt>Paid on</dt><dd>${payout.paid_date || '—'}</dd>
                <dt>UTR</dt><dd>${payout.utr || '—'}</dd>
              </dl>
              <p style="margin:12px 0 0"><a href="/payouts/${payout.id}">Open payout</a></p>`
            : html`<p class="sub">No payout record yet.</p>`}
        </div>
      </div>
    </div>`,
  );
}, { cap: 'view_records' });

/* ---------------------------------------------------------- transitions --- */

post('/applications/:id/transition', async (ctx) => {
  const app = await loadApp(ctx, ctx.params.id);
  if (!app) return errorPage(ctx, 404, 'Application not found.');
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const to = String(form.to ?? '') as AppStatus;
  const remark = String(form.remark ?? '');
  if (!APP_STATUSES.includes(to)) return flash(`/applications/${app.id}`, 'err', 'Unknown target status.');

  const { assessment } = await assess(ctx, app);
  const check = checkTransition(app.status as AppStatus, to, {
    role: ctx.user!.role,
    docs: assessment,
    app,
    remark,
    operatorsMayVerify: ctx.settings.operators_may_verify === '1',
  });
  if (!check.allowed) return flash(`/applications/${app.id}`, 'err', check.reason ?? 'Transition refused.');

  const closing = to === 'rejected' || to === 'cancelled';
  await ctx.env.DB.prepare(
    `UPDATE applications SET status = ?, cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(to, closing ? remark : app.cancel_reason, app.id).run();
  await ctx.env.DB.prepare(
    'INSERT INTO status_history (id, application_id, from_status, to_status, actor, remark) VALUES (?,?,?,?,?,?)',
  ).bind(randomId('sh_'), app.id, app.status, to, ctx.user!.id, remark || null).run();
  await audit(ctx, 'application.transition', 'applications', app.id, { status: app.status }, { status: to, remark });

  if (to === 'policy_issued') await recalcPayout(ctx, app.id);
  return flash(`/applications/${app.id}`, 'ok', `Status changed to ${label(to)}.`);
}, { cap: 'edit_applications' });

export { DOC_TYPES, DOC_LABELS };

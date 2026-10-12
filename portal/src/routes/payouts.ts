import { get, post } from '../router.ts';
import { html, raw } from '../html.ts';
import { badge, errorPage, flash, flashFromUrl, page, pager, table } from '../ui.ts';
import { audit } from '../audit.ts';
import { can, randomId } from '../auth.ts';
import { visibilityScope } from '../db.ts';
import { computePayout, paise, pctToBp, rupees } from '../payout.ts';
import { PAYOUT_STATUSES, label } from '../types.ts';
import type { Ctx, PayoutStatus } from '../types.ts';

const PER_PAGE = 25;

interface PayoutRow {
  id: string; application_id: string; base_paise: number; payout_bp: number; gross_paise: number;
  tds_bp: number; tds_paise: number; deductions_paise: number; net_paise: number; status: PayoutStatus;
  paid_date: string | null; utr: string | null; remarks: string | null; rule_snapshot: string | null;
  application_no: string; customer_name: string; policy_no: string | null; category: string;
  partner_name: string | null; partner_code: string | null; insurer_name: string | null;
  employee_name: string | null; app_status: string;
}

const SELECT = `
  SELECT p.*, a.application_no, a.customer_name, a.policy_no, a.category, a.status AS app_status,
         pa.name AS partner_name, pa.partner_code, i.name AS insurer_name, e.name AS employee_name
    FROM payouts p
    JOIN applications a ON a.id = p.application_id
    LEFT JOIN partners pa ON pa.id = a.partner_id
    LEFT JOIN insurers i ON i.id = a.insurer_id
    LEFT JOIN employees e ON e.id = a.employee_id`;

get('/payouts', async (ctx) => {
  const scope = visibilityScope(ctx);
  const where: string[] = [scope.sql];
  const binds: unknown[] = [...scope.binds];
  const status = ctx.url.searchParams.get('status');
  if (status) { where.push('p.status = ?'); binds.push(status); }
  const q = ctx.url.searchParams.get('q')?.trim();
  if (q) { where.push('(a.customer_name LIKE ? OR a.application_no LIKE ? OR p.utr LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const w = where.join(' AND ');
  const p = Math.max(1, Number(ctx.url.searchParams.get('page') ?? 1) || 1);

  const [count, rows, totals] = await Promise.all([
    ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM payouts p JOIN applications a ON a.id=p.application_id WHERE ${w}`)
      .bind(...binds).first<{ n: number }>(),
    ctx.env.DB.prepare(`${SELECT} WHERE ${w} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...binds, PER_PAGE, (p - 1) * PER_PAGE).all<PayoutRow>(),
    ctx.env.DB.prepare(
      `SELECT COALESCE(SUM(p.gross_paise),0) g, COALESCE(SUM(p.tds_paise),0) t, COALESCE(SUM(p.net_paise),0) n
         FROM payouts p JOIN applications a ON a.id=p.application_id WHERE ${w}`)
      .bind(...binds).first<{ g: number; t: number; n: number }>(),
  ]);

  const body = rows.results.map((r) => html`<tr>
    <td><a href="/payouts/${r.id}">${r.application_no}</a></td>
    <td>${r.customer_name}</td>
    <td>${r.partner_name ?? '—'}</td>
    <td>${r.insurer_name ?? '—'}</td>
    <td class="num">&#8377;${rupees(r.base_paise)}</td>
    <td class="num">${(r.payout_bp / 100).toFixed(2)}%</td>
    <td class="num">&#8377;${rupees(r.gross_paise)}</td>
    <td class="num">&#8377;${rupees(r.tds_paise)}</td>
    <td class="num">&#8377;${rupees(r.net_paise)}</td>
    <td>${badge(r.status)}</td>
    <td>${r.utr ?? '—'}</td>
  </tr>`);

  return page(
    { title: 'Payouts', user: ctx.user, ctx, active: '/payouts', wide: true },
    html`<div class="pagehead"><div><h1>Payout Management</h1>
      <p>Partner-wise payouts, computed from the configured rules. Approval is Admin-only.</p></div>
      <div class="actions"><a class="btn ghost sm" href="/export?kind=payouts${status ? `&payout_status=${status}` : ''}">Export CSV</a></div></div>
    ${flashFromUrl(ctx.url)}
    <form class="filters" method="get"><div class="row">
      <div><label>Search</label><input name="q" value="${q ?? ''}" placeholder="Customer, application no or UTR"></div>
      <div><label>Status</label><select name="status"><option value="">All</option>
        ${PAYOUT_STATUSES.map((s) => html`<option value="${s}" ${status === s ? raw('selected') : ''}>${label(s)}</option>`)}</select></div>
      <div style="display:flex;align-items:flex-end;gap:8px"><button class="sm" type="submit">Apply</button>
        <a class="btn ghost sm" href="/payouts">Clear</a></div>
    </div></form>
    <div class="grid c3" style="margin-bottom:16px">
      <div class="stat"><b>&#8377;${rupees(totals!.g)}</b><span>Gross (filtered)</span></div>
      <div class="stat"><b>&#8377;${rupees(totals!.t)}</b><span>TDS (filtered)</span></div>
      <div class="stat"><b>&#8377;${rupees(totals!.n)}</b><span>Net (filtered)</span></div>
    </div>
    ${table(['Application', 'Customer', 'Partner', 'Insurer', 'Base', 'Payout %', 'Gross', 'TDS', 'Net', 'Status', 'UTR'],
      body, 'No payout records match.')}
    ${pager(ctx.url, p, count?.n ?? 0, PER_PAGE)}`,
  );
}, { cap: 'view_records' });

async function loadPayout(ctx: Ctx, id: string): Promise<PayoutRow | null> {
  const scope = visibilityScope(ctx);
  return ctx.env.DB.prepare(`${SELECT} WHERE p.id = ? AND ${scope.sql}`)
    .bind(id, ...scope.binds).first<PayoutRow>();
}

get('/payouts/:id', async (ctx) => {
  const p = await loadPayout(ctx, ctx.params.id);
  if (!p) return errorPage(ctx, 404, 'Payout not found, or not visible to your account.');
  const { results: events } = await ctx.env.DB.prepare(
    `SELECT ev.*, u.name AS actor_name FROM payout_events ev LEFT JOIN users u ON u.id = ev.actor
      WHERE ev.payout_id = ? ORDER BY ev.at DESC, ev.rowid DESC`,
  ).bind(p.id).all<{ action: string; at: string; actor_name: string | null; after_json: string | null }>();

  const mayApprove = can(ctx.user, 'approve_payouts', ctx.settings);
  const snap = p.rule_snapshot ? JSON.parse(p.rule_snapshot) as Record<string, unknown> : null;

  return page(
    { title: `Payout ${p.application_no}`, user: ctx.user, ctx, active: '/payouts' },
    html`<div class="pagehead"><div><h1>Payout</h1>
      <p>${p.application_no} · ${p.customer_name} · ${badge(p.status)}</p></div>
      <div class="actions"><a class="btn ghost sm" href="/applications/${p.application_id}">Open application</a></div></div>
    ${flashFromUrl(ctx.url)}
    <div class="split">
      <div>
        <div class="card"><h2>Calculation</h2>
          <dl class="kv">
            <dt>Base</dt><dd>&#8377;${rupees(p.base_paise)}</dd>
            <dt>Payout %</dt><dd>${(p.payout_bp / 100).toFixed(2)}%</dd>
            <dt>Gross payout</dt><dd>&#8377;${rupees(p.gross_paise)}</dd>
            <dt>TDS %</dt><dd>${(p.tds_bp / 100).toFixed(2)}%</dd>
            <dt>TDS amount</dt><dd>&#8377;${rupees(p.tds_paise)}</dd>
            <dt>Other deductions</dt><dd>&#8377;${rupees(p.deductions_paise)}</dd>
            <dt>Net payout</dt><dd><b>&#8377;${rupees(p.net_paise)}</b></dd>
            <dt>Rule applied</dt><dd>${snap ? html`<code>${String(snap.rule_id ?? 'settings default')}</code>` : '—'}</dd>
          </dl>
          ${mayApprove && ['not_initiated', 'pending'].includes(p.status)
            ? html`<hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
              <h3>Override before approval</h3>
              <form method="post" action="/payouts/${p.id}/recalc"><div class="row">
                <div class="field"><label>Payout %</label><input name="payout_pct" value="${(p.payout_bp / 100).toFixed(2)}" inputmode="decimal"></div>
                <div class="field"><label>TDS %</label><input name="tds_pct" value="${(p.tds_bp / 100).toFixed(2)}" inputmode="decimal"></div>
                <div class="field"><label>Other deductions (&#8377;)</label><input name="deductions" value="${rupees(p.deductions_paise).replace(/,/g, '')}" inputmode="decimal"></div>
              </div><button class="sm ghost" type="submit">Recalculate</button></form>`
            : ''}
        </div>

        ${mayApprove ? actionsCard(p) : html``}
      </div>

      <div>
        <div class="card"><h2>Context</h2>
          <dl class="kv">
            <dt>Category</dt><dd>${badge(p.category)}</dd>
            <dt>Policy status</dt><dd>${badge(p.app_status)}</dd>
            <dt>Policy No</dt><dd>${p.policy_no || '—'}</dd>
            <dt>Partner</dt><dd>${p.partner_name ?? '—'}</dd>
            <dt>Partner code</dt><dd>${p.partner_code ?? '—'}</dd>
            <dt>Insurer</dt><dd>${p.insurer_name ?? '—'}</dd>
            <dt>Employee</dt><dd>${p.employee_name ?? '—'}</dd>
            <dt>Paid on</dt><dd>${p.paid_date || '—'}</dd>
            <dt>UTR</dt><dd>${p.utr || '—'}</dd>
            <dt>Remarks</dt><dd>${p.remarks || '—'}</dd>
          </dl>
        </div>
        <div class="card"><h2>History</h2>
          <ul class="timeline">${events.map((e) => html`<li><b>${label(e.action)}</b>
            <small>${e.at} · ${e.actor_name ?? 'system'}</small></li>`)}</ul>
        </div>
      </div>
    </div>`,
  );
}, { cap: 'view_records' });

function actionsCard(p: PayoutRow) {
  return html`<div class="card"><h2>Approval and payment</h2>
    ${p.status === 'paid'
      ? html`<p class="sub">This payout is recorded as paid on ${p.paid_date} against UTR <code>${p.utr}</code>. Record a reversal if it needs correcting.</p>`
      : ''}
    <div class="actions">
      ${['pending', 'on_hold'].includes(p.status)
        ? html`<form method="post" action="/payouts/${p.id}/approve" class="inline"><button class="sm" type="submit">Approve</button></form>`
        : ''}
      ${p.status === 'approved'
        ? html`<form method="post" action="/payouts/${p.id}/status" class="inline">
            <input type="hidden" name="status" value="processing"><button class="sm ghost" type="submit">Mark processing</button></form>`
        : ''}
      ${['pending', 'approved'].includes(p.status)
        ? html`<form method="post" action="/payouts/${p.id}/status" class="inline">
            <input type="hidden" name="status" value="on_hold"><button class="sm ghost" type="submit">Put on hold</button></form>`
        : ''}
      ${p.status === 'paid'
        ? html`<form method="post" action="/payouts/${p.id}/status" class="inline"
                 onsubmit="return confirm('Record a reversal for this paid payout?')">
            <input type="hidden" name="status" value="reversed"><button class="sm danger" type="submit">Record reversal</button></form>`
        : ''}
    </div>
    ${['approved', 'processing'].includes(p.status)
      ? html`<hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
        <h3>Record payment</h3>
        <form method="post" action="/payouts/${p.id}/pay"><div class="row">
          <div class="field"><label>Payment date <span class="req">*</span></label><input type="date" name="paid_date" required></div>
          <div class="field"><label>Transaction reference / UTR <span class="req">*</span></label>
            <input name="utr" required maxlength="80"><small>Must be unique; a repeat blocks a duplicate payment.</small></div>
          <div class="field"><label>Remarks</label><input name="remarks" maxlength="300"></div>
        </div><button class="sm" type="submit">Mark paid</button></form>`
      : ''}
  </div>`;
}

post('/payouts/:id/recalc', async (ctx) => {
  const p = await loadPayout(ctx, ctx.params.id);
  if (!p) return errorPage(ctx, 404, 'Payout not found.');
  if (!['not_initiated', 'pending'].includes(p.status)) {
    return flash(`/payouts/${p.id}`, 'err', 'An approved payout cannot be recalculated. Reverse it instead.');
  }
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  let payoutBp: number, tdsBp: number, deductions: number;
  try {
    payoutBp = pctToBp(form.payout_pct ?? '0');
    tdsBp = pctToBp(form.tds_pct ?? '0');
    deductions = paise(form.deductions ?? '0');
  } catch (e) {
    return flash(`/payouts/${p.id}`, 'err', e instanceof Error ? e.message : 'Invalid number.');
  }
  const r = computePayout({ basePaise: p.base_paise, payoutBp, tdsBp, deductionsPaise: deductions });
  const status = payoutBp === 0 ? 'not_initiated' : 'pending';

  await ctx.env.DB.prepare(
    `UPDATE payouts SET payout_bp=?, gross_paise=?, tds_bp=?, tds_paise=?, deductions_paise=?,
       net_paise=?, status=?, rule_snapshot=?, updated_at=datetime('now') WHERE id=?`,
  ).bind(payoutBp, r.grossPaise, tdsBp, r.tdsPaise, deductions, r.netPaise, status,
    JSON.stringify({ rule_id: 'manual_override', payoutBp, tdsBp, by: ctx.user!.id, at: new Date().toISOString() }), p.id).run();
  await logEvent(ctx, p.id, 'recalculate',
    { payout_bp: p.payout_bp, tds_bp: p.tds_bp, net_paise: p.net_paise },
    { payout_bp: payoutBp, tds_bp: tdsBp, net_paise: r.netPaise });
  return flash(`/payouts/${p.id}`, 'ok', 'Payout recalculated.');
}, { cap: 'approve_payouts' });

post('/payouts/:id/approve', async (ctx) => {
  const p = await loadPayout(ctx, ctx.params.id);
  if (!p) return errorPage(ctx, 404, 'Payout not found.');
  if (!['pending', 'on_hold'].includes(p.status)) {
    return flash(`/payouts/${p.id}`, 'err', `A payout in ${label(p.status)} cannot be approved.`);
  }
  if (p.net_paise <= 0) return flash(`/payouts/${p.id}`, 'err', 'Net payout is zero; set a payout percentage first.');
  await ctx.env.DB.prepare("UPDATE payouts SET status='approved', updated_at=datetime('now') WHERE id=?").bind(p.id).run();
  await logEvent(ctx, p.id, 'approve', { status: p.status }, { status: 'approved', net_paise: p.net_paise });
  return flash(`/payouts/${p.id}`, 'ok', 'Payout approved.');
}, { cap: 'approve_payouts' });

post('/payouts/:id/status', async (ctx) => {
  const p = await loadPayout(ctx, ctx.params.id);
  if (!p) return errorPage(ctx, 404, 'Payout not found.');
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const to = String(form.status ?? '') as PayoutStatus;
  const legal: Partial<Record<PayoutStatus, PayoutStatus[]>> = {
    pending: ['on_hold'],
    approved: ['processing', 'on_hold'],
    on_hold: ['pending'],
    paid: ['reversed'],
  };
  if (!legal[p.status]?.includes(to)) {
    return flash(`/payouts/${p.id}`, 'err', `${label(p.status)} → ${label(to)} is not a permitted payout transition.`);
  }
  // A reversal frees the UTR so a corrected payment can be recorded.
  const clearUtr = to === 'reversed';
  await ctx.env.DB.prepare(
    `UPDATE payouts SET status=?, utr=${clearUtr ? 'NULL' : 'utr'}, updated_at=datetime('now') WHERE id=?`,
  ).bind(to, p.id).run();
  await logEvent(ctx, p.id, `status.${to}`, { status: p.status, utr: p.utr }, { status: to });
  return flash(`/payouts/${p.id}`, 'ok', `Payout moved to ${label(to)}.`);
}, { cap: 'approve_payouts' });

post('/payouts/:id/pay', async (ctx) => {
  const p = await loadPayout(ctx, ctx.params.id);
  if (!p) return errorPage(ctx, 404, 'Payout not found.');
  if (!['approved', 'processing'].includes(p.status)) {
    return flash(`/payouts/${p.id}`, 'err', 'Only an approved payout can be marked paid.');
  }
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const paid_date = String(form.paid_date ?? '').trim();
  const utr = String(form.utr ?? '').trim();
  const remarks = String(form.remarks ?? '').trim().slice(0, 300) || null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_date)) return flash(`/payouts/${p.id}`, 'err', 'A valid payment date is required.');
  if (!utr) return flash(`/payouts/${p.id}`, 'err', 'A transaction reference / UTR is required.');

  try {
    await ctx.env.DB.prepare(
      "UPDATE payouts SET status='paid', paid_date=?, utr=?, remarks=?, updated_at=datetime('now') WHERE id=?",
    ).bind(paid_date, utr, remarks, p.id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return flash(`/payouts/${p.id}`, 'err', 'That UTR is already recorded against another payout. Duplicate payment refused.');
    }
    throw e;
  }
  await logEvent(ctx, p.id, 'pay', { status: p.status }, { status: 'paid', paid_date, utr, net_paise: p.net_paise });
  return flash(`/payouts/${p.id}`, 'ok', 'Payment recorded.');
}, { cap: 'approve_payouts' });

async function logEvent(ctx: Ctx, payoutId: string, action: string, before?: unknown, after?: unknown) {
  await ctx.env.DB.prepare(
    'INSERT INTO payout_events (id, payout_id, action, actor, before_json, after_json) VALUES (?,?,?,?,?,?)',
  ).bind(randomId('pe_'), payoutId, action, ctx.user!.id,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null).run();
  await audit(ctx, `payout.${action}`, 'payouts', payoutId, before, after);
}

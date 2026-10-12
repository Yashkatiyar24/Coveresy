import { get, post } from '../router.ts';
import { html } from '../html.ts';
import { badge, errorPage, flash, flashFromUrl, numh, page, pager, table } from '../ui.ts';
import { audit } from '../audit.ts';
import { randomId } from '../auth.ts';
import { masters, visibilityScope } from '../db.ts';
import { buildFilter, loadApp, orderBy, recalcPayout, syncDocState } from '../service.ts';
import { Money, paise, rupees } from '../payout.ts';
import { parseCsv, toCsv } from '../csv.ts';
import { toXlsx } from '../xlsx.ts';
import { label } from '../types.ts';
import type { Ctx } from '../types.ts';

/* --------------------------------------------------------------- reports --- */

get('/reports', async (ctx) => {
  const f = buildFilter(ctx);
  const q = (sql: string) => ctx.env.DB.prepare(sql.replace('{W}', f.sql)).bind(...f.binds).all();

  const [byInsurer, byBroker, byPartner, byEmployee, byMonth] = await Promise.all([
    q(`SELECT i.name AS k, COUNT(*) n, SUM(a.status='policy_issued') issued,
              COALESCE(SUM(a.premium_paise),0) premium, COALESCE(SUM(p.gross_paise),0) gross,
              COALESCE(SUM(p.tds_paise),0) tds, COALESCE(SUM(p.net_paise),0) net
         FROM applications a LEFT JOIN insurers i ON i.id=a.insurer_id
         LEFT JOIN payouts p ON p.application_id=a.id WHERE {W} GROUP BY i.id ORDER BY n DESC`),
    q(`SELECT b.name AS k, COUNT(*) n, SUM(a.status='policy_issued') issued,
              COALESCE(SUM(a.premium_paise),0) premium, COALESCE(SUM(p.net_paise),0) net
         FROM applications a LEFT JOIN brokers b ON b.id=a.broker_id
         LEFT JOIN payouts p ON p.application_id=a.id WHERE {W} AND a.broker_id IS NOT NULL GROUP BY b.id ORDER BY n DESC`),
    q(`SELECT pa.name AS k, pa.partner_code AS code, COUNT(*) n, SUM(a.status='policy_issued') issued,
              COALESCE(SUM(a.premium_paise),0) premium, COALESCE(SUM(p.gross_paise),0) gross,
              COALESCE(SUM(p.tds_paise),0) tds, COALESCE(SUM(p.net_paise),0) net,
              COALESCE(SUM(CASE WHEN p.status='paid' THEN p.net_paise ELSE 0 END),0) paid
         FROM applications a LEFT JOIN partners pa ON pa.id=a.partner_id
         LEFT JOIN payouts p ON p.application_id=a.id WHERE {W} AND a.partner_id IS NOT NULL GROUP BY pa.id ORDER BY net DESC`),
    q(`SELECT e.name AS k, COUNT(*) n, SUM(a.status='policy_issued') issued,
              COALESCE(SUM(a.premium_paise),0) premium
         FROM applications a LEFT JOIN employees e ON e.id=a.employee_id
        WHERE {W} AND a.employee_id IS NOT NULL GROUP BY e.id ORDER BY n DESC`),
    q(`SELECT substr(COALESCE(a.login_date,a.created_at),1,7) AS k, COUNT(*) n,
              SUM(a.status='policy_issued') issued, COALESCE(SUM(a.premium_paise),0) premium
         FROM applications a WHERE {W} GROUP BY k ORDER BY k DESC`),
  ]);

  type R = Record<string, number | string | null>;
  const money = (v: unknown) => html`<td class="num">&#8377;${rupees(Number(v ?? 0))}</td>`;
  const sec = (title: string, headers: unknown[], rows: unknown[], render: (r: R) => ReturnType<typeof html>) =>
    html`<div class="card"><h2>${title}</h2>${table(headers, (rows as R[]).map(render), 'No data under these filters.')}</div>`;

  return page(
    { title: 'Reports', user: ctx.user, ctx, active: '/reports', wide: true },
    html`<div class="pagehead"><div><h1>Reports &amp; Exports</h1>
      <p>Aggregates over the same filtered record set the Policy MIS uses. Exports respect these filters and your role.</p></div>
      <div class="actions">
        <a class="btn ghost sm" href="/export?kind=applications${ctx.url.search.replace('?', '&')}">Applications CSV</a>
        <a class="btn ghost sm" href="/export?kind=payouts${ctx.url.search.replace('?', '&')}">Payouts CSV</a>
        <a class="btn ghost sm" href="/export?kind=partner_summary${ctx.url.search.replace('?', '&')}">Partner summary CSV</a>
        <a class="btn ghost sm" href="/export?format=xlsx&kind=applications${ctx.url.search.replace('?', '&')}">Applications XLSX</a>
        <a class="btn ghost sm" href="/export?format=xlsx&kind=payouts${ctx.url.search.replace('?', '&')}">Payouts XLSX</a>
      </div></div>
    ${flashFromUrl(ctx.url)}
    <p class="sub">Filter on the <a href="/applications">Policy MIS</a> page, then return here — the query string carries over.</p>
    ${sec('Insurer-wise', ['Insurer', ...['Apps', 'Issued', 'Premium', 'Gross', 'TDS', 'Net'].map(numh)], byInsurer.results,
      (r) => html`<tr><td>${r.k ?? '—'}</td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>
        ${money(r.premium)}${money(r.gross)}${money(r.tds)}${money(r.net)}</tr>`)}
    ${sec('Partner-wise', ['Partner', 'Code', ...['Apps', 'Issued', 'Premium', 'Gross', 'TDS', 'Net', 'Paid'].map(numh)], byPartner.results,
      (r) => html`<tr><td>${r.k}</td><td><code>${r.code}</code></td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>
        ${money(r.premium)}${money(r.gross)}${money(r.tds)}${money(r.net)}${money(r.paid)}</tr>`)}
    ${sec('Broker-wise', ['Broker', ...['Apps', 'Issued', 'Premium', 'Net payout'].map(numh)], byBroker.results,
      (r) => html`<tr><td>${r.k}</td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>${money(r.premium)}${money(r.net)}</tr>`)}
    ${sec('Employee-wise', ['Employee', ...['Apps', 'Issued', 'Premium'].map(numh)], byEmployee.results,
      (r) => html`<tr><td>${r.k}</td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>${money(r.premium)}</tr>`)}
    ${sec('Monthly login and issuance', ['Month', ...['Logged', 'Issued', 'Premium'].map(numh)], byMonth.results,
      (r) => html`<tr><td>${r.k ?? '—'}</td><td class="num">${r.n}</td><td class="num">${r.issued ?? 0}</td>${money(r.premium)}</tr>`)}`,
  );
}, { cap: 'view_records' });

/* ---------------------------------------------------------------- export --- */

get('/export', async (ctx) => {
  const kind = ctx.url.searchParams.get('kind') ?? 'applications';
  const f = buildFilter(ctx);
  let headers: string[] = [];
  let rows: unknown[][] = [];
  let name = kind;

  if (kind === 'applications') {
    const { results } = await ctx.env.DB.prepare(
      `SELECT a.*, i.name insurer_name, b.name broker_name, pa.name partner_name, pa.partner_code,
              e.name employee_name, pr.name product, u.name assigned_name,
              po.status payout_status, po.gross_paise, po.tds_paise, po.net_paise, po.paid_date, po.utr,
              (SELECT status FROM application_documents d WHERE d.application_id=a.id AND d.doc_type='policy_copy' AND d.is_current=1) policy_copy_status,
              (SELECT status FROM application_documents d WHERE d.application_id=a.id AND d.doc_type='proposal_form' AND d.is_current=1) proposal_form_status,
              (SELECT status FROM application_documents d WHERE d.application_id=a.id AND d.doc_type='payment_receipt' AND d.is_current=1) payment_receipt_status,
              (SELECT MAX(uploaded_at) FROM application_documents d WHERE d.application_id=a.id) last_doc_at,
              (SELECT u2.name FROM application_documents d JOIN users u2 ON u2.id=d.uploaded_by
                 WHERE d.application_id=a.id ORDER BY d.uploaded_at DESC LIMIT 1) last_doc_by
         FROM applications a
         LEFT JOIN insurers i ON i.id=a.insurer_id LEFT JOIN brokers b ON b.id=a.broker_id
         LEFT JOIN partners pa ON pa.id=a.partner_id LEFT JOIN employees e ON e.id=a.employee_id
         LEFT JOIN products pr ON pr.id=a.product_id LEFT JOIN users u ON u.id=a.assigned_user_id
         LEFT JOIN payouts po ON po.application_id=a.id
        WHERE ${f.sql} ORDER BY ${orderBy(ctx)} LIMIT 20000`,
    ).bind(...f.binds).all<Record<string, unknown>>();

    headers = ['Internal Record ID', 'Insurance Category', 'Product/Plan Name', 'Login Date', 'Application Number',
      'Policy Number', 'Customer Name', 'Premium Amount', 'Policy Status', 'Policy Issued Date', 'Policy Term',
      'Premium Payment Frequency', 'Insurer', 'Insurer Representative', 'Broker Name', 'Partner Name', 'Partner Code',
      'Employee Name', 'Assigned Operations User', 'Gross Partner Payout', 'Payout Percentage', 'TDS Percentage',
      'TDS Amount', 'Net Payout', 'Payout Status', 'Payout Date', 'Transaction Reference/UTR',
      'Policy Copy Status', 'Proposal Form Status', 'Payment Receipt Status', 'Mandatory Documents Completion Status',
      'Overall Document Verification Status', 'Last Document Updated At', 'Last Document Updated By'];
    rows = results.map((a) => [
      a.id, label(String(a.category)), a.product_name || a.product || '', a.login_date ?? '', a.application_no,
      a.policy_no ?? '', a.customer_name, new Money(Number(a.premium_paise)), label(String(a.status)), a.issued_date ?? '',
      a.policy_term ?? '', a.premium_frequency ?? '', a.insurer_name ?? '', a.insurer_rep_name ?? '', a.broker_name ?? '',
      a.partner_name ?? '', a.partner_code ?? '', a.employee_name ?? '', a.assigned_name ?? '',
      a.gross_paise != null ? new Money(Number(a.gross_paise)) : '', '', '',
      a.tds_paise != null ? new Money(Number(a.tds_paise)) : '', a.net_paise != null ? new Money(Number(a.net_paise)) : '',
      a.payout_status ? label(String(a.payout_status)) : '', a.paid_date ?? '', a.utr ?? '',
      a.policy_copy_status ? label(String(a.policy_copy_status)) : 'Missing',
      a.proposal_form_status ? label(String(a.proposal_form_status)) : 'Missing',
      a.payment_receipt_status ? label(String(a.payment_receipt_status)) : 'Missing',
      ['verified', 'pending_verification'].includes(String(a.doc_overall_status)) ? 'Complete' : 'Incomplete',
      label(String(a.doc_overall_status)), a.last_doc_at ?? '', a.last_doc_by ?? '',
    ]);
  } else if (kind === 'payouts') {
    const scope = visibilityScope(ctx);
    const { results } = await ctx.env.DB.prepare(
      `SELECT p.*, a.application_no, a.customer_name, a.policy_no, a.category,
              pa.name partner_name, pa.partner_code, i.name insurer_name, e.name employee_name
         FROM payouts p JOIN applications a ON a.id=p.application_id
         LEFT JOIN partners pa ON pa.id=a.partner_id LEFT JOIN insurers i ON i.id=a.insurer_id
         LEFT JOIN employees e ON e.id=a.employee_id
        WHERE ${scope.sql} ORDER BY p.updated_at DESC LIMIT 20000`,
    ).bind(...scope.binds).all<Record<string, unknown>>();
    headers = ['Application Number', 'Customer Name', 'Policy Number', 'Category', 'Partner', 'Partner Code',
      'Insurer', 'Employee', 'Base', 'Payout %', 'Gross Payout', 'TDS %', 'TDS Amount', 'Deductions',
      'Net Payout', 'Payout Status', 'Payment Date', 'UTR', 'Remarks'];
    rows = results.map((p) => [
      p.application_no, p.customer_name, p.policy_no ?? '', label(String(p.category)), p.partner_name ?? '',
      p.partner_code ?? '', p.insurer_name ?? '', p.employee_name ?? '', new Money(Number(p.base_paise)),
      Number(p.payout_bp) / 100, new Money(Number(p.gross_paise)), Number(p.tds_bp) / 100,
      new Money(Number(p.tds_paise)), new Money(Number(p.deductions_paise)), new Money(Number(p.net_paise)),
      label(String(p.status)), p.paid_date ?? '', p.utr ?? '', p.remarks ?? '',
    ]);
  } else if (kind === 'partner_summary') {
    const { results } = await ctx.env.DB.prepare(
      `SELECT pa.name k, pa.partner_code code, COUNT(*) n, SUM(a.status='policy_issued') issued,
              COALESCE(SUM(a.premium_paise),0) premium, COALESCE(SUM(p.gross_paise),0) gross,
              COALESCE(SUM(p.tds_paise),0) tds, COALESCE(SUM(p.net_paise),0) net,
              COALESCE(SUM(CASE WHEN p.status='paid' THEN p.net_paise ELSE 0 END),0) paid
         FROM applications a JOIN partners pa ON pa.id=a.partner_id
         LEFT JOIN payouts p ON p.application_id=a.id
        WHERE ${f.sql} GROUP BY pa.id ORDER BY net DESC`,
    ).bind(...f.binds).all<Record<string, unknown>>();
    headers = ['Partner', 'Partner Code', 'Applications', 'Policies Issued', 'Premium', 'Gross Payout', 'TDS', 'Net Payout', 'Paid'];
    rows = results.map((r) => [r.k, r.code, Number(r.n), Number(r.issued ?? 0), new Money(Number(r.premium)),
      new Money(Number(r.gross)), new Money(Number(r.tds)), new Money(Number(r.net)), new Money(Number(r.paid))]);
  } else {
    return errorPage(ctx, 400, 'Unknown export kind.');
  }

  // Section 13: exports are logged. Row count only, never the exported contents.
  await audit(ctx, 'export', kind, null, undefined, {
    rows: rows.length,
    format: ctx.url.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv',
    filters: ctx.url.search,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `coveresy-${name}-${stamp}`;

  if (ctx.url.searchParams.get('format') === 'xlsx') {
    const book = toXlsx(name.slice(0, 31), headers, rows);
    return new Response(book, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  return new Response(toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
}, { cap: 'export' });

/* ---------------------------------------------------------------- import --- */

const IMPORT_COLUMNS = ['category', 'application_no', 'customer_name', 'insurer', 'premium',
  'login_date', 'policy_no', 'policy_term', 'premium_frequency', 'broker', 'partner_code', 'employee', 'product'];

get('/imports', async (ctx) => {
  const { results } = await ctx.env.DB.prepare(
    `SELECT im.*, u.name uploader_name FROM imports im LEFT JOIN users u ON u.id=im.uploader
      ORDER BY im.created_at DESC LIMIT 25`,
  ).all<{ id: string; file_name: string; uploader_name: string | null; status: string; rows_total: number; rows_ok: number; rows_failed: number; created_at: string }>();

  return page(
    { title: 'Import', user: ctx.user, ctx, active: '/reports' },
    html`<div class="pagehead"><div><h1>Import applications</h1>
      <p>CSV only, previewed before anything is written. Rows are never silently dropped.</p></div></div>
    ${flashFromUrl(ctx.url)}
    <div class="flash err" style="background:var(--warn-bg);border-color:#efd9a3;color:var(--warn)">
      <b>An import never marks a document as uploaded (§15).</b> Files must be attached through the
      application's Documents panel, where the type and contents are checked.</div>
    <div class="card"><h2>Upload a CSV</h2>
      <form method="post" action="/imports/preview" enctype="multipart/form-data">
        <div class="field"><label>CSV file</label><input type="file" name="file" accept=".csv,text/csv" required></div>
        <button type="submit">Preview</button>
      </form>
      <h3 style="margin-top:20px">Required column headers</h3>
      <p class="sub"><code>${IMPORT_COLUMNS.join('</code>, <code>')}</code></p>
      <p class="sub"><b>category</b> is health or life. <b>insurer</b>, <b>broker</b>, <b>employee</b> and
        <b>product</b> match on name; <b>partner_code</b> matches a partner code. <b>premium</b> is in rupees.
        Unknown master-data names are reported as errors rather than created.</p>
    </div>
    <div class="card"><h2>Recent imports</h2>
      ${table(['File', 'By', 'Status', numh('Rows'), numh('OK'), numh('Failed'), 'When'], results.map((im) => html`<tr>
        <td><a href="/imports/${im.id}">${im.file_name}</a></td><td>${im.uploader_name ?? '—'}</td>
        <td>${badge(im.status)}</td><td class="num">${im.rows_total}</td><td class="num">${im.rows_ok}</td>
        <td class="num">${im.rows_failed}</td><td>${im.created_at}</td></tr>`), 'No imports yet.')}</div>`,
  );
}, { cap: 'import' });

interface ParsedRow { row: number; data: Record<string, string>; errors: Array<{ field: string; message: string }> }

async function validateRows(ctx: Ctx, rows: string[][]): Promise<{ parsed: ParsedRow[]; header: string[] }> {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const m = await masters(ctx.env);
  const seen = new Set<string>();

  const existing = new Set(
    (await ctx.env.DB.prepare('SELECT insurer_id || "|" || application_no AS k FROM applications').all<{ k: string }>())
      .results.map((r) => r.k),
  );

  const parsed: ParsedRow[] = rows.slice(1).map((cells, i) => {
    const data: Record<string, string> = {};
    header.forEach((h, j) => { data[h] = (cells[j] ?? '').trim(); });
    const errors: Array<{ field: string; message: string }> = [];
    const need = (f: string) => { if (!data[f]) errors.push({ field: f, message: `${f} is required` }); };

    need('category'); need('application_no'); need('customer_name'); need('insurer');
    if (data.category && !['health', 'life'].includes(data.category.toLowerCase())) {
      errors.push({ field: 'category', message: 'must be health or life' });
    }
    const insurer = m.insurers.find((x) => x.name.toLowerCase() === data.insurer?.toLowerCase());
    if (data.insurer && !insurer) errors.push({ field: 'insurer', message: `unknown insurer "${data.insurer}"` });
    if (data.broker && !m.brokers.find((x) => x.name.toLowerCase() === data.broker.toLowerCase())) {
      errors.push({ field: 'broker', message: `unknown broker "${data.broker}"` });
    }
    if (data.employee && !m.employees.find((x) => x.name.toLowerCase() === data.employee.toLowerCase())) {
      errors.push({ field: 'employee', message: `unknown employee "${data.employee}"` });
    }
    if (data.partner_code && !m.partners.find((x) => String(x.partner_code).toLowerCase() === data.partner_code.toLowerCase())) {
      errors.push({ field: 'partner_code', message: `unknown partner code "${data.partner_code}"` });
    }
    if (data.premium) { try { paise(data.premium); } catch { errors.push({ field: 'premium', message: 'not a valid amount' }); } }
    for (const f of ['login_date', 'policy_no'] as const) {
      if (f === 'login_date' && data[f] && !/^\d{4}-\d{2}-\d{2}$/.test(data[f])) {
        errors.push({ field: f, message: 'must be YYYY-MM-DD' });
      }
    }
    if (insurer && data.application_no) {
      const key = `${insurer.id}|${data.application_no}`;
      if (existing.has(key)) errors.push({ field: 'application_no', message: 'already exists for this insurer' });
      if (seen.has(key)) errors.push({ field: 'application_no', message: 'duplicated within this file' });
      seen.add(key);
    }
    return { row: i + 2, data, errors };
  });
  return { parsed, header };
}

post('/imports/preview', async (ctx) => {
  const form = await ctx.req.formData();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return flash('/imports', 'err', 'Choose a CSV file.');
  if (file.size > 5 * 1024 * 1024) return flash('/imports', 'err', 'Import files are limited to 5 MB.');

  const rows = parseCsv(await file.text());
  if (rows.length < 2) return flash('/imports', 'err', 'The file has a header but no data rows.');

  const { parsed } = await validateRows(ctx, rows);
  const ok = parsed.filter((p) => !p.errors.length);
  const bad = parsed.filter((p) => p.errors.length);

  const id = randomId('imp_');
  await ctx.env.DB.prepare(
    `INSERT INTO imports (id, file_name, uploader, status, rows_total, rows_ok, rows_failed, payload)
     VALUES (?,?,?,'preview',?,?,?,?)`,
  ).bind(id, file.name.slice(0, 200), ctx.user!.id, parsed.length, ok.length, bad.length,
    JSON.stringify(ok.map((p) => p.data))).run();

  if (bad.length) {
    await ctx.env.DB.batch(bad.flatMap((p) => p.errors.map((e) =>
      ctx.env.DB.prepare('INSERT INTO import_errors (id, import_id, row_number, field, message) VALUES (?,?,?,?,?)')
        .bind(randomId('ie_'), id, p.row, e.field, e.message))));
  }
  await audit(ctx, 'import.preview', 'imports', id, undefined, { file: file.name, total: parsed.length, ok: ok.length, failed: bad.length });
  return flash(`/imports/${id}`, 'ok', `Previewed ${parsed.length} rows: ${ok.length} valid, ${bad.length} with errors.`);
}, { cap: 'import' });

get('/imports/:id', async (ctx) => {
  const im = await ctx.env.DB.prepare('SELECT * FROM imports WHERE id = ?').bind(ctx.params.id)
    .first<{ id: string; file_name: string; status: string; rows_total: number; rows_ok: number; rows_failed: number; payload: string | null }>();
  if (!im) return errorPage(ctx, 404, 'Import not found.');
  const { results: errs } = await ctx.env.DB.prepare(
    'SELECT * FROM import_errors WHERE import_id = ? ORDER BY row_number LIMIT 500',
  ).bind(im.id).all<{ row_number: number; field: string | null; message: string }>();

  return page(
    { title: 'Import preview', user: ctx.user, ctx, active: '/reports', wide: true },
    html`<div class="pagehead"><div><h1>${im.file_name}</h1>
      <p>${badge(im.status)} · ${im.rows_total} rows · ${im.rows_ok} valid · ${im.rows_failed} with errors</p></div>
      <div class="actions"><a class="btn ghost sm" href="/imports/${im.id}/errors.csv">Download error report</a>
      <a class="btn ghost sm" href="/imports">All imports</a></div></div>
    ${flashFromUrl(ctx.url)}
    ${im.status === 'preview' && im.rows_ok > 0
      ? html`<div class="card"><h2>Commit</h2>
          <p class="sub">${im.rows_ok} valid rows will be created as Draft applications. The ${im.rows_failed} rows
            with errors are not imported; fix them and upload again.</p>
          <form method="post" action="/imports/${im.id}/commit"
            onsubmit="return confirm('Create ${im.rows_ok} applications?')">
            <button type="submit">Commit ${im.rows_ok} rows</button></form></div>`
      : ''}
    ${im.status === 'committed' ? html`<div class="flash ok">This import has already been committed.</div>` : ''}
    <div class="card"><h2>Row errors</h2>
      ${table([numh('Row'), 'Field', 'Problem'], errs.map((e) => html`<tr>
        <td class="num">${e.row_number}</td><td><code>${e.field ?? '—'}</code></td><td>${e.message}</td></tr>`),
        'No row errors.')}</div>`,
  );
}, { cap: 'import' });

get('/imports/:id/errors.csv', async (ctx) => {
  const { results } = await ctx.env.DB.prepare(
    'SELECT row_number, field, message FROM import_errors WHERE import_id = ? ORDER BY row_number',
  ).bind(ctx.params.id).all<{ row_number: number; field: string | null; message: string }>();
  return new Response(toCsv(['Row', 'Field', 'Problem'], results.map((r) => [r.row_number, r.field ?? '', r.message])), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="import-errors-${ctx.params.id}.csv"`,
    },
  });
}, { cap: 'import' });

post('/imports/:id/commit', async (ctx) => {
  const im = await ctx.env.DB.prepare('SELECT * FROM imports WHERE id = ?').bind(ctx.params.id)
    .first<{ id: string; status: string; payload: string | null; rows_ok: number }>();
  if (!im) return errorPage(ctx, 404, 'Import not found.');
  if (im.status !== 'preview') return flash(`/imports/${im.id}`, 'err', 'This import was already committed.');

  const m = await masters(ctx.env);
  const rows = JSON.parse(im.payload ?? '[]') as Array<Record<string, string>>;
  const find = (list: Array<{ id: string; name: string }>, name: string) =>
    list.find((x) => x.name.toLowerCase() === (name ?? '').toLowerCase())?.id ?? null;

  const created: string[] = [];
  const failed: Array<{ row: number; message: string }> = [];

  for (const [i, r] of rows.entries()) {
    const insurerId = find(m.insurers, r.insurer);
    if (!insurerId) { failed.push({ row: i + 2, message: 'insurer no longer exists' }); continue; }
    const id = randomId('app_');
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO applications (id, category, product_name, login_date, application_no, policy_no,
           customer_name, premium_paise, status, policy_term, premium_frequency, insurer_id, broker_id,
           partner_id, employee_id, doc_overall_status, created_by)
         VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,'incomplete',?)`,
      ).bind(id, r.category.toLowerCase(), r.product || null, r.login_date || null, r.application_no,
        r.policy_no || null, r.customer_name, r.premium ? paise(r.premium) : 0, r.policy_term || null,
        r.premium_frequency || null, insurerId, find(m.brokers, r.broker),
        m.partners.find((p) => String(p.partner_code).toLowerCase() === (r.partner_code ?? '').toLowerCase())?.id ?? null,
        find(m.employees, r.employee), ctx.user!.id).run();
      await ctx.env.DB.prepare(
        "INSERT INTO status_history (id, application_id, from_status, to_status, actor, remark) VALUES (?,?,NULL,'draft',?,'Created by import')",
      ).bind(randomId('sh_'), id, ctx.user!.id).run();
      // Document state is recomputed from real attachments, which an import never creates.
      await syncDocState(ctx, id);
      await recalcPayout(ctx, id);
      created.push(id);
    } catch (e) {
      failed.push({ row: i + 2, message: String(e).includes('UNIQUE') ? 'duplicate application number' : 'insert failed' });
    }
  }

  if (failed.length) {
    await ctx.env.DB.batch(failed.map((fr) =>
      ctx.env.DB.prepare('INSERT INTO import_errors (id, import_id, row_number, field, message) VALUES (?,?,?,?,?)')
        .bind(randomId('ie_'), im.id, fr.row, 'commit', fr.message)));
  }
  await ctx.env.DB.prepare('UPDATE imports SET status=?, rows_ok=?, rows_failed=rows_failed+?, payload=NULL WHERE id=?')
    .bind('committed', created.length, failed.length, im.id).run();
  await audit(ctx, 'import.commit', 'imports', im.id, undefined, { created: created.length, failed: failed.length });

  return flash(`/imports/${im.id}`, 'ok', `${created.length} applications created${failed.length ? `, ${failed.length} failed` : ''}. Documents still need attaching individually.`);
}, { cap: 'import' });

/* ------------------------------------------------------------ audit logs --- */

get('/audit-logs', async (ctx) => {
  const p = Math.max(1, Number(ctx.url.searchParams.get('page') ?? 1) || 1);
  const perPage = 50;
  const where: string[] = ['1=1'];
  const binds: unknown[] = [];
  const action = ctx.url.searchParams.get('action');
  if (action) { where.push('l.action LIKE ?'); binds.push(`${action}%`); }
  const entityId = ctx.url.searchParams.get('entity_id');
  if (entityId) { where.push('l.entity_id = ?'); binds.push(entityId); }
  const w = where.join(' AND ');

  const [count, { results }] = await Promise.all([
    ctx.env.DB.prepare(`SELECT COUNT(*) n FROM audit_logs l WHERE ${w}`).bind(...binds).first<{ n: number }>(),
    ctx.env.DB.prepare(
      `SELECT l.*, u.name actor_name FROM audit_logs l LEFT JOIN users u ON u.id=l.actor
        WHERE ${w} ORDER BY l.at DESC, l.rowid DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, perPage, (p - 1) * perPage)
      .all<{ at: string; actor_name: string | null; action: string; entity: string | null; entity_id: string | null; before_json: string | null; after_json: string | null; ip: string | null }>(),
  ]);

  const prefixes = ['auth', 'application', 'document', 'payout', 'user', 'settings', 'rule', 'master', 'export', 'import', 'setup'];
  return page(
    { title: 'Audit logs', user: ctx.user, ctx, active: '/audit-logs', wide: true },
    html`<div class="pagehead"><div><h1>Audit Logs</h1>
      <p>Every login, record change, document action, payout decision, export and import. Passwords, tokens and file contents are never recorded.</p></div></div>
    <form class="filters" method="get"><div class="row">
      <div><label>Action</label><select name="action"><option value="">All</option>
        ${prefixes.map((a) => html`<option value="${a}" ${action === a ? html`selected` : ''}>${label(a)}</option>`)}</select></div>
      <div><label>Record ID</label><input name="entity_id" value="${entityId ?? ''}" placeholder="app_..."></div>
      <div style="display:flex;align-items:flex-end;gap:8px"><button class="sm" type="submit">Apply</button>
        <a class="btn ghost sm" href="/audit-logs">Clear</a></div>
    </div></form>
    ${table(['When', 'Actor', 'Action', 'Entity', 'Record', 'Before', 'After', 'IP'], results.map((l) => html`<tr>
      <td>${l.at}</td><td>${l.actor_name ?? 'system'}</td><td><code>${l.action}</code></td>
      <td>${l.entity ?? '—'}</td><td>${l.entity_id ? html`<code>${l.entity_id}</code>` : '—'}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis"><small>${l.before_json ?? ''}</small></td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis"><small>${l.after_json ?? ''}</small></td>
      <td>${l.ip ?? '—'}</td></tr>`), 'No audit entries yet.')}
    ${pager(ctx.url, p, count?.n ?? 0, perPage)}`,
  );
}, { cap: 'audit_logs' });

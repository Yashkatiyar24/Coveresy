import { z } from 'zod';
import { get, post } from '../router.ts';
import { html, raw } from '../html.ts';
import { badge, errorPage, flash, flashFromUrl, page, table } from '../ui.ts';
import { audit } from '../audit.ts';
import { hashPassword, randomId } from '../auth.ts';
import { masters } from '../db.ts';
import { bpToPct, pctToBp, rupees } from '../payout.ts';
import { DOC_LABELS, DOC_TYPES, label } from '../types.ts';
import type { Ctx } from '../types.ts';

/* ----------------------------------------------------------- master data --- */

const TABS = [
  { key: 'insurers', title: 'Insurers' },
  { key: 'brokers', title: 'Brokers' },
  { key: 'partners', title: 'Partners' },
  { key: 'employees', title: 'Employees' },
  { key: 'products', title: 'Products / Plans' },
  { key: 'payout_rules', title: 'Payout Rules' },
  { key: 'document_rules', title: 'Document Rules' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function tabNav(active: TabKey) {
  return html`<div class="actions" style="margin-bottom:18px">
    ${TABS.map((t) => html`<a class="btn ${t.key === active ? '' : 'ghost'} sm" href="/masters?tab=${t.key}">${t.title}</a>`)}
  </div>`;
}

get('/masters', async (ctx) => {
  const tab = (ctx.url.searchParams.get('tab') ?? 'insurers') as TabKey;
  if (!TABS.some((t) => t.key === tab)) return errorPage(ctx, 404, 'Unknown master data section.');
  const m = await masters(ctx.env);

  const body =
    tab === 'products' ? await productsTab(ctx, m)
    : tab === 'payout_rules' ? await payoutRulesTab(ctx, m)
    : tab === 'document_rules' ? await documentRulesTab(ctx)
    : await simpleTab(ctx, tab);

  return page(
    { title: 'Master data', user: ctx.user, ctx, active: '/masters', wide: true },
    html`<div class="pagehead"><div><h1>Master Data</h1>
      <p>Referenced by every application. Names are unique; records are deactivated, never deleted, so existing links stay intact.</p></div></div>
    ${flashFromUrl(ctx.url)}
    ${tabNav(tab)}
    ${body}`,
  );
}, { cap: 'master_data' });

const SIMPLE: Record<string, { table: string; extra?: string }> = {
  insurers: { table: 'insurers' },
  brokers: { table: 'brokers' },
  partners: { table: 'partners' },
  employees: { table: 'employees' },
};

async function simpleTab(ctx: Ctx, tab: TabKey) {
  const t = SIMPLE[tab].table;
  const { results } = await ctx.env.DB.prepare(`SELECT * FROM ${t} ORDER BY status, name`)
    .all<{ id: string; name: string; code: string | null; partner_code?: string; status: string }>();
  const isPartner = tab === 'partners';

  const rows = results.map((r) => html`<tr>
    <td>${r.name}</td>
    <td><code>${(isPartner ? r.partner_code : r.code) || '—'}</code></td>
    <td>${badge(r.status)}</td>
    <td><form method="post" action="/masters/${tab}/${r.id}/toggle" class="inline">
      <button class="sm ghost" type="submit">${r.status === 'active' ? 'Deactivate' : 'Reactivate'}</button></form></td>
  </tr>`);

  return html`<div class="grid c2">
    <div class="card"><h2>${TABS.find((x) => x.key === tab)!.title}</h2>
      ${table(['Name', isPartner ? 'Partner Code' : 'Code', 'Status', ''], rows, 'None yet.')}</div>
    <div class="card"><h2>Add</h2>
      <form method="post" action="/masters/${tab}">
        <div class="field"><label>Name <span class="req">*</span></label><input name="name" required maxlength="160"></div>
        <div class="field"><label>${isPartner ? 'Partner Code' : 'Code'} ${isPartner ? raw('<span class="req">*</span>') : ''}</label>
          <input name="code" maxlength="60" ${isPartner ? raw('required') : ''}></div>
        <button type="submit">Add</button>
      </form></div>
  </div>`;
}

post('/masters/:tab', async (ctx) => {
  const tab = ctx.params.tab;
  if (!SIMPLE[tab]) return errorPage(ctx, 404, 'Unknown master data section.');
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const name = String(form.name ?? '').trim();
  const code = String(form.code ?? '').trim();
  if (!name) return flash(`/masters?tab=${tab}`, 'err', 'A name is required.');
  if (tab === 'partners' && !code) return flash('/masters?tab=partners', 'err', 'A partner code is required.');

  const id = randomId(`${tab.slice(0, 3)}_`);
  try {
    if (tab === 'partners') {
      await ctx.env.DB.prepare('INSERT INTO partners (id, name, partner_code) VALUES (?,?,?)').bind(id, name, code).run();
    } else {
      await ctx.env.DB.prepare(`INSERT INTO ${SIMPLE[tab].table} (id, name, code) VALUES (?,?,?)`)
        .bind(id, name, code || null).run();
    }
  } catch (e) {
    if (String(e).includes('UNIQUE')) return flash(`/masters?tab=${tab}`, 'err', 'That name or code already exists.');
    throw e;
  }
  await audit(ctx, `master.create.${tab}`, tab, id, undefined, { name, code });
  return flash(`/masters?tab=${tab}`, 'ok', `${name} added.`);
}, { cap: 'master_data' });

post('/masters/:tab/:id/toggle', async (ctx) => {
  const tab = ctx.params.tab;
  if (!SIMPLE[tab]) return errorPage(ctx, 404, 'Unknown master data section.');
  const t = SIMPLE[tab].table;
  const row = await ctx.env.DB.prepare(`SELECT id, name, status FROM ${t} WHERE id = ?`)
    .bind(ctx.params.id).first<{ id: string; name: string; status: string }>();
  if (!row) return errorPage(ctx, 404, 'Record not found.');
  const next = row.status === 'active' ? 'inactive' : 'active';
  await ctx.env.DB.prepare(`UPDATE ${t} SET status = ? WHERE id = ?`).bind(next, row.id).run();
  await audit(ctx, `master.toggle.${tab}`, tab, row.id, { status: row.status }, { status: next });
  return flash(`/masters?tab=${tab}`, 'ok', `${row.name} is now ${next}.`);
}, { cap: 'master_data' });

/* -------------------------------------------------------------- products --- */

async function productsTab(ctx: Ctx, m: Awaited<ReturnType<typeof masters>>) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT p.*, i.name AS insurer_name FROM products p LEFT JOIN insurers i ON i.id = p.insurer_id
      ORDER BY p.status, i.name, p.name`,
  ).all<{ id: string; name: string; category: string; status: string; insurer_name: string | null }>();

  const rows = results.map((r) => html`<tr>
    <td>${r.name}</td><td>${r.insurer_name ?? '—'}</td><td>${badge(r.category)}</td><td>${badge(r.status)}</td>
    <td><form method="post" action="/masters/products/${r.id}/toggle" class="inline">
      <button class="sm ghost" type="submit">${r.status === 'active' ? 'Deactivate' : 'Reactivate'}</button></form></td>
  </tr>`);

  return html`<div class="grid c2">
    <div class="card"><h2>Products / Plans</h2>${table(['Name', 'Insurer', 'Category', 'Status', ''], rows, 'None yet.')}</div>
    <div class="card"><h2>Add product</h2>
      <form method="post" action="/masters/products">
        <div class="field"><label>Insurer <span class="req">*</span></label>
          <select name="insurer_id" required><option value="">Select</option>
            ${m.insurers.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></div>
        <div class="field"><label>Category <span class="req">*</span></label>
          <select name="category" required><option value="health">Health Insurance</option><option value="life">Life Insurance</option></select></div>
        <div class="field"><label>Product / Plan name <span class="req">*</span></label><input name="name" required maxlength="160"></div>
        <button type="submit">Add product</button>
      </form></div>
  </div>`;
}

post('/masters/products', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const parsed = z.object({
    insurer_id: z.string().min(1),
    category: z.enum(['health', 'life']),
    name: z.string().trim().min(1).max(160),
  }).safeParse(form);
  if (!parsed.success) return flash('/masters?tab=products', 'err', 'Insurer, category and name are required.');
  const id = randomId('prd_');
  try {
    await ctx.env.DB.prepare('INSERT INTO products (id, insurer_id, category, name) VALUES (?,?,?,?)')
      .bind(id, parsed.data.insurer_id, parsed.data.category, parsed.data.name).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return flash('/masters?tab=products', 'err', 'That product already exists for this insurer.');
    throw e;
  }
  await audit(ctx, 'master.create.products', 'products', id, undefined, parsed.data);
  return flash('/masters?tab=products', 'ok', 'Product added.');
}, { cap: 'master_data' });

post('/masters/products/:id/toggle', async (ctx) => {
  const row = await ctx.env.DB.prepare('SELECT id, name, status FROM products WHERE id = ?')
    .bind(ctx.params.id).first<{ id: string; name: string; status: string }>();
  if (!row) return errorPage(ctx, 404, 'Product not found.');
  const next = row.status === 'active' ? 'inactive' : 'active';
  await ctx.env.DB.prepare('UPDATE products SET status = ? WHERE id = ?').bind(next, row.id).run();
  await audit(ctx, 'master.toggle.products', 'products', row.id, { status: row.status }, { status: next });
  return flash('/masters?tab=products', 'ok', `${row.name} is now ${next}.`);
}, { cap: 'master_data' });

/* ---------------------------------------------------------- payout rules --- */

async function payoutRulesTab(ctx: Ctx, m: Awaited<ReturnType<typeof masters>>) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT r.*, i.name AS insurer_name, p.name AS product_name, pa.name AS partner_name
       FROM payout_rules r
       LEFT JOIN insurers i ON i.id = r.insurer_id
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN partners pa ON pa.id = r.partner_id
      ORDER BY r.effective_from DESC`,
  ).all<{ id: string; insurer_name: string | null; product_name: string | null; partner_name: string | null; base_type: string; payout_bp: number; tds_bp: number; effective_from: string; effective_to: string | null }>();

  const rows = results.map((r) => html`<tr>
    <td>${r.insurer_name ?? 'Any insurer'}</td>
    <td>${r.product_name ?? 'Any product'}</td>
    <td>${r.partner_name ?? 'Any partner'}</td>
    <td>${label(r.base_type)}</td>
    <td class="num">${bpToPct(r.payout_bp)}%</td>
    <td class="num">${bpToPct(r.tds_bp)}%</td>
    <td>${r.effective_from}</td>
    <td>${r.effective_to ?? 'open'}</td>
    <td><form method="post" action="/masters/payout-rules/${r.id}/delete" class="inline"
          onsubmit="return confirm('Delete this payout rule? Payouts already approved keep their snapshot.')">
      <button class="sm danger" type="submit">Delete</button></form></td>
  </tr>`);

  return html`<div class="card"><h2>Payout Rules</h2>
    <p class="sub">Most specific rule wins: partner beats product beats insurer, and a later effective date breaks a tie. Leave a field blank for "any".</p>
    ${table(['Insurer', 'Product', 'Partner', 'Base', 'Payout %', 'TDS %', 'From', 'To', ''], rows, 'No rules yet — the settings defaults apply.')}
  </div>
  <div class="card"><h2>Add rule</h2>
    <form method="post" action="/masters/payout-rules"><div class="row">
      <div class="field"><label>Insurer</label><select name="insurer_id"><option value="">Any</option>
        ${m.insurers.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></div>
      <div class="field"><label>Product</label><select name="product_id"><option value="">Any</option>
        ${m.products.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
      <div class="field"><label>Partner</label><select name="partner_id"><option value="">Any</option>
        ${m.partners.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
      <div class="field"><label>Payout base</label><select name="base_type">
        <option value="premium">Premium</option><option value="net_premium">Net premium</option></select></div>
      <div class="field"><label>Payout % <span class="req">*</span></label><input name="payout_pct" required inputmode="decimal" placeholder="12.50"></div>
      <div class="field"><label>TDS % <span class="req">*</span></label><input name="tds_pct" required inputmode="decimal" placeholder="5.00"></div>
      <div class="field"><label>Effective from <span class="req">*</span></label><input type="date" name="effective_from" required></div>
      <div class="field"><label>Effective to</label><input type="date" name="effective_to"></div>
    </div><button type="submit">Add rule</button></form>
  </div>`;
}

post('/masters/payout-rules', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  let payout_bp: number, tds_bp: number;
  try {
    payout_bp = pctToBp(form.payout_pct ?? '');
    tds_bp = pctToBp(form.tds_pct ?? '');
  } catch (e) {
    return flash('/masters?tab=payout_rules', 'err', e instanceof Error ? e.message : 'Invalid percentage.');
  }
  const from = String(form.effective_from ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return flash('/masters?tab=payout_rules', 'err', 'An effective-from date is required.');
  const to = String(form.effective_to ?? '').trim() || null;
  if (to && to < from) return flash('/masters?tab=payout_rules', 'err', 'Effective-to cannot be before effective-from.');

  const id = randomId('pr_');
  await ctx.env.DB.prepare(
    `INSERT INTO payout_rules (id, insurer_id, product_id, partner_id, base_type, payout_bp, tds_bp, effective_from, effective_to)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(id, form.insurer_id || null, form.product_id || null, form.partner_id || null,
    form.base_type === 'net_premium' ? 'net_premium' : 'premium', payout_bp, tds_bp, from, to).run();
  await audit(ctx, 'rule.payout.create', 'payout_rules', id, undefined, { payout_bp, tds_bp, from, to });
  return flash('/masters?tab=payout_rules', 'ok', 'Payout rule added. New and pending payouts will use it.');
}, { cap: 'configure_rules' });

post('/masters/payout-rules/:id/delete', async (ctx) => {
  const row = await ctx.env.DB.prepare('SELECT * FROM payout_rules WHERE id = ?').bind(ctx.params.id).first();
  if (!row) return errorPage(ctx, 404, 'Rule not found.');
  await ctx.env.DB.prepare('DELETE FROM payout_rules WHERE id = ?').bind(ctx.params.id).run();
  await audit(ctx, 'rule.payout.delete', 'payout_rules', ctx.params.id, row, undefined);
  return flash('/masters?tab=payout_rules', 'ok', 'Payout rule deleted.');
}, { cap: 'configure_rules' });

/* -------------------------------------------------------- document rules --- */

async function documentRulesTab(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM document_rules').all<{ id: string; category: string; doc_type: string; requirement: string }>();
  const get2 = (cat: string, doc: string) => results.find((r) => r.category === cat && r.doc_type === doc)?.requirement ?? 'optional';

  return html`<div class="card">
    <h2>Document Rules</h2>
    <p class="sub"><b>These are fixed business requirements.</b> The seeded values are Anwar's §3 table. Changing them changes what the server will accept, for every application, immediately — including records already in flight.</p>
    <form method="post" action="/masters/document-rules">
      ${table(['Document', 'Health Insurance', 'Life Insurance'], DOC_TYPES.map((d) => html`<tr>
        <td><b>${DOC_LABELS[d]}</b></td>
        ${(['health', 'life'] as const).map((cat) => html`<td>
          <select name="${cat}__${d}">
            <option value="mandatory" ${get2(cat, d) === 'mandatory' ? raw('selected') : ''}>Mandatory</option>
            <option value="optional" ${get2(cat, d) === 'optional' ? raw('selected') : ''}>Optional</option>
          </select></td>`)}
      </tr>`))}
      <div class="actions"><button type="submit" onclick="return confirm('Change the document rules for all applications?')">Save document rules</button></div>
    </form>
  </div>`;
}

post('/masters/document-rules', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const before = (await ctx.env.DB.prepare('SELECT category, doc_type, requirement FROM document_rules').all()).results;

  const stmts = [];
  for (const cat of ['health', 'life'] as const) {
    for (const d of DOC_TYPES) {
      const v = form[`${cat}__${d}`] === 'mandatory' ? 'mandatory' : 'optional';
      stmts.push(
        ctx.env.DB.prepare(
          `INSERT INTO document_rules (id, category, doc_type, requirement) VALUES (?,?,?,?)
             ON CONFLICT (category, doc_type) DO UPDATE SET requirement = excluded.requirement, updated_at = datetime('now')`,
        ).bind(`dr_${cat}_${d}`, cat, d, v),
      );
    }
  }
  await ctx.env.DB.batch(stmts);
  const after = (await ctx.env.DB.prepare('SELECT category, doc_type, requirement FROM document_rules').all()).results;
  await audit(ctx, 'rule.document.update', 'document_rules', null, before, after);
  return flash('/masters?tab=document_rules', 'ok', 'Document rules saved. They apply to every application from now on.');
}, { cap: 'configure_rules' });

/* ----------------------------------------------------------------- users --- */

get('/users', async (ctx) => {
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, name, email, role, status, created_at FROM users ORDER BY status, name',
  ).all<{ id: string; name: string; email: string; role: string; status: string; created_at: string }>();

  const rows = results.map((u) => html`<tr>
    <td>${u.name}${u.id === ctx.user!.id ? html` <span class="tag opt">you</span>` : ''}</td>
    <td>${u.email}</td><td>${badge(u.role)}</td><td>${badge(u.status)}</td><td>${u.created_at}</td>
    <td class="act">
      <form method="post" action="/users/${u.id}/role" class="inline">
        <select name="role" style="width:auto;display:inline-block">
          ${['admin', 'operator', 'viewer'].map((r) => html`<option value="${r}" ${r === u.role ? raw('selected') : ''}>${label(r)}</option>`)}
        </select>
        <button class="sm ghost" type="submit">Set role</button></form>
      ${u.id === ctx.user!.id ? '' : html`<form method="post" action="/users/${u.id}/toggle" class="inline">
        <button class="sm ghost" type="submit">${u.status === 'active' ? 'Disable' : 'Enable'}</button></form>`}
      <form method="post" action="/users/${u.id}/password" class="act">
        <input name="password" type="password" placeholder="New password" minlength="12" required style="width:150px">
        <button class="sm ghost" type="submit">Reset</button></form>
    </td>
  </tr>`);

  return page(
    { title: 'Users', user: ctx.user, ctx, active: '/users', wide: true },
    html`<div class="pagehead"><div><h1>Employees &amp; Users</h1>
      <p>Roles are enforced on the server for every endpoint. Disabling a user ends their access at the next request.</p></div></div>
    ${flashFromUrl(ctx.url)}
    ${table(['Name', 'Email', 'Role', 'Status', 'Created', 'Actions'], rows)}
    <div class="card" style="margin-top:20px;max-width:520px"><h2>Add user</h2>
      <form method="post" action="/users">
        <div class="field"><label>Full name <span class="req">*</span></label><input name="name" required maxlength="120"></div>
        <div class="field"><label>Email <span class="req">*</span></label><input name="email" type="email" required></div>
        <div class="field"><label>Role <span class="req">*</span></label><select name="role" required>
          <option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></div>
        <div class="field"><label>Temporary password <span class="req">*</span></label>
          <input name="password" type="password" minlength="12" required><small>At least 12 characters. Ask the user to change it after first login.</small></div>
        <button type="submit">Create user</button>
      </form></div>`,
  );
}, { cap: 'manage_users' });

post('/users', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const parsed = z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    role: z.enum(['admin', 'operator', 'viewer']),
    password: z.string().min(12).max(200),
  }).safeParse(form);
  if (!parsed.success) return flash('/users', 'err', 'Name, a valid email, a role and a 12-character password are required.');
  const id = randomId('u_');
  try {
    await ctx.env.DB.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
      .bind(id, parsed.data.name, parsed.data.email, await hashPassword(parsed.data.password), parsed.data.role).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return flash('/users', 'err', 'A user with that email already exists.');
    throw e;
  }
  // The password never enters the audit record.
  await audit(ctx, 'user.create', 'users', id, undefined, { email: parsed.data.email, role: parsed.data.role });
  return flash('/users', 'ok', `${parsed.data.name} created.`);
}, { cap: 'manage_users' });

post('/users/:id/role', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const role = String(form.role ?? '');
  if (!['admin', 'operator', 'viewer'].includes(role)) return flash('/users', 'err', 'Unknown role.');
  const u = await ctx.env.DB.prepare('SELECT id, name, role FROM users WHERE id = ?')
    .bind(ctx.params.id).first<{ id: string; name: string; role: string }>();
  if (!u) return errorPage(ctx, 404, 'User not found.');
  if (u.id === ctx.user!.id && role !== 'admin') {
    return flash('/users', 'err', 'You cannot remove your own admin role; ask another admin.');
  }
  if (u.role === 'admin' && role !== 'admin') {
    const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").first<{ n: number }>();
    if ((row?.n ?? 0) <= 1) return flash('/users', 'err', 'That is the last active administrator.');
  }
  await ctx.env.DB.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").bind(role, u.id).run();
  await audit(ctx, 'user.role', 'users', u.id, { role: u.role }, { role });
  return flash('/users', 'ok', `${u.name} is now ${label(role)}.`);
}, { cap: 'manage_users' });

post('/users/:id/toggle', async (ctx) => {
  const u = await ctx.env.DB.prepare('SELECT id, name, status, role FROM users WHERE id = ?')
    .bind(ctx.params.id).first<{ id: string; name: string; status: string; role: string }>();
  if (!u) return errorPage(ctx, 404, 'User not found.');
  if (u.id === ctx.user!.id) return flash('/users', 'err', 'You cannot disable your own account.');
  const next = u.status === 'active' ? 'disabled' : 'active';
  if (next === 'disabled' && u.role === 'admin') {
    const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").first<{ n: number }>();
    if ((row?.n ?? 0) <= 1) return flash('/users', 'err', 'That is the last active administrator.');
  }
  await ctx.env.DB.prepare("UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(next, u.id).run();
  // Disabling revokes immediately: every live session for that user is dropped.
  if (next === 'disabled') await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
  await audit(ctx, 'user.status', 'users', u.id, { status: u.status }, { status: next });
  return flash('/users', 'ok', `${u.name} is now ${next}.`);
}, { cap: 'manage_users' });

post('/users/:id/password', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const password = String(form.password ?? '');
  if (password.length < 12) return flash('/users', 'err', 'A password must be at least 12 characters.');
  const u = await ctx.env.DB.prepare('SELECT id, name FROM users WHERE id = ?')
    .bind(ctx.params.id).first<{ id: string; name: string }>();
  if (!u) return errorPage(ctx, 404, 'User not found.');
  await ctx.env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(await hashPassword(password), u.id).run();
  await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
  await audit(ctx, 'user.password_reset', 'users', u.id);
  return flash('/users', 'ok', `Password reset for ${u.name}; their sessions were ended.`);
}, { cap: 'manage_users' });

/* -------------------------------------------------------------- settings --- */

const EDITABLE: Array<{ key: string; label: string; help: string; type: 'number' | 'pct' | 'bool' | 'text' }> = [
  { key: 'max_file_bytes', label: 'Maximum file size (bytes)', help: 'Applies to every document upload. 10485760 = 10 MB.', type: 'number' },
  { key: 'default_tds_bp', label: 'Default TDS %', help: 'PENDING ANWAR’S APPROVAL. Used when no payout rule matches.', type: 'pct' },
  { key: 'default_payout_bp', label: 'Default payout %', help: 'Used when no payout rule matches. 0 leaves payouts Not Initiated.', type: 'pct' },
  { key: 'default_payout_base', label: 'Default payout base', help: 'premium or net_premium.', type: 'text' },
  { key: 'operators_may_verify', label: 'Operators may verify documents', help: '0 = Admin only (the default). 1 = Operators may verify too.', type: 'bool' },
  { key: 'operator_sees_all', label: 'Operators see all records', help: '0 = only records they created or are assigned (the default).', type: 'bool' },
  { key: 'session_hours', label: 'Session length (hours)', help: 'Sessions expire after this many hours.', type: 'number' },
];

get('/settings', async (ctx) => page(
  { title: 'Settings', user: ctx.user, ctx, active: '/settings' },
  html`<div class="pagehead"><div><h1>Settings</h1>
    <p>Business configuration. Nothing here is compiled into the code, so these can change without a deploy.</p></div></div>
  ${flashFromUrl(ctx.url)}
  <div class="flash err" style="background:var(--warn-bg);border-color:#efd9a3;color:var(--warn)">
    <b>Pending client approval (§18):</b> the default TDS percentage and payout percentage are placeholders
    until Anwar confirms them. They are stored here, never hardcoded.</div>
  <div class="card"><form method="post" action="/settings">
    ${EDITABLE.map((s) => {
      const cur = ctx.settings[s.key] ?? '';
      const shown = s.type === 'pct' ? bpToPct(Number(cur) || 0) : cur;
      return html`<div class="field"><label>${s.label}</label>
        ${s.type === 'bool'
          ? html`<select name="${s.key}">
              <option value="0" ${cur === '0' ? raw('selected') : ''}>No</option>
              <option value="1" ${cur === '1' ? raw('selected') : ''}>Yes</option></select>`
          : html`<input name="${s.key}" value="${shown}">`}
        <small>${s.help} Key: <code>${s.key}</code></small></div>`;
    })}
    <button type="submit">Save settings</button>
  </form></div>
  <div class="card"><h2>Secrets</h2>
    <p class="sub">Server-side only. They are never rendered into a page, returned by an API or written to the audit log.</p>
    <dl class="kv">
      <dt>COVERESY_SESSION_SECRET</dt><dd>${ctx.env.COVERESY_SESSION_SECRET ? badge('configured') : badge('missing')}</dd>
      <dt>COVERESY_SETUP_TOKEN</dt><dd>${ctx.env.COVERESY_SETUP_TOKEN ? badge('configured') : badge('missing')}</dd>
    </dl>
    <p class="sub" style="margin-top:12px">Rotate with <code>npx wrangler secret put &lt;NAME&gt;</code>.
      Once the first administrator exists, the setup route refuses to run again even with a valid token —
      delete the setup token with <code>npx wrangler secret delete COVERESY_SETUP_TOKEN</code>.</p>
  </div>`,
), { cap: 'settings' });

post('/settings', async (ctx) => {
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const before = { ...ctx.settings };
  const stmts = [];
  for (const s of EDITABLE) {
    if (!(s.key in form)) continue;
    let value = String(form[s.key]).trim();
    try {
      if (s.type === 'pct') value = String(pctToBp(value));
      else if (s.type === 'number') {
        if (!/^\d+$/.test(value)) throw new Error(`${s.label} must be a whole number.`);
      } else if (s.type === 'bool') value = value === '1' ? '1' : '0';
      else if (s.key === 'default_payout_base' && !['premium', 'net_premium'].includes(value)) {
        throw new Error('Payout base must be premium or net_premium.');
      }
    } catch (e) {
      return flash('/settings', 'err', e instanceof Error ? e.message : 'Invalid value.');
    }
    stmts.push(ctx.env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    ).bind(s.key, value));
  }
  await ctx.env.DB.batch(stmts);
  const after = Object.fromEntries((await ctx.env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]));
  await audit(ctx, 'settings.update', 'settings', null, before, after);
  return flash('/settings', 'ok', 'Settings saved.');
}, { cap: 'settings' });

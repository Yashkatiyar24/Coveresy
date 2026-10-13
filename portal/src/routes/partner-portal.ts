import { get, post } from '../router.ts';
import { hashPassword, randomId, timingSafeEqual, verifyPassword } from '../auth.ts';
import type { Ctx } from '../types.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Data API for the partner portal, whose application server is the FastAPI
 * service on Vercel. Operations are named rather than accepting SQL, so the
 * shared secret grants exactly these, not a free-form handle on the database.
 * Password material never leaves this Worker.
 */
function authed(ctx: Ctx): boolean {
  const secret = ctx.env.PARTNER_SINK_SECRET;
  if (!secret) return false;
  return timingSafeEqual(ctx.req.headers.get('Authorization') ?? '', `Bearer ${secret}`);
}

const guard = (ctx: Ctx) => (authed(ctx) ? null : json(401, { error: 'Unauthorized' }));

type Account = {
  id: string; agent_code: string; name: string; email: string; mobile: string;
  agent_type: string; status: string; parent_id: string | null;
  created_via: string; last_login_at: string | null; login_count: number;
};

const PUBLIC_COLUMNS = 'id, agent_code, name, email, mobile, agent_type, status, parent_id, created_at, created_via, last_login_at, login_count';

post('/internal/partner/login', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const { email, password } = await ctx.req.json<{ email?: string; password?: string }>();
  if (!email || !password) return json(400, { error: 'email and password are required' });

  const row = await ctx.env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM partner_accounts WHERE email = ?`,
  ).bind(email.trim().toLowerCase()).first<Account & { password_hash: string }>();

  // Same answer either way, so the response cannot be used to enumerate accounts.
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return json(401, { error: 'Invalid email or password' });
  }
  if (row.status !== 'approved') return json(403, { error: `Account is ${row.status}` });

  // Staff use this to tell a login that is in use from one that was never touched.
  await ctx.env.DB.prepare(
    "UPDATE partner_accounts SET last_login_at = datetime('now'), login_count = login_count + 1 WHERE id = ?",
  ).bind(row.id).run();

  const { password_hash, ...account } = row;
  return json(200, { account });
}, { public: true });

post('/internal/partner/accounts', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const b = await ctx.req.json<Record<string, string>>();
  for (const f of ['name', 'email', 'mobile', 'password']) {
    if (!b[f]) return json(400, { error: `Missing field: ${f}` });
  }
  const id = randomId('pac_');
  const code = b.agent_code ?? `CF/POS/${Math.floor(100000 + Math.random() * 899999)}`;
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO partner_accounts
         (id, application_id, parent_id, agent_code, name, email, mobile, password_hash,
          agent_type, status, created_via, created_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, b.application_id ?? null, b.parent_id ?? null, code, b.name,
      b.email.trim().toLowerCase(), b.mobile, await hashPassword(b.password),
      b.agent_type ?? 'coveresy', b.status ?? 'approved',
      // A login either came from staff or was added by a partner for their agent.
      b.created_via ?? (b.parent_id ? 'partner' : 'staff'), b.created_note ?? null,
    ).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return json(409, { error: 'Email, mobile or agent code already in use' });
    throw e;
  }
  return json(201, { id, agent_code: code });
}, { public: true });

get('/internal/partner/accounts', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const parent = ctx.url.searchParams.get('parent_id');
  const status = ctx.url.searchParams.get('status');
  const binds: string[] = [];
  let sql = `SELECT ${PUBLIC_COLUMNS} FROM partner_accounts WHERE 1=1`;
  if (parent) { sql += ' AND parent_id = ?'; binds.push(parent); }
  if (status) { sql += ' AND status = ?'; binds.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const { results } = await ctx.env.DB.prepare(sql).bind(...binds).all();
  return json(200, { accounts: results });
}, { public: true });

post('/internal/partner/quote-requests', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const b = await ctx.req.json<Record<string, unknown>>();
  const partnerId = typeof b.partner_id === 'string' ? b.partner_id : '';
  const product = typeof b.product === 'string' ? b.product : '';
  if (!partnerId || !product) return json(400, { error: 'partner_id and product are required' });

  const id = randomId('qr_');
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO quote_requests (id, partner_id, product, customer_name, customer_phone, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, partnerId, product,
      (b.customer_name as string) ?? null,
      (b.customer_phone as string) ?? null,
      JSON.stringify(b.details ?? {}),
    ).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    // A bad product or an unknown partner is the caller's error, not a 500.
    if (msg.includes('CHECK') || msg.includes('FOREIGN KEY')) return json(400, { error: 'Invalid product or partner' });
    throw e;
  }
  return json(201, { id, stage: 'quote_created' });
}, { public: true });

get('/internal/partner/quote-requests', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const q = ctx.url.searchParams;
  const partnerId = q.get('partner_id');
  if (!partnerId) return json(400, { error: 'partner_id is required' });

  const binds: string[] = [partnerId];
  let where = 'partner_id = ?';
  for (const [param, column] of [['product', 'product'], ['stage', 'stage']] as const) {
    const v = q.get(param);
    if (v) { where += ` AND ${column} = ?`; binds.push(v); }
  }
  // Dates arrive as YYYY-MM-DD; created_at is 'YYYY-MM-DD HH:MM:SS'.
  const from = q.get('from'), to = q.get('to');
  if (from) { where += ' AND created_at >= ?'; binds.push(`${from} 00:00:00`); }
  if (to) { where += ' AND created_at <= ?'; binds.push(`${to} 23:59:59`); }

  const [rows, totals] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, product, stage, customer_name, customer_phone, details,
              net_premium, total_premium, created_at
         FROM quote_requests WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    ).bind(...binds).all(),
    ctx.env.DB.prepare(
      `SELECT COUNT(*) AS policies,
              COALESCE(SUM(net_premium), 0) AS net_premium,
              COALESCE(SUM(total_premium), 0) AS total_premium
         FROM quote_requests WHERE ${where} AND stage = 'payment_done'`,
    ).bind(...binds).first(),
  ]);
  return json(200, { quotes: rows.results, totals });
}, { public: true });

get('/internal/partner/profile', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const id = ctx.url.searchParams.get('partner_id');
  if (!id) return json(400, { error: 'partner_id is required' });

  const [account, stats] = await Promise.all([
    ctx.env.DB.prepare(`SELECT ${PUBLIC_COLUMNS} FROM partner_accounts WHERE id = ?`).bind(id).first<Account>(),
    ctx.env.DB.prepare(
      `SELECT COUNT(*) AS quotes,
              COALESCE(SUM(stage='payment_done'), 0) AS issued,
              (SELECT COUNT(*) FROM partner_accounts WHERE parent_id = ?) AS agents,
              (SELECT COUNT(*) FROM missing_policy_requests WHERE partner_id = ? AND status IN ('pending','in_review')) AS open_reports
         FROM quote_requests WHERE partner_id = ?`,
    ).bind(id, id, id).first(),
  ]);
  if (!account) return json(404, { error: 'No such account' });
  return json(200, { account, stats });
}, { public: true });

post('/internal/partner/password', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const { partner_id, current_password, new_password } =
    await ctx.req.json<{ partner_id?: string; current_password?: string; new_password?: string }>();
  if (!partner_id || !current_password || !new_password) return json(400, { error: 'Missing fields' });

  const row = await ctx.env.DB.prepare('SELECT password_hash FROM partner_accounts WHERE id = ?')
    .bind(partner_id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current_password, row.password_hash))) {
    return json(401, { error: 'Your current password is not right' });
  }
  await ctx.env.DB.prepare('UPDATE partner_accounts SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(new_password), partner_id).run();
  return json(200, { ok: true });
}, { public: true });

post('/internal/partner/missing-policies', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const b = await ctx.req.json<Record<string, string | undefined>>();
  for (const f of ['partner_id', 'policy_number', 'issue_month', 'product']) {
    if (!b[f]) return json(400, { error: `Missing field: ${f}` });
  }

  // The document is optional, and R2 may not be enabled on the account; a
  // report is still worth recording without it.
  let key: string | null = null;
  if (b.document_base64 && ctx.env.DOCS) {
    const bytes = Uint8Array.from(atob(b.document_base64), (c) => c.charCodeAt(0));
    key = `missing-policies/${b.partner_id}/${randomId('mpd_')}`;
    await ctx.env.DOCS.put(key, bytes, {
      httpMetadata: { contentType: b.document_type || 'application/octet-stream' },
    });
  }

  const id = randomId('mp_');
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO missing_policy_requests
         (id, partner_id, policy_number, issue_month, product, comment, start_date, document_key, document_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, b.partner_id, b.policy_number, b.issue_month, b.product,
           b.comment ?? null, b.start_date ?? null, key, b.document_name ?? null).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('CHECK') || msg.includes('FOREIGN KEY')) return json(400, { error: 'Invalid product or partner' });
    throw e;
  }
  return json(201, { id, status: 'pending', document_stored: key !== null });
}, { public: true });

get('/internal/partner/missing-policies', async (ctx: Ctx) => {
  const bad = guard(ctx); if (bad) return bad;
  const id = ctx.url.searchParams.get('partner_id');
  if (!id) return json(400, { error: 'partner_id is required' });
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, policy_number, issue_month, product, comment, start_date, document_name,
            status, staff_note, resolved_at, created_at
       FROM missing_policy_requests WHERE partner_id = ? ORDER BY created_at DESC LIMIT 200`,
  ).bind(id).all();
  return json(200, { requests: results });
}, { public: true });

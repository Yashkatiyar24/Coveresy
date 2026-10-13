import { post } from '../router.ts';
import { randomId, timingSafeEqual } from '../auth.ts';
import type { Ctx } from '../types.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Server-to-server sink for the public "Become a Partner" form.
 *
 * The public API (FastAPI, on Vercel) validates the applicant and forwards the
 * clean record here, so D1 stays the system of record and staff see partner
 * applications beside everything else. Authentication is the shared bearer
 * secret, never a session: the caller is a server, not a signed-in operator.
 */
post('/internal/partner-applications', async (ctx: Ctx) => {
  const secret = ctx.env.PARTNER_SINK_SECRET;
  if (!secret) return json(503, { error: 'Partner sink is not configured' });

  const given = ctx.req.headers.get('Authorization') ?? '';
  if (!timingSafeEqual(given, `Bearer ${secret}`)) return json(401, { error: 'Unauthorized' });

  let body: Record<string, unknown>;
  try {
    body = await ctx.req.json();
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }

  // The API owns validation; this end only refuses what would corrupt a row.
  const fields = ['full_name', 'email', 'mobile', 'gender', 'pincode', 'pan'] as const;
  const values: string[] = [];
  for (const f of fields) {
    const v = body[f];
    if (typeof v !== 'string' || v === '') return json(400, { error: `Missing field: ${f}` });
    values.push(v);
  }
  const referral = typeof body.referral === 'string' && body.referral !== '' ? body.referral : null;
  const id = randomId('pa_');

  try {
    await ctx.env.DB.prepare(
      `INSERT INTO partner_applications
         (id, full_name, email, mobile, gender, pincode, pan, referral)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, ...values, referral).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return json(409, { error: 'Already applied' });
    throw e;
  }
  return json(201, { id, status: 'new' });
}, { public: true });

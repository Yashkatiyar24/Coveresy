import type { Category, Ctx, DocType } from './types.ts';
import type { DocRecord, DocRule } from './rules.ts';
import { assessDocuments, overallStatus } from './rules.ts';
import type { PayoutRule } from './payout.ts';
import { computePayout, selectRule } from './payout.ts';
import { randomId } from './auth.ts';
import { num, visibilityScope } from './db.ts';

export interface AppRow {
  id: string; category: Category; product_id: string | null; product_name: string | null;
  login_date: string | null; application_no: string; policy_no: string | null;
  customer_name: string; premium_paise: number; status: string; issued_date: string | null;
  policy_term: string | null; premium_frequency: string | null; insurer_id: string;
  insurer_rep_name: string | null; broker_id: string | null; partner_id: string | null;
  employee_id: string | null; assigned_user_id: string | null; doc_overall_status: string;
  cancel_reason: string | null; created_by: string; created_at: string; updated_at: string;
}

export async function docRules(ctx: Ctx): Promise<DocRule[]> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT category, doc_type, requirement FROM document_rules',
  ).all<DocRule>();
  return results;
}

export async function currentDocs(ctx: Ctx, appId: string) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT d.*, u1.name AS uploaded_by_name, u2.name AS verified_by_name
       FROM application_documents d
       LEFT JOIN users u1 ON u1.id = d.uploaded_by
       LEFT JOIN users u2 ON u2.id = d.verified_by
      WHERE d.application_id = ? AND d.is_current = 1`,
  ).bind(appId).all<DocRecord & {
    id: string; storage_key: string; original_name: string; mime_type: string;
    size_bytes: number; sha256: string; version: number; uploaded_at: string;
    uploaded_by_name: string | null; verified_by_name: string | null; verified_at: string | null; notes: string | null;
  }>();
  return results;
}

/** Load an application the current user is permitted to see (§12 IDOR guard). */
export async function loadApp(ctx: Ctx, id: string): Promise<AppRow | null> {
  const scope = visibilityScope(ctx);
  return ctx.env.DB.prepare(
    `SELECT a.* FROM applications a WHERE a.id = ? AND ${scope.sql}`,
  ).bind(id, ...scope.binds).first<AppRow>();
}

export async function assess(ctx: Ctx, app: AppRow) {
  const [rules, docs] = await Promise.all([docRules(ctx), currentDocs(ctx, app.id)]);
  return { assessment: assessDocuments(app.category, rules, docs), docs, rules };
}

/**
 * Recompute doc_overall_status from the documents themselves and walk the
 * application back if its status no longer holds. Called after every document
 * change and after a category switch — which is what makes "switching Life to
 * Health immediately triggers Health validation" true rather than aspirational.
 */
export async function syncDocState(ctx: Ctx, appId: string): Promise<void> {
  const app = await ctx.env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first<AppRow>();
  if (!app) return;
  const [rules, docs] = await Promise.all([docRules(ctx), currentDocs(ctx, appId)]);
  const a = assessDocuments(app.category, rules, docs);
  const overall = overallStatus(a);

  let status = app.status;
  const past = ['documents_uploaded', 'pending_verification', 'verified', 'submitted_to_insurer'];
  if (!a.complete && past.includes(status)) status = 'documents_pending';
  else if (!a.verified && ['verified', 'submitted_to_insurer'].includes(status)) status = 'pending_verification';
  else if (a.complete && status === 'documents_pending') status = 'documents_uploaded';

  await ctx.env.DB.prepare(
    "UPDATE applications SET doc_overall_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(overall, status, appId).run();

  if (status !== app.status) {
    await ctx.env.DB.prepare(
      'INSERT INTO status_history (id, application_id, from_status, to_status, actor, remark) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(randomId('sh_'), appId, app.status, status, ctx.user?.id ?? null,
      'Automatic: document state changed').run();
  }
}

/* ------------------------------------------------------------- payouts --- */

export async function payoutRules(ctx: Ctx): Promise<PayoutRule[]> {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM payout_rules').all<PayoutRule>();
  return results;
}

/**
 * Recalculate a draft payout from the applicable rule. Never touches a payout
 * that is already approved or beyond — those are frozen with their
 * rule_snapshot so a later rule edit cannot silently restate a paid amount.
 */
export async function recalcPayout(ctx: Ctx, appId: string): Promise<void> {
  const app = await ctx.env.DB.prepare('SELECT * FROM applications WHERE id = ?').bind(appId).first<AppRow>();
  if (!app) return;
  const existing = await ctx.env.DB.prepare('SELECT * FROM payouts WHERE application_id = ?')
    .bind(appId).first<{ id: string; status: string; deductions_paise: number }>();
  if (existing && !['not_initiated', 'pending'].includes(existing.status)) return;

  const onDate = app.login_date || app.created_at.slice(0, 10);
  const rule = selectRule(await payoutRules(ctx), app, onDate);

  const payoutBp = rule ? rule.payout_bp : num(ctx.settings, 'default_payout_bp', 0);
  const tdsBp = rule ? rule.tds_bp : num(ctx.settings, 'default_tds_bp', 0);
  const deductions = existing?.deductions_paise ?? 0;
  const r = computePayout({ basePaise: app.premium_paise, payoutBp, tdsBp, deductionsPaise: deductions });
  const snapshot = JSON.stringify({ rule_id: rule?.id ?? null, base_type: rule?.base_type ?? 'premium', payoutBp, tdsBp, at: new Date().toISOString() });
  const status = payoutBp === 0 ? 'not_initiated' : 'pending';

  if (existing) {
    await ctx.env.DB.prepare(
      `UPDATE payouts SET base_paise=?, payout_bp=?, gross_paise=?, tds_bp=?, tds_paise=?,
         net_paise=?, status=?, rule_snapshot=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(r.basePaise, payoutBp, r.grossPaise, tdsBp, r.tdsPaise, r.netPaise, status, snapshot, existing.id).run();
  } else {
    await ctx.env.DB.prepare(
      `INSERT INTO payouts (id, application_id, base_paise, payout_bp, gross_paise, tds_bp,
         tds_paise, deductions_paise, net_paise, status, rule_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(randomId('po_'), appId, r.basePaise, payoutBp, r.grossPaise, tdsBp, r.tdsPaise, 0, r.netPaise, status, snapshot).run();
  }
}

/* ------------------------------------------------------------- filters --- */

export interface Filter { sql: string; binds: unknown[] }

/** One filter builder shared by the MIS list, the dashboard and every export. */
export function buildFilter(ctx: Ctx): Filter {
  const p = ctx.url.searchParams;
  const scope = visibilityScope(ctx);
  const where: string[] = [scope.sql];
  const binds: unknown[] = [...scope.binds];

  const eq = (param: string, col: string) => {
    const v = p.get(param);
    if (v) { where.push(`a.${col} = ?`); binds.push(v); }
  };
  eq('category', 'category');
  eq('insurer', 'insurer_id');
  eq('broker', 'broker_id');
  eq('partner', 'partner_id');
  eq('employee', 'employee_id');
  eq('status', 'status');
  eq('doc_status', 'doc_overall_status');

  const from = p.get('from');
  const to = p.get('to');
  if (from) { where.push('a.login_date >= ?'); binds.push(from); }
  if (to) { where.push('a.login_date <= ?'); binds.push(to); }

  const payout = p.get('payout_status');
  if (payout) { where.push('EXISTS (SELECT 1 FROM payouts po WHERE po.application_id = a.id AND po.status = ?)'); binds.push(payout); }

  const q = p.get('q')?.trim();
  if (q) {
    where.push('(a.customer_name LIKE ? OR a.application_no LIKE ? OR a.policy_no LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  return { sql: where.join(' AND '), binds };
}

const SORTABLE: Record<string, string> = {
  login_date: 'a.login_date', customer_name: 'a.customer_name', application_no: 'a.application_no',
  premium: 'a.premium_paise', status: 'a.status', category: 'a.category',
  policy_no: 'a.policy_no', created_at: 'a.created_at', doc_status: 'a.doc_overall_status',
};

/** Whitelisted sort: the column never comes from user input directly. */
export function orderBy(ctx: Ctx, fallback = 'a.created_at DESC'): string {
  const col = SORTABLE[ctx.url.searchParams.get('sort') ?? ''];
  if (!col) return fallback;
  const dir = ctx.url.searchParams.get('dir') === 'desc' ? 'DESC' : 'ASC';
  return `${col} ${dir}`;
}

export const DOC_LABEL_OF = (d: DocType) =>
  ({ policy_copy: 'Policy Copy', proposal_form: 'Proposal Form', payment_receipt: 'Payment Receipt' })[d];

import type { Ctx, Env, User } from './types.ts';

export async function loadSettings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

export function num(settings: Record<string, string>, key: string, fallback: number): number {
  const v = Number(settings[key]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * §18 decision 9: Operators see only what they created or are assigned, unless
 * the operator_sees_all setting is on. Returned as a SQL fragment + binds so
 * every list query is scoped the same way — this is the IDOR guard (§12).
 */
export function visibilityScope(ctx: Ctx, alias = 'a'): { sql: string; binds: string[] } {
  const u = ctx.user!;
  if (u.role === 'admin' || u.role === 'viewer') return { sql: '1=1', binds: [] };
  if (ctx.settings.operator_sees_all === '1') return { sql: '1=1', binds: [] };
  return {
    sql: `(${alias}.created_by = ? OR ${alias}.assigned_user_id = ?)`,
    binds: [u.id, u.id],
  };
}

export async function canSeeApplication(ctx: Ctx, appId: string): Promise<boolean> {
  const scope = visibilityScope(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT 1 AS ok FROM applications a WHERE a.id = ? AND ${scope.sql}`,
  ).bind(appId, ...scope.binds).first<{ ok: number }>();
  return !!row;
}

export async function listUsers(env: Env): Promise<User[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, email, role, status FROM users WHERE status='active' ORDER BY name",
  ).all<User>();
  return results;
}

export interface Named { id: string; name: string; [k: string]: unknown }

export async function masters(env: Env) {
  const q = (t: string, extra = '') =>
    env.DB.prepare(`SELECT * FROM ${t} WHERE status='active' ${extra} ORDER BY name`).all<Named>();
  const [insurers, brokers, partners, employees, products] = await Promise.all([
    q('insurers'), q('brokers'), q('partners'), q('employees'), q('products'),
  ]);
  return {
    insurers: insurers.results,
    brokers: brokers.results,
    partners: partners.results,
    employees: employees.results,
    products: products.results,
  };
}

export function nameOf(list: Named[], id: string | null | undefined): string {
  if (!id) return '—';
  return list.find((x) => x.id === id)?.name ?? '—';
}

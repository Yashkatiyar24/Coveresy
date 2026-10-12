import type { Ctx } from './types.ts';
import { randomId } from './auth.ts';

/**
 * §13. Never pass passwords, tokens or document contents in before/after —
 * callers strip them before calling.
 */
export async function audit(
  ctx: Ctx,
  action: string,
  entity: string | null,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
): Promise<void> {
  await ctx.env.DB.prepare(
    `INSERT INTO audit_logs (id, actor, action, entity, entity_id, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId('al_'),
      ctx.user?.id ?? null,
      action,
      entity,
      entityId,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      ctx.ip,
    )
    .run();
}

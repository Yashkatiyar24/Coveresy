import type { Env, Role, User } from './types.ts';

// The Workers runtime refuses more than 100,000 PBKDF2 iterations in one call
// ("iteration counts above 100000 are not supported"), while OWASP's floor for
// PBKDF2-SHA256 is 210,000. Chaining rounds keeps the real work factor: each
// round feeds the previous round's output back in as the password, so N rounds
// cost N x ITERATIONS to compute and to attack.
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_ROUNDS = 3; // 300,000 effective, above the OWASP floor
const SESSION_COOKIE = 'coveresy_session';
const enc = new TextEncoder();

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function randomId(prefix = ''): string {
  return prefix + hex(crypto.getRandomValues(new Uint8Array(12)).buffer);
}

/** Constant-time compare; both sides are already-encoded strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function deriveOnce(material: BufferSource, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  rounds: number,
): Promise<string> {
  let bits: BufferSource = enc.encode(password);
  for (let i = 0; i < rounds; i++) bits = await deriveOnce(bits, salt, iterations);
  return b64(bits as ArrayBuffer);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_ROUNDS);
  // Self-describing, so the work factor can be raised later without
  // invalidating hashes already stored.
  return `pbkdf2$${PBKDF2_ROUNDS}x${PBKDF2_ITERATIONS}$${b64(salt.buffer)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, costStr, saltB64, expected] = stored.split('$');
  if (scheme !== 'pbkdf2' || !costStr || !saltB64 || !expected) return false;
  // "3x100000" (rounds x iterations), or a bare count from the original format.
  const [a, b] = costStr.split('x');
  const rounds = b ? Number(a) : 1;
  const iterations = b ? Number(b) : Number(a);
  if (!Number.isFinite(rounds) || !Number.isFinite(iterations)) return false;
  const actual = await pbkdf2(password, unb64(saltB64), iterations, rounds);
  return timingSafeEqual(actual, expected);
}

/**
 * Session tokens are opaque random bytes handed to the browser; what we store
 * is their HMAC under COVERESY_SESSION_SECRET. A stolen database row therefore
 * cannot be replayed as a cookie.
 */
async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function secretsConfigured(env: Env): boolean {
  return !!env.COVERESY_SESSION_SECRET && env.COVERESY_SESSION_SECRET.length >= 32;
}

export async function createSession(env: Env, userId: string, hours: number): Promise<string> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const id = await hmac(env.COVERESY_SESSION_SECRET!, token);
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, expires)
    .run();
  return token;
}

export async function userFromRequest(req: Request, env: Env): Promise<User | null> {
  if (!secretsConfigured(env)) return null;
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const id = await hmac(env.COVERESY_SESSION_SECRET!, token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.status, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  ).bind(id).first<User & { expires_at: string }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  if (row.status !== 'active') return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, status: row.status };
}

export async function destroySession(req: Request, env: Env): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !secretsConfigured(env)) return;
  const id = await hmac(env.COVERESY_SESSION_SECRET!, token);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Scope the cookie to the mount path: at coveresy.com/admin it is never sent
 *  to the marketing site on the same domain. */
function cookiePath(env: Env): string {
  const base = (env.BASE_PATH ?? '').replace(/\/+$/, '');
  return base || '/';
}

export function sessionCookie(token: string, env: Env, hours: number): string {
  const secure = env.COVERESY_ENV === 'development' ? '' : ' Secure;';
  return `${SESSION_COOKIE}=${token}; Path=${cookiePath(env)}; HttpOnly;${secure} SameSite=Lax; Max-Age=${hours * 3600}`;
}

export function clearCookie(env: Env): string {
  const secure = env.COVERESY_ENV === 'development' ? '' : ' Secure;';
  return `${SESSION_COOKIE}=; Path=${cookiePath(env)}; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

/* ---------------------------------------------------------------- authz --- */

export function can(user: User | null, capability: Capability, settings: Record<string, string>): boolean {
  if (!user || user.status !== 'active') return false;
  if (user.role === 'admin') return true;
  if (user.role === 'operator') {
    switch (capability) {
      case 'view_records':
      case 'edit_applications':
      case 'upload_documents':
      case 'import':
      case 'export':
        return true;
      case 'verify_documents':
        return settings.operators_may_verify === '1';
      default:
        return false;
    }
  }
  // viewer
  return capability === 'view_records' || capability === 'export';
}

export type Capability =
  | 'manage_users'
  | 'configure_rules'
  | 'settings'
  | 'view_records'
  | 'edit_applications'
  | 'upload_documents'
  | 'verify_documents'
  | 'approve_payouts'
  | 'audit_logs'
  | 'import'
  | 'export'
  | 'master_data';

/* ------------------------------------------------------- rate limiting --- */

const MAX_FAILS = 10;
const WINDOW_MINUTES = 15;

export async function loginBlocked(env: Env, email: string, ip: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts
      WHERE ok = 0 AND (email = ? OR ip = ?) AND at > datetime('now', ?)`,
  ).bind(email, ip, `-${WINDOW_MINUTES} minutes`).first<{ n: number }>();
  return (row?.n ?? 0) >= MAX_FAILS;
}

export async function recordAttempt(env: Env, email: string, ip: string, ok: boolean): Promise<void> {
  await env.DB.prepare('INSERT INTO login_attempts (email, ip, ok) VALUES (?, ?, ?)')
    .bind(email, ip, ok ? 1 : 0)
    .run();
}

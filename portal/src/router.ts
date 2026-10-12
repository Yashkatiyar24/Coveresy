import type { Ctx, Env } from './types.ts';
import type { Capability } from './auth.ts';
import { can, userFromRequest } from './auth.ts';
import { loadSettings } from './db.ts';
import { errorPage, redirect } from './ui.ts';
import { setBasePath } from './html.ts';

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
  /** Public routes skip the session check. Everything else requires one. */
  public?: boolean;
  cap?: Capability;
}

const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler, opts: Omit<Route, 'method' | 'path' | 'handler'> = {}) {
  routes.push({ method, path, handler, ...opts });
}
export const get = (p: string, h: Handler, o?: Omit<Route, 'method' | 'path' | 'handler'>) => route('GET', p, h, o);
export const post = (p: string, h: Handler, o?: Omit<Route, 'method' | 'path' | 'handler'>) => route('POST', p, h, o);

function match(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (b[i] !== a[i]) return null;
  }
  return params;
}

/** CSRF: same-origin check on every state-changing request (§17). */
function originOk(req: Request, url: URL): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.get('Origin');
  if (origin) return new URL(origin).host === url.host;
  const referer = req.headers.get('Referer');
  if (referer) return new URL(referer).host === url.host;
  return false; // no Origin and no Referer on a POST: refuse
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // The portal may be mounted under a path (BASE_PATH="/ops"). Routes are
  // declared without it; strip it here so there is exactly one place that
  // knows, and one place that puts it back (html.ts / redirect()).
  const base = (env.BASE_PATH ?? '').replace(/\/+$/, '');
  setBasePath(base);
  if (base) {
    if (url.pathname === base) url.pathname = '/';
    else if (url.pathname.startsWith(base + '/')) url.pathname = url.pathname.slice(base.length);
    else {
      // Outside the mount point. In production the edge only forwards
      // BASE_PATH/*, so this is belt and braces rather than a live path.
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  }
  const ip = req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For') ?? 'local';

  // Candidates are ranked by how many LITERAL segments they match, so
  // /masters/payout-rules always beats /masters/:tab regardless of the order
  // the route modules happened to be imported in.
  const candidates = routes
    .filter((r) => r.method === req.method)
    .map((r) => ({ r, params: match(url.pathname, r.path) }))
    .filter((c): c is { r: Route; params: Record<string, string> } => c.params !== null)
    .sort((a, b) => Object.keys(a.params).length - Object.keys(b.params).length);

  for (const { r, params } of candidates) {
    if (!originOk(req, url)) {
      return new Response('Cross-origin request refused', { status: 403 });
    }

    const [user, settings] = await Promise.all([userFromRequest(req, env), loadSettings(env)]);
    const ctx: Ctx = { req, env, url, user, params, settings, ip };

    if (!r.public && !user) {
      const next = encodeURIComponent(url.pathname + url.search);
      // Via redirect() so the mount path is applied, as for every other Location.
      return redirect(`/login?next=${next}`);
    }
    if (r.cap && !can(user, r.cap, settings)) {
      return errorPage(ctx, 403, 'Your role does not permit this action.');
    }
    try {
      return await r.handler(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unexpected error';
      // Message only; never the stack or any record contents.
      console.error('handler error', r.method, r.path, msg);
      return errorPage(ctx, 500, msg);
    }
  }
  const settings = await loadSettings(env).catch(() => ({}));
  const user = await userFromRequest(req, env).catch(() => null);
  return errorPage({ req, env, url, user, params: {}, settings, ip }, 404, 'Page not found.');
}

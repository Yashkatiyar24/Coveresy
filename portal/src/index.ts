import { get, handle } from './router.ts';
import { CSS } from './styles.ts';
import type { Env } from './types.ts';

// Importing a route module registers its routes. Order is specificity-free:
// the router matches on an exact segment count, so /applications/new and
// /applications/:id cannot collide.
import './routes/auth.ts';
import './routes/dashboard.ts';
import './routes/applications.ts';
import './routes/documents.ts';
import './routes/payouts.ts';
import './routes/masters.ts';
import './routes/reports.ts';

get('/app.css', () => new Response(CSS, {
  headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
}), { public: true });

get('/healthz', () => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }), { public: true });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await handle(req, env);
    const h = new Headers(res.headers);
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'same-origin');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (env.COVERESY_ENV !== 'development') {
      h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
} satisfies ExportedHandler<Env>;

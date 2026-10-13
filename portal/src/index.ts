import { get, handle } from './router.ts';
import { CSS } from './styles.ts';
import { FAVICON_SVG, LOGO_SVG } from './brand.ts';
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
import './routes/partners.ts';
import './routes/partner-portal.ts';

get('/app.css', () => new Response(CSS, {
  headers: {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable',
  },
}), { public: true });

// Safe to cache hard: the page requests these with a ?v= content hash, so a
// changed asset arrives on a new URL rather than waiting for a cache to lapse.
const svg = (body: string) => () => new Response(body, {
  headers: {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=31536000, immutable',
  },
});

get('/logo.svg', svg(LOGO_SVG), { public: true });
get('/favicon.svg', svg(FAVICON_SVG), { public: true });

get('/healthz', () => new Response('ok', { headers: { 'Content-Type': 'text/plain' } }), { public: true });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await handle(req, env);
    const h = new Headers(res.headers);
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'same-origin');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (env.COVERESY_ENV !== 'development') {
      h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return new Response(res.body, { status: res.status, headers: h });
  },
} satisfies ExportedHandler<Env>;

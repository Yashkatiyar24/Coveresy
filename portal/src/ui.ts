import { html, render } from './html.ts';
import type { Ctx, User } from './types.ts';
import { label } from './types.ts';
import { can } from './auth.ts';

export interface PageOpts {
  title: string;
  user?: User | null;
  active?: string;
  ctx?: Ctx;
  wide?: boolean;
}

const NAV: Array<{ href: string; text: string; cap?: Parameters<typeof can>[1] }> = [
  { href: '/', text: 'Dashboard' },
  { href: '/applications', text: 'Policy MIS' },
  { href: '/verification', text: 'Verification Queue' },
  { href: '/payouts', text: 'Payouts' },
  { href: '/reports', text: 'Reports & Exports' },
  { href: '/masters', text: 'Master Data', cap: 'master_data' },
  { href: '/users', text: 'Users', cap: 'manage_users' },
  { href: '/settings', text: 'Settings', cap: 'settings' },
  { href: '/audit-logs', text: 'Audit Logs', cap: 'audit_logs' },
];

export function page(opts: PageOpts, body: ReturnType<typeof html>): Response {
  const u = opts.user ?? null;
  const settings = opts.ctx?.settings ?? {};
  const nav = u
    ? NAV.filter((n) => !n.cap || can(u, n.cap, settings)).map(
        (n) => html`<a href="${n.href}" class="${opts.active === n.href ? 'on' : ''}">${n.text}</a>`,
      )
    : [];

  const doc = html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Coveresy Ops</title>
<link rel="stylesheet" href="/app.css">
</head><body class="${u ? 'in' : 'out'}">
${u
    ? html`<header class="top">
  <a class="brand" href="/">Coveresy<span>Ops</span></a>
  <button class="navtoggle" aria-label="Menu" onclick="document.body.classList.toggle('navopen')">&#9776;</button>
  <nav>${nav}</nav>
  <div class="who"><span>${u.name}</span><em>${label(u.role)}</em>
    <form method="post" action="/auth/logout"><button class="link">Log out</button></form></div>
</header>`
    : ''}
<main class="${opts.wide ? 'wide' : ''}">${body}</main>
</body></html>`;

  return new Response(render(doc), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}

export function flashFromUrl(url: URL) {
  const ok = url.searchParams.get('ok');
  const err = url.searchParams.get('err');
  if (ok) return html`<div class="flash ok">${ok}</div>`;
  if (err) return html`<div class="flash err">${err}</div>`;
  return html``;
}

export function badge(status: string): ReturnType<typeof html> {
  const tone =
    /verified|policy_issued|paid|approved|active/.test(status) ? 'good'
    : /rejected|cancelled|reversed|missing|incomplete/.test(status) ? 'bad'
    : /pending|processing|hold|partial|awaiting/.test(status) ? 'warn'
    : 'neutral';
  return html`<span class="badge ${tone}">${label(status)}</span>`;
}

export function empty(text: string) {
  return html`<p class="empty">${text}</p>`;
}

/** Headers may be plain strings (escaped) or html`` nodes such as sortLink. */
export function table(headers: unknown[], rows: Array<ReturnType<typeof html>>, emptyText = 'No records yet.') {
  if (!rows.length) return empty(emptyText);
  return html`<div class="tablewrap"><table>
    <thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

/** Sortable column header that preserves the current filters. */
export function sortLink(url: URL, field: string, text: string) {
  const cur = url.searchParams.get('sort');
  const dir = cur === field && url.searchParams.get('dir') !== 'desc' ? 'desc' : 'asc';
  const next = new URL(url);
  next.searchParams.set('sort', field);
  next.searchParams.set('dir', dir);
  next.searchParams.delete('page');
  const arrow = cur === field ? (url.searchParams.get('dir') === 'desc' ? ' ↓' : ' ↑') : '';
  return html`<a class="sort" href="${next.pathname + next.search}">${text}${arrow}</a>`;
}

export function pager(url: URL, page: number, total: number, perPage: number) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return html`<p class="pagecount">${total} record${total === 1 ? '' : 's'}</p>`;
  const link = (p: number, text: string, disabled: boolean) => {
    if (disabled) return html`<span class="pg off">${text}</span>`;
    const u = new URL(url);
    u.searchParams.set('page', String(p));
    return html`<a class="pg" href="${u.pathname + u.search}">${text}</a>`;
  };
  return html`<div class="pager">
    ${link(page - 1, '← Prev', page <= 1)}
    <span class="pagecount">Page ${page} of ${pages} · ${total} records</span>
    ${link(page + 1, 'Next →', page >= pages)}
  </div>`;
}

export function redirect(to: string, extra?: Record<string, string>): Response {
  const headers = new Headers({ Location: to });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.append(k, v);
  return new Response(null, { status: 303, headers });
}

export function flash(to: string, kind: 'ok' | 'err', message: string): Response {
  const sep = to.includes('?') ? '&' : '?';
  return redirect(`${to}${sep}${kind}=${encodeURIComponent(message)}`);
}

export function errorPage(ctx: Ctx, status: number, message: string): Response {
  const res = page(
    { title: `${status}`, user: ctx.user, ctx },
    html`<div class="card narrow"><h1>${status}</h1><p>${message}</p><p><a href="/">Back to dashboard</a></p></div>`,
  );
  return new Response(res.body, { status, headers: res.headers });
}

import { z } from 'zod';
import { get, post } from '../router.ts';
import { html } from '../html.ts';
import { page, flash, redirect } from '../ui.ts';
import { audit } from '../audit.ts';
import {
  clearCookie, createSession, destroySession, hashPassword, loginBlocked,
  randomId, recordAttempt, secretsConfigured, sessionCookie, timingSafeEqual, verifyPassword,
} from '../auth.ts';
import { num } from '../db.ts';
import type { Ctx } from '../types.ts';

async function adminExists(ctx: Ctx): Promise<boolean> {
  const row = await ctx.env.DB.prepare("SELECT 1 AS ok FROM users WHERE role='admin' LIMIT 1").first();
  return !!row;
}

/** The setup screen appears only when a secret is genuinely missing (§4). */
function secretsMissingPage(ctx: Ctx) {
  const missing: string[] = [];
  if (!ctx.env.COVERESY_SESSION_SECRET) missing.push('COVERESY_SESSION_SECRET');
  else if (ctx.env.COVERESY_SESSION_SECRET.length < 32) missing.push('COVERESY_SESSION_SECRET (must be at least 32 characters)');
  if (!ctx.env.COVERESY_SETUP_TOKEN) missing.push('COVERESY_SETUP_TOKEN');

  return page(
    { title: 'Server setup required' },
    html`<div class="loginmark"><img src="/logo.svg" alt="Coveresy"></div>
    <div class="card">
      <h1>Server setup required</h1>
      <p class="sub">The portal cannot start a session until these server-side secrets are configured. They are never shown to the browser.</p>
      <ul>${missing.map((m) => html`<li><code>${m}</code></li>`)}</ul>
      <h3>Set them</h3>
      <pre>openssl rand -hex 32   # use the output as the value

npx wrangler secret put COVERESY_SESSION_SECRET
npx wrangler secret put COVERESY_SETUP_TOKEN</pre>
      <p class="sub">Locally, put the same two keys in <code>portal/.dev.vars</code> (never committed). Reload this page once they are set.</p>
    </div>`,
  );
}

get('/login', async (ctx) => {
  if (!secretsConfigured(ctx.env) || !ctx.env.COVERESY_SETUP_TOKEN) return secretsMissingPage(ctx);
  if (ctx.user) return redirect('/');
  if (!(await adminExists(ctx))) return redirect('/setup');

  const err = ctx.url.searchParams.get('err');
  const next = ctx.url.searchParams.get('next') ?? '/';
  return page(
    { title: 'Log in' },
    html`<div class="loginmark"><img src="/logo.svg" alt="Coveresy"></div>
    <div class="card">
      <h1>Operations portal</h1>
      <p class="sub">Internal access for the Coveresy operations team.</p>
      ${err ? html`<div class="flash err">${err}</div>` : ''}
      <form method="post" action="/auth/login">
        <input type="hidden" name="next" value="${next}">
        <div class="field"><label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
        <div class="field"><label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button type="submit">Log in</button>
      </form>
    </div>`,
  );
}, { public: true });

get('/setup', async (ctx) => {
  if (!secretsConfigured(ctx.env) || !ctx.env.COVERESY_SETUP_TOKEN) return secretsMissingPage(ctx);
  if (await adminExists(ctx)) {
    return page(
      { title: 'Setup complete' },
      html`<div class="loginmark"><img src="/logo.svg" alt="Coveresy"></div>
      <div class="card">
        <h1>Setup already complete</h1>
        <p class="sub">An administrator account exists, so first-run setup is closed. Rotate or remove <code>COVERESY_SETUP_TOKEN</code> now.</p>
        <p><a class="btn" href="/login">Go to login</a></p>
      </div>`,
    );
  }
  const err = ctx.url.searchParams.get('err');
  return page(
    { title: 'First administrator' },
    html`<div class="loginmark"><img src="/logo.svg" alt="Coveresy"></div>
    <div class="card">
      <h1>Create the first administrator</h1>
      <p class="sub">This runs once and is protected by the one-time setup token. There is no default password.</p>
      ${err ? html`<div class="flash err">${err}</div>` : ''}
      <form method="post" action="/auth/setup">
        <div class="field"><label for="token">Setup token <span class="req">*</span></label>
          <input id="token" name="token" type="password" required autofocus></div>
        <div class="field"><label for="name">Full name <span class="req">*</span></label>
          <input id="name" name="name" required></div>
        <div class="field"><label for="email">Email <span class="req">*</span></label>
          <input id="email" name="email" type="email" required></div>
        <div class="field"><label for="password">Password <span class="req">*</span></label>
          <input id="password" name="password" type="password" minlength="12" required>
          <small>At least 12 characters.</small></div>
        <button type="submit">Create administrator</button>
      </form>
    </div>`,
  );
}, { public: true });

const setupSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(12).max(200),
});

post('/auth/setup', async (ctx) => {
  if (!secretsConfigured(ctx.env) || !ctx.env.COVERESY_SETUP_TOKEN) return secretsMissingPage(ctx);
  if (await adminExists(ctx)) return flash('/login', 'err', 'Setup is already complete.');

  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const parsed = setupSchema.safeParse(form);
  if (!parsed.success) return flash('/setup', 'err', 'Check the fields: a 12-character password and a valid email are required.');

  if (!timingSafeEqual(parsed.data.token, ctx.env.COVERESY_SETUP_TOKEN)) {
    await recordAttempt(ctx.env, parsed.data.email, ctx.ip, false);
    return flash('/setup', 'err', 'Invalid setup token.');
  }

  const id = randomId('u_');
  await ctx.env.DB.prepare(
    "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')",
  ).bind(id, parsed.data.name, parsed.data.email, await hashPassword(parsed.data.password)).run();

  await audit({ ...ctx, user: { id, name: parsed.data.name, email: parsed.data.email, role: 'admin', status: 'active' } },
    'setup.create_admin', 'users', id, undefined, { email: parsed.data.email, role: 'admin' });

  return flash('/login', 'ok', 'Administrator created. Rotate COVERESY_SETUP_TOKEN now, then log in.');
}, { public: true });

post('/auth/login', async (ctx) => {
  if (!secretsConfigured(ctx.env)) return secretsMissingPage(ctx);
  const form = Object.fromEntries(await ctx.req.formData()) as Record<string, string>;
  const email = String(form.email ?? '').trim().toLowerCase();
  const password = String(form.password ?? '');
  // Only same-origin relative paths, so ?next= cannot become an open redirect.
  const raw = String(form.next ?? '/');
  const next = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';

  if (await loginBlocked(ctx.env, email, ctx.ip)) {
    return flash('/login', 'err', 'Too many failed attempts. Try again in 15 minutes.');
  }

  const user = await ctx.env.DB.prepare(
    'SELECT id, name, email, role, status, password_hash FROM users WHERE email = ?',
  ).bind(email).first<{ id: string; name: string; email: string; role: 'admin' | 'operator' | 'viewer'; status: string; password_hash: string }>();

  const ok = !!user && user.status === 'active' && (await verifyPassword(password, user.password_hash));
  await recordAttempt(ctx.env, email, ctx.ip, ok);
  if (!ok || !user) {
    // Same message either way: no account enumeration.
    return flash('/login', 'err', 'Incorrect email or password.');
  }

  const hours = num(ctx.settings, 'session_hours', 12);
  const token = await createSession(ctx.env, user.id, hours);
  await audit({ ...ctx, user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status } },
    'auth.login', 'users', user.id);

  return redirect(next, { 'Set-Cookie': sessionCookie(token, ctx.env, hours) });
}, { public: true });

post('/auth/logout', async (ctx) => {
  if (ctx.user) await audit(ctx, 'auth.logout', 'users', ctx.user.id);
  await destroySession(ctx.req, ctx.env);
  return redirect('/login', { 'Set-Cookie': clearCookie(ctx.env) });
}, { public: true });

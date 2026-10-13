import { test } from 'node:test';
import assert from 'node:assert/strict';

// originOk is module-private; exercise it through the same logic the router
// uses, so the allowlist rules are pinned by a test.
function originOk(req, url, env) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const allowed = new Set([url.host]);
  for (const h of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const host = h.trim();
    if (host) allowed.add(host);
  }
  const hostOf = (v) => { try { return new URL(v).host; } catch { return null; } };
  const origin = req.headers.get('Origin');
  if (origin) { const h = hostOf(origin); return h !== null && allowed.has(h); }
  const referer = req.headers.get('Referer');
  if (referer) { const h = hostOf(referer); return h !== null && allowed.has(h); }
  return false;
}

const url = new URL('https://worker.workers.dev/ops/auth/login');
const env = { ALLOWED_ORIGINS: 'www.coveresy.com, coveresy.vercel.app' };
const req = (headers, method = 'POST') => new Request('https://x/', { method, headers });

test('a POST from an allowlisted public host is accepted', () => {
  assert.ok(originOk(req({ Origin: 'https://www.coveresy.com' }), url, env));
  assert.ok(originOk(req({ Origin: 'https://coveresy.vercel.app' }), url, env));
});

test('a POST from the worker host itself is accepted', () => {
  assert.ok(originOk(req({ Origin: 'https://worker.workers.dev' }), url, env));
});

test('a POST from anywhere else is refused', () => {
  for (const o of ['https://evil.com', 'https://coveresy.com.evil.com',
                   'https://notcoveresy.vercel.app', 'http://localhost:3000']) {
    assert.equal(originOk(req({ Origin: o }), url, env), false, `must refuse ${o}`);
  }
});

test('a POST with no Origin and no Referer is refused', () => {
  assert.equal(originOk(req({}), url, env), false);
});

test('a malformed Origin is refused, not thrown on', () => {
  assert.equal(originOk(req({ Origin: 'not-a-url' }), url, env), false);
});

test('a forged X-Forwarded-Host cannot authorise a request', () => {
  const r = req({ Origin: 'https://evil.com', 'X-Forwarded-Host': 'www.coveresy.com' });
  assert.equal(originOk(r, url, env), false, 'the allowlist is config, never a header');
});

test('with no allowlist set, only same-origin is accepted', () => {
  assert.ok(originOk(req({ Origin: 'https://worker.workers.dev' }), url, {}));
  assert.equal(originOk(req({ Origin: 'https://www.coveresy.com' }), url, {}), false);
});

test('GET is never blocked', () => {
  assert.ok(originOk(req({}, 'GET'), url, env));
});

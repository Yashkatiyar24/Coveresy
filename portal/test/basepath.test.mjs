import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, render, setBasePath, withBase, raw } from '../src/html.ts';

test('with no mount path, markup is untouched', () => {
  setBasePath('');
  const out = render(html`<a href="/applications">x</a><form action="/auth/login"></form>`);
  assert.equal(out, '<a href="/applications">x</a><form action="/auth/login"></form>');
});

test('static hrefs, actions and srcs are prefixed', () => {
  setBasePath('/ops');
  const out = render(html`<a href="/applications">x</a><form action="/auth/login"><img src="/logo.svg"></form>`);
  assert.ok(out.includes('href="/ops/applications"'));
  assert.ok(out.includes('action="/ops/auth/login"'));
  assert.ok(out.includes('src="/ops/logo.svg"'));
  setBasePath('');
});

test('interpolated URLs are prefixed too', () => {
  setBasePath('/ops');
  const id = 'app_123';
  const out = render(html`<a href="${`/applications/${id}`}">x</a>`);
  assert.ok(out.includes('href="/ops/applications/app_123"'), out);
  setBasePath('');
});

test('external and protocol-relative URLs are left alone', () => {
  setBasePath('/ops');
  const out = render(html`<link href="https://fonts.googleapis.com/css2?family=Lato">
    <a href="//example.com/x">y</a>`);
  assert.ok(out.includes('href="https://fonts.googleapis.com/css2?family=Lato"'));
  assert.ok(out.includes('href="//example.com/x"'));
  setBasePath('');
});

test('prefixing is idempotent — never doubles up', () => {
  setBasePath('/ops');
  assert.equal(withBase('/ops/applications'), '/ops/applications');
  assert.equal(withBase('/ops'), '/ops');
  assert.equal(withBase('/applications'), '/ops/applications');
  const out = render(html`<a href="/ops/already">x</a>`);
  assert.ok(!out.includes('/ops/ops/'), out);
  setBasePath('');
});

test('escaping still applies to interpolated URL slots', () => {
  setBasePath('/ops');
  const nasty = '/x"><script>alert(1)</script>';
  const out = render(html`<a href="${nasty}">x</a>`);
  assert.ok(!out.includes('<script>'), 'must not break out of the attribute');
  assert.ok(out.includes('&quot;'), out);
  setBasePath('');
});

test('text content that looks like a path is not rewritten', () => {
  setBasePath('/ops');
  const out = render(html`<p>Upload to /applications now</p>`);
  assert.ok(out.includes('Upload to /applications now'), out);
  setBasePath('');
});

test('a trailing slash in the mount path is normalised', () => {
  setBasePath('/ops/');
  assert.equal(withBase('/applications'), '/ops/applications');
  setBasePath('/');
  assert.equal(withBase('/applications'), '/applications');
  setBasePath('');
});

test('raw() content is still passed through unescaped', () => {
  setBasePath('');
  assert.equal(render(html`${raw('<b>hi</b>')}`), '<b>hi</b>');
});

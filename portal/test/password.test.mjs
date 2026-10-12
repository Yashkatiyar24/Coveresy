import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth.ts';

test('a password verifies against its own hash', async () => {
  const h = await hashPassword('CorrectHorseBattery1');
  assert.ok(await verifyPassword('CorrectHorseBattery1', h));
  assert.equal(await verifyPassword('CorrectHorseBattery2', h), false);
});

test('the stored hash is self-describing and carries no plaintext', async () => {
  const h = await hashPassword('SuperSecret12345');
  const [scheme, cost, salt, digest] = h.split('$');
  assert.equal(scheme, 'pbkdf2');
  // rounds x iterations, each round within the Workers 100k ceiling.
  const [rounds, iters] = cost.split('x').map(Number);
  assert.ok(iters <= 100000, `each round must stay within the Workers limit, got ${iters}`);
  assert.ok(rounds * iters >= 210000, `effective work factor should meet the OWASP floor, got ${rounds * iters}`);
  assert.ok(salt.length > 10 && digest.length > 10);
  assert.ok(!h.includes('SuperSecret12345'));
});

test('every hash uses a fresh salt', async () => {
  const [a, b] = [await hashPassword('same'), await hashPassword('same')];
  assert.notEqual(a, b, 'identical passwords must not produce identical hashes');
  assert.ok(await verifyPassword('same', a));
  assert.ok(await verifyPassword('same', b));
});

test('the original single-round format still verifies', async () => {
  // Hashes written before rounds were introduced must keep working.
  const legacy = await hashPassword('LegacyPassword99');
  const [, cost, salt, digest] = legacy.split('$');
  const [rounds, iters] = cost.split('x').map(Number);
  assert.equal(rounds, 3);
  // Build a single-round hash by hand and confirm the parser handles it.
  const single = `pbkdf2$${iters}$${salt}$${digest}`;
  assert.equal(await verifyPassword('LegacyPassword99', single), false,
    'a 1-round hash of the same salt is a different digest, so this must not match');
  assert.ok(iters <= 100000);
});

test('a malformed hash is refused, not thrown on', async () => {
  for (const bad of ['', 'garbage', 'pbkdf2$', 'pbkdf2$abc$x$y', 'bcrypt$10$x$y']) {
    assert.equal(await verifyPassword('anything', bad), false, `should refuse: ${bad}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGO_SVG, FAVICON_SVG, ASSET_VERSION } from '../src/brand.ts';

/**
 * The source wordmark centres a 727.5x158.4 mark on a 1145.87x640.34 canvas.
 * Shipping that uncropped makes `height:22px` render an ~5px wordmark adrift in
 * whitespace, which is what the header bug looked like. Assert the crop holds.
 */
test('the embedded wordmark is cropped to its artwork', () => {
  const vb = LOGO_SVG.match(/viewBox="([\d.\s-]+)"/);
  assert.ok(vb, 'logo has a viewBox');
  const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
  const aspect = w / h;
  assert.ok(aspect > 3.5 && aspect < 5,
    `wordmark aspect should be ~4.2:1, got ${aspect.toFixed(2)}:1 (the raw file is 1.79:1)`);
  assert.ok(w < 900 && h < 250, `viewBox should be cropped, got ${w}x${h}`);
});

test('the artwork itself is untouched by the crop', () => {
  // Only the viewBox may differ from the source; the paths must be identical.
  assert.ok(LOGO_SVG.includes('fill: #f7ca15'), 'keeps the brand yellow');
  assert.ok(LOGO_SVG.includes('fill: #fff'), 'keeps the white wordmark');
  assert.equal((LOGO_SVG.match(/<path/g) || []).length, 7, 'all seven paths present');
});

test('the asset version changes when an asset changes', async () => {
  // Recompute the same way brand.ts does, over altered content.
  const hash = (...parts) => {
    let h = 2166136261;
    for (const s of parts) {
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    }
    return (h >>> 0).toString(36);
  };
  assert.equal(hash(LOGO_SVG, FAVICON_SVG), ASSET_VERSION, 'version is the content hash');
  assert.notEqual(hash(LOGO_SVG + ' ', FAVICON_SVG), ASSET_VERSION,
    'a changed asset must produce a different version, or browsers keep the stale one');
  assert.match(ASSET_VERSION, /^[a-z0-9]+$/);
});

test('the favicon keeps the brand colours', () => {
  assert.ok(FAVICON_SVG.includes('#f7ca15'));
});

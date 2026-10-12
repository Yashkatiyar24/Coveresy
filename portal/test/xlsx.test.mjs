import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toXlsx } from '../src/xlsx.ts';
import { Money } from '../src/payout.ts';

test('the workbook is a valid zip that unzip can read', () => {
  const buf = toXlsx('Applications', ['Name', 'Premium'], [['Test', new Money(500000)]]);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'book.xlsx');
  writeFileSync(file, buf);
  // unzip -t fails loudly on a bad CRC or a malformed central directory.
  const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);
  const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
  for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(listing.includes(part), `missing part ${part}`);
  }
});

test('money is written as a number, text as inline string', () => {
  const buf = toXlsx('S', ['A', 'B'], [['text', new Money(593750)]]);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'b.xlsx');
  writeFileSync(file, buf);
  const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
  assert.match(sheet, /<v>5937\.5<\/v>/, 'money should be a bare number Excel can total');
  assert.match(sheet, /t="inlineStr"><is><t[^>]*>text</, 'text should be an inline string');
});

test('xml-hostile content cannot corrupt the sheet', () => {
  const buf = toXlsx('S', ['A'], [['</t></is></c><script>&"\u0007']]);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'c.xlsx');
  writeFileSync(file, buf);
  const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
  assert.ok(!sheet.includes('<script>'), 'raw markup must not survive');
  assert.ok(!sheet.includes('\u0007'), 'control characters must be stripped');
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
});

test('column names continue past Z', () => {
  const headers = Array.from({ length: 30 }, (_, i) => `h${i}`);
  const buf = toXlsx('S', headers, [headers.map((_, i) => i)]);
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'd.xlsx');
  writeFileSync(file, buf);
  const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8' });
  assert.ok(sheet.includes('r="AA1"'), 'the 27th column should be AA');
  assert.ok(sheet.includes('r="AD1"'), 'the 30th column should be AD');
});

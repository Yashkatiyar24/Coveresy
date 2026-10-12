import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv, csvCell } from '../src/csv.ts';

test('csv quotes commas, quotes and newlines', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('a formula-looking cell is neutralised for spreadsheets', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-5'), "'-5");
});

test('csv round-trips through the parser', () => {
  const headers = ['a', 'b', 'c'];
  const rows = [['1', 'x,y', 'say "hi"'], ['2', 'line1\nline2', '']];
  const parsed = parseCsv(toCsv(headers, rows));
  assert.deepEqual(parsed[0], headers);
  assert.deepEqual(parsed[1], rows[0]);
  assert.deepEqual(parsed[2], rows[1]);
});

test('blank rows are dropped, data rows are not', () => {
  assert.equal(parseCsv('a,b\n\n1,2\n').length, 2);
});

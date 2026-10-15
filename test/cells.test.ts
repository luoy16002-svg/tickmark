import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fromCells, type ReadRow } from '../src/parse/statement.ts';
import { parseJsonRows } from '../src/ai/read-scan-parse.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'statements');
const money = (c: number) => (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

/** What a careful reader of the scanned Northgate page would write down, cell by cell. */
function northgateCells(misread?: number): { header: string[]; rows: ReadRow[] } {
  const ans = JSON.parse(readFileSync(join(DIR, 'northgate-2026-09.json'), 'utf8'));
  const rows: ReadRow[] = [{ cells: ['', 'BALANCE BROUGHT FORWARD', '', '', money(ans.opening_cents)], page: 1, y0: 100, y1: 110 }];
  ans.transactions.forEach((t: { date: string; description: string; amount_cents: number; balance_cents: number | null }, i: number) => {
    const [y, m, d] = t.date.split('-');
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1];
    let amt = Math.abs(t.amount_cents);
    if (i === misread) amt += 900; // a 1 read as a 7 in the pence, say
    const bal = t.balance_cents === null ? '' : money(t.balance_cents) + (t.balance_cents < 0 ? ' OD' : '');
    rows.push({
      cells: [`${d} ${mon} ${y.slice(2)}`, t.description, t.amount_cents < 0 ? money(amt) : '', t.amount_cents > 0 ? money(amt) : '', bal],
      page: 1, y0: 120 + i * 12, y1: 130 + i * 12,
    });
  });
  return { header: ['Date', 'Payment type and details', 'Paid out', 'Paid in', 'Balance'], rows };
}

test('rows read off a scan go through the same balance check', () => {
  const { header, rows } = northgateCells();
  const p = fromCells(header, rows);
  assert.equal(p.status, 'ties');
  assert.equal(p.transactions.length, 58);
  assert.ok(p.transactions.every((t) => t.check === 'tied' || t.check === 'tied-day'));
});

test('a digit the model misreads is caught by the balance', () => {
  const { header, rows } = northgateCells(10);
  const p = fromCells(header, rows);
  assert.equal(p.status, 'off');
  // Northgate prints one balance a day, so the gap shows on the misread row's whole day and nowhere else
  const day = p.transactions[10].date;
  const off = p.transactions.filter((t) => t.check === 'off');
  assert.ok(off.length >= 1, 'nothing flagged');
  assert.ok(off.every((t) => t.date === day), `flagged outside ${day}: ${off.map((t) => t.date)}`);
  assert.equal(Math.abs(off.at(-1)!.diff!), 900);
});

test('model output lines become cells, with code fences and chatter ignored', () => {
  const text = 'Here is the table:\n```json\n["Date","Details","Paid out","Paid in","Balance"]\n["01 Sep 26","DD PG&E","297.05","",""]\nnot json\n["02 Sep 26","CR INTEREST","","2.14","5,000.00"]\n```';
  const { header, rows } = parseJsonRows(text);
  assert.deepEqual(header, ['Date', 'Details', 'Paid out', 'Paid in', 'Balance']);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][3], '2.14');
});

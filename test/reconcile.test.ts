import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TextItem } from '../src/parse/layout.ts';
import { parseStatement } from '../src/parse/statement.ts';

/** A one-page statement drawn from rows of [date, description, amount, balance] at fixed columns. */
function page(rows: [string, string, string, string][], header = ['Date', 'Description', 'Amount', 'Balance']): TextItem[] {
  const items: TextItem[] = [];
  const put = (str: string, x0: number, y: number, right = false) => {
    const w = str.length * 4.6;
    items.push({ str, x0: right ? x0 - w : x0, x1: right ? x0 : x0 + w, y, h: 9, page: 1 });
  };
  put('Statement period September 1, 2026 through September 30, 2026', 54, 60);
  put('Beginning balance', 54, 80);
  put('1,000.00', 330, 80, true);
  put(header[0], 54, 120);
  put(header[1], 100, 120);
  put(header[2], 470, 120, true);
  put(header[3], 558, 120, true);
  rows.forEach(([d, desc, amt, bal], i) => {
    const y = 140 + i * 14;
    put(d, 54, y);
    put(desc, 100, y);
    put(amt, 470, y, true);
    if (bal) put(bal, 558, y, true);
  });
  return items;
}

test('a misprinted amount is caught on its row and nowhere else', () => {
  const p = parseStatement(page([
    ['09/01', 'COFFEE BEANS', '-200.00', '800.00'],
    ['09/02', 'STRIPE TRANSFER', '450.00', '1,250.00'],
    ['09/03', 'RENT', '-300.00', '940.00'], // should be 950.00
    ['09/04', 'SQUARE DEPOSIT', '60.00', '1,000.00'],
  ]));
  assert.equal(p.status, 'off');
  assert.deepEqual(p.transactions.map((t) => t.check), ['tied', 'tied', 'off', 'tied']);
  assert.equal(p.transactions[2].diff, -1000);
});

test('amounts printed without a sign get it from the running balance', () => {
  const p = parseStatement(page([
    ['09/01', 'COFFEE BEANS', '200.00', '800.00'],
    ['09/02', 'STRIPE TRANSFER', '450.00', '1,250.00'],
    ['09/03', 'RENT', '300.00', '950.00'],
  ]));
  assert.equal(p.status, 'ties');
  assert.deepEqual(p.transactions.map((t) => t.amount), [-20000, 45000, -30000]);
  assert.deepEqual(p.transactions.map((t) => t.signFrom), ['balance', 'balance', 'balance']);
});

test('a day printed with one closing balance is checked as a group', () => {
  const p = parseStatement(page([
    ['09/01', 'COFFEE BEANS', '-200.00', ''],
    ['09/01', 'STRIPE TRANSFER', '450.00', '1,250.00'],
    ['09/02', 'RENT', '-300.00', ''],
    ['09/02', 'FEE', '-5.00', '945.00'],
  ]));
  assert.equal(p.status, 'ties');
  assert.deepEqual(p.transactions.map((t) => t.check), ['tied-day', 'tied', 'tied-day', 'tied']);
});

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readItems } from '../src/parse/pdf.ts';
import { parseStatement } from '../src/parse/statement.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'statements');

export async function parseFile(path: string) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const { items, pages } = await readItems(doc);
  return { parsed: parseStatement(items), pages };
}

for (const name of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const key = name.replace(/\.json$/, '');
  test(`${key}: every row matches the answer key and ties to the balance`, async () => {
    const want = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
    const { parsed } = await parseFile(join(DIR, `${key}.pdf`));
    let got = parsed.transactions;
    // a ledger listed by date from category sections: compare each day's rows regardless of their order within the day
    if (/daily-balance-table/.test(want.layout)) {
      const k = (d: string, a: number, s: string) => `${d}|${String(a).padStart(12)}|${s}`;
      want.transactions.sort((x: Record<string, any>, y: Record<string, any>) => k(x.date, x.amount_cents, x.description).localeCompare(k(y.date, y.amount_cents, y.description)));
      got = [...got].sort((x, y) => k(x.date, x.amount, x.description).localeCompare(k(y.date, y.amount, y.description)));
    }
    const problems: string[] = [];
    if (got.length !== want.transactions.length) problems.push(`rows: got ${got.length}, want ${want.transactions.length}`);
    want.transactions.forEach((w: Record<string, unknown>, i: number) => {
      const g = got[i];
      if (!g) return;
      const diffs = [];
      if (g.date !== w.date) diffs.push(`date ${g.date} != ${w.date}`);
      if (g.amount !== w.amount_cents) diffs.push(`amount ${g.amount} != ${w.amount_cents}`);
      if (w.balance_cents !== null && g.balance !== w.balance_cents) diffs.push(`balance ${g.balance} != ${w.balance_cents}`);
      if (g.description !== w.description) diffs.push(`desc "${g.description}" != "${w.description}"`);
      if (g.check === 'off' || g.check === 'unchecked') diffs.push(`check ${g.check}`);
      if (diffs.length) problems.push(`#${i}: ${diffs.join('; ')}`);
    });
    if (parsed.opening !== want.opening_cents) problems.push(`opening ${parsed.opening} != ${want.opening_cents}`);
    if (parsed.closing !== undefined && parsed.closing !== want.closing_cents) problems.push(`closing ${parsed.closing} != ${want.closing_cents}`);
    if (parsed.status !== 'ties') problems.push(`status ${parsed.status}`);
    assert.deepEqual(problems.slice(0, 12), [], `${problems.length} problems`);
  });
}

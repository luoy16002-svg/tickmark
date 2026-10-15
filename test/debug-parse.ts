// Print what the parser makes of a statement: node test/debug-parse.ts fixtures/statements/x.pdf [rows]
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readItems } from '../src/parse/pdf.ts';
import { parseStatement } from '../src/parse/statement.ts';

const [file, n] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
const p = parseStatement((await readItems(doc)).items);
console.log('columns:', p.columns.map((c) => `${c.kind}:${c.label}@${c.x0.toFixed(0)}-${c.x1.toFixed(0)}`).join(' | '));
console.log('opening', p.opening, 'closing', p.closing, 'status', p.status, p.notes.join(' '));
for (const t of p.transactions.slice(0, Number(n) || 12)) {
  console.log(`${t.check.padEnd(9)} ${t.date} ${(t.amount / 100).toFixed(2).padStart(10)} ${t.signFrom.padEnd(7)} ${t.balance !== undefined ? (t.balance / 100).toFixed(2) : ''} | ${t.description}`);
}

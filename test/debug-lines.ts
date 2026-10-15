// Print a statement's regrouped lines and cells: node test/debug-lines.ts fixtures/statements/x.pdf [page]
import { readFileSync } from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { toLines } from '../src/parse/layout.ts';
import { readItems } from '../src/parse/pdf.ts';
import { kindOf } from '../src/parse/statement.ts';

const [file, pageArg] = process.argv.slice(2);
const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise;
const { items } = await readItems(doc);
for (const l of toLines(items)) {
  if (pageArg && l.page !== Number(pageArg)) continue;
  console.log(`p${l.page} y${l.y.toFixed(0).padStart(4)} | ` + l.cells.map((c) => `${c.text}@${c.x0.toFixed(0)}-${c.x1.toFixed(0)}${kindOf(c.text) ? `[${kindOf(c.text)}]` : ''}`).join(' | '));
}

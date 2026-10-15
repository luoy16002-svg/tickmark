import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildExport, FORMATS } from '../src/export/formats.ts';
import { readItems } from '../src/parse/pdf.ts';
import { parseStatement } from '../src/parse/statement.ts';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'statements');

test('every export format opens and carries every row', async () => {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(DIR, 'northgate-2026-09.pdf'))), verbosity: 0 }).promise;
  const parsed = parseStatement((await readItems(doc)).items);
  const out = join(tmpdir(), 'tickmark-export-test');
  mkdirSync(out, { recursive: true });
  for (const f of FORMATS) {
    const file = buildExport(f.id, parsed, 'northgate-2026-09');
    writeFileSync(join(out, file.name), file.data);
  }
  // an independent reader checks the workbook: openpyxl must load it and see the same money
  const py = `
import openpyxl, sys, csv, xml.dom.minidom
wb = openpyxl.load_workbook(sys.argv[1] + '/northgate-2026-09.xlsx')
ws = wb['Transactions']
rows = list(ws.iter_rows(min_row=2, values_only=True))
print(len(rows), round(sum(r[3] for r in rows), 2), ws['A2'].value.date().isoformat(), ws['A2'].number_format)
rec = dict((r[0], r[1]) for r in wb['Reconciliation'].iter_rows(values_only=True))
print(rec['Rows that do not tie'])
xml.dom.minidom.parse(sys.argv[1] + '/northgate-2026-09.ofx')
print(sum(1 for _ in csv.reader(open(sys.argv[1] + '/northgate-2026-09-xero.csv', encoding='utf-8-sig'))) - 1)
`;
  const res = execFileSync('python', ['-c', py, out], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const total = parsed.transactions.reduce((s, t) => s + t.amount, 0) / 100;
  assert.equal(res[0], `${parsed.transactions.length} ${total.toFixed(2).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m))} 2026-09-01 yyyy-mm-dd`.replace(/ (-?\d+\.\d)0 /, ' $1 '));
  assert.equal(res[1], '0');
  assert.equal(Number(res[2]), parsed.transactions.length);
});

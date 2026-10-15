// Opening a statement in the page: pdf.js reads it here, the parser and the rules run here, nothing leaves.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { categorise } from './ai/rules.ts';
import { readItems, type PageInfo } from './parse/pdf.ts';
import { parseStatement, type Parsed } from './parse/statement.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

export interface Opened {
  name: string;
  doc: PdfDoc;
  pages: PageInfo[];
  parsed: Parsed;
  /** True when the pages carry almost no text: a scan or a photo. */
  scanned: boolean;
}

export async function openStatement(data: ArrayBuffer, name: string): Promise<Opened> {
  const base = new URL('pdfjs/', document.baseURI).href;
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    verbosity: 0,
  }).promise;
  const { items, pages } = await readItems(doc);
  const parsed = parseStatement(items);
  categorise(parsed.transactions);
  const chars = pages.reduce((s, p) => s + p.chars, 0);
  return { name, doc, pages, parsed, scanned: chars < 40 * pages.length };
}

export function baseName(file: string): string {
  return file.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'statement';
}

export function formatMoney(cents: number | undefined, decimal: '.' | ',' = '.'): string {
  if (cents === undefined) return '';
  const s = (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const local = decimal === ',' ? s.replace(/,/g, ' ').replace('.', ',') : s;
  return (cents < 0 ? '−' : '') + local;
}

/** Dates as people read them in the statement's region: 3 Sep 2026. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${mon} ${y}`;
}

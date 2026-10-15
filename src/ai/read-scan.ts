// A scanned statement: draw each page, cut the table into bands the model can read at full size, ask Gemma for
// the cells, then put the rows through the same balance check as a text PDF. The arithmetic, not the model,
// decides which rows are right.
import type { PdfDoc } from '../core.ts';
import { fromCells, type Parsed, type ReadRow } from '../parse/statement.ts';
import { readImage } from './gemma.ts';
import { parseJsonRows } from './read-scan-parse.ts';

export interface ScanProgress {
  page: number;
  pages: number;
  band: number;
  bands: number;
  rows: number;
  live: string;
}

const FIRST = 'This is the top of a table on a scanned bank statement. Write the column headings as one JSON array, then every row of the table as a JSON array of its cells from left to right, one array per line. Use "" for an empty cell. Copy dates, words and amounts exactly as printed, with every digit, comma, point and minus sign. A row whose details run onto a second printed line is still one row: join the lines. Write nothing else.';
const NEXT = (header: string[]) => `This is part of a table on a scanned bank statement. Its columns are ${JSON.stringify(header)}. Write every row you can see as a JSON array of its ${header.length} cells in that order, one array per line. Use "" for an empty cell. Copy dates, words and amounts exactly as printed, with every digit, comma, point and minus sign. A row whose details run onto a second printed line is still one row: join the lines. Skip the column headings if they appear. Write nothing else.`;

/** Draw a page at about 170 dpi on an offscreen canvas. */
async function pageImage(doc: PdfDoc, n: number): Promise<{ img: ImageData; scale: number; height: number }> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = 1600 / base.width;
  const vp = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  return { img: ctx.getImageData(0, 0, canvas.width, canvas.height), scale, height: base.height };
}

function crop(img: ImageData, y0: number, y1: number): ImageData {
  const h = Math.max(1, Math.min(img.height, y1) - Math.max(0, y0));
  const out = new ImageData(img.width, h);
  out.data.set(img.data.subarray(Math.max(0, y0) * img.width * 4, (Math.max(0, y0) + h) * img.width * 4));
  return out;
}

const key = (cells: string[]) => cells.join('|').replace(/\s+/g, '').toLowerCase();

/** Two reads of one printed row: the same figures and the same first words of the details. */
function same(a: string[], b: string[]): boolean {
  const figs = (r: string[]) => r.filter((c) => /\d[.,]\d{2}/.test(c)).join('|');
  const words = (r: string[]) => r.filter((c) => /[A-Za-z]{3}/.test(c)).join(' ').toLowerCase().replace(/[^a-z]/g, '').slice(0, 14);
  return figs(a) !== '' && figs(a) === figs(b) && words(a) === words(b);
}

/** Share of dark pixels in a band: blank paper (a page's empty foot) is not worth asking the model about,
 *  and a model shown a blank picture sometimes invents an example table. */
function ink(img: ImageData): number {
  let dark = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] < 360) dark++;
  return dark / (d.length / 16);
}

/** Printed lines that carry a figure: runs of pixel rows with ink in the right third of the band, where amounts
 *  and balances sit. Each transaction starts on such a line; a description's second line has no figure. Returns
 *  the [top, bottom] of each, in band pixels. */
function figureLines(img: ImageData): [number, number][] {
  const x0 = Math.floor(img.width * 0.62);
  const x1 = Math.floor(img.width * 0.97);
  const lines: [number, number][] = [];
  let start = -1;
  for (let y = 0; y < img.height; y++) {
    let dark = 0;
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 330) dark++;
    }
    const inked = dark > 2;
    if (inked && start < 0) start = y;
    if (!inked && start >= 0) {
      if (y - start >= 4) lines.push([start, y]);
      start = -1;
    }
  }
  return lines;
}

export async function readScan(doc: PdfDoc, onProgress: (p: ScanProgress) => void, opts: { bands?: number; imageTokens?: number; maxPages?: number } = {}): Promise<Parsed> {
  let header: string[] | null = null;
  const rows: ReadRow[] = [];
  const pages = Math.min(doc.numPages, opts.maxPages ?? Infinity);
  for (let n = 1; n <= pages; n++) {
    const { img, scale } = await pageImage(doc, n);
    // about ten bands a page, overlapping by a line so no row is cut in half: the model sees 280 image tokens per picture, so a narrow band keeps print legible
    const bands = opts.bands ?? 10;
    const bandH = Math.ceil(img.height / bands);
    const overlap = Math.round(img.height * 0.025);
    let lastKey = '';
    let tail: string[][] = [];
    for (let b = 0; b < bands; b++) {
      const y0 = b * bandH - (b ? overlap : 0);
      const y1 = (b + 1) * bandH;
      const prompt = header ? NEXT(header) : FIRST;
      const band = crop(img, y0, y1);
      if (ink(band) < 0.004) {
        onProgress({ page: n, pages, band: b + 1, bands, rows: rows.length, live: '' });
        continue;
      }
      const text = await readImage(band, prompt, 1400, (live) => {
        onProgress({ page: n, pages, band: b + 1, bands, rows: rows.length, live });
      }, opts.imageTokens ?? 280);
      const got = parseJsonRows(text);
      if (!header && got.header) header = got.header;
      // a row needs words of its own: a lone payment code or a date fragment is a partial read
      const fresh = got.rows.filter((r) => r.join(' ').replace(/[^A-Za-z]/g, '').length >= 4);
      // the overlap may repeat the last rows of the band above, sometimes read a little differently
      while (fresh.length && tail.some((t) => same(t, fresh[0]))) fresh.shift();
      if (fresh.length && key(fresh[0]) === lastKey) fresh.shift();
      // place each row on the page: on the printed lines that carry figures when their count matches (the
      // headings line counts too in the band that holds it), otherwise spread evenly through the band
      const top = y0 / scale;
      let lines = figureLines(band).filter(([a]) => !b || a > overlap * 0.6);
      if (got.header && lines.length === fresh.length + 1) lines = lines.slice(1);
      const step = (y1 - y0) / scale / Math.max(1, fresh.length + 1);
      fresh.forEach((cells, i) => {
        const line = lines.length === fresh.length ? lines[i] : null;
        rows.push(line
          ? { cells, page: n, y0: top + (line[0] - 4) / scale, y1: top + (line[1] + 4) / scale }
          : { cells, page: n, y0: top + step * (i + 0.5), y1: top + step * (i + 1.4) });
      });
      if (fresh.length) lastKey = key(fresh[fresh.length - 1]);
      tail = [...tail, ...fresh].slice(-3);
      onProgress({ page: n, pages, band: b + 1, bands, rows: rows.length, live: '' });
    }
  }
  if (!header) throw new Error('Gemma could not find the table headings on the first page.');
  return fromCells(header, rows);
}

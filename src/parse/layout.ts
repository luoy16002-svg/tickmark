// Positioned text from a PDF page, regrouped into printed lines and cells.

export interface TextItem {
  str: string;
  x0: number;
  x1: number;
  /** Baseline, measured from the top of the page (points). */
  y: number;
  /** Font size (points). */
  h: number;
  page: number;
}

export interface Cell {
  text: string;
  x0: number;
  x1: number;
}

export interface Line {
  page: number;
  y: number;
  h: number;
  cells: Cell[];
  /** The pieces of text as the PDF drew them, before neighbours were joined into cells. */
  items: Cell[];
  text: string;
}

/** Items on one baseline become a line; items closer than about half a character become one cell. */
export function toLines(items: TextItem[]): Line[] {
  const byPage = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    (byPage.get(it.page) ?? byPage.set(it.page, []).get(it.page)!).push(it);
  }
  const lines: Line[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const its = byPage.get(page)!.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    let cur: TextItem[] = [];
    let curY = -1e9;
    const flush = () => {
      if (cur.length) lines.push(makeLine(page, cur));
      cur = [];
    };
    for (const it of its) {
      const tol = Math.max(1.5, 0.45 * it.h);
      if (cur.length && Math.abs(it.y - curY) > tol) flush();
      if (!cur.length) curY = it.y;
      cur.push(it);
    }
    flush();
  }
  return lines;
}

function makeLine(page: number, items: TextItem[]): Line {
  items.sort((a, b) => a.x0 - b.x0);
  const h = Math.max(...items.map((i) => i.h));
  const cells: Cell[] = [];
  for (const it of items) {
    const last = cells[cells.length - 1];
    const gap = last ? it.x0 - last.x1 : Infinity;
    // a word space is up to 0.6 em in monospace fonts; a CR/DR/OD marker belongs to the amount before it
    const marker = /^(CR|DR|OD|-)$/i.test(it.str.trim()) && /\d[.,]\d{2}$/.test(last?.text.trim() ?? '');
    if (last && (gap < 0.65 * h || (marker && gap < 1.4 * h))) {
      last.text += (gap > 0.12 * h && !last.text.endsWith(' ') ? ' ' : '') + it.str;
      last.x1 = Math.max(last.x1, it.x1);
    } else {
      cells.push({ text: it.str, x0: it.x0, x1: it.x1 });
    }
  }
  for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
  const y = items.reduce((s, i) => s + i.y, 0) / items.length;
  const raw = items.map((i) => ({ text: i.str.trim(), x0: i.x0, x1: i.x1 })).filter((c) => c.text);
  return { page, y, h, cells: cells.filter((c) => c.text), items: raw, text: cells.map((c) => c.text).join(' ') };
}

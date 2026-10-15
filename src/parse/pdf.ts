// pdf.js text layer -> positioned items. Works with the browser build and with the legacy build in Node.
import type { TextItem } from './layout.ts';

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface PageInfo {
  page: number;
  width: number;
  height: number;
  /** Characters of real text on the page; near zero means a scan. */
  chars: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readItems(doc: any): Promise<{ items: TextItem[]; pages: PageInfo[] }> {
  const items: TextItem[] = [];
  const pages: PageInfo[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [vx0, vy0, vx1, vy1] = page.view as number[];
    const height = vy1 - vy0;
    const content = await page.getTextContent();
    let chars = 0;
    for (const raw of content.items as PdfTextItem[]) {
      if (!('str' in raw) || !raw.str) continue;
      const [a, b, c, d, e, f] = raw.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || raw.height || 8;
      const x0 = e - vx0;
      items.push({ str: raw.str, x0, x1: x0 + (raw.width || 0), y: height - (f - vy0), h: size, page: n });
      chars += raw.str.trim().length;
    }
    pages.push({ page: n, width: vx1 - vx0, height, chars });
    page.cleanup?.();
  }
  return { items, pages };
}

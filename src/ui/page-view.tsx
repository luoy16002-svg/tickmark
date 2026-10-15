// The bank's own page, drawn by pdf.js, with the rows Tickmark read marked on it.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PdfDoc } from '../core.ts';
import type { Transaction } from '../parse/statement.ts';
import { Icon } from './icons.tsx';

interface Props {
  doc: PdfDoc;
  page: number;
  pages: number;
  rows: Transaction[];
  focus: number | null;
  onPage: (n: number) => void;
  onPick: (id: number) => void;
}

export function PageView({ doc, page, pages, rows, focus, onPage, onPick }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [size, setSize] = useState({ w: 612, h: 792 });

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const width = wrap.current?.clientWidth ?? base.width;
      const s = width / base.width;
      const vp = p.getViewport({ scale: s * (window.devicePixelRatio || 1) });
      const c = canvas.current;
      if (!c || cancelled) return;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      setScale(s);
      setSize({ w: base.width, h: base.height });
      task = p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp }) as unknown as typeof task;
      await task!.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);

  useEffect(() => {
    if (focus === null) return;
    const el = wrap.current?.querySelector(`[data-row="${focus}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus, page]);

  const onThisPage = rows.filter((r) => r.page === page);
  return (
    <div class="page-view">
      <div class="page-nav">
        <button class="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <Icon name="arrowLeft" />
        </button>
        <span class="num">Page {page} of {pages}</span>
        <button class="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <Icon name="arrowRight" />
        </button>
      </div>
      <div class="bond" ref={wrap} style={{ aspectRatio: `${size.w} / ${size.h}` }}>
        <canvas ref={canvas} />
        {scale > 0 && onThisPage.map((r) => (
          <button
            key={r.id}
            data-row={r.id}
            class={`mark ${r.check} ${focus === r.id ? 'focus' : ''}`}
            style={{ top: `${(r.y0 / size.h) * 100}%`, height: `${((r.y1 - r.y0) / size.h) * 100}%` }}
            onClick={() => onPick(r.id)}
            aria-label={`Row ${r.id + 1}: ${r.description}`}
          />
        ))}
      </div>
    </div>
  );
}

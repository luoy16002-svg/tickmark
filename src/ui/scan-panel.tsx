import { useState } from 'preact/hooks';
import { gemma, hasWebGPU, type Progress } from '../ai/gemma.ts';
import { readScan, type ScanProgress } from '../ai/read-scan.ts';
import { categorise } from '../ai/rules.ts';
import type { Opened } from '../core.ts';
import { Icon } from './icons.tsx';

type Stage =
  | { kind: 'idle' }
  | { kind: 'loading'; p: Progress | null }
  | { kind: 'reading'; p: ScanProgress | null }
  | { kind: 'failed'; message: string };

export function ScanPanel({ opened, onRows }: { opened: Opened; onRows: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const gpu = hasWebGPU();

  const start = async () => {
    try {
      setStage({ kind: 'loading', p: null });
      await gemma((p) => setStage({ kind: 'loading', p }));
      setStage({ kind: 'reading', p: null });
      const parsed = await readScan(opened.doc, (p) => setStage({ kind: 'reading', p }));
      categorise(parsed.transactions);
      parsed.notes.push('Read from a scan by Gemma 4 on this computer. Every tick still comes from the arithmetic.');
      opened.parsed = parsed;
      onRows();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStage({ kind: 'failed', message: /buffer size|out of memory|device (was )?lost/i.test(msg) ? 'The graphics card ran out of memory for the model. Close other tabs that use the graphics card and try again.' : msg });
    }
  };

  return (
    <div class="ledger scan">
      <h2><Icon name="scan" /> This statement is a scan</h2>
      <p>
        Its pages are pictures, with no text to copy. Gemma 4, Google's open model, can read them on this computer:
        it writes down each row, and Tickmark checks every one against the balance printed beside it, so a figure
        the model misreads shows up as a row that does not tie.
      </p>
      {!gpu && (
        <p class="warn-line">This browser has no WebGPU, which Gemma needs. Chrome or Edge on a recent computer will do.</p>
      )}
      {stage.kind === 'idle' && (
        <>
          <p>The first time, the model is downloaded from Hugging Face: about 3.4 GB, kept in this browser afterwards. The statement itself is never sent anywhere.</p>
          <button class="solid" disabled={!gpu} onClick={start}>Read it with Gemma 4</button>
        </>
      )}
      {stage.kind === 'loading' && (
        <>
          <p class="progress-line">
            {stage.p && stage.p.total ? `Loading Gemma 4: ${(stage.p.loaded / 1e9).toFixed(2)} of ${(stage.p.total / 1e9).toFixed(2)} GB` : 'Starting Gemma 4'}
          </p>
          <div class="meter"><i style={{ width: `${stage.p?.progress ?? 2}%` }} /></div>
        </>
      )}
      {stage.kind === 'reading' && (
        <>
          <p class="progress-line">
            {stage.p ? `Page ${stage.p.page} of ${stage.p.pages}, band ${stage.p.band} of ${stage.p.bands}: ${stage.p.rows} rows so far` : 'Reading the first page'}
          </p>
          <div class="meter">
            <i style={{ width: `${stage.p ? (((stage.p.page - 1) * stage.p.bands + stage.p.band - 1) / (stage.p.pages * stage.p.bands)) * 100 : 1}%` }} />
          </div>
          {stage.p?.live && <pre class="live">{stage.p.live.split('\n').slice(-6).join('\n')}</pre>}
        </>
      )}
      {stage.kind === 'failed' && (
        <>
          <p class="warn-line">{stage.message}</p>
          <button class="solid" onClick={start}><Icon name="arrowCounterClockwise" /> Try again</button>
        </>
      )}
    </div>
  );
}

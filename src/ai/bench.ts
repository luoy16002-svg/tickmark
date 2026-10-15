// Runs the real scan pipeline (worker, bands, Gemma, balance check) on a sample scan and scores it against
// the sample's answer key. URL: probe2.html?file=harbor-pine-2026-09&bands=6&tokens=1120&pages=1
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { gemma } from './gemma.ts';
import { readScan } from './read-scan.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const q = new URLSearchParams(location.search);
const FILE = q.get('file') ?? 'harbor-pine-2026-09';
const out = document.getElementById('log')!;
const results: Record<string, unknown> = {};
(window as unknown as { __probe: unknown }).__probe = results;
const log = (s: string) => {
  out.textContent += s + '\n';
  results.log = out.textContent;
};

async function main() {
  const t0 = performance.now();
  await gemma();
  log(`model ready ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const data = await (await fetch(`/samples/${FILE}-scan.pdf`)).arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0 }).promise;
  const pages = Number(q.get('pages') ?? '0');
  const want = await (await fetch(`/samples/${FILE}.json`)).json();
  const t1 = performance.now();
  let lastBand = '';
  const raw: Record<string, string> = {};
  results.raw = raw;
  const parsed = await readScan(doc, (p) => {
    if (p.live) raw[`${p.page}.${p.band}`] = p.live;
    const tag = `${p.page}.${p.band}`;
    if (tag !== lastBand && !p.live) {
      lastBand = tag;
      log(`page ${p.page} band ${p.band}/${p.bands}: ${p.rows} rows, ${((performance.now() - t1) / 1000).toFixed(0)} s`);
    }
  }, { bands: Number(q.get('bands') ?? '6'), imageTokens: Number(q.get('tokens') ?? '1120'), maxPages: pages || undefined });
  const secs = (performance.now() - t1) / 1000;
  const got = parsed.transactions;
  const exp = want.transactions as { date: string; amount_cents: number; balance_cents: number | null; description: string }[];
  // score: rows in order whose amount and balance both match the answer key exactly
  // score: answer-key rows that a read row reproduces exactly (date, amount, and the balance when printed)
  const pool = [...got];
  let exact = 0;
  for (const e of exp) {
    const k = pool.findIndex((t) => t.date === e.date && t.amount === e.amount_cents && (e.balance_cents === null || t.balance === e.balance_cents));
    if (k >= 0) {
      exact++;
      pool.splice(k, 1);
    }
  }
  const covered = Math.min(exp.length, pages ? exp.filter((e) => true).length : exp.length);
  results.summary = {
    file: FILE, seconds: Math.round(secs), rowsRead: got.length, rowsInKey: covered, exactMatches: exact,
    tied: got.filter((t) => t.check === 'tied' || t.check === 'tied-day').length,
    off: got.filter((t) => t.check === 'off').length, status: parsed.status,
  };
  log('\nSUMMARY ' + JSON.stringify(results.summary));
  log(got.map((t) => `${t.check.padEnd(9)} ${t.date} ${(t.amount / 100).toFixed(2).padStart(10)} ${t.balance !== undefined ? (t.balance / 100).toFixed(2).padStart(10) : '          '} ${t.description.slice(0, 50)}`).join('\n'));
  log('\nDONE');
}

main().catch((e) => {
  log('RAW ' + JSON.stringify(results.raw ?? {}).slice(0, 3000));
  results.error = String(e?.stack ?? e);
  log('ERROR ' + results.error);
});

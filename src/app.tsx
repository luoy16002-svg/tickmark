import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { gemma, hasWebGPU } from './ai/gemma.ts';
import { CATEGORIES, type Category, payeeKey, remember } from './ai/rules.ts';
import { suggestCategories } from './ai/suggest.ts';
import { baseName, formatDate, formatMoney, type Opened, openStatement } from './core.ts';
import { buildExport, FORMATS, type Format } from './export/formats.ts';
import { type NetCount, watchNetwork } from './net.ts';
import { recheck, type Transaction } from './parse/statement.ts';
import { Icon, Ring, Tick } from './ui/icons.tsx';
import { PageView } from './ui/page-view.tsx';
import { ScanPanel } from './ui/scan-panel.tsx';

const SAMPLES = [
  { file: 'harbor-pine-2026-09.pdf', label: 'Harbor & Pine Credit Union', note: 'US, one signed amount column' },
  { file: 'northgate-2026-09.pdf', label: 'Northgate Bank', note: 'UK, paid out and paid in, overdrawn' },
  { file: 'aurelia-2026-09.pdf', label: 'Banca Aurelia', note: 'Italy, decimal commas, two dates' },
  { file: 'kestrel-2026-12.pdf', label: 'Kestrel Federal', note: 'CR and DR, one balance a day' },
  { file: 'bayside-2026-10.pdf', label: 'Bayside National', note: 'US, sections by kind, no running balance' },
  { file: 'redwood-2026-10.pdf', label: 'Redwood Valley', note: 'US, check numbers, credits and debits' },
  { file: 'lakemont-2026-10.pdf', label: 'Lakemont Bank', note: 'US, sections and a daily balance table' },
  { file: 'harbor-pine-2026-09-scan.pdf', label: 'Harbor & Pine, scanned', note: 'No text layer: Gemma 4 reads it' },
];

type View =
  | { kind: 'empty' }
  | { kind: 'reading'; name: string }
  | { kind: 'error'; name: string; message: string }
  | { kind: 'ready'; opened: Opened };

export function App() {
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [net, setNet] = useState<NetCount>({ external: 0, hosts: [], model: 0 });
  const [, setVersion] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState<'export' | 'samples' | null>(null);
  const [drag, setDrag] = useState(false);
  const [band, setBand] = useState<{ page: number; band: number; bands: number } | null>(null);
  const watcher = useRef<ReturnType<typeof watchNetwork> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    watcher.current = watchNetwork(setNet);
    return () => watcher.current?.stop();
  }, []);

  const open = async (data: ArrayBuffer, name: string) => {
    setMenu(null);
    setFocus(null);
    setPage(1);
    setView({ kind: 'reading', name });
    watcher.current?.reset();
    try {
      const opened = await openStatement(data, name);
      setView({ kind: 'ready', opened });
    } catch (e) {
      setView({ kind: 'error', name, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const openFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) {
      setView({ kind: 'error', name: f.name, message: 'This is not a PDF. Download the statement from your bank as a PDF and open that.' });
      return;
    }
    await open(await f.arrayBuffer(), f.name);
  };

  const openSample = async (file: string) => {
    const res = await fetch(new URL(`samples/${file}`, document.baseURI));
    await open(await res.arrayBuffer(), file);
  };

  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDrag(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDrag(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDrag(false);
      openFile(e.dataTransfer?.files?.[0]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const ready = view.kind === 'ready' ? view.opened : null;

  const download = (fmt: Format) => {
    if (!ready) return;
    const file = buildExport(fmt, ready.parsed, baseName(ready.name));
    const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setMenu(null);
  };

  return (
    <div class={`desk ${drag ? 'dragging' : ''}`}>
      <header class="bar">
        <div class="brand">
          <Tick />
          <span>Tickmark</span>
        </div>
        <div class="actions">
          <button class="quiet" onClick={() => fileInput.current?.click()}>
            <Icon name="filePdf" /> Open<span class="long"> a statement</span>
          </button>
          <div class="menu-wrap">
            <button class="quiet" onClick={() => setMenu(menu === 'samples' ? null : 'samples')} aria-expanded={menu === 'samples'}>
              Samples <Icon name="caretDown" size={14} />
            </button>
            {menu === 'samples' && (
              <div class="menu" role="menu">
                {SAMPLES.map((s) => (
                  <button role="menuitem" key={s.file} onClick={() => openSample(s.file)}>
                    <span>{s.label}</span>
                    <small>{s.note}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div class="menu-wrap">
            <button class="solid" disabled={!ready || ready.parsed.transactions.length === 0} onClick={() => setMenu(menu === 'export' ? null : 'export')} aria-expanded={menu === 'export'}>
              <Icon name="downloadSimple" /> Export
            </button>
            {menu === 'export' && ready && (
              <div class="menu right" role="menu">
                {ready.parsed.status === 'off' && (
                  <p class="menu-warn">Some rows do not tie yet. The export marks them so you can check them.</p>
                )}
                {FORMATS.map((f) => (
                  <button role="menuitem" key={f.id} onClick={() => download(f.id)}>
                    <span>{f.label}</span>
                    <small>{f.note}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => openFile((e.target as HTMLInputElement).files?.[0])} />
      </header>

      {view.kind === 'empty' && <Welcome onOpen={() => fileInput.current?.click()} onSample={openSample} />}
      {view.kind === 'reading' && <Reading name={view.name} />}
      {view.kind === 'error' && <Failed name={view.name} message={view.message} onOpen={() => fileInput.current?.click()} />}
      {ready && (
        <main class="work">
          <section class="sheet-bond" aria-label="The statement">
            <PageView
              doc={ready.doc}
              page={page}
              pages={ready.pages.length}
              rows={ready.parsed.transactions}
              focus={focus}
              onPage={setPage}
              onPick={(id) => setFocus(id)}
              band={band}
            />
          </section>
          <section class="sheet-pad" aria-label="The ledger">
            {ready.scanned && ready.parsed.transactions.length === 0 ? (
              <ScanPanel opened={ready} onRows={() => bump()} onBand={(b) => {
                setBand(b);
                if (b && b.page !== page) setPage(b.page);
              }} />
            ) : (
              <Ledger
                opened={ready}
                focus={focus}
                onFocus={(id) => {
                  setFocus(id);
                  const t = ready.parsed.transactions[id];
                  if (t && t.page !== page) setPage(t.page);
                }}
                onChange={bump}
              />
            )}
          </section>
        </main>
      )}

      <footer class="foot">
        <Icon name="shieldCheck" size={16} />
        {!ready && net.external === 0 ? (
          <span>Requests to other sites from this page: <b class="num">0</b>. Open a statement and watch this number.</span>
        ) : net.external === 0 ? (
          <span>Requests to other sites since you opened this file: <b class="num">0</b>. The statement is read in this tab.</span>
        ) : (
          <span class="warn">Requests to other sites since you opened this file: <b class="num">{net.external}</b> ({net.hosts.join(', ')})</span>
        )}
        {net.model > 0 && <span class="model-net">Gemma 4 model files fetched from Hugging Face: <b class="num">{net.model}</b></span>}
      </footer>
    </div>
  );
}

function Welcome({ onOpen, onSample }: { onOpen: () => void; onSample: (f: string) => void }) {
  return (
    <main class="welcome">
      <div class="pad-blank">
        <h1>Bank statements into spreadsheets, checked row by row.</h1>
        <p>
          Open a PDF statement. Tickmark copies every transaction into a ledger and adds it to the running balance.
          A row gets a tick only when the balance the bank printed agrees to the cent.
        </p>
        <div class="welcome-actions">
          <button class="solid big" onClick={onOpen}>
            <Icon name="filePdf" /> Open a statement
          </button>
          <span class="or">or drop a PDF anywhere on this page</span>
        </div>
        <div class="example" aria-label="How a row is checked">
          <div class="ex-row">
            <span class="num">23,256.93</span>
            <span class="op">balance before</span>
          </div>
          <div class="ex-row">
            <span class="num">&minus;27.32</span>
            <span class="op">Joe's Hardware</span>
          </div>
          <div class="ex-row total">
            <span class="num">23,229.61</span>
            <span class="op">printed by the bank</span>
            <Tick />
          </div>
        </div>
        <ul class="facts">
          <li>The file is read inside this browser tab. Nothing is uploaded; the counter at the bottom shows every request this page makes.</li>
          <li>Exports to Excel, CSV, QuickBooks Online, Xero and OFX.</li>
          <li>Scanned statements are read by Gemma 4, Google's open model, running on this computer.</li>
        </ul>
        <div class="samples">
          <span>No statement to hand? Open a made-up one:</span>
          {SAMPLES.slice(0, 4).map((s) => (
            <button class="link" key={s.file} onClick={() => onSample(s.file)}>{s.label}</button>
          ))}
        </div>
      </div>
    </main>
  );
}

function Reading({ name }: { name: string }) {
  return (
    <main class="welcome">
      <div class="pad-blank reading" aria-busy="true">
        <p class="reading-name">Reading {name}</p>
        {Array.from({ length: 9 }, (_, i) => (
          <div class="skeleton-row" key={i} style={{ animationDelay: `${i * 70}ms` }} />
        ))}
      </div>
    </main>
  );
}

function Failed({ name, message, onOpen }: { name: string; message: string; onOpen: () => void }) {
  return (
    <main class="welcome">
      <div class="pad-blank">
        <h2><Icon name="warningCircle" /> {name} could not be read</h2>
        <p>{/password/i.test(message) ? 'The PDF is protected with a password. Open it in your PDF viewer, save a copy without the password, and open that copy here.' : message}</p>
        <button class="solid" onClick={onOpen}><Icon name="filePdf" /> Open another statement</button>
      </div>
    </main>
  );
}

function Ledger({ opened, focus, onFocus, onChange }: {
  opened: Opened;
  focus: number | null;
  onFocus: (id: number) => void;
  onChange: () => void;
}) {
  const p = opened.parsed;
  const d = p.decimal;
  const off = p.transactions.filter((t) => t.check === 'off');
  const tied = p.transactions.filter((t) => t.check === 'tied' || t.check === 'tied-day').length;
  const worked = p.opening !== undefined ? p.opening + p.totals.in - p.totals.out : undefined;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === null) return;
    listRef.current?.querySelector(`[data-id="${focus}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);

  const setCategory = (t: Transaction, c: Category) => {
    remember(t.description, c);
    const key = payeeKey(t.description);
    for (const o of p.transactions) {
      if (o === t || (payeeKey(o.description) === key && o.categoryFrom !== 'you')) {
        o.category = c;
        o.categoryFrom = 'you';
      }
    }
    onChange();
  };

  const removeRow = (t: Transaction) => {
    p.transactions = p.transactions.filter((o) => o !== t).map((o, i) => ({ ...o, id: i }));
    recheck(p);
    onChange();
  };

  const fixAmount = (t: Transaction, value: string) => {
    const n = Math.round(Number(value.replace(/[^\d.-]/g, '')) * 100);
    if (!Number.isFinite(n) || n === 0) return;
    t.amount = n;
    t.signFrom = 'marker';
    recheck(p);
    onChange();
  };

  if (p.transactions.length === 0) {
    return (
      <div class="ledger empty-ledger">
        <h2>No transactions found</h2>
        <p>{p.notes[0] ?? 'This PDF has text, but no table with dates and amounts that Tickmark recognises.'}</p>
      </div>
    );
  }

  return (
    <div class="ledger">
      <div class="ledger-head">
        <div>
          <h2>{opened.name}</h2>
          <p class="sub num">
            {p.period ? `${p.period.start ? formatDate(p.period.start) + ' to ' : 'to '}${formatDate(p.period.end)}` : 'Period not printed'}
            {p.currency ? `  ${p.currency}` : ''}
          </p>
        </div>
        <p class={`verdict ${p.status}`}>
          {p.status === 'ties' && <>Every row ties to the printed balance.</>}
          {p.status === 'off' && <>{off.length} {off.length === 1 ? 'row does' : 'rows do'} not tie. Check {off.length === 1 ? 'it' : 'them'} against the page.</>}
          {p.status === 'unchecked' && <>This statement prints no balances, so the rows cannot be checked.</>}
        </p>
        <CategoryAssist rows={p.transactions} onChange={onChange} />
      </div>

      <div class="cols" role="row">
        <span class="c-tick" role="columnheader"><span class="sr">Check</span></span>
        <span class="c-date" role="columnheader">Date</span>
        <span class="c-desc" role="columnheader">Description</span>
        <span class="c-cat" role="columnheader">Category</span>
        <span class="c-out" role="columnheader">Out</span>
        <span class="c-in" role="columnheader">In</span>
        <span class="c-bal" role="columnheader">Balance</span>
      </div>

      <div class="rows" role="table" ref={listRef}>
        {p.opening !== undefined && (
          <div class="row carried" role="row">
            <span class="c-tick" />
            <span class="c-date" />
            <span class="c-desc">Opening balance</span>
            <span class="c-cat" />
            <span class="c-out" />
            <span class="c-in" />
            <span class="c-bal num">{formatMoney(p.opening, d)}</span>
          </div>
        )}
        {p.transactions.map((t) => (
          <div
            key={t.id}
            data-id={t.id}
            role="row"
            class={`row ${t.check} ${focus === t.id ? 'focus' : ''}`}
            onClick={() => onFocus(t.id)}
          >
            <span class="c-tick" title={tickTitle(t)}>
              {t.check === 'tied' && <Tick />}
              {t.check === 'tied-day' && <Tick day />}
              {t.check === 'off' && <Icon name="warningCircle" size={16} />}
            </span>
            <span class="c-date num" title={formatDate(t.date)}>{shortDate(t.date)}</span>
            <span class="c-desc" title={t.description}>
              <span class="desc-text">
                {t.code && <span class="code">{t.code}</span>}
                {t.description}
              </span>
            </span>
            <span class="c-cat">
              <label class={`cat ${t.categoryFrom ?? 'none'}`}>
                <span class="sr">Category</span>
                <select value={t.category ?? ''} onChange={(e) => setCategory(t, (e.target as HTMLSelectElement).value as Category)} onClick={(e) => e.stopPropagation()} title={t.categoryFrom === 'model' ? 'Suggested by Gemma 4' : t.categoryFrom === 'rule' ? 'From a rule' : undefined}>
                  <option value="" disabled>Choose</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <Icon name="caretDown" size={12} />
              </label>
            </span>
            <span class="c-out num">{t.amount < 0 ? formatMoney(-t.amount, d) : ''}</span>
            <span class="c-in num">{t.amount > 0 ? formatMoney(t.amount, d) : ''}</span>
            <span class="c-bal num">
              {t.balance !== undefined ? formatMoney(t.balance, d) : ''}
              {t.check === 'off' && <Ring />}
            </span>
            {(t.check === 'off' || focus === t.id) && (
              <div class={`note ${t.check === 'off' ? '' : 'neutral'}`} onClick={(e) => e.stopPropagation()}>
                {t.check === 'off' && t.diff !== undefined ? (
                  <p>
                    The bank printed <b class="num">{formatMoney(t.balance, d)}</b>; the rows above add up to{' '}
                    <b class="num">{formatMoney((t.balance ?? 0) - (t.diff ?? 0), d)}</b>, a gap of <b class="num">{formatMoney(t.diff, d)}</b>.
                    Look at this row on the page. If an amount was misread, type the right one:
                  </p>
                ) : t.check === 'off' ? (
                  <p>This day's rows do not add up to the balance printed at its end. Look at them on the page and correct the one that differs:</p>
                ) : (
                  <p>Correct this row if it differs from the page. The ledger checks it again at once.</p>
                )}
                <form onSubmit={(e) => {
                  e.preventDefault();
                  const v = (e.currentTarget.elements.namedItem('amt') as HTMLInputElement).value;
                  fixAmount(t, v);
                }}>
                  <label>
                    <span>Amount (minus for money out)</span>
                    <input name="amt" inputMode="decimal" defaultValue={(t.amount / 100).toFixed(2)} />
                  </label>
                  <button class="solid" type="submit">Check again</button>
                  <button class="quiet-ink" type="button" onClick={() => removeRow(t)}>Not on the statement: remove</button>
                </form>
              </div>
            )}
          </div>
        ))}
      </div>

      <div class="footing">
        <dl>
          <div><dt>Opening balance</dt><dd class="num">{p.opening !== undefined ? formatMoney(p.opening, d) : 'not printed'}</dd></div>
          <div><dt>Money in</dt><dd class="num">{formatMoney(p.totals.in, d)}</dd></div>
          <div><dt>Money out</dt><dd class="num">{formatMoney(-p.totals.out, d)}</dd></div>
          <div class="sum"><dt>Closing, added up</dt><dd class="num">{worked !== undefined ? formatMoney(worked, d) : ''}</dd></div>
          <div><dt>Closing, as printed</dt><dd class="num">{p.closing !== undefined ? formatMoney(p.closing, d) : (p.transactions.at(-1)?.balance !== undefined ? formatMoney(p.transactions.at(-1)!.balance, d) : 'not printed')}</dd></div>
        </dl>
        {p.status === 'ties' && (
          <div class="stamp" aria-label="Reconciled">
            <span class="stamp-word">Reconciled</span>
            <span class="stamp-line num">{tied} of {p.transactions.length} rows</span>
          </div>
        )}
      </div>
      {p.notes.length > 0 && <p class="notes">{p.notes.join(' ')}</p>}
    </div>
  );
}

function CategoryAssist({ rows, onChange }: { rows: Transaction[]; onChange: () => void }) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'loading'; pct: number } | { kind: 'working' } | { kind: 'done'; n: number } | { kind: 'failed'; msg: string }>({ kind: 'idle' });
  const open = rows.filter((t) => !t.category).length;
  if (!open && state.kind !== 'done') return null;
  const run = async () => {
    try {
      setState({ kind: 'loading', pct: 0 });
      await gemma((pr) => setState({ kind: 'loading', pct: pr.progress }));
      setState({ kind: 'working' });
      const n = await suggestCategories(rows, onChange);
      setState({ kind: 'done', n });
      onChange();
    } catch (e) {
      setState({ kind: 'failed', msg: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div class="assist">
      {state.kind === 'idle' && (
        <button class="quiet-ink" disabled={!hasWebGPU()} onClick={run} title="Runs Gemma 4 on this computer. The first time it downloads the model (3.4 GB) from Hugging Face.">
          <Icon name="tag" size={15} /> Suggest {open} {open === 1 ? 'category' : 'categories'} with Gemma 4
        </button>
      )}
      {state.kind === 'loading' && <span class="num">Loading Gemma 4: {Math.round(state.pct)}%</span>}
      {state.kind === 'working' && <span>Gemma 4 is reading the descriptions</span>}
      {state.kind === 'done' && <span>Gemma 4 suggested {state.n}. Suggestions are in italics until you choose.</span>}
      {state.kind === 'failed' && <span class="warn-line">{state.msg}</span>}
    </div>
  );
}

function shortDate(iso: string): string {
  return formatDate(iso).replace(/ \d{4}$/, '');
}

function tickTitle(t: Transaction): string {
  switch (t.check) {
    case 'tied': return t.signFrom === 'balance' ? 'Ties: the balance printed on this row agrees to the cent (in or out was read from the balance)' : 'Ties: the balance printed on this row agrees to the cent';
    case 'tied-day': return 'Ties with the rest of its day at the day’s closing balance';
    case 'off': return 'Does not tie';
    default: return 'Nothing printed to check this row against';
  }
}

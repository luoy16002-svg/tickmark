// A bank statement's text -> transactions, each checked against the running balance the bank printed.
import { type Cell, type Line, type TextItem, toLines } from './layout.ts';
import {
  type Decimal, type Money, type PartialDate, findPeriod, guessDecimal, parseDate, parseMoney, placeInPeriod,
} from './tokens.ts';

export type ColKind = 'date' | 'date2' | 'desc' | 'debit' | 'credit' | 'amount' | 'balance';
export interface Column {
  kind: ColKind;
  label: string;
  x0: number;
  x1: number;
}

/** tied: this row's printed balance agrees to the cent. tied-day: checked together with the other rows of its
 *  day at the day's closing balance. off: the arithmetic does not agree. unchecked: nothing printed to check. */
export type Check = 'tied' | 'tied-day' | 'off' | 'unchecked';

export interface Transaction {
  id: number;
  page: number;
  y0: number;
  y1: number;
  date: string;
  valueDate?: string;
  code?: string;
  description: string;
  /** Signed cents: money in is positive. */
  amount: number;
  /** The balance printed on this row, signed cents. */
  balance?: number;
  signFrom: 'column' | 'marker' | 'section' | 'balance' | 'guess';
  check: Check;
  /** Printed balance minus the running balance, in cents, on the row where a gap shows. */
  diff?: number;
  category?: string;
  categoryFrom?: 'rule' | 'model' | 'you';
}

export interface Checkpoint {
  kind: 'opening' | 'brought' | 'carried' | 'closing';
  cents: number;
  page: number;
  y: number;
  label: string;
  ok?: boolean;
}

export interface Parsed {
  transactions: Transaction[];
  opening?: number;
  closing?: number;
  period: { start?: string; end: string } | null;
  decimal: Decimal;
  currency?: string;
  columns: Column[];
  checkpoints: Checkpoint[];
  totals: { in: number; out: number };
  status: 'ties' | 'off' | 'unchecked' | 'empty';
  notes: string[];
}

const HEAD: [ColKind, RegExp][] = [
  ['balance', /\bbalance\b|^saldo$/i],
  ['date2', /^(value date|effective date|value|valuta)$/i],
  ['date', /^(date|posted|posting date|post date|posted date|trans(action)?\.? date|booking date|txn date|tran date|date posted|date paid|entry date|data)$/i],
  ['debit', /(withdraw|debit|paid out|money out)|^(payments?( out)?|charges|out|dare|soll|uscite)$/i],
  ['credit', /(deposit|credit|paid in|money in)|^(receipts|in|avere|haben|entrate)$/i],
  ['amount', /^(amount|transaction amount|amount \(.*\)|importo|betrag)$/i],
  ['desc', /(description|details|transaction|narrative|particulars|payee|memo|payment type|descrizione)/i],
];
const NUMERIC: ColKind[] = ['debit', 'credit', 'amount', 'balance'];
const OPENING = /(balance brought forward|brought forward|opening balance|beginning balance|previous balance|starting balance|balance forward|balance b\/f|saldo iniziale)/i;
const CARRIED = /(balance carried forward|carried forward|balance c\/f)/i;
const CLOSING = /(closing balance|ending balance|new balance|balance at end|saldo finale)/i;
const TOTALS = /^(total|totals|subtotal|sum)\b/i;
// section titles some banks print instead of one table; the money in a section goes one way
const SECTION_IN = /^(deposits?( and (other )?(additions|credits))?|credits|additions|other credits|money in)$/i;
const SECTION_OUT = /^(withdrawals?( and (other )?(subtractions|debits))?|checks( paid)?|cheques( paid)?|atm (&|and) debit card withdrawals|card purchases|electronic withdrawals|other withdrawals|other debits|debits|fees|service (fees|charges)|payments)$/i;
const SECTION_DAILY = /^daily (ending )?balances?( summary)?$/i;
// lines of an account summary box, which a reader of a scan may copy as if they were rows
const SUMMARY = /(deposits and (other )?credits|withdrawals and (other )?debits|total (deposits|withdrawals|credits|debits|money in|money out|paid in|paid out)|^(deposits|withdrawals|credits|debits|money in|money out)$|number of (deposits|withdrawals|transactions)|average (daily )?balance)/i;
const CODES = new Set(['DD', 'SO', 'BP', 'CR', 'DR', 'VIS', 'TFR', 'FPI', 'FPO', 'CHG', 'CHQ', 'ATM', 'POS', 'DEB', 'BGC',
  'OBP', 'COR', 'PAY', 'DEP', 'ITL', 'IBP', 'DPC', 'CPT', 'INT', 'FEE', 'BCC', 'C/L', ')))']);

export function kindOf(text: string): ColKind | null {
  const t = text.trim();
  for (const [k, re] of HEAD) if (re.test(t)) return k;
  return null;
}

function headerColumns(line: Line): Column[] | null {
  // headings set close together get joined into one cell ("Check NumberDescription"); the pieces as drawn keep
  // them apart, so read both ways and keep whichever finds more columns
  const a = columnsOf(line.cells);
  const b = line.items?.length ? columnsOf(line.items) : null;
  if (a && b) return new Set(b.map((c) => c.kind)).size > new Set(a.map((c) => c.kind)).size ? b : a;
  return a ?? b;
}

// Headings a PDF ran together into one piece of text ("Deposits/Credits Withdrawals/Debits") are split again at
// the phrases banks use, each part placed by its share of the characters.
const HEADING_PHRASES = /(ending daily balance|daily balance|running balance|balance|deposits?\s*\/\s*credits?|withdrawals?\s*\/\s*debits?|debits?\s*\/\s*withdrawals?|credits?\s*\/\s*deposits?|deposits?|withdrawals?|credits?|debits?|paid out|paid in|money out|money in|payment type and details|transaction details|description|details|check number|check no\.?|date paid|posting date|booking date|value date|date|amount)/gi;

function splitHeading(c: Cell): Cell[] {
  const found = [...c.text.matchAll(HEADING_PHRASES)];
  if (found.length < 2) return [c];
  const kinds = new Set(found.map((m) => kindOf(m[0]) ?? m[0].toLowerCase()));
  if (kinds.size < 2) return [c];
  const per = (c.x1 - c.x0) / Math.max(1, c.text.length);
  const starts = found.map((m) => m.index!);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : c.text.length;
    const text = c.text.slice(start, end).trim();
    return { text, x0: c.x0 + start * per, x1: c.x0 + (start + text.length) * per };
  });
}

function columnsOf(cells: Cell[]): Column[] | null {
  const cols: Column[] = [];
  for (const c of cells.flatMap(splitHeading)) {
    const k = kindOf(c.text);
    if (k) cols.push({ kind: k, label: c.text, x0: c.x0, x1: c.x1 });
  }
  const kinds = new Set(cols.map((c) => c.kind));
  const hasDate = kinds.has('date');
  const hasMoney = NUMERIC.some((k) => kinds.has(k));
  if (!hasDate || !hasMoney || kinds.size < 3) return null;
  // two date columns: the left one is the transaction date
  const dates = cols.filter((c) => c.kind === 'date').sort((a, b) => a.x0 - b.x0);
  if (dates.length > 1) for (const d of dates.slice(1)) d.kind = 'date2';
  return cols.sort((a, b) => a.x0 - b.x0);
}

function numericColumn(cell: Cell, cols: Column[]): Column | null {
  let best: Column | null = null;
  let bestD = Infinity;
  for (const c of cols) {
    if (!NUMERIC.includes(c.kind)) continue;
    const d = Math.min(Math.abs(cell.x1 - c.x1), Math.abs((cell.x0 + cell.x1) / 2 - (c.x0 + c.x1) / 2));
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best && bestD < 42 ? best : null;
}

interface RawRow {
  kind: 'tx' | 'cp' | 'cont';
  /** +1 or -1 when the row sits under a section title that says which way its money goes. */
  section?: number;
  line: Line;
  date?: PartialDate;
  valueDate?: PartialDate;
  desc: string[];
  code?: string;
  amount?: Money & { col: ColKind };
  balance?: Money;
  cp?: Checkpoint['kind'];
}

export function parseStatement(items: TextItem[]): Parsed {
  const lines = toLines(items);
  const allText = lines.map((l) => l.text).join('\n');
  const decimal = guessDecimal(lines.flatMap((l) => l.cells.map((c) => c.text)));
  const period = findPeriod(lines.filter((l) => l.page <= 2).map((l) => l.text).join(' '));
  const currency = guessCurrency(allText);
  const notes: string[] = [];

  // 1. find the table header on each page; pages without one reuse the last header's columns
  let cols: Column[] | null = null;
  const headerAt = new Map<number, number>(); // page -> y of its header
  const colsByPage = new Map<number, Column[]>();
  for (const l of lines) {
    if (headerAt.has(l.page)) continue;
    const h = headerColumns(l);
    if (h) {
      headerAt.set(l.page, l.y);
      colsByPage.set(l.page, h);
      cols = cols ?? h;
    }
  }
  if (!cols) {
    return {
      transactions: [], period, decimal, currency, columns: [], checkpoints: [], totals: { in: 0, out: 0 },
      status: 'empty', notes: ['No transaction table header (Date … Balance) was found in the text of this file.'],
    };
  }

  // date order for numbers like 09/11: settle it once for the statement
  const order = dateOrder(lines, cols, period, currency);

  // 2. classify every line inside the tables
  const rows: RawRow[] = [];
  const summaryOpening: number[] = [];
  const summaryClosing: number[] = [];
  const daily: { date: PartialDate; cents: number }[] = [];
  let pageCols = cols;
  let prev: RawRow | null = null;
  let section = 0;
  let inDaily = false;
  let started = false;
  for (const l of lines) {
    // every heading line sets the columns for what follows it, across page breaks, until the next heading
    const heading = headerColumns(l);
    if (heading) {
      pageCols = heading;
      started = true;
      inDaily = false;
      prev = null;
      continue;
    }
    const top = started ? -Infinity : headerAt.get(l.page);
    // a section title (no figures on the line) says which way the money below it goes, or opens the daily balances
    const hasMoney = l.cells.some((c) => parseMoney(c.text, decimal));
    if (!hasMoney && l.text.length < 60) {
      if (SECTION_DAILY.test(l.text)) {
        inDaily = true;
        prev = null;
        continue;
      }
      if (SECTION_IN.test(l.text) || SECTION_OUT.test(l.text)) {
        section = SECTION_IN.test(l.text) ? 1 : -1;
        inDaily = false;
        prev = null;
        continue;
      }
    }
    if (inDaily) {
      // date and balance pairs, often three to a line
      let d: PartialDate | null = null;
      for (const c of l.cells) {
        const pd = parseDate(c.text, order);
        if (pd) d = pd;
        else if (d) {
          const m = parseMoney(c.text, decimal);
          if (m) {
            daily.push({ date: d, cents: signed(m) });
            d = null;
          }
        }
      }
      continue;
    }

    if (top === undefined || l.y <= top + 0.5) {
      // above the table: summary boxes may hold the opening and closing balances
      const money = l.cells.map((c) => parseMoney(c.text, decimal)).filter(Boolean) as Money[];
      const m = money[money.length - 1];
      if (m && OPENING.test(l.text)) summaryOpening.push(signed(m));
      else if (m && CLOSING.test(l.text)) summaryClosing.push(signed(m));
      else {
        const inline = l.text.match(/(?:opening|beginning|previous) balance[^\d-]*(-?[\d.,]+\d)/i);
        const pm = inline && parseMoney(inline[1], decimal);
        if (pm) summaryOpening.push(signed(pm));
      }
      if (l.page === 1 || top === undefined) continue;
      continue;
    }
    const row = classify(l, pageCols, decimal, order);
    if (!row) {
      prev = null;
      continue;
    }
    if (section) row.section = section;
    if (row.kind === 'cont') {
      const last = rows[rows.length - 1];
      const close: boolean = !!prev && prev.line.page === l.page && l.y - prev.line.y <= 2.1 * Math.max(l.h, prev.line.h);
      if (last && last.kind === 'tx' && close) {
        last.desc.push(...row.desc);
        last.line = { ...last.line, y: last.line.y }; // keep the first line as the anchor
        (last as RawRow & { lastY?: number }).lastY = l.y;
      }
      prev = close ? row : null;
      continue;
    }
    rows.push(row);
    prev = row;
  }

  // 3. build transactions in document order, carrying dates forward for same-day rows
  const transactions: Transaction[] = [];
  const checkpoints: Checkpoint[] = [];
  const seq: ({ t: 'tx'; i: number } | { t: 'cp'; i: number })[] = [];
  let lastDate: PartialDate | undefined;
  for (const r of rows) {
    if (r.kind === 'cp') {
      if (!r.balance) continue;
      checkpoints.push({ kind: r.cp!, cents: signed(r.balance), page: r.line.page, y: r.line.y, label: r.desc.join(' ') });
      seq.push({ t: 'cp', i: checkpoints.length - 1 });
      continue;
    }
    const date = r.date ?? lastDate;
    if (!date) continue;
    lastDate = date;
    if (!r.amount) {
      // a dated line whose amount sits on a later line is merged below; a lone date line is skipped
      continue;
    }
    const a = r.amount;
    const sign = a.col === 'debit' ? -1 : a.col === 'credit' ? 1 : a.sign || r.section || 0;
    const y1 = (r as RawRow & { lastY?: number }).lastY ?? r.line.y;
    transactions.push({
      id: transactions.length,
      page: r.line.page,
      y0: r.line.y - r.line.h,
      y1: y1 + 0.35 * r.line.h,
      date: placeInPeriod(date, period),
      valueDate: r.valueDate ? placeInPeriod(r.valueDate, period) : undefined,
      code: r.code,
      description: r.desc.join(' ').replace(/\s+/g, ' ').trim(),
      amount: (sign || 1) * a.cents,
      balance: r.balance ? signed(r.balance) : undefined,
      signFrom: a.col === 'debit' || a.col === 'credit' ? 'column' : a.sign ? 'marker' : r.section ? 'section' : 'guess',
      check: 'unchecked',
    });
    seq.push({ t: 'tx', i: transactions.length - 1 });
  }

  // 3b. balances printed only in a separate daily table: rows go in date order, each day's last row gets the
  //     day's closing balance, and the usual walk checks them
  if (daily.length && !transactions.some((t) => t.balance !== undefined)) {
    const byDay = new Map(daily.map((d) => [placeInPeriod(d.date, period), d.cents]));
    const sorted = transactions.map((t, i) => ({ t, i })).sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i).map((x) => x.t);
    sorted.forEach((t, i) => {
      t.id = i;
      const next = sorted[i + 1];
      if ((!next || next.date !== t.date) && byDay.has(t.date)) t.balance = byDay.get(t.date);
    });
    transactions.splice(0, transactions.length, ...sorted);
    seq.splice(0, seq.length, ...sorted.map((_, i) => ({ t: 'tx' as const, i })));
    checkpoints.length = 0;
    notes.push('Balances are printed once a day in a separate table; rows are listed by date and checked day by day.');
  }

  // 4. opening and closing balances
  const firstCp = checkpoints.find((c) => c.kind === 'opening' || c.kind === 'brought');
  let opening = summaryOpening[0] ?? (firstCp && seq[0]?.t === 'cp' ? firstCp.cents : undefined);
  const lastCp = [...checkpoints].reverse().find((c) => c.kind === 'closing' || c.kind === 'carried');
  const closing = summaryClosing[0] ?? (lastCp && seq[seq.length - 1]?.t === 'cp' ? lastCp.cents : undefined);
  if (opening === undefined) {
    const first = transactions.find((t) => t.balance !== undefined);
    if (first && first === transactions[0] && first.signFrom !== 'guess') {
      opening = first.balance! - first.amount;
      notes.push('No opening balance is printed; it was worked back from the first row.');
    }
  }

  // 5. walk the rows with a running balance
  reconcile(transactions, checkpoints, seq, opening, closing);

  const totals = transactions.reduce((s, t) => (t.amount > 0 ? { ...s, in: s.in + t.amount } : { ...s, out: s.out - t.amount }), { in: 0, out: 0 });
  const off = transactions.some((t) => t.check === 'off') || checkpoints.some((c) => c.ok === false);
  const checked = transactions.some((t) => t.check === 'tied' || t.check === 'tied-day');
  return {
    transactions, opening, closing, period, decimal, currency, columns: cols, checkpoints, totals,
    status: transactions.length === 0 ? 'empty' : off ? 'off' : checked ? 'ties' : 'unchecked',
    notes,
  };
}

export interface ReadRow {
  cells: string[];
  page: number;
  y0: number;
  y1: number;
}

/** Rows read off a scanned page (by the model) -> the same checked ledger as a text PDF gets. The header is
 *  the table's own column headings, in order; each row lists its cells in the same order. */
export function fromCells(header: string[], rows: ReadRow[], periodHint?: { start?: string; end: string } | null): Parsed {
  // the statement period, from whatever words the reader copied (a heading, the summary box)
  periodHint = periodHint ?? findPeriod(rows.map((r) => r.cells.join(' ')).join(' '));
  const kinds = header.map((h) => kindOf(h));
  if (kinds.filter((k) => k === 'date').length > 1) kinds[kinds.lastIndexOf('date')] = 'date2';
  const decimal = guessDecimal(rows.flatMap((r) => r.cells));
  const iDate = kinds.indexOf('date');
  const order: 'md' | 'dm' = rows.some((r) => /^(1[3-9]|2\d|3[01])[/.]/.test(r.cells[iDate] ?? '')) ? 'dm' : 'md';
  const transactions: Transaction[] = [];
  const checkpoints: Checkpoint[] = [];
  const seq: ({ t: 'tx'; i: number } | { t: 'cp'; i: number })[] = [];
  let lastDate: PartialDate | undefined;
  const iDesc = Math.max(0, kinds.indexOf('desc'));
  const iBal = kinds.indexOf('balance');
  const moneyCols = kinds.map((k, i) => (k === 'debit' || k === 'credit' || k === 'amount' ? i : -1)).filter((i) => i >= 0);
  const cell = (r: ReadRow, i: number) => (i >= 0 ? r.cells[i] ?? '' : '').trim();
  // Repairs a reader needs and the arithmetic can prove: (1) the same row read twice where two bands overlap
  // (a non-zero amount cannot leave the balance unchanged); (2) the second printed line of a description read as
  // a row of its own, carrying the line above's balance in its amount column.
  const cleaned: ReadRow[] = [];
  for (const r of rows) {
    const prev = cleaned[cleaned.length - 1];
    if (prev && iBal >= 0 && cell(r, iBal) && r.cells.join('|') === prev.cells.join('|')) continue;
    if (prev && iBal >= 0) {
      const amounts = moneyCols.map((i) => cell(r, i)).filter(Boolean);
      const carriesBalance = amounts.length === 1 && amounts[0] === cell(prev, iBal) && !cell(r, iBal);
      const textOnly = !cell(r, iDate) && amounts.length === 0 && !cell(r, iBal) && cell(r, iDesc) && !OPENING.test(r.cells.join(' ')) && !CLOSING.test(r.cells.join(' ')) && !CARRIED.test(r.cells.join(' '));
      if (carriesBalance || textOnly) {
        prev.cells = prev.cells.map((c, i) => (i === iDesc ? `${c} ${cell(r, iDesc)}`.trim() : c));
        prev.y1 = r.y1;
        continue;
      }
    }
    cleaned.push({ ...r, cells: [...r.cells] });
  }
  const at = (k: ColKind) => kinds.indexOf(k);
  let summaryClosing: number | undefined;
  for (const r of cleaned) {
    const cells = r.cells.map((c) => c.trim());
    // the date is one of the first cells; figures are every cell that reads as money
    let dateCell = -1;
    for (let i = 0; i < Math.min(cells.length, 3); i++) {
      if (parseDate(cells[i], order)) {
        dateCell = i;
        break;
      }
    }
    const figures = cells.map((c, i) => ({ i, m: i === dateCell ? null : parseMoney(c, decimal) })).filter((x) => x.m) as { i: number; m: Money }[];
    const words = cells.filter((c, i) => i !== dateCell && c && !figures.some((x) => x.i === i)).join(' ').replace(/\s+/g, ' ').trim();
    if (OPENING.test(words) || CARRIED.test(words) || CLOSING.test(words)) {
      const b = figures.at(-1)?.m;
      if (b) {
        const kind = CARRIED.test(words) ? 'carried' : OPENING.test(words) ? (/brought/i.test(words) ? 'brought' : 'opening') : 'closing';
        // a summary box above the table states the closing balance before any row: it checks the total at the end
        if (kind === 'closing' && !transactions.length) summaryClosing = signed(b);
        else {
          checkpoints.push({ kind, cents: signed(b), page: r.page, y: r.y0, label: words });
          seq.push({ t: 'cp', i: checkpoints.length - 1 });
        }
      }
      continue;
    }
    if (SUMMARY.test(words) || TOTALS.test(words)) continue;
    const date = (dateCell >= 0 ? parseDate(cells[dateCell], order) : null) ?? lastDate;
    if (!date || !figures.length) continue;
    lastDate = date;
    // Where the cells line up with the headings, the columns say which figure is which and hint the sign.
    // A reader often drops an empty cell, so otherwise the last of two figures is the balance. Either way the
    // sign stays open for the running balance to settle: only the arithmetic decides money in or out.
    let bal: Money | null = null;
    let amt: Money | null = null;
    let hint = 0;
    if (cells.length === header.length) {
      bal = iBal >= 0 ? parseMoney(cells[iBal] ?? '', decimal) : null;
      const out = at('debit') >= 0 ? parseMoney(cells[at('debit')] ?? '', decimal) : null;
      const inn = at('credit') >= 0 ? parseMoney(cells[at('credit')] ?? '', decimal) : null;
      const one = at('amount') >= 0 ? parseMoney(cells[at('amount')] ?? '', decimal) : null;
      if (out?.cents) [amt, hint] = [out, -1];
      else if (inn?.cents) [amt, hint] = [inn, 1];
      else if (one) [amt, hint] = [one, one.sign];
    }
    if (!amt) {
      bal = figures.length >= 2 && iBal >= 0 ? figures[figures.length - 1].m : null;
      amt = figures[0].m;
      hint = amt.sign;
    }
    if (!amt.cents) continue;
    const code = words.split(' ')[0];
    const hasCode = CODES.has(code) && words.includes(' ');
    transactions.push({
      id: transactions.length, page: r.page, y0: r.y0, y1: r.y1,
      date: placeInPeriod(date, periodHint ?? null),
      code: hasCode ? code : undefined,
      description: hasCode ? words.slice(code.length + 1) : words,
      amount: (hint || (amt.sign === -1 ? -1 : 1)) * amt.cents,
      balance: bal ? signed(bal) : undefined,
      signFrom: amt.marker && amt.marker !== 'od' ? 'marker' : 'guess',
      check: 'unchecked',
    });
    seq.push({ t: 'tx', i: transactions.length - 1 });
  }
  const first = checkpoints.find((c) => c.kind === 'opening' || c.kind === 'brought');
  const opening = first && seq[0]?.t === 'cp' ? first.cents : undefined;
  const last = [...checkpoints].reverse().find((c) => c.kind === 'closing' || c.kind === 'carried');
  const closing = summaryClosing ?? (last && seq[seq.length - 1]?.t === 'cp' ? last.cents : undefined);
  const kept = pruneExtras(dropStrays(transactions), opening);
  const p: Parsed = {
    transactions: kept, opening, closing, period: periodHint ?? null, decimal, currency: undefined,
    columns: [], checkpoints, totals: { in: 0, out: 0 }, status: 'empty', notes: [],
  };
  recheck(p);
  return p;
}

/** Rows dated far from the rest are not on this statement (a model inventing an example, a misread year). */
function dropStrays(txs: Transaction[]): Transaction[] {
  if (txs.length < 4) return txs;
  const days = txs.map((t) => Date.parse(t.date) / 86400000).sort((a, b) => a - b);
  const median = days[Math.floor(days.length / 2)];
  return txs.filter((t) => Math.abs(Date.parse(t.date) / 86400000 - median) <= 62);
}

/** A row is extra when the next row ties without it: a duplicate where two bands overlap, a line read twice.
 *  Only rows the arithmetic proves extra are removed; a misread amount stays in, marked as not tying. */
function pruneExtras(txs: Transaction[], opening?: number): Transaction[] {
  const fits = (r: number, x: Transaction) =>
    x.balance !== undefined && (r + x.amount === x.balance || (x.signFrom === 'guess' && r - x.amount === x.balance));
  const out: Transaction[] = [];
  let running = opening;
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i];
    if (running === undefined || t.balance === undefined) {
      out.push(t);
      running = t.balance ?? (running === undefined ? undefined : running + t.amount);
      continue;
    }
    if (fits(running, t)) {
      out.push(t);
      running = t.balance;
      continue;
    }
    const next = txs[i + 1];
    if (next && fits(running, next)) continue;
    out.push(t);
    running = t.balance;
  }
  return out.map((t, i) => ({ ...t, id: i }));
}

/** Run the balance checks again after a person corrects a row. */
export function recheck(p: Parsed) {
  for (const t of p.transactions) {
    t.check = 'unchecked';
    delete t.diff;
  }
  for (const c of p.checkpoints) delete c.ok;
  const at = (page: number, y: number) => page * 100000 + y;
  const seq = [
    ...p.transactions.map((t, i) => ({ t: 'tx' as const, i, k: at(t.page, t.y0 + 1) })),
    ...p.checkpoints.map((c, i) => ({ t: 'cp' as const, i, k: at(c.page, c.y - 2) })),
  ].sort((a, b) => a.k - b.k);
  reconcile(p.transactions, p.checkpoints, seq, p.opening, p.closing);
  p.totals = p.transactions.reduce((s, t) => (t.amount > 0 ? { ...s, in: s.in + t.amount } : { ...s, out: s.out - t.amount }), { in: 0, out: 0 });
  const off = p.transactions.some((t) => t.check === 'off') || p.checkpoints.some((c) => c.ok === false);
  const checked = p.transactions.some((t) => t.check === 'tied' || t.check === 'tied-day');
  p.status = p.transactions.length === 0 ? 'empty' : off ? 'off' : checked ? 'ties' : 'unchecked';
}

function signed(m: Money): number {
  return m.sign === -1 ? -m.cents : m.cents;
}

function classify(l: Line, cols: Column[], decimal: Decimal, order: 'md' | 'dm'): RawRow | null {
  const dateCol = cols.find((c) => c.kind === 'date');
  const date2Col = cols.find((c) => c.kind === 'date2');
  const firstNum = Math.min(...cols.filter((c) => NUMERIC.includes(c.kind)).map((c) => c.x0));
  const descCol = cols.find((c) => c.kind === 'desc');
  const row: RawRow = { kind: 'tx', line: l, desc: [] };
  for (const c of l.cells) {
    const nearDate = dateCol && c.x0 >= dateCol.x0 - 8 && c.x0 <= Math.max(dateCol.x1, dateCol.x0 + 40) + 6;
    const nearDate2 = date2Col && c.x0 >= date2Col.x0 - 8 && c.x0 <= Math.max(date2Col.x1, date2Col.x0 + 40) + 6;
    if (nearDate && !row.date) {
      const d = parseDate(c.text, order);
      if (d) {
        row.date = d;
        continue;
      }
    }
    if (nearDate2 && !row.valueDate) {
      const d = parseDate(c.text, order);
      if (d) {
        row.valueDate = d;
        continue;
      }
    }
    const m = c.x1 > firstNum - 30 ? parseMoney(c.text, decimal) : null;
    const col = m ? numericColumn(c, cols) : null;
    if (m && col) {
      if (col.kind === 'balance') row.balance = m;
      else if (!row.amount) row.amount = { ...m, col: col.kind };
      continue;
    }
    row.desc.push(c.text);
  }
  const text = row.desc.join(' ');
  if (TOTALS.test(text) && !row.date) return null;
  if ((OPENING.test(text) || CARRIED.test(text) || CLOSING.test(text)) && !row.amount) {
    row.kind = 'cp';
    row.cp = CARRIED.test(text) ? 'carried' : OPENING.test(text) ? (/brought/i.test(text) ? 'brought' : 'opening') : 'closing';
    return row.balance ? row : null;
  }
  if (!row.date && !row.amount && !row.balance) {
    if (!row.desc.length) return null;
    row.kind = 'cont';
    return row;
  }
  if (row.desc.length > 1 && CODES.has(row.desc[0])) row.code = row.desc.shift();
  return row;
}

function dateOrder(lines: Line[], cols: Column[], period: Parsed['period'], currency?: string): 'md' | 'dm' {
  const dateCol = cols.find((c) => c.kind === 'date')!;
  let md = 0;
  let dm = 0;
  const pm = period ? Number(period.end.slice(5, 7)) : 0;
  for (const l of lines) {
    const c = l.cells[0];
    if (!c || Math.abs(c.x0 - dateCol.x0) > 12) continue;
    const m = c.text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?$/);
    if (!m) continue;
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) dm += 5;
    else if (b > 12) md += 5;
    else if (pm && a === pm) md += 1;
    else if (pm && b === pm) dm += 1;
    if (c.text.includes('.')) dm += 2;
  }
  if (md === dm) return currency === 'USD' || currency === 'CAD' ? 'md' : 'dm';
  return md > dm ? 'md' : 'dm';
}

function guessCurrency(text: string): string | undefined {
  const score: Record<string, number> = { USD: 0, GBP: 0, EUR: 0 };
  score.USD += (text.match(/\$|\bUSD\b/g) ?? []).length + (/\bACH\b|\bNCUA\b|\bFDIC\b/.test(text) ? 3 : 0);
  score.GBP += (text.match(/£|\bGBP\b/g) ?? []).length + (/sort code|\bplc\b/i.test(text) ? 3 : 0);
  score.EUR += (text.match(/€|\bEUR\b/g) ?? []).length + (/\bIBAN\b/.test(text) ? 2 : 0);
  const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : undefined;
}

/** Running balance through rows and printed checkpoints. Rows between two printed balances are checked as a
 *  group; an amount whose sign the statement does not show is settled by the balance when only one way adds up. */
function reconcile(txs: Transaction[], cps: Checkpoint[], seq: ({ t: 'tx'; i: number } | { t: 'cp'; i: number })[],
  opening: number | undefined, closing: number | undefined) {
  let running = opening;
  let group: Transaction[] = [];
  const settle = (target: number) => {
    if (running === undefined) {
      running = target;
      group = [];
      return true;
    }
    const unknown = group.filter((t) => t.signFrom === 'guess');
    if (unknown.length) solveSigns(group, running, target);
    const sum = group.reduce((s, t) => s + t.amount, 0);
    const ok = running + sum === target;
    group.forEach((t, k) => {
      t.check = ok ? (k === group.length - 1 && t.balance !== undefined ? 'tied' : 'tied-day') : 'off';
    });
    if (!ok && group.length) group[group.length - 1].diff = target - (running + sum);
    if (ok && group.length === 1 && group[0].balance !== undefined) group[0].check = 'tied';
    running = target;
    group = [];
    return ok;
  };
  for (const s of seq) {
    if (s.t === 'tx') {
      const t = txs[s.i];
      group.push(t);
      if (t.balance !== undefined) settle(t.balance);
    } else {
      const c = cps[s.i];
      if (c.kind === 'opening' && running === undefined) {
        running = c.cents;
        continue;
      }
      if (running !== undefined || group.length) c.ok = settle(c.cents) || undefined;
      if (c.ok === undefined && running !== undefined) c.ok = false;
      if (c.ok === undefined) delete c.ok;
    }
  }
  if (group.length && closing !== undefined && running !== undefined) settle(closing);
  // a lone row whose own balance ties is "tied"; rows checked only with their day stay "tied-day"
}

function solveSigns(group: Transaction[], start: number, target: number) {
  const unknown = group.filter((t) => t.signFrom === 'guess');
  const known = group.filter((t) => t.signFrom !== 'guess').reduce((s, t) => s + t.amount, 0);
  if (unknown.length > 14) return;
  const want = target - start - known;
  const abs = unknown.map((t) => Math.abs(t.amount));
  const hits: number[] = [];
  for (let mask = 0; mask < 1 << abs.length; mask++) {
    let sum = 0;
    for (let k = 0; k < abs.length; k++) sum += mask & (1 << k) ? abs[k] : -abs[k];
    if (sum === want) {
      hits.push(mask);
      if (hits.length > 1) break;
    }
  }
  if (hits.length === 1) {
    unknown.forEach((t, k) => {
      t.amount = hits[0] & (1 << k) ? abs[k] : -abs[k];
      t.signFrom = 'balance';
    });
  }
}

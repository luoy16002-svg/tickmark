// Money and date tokens as banks print them.

export type Decimal = '.' | ',';

export interface Money {
  cents: number; // always >= 0 here; the sign is in `sign`
  sign: -1 | 1 | 0; // 0: the token itself does not say
  marker?: 'minus' | 'parens' | 'cr' | 'dr' | 'od' | 'trailing-minus';
}

const MONEY_DOT = /^(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})$/;
const MONEY_COMMA = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})$/;
const MONEY_SPACE_DOT = /^(\d{1,3}(?: \d{3})+)\.(\d{2})$/;
const MONEY_SPACE_COMMA = /^(\d{1,3}(?: \d{3})+),(\d{2})$/;

/** A printed amount such as "1,234.56", "(12.00)", "-3.10", "1.234,56", "45.00 CR", "1,036.20 OD" or "9.99-". */
export function parseMoney(raw: string, decimal: Decimal): Money | null {
  let s = raw.trim().replace(/[   ]/g, ' ');
  if (!s || s.length > 24) return null;
  let sign: Money['sign'] = 0;
  let marker: Money['marker'];
  const suffix = s.match(/\s*(CR|DR|OD|C|D)$/i);
  if (suffix && /\d/.test(s.slice(0, suffix.index))) {
    const m = suffix[1].toUpperCase();
    sign = m === 'CR' || m === 'C' ? 1 : -1;
    marker = m === 'CR' || m === 'C' ? 'cr' : m === 'OD' ? 'od' : 'dr';
    s = s.slice(0, suffix.index).trim();
  }
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    marker = 'parens';
    s = s.slice(1, -1).trim();
  }
  if (/^[-−–]/.test(s)) {
    sign = -1;
    marker = 'minus';
    s = s.slice(1).trim();
  } else if (/[-−]$/.test(s)) {
    sign = -1;
    marker = 'trailing-minus';
    s = s.slice(0, -1).trim();
  } else if (s.startsWith('+')) {
    sign = 1;
    s = s.slice(1).trim();
  }
  s = s.replace(/^(?:[$£€¥₹]|USD|GBP|EUR|AUD|CAD|NZD|SGD|CHF)\s*/i, '').replace(/\s*(?:[$£€]|USD|GBP|EUR)$/i, '');
  if (/^[-−]/.test(s)) {
    sign = -1;
    marker = 'minus';
    s = s.slice(1);
  }
  let m: RegExpMatchArray | null;
  let whole: string;
  let frac: string;
  if (decimal === '.' && ((m = s.match(MONEY_DOT)) || (m = s.match(MONEY_SPACE_DOT)))) {
    [whole, frac] = [m[1].replace(/[ ,]/g, ''), m[2]];
  } else if (decimal === ',' && ((m = s.match(MONEY_COMMA)) || (m = s.match(MONEY_SPACE_COMMA)))) {
    [whole, frac] = [m[1].replace(/[ .]/g, ''), m[2]];
  } else {
    return null;
  }
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isFinite(cents)) return null;
  return { cents, sign, marker };
}

/** Which decimal mark the statement uses, judged from every money-looking string on it. */
export function guessDecimal(strings: string[]): Decimal {
  let dot = 0;
  let comma = 0;
  for (const raw of strings) {
    const s = raw.trim().replace(/\s*(CR|DR|OD)$/i, '').replace(/^[-(]|[-)]$/g, '');
    if (/^\d{1,3}(,\d{3})*\.\d{2}$/.test(s)) dot += s.includes(',') ? 3 : 1;
    if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) comma += s.includes('.') ? 3 : 1;
  }
  return comma > dot ? ',' : '.';
}

export const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

export interface PartialDate {
  y?: number;
  m: number;
  d: number;
  /** For numeric a/b dates without a year: which order was assumed. */
  ambiguous?: [number, number];
}

function year(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** Any one date token. `order` settles numeric dates such as 09/11 (month first in the US). */
export function parseDate(raw: string, order: 'md' | 'dm' = 'md'): PartialDate | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/,/g, '');
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return ok({ y: +m[1], m: +m[2], d: +m[3] });
  if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})$/))) {
    const [a, b] = [+m[1], +m[2]];
    const dm = s.includes('.') || order === 'dm' || a > 12;
    return ok(dm && b <= 12 ? { y: year(m[3]), m: b, d: a } : { y: year(m[3]), m: a, d: b });
  }
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/))) {
    const [a, b] = [+m[1], +m[2]];
    if (a > 12) return ok({ m: b, d: a });
    if (b > 12) return ok({ m: a, d: b });
    return ok(order === 'dm' ? { m: b, d: a, ambiguous: [a, b] } : { m: a, d: b, ambiguous: [a, b] });
  }
  if ((m = s.match(new RegExp(`^(\\d{1,2})[ -]?${MON}\\.?(?:[ -](\\d{4}|\\d{2}))?$`)))) {
    return ok({ d: +m[1], m: MONTHS[m[2].slice(0, 3)] ?? MONTHS[m[2]], y: m[3] ? year(m[3]) : undefined });
  }
  if ((m = s.match(new RegExp(`^${MON}\\.? (\\d{1,2})(?: (\\d{4}))?$`)))) {
    return ok({ m: MONTHS[m[1].slice(0, 3)] ?? MONTHS[m[1]], d: +m[2], y: m[3] ? +m[3] : undefined });
  }
  return null;
}

function ok(p: PartialDate): PartialDate | null {
  if (!p.m || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  if (p.y !== undefined && (p.y < 1990 || p.y > 2100)) return null;
  return p;
}

export function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Statement period from the words on the first pages, e.g. "September 1, 2026 through September 30, 2026",
 *  "1 September to 30 September 2026", "01.09.2026 - 30.09.2026", or a lone "STATEMENT DATE 12/31/2026". */
export function findPeriod(text: string): { start?: string; end: string } | null {
  const t = text.replace(/\s+/g, ' ');
  const range = [
    new RegExp(`${MON}\\.? (\\d{1,2}),? (\\d{4}) (?:through|to|thru|-|–) ${MON}\\.? (\\d{1,2}),? (\\d{4})`, 'i'),
    new RegExp(`(\\d{1,2}) ${MON}(?: (\\d{4}))? (?:to|-|–|until) (\\d{1,2}) ${MON} (\\d{4})`, 'i'),
    /(\d{1,2})[./](\d{1,2})[./](\d{4}) ?(?:-|–|to|bis|through) ?(\d{1,2})[./](\d{1,2})[./](\d{4})/i,
    /(\d{4})-(\d{2})-(\d{2}) ?(?:-|–|to|through) ?(\d{4})-(\d{2})-(\d{2})/i,
  ];
  let m: RegExpMatchArray | null;
  if ((m = t.match(range[0]))) {
    return { start: iso(+m[3], mon(m[1]), +m[2]), end: iso(+m[6], mon(m[4]), +m[5]) };
  }
  if ((m = t.match(range[1]))) {
    const y2 = +m[6];
    const m1 = mon(m[2]);
    const y1 = m[3] ? +m[3] : m1 > mon(m[5]) ? y2 - 1 : y2;
    return { start: iso(y1, m1, +m[1]), end: iso(y2, mon(m[5]), +m[4]) };
  }
  if ((m = t.match(range[2]))) {
    const dotted = /\d\.\d/.test(m[0]);
    const [a, b, c, d] = [+m[1], +m[2], +m[4], +m[5]];
    const dm = dotted || a > 12 || c > 12;
    return dm ? { start: iso(+m[3], b, a), end: iso(+m[6], d, c) } : { start: iso(+m[3], a, b), end: iso(+m[6], c, d) };
  }
  if ((m = t.match(range[3]))) return { start: iso(+m[1], +m[2], +m[3]), end: iso(+m[4], +m[5], +m[6]) };
  if ((m = t.match(/statement (?:date|ending|end date|closing date)[: ]+(\d{1,2})\/(\d{1,2})\/(\d{4})/i))) {
    return { end: iso(+m[3], +m[1], +m[2]) };
  }
  return null;
}

function mon(s: string): number {
  const k = s.toLowerCase();
  return MONTHS[k] ?? MONTHS[k.slice(0, 3)];
}

/** Give a year to a month/day printed without one, so that it falls inside (or next to) the statement period. */
export function placeInPeriod(p: PartialDate, period: { start?: string; end: string } | null): string {
  if (p.y) return iso(p.y, p.m, p.d);
  if (!period) return iso(new Date().getFullYear(), p.m, p.d);
  const end = new Date(period.end + 'T00:00:00Z');
  const ey = end.getUTCFullYear();
  const em = end.getUTCMonth() + 1;
  // a month later than the period's last month belongs to the year before (a Dec statement ending in January)
  const y = p.m > em + 1 ? ey - 1 : ey;
  return iso(y, p.m, p.d);
}

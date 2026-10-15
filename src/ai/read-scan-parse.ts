// Turning the model's written answer back into cells. It is asked for one JSON array per row, but it may
// indent the JSON, wrap it in a code fence, or put the headings and rows in an object; all of those are read,
// and anything that is not JSON (a sentence, a fence) is skipped rather than trusted.
import { kindOf } from '../parse/statement.ts';

/** Every top-level JSON value in the text, found by matching brackets outside strings. */
function jsonValues(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = depth > 0;
    else if (ch === '[' || ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* a broken value: skip it */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

const isRow = (v: unknown): v is (string | number)[] =>
  Array.isArray(v) && v.length > 1 && v.every((c) => typeof c === 'string' || typeof c === 'number');

function looksLikeHeader(cells: string[]): boolean {
  return cells.filter((c) => kindOf(c)).length >= 3 && !cells.some((c) => /\d[.,]\d{2}$/.test(c));
}

export function parseJsonRows(text: string): { header: string[] | null; rows: string[][] } {
  let header: string[] | null = null;
  const rows: string[][] = [];
  const take = (cells: (string | number)[]) => {
    const strs = cells.map((c) => String(c).trim());
    if (looksLikeHeader(strs)) {
      if (!header) header = strs;
    } else rows.push(strs);
  };
  for (const v of jsonValues(text)) {
    if (isRow(v)) take(v);
    else if (Array.isArray(v)) {
      for (const inner of v) if (isRow(inner)) take(inner);
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/head|column/i.test(k) && isRow(val)) {
          const strs = val.map(String);
          if (!header && strs.filter((c) => kindOf(c)).length >= 3) header = strs;
        } else if (Array.isArray(val)) {
          for (const inner of val) if (isRow(inner)) take(inner);
        }
      }
    }
  }
  return { header, rows };
}

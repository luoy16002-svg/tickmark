// Every export is built in the page and handed to the browser as a download; nothing is sent anywhere.
import type { Parsed, Transaction } from '../parse/statement.ts';
import { xlsx } from './xlsx.ts';

export type Format = 'xlsx' | 'csv' | 'qbo-csv' | 'xero-csv' | 'ofx';

export interface ExportFile {
  name: string;
  type: string;
  data: Uint8Array;
}

export const FORMATS: { id: Format; label: string; note: string }[] = [
  { id: 'xlsx', label: 'Excel workbook', note: 'Transactions and a reconciliation sheet' },
  { id: 'csv', label: 'CSV', note: 'Every column, for any spreadsheet' },
  { id: 'qbo-csv', label: 'QuickBooks Online', note: 'Date, Description, Amount' },
  { id: 'xero-csv', label: 'Xero', note: 'Xero statement import columns' },
  { id: 'ofx', label: 'OFX', note: 'For QuickBooks Desktop, Wave, Moneydance and others' },
];

const enc = new TextEncoder();
const cents = (c: number) => (c / 100).toFixed(2);
const checkWord: Record<Transaction['check'], string> = {
  tied: 'ties', 'tied-day': 'ties (day total)', off: 'does not tie', unchecked: 'not checked',
};

function csvCell(v: string | number | undefined): string {
  if (v === undefined || v === null) return '';
  let s = String(v);
  // keep spreadsheets from running a description as a formula
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: (string | number | undefined)[][]): Uint8Array {
  return enc.encode('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
}

/** dd/mm/yyyy or mm/dd/yyyy as the accounting package expects for the statement's region. */
function regional(iso: string, order: 'md' | 'dm'): string {
  const [y, m, d] = iso.split('-');
  return order === 'md' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

export function buildExport(fmt: Format, p: Parsed, baseName: string): ExportFile {
  const txs = p.transactions;
  const order: 'md' | 'dm' = p.currency === 'USD' || p.currency === 'CAD' ? 'md' : 'dm';
  const name = (ext: string, suffix = '') => `${baseName}${suffix}.${ext}`;
  switch (fmt) {
    case 'csv':
      return {
        name: name('csv'), type: 'text/csv',
        data: csv([
          ['Date', 'Description', 'Category', 'Amount', 'Money in', 'Money out', 'Balance', 'Check'],
          ...txs.map((t) => [t.date, t.description, t.category, cents(t.amount), t.amount > 0 ? cents(t.amount) : '',
            t.amount < 0 ? cents(-t.amount) : '', t.balance !== undefined ? cents(t.balance) : '', checkWord[t.check]]),
        ]),
      };
    case 'qbo-csv':
      return {
        name: name('csv', '-quickbooks'), type: 'text/csv',
        data: csv([['Date', 'Description', 'Amount'], ...txs.map((t) => [regional(t.date, order), t.description, cents(t.amount)])]),
      };
    case 'xero-csv':
      return {
        name: name('csv', '-xero'), type: 'text/csv',
        data: csv([
          ['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Cheque Number', 'Account code'],
          ...txs.map((t) => {
            const cheque = t.description.match(/\bCHE(?:CK|QUE)\s*#?\s*(\d{3,})/i)?.[1];
            return [regional(t.date, order), cents(t.amount), '', t.description, '', cheque ?? '', ''];
          }),
        ]),
      };
    case 'ofx':
      return { name: name('ofx'), type: 'application/x-ofx', data: enc.encode(ofx(p)) };
    case 'xlsx':
    default:
      return {
        name: name('xlsx'),
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        data: xlsx([
          {
            name: 'Transactions',
            widths: [11, 52, 22, 13, 13, 18],
            rows: [
              ['Date', 'Description', 'Category', 'Amount', 'Balance', 'Check'],
              ...txs.map((t) => [{ date: t.date }, t.description, t.category ?? '', { money: t.amount },
                t.balance !== undefined ? { money: t.balance } : '', checkWord[t.check]]),
            ],
          },
          {
            name: 'Reconciliation',
            widths: [30, 16],
            rows: [
              ['Opening balance', p.opening !== undefined ? { money: p.opening } : 'not printed'],
              ['Money in', { money: p.totals.in }],
              ['Money out', { money: -p.totals.out }],
              ['Opening + in - out', p.opening !== undefined ? { money: p.opening + p.totals.in - p.totals.out } : ''],
              ['Closing balance printed', p.closing !== undefined ? { money: p.closing } : 'not printed'],
              ['Rows', txs.length],
              ['Rows that tie', txs.filter((t) => t.check === 'tied' || t.check === 'tied-day').length],
              ['Rows that do not tie', txs.filter((t) => t.check === 'off').length],
            ],
          },
        ]),
      };
  }
}

function ofx(p: Parsed): string {
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const d = (iso: string) => iso.replace(/-/g, '') + '120000';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const start = p.period?.start ?? p.transactions[0]?.date ?? '';
  const end = p.period?.end ?? p.transactions[p.transactions.length - 1]?.date ?? '';
  const seen = new Map<string, number>();
  const rows = p.transactions.map((t) => {
    const base = `${t.date.replace(/-/g, '')}-${Math.abs(t.amount)}-${t.description.slice(0, 12).replace(/\W/g, '')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${d(t.date)}</DTPOSTED>` +
      `<TRNAMT>${cents(t.amount)}</TRNAMT><FITID>${esc(base)}-${n}</FITID><NAME>${esc(t.description.slice(0, 32))}</NAME>` +
      `<MEMO>${esc(t.description)}</MEMO></STMTTRN>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n` +
    `<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>${now}</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>` +
    `<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>${p.currency ?? 'USD'}</CURDEF>` +
    `<BANKACCTFROM><BANKID>000000000</BANKID><ACCTID>TICKMARK</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>` +
    `<BANKTRANLIST><DTSTART>${d(start)}</DTSTART><DTEND>${d(end)}</DTEND>\n${rows.join('\n')}\n</BANKTRANLIST>` +
    `<LEDGERBAL><BALAMT>${cents(p.closing ?? (p.transactions.at(-1)?.balance ?? 0))}</BALAMT><DTASOF>${d(end)}</DTASOF></LEDGERBAL>` +
    `</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n`;
}

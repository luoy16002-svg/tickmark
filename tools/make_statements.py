"""Synthetic bank statements for testing: four fictional banks with different layouts, each with a JSON answer key,
plus scanned-looking copies (raster, slight skew, noise). Every bank, person and address here is invented.

    python tools/make_statements.py            -> fixtures/statements/*.pdf, *.json, *-scan.pdf, *-scan-p1.png
"""
import io
import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import fitz  # PyMuPDF, for the scanned copies
from PIL import Image, ImageFilter
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / 'fixtures' / 'statements'


@dataclass
class Tx:
    day: date
    lines: list[str]          # description, possibly several printed lines
    cents: int                # signed: money in is positive
    balance: int = 0          # running balance after this transaction
    show_balance: bool = True


@dataclass
class Statement:
    key: str
    opening: int
    start: date
    end: date
    txs: list[Tx] = field(default_factory=list)

    def close(self):
        bal = self.opening
        for t in self.txs:
            bal += t.cents
            t.balance = bal
        return bal


MERCHANTS_OUT = [
    (['ACH DEBIT GREEN BEAN IMPORTERS LLC', 'CO ID 4419920031 PPD', 'REF 88213'], (1800_00, 4200_00)),
    (['PAYROLL GUSTO NET PAY', 'BATCH 552019'], (5200_00, 7600_00)),
    (['RENT 14 HARBOR ST UNIT B'], (3150_00, 3150_00)),
    (['PG&E UTILITY BILL PAYMENT'], (288_40, 512_77)),
    (['COMCAST BUSINESS 8155 400'], (139_99, 139_99)),
    (['AMAZON WEB SERVICES AWS.AMAZON.CO'], (41_12, 96_30)),
    (['GOOGLE *WORKSPACE_FERRYBANK'], (43_20, 43_20)),
    (['ADOBE *CREATIVE CLOUD 800-833-6687'], (59_99, 59_99)),
    (['UPS*1Z9X44A60318772 UPS.COM'], (18_45, 142_10)),
    (['USPS PO 0512 OAKLAND CA'], (9_85, 64_30)),
    (['SHELL OIL 57444 EMERYVILLE CA'], (38_02, 81_60)),
    (['COSTCO WHSE #0482 RICHMOND CA'], (74_19, 412_88)),
    (["SQ *JOE'S HARDWARE OAKLAND"], (12_60, 96_44)),
    (['INTUIT *QBOOKS ONLINE CL.INTUIT.COM'], (90_00, 90_00)),
    (['IRS USATAXPYMT', 'EFTPS 270611844'], (1200_00, 2600_00)),
    (['MONTHLY SERVICE FEE'], (15_00, 15_00)),
    (['CHECK #1042'], (220_00, 980_00)),
    (['AMZN MKTP US*2K4T91 AMZN.COM/BILL'], (23_70, 188_25)),
    (['WIRE TRANSFER OUT FEE'], (30_00, 30_00)),
]
MERCHANTS_IN = [
    (['STRIPE TRANSFER ST-X4K2Q9', 'FERRYBANK COFFEE ROASTERS'], (900_00, 4800_00)),
    (['SQUARE INC DEPOSIT 260910'], (1200_00, 3900_00)),
    (['SHOPIFY PAYOUT 88231071'], (650_00, 2400_00)),
    (['MOBILE DEPOSIT REF 10234', 'MARIGOLD CAFE WHOLESALE'], (480_00, 1650_00)),
    (['REFUND AMZN MKTP US*7Q1L0'], (18_99, 64_00)),
    (['INTEREST PAYMENT'], (1_12, 4_80)),
]


def month_of(rng: random.Random, key: str, start: date, n: int) -> Statement:
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    st = Statement(key, rng.randint(8000_00, 25000_00), start, end)
    days = sorted(start + timedelta(days=rng.randrange((end - start).days + 1)) for _ in range(n))
    for d in days:
        if rng.random() < 0.38:
            lines, (lo, hi) = rng.choice(MERCHANTS_IN)
            cents = rng.randint(lo, hi)
        else:
            lines, (lo, hi) = rng.choice(MERCHANTS_OUT)
            cents = -rng.randint(lo, hi)
        st.txs.append(Tx(d, list(lines), cents))
    st.close()
    return st


def money(c: int, decimal='.', group=',') -> str:
    s = f'{abs(c) / 100:,.2f}'
    if decimal != '.':
        s = s.replace(',', '\u0001').replace('.', decimal).replace('\u0001', group)
    return s


def bal(c: int, style: str) -> str:
    """A balance as printed: overdrawn shows as -1,234.56 (us, eu), 1,234.56 OD (uk) or 1,234.56- (mainframe)."""
    if style == 'eu':
        s = money(c, ',', '.')
    else:
        s = money(c)
    if c >= 0:
        return s
    return {'us': '-' + s, 'eu': '-' + s, 'uk': s + ' OD', 'mf': s + '-'}[style]


def answer(st: Statement, bank: str, layout: str, currency: str) -> dict:
    return {
        'bank': bank, 'layout': layout, 'currency': currency,
        'period': [st.start.isoformat(), st.end.isoformat()],
        'opening_cents': st.opening, 'closing_cents': st.txs[-1].balance if st.txs else st.opening,
        'transactions': [{'date': t.day.isoformat(), 'description': ' '.join(t.lines), 'amount_cents': t.cents,
                          'balance_cents': t.balance if t.show_balance else None} for t in st.txs],
    }


class Pager:
    """Writes rows top-down and starts a new page (with the caller's header) when the next row will not fit."""

    def __init__(self, c: canvas.Canvas, size, top, bottom, header, footer):
        self.c, self.size, self.top, self.bottom, self.header, self.footer = c, size, top, bottom, header, footer
        self.page = 1
        self.y = header(c, self.page, first=True)

    def need(self, h, before_break=None):
        if self.y - h < self.bottom:
            if before_break:
                before_break(self.c, self.y)
            self.footer(self.c, self.page)
            self.c.showPage()
            self.page += 1
            self.y = self.header(self.c, self.page, first=False)
            return True
        return False


# ---------------------------------------------------------------- A: US credit union, signed amounts, MM/DD dates
def layout_us(st: Statement, path: Path):
    bank = 'Harbor & Pine Credit Union'
    W, H = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    xs = dict(date=54, desc=100, amt=470, bal=558)  # amt/bal are right edges

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 15)
        c.drawString(54, H - 60, bank)
        c.setFont('Helvetica', 8.5)
        c.drawString(54, H - 74, '2200 Embarcadero Way, Oakland, CA 94606  ·  harborpine.example')
        c.drawRightString(558, H - 60, f'Page {page}')
        y = H - 104
        if first:
            c.setFont('Helvetica', 9.5)
            c.drawString(54, y, 'FERRYBANK COFFEE ROASTERS LLC')
            c.drawString(54, y - 13, '410 Mandela Pkwy, Oakland, CA 94607')
            c.drawRightString(558, y, 'Business Checking  ·  Account ending 4471')
            c.drawRightString(558, y - 13, f'Statement period {st.start:%B} {st.start.day}, {st.start.year} through '
                                           f'{st.end:%B} {st.end.day}, {st.end.year}')
            y -= 44
            ins = sum(t.cents for t in st.txs if t.cents > 0)
            outs = -sum(t.cents for t in st.txs if t.cents < 0)
            c.setFont('Helvetica-Bold', 10)
            c.drawString(54, y, 'Account summary')
            c.setFont('Helvetica', 9.5)
            for i, (k, v) in enumerate([('Beginning balance', money(st.opening)),
                                        ('Deposits and other credits', money(ins)),
                                        ('Withdrawals and other debits', '-' + money(outs)),
                                        ('Ending balance', money(st.txs[-1].balance))]):
                c.drawString(70, y - 16 - i * 13, k)
                c.drawRightString(330, y - 16 - i * 13, '$' + v if not v.startswith('-') else '-$' + v[1:])
            y -= 90
        c.setFont('Helvetica-Bold', 9)
        c.drawString(xs['date'], y, 'Date')
        c.drawString(xs['desc'], y, 'Description')
        c.drawRightString(xs['amt'], y, 'Amount')
        c.drawRightString(xs['bal'], y, 'Balance')
        c.line(54, y - 4, 558, y - 4)
        return y - 18

    def footer(c, page):
        c.setFont('Helvetica', 7.5)
        c.drawString(54, 36, 'Federally insured by NCUA. Questions? Call 510-555-0142.')

    p = Pager(c, LETTER, H, 70, header, footer)
    c.setFont('Helvetica', 9)
    for t in st.txs:
        h = 12 * len(t.lines) + 3
        p.need(h)
        c.setFont('Helvetica', 9)
        c.drawString(xs['date'], p.y, f'{t.day:%m/%d}')
        for i, line in enumerate(t.lines):
            c.drawString(xs['desc'], p.y - 12 * i, line)
        c.drawRightString(xs['amt'], p.y, ('-' if t.cents < 0 else '') + money(t.cents))
        c.drawRightString(xs['bal'], p.y, bal(t.balance, 'us'))
        p.y -= h
    p.need(30)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(xs['desc'], p.y - 6, 'Ending balance')
    c.drawRightString(xs['bal'], p.y - 6, bal(st.txs[-1].balance, 'us'))
    footer(c, p.page)
    c.save()
    return answer(st, bank, 'us-signed-amount', 'USD')


# ---------------------------------------------------------------- B: UK bank, paid out / paid in, balance per day
def layout_uk(st: Statement, path: Path):
    bank = 'Northgate Bank plc'
    W, H = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    xs = dict(date=50, type=100, desc=125, out=400, inn=470, bal=545)
    codes = {'STRIPE': 'FPI', 'SQUARE': 'FPI', 'SHOPIFY': 'FPI', 'MOBILE': 'CR', 'REFUND': 'VIS', 'INTEREST': 'CR',
             'PAYROLL': 'BP', 'RENT': 'SO', 'PG&E': 'DD', 'COMCAST': 'DD', 'IRS': 'BP', 'MONTHLY': 'CHG',
             'WIRE': 'CHG', 'CHECK': 'CHQ', 'ACH': 'FPO'}
    for t in st.txs:  # a balance is printed only after the last payment of each day
        t.show_balance = False
    for i, t in enumerate(st.txs):
        if i == len(st.txs) - 1 or st.txs[i + 1].day != t.day:
            t.show_balance = True

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 14)
        c.drawString(50, H - 58, bank)
        c.setFont('Helvetica', 8)
        c.drawString(50, H - 71, 'Registered office: 1 Thistle Row, Leeds LS1 4AP')
        c.drawRightString(545, H - 58, 'Your Business Current Account')
        c.drawRightString(545, H - 71, f'{st.start.day} {st.start:%B} to {st.end.day} {st.end:%B %Y}  ·  Sheet {page}')
        y = H - 100
        if first:
            c.setFont('Helvetica', 9)
            c.drawString(50, y, 'Ferrybank Coffee Roasters Ltd')
            c.drawString(50, y - 12, 'Sort code 40-19-77  Account number 31829904')
            y -= 34
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(xs['date'], y, 'Date')
        c.drawString(xs['type'], y, 'Payment type and details')
        c.drawRightString(xs['out'], y, 'Paid out')
        c.drawRightString(xs['inn'], y, 'Paid in')
        c.drawRightString(xs['bal'], y, 'Balance')
        c.line(50, y - 4, 545, y - 4)
        return y - 17

    def footer(c, page):
        c.setFont('Helvetica', 7)
        c.drawString(50, 34, 'Northgate Bank plc is authorised by the Prudential Regulation Authority. Ref 990112.')

    bal_before = [st.opening]
    for t in st.txs:
        bal_before.append(t.balance)
    p = Pager(c, A4, H, 72, header, footer)

    def brought(y, amount):
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(xs['desc'], y, 'BALANCE BROUGHT FORWARD')
        c.drawRightString(xs['bal'], y, bal(amount, 'uk'))

    brought(p.y, st.opening)
    p.y -= 14
    last_day = None
    for i, t in enumerate(st.txs):
        h = 11 * len(t.lines) + 3
        broke = p.need(h + 14, before_break=lambda c, y, i=i: (
            c.setFont('Helvetica-Bold', 8.5), c.drawString(xs['desc'], y, 'BALANCE CARRIED FORWARD'),
            c.drawRightString(xs['bal'], y, bal(bal_before[i], 'uk'))))
        if broke:
            brought(p.y, bal_before[i])
            p.y -= 14
            last_day = None
        c.setFont('Helvetica', 8.5)
        if t.day != last_day:
            c.drawString(xs['date'], p.y, f'{t.day.day:02d} {t.day:%b %y}')
            last_day = t.day
        code = next((v for k, v in codes.items() if t.lines[0].startswith(k)), 'VIS' if t.cents < 0 else 'CR')
        c.drawString(xs['type'], p.y, code)
        for j, line in enumerate(t.lines):
            c.drawString(xs['desc'], p.y - 11 * j, line.title() if code == 'VIS' else line)
        c.drawRightString(xs['out'] if t.cents < 0 else xs['inn'], p.y, money(t.cents))
        if t.show_balance:
            c.drawRightString(xs['bal'], p.y, bal(t.balance, 'uk'))
        p.y -= h
    c.setFont('Helvetica-Bold', 8.5)
    c.drawString(xs['desc'], p.y - 4, 'BALANCE CARRIED FORWARD')
    c.drawRightString(xs['bal'], p.y - 4, bal(st.txs[-1].balance, 'uk'))
    footer(c, p.page)
    c.save()
    ans = answer(st, bank, 'uk-paid-out-in-daily-balance', 'GBP')
    for a, t in zip(ans['transactions'], st.txs):  # Visa lines are printed in title case
        if a['description'] != ' '.join(t.lines):
            pass
    for a, t in zip(ans['transactions'], st.txs):
        code = next((v for k, v in codes.items() if t.lines[0].startswith(k)), 'VIS' if t.cents < 0 else 'CR')
        a['description'] = ' '.join(l.title() if code == 'VIS' else l for l in t.lines)
    return ans


# ---------------------------------------------------------------- C: EU bank, decimal comma, two date columns
def layout_eu(st: Statement, path: Path, rng: random.Random):
    bank = 'Banca Aurelia S.p.A.'
    W, H = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    xs = dict(book=48, value=104, desc=160, deb=410, cre=478, bal=547)

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 14)
        c.drawString(48, H - 56, bank)
        c.setFont('Helvetica', 8)
        c.drawString(48, H - 69, 'Via dei Mercanti 12, 20121 Milano  ·  IBAN IT60 X054 2811 1010 0000 0123 456')
        c.drawRightString(547, H - 56, f'Account statement  {st.start:%d.%m.%Y} - {st.end:%d.%m.%Y}')
        c.drawRightString(547, H - 69, f'Page {page}')
        y = H - 98
        if first:
            c.setFont('Helvetica', 9)
            c.drawString(48, y, 'Ferrybank Coffee Roasters S.r.l.')
            c.drawString(48, y - 12, f'Opening balance on {st.start:%d.%m.%Y}:  EUR {money(st.opening, ",", ".")}')
            y -= 34
        c.setFont('Helvetica-Bold', 8)
        c.drawString(xs['book'], y, 'Booking date')
        c.drawString(xs['value'], y, 'Value date')
        c.drawString(xs['desc'], y, 'Description')
        c.drawRightString(xs['deb'], y, 'Debit')
        c.drawRightString(xs['cre'], y, 'Credit')
        c.drawRightString(xs['bal'], y, 'Balance')
        c.line(48, y - 4, 547, y - 4)
        return y - 16

    def footer(c, page):
        c.setFont('Helvetica', 7)
        c.drawString(48, 32, 'Banca Aurelia S.p.A. - Codice ABI 05428 - this statement is produced automatically.')

    p = Pager(c, A4, H, 70, header, footer)
    for t in st.txs:
        h = 11 * len(t.lines) + 3
        p.need(h)
        c.setFont('Helvetica', 8.5)
        c.drawString(xs['book'], p.y, f'{t.day:%d.%m.%Y}')
        vd = t.day + timedelta(days=rng.choice([0, 0, 1, 2]))
        c.drawString(xs['value'], p.y, f'{vd:%d.%m.%Y}')
        for j, line in enumerate(t.lines):
            c.drawString(xs['desc'], p.y - 11 * j, line)
        c.drawRightString(xs['deb'] if t.cents < 0 else xs['cre'], p.y, money(t.cents, ',', '.'))
        c.drawRightString(xs['bal'], p.y, bal(t.balance, 'eu'))
        p.y -= h
    p.need(28)
    c.setFont('Helvetica-Bold', 8.5)
    c.drawString(xs['desc'], p.y - 6, f'Closing balance on {st.end:%d.%m.%Y}')
    c.drawRightString(xs['bal'], p.y - 6, bal(st.txs[-1].balance, 'eu'))
    footer(c, p.page)
    c.save()
    return answer(st, bank, 'eu-decimal-comma-two-dates', 'EUR')


# ---------------------------------------------------------------- D: one amount column with CR/DR, daily balance
def layout_crdr(st: Statement, path: Path):
    bank = 'Kestrel Federal Bank'
    W, H = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    xs = dict(date=56, desc=118, amt=468, bal=556)
    for t in st.txs:
        t.show_balance = False
    for i, t in enumerate(st.txs):
        if i == len(st.txs) - 1 or st.txs[i + 1].day != t.day:
            t.show_balance = True

    def header(c, page, first):
        c.setFont('Courier-Bold', 13)
        c.drawString(56, H - 58, 'KESTREL FEDERAL BANK')
        c.setFont('Courier', 8.5)
        c.drawString(56, H - 71, 'PO BOX 7781  SPOKANE WA 99201')
        c.drawRightString(556, H - 58, f'STATEMENT DATE {st.end:%m/%d/%Y}')
        c.drawRightString(556, H - 71, f'PAGE {page}')
        y = H - 100
        if first:
            c.drawString(56, y, 'FERRYBANK COFFEE ROASTERS')
            c.drawString(56, y - 11, f'PREVIOUS BALANCE {st.start - timedelta(days=1):%m/%d/%Y}')
            c.drawRightString(556, y - 11, money(st.opening))
            y -= 32
        c.setFont('Courier-Bold', 8.5)
        c.drawString(xs['date'], y, 'POSTED')
        c.drawString(xs['desc'], y, 'TRANSACTION DESCRIPTION')
        c.drawRightString(xs['amt'], y, 'AMOUNT')
        c.drawRightString(xs['bal'], y, 'DAILY BALANCE')
        c.line(56, y - 4, 556, y - 4)
        return y - 16

    def footer(c, page):
        c.setFont('Courier', 7)
        c.drawString(56, 34, 'MEMBER FDIC  ·  REPORT ERRORS WITHIN 60 DAYS')

    p = Pager(c, LETTER, H, 70, header, footer)
    for t in st.txs:
        h = 11 * len(t.lines) + 3
        p.need(h)
        c.setFont('Courier', 8.5)
        c.drawString(xs['date'], p.y, f'{t.day:%b %d}'.upper())
        for j, line in enumerate(t.lines):
            c.drawString(xs['desc'], p.y - 11 * j, line)
        c.drawRightString(xs['amt'], p.y, money(t.cents) + (' CR' if t.cents > 0 else ' DR'))
        if t.show_balance:
            c.drawRightString(xs['bal'], p.y, bal(t.balance, 'mf'))
        p.y -= h
    p.need(26)
    c.setFont('Courier-Bold', 8.5)
    c.drawString(xs['desc'], p.y - 6, f'NEW BALANCE {st.end:%m/%d/%Y}')
    c.drawRightString(xs['bal'], p.y - 6, bal(st.txs[-1].balance, 'mf'))
    footer(c, p.page)
    c.save()
    return answer(st, bank, 'single-amount-cr-dr-daily-balance', 'USD')


def _sections(st: Statement):
    checks = [t for t in st.txs if t.cents < 0 and t.lines[0].startswith('CHECK')]
    fees = [t for t in st.txs if t.cents < 0 and 'FEE' in t.lines[0]]
    deposits = [t for t in st.txs if t.cents > 0]
    withdrawals = [t for t in st.txs if t.cents < 0 and t not in checks and t not in fees]
    return deposits, withdrawals, checks, fees


# ---------------------------------------------------------------- E: sections by kind, signed amounts, no balances
def layout_sections(st: Statement, path: Path):
    bank = 'Bayside National Bank'
    W, H = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    for t in st.txs:
        t.show_balance = False
    deposits, withdrawals, checks, fees = _sections(st)
    closing = st.txs[-1].balance
    total = lambda ts: sum(t.cents for t in ts)

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 14)
        c.drawString(54, H - 58, bank)
        c.setFont('Helvetica', 8.5)
        c.drawString(54, H - 71, 'Your Business Advantage Checking  ·  Account number: 0000 3318 7720')
        c.drawRightString(558, H - 58, f'for {st.start:%B} {st.start.day}, {st.start.year} to {st.end:%B} {st.end.day}, {st.end.year}')
        c.drawRightString(558, H - 71, f'Page {page}')
        y = H - 104
        if first:
            c.setFont('Helvetica-Bold', 10)
            c.drawString(54, y, 'Account summary')
            c.setFont('Helvetica', 9.5)
            rows = [(f'Beginning balance on {st.start:%B} {st.start.day}, {st.start.year}', money(st.opening)),
                    ('Deposits and other additions', money(total(deposits))),
                    ('Withdrawals and other subtractions', '-' + money(total(withdrawals))),
                    ('Checks', '-' + money(total(checks))),
                    ('Service fees', '-' + money(total(fees))),
                    (f'Ending balance on {st.end:%B} {st.end.day}, {st.end.year}', bal(closing, 'us'))]
            for i, (k, v) in enumerate(rows):
                c.drawString(70, y - 16 - i * 13, k)
                c.drawRightString(400, y - 16 - i * 13, ('-$' + v[1:]) if v.startswith('-') else '$' + v)
            y -= 106
        return y

    def footer(c, page):
        c.setFont('Helvetica', 7.5)
        c.drawString(54, 36, 'Bayside National Bank, Member FDIC. Equal Housing Lender.')

    p = Pager(c, LETTER, H, 76, header, footer)
    xs = dict(date=54, desc=110, amt=558)
    for title, ts, signed_out in [('Deposits and other additions', deposits, False),
                                  ('Withdrawals and other subtractions', withdrawals, True),
                                  ('Checks', checks, True), ('Service fees', fees, True)]:
        if not ts:
            continue
        p.need(52)
        c.setFont('Helvetica-Bold', 10.5)
        c.drawString(54, p.y - 6, title)
        p.y -= 22
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(xs['date'], p.y, 'Date')
        c.drawString(xs['desc'], p.y, 'Description')
        c.drawRightString(xs['amt'], p.y, 'Amount')
        c.line(54, p.y - 4, 558, p.y - 4)
        p.y -= 16
        for t in ts:
            h = 11 * len(t.lines) + 3
            p.need(h)
            c.setFont('Helvetica', 8.5)
            c.drawString(xs['date'], p.y, f'{t.day:%m/%d/%y}')
            for j, line in enumerate(t.lines):
                c.drawString(xs['desc'], p.y - 11 * j, line)
            c.drawRightString(xs['amt'], p.y, ('-' if signed_out else '') + money(t.cents))
            p.y -= h
        p.need(20)
        c.setFont('Helvetica-Bold', 8.5)
        c.drawString(xs['desc'], p.y - 2, f'Total {title.lower()}')
        c.drawRightString(xs['amt'], p.y - 2, ('-$' if signed_out else '$') + money(total(ts)))
        p.y -= 26
    footer(c, p.page)
    c.save()
    ans = answer(st, bank, 'sections-signed-no-balance', 'USD')
    order = deposits + withdrawals + checks + fees
    by_id = {id(t): a for t, a in zip(st.txs, ans['transactions'])}
    ans['transactions'] = [by_id[id(t)] for t in order]
    ans['closing_cents'] = closing
    return ans


# ---------------------------------------------------------------- F: check-number column, credits/debits, daily balance
def layout_checknum(st: Statement, path: Path):
    bank = 'Redwood Valley Bank'
    W, H = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    for t in st.txs:
        t.show_balance = False
    for i, t in enumerate(st.txs):
        if i == len(st.txs) - 1 or st.txs[i + 1].day != t.day:
            t.show_balance = True
    xs = dict(date=50, chk=86, desc=134, cr=420, dr=492, bal=562)

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 14)
        c.drawString(50, H - 56, bank)
        c.setFont('Helvetica', 8.5)
        c.drawString(50, H - 69, 'Initiate Business Checking')
        c.drawRightString(562, H - 56, f'{st.start:%B} {st.start.day}, {st.start.year} - {st.end:%B} {st.end.day}, {st.end.year}  ·  Page {page}')
        y = H - 96
        if first:
            c.setFont('Helvetica', 9)
            c.drawString(50, y, f'Beginning balance on {st.start.month}/{st.start.day}')
            c.drawRightString(300, y, '$' + money(st.opening))
            c.drawString(50, y - 12, f'Ending balance on {st.end.month}/{st.end.day}')
            c.drawRightString(300, y - 12, bal(st.txs[-1].balance, 'us') if st.txs[-1].balance < 0 else '$' + money(st.txs[-1].balance))
            y -= 34
            c.setFont('Helvetica-Bold', 10)
            c.drawString(50, y, 'Transaction history')
            y -= 18
        c.setFont('Helvetica-Bold', 7.5)
        c.drawString(xs['date'], y, 'Date')
        c.drawString(xs['chk'], y, 'Check Number')
        c.drawString(xs['desc'], y, 'Description')
        c.drawRightString(xs['cr'], y, 'Deposits/Credits')
        c.drawRightString(xs['dr'], y, 'Withdrawals/Debits')
        c.drawRightString(xs['bal'], y, 'Ending daily balance')
        c.line(50, y - 4, 562, y - 4)
        return y - 16

    def footer(c, page):
        c.setFont('Helvetica', 7)
        c.drawString(50, 34, 'Redwood Valley Bank, N.A. Member FDIC.')

    p = Pager(c, LETTER, H, 72, header, footer)
    ans = answer(st, bank, 'check-number-credits-debits-daily-balance', 'USD')
    for a, t in zip(ans['transactions'], st.txs):
        h = 11 * len(t.lines) + 3
        p.need(h)
        c.setFont('Helvetica', 8)
        c.drawString(xs['date'], p.y, f'{t.day.month}/{t.day.day}')
        lines = list(t.lines)
        if lines[0].startswith('CHECK #'):
            num = lines[0].split('#')[1]
            c.drawString(xs['chk'], p.y, num)
            lines = ['Check'] + lines[1:]
            a['description'] = ' '.join([num] + lines)
        for j, line in enumerate(lines):
            c.drawString(xs['desc'], p.y - 11 * j, line)
        c.drawRightString(xs['cr'] if t.cents > 0 else xs['dr'], p.y, money(t.cents))
        if t.show_balance:
            c.drawRightString(xs['bal'], p.y, bal(t.balance, 'us'))
        p.y -= h
    p.need(18)
    c.setFont('Helvetica-Bold', 8)
    c.drawString(xs['desc'], p.y - 4, 'Totals')
    c.drawRightString(xs['cr'], p.y - 4, '$' + money(sum(t.cents for t in st.txs if t.cents > 0)))
    c.drawRightString(xs['dr'], p.y - 4, '$' + money(-sum(t.cents for t in st.txs if t.cents < 0)))
    footer(c, p.page)
    c.save()
    return ans


# ---------------------------------------------------------------- G: sections, unsigned amounts, daily balance table
def layout_daily_table(st: Statement, path: Path):
    bank = 'LAKEMONT BANK'
    W, H = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    for t in st.txs:
        t.show_balance = False
    deposits, withdrawals, checks, fees = _sections(st)
    cards = [t for t in withdrawals if t.lines[0].startswith(('SQ ', 'COSTCO', 'SHELL', 'AMZN', 'UPS', 'USPS', 'GOOGLE', 'ADOBE', 'AMAZON'))]
    electronic = [t for t in withdrawals if t not in cards]
    total = lambda ts: sum(t.cents for t in ts)
    closing = st.txs[-1].balance

    def header(c, page, first):
        c.setFont('Helvetica-Bold', 13)
        c.drawString(54, H - 58, bank)
        c.setFont('Helvetica', 8.5)
        c.drawRightString(558, H - 58, f'{st.start:%B} {st.start.day:02d}, {st.start.year} through {st.end:%B} {st.end.day:02d}, {st.end.year}')
        c.drawRightString(558, H - 71, f'Page {page}')
        y = H - 100
        if first:
            c.setFont('Helvetica-Bold', 9.5)
            c.drawString(54, y, 'CHECKING SUMMARY')
            c.setFont('Helvetica', 9)
            rows = [('Beginning Balance', '$' + money(st.opening)), ('Deposits and Additions', money(total(deposits))),
                    ('Checks Paid', '-' + money(total(checks))), ('ATM & Debit Card Withdrawals', '-' + money(total(cards))),
                    ('Electronic Withdrawals', '-' + money(total(electronic))), ('Fees', '-' + money(total(fees))),
                    ('Ending Balance', bal(closing, 'us') if closing < 0 else '$' + money(closing))]
            for i, (k, v) in enumerate(rows):
                c.drawString(70, y - 15 - i * 12, k)
                c.drawRightString(360, y - 15 - i * 12, v)
            y -= 108
        return y

    def footer(c, page):
        c.setFont('Helvetica', 7)
        c.drawString(54, 34, 'Lakemont Bank, N.A. Member FDIC')

    p = Pager(c, LETTER, H, 76, header, footer)
    xs = dict(date=54, desc=110, amt=558)

    def section(title, ts, check_table=False):
        if not ts:
            return
        p.need(52)
        c.setFont('Helvetica-Bold', 9.5)
        c.drawString(54, p.y - 6, title)
        p.y -= 22
        c.setFont('Helvetica-Bold', 8)
        if check_table:
            c.drawString(54, p.y, 'CHECK NO.')
            c.drawString(150, p.y, 'DESCRIPTION')
            c.drawString(400, p.y, 'DATE PAID')
        else:
            c.drawString(xs['date'], p.y, 'DATE')
            c.drawString(xs['desc'], p.y, 'DESCRIPTION')
        c.drawRightString(xs['amt'], p.y, 'AMOUNT')
        c.line(54, p.y - 4, 558, p.y - 4)
        p.y -= 16
        for t in ts:
            h = 11 * len(t.lines) + 3
            p.need(h)
            c.setFont('Helvetica', 8)
            if check_table:
                c.drawString(54, p.y, t.lines[0].split('#')[1])
                c.drawString(150, p.y, '^')
                c.drawString(400, p.y, f'{t.day:%m/%d}')
            else:
                c.drawString(xs['date'], p.y, f'{t.day:%m/%d}')
                for j, line in enumerate(t.lines):
                    c.drawString(xs['desc'], p.y - 11 * j, line)
            c.drawRightString(xs['amt'], p.y, '$' + money(t.cents))
            p.y -= h
        p.need(18)
        c.setFont('Helvetica-Bold', 8)
        c.drawString(xs['desc'], p.y - 2, f'Total {title.title()}')
        c.drawRightString(xs['amt'], p.y - 2, '$' + money(abs(total(ts))))
        p.y -= 26

    section('DEPOSITS AND ADDITIONS', deposits)
    section('CHECKS PAID', checks, check_table=True)
    section('ATM & DEBIT CARD WITHDRAWALS', cards)
    section('ELECTRONIC WITHDRAWALS', electronic)
    section('FEES', fees)
    # the balance at the end of every day with activity, three pairs to a line
    days = []
    for i, t in enumerate(st.txs):
        if i == len(st.txs) - 1 or st.txs[i + 1].day != t.day:
            days.append((t.day, t.balance))
    p.need(40)
    c.setFont('Helvetica-Bold', 9.5)
    c.drawString(54, p.y - 6, 'DAILY ENDING BALANCE')
    p.y -= 22
    c.setFont('Helvetica-Bold', 8)
    for k, x in enumerate((54, 230, 406)):
        c.drawString(x, p.y, 'DATE')
        c.drawRightString(x + 140, p.y, 'AMOUNT')
    p.y -= 14
    for r in range(0, len(days), 3):
        p.need(12)
        c.setFont('Helvetica', 8)
        for k, (d, b) in enumerate(days[r:r + 3]):
            x = (54, 230, 406)[k]
            c.drawString(x, p.y, f'{d:%m/%d}')
            c.drawRightString(x + 140, p.y, bal(b, 'us') if b < 0 else '$' + money(b))
        p.y -= 12
    footer(c, p.page)
    c.save()
    ans = answer(st, bank, 'sections-unsigned-daily-balance-table', 'USD')
    # the answer key in date order (the ledger lists rows by date when balances are only given per day)
    for a, t in zip(ans['transactions'], st.txs):
        if t.lines[0].startswith('CHECK #'):
            a['description'] = t.lines[0].split('#')[1] + ' ^'
        a['balance_cents'] = None
    ans['closing_cents'] = closing
    return ans


def scanned_copy(src: Path, dst_pdf: Path, dst_png: Path, rng: random.Random, dpi=150):
    """Rasterise, tilt a little, add grain and JPEG artefacts, then wrap the pages in an image-only PDF."""
    doc = fitz.open(src)
    out = fitz.open()
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        img = Image.frombytes('L', (pix.width, pix.height), pix.samples)
        img = img.rotate(rng.uniform(-0.8, 0.8), resample=Image.BICUBIC, expand=False, fillcolor=250)
        noise = Image.effect_noise(img.size, 9).point(lambda v: v - 128 + 128)
        img = Image.blend(img, noise, 0.06).filter(ImageFilter.GaussianBlur(0.35))
        buf = io.BytesIO()
        img.convert('L').save(buf, 'JPEG', quality=72)
        if i == 0:
            dst_png.write_bytes(buf.getvalue())
        rect = page.rect
        np = out.new_page(width=rect.width, height=rect.height)
        np.insert_image(rect, stream=buf.getvalue())
    out.save(dst_pdf)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261014)
    jobs = [
        ('harbor-pine-2026-09', layout_us, date(2026, 9, 1), 64),
        ('northgate-2026-09', layout_uk, date(2026, 9, 1), 58),
        ('aurelia-2026-09', layout_eu, date(2026, 9, 1), 47),
        ('kestrel-2026-12', layout_crdr, date(2026, 12, 1), 52),
        ('bayside-2026-10', layout_sections, date(2026, 10, 1), 55),
        ('redwood-2026-10', layout_checknum, date(2026, 10, 1), 61),
        ('lakemont-2026-10', layout_daily_table, date(2026, 10, 1), 49),
    ]
    for key, fn, start, n in jobs:
        st = month_of(rng, key, start, n)
        pdf = OUT / f'{key}.pdf'
        ans = fn(st, pdf, rng) if fn is layout_eu else fn(st, pdf)
        (OUT / f'{key}.json').write_text(json.dumps(ans, indent=1), encoding='utf-8')
        scanned_copy(pdf, OUT / f'{key}-scan.pdf', OUT / f'{key}-scan-p1.jpg', rng)
        pages = len(fitz.open(pdf))
        print(f'{key}: {len(ans["transactions"])} transactions, {pages} pages, '
              f'opening {ans["opening_cents"] / 100:.2f}, closing {ans["closing_cents"] / 100:.2f}')


if __name__ == '__main__':
    main()

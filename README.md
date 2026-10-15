# Tickmark

Bank statements into spreadsheets, checked row by row, on your own computer.

Open a PDF statement in the browser. Tickmark copies every transaction into a ledger and adds it to the running
balance. A row gets a tick only when the balance the bank printed agrees to the cent; a row that does not agree is
ringed in red, with the gap and the place to look. Scanned statements are read by **Gemma 4**, Google's open model,
running on your graphics card through WebGPU, and go through the same check, so a figure the model misreads shows
up as a row that does not tie instead of slipping into your books.

Nothing is uploaded. The page counts every request it makes to another site and shows the number at the bottom.

## What it reads

- Text PDFs as banks issue them: one table or sections by kind (deposits, withdrawals, checks, fees), one signed amount column, separate money-in and money-out columns, a check-number column, a separate daily-balance table, CR and DR
  markers, balances on every row or only at the end of each day, overdrawn balances (`-`, `OD`, a trailing minus),
  decimal commas, two date columns (booking and value), descriptions that run onto several lines, balances brought
  and carried forward between pages.
- Scanned PDFs, with Gemma 4 E2B (the model is downloaded once, about 3.4 GB, and kept in the browser).

## What it writes

Excel (a transactions sheet and a reconciliation sheet), CSV, QuickBooks Online CSV, Xero CSV and OFX.

## Run it

```
npm install
npm run dev        # http://127.0.0.1:5470
npm test           # parser, balance checks and exports against the sample statements
```

The sample statements in `public/samples/` and `fixtures/statements/` are made up: invented banks, a fictional
coffee roaster and numbers drawn by `tools/make_statements.py`, which also writes the answer key for each one.

## Credits

[pdf.js](https://mozilla.github.io/pdf.js/) reads and draws the PDFs. [Transformers.js](https://huggingface.co/docs/transformers.js)
and ONNX Runtime Web run [Gemma 4 E2B](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) (Apache 2.0) in the
browser. [Preact](https://preactjs.com/), [Geist](https://vercel.com/font) and [Phosphor](https://phosphoricons.com/) icons.

## License

MIT, Copyright (c) 2026 fuddle_yichi

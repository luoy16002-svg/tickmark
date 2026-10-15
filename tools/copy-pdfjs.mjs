// pdf.js needs its standard fonts and character maps at run time; copy them from the installed package so the
// site serves them itself (no CDN) without keeping copies in the repository.
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
for (const dir of ['standard_fonts', 'cmaps']) {
  const to = join(root, 'public', 'pdfjs', dir);
  if (!existsSync(to)) cpSync(join(root, 'node_modules', 'pdfjs-dist', dir), to, { recursive: true });
}

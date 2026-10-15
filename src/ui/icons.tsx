// One icon family (Phosphor, regular weight), inlined so the page loads nothing from elsewhere.
import caretDown from '@phosphor-icons/core/assets/regular/caret-down.svg?raw';
import downloadSimple from '@phosphor-icons/core/assets/regular/download-simple.svg?raw';
import filePdf from '@phosphor-icons/core/assets/regular/file-pdf.svg?raw';
import arrowCounterClockwise from '@phosphor-icons/core/assets/regular/arrow-counter-clockwise.svg?raw';
import warningCircle from '@phosphor-icons/core/assets/regular/warning-circle.svg?raw';
import x from '@phosphor-icons/core/assets/regular/x.svg?raw';
import scan from '@phosphor-icons/core/assets/regular/scan.svg?raw';
import shieldCheck from '@phosphor-icons/core/assets/regular/shield-check.svg?raw';
import arrowLeft from '@phosphor-icons/core/assets/regular/arrow-left.svg?raw';
import arrowRight from '@phosphor-icons/core/assets/regular/arrow-right.svg?raw';
import tag from '@phosphor-icons/core/assets/regular/tag.svg?raw';

const ICONS = { caretDown, downloadSimple, filePdf, arrowCounterClockwise, warningCircle, x, scan, shieldCheck, arrowLeft, arrowRight, tag };
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const svg = ICONS[name].replace('<svg ', `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" `);
  return <span class="icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** The auditor's tick, drawn the way a pencil leaves it: a short down-stroke and a long rise. */
export function Tick({ day = false }: { day?: boolean }) {
  return (
    <svg class={day ? 'tick tick-day' : 'tick'} viewBox="0 0 24 18" width="22" height="16" aria-hidden="true">
      <path d="M2.6 9.8c1.6 1.1 3.1 2.6 4.6 5.1.4.6 1 .6 1.3 0C11.4 9.3 15.7 4.5 21.6 1.6" />
      {day ? null : <path d="M3.4 10.6c1.3.9 2.6 2.2 3.9 4.2" class="tick-double" />}
    </svg>
  );
}

/** The red pencil ring a checker draws round a figure that does not agree. */
export function Ring() {
  return (
    <svg class="ring" viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">
      <path d="M8 18C7 9 33 3.6 62 3.4c27-.2 51 3.9 51 13.4 0 9.6-25 14.5-55 14.3C29 30.9 6.5 26.4 7.3 15.2c.5-6 9-9.6 19-11.2" />
    </svg>
  );
}

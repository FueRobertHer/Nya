// lib/import/dates.ts
//
// Reading the dates banks write, for the import parsers. Pure, safe to import
// from client code.
//
// A DAY, NOT AN INSTANT. A transaction's date is a calendar day at the bank,
// as Plaid's are (lib/local-date.ts), so the day is taken as written and a
// time or a time zone after it is ignored: OFX's "20260105230000[-5:EST]" is
// January 5, even though that moment is January 6 in UTC. Converting it would
// move transactions across days, and across months at a month's end.
//
// THE ORDER OF A NUMERIC DATE. "03/04/2026" is March 4 in the US and April 3
// in the UK and most of Europe, and nothing in the date says which. A column
// (or a QIF file) is read in one order: the one its dates fit, when some of
// them fit only one ("13/04/2026" is day first). When every date fits both,
// the person says which; it is never guessed, because a guess would put every
// transaction on the wrong day without anything looking wrong. A date that
// reads the same either way ("05/05/2026") decides nothing. ISO dates
// (2026-04-03), compact ones (20260403) and dates with the month named
// ("3 Apr 2026", "Apr 3, 2026") are never ambiguous.
//
// TWO-DIGIT YEARS are this century unless that would be more than a year
// ahead, so "26" is 2026 and "99" is 1999. Quicken writes years from 2000 on
// with an apostrophe ("1/2'26", "1/2' 5" for 2005), which always means 2000
// and after.

export type DateOrder = 'mdy' | 'dmy';

export const DATE_ORDERS: readonly DateOrder[] = ['mdy', 'dmy'];

/** The orders, as the import sheet names them. */
export const DATE_ORDER_NAMES: Record<DateOrder, string> = {
  mdy: 'month/day/year (US)',
  dmy: 'day/month/year (UK, Europe)',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A real calendar day as YYYY-MM-DD, or null. */
function dayOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** A year as written: four digits, two (see the header), or one or two after
 *  Quicken's apostrophe. */
function fullYear(text: string, apostrophe: boolean, thisYear: number): number | null {
  const n = Number(text);
  if (apostrophe) return text.length <= 2 ? 2000 + n : text.length === 4 ? n : null;
  if (text.length === 4) return n;
  if (text.length !== 2) return null;
  return 2000 + n > thisYear + 1 ? 1900 + n : 2000 + n;
}

/** How a date is written: ISO's year-month-day, the same run together, with
 *  the month named, or numbers with the year last (whose order a file
 *  settles, or the person). */
export type DateStyle = 'iso' | 'compact' | 'named' | DateOrder;

/** The styles, as the import sheet says how a file's dates were read. */
export const DATE_STYLE_NAMES: Record<DateStyle, string> = {
  iso: 'year-month-day (2026-09-30)',
  compact: 'year, month and day run together (20260930)',
  named: 'with the month named (30 Sep 2026)',
  mdy: DATE_ORDER_NAMES.mdy,
  dmy: DATE_ORDER_NAMES.dmy,
};

/** How a date can be read: as one day whatever the order (with how it is
 *  written; 'numeric' for numbers that read the same either way), or as the
 *  day each order makes of it (null where that order makes no real day). */
export type DateReading =
  | { kind: 'fixed'; day: string; style: 'iso' | 'compact' | 'named' | 'numeric' }
  | { kind: 'ordered'; mdy: string | null; dmy: string | null };

const fixed = (day: string | null, style: 'iso' | 'compact' | 'named' | 'numeric'): DateReading | null => (day ? { kind: 'fixed', day, style } : null);

/** A time after a date, which a day doesn't need: "14:22", "2:22 PM", "14:22:01.5Z". */
const TIME = /(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AaPp]\.?[Mm]\.?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT))?)$/;

/**
 * A date as a bank writes it in a CSV or QIF file, read as far as it can be
 * without knowing the file's order (see the header), or null if it isn't a
 * date. `thisYear` places two-digit years.
 */
export function readDateText(input: string, thisYear: number): DateReading | null {
  let s = input.trim();
  if (!s || s.length > 40) return null;
  s = s.replace(TIME, '').trim();
  // Quicken pads with spaces ("1/ 2'26"); nothing else needs them kept.
  s = s.replace(/\s*([/.\-'])\s*/g, '$1');
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})\.?$/.exec(s))) return fixed(dayOf(+m[1], +m[3], +m[4]), 'iso');
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return fixed(dayOf(+m[1], +m[2], +m[3]), 'compact');
  if ((m = /^(\d{1,2})([-/.])(\d{1,2})(?:\2|('))(\d{1,4})\.?$/.exec(s))) {
    const year = fullYear(m[5], m[4] === "'", thisYear);
    if (year === null) return null;
    const a = Number(m[1]);
    const b = Number(m[3]);
    const mdy = dayOf(year, a, b);
    const dmy = dayOf(year, b, a);
    if (!mdy && !dmy) return null;
    // The same day either way decides nothing.
    if (mdy && mdy === dmy) return { kind: 'fixed', day: mdy, style: 'numeric' };
    return { kind: 'ordered', mdy, dmy };
  }
  // The month named: "30 Sep 2026", "30-Sep-26", "30. September 2026".
  if ((m = /^(\d{1,2})[-.\s]*([A-Za-z]{3,9})\.?[-.,\s]*(\d{2}|\d{4})$/.exec(s))) {
    const month = MONTHS[m[2].toLowerCase()];
    const year = fullYear(m[3], false, thisYear);
    return month && year ? fixed(dayOf(year, month, Number(m[1])), 'named') : null;
  }
  // "Sep 30, 2026", "September 30 2026", "Sep 30th, 2026".
  if ((m = /^([A-Za-z]{3,9})\.?[-.\s]*(\d{1,2})(?:st|nd|rd|th)?,?[-.\s]*(\d{2}|\d{4})$/.exec(s))) {
    const month = MONTHS[m[1].toLowerCase()];
    const year = fullYear(m[3], false, thisYear);
    return month && year ? fixed(dayOf(year, month, Number(m[2])), 'named') : null;
  }
  return null;
}

/** How most of these dates are written, numbers read in `order` (for the
 *  sheet's "dates read as"), or null when none reads. */
export function dateStyle(texts: Iterable<string>, order: DateOrder | null, thisYear: number): DateStyle | null {
  const counts = new Map<DateStyle, number>();
  for (const t of texts) {
    const r = readDateText(t, thisYear);
    if (!r) continue;
    const style: DateStyle | null = r.kind === 'ordered' || r.style === 'numeric' ? order : r.style;
    if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  let best: DateStyle | null = null;
  for (const [style, n] of counts) if (best === null || n > counts.get(best)!) best = style;
  return best;
}

/** What the dates of a column (or a QIF file) say about their order. */
export type DateDetection = {
  /** The order every date that depends on one fits, or null. */
  order: DateOrder | null;
  /** Every such date fits both orders: the person must say which. */
  ambiguous: boolean;
  /** Some fit only one order and others only the other: the file mixes
   *  them, and the person says which to read (the rest can't be read). */
  mixed: boolean;
};

/** The order a set of dates is in, as far as they say (see the header). */
export function detectDateOrder(texts: Iterable<string>, thisYear: number): DateDetection {
  let onlyMdy = 0;
  let onlyDmy = 0;
  let both = 0;
  for (const t of texts) {
    const r = readDateText(t, thisYear);
    if (r?.kind !== 'ordered') continue;
    if (r.mdy && r.dmy) both++;
    else if (r.mdy) onlyMdy++;
    else onlyDmy++;
  }
  if (onlyMdy > 0 && onlyDmy > 0) return { order: null, ambiguous: false, mixed: true };
  if (onlyMdy > 0) return { order: 'mdy', ambiguous: false, mixed: false };
  if (onlyDmy > 0) return { order: 'dmy', ambiguous: false, mixed: false };
  return { order: null, ambiguous: both > 0, mixed: false };
}

/** The day a date text is, read in `order` where it depends on one; null when
 *  it isn't a date, isn't one in that order, or needs an order none was given. */
export function dateFor(text: string, order: DateOrder | null, thisYear: number): string | null {
  const r = readDateText(text, thisYear);
  if (!r) return null;
  if (r.kind === 'fixed') return r.day;
  if (!order) return null;
  return order === 'mdy' ? r.mdy : r.dmy;
}

// ---- OFX ----

/** OFX's datetime: YYYYMMDD, then optionally HHMMSS, milliseconds and a zone in
 *  brackets ("[-5:EST]", "[+5.30:IST]", "[0:GMT]", "[-5]"). */
const OFX_DATE = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,]\d{1,6})?)?)?)?\s*(?:\[[^\]]{0,40}\])?$/;

/**
 * The day an OFX date is on, as written (see the header), or null. Tolerant
 * of what banks write beside the standard: a time without a zone, a zone
 * without a name, a "T" before the time, hyphens in the date.
 */
export function ofxDay(input: string): string | null {
  const s = input.trim();
  const m = OFX_DATE.exec(s);
  if (m) {
    if ((m[4] && +m[4] > 23) || (m[5] && +m[5] > 59) || (m[6] && +m[6] > 60)) return null;
    return dayOf(+m[1], +m[2], +m[3]);
  }
  const loose = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T\s]\S*)?$/.exec(s);
  return loose ? dayOf(+loose[1], +loose[2], +loose[3]) : null;
}

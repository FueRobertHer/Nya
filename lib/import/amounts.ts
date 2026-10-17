// lib/import/amounts.ts
//
// Reading the amounts banks write, for the CSV and QIF parsers (OFX's are
// plainer, ofx.ts). Pure, safe to import from client code.
//
// THE DECIMAL MARK is the file's, not guessed per amount: "1,234" is a
// thousand and more with a point for decimals, and one and a bit with a
// comma. A file is read with one mark, found from its amounts (the mark
// before the last one or two digits, where they show one) or chosen by the
// person, and the other mark (or a space, or an apostrophe, as Switzerland
// writes them) may only group digits in threes. So with the wrong mark
// most amounts fail to read and the preview says so, rather than every
// amount coming out a hundred times too large.
//
// SIGNS as banks write them: a minus or a plus before or after the number,
// the Unicode minus sign, parentheses for a negative ("(12.34)"), and a
// trailing CR or DR, which says the direction instead (credit: money in;
// debit: money out). Currency symbols are dropped; letters other than CR and
// DR (a currency code, a word) make the amount unreadable, since they might
// say something the number doesn't.

export type DecimalMark = '.' | ',';

export const DECIMAL_NAMES: Record<DecimalMark, string> = { '.': 'a point (1,234.56)', ',': 'a comma (1.234,56)' };

/** An amount as written: its value with the sign it carries, and the
 *  direction a CR or DR gave it, if any. */
export type AmountText = { value: number; direction?: 'in' | 'out' };

const SYMBOLS = /[$€£¥₹₩₽¢₺₪฿₫₴₦₱]/g;
/** Spaces a number may be grouped with: the ordinary one, no-break and thin. */
const SPACES = /[\s    ]/g;

/** The amount, or null if it isn't one in this decimal mark (see the header). */
export function readAmount(input: string, decimal: DecimalMark): AmountText | null {
  let s = input.replace(/−/g, '-').trim();
  if (!s || s.length > 40) return null;
  let direction: AmountText['direction'];
  const drcr = /\s*(CR|DR)\.?$/i.exec(s);
  if (drcr) {
    direction = drcr[1].toUpperCase() === 'CR' ? 'in' : 'out';
    s = s.slice(0, drcr.index).trim();
  }
  s = s.replace(SYMBOLS, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const lead = /^([+-])\s*/.exec(s);
  if (lead) {
    negative = negative !== (lead[1] === '-');
    s = s.slice(lead[0].length);
  } else {
    const trail = /\s*([+-])$/.exec(s);
    if (trail) {
      negative = negative !== (trail[1] === '-');
      s = s.slice(0, trail.index);
    }
  }
  s = s.replace(SYMBOLS, '').trim();
  const group = decimal === '.' ? ',' : '.';
  const at = s.lastIndexOf(decimal);
  const whole = at >= 0 ? s.slice(0, at) : s;
  const fraction = at >= 0 ? s.slice(at + 1) : '';
  if (at >= 0 && !/^\d+$/.test(fraction)) return null;
  // The whole part: plain digits, or digits grouped in threes by one mark.
  const grouping = new RegExp(`^\\d{1,3}(?:([\\${group}' \\u00a0\\u2007\\u2009\\u202f])\\d{3}(?:\\1\\d{3})*)?$`);
  let digits: string;
  if (/^\d*$/.test(whole)) digits = whole;
  else if (grouping.test(whole)) digits = whole.replace(new RegExp(`[\\${group}']`, 'g'), '').replace(SPACES, '');
  else return null;
  if (digits === '' && fraction === '') return null;
  const value = Number(`${digits || '0'}.${fraction || '0'}`);
  if (!Number.isFinite(value)) return null;
  return direction ? { value: negative ? -value : value, direction } : { value: negative ? -value : value };
}

/**
 * The decimal mark a set of amounts shows, or null when none shows one: the
 * mark before the last one or two digits (a cent or a tenth), or the later of
 * two marks in one amount. Three digits after the only mark say nothing
 * ("1,234" could be either). The mark most amounts show wins.
 */
export function detectDecimalMark(texts: Iterable<string>): DecimalMark | null {
  let point = 0;
  let comma = 0;
  for (const raw of texts) {
    const s = raw.replace(SPACES, '').replace(/[^0-9.,]/g, '');
    const dot = s.lastIndexOf('.');
    const com = s.lastIndexOf(',');
    if (dot < 0 && com < 0) continue;
    if (dot >= 0 && com >= 0) {
      if (dot > com) point++;
      else comma++;
      continue;
    }
    const at = Math.max(dot, com);
    const after = s.length - at - 1;
    if (after === 1 || after === 2) {
      if (dot >= 0) point++;
      else comma++;
    }
  }
  if (point === 0 && comma === 0) return null;
  return comma > point ? ',' : '.';
}

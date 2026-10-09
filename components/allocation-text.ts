// Wording and colors for the allocation views (components/AllocationCard.tsx),
// kept apart from the components so the sentences can be tested
// (test/allocation-view.test.tsx). Imports nothing heavy.
//
// COLORS. Each class keeps its color wherever it is drawn (the bar, the
// table's swatch, the chart over time), in the order the classes are shown
// (lib/allocation/classes.ts ASSET_CLASSES): the dark steps of the default
// categorical palette, whose order was checked against this app's card
// surface (#171a21) for telling neighbours apart, with and without colour
// vision deficiency, and contrast. Unclassified is a neutral gray, never a
// class's hue: it is money whose class isn't known. Tax buckets are another
// set of things, shown in another view, so they take the palette from its
// first slot again. Identity never rests on color alone: every swatch has its
// name beside it, and every figure is in a table.

import type { AccountGap, PlanMix } from '@/lib/allocation/allocation';
import { BUCKET_NAMES, type BucketSlot } from '@/lib/allocation/buckets';
import { CLASS_NAMES, CLASS_WORDS, splitText, type Classified, type Slot } from '@/lib/allocation/classes';
import { wholeMoney } from './plan-text';

export const UNCLASSIFIED_COLOR = '#6f7480';

export const CLASS_COLORS: Record<Slot, string> = {
  'us-stocks': '#3987e5',
  'intl-stocks': '#d95926',
  bonds: '#199e70',
  cash: '#c98500',
  stocks: '#d55181',
  'real-estate': '#008300',
  crypto: '#9085e9',
  other: '#e66767',
  unclassified: UNCLASSIFIED_COLOR,
};

export const BUCKET_COLORS: Record<BucketSlot, string> = {
  taxable: '#3987e5',
  'tax-deferred': '#d95926',
  roth: '#199e70',
  hsa: '#c98500',
  education: '#d55181',
  unclassified: UNCLASSIFIED_COLOR,
};

export const slotName = (s: Slot) => CLASS_NAMES[s];
export const bucketName = (b: BucketSlot) => BUCKET_NAMES[b];

/** "A, B and C". */
export function names(list: string[]): string {
  const unique = [...new Set(list)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** Why a security is where it is, as a sentence without its full stop, for
 *  its row. */
export function classifiedText(k: Classified): string {
  if (k.split) {
    const what = splitText(k.split);
    switch (k.by) {
      case 'yours':
        return `${what}, as you set it`;
      case 'cash':
        return 'Cash: a cash or money market position';
      case 'list':
        return `${what}, from Nya's list of index funds`;
      case 'type':
        return `${what}, by its type`;
    }
  }
  switch (k.why) {
    case 'fund':
      return "Unclassified: a fund whose mix Nya doesn't know (a target-date or balanced fund, say)";
    case 'unknown':
      return "Unclassified: Plaid doesn't say what kind of security it is";
    case 'bad-split':
      return "Unclassified: the split saved for it doesn't add up to 100%";
  }
}

/** Why account money is unclassified, or how it is classified, for its row. */
export function gapText(g: AccountGap, fmtDay: (day: string, at: string | null) => string): string {
  const where = `${g.account} at ${g.institution}`;
  const classified = g.split ? `, classified as you set it: ${splitText(g.split)}` : '';
  switch (g.kind) {
    case 'no-positions':
      return g.manual
        ? `${g.account} is an account you track by hand, with no positions to go by${classified}`
        : `${where} lists no position Nya can value${classified}`;
    case 'not-in-position':
      return `${where}: part of its balance isn't in any position it lists (often cash)${classified}`;
    case 'unreachable':
      return `${where} couldn't be reached${g.asOf ? `, so its balance is from ${fmtDay(g.asOf, g.asOfAt)} and` : ', so'} what it holds isn't known`;
  }
}

/** To one decimal, halves away from zero, so a drift under its target reads
 *  the same size as one over it. */
const oneDecimal = (n: number) => (Math.sign(n) * Math.round(Math.abs(n) * 10)) / 10;

/** A drift in percentage points: "+3.2 points", "-5 points", "on target". */
export function pointsText(diff: number): string {
  const r = oneDecimal(diff);
  if (r === 0) return 'on target';
  return `${r > 0 ? '+' : ''}${r} point${Math.abs(r) === 1 ? '' : 's'}`;
}

/** A percent of the whole to one decimal, for drift tables: "54.3%". */
export const tenthPct = (p: number) => `${oneDecimal(p) || 0}%`;

/** The Plan's mix in words: "72% stocks, 20% bonds, 8% cash". */
export function mixText(m: { stocksPct: number; bondsPct: number; cashPct?: number }): string {
  const cash = m.cashPct ?? 100 - m.stocksPct - m.bondsPct;
  return `${m.stocksPct}% stocks, ${m.bondsPct}% bonds, ${cash}% cash`;
}

/** What the Plan's mix left out, in a sentence, or null when nothing was. */
export function leftOutText(m: PlanMix, currency: string | null): string | null {
  const money = (n: number) => wholeMoney(n, currency);
  const parts = m.leftOut.map((l) => (l.slot === 'unclassified' ? `${money(l.amount)} unclassified` : `${money(l.amount)} of ${CLASS_WORDS[l.slot]}`));
  const classes = parts.length
    ? `Left out: ${names(parts)}, which ${m.leftOut.length === 1 && m.leftOut[0].slot === 'unclassified' ? "can't be counted as stocks or bonds without knowing what it is" : "the simulation's stocks, bonds and cash can't stand for"}.`
    : null;
  const other = m.otherCurrencies.length
    ? `${names(m.otherCurrencies.map((o) => wholeMoney(o.amount, o.currency)))} in ${m.otherCurrencies.length === 1 ? 'another currency' : 'other currencies'} ${m.otherCurrencies.length === 1 ? 'is' : 'are'} left out too: Nya doesn't convert currencies.`
    : null;
  const all = [classes, other].filter((x): x is string => !!x);
  return all.length ? all.join(' ') : null;
}

/** Why the Plan's mix can't be taken from the allocation. */
export function noMixText(why: 'nothing' | 'negative'): string {
  return why === 'negative'
    ? "Your cash is below zero (money borrowed on margin, say), which a mix of shares can't hold, so set the plan's mix yourself."
    : 'Nothing is classified as stocks, bonds or cash yet, so there is no mix to use.';
}

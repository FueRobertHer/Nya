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

import { isMoney, shareLabel, type AccountGap, type AllocCaveat, type PlanMix } from '@/lib/allocation/allocation';
import type { BucketSlot } from '@/lib/allocation/buckets';
import { CLASS_WORDS, splitText, type Classified, type Slot } from '@/lib/allocation/classes';
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
      return "Unclassified: a fund whose mix Nya doesn't know (a target-date fund, whose mix moves every year, or an actively managed one, say)";
    case 'leveraged':
      return "Unclassified: a leveraged or inverse fund, which moves by a multiple of what it tracks, or against it, so it isn't counted as what it tracks";
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
        : `${g.institution} lists no positions for ${g.account}${classified}`;
    case 'no-answer':
      // The holdings call failed for it this time: its split, for money
      // beyond its positions, isn't applied to what it holds.
      return `No positions came from ${g.institution} for ${g.account} this time, so what it holds isn't known`;
    case 'not-in-position':
      return `${where}: part of its balance isn't in any position it lists (often cash)${classified}`;
    case 'unreachable':
      return `${where} couldn't be reached${g.asOf ? `, so its balance is from ${fmtDay(g.asOf, g.asOfAt)} and` : ', so'} what it holds isn't known`;
  }
}

/** Why figures may be short, for one of the allocation's caveats: `what` is
 *  the figure ("this", "the latest days"). The same words under today's
 *  allocation and under the mix over time. */
export function caveatText(c: AllocCaveat, what: string): string {
  return c.kind === 'unreachable'
    ? `${c.institution} couldn't be reached and isn't counted, so ${what} may be short.`
    : `${c.count} account${c.count === 1 ? '' : 's'} at ${c.institution} couldn't be shown, so ${what} may be short.`;
}

/** To one decimal, halves away from zero, so a drift under its target reads
 *  the same size as one over it. */
const oneDecimal = (n: number) => (Math.sign(n) * Math.round(Math.abs(n) * 10)) / 10;

/** Whether a drift is too small to show at a tenth of a point. */
export const onTarget = (diff: number) => oneDecimal(diff) === 0;

/** A drift in percentage points: "+3.2 points", "-5 points", "on target". */
export function pointsText(diff: number): string {
  const r = oneDecimal(diff);
  if (r === 0) return 'on target';
  return `${r > 0 ? '+' : ''}${r} point${Math.abs(r) === 1 ? '' : 's'}`;
}

/** A percent of the whole to one decimal, for drift tables: "54.3%". As
 *  the shares are said (shareLabel), money that is there never reads 0%
 *  ("<0.1%"), and a share short of the whole never reads 100% (">99.9%"). */
export function tenthPct(p: number): string {
  const r = oneDecimal(p);
  if (p > 0 && r <= 0) return '<0.1%';
  if (p < 0 && r >= 0) return '>-0.1%';
  if (p < 100 && r >= 100) return '>99.9%';
  return `${r || 0}%`;
}

/** The Plan's mix in words: "72% stocks, 20% bonds, 8% cash". */
export function mixText(m: { stocksPct: number; bondsPct: number; cashPct?: number }): string {
  const cash = m.cashPct ?? 100 - m.stocksPct - m.bondsPct;
  return `${m.stocksPct}% stocks, ${m.bondsPct}% bonds, ${cash}% cash`;
}

/**
 * What the Plan's mix is of, as the start of a sentence its percents follow:
 * "Of the $160,000 in your accounts, $100,000 is classified as stocks, bonds
 * or cash". The mix is of the classified part only, so it is never said as
 * what "your accounts hold".
 */
export function mixBasisText(m: PlanMix, currency: string | null): string {
  const money = (n: number) => wholeMoney(n, currency);
  const counted = m.stocks + m.bonds + m.cash;
  const bank = m.bank > 0 ? ` (with ${money(m.bank)} of checking and savings as cash, as your plan counts them)` : '';
  const where = m.otherCurrencies.length && currency ? `your accounts hold in ${currency}` : 'in your accounts';
  return isMoney(m.whole - counted)
    ? `Of the ${money(m.whole)} ${where}, ${money(counted)} is classified as stocks, bonds or cash${bank}`
    : `All ${money(counted)} ${where} is classified as stocks, bonds or cash${bank}`;
}

/** What the Plan's mix left out, in a sentence, or null when nothing was:
 *  each class with its amount, and their share of the whole, as the share
 *  table has it; then what is in another currency. */
export function mixLeftOutText(m: PlanMix, currency: string | null): string | null {
  const money = (n: number) => wholeMoney(n, currency);
  const parts = m.leftOut.map((l) => (l.slot === 'unclassified' ? `${money(l.amount)} unclassified` : `${money(l.amount)} of ${CLASS_WORDS[l.slot]}`));
  const left = m.leftOut.reduce((s, l) => s + l.amount, 0);
  const share = m.leftOutPct !== null && left > 0 ? `, ${shareLabel(left, m.leftOutPct, m.whole)} of the ${money(m.whole)}` : '';
  const classes = parts.length
    ? `Left out: ${names(parts)}${share}, which ${m.leftOut.length === 1 && m.leftOut[0].slot === 'unclassified' ? "can't be counted as stocks or bonds without knowing what it is" : "the simulation's stocks, bonds and cash can't stand for"}.`
    : null;
  const one = m.otherCurrencies.length === 1;
  const other = m.otherCurrencies.length
    ? `${names(m.otherCurrencies.map((o) => wholeMoney(o.amount, o.currency)))} in ${one ? 'another currency' : 'other currencies'} ${one ? 'is' : 'are'} left out${classes ? ' too' : ''}: Nya doesn't convert currencies.`
    : null;
  const all = [classes, other].filter((x): x is string => !!x);
  return all.length ? all.join(' ') : null;
}

/** Why the Plan's mix can't be taken from the allocation: nothing to take it
 *  from, or which of stocks, bonds and cash is below zero, and what could put
 *  it there. */
export function noMixText(m: Extract<PlanMix, { ok: false }>): string {
  if (m.why === 'nothing') return 'Nothing is classified as stocks, bonds or cash yet, so there is no mix to use.';
  const why = (k: 'stocks' | 'bonds' | 'cash') =>
    k === 'cash' ? (m.bank < 0 ? 'an overdrawn account the plan counts as cash, say' : 'money borrowed on margin, say') : 'a short position, say';
  const what = m.below.map((k) => `${k} (${why(k)})`);
  const one = m.below.length === 1;
  return `Your ${names(what)} ${one ? (m.below[0] === 'cash' ? 'is' : 'are') : 'are'} below zero, which a mix of shares can't hold, so set the plan's mix yourself.`;
}

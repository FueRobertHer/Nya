// lib/shared-expenses/match.ts
//
// Which of the person's own transactions may have paid back what someone owes
// them, or paid what they owe someone (#49): proposals, ranked, never facts.
// Pure, safe in the browser: the Activity tab runs it over the rows it has
// already loaded, and nothing on the server computes or stores a proposal.
// Only the person's tap on Confirm writes a payment
// (app/api/shared-expenses/payments, lib/shared-expenses/edits.ts).
//
// CANDIDATES, for a person with an open balance in a currency (not archived):
// the rows in that currency as written (never a converted copy), in the
// balance's direction (money in when they owe you, money out when you owe
// them), posted, dated on or after their oldest open item and within
// WINDOW_DAYS after the newest of their last request and their newest open
// item, and not already a payment, said to be none, shared, split, in a
// group, or a row this feature added.
//
// SIGNALS:
//   - the amount, in the currency's minor units: what was requested, the
//     balance, a set of their open items (among the oldest SUBSET_ITEMS,
//     worked out once per person; between sets with one sum, the oldest
//     first, and the proposal says there was a choice), less, or more;
//   - a payment app named on the row (its name, the merchant behind a
//     processor, the processor), stronger when it is the person's own app;
//   - the person's name (every word of two letters or more, as whole words)
//     or their handle on the row;
//   - the days since the request, else since their newest open item.
// The words payment apps leave on bank rows ("VENMO CASHOUT", "Zelle payment
// from ...") are examples recalled, not documented by any bank, so they are
// a signal, never proof.
//
// TIERS. Strong (the only one preselected): the amount requested, the
// balance or a set of items, with the app or the name. Likely: the name,
// with less or more than the balance. Possible: one of those amounts alone,
// the app with less or more, or one row equal to two or three people's
// balances together with the app (a batched cashout). A row filed under a
// spending category, or with a merchant's name that isn't a payment app's,
// is at most possible: a store's refund of the same amount is no repayment.
// A row in one tier for two people preselects neither and says so.

import { matchText } from '../rules';
import { currencyOf, isExcluded, isTransfer } from '../spending';
import { toUnits, unitScale } from '../split-rows';
import type { CategoryKind } from '../categories';
import type { ItemState } from './balances';
import type { PaymentApp, PaymentRequest } from './model';

/** How long after a request (or the newest item) a payment is looked for. */
export const WINDOW_DAYS = 45;
/** The open items a set of items is looked for among, oldest first. */
export const SUBSET_ITEMS = 16;
/** The most people a batched cashout is looked for across. */
export const BATCH_PEOPLE = 3;

// ---- Payment apps ----

export const KNOWN_APPS = ['venmo', 'cashapp', 'zelle', 'paypal', 'applecash'] as const;
export type KnownApp = (typeof KNOWN_APPS)[number];

const APP_WORDS: { app: KnownApp; words: string[] }[] = [
  { app: 'venmo', words: ['venmo'] },
  { app: 'cashapp', words: ['cash app', 'cashapp', 'square cash', 'sq cash'] },
  { app: 'zelle', words: ['zelle'] },
  { app: 'paypal', words: ['paypal'] },
  { app: 'applecash', words: ['apple cash'] },
];

/** What a row says, as matching reads it. */
export type MatchRow = {
  transaction_id: string;
  date: string;
  amount: number;
  pending: boolean;
  name: string;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  counterparty?: string | null;
  payment_processor?: string | null;
  renamed_from?: string;
  name_before_rules?: string;
  category_kind?: CategoryKind | null;
  transaction_code?: string | null;
  category?: string | null;
  excluded?: boolean | null;
  split_of?: string;
  group_members?: readonly unknown[];
  group_outside?: unknown;
  shared?: unknown;
  settles?: unknown;
  settles_unapplied?: unknown;
  shared_unapplied?: unknown;
  shared_part?: unknown;
  shared_iou?: unknown;
};

/** A text as whole words, for whole-word matching: matchText's, with every
 *  other character a space. */
const words = (s: string): string => ` ${matchText(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const hasWords = (text: string, phrase: string): boolean => {
  const w = words(phrase).trim();
  return w.length > 0 && text.includes(` ${w} `);
};

/** The texts of a row a match reads. */
function textOf(t: Pick<MatchRow, 'name' | 'counterparty' | 'payment_processor' | 'renamed_from' | 'name_before_rules'>): string {
  return words([t.name, t.counterparty, t.payment_processor, t.renamed_from, t.name_before_rules].filter((x): x is string => !!x).join(' '));
}

/** The payment app a row names, or null. */
export function appOf(t: Pick<MatchRow, 'name' | 'counterparty' | 'payment_processor' | 'renamed_from' | 'name_before_rules'>): KnownApp | null {
  const text = textOf(t);
  for (const { app, words: ws } of APP_WORDS) if (ws.some((w) => hasWords(text, w))) return app;
  return null;
}

/** Whether a row names the person: every word of their name of two letters
 *  or more, or a handle, each as whole words. */
export function namesPerson(t: Pick<MatchRow, 'name' | 'counterparty' | 'payment_processor' | 'renamed_from' | 'name_before_rules'>, p: Pick<MatchPerson, 'name' | 'venmo' | 'cashtag'>): boolean {
  const text = textOf(t);
  const parts = p.name ? words(p.name).trim().split(' ').filter((w) => w.length >= 2) : [];
  if (parts.length > 0 && parts.every((w) => text.includes(` ${w} `))) return true;
  return [p.venmo, p.cashtag].some((h) => !!h && h.length >= 3 && hasWords(text, h));
}

// ---- Inputs and answers ----

export type MatchPerson = {
  id: string;
  name: string | null;
  venmo?: string;
  cashtag?: string;
  app?: PaymentApp;
  requests: readonly PaymentRequest[];
  archived: boolean;
};

export type Fit = 'requested' | 'balance' | 'items' | 'part' | 'over' | 'several';
export type Tier = 'strong' | 'likely' | 'possible';

export type Proposal = {
  row: string;
  date: string;
  /** Plaid's sign, as the row's. */
  amount: number;
  currency: string;
  /** The person, or with `several` the first of them. */
  person: string;
  tier: Tier;
  fit: Fit;
  app: KnownApp | null;
  /** The app is the one the person said they use. */
  their_app: boolean;
  named: boolean;
  /** Days since the request, else since the newest open item. */
  days: number;
  /** What it would close, each item and how much (positive): preselected
   *  only when `preselect`. */
  allocations: { item: string; amount: number }[];
  preselect: boolean;
  /** Another set of items adds up to the same amount. */
  choice: boolean;
  /** The other people it fits in the same tier (it preselects none). */
  also: string[];
  /** A batched cashout: the people it would pay back together. */
  several?: string[];
  /** The row counts in totals as it is (money in, not a transfer): listed
   *  first, since until it is confirmed it counts beside the part already
   *  out of spending. */
  counted: boolean;
};

const TIER_ORDER: Tier[] = ['strong', 'likely', 'possible'];
const FIT_ORDER: Fit[] = ['requested', 'balance', 'items', 'part', 'over', 'several'];
const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** A row that can be a payment at all (see CANDIDATES). */
export function eligible(t: MatchRow, dismissed: ReadonlySet<string>, paying: ReadonlySet<string>): boolean {
  return (
    !t.pending &&
    t.amount !== 0 &&
    currencyOf(t) !== null &&
    t.split_of === undefined &&
    !t.group_members &&
    !t.group_outside &&
    t.shared === undefined &&
    t.settles === undefined &&
    t.settles_unapplied === undefined &&
    t.shared_unapplied === undefined &&
    t.shared_part === undefined &&
    t.shared_iou === undefined &&
    !dismissed.has(t.transaction_id) &&
    !paying.has(t.transaction_id)
  );
}

type PersonWindow = {
  person: MatchPerson;
  currency: string;
  scale: number;
  /** Positive: they owe you (money in pays it). */
  balanceUnits: number;
  /** Their open items in the balance's direction, oldest first. */
  items: ItemState[];
  /** Every open item, both ways (what the balance closes). */
  all: ItemState[];
  from: string;
  until: number;
  request: PaymentRequest | null;
  sums: Map<number, { mask: number; count: number }>;
};

/** Every sum of a set of the oldest items, once, with the set that takes the
 *  oldest (see SIGNALS) and how many sets share it. */
function subsetSums(units: readonly number[]): Map<number, { mask: number; count: number }> {
  const n = Math.min(units.length, SUBSET_ITEMS);
  const out = new Map<number, { mask: number; count: number }>();
  const sum = new Array<number>(1 << n).fill(0);
  for (let mask = 1; mask < 1 << n; mask++) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    sum[mask] = sum[mask ^ low] + units[i];
    const cur = out.get(sum[mask]);
    // The oldest item is bit 0: prefer the set whose lowest bits hold more.
    if (!cur) out.set(sum[mask], { mask, count: 1 });
    else out.set(sum[mask], { mask: prefer(mask, cur.mask), count: cur.count + 1 });
  }
  return out;
}

/** Of two sets, the one that takes the older items (lowest bits first). */
function prefer(a: number, b: number): number {
  for (let bit = 0; bit < 31; bit++) {
    const x = (a >> bit) & 1;
    const y = (b >> bit) & 1;
    if (x !== y) return x ? a : b;
  }
  return a;
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * The proposals for the rows (see the header), ranked: by tier, then by
 * fit, then a name before none, then fewer days, then the row's id, so every
 * device ranks them alike. `items` are every item with what is open of it
 * (lib/shared-expenses/balances.ts itemState); `paying`, the rows already
 * confirmed as payments; `dismissed`, those said to be none.
 */
export function proposals(
  rows: readonly MatchRow[],
  people: readonly MatchPerson[],
  items: readonly ItemState[],
  opts: { dismissed?: ReadonlySet<string>; paying?: ReadonlySet<string> } = {}
): Proposal[] {
  const dismissed = opts.dismissed ?? new Set<string>();
  const paying = opts.paying ?? new Set<string>();
  const windows: PersonWindow[] = [];
  for (const person of people) {
    if (person.archived) continue;
    const mine = items.filter((i) => i.person === person.id && i.open !== 0);
    for (const currency of new Set(mine.map((i) => i.currency))) {
      const scale = unitScale(currency);
      const all = mine.filter((i) => i.currency === currency).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
      const balanceUnits = all.reduce((n, i) => n + (i.direction === 'to_you' ? 1 : -1) * toUnits(i.open, scale), 0);
      if (balanceUnits === 0) continue;
      const direction = balanceUnits > 0 ? 'to_you' : 'by_you';
      const open = all.filter((i) => i.direction === direction && i.open > 0);
      if (open.length === 0) continue;
      const request = [...person.requests].filter((r) => r.currency === currency && r.direction === direction).sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
      const newest = open[open.length - 1].date;
      const anchor = request && request.at.slice(0, 10) > newest ? request.at.slice(0, 10) : newest;
      windows.push({
        person,
        currency,
        scale,
        balanceUnits,
        items: open,
        all,
        from: open[0].date,
        until: dayNumber(anchor) + WINDOW_DAYS,
        request,
        sums: subsetSums(open.map((i) => toUnits(i.open, scale))),
      });
    }
  }
  if (windows.length === 0) return [];

  const out: Proposal[] = [];
  for (const t of rows) {
    if (!eligible(t, dismissed, paying)) continue;
    const currency = currencyOf(t)!;
    const app = appOf(t);
    // A store's refund, or a merchant's: at most possible.
    const capped = t.category_kind === 'expense' || (!!t.counterparty && app === null);
    const counted = t.amount < 0 && !isExcluded(t) && !isTransfer({ transaction_code: t.transaction_code ?? null, category: t.category ?? null, category_kind: t.category_kind });
    const found: Proposal[] = [];
    for (const w of windows) {
      if (w.currency !== currency || t.date < w.from || dayNumber(t.date) > w.until) continue;
      if (sign(t.amount) !== (w.balanceUnits > 0 ? -1 : 1)) continue;
      const units = Math.abs(toUnits(t.amount, w.scale));
      const balance = Math.abs(w.balanceUnits);
      const named = namesPerson(t, w.person);
      const request = w.request && w.request.at.slice(0, 10) <= t.date ? w.request : null;
      const requestedUnits = request ? toUnits(request.amount, w.scale) : null;
      const subset = w.sums.get(units);
      const fit: Fit = requestedUnits === units ? 'requested' : units === balance ? 'balance' : subset ? 'items' : units < balance ? 'part' : 'over';
      const exact = fit === 'requested' || fit === 'balance' || fit === 'items';
      let tier: Tier | null = exact && (app !== null || named) ? 'strong' : named && (fit === 'part' || fit === 'over') ? 'likely' : exact || (app !== null && (fit === 'part' || fit === 'over')) ? 'possible' : null;
      if (tier === null) continue;
      if (capped && tier !== 'possible') tier = 'possible';
      const since = request ? request.at.slice(0, 10) : w.items[w.items.length - 1].date;
      found.push({
        row: t.transaction_id,
        date: t.date,
        amount: t.amount,
        currency,
        person: w.person.id,
        tier,
        fit,
        app,
        their_app: app !== null && app === w.person.app,
        named,
        days: Math.max(0, dayNumber(t.date) - dayNumber(since)),
        allocations: allocationsFor(fit, units, w, request, subset?.mask ?? 0),
        preselect: tier === 'strong',
        choice: fit === 'items' && (subset?.count ?? 0) > 1,
        also: [],
        counted,
      });
    }
    // A batched cashout explains a row better than "more than" or "less
    // than" any one person's balance does.
    if (app !== null && t.amount < 0 && !found.some((p) => p.fit === 'requested' || p.fit === 'balance' || p.fit === 'items')) {
      const batch = several(t, owedWindows(windows, currency, t), app, counted);
      if (batch) found.splice(0, found.length, batch);
    }
    // One row in one tier for two people preselects neither.
    for (const p of found) {
      p.also = found.filter((q) => q !== p && q.tier === p.tier).map((q) => q.person);
      if (p.also.length > 0) p.preselect = false;
    }
    out.push(...found);
  }
  return out.sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      Number(b.counted) - Number(a.counted) ||
      FIT_ORDER.indexOf(a.fit) - FIT_ORDER.indexOf(b.fit) ||
      Number(b.named) - Number(a.named) ||
      a.days - b.days ||
      (a.row < b.row ? -1 : a.row > b.row ? 1 : a.person < b.person ? -1 : 1)
  );
}

/** The windows a batched cashout can pay: people owed in its currency whose
 *  windows hold its day. */
function owedWindows(windows: readonly PersonWindow[], currency: string, t: MatchRow): PersonWindow[] {
  return windows.filter((w) => w.currency === currency && w.balanceUnits > 0 && t.date >= w.from && dayNumber(t.date) <= w.until).slice(0, 20);
}

/** One row equal to the balances of two or three people together. */
function several(t: MatchRow, windows: readonly PersonWindow[], app: KnownApp, counted: boolean): Proposal | null {
  if (windows.length < 2) return null;
  const units = Math.abs(toUnits(t.amount, windows[0].scale));
  const pick = (ws: PersonWindow[]): Proposal => ({
    row: t.transaction_id,
    date: t.date,
    amount: t.amount,
    currency: windows[0].currency,
    person: ws[0].person.id,
    tier: 'possible',
    fit: 'several',
    app,
    their_app: false,
    named: false,
    days: 0,
    allocations: ws.flatMap((w) => w.all.map((i) => ({ item: i.id, amount: Math.abs(i.open) }))),
    preselect: false,
    choice: false,
    also: [],
    several: ws.map((w) => w.person.id),
    counted,
  });
  for (let a = 0; a < windows.length; a++) {
    for (let b = a + 1; b < windows.length; b++) {
      if (windows[a].balanceUnits + windows[b].balanceUnits === units) return pick([windows[a], windows[b]]);
      if (BATCH_PEOPLE < 3) continue;
      for (let c = b + 1; c < windows.length; c++) {
        if (windows[a].balanceUnits + windows[b].balanceUnits + windows[c].balanceUnits === units) return pick([windows[a], windows[b], windows[c]]);
      }
    }
  }
  return null;
}

/** What a proposal would close (see 4.5 of the design): the request's
 *  items; every open item; the set; the oldest first up to the amount; or
 *  every open item, the rest staying the row's. */
function allocationsFor(fit: Fit, units: number, w: PersonWindow, request: PaymentRequest | null, mask: number): { item: string; amount: number }[] {
  const close = (list: readonly ItemState[], limit: number | null) => {
    const out: { item: string; amount: number }[] = [];
    let left = limit;
    for (const i of list) {
      const open = toUnits(i.open, w.scale);
      if (open <= 0) continue;
      const take = left === null ? open : Math.min(open, left);
      if (take <= 0) break;
      out.push({ item: i.id, amount: take / w.scale });
      if (left !== null) left -= take;
    }
    return out;
  };
  if (fit === 'requested' && request) {
    // The request's items, each whole, when what they come to (both ways)
    // is the amount; else the oldest first, as for less.
    const asked = w.all.filter((i) => request.items.includes(i.id) && i.open > 0);
    const net = Math.abs(asked.reduce((n, i) => n + (i.direction === 'to_you' ? 1 : -1) * toUnits(i.open, w.scale), 0));
    if (asked.length > 0 && net === units) return asked.map((i) => ({ item: i.id, amount: i.open }));
  }
  if (fit === 'balance' || fit === 'over') {
    // The balance nets both ways: every open item, each whole.
    return w.all.filter((i) => i.open > 0).map((i) => ({ item: i.id, amount: i.open }));
  }
  if (fit === 'items') return w.items.filter((_, i) => i < SUBSET_ITEMS && (mask >> i) & 1).map((i) => ({ item: i.id, amount: i.open }));
  return close(w.items, units);
}

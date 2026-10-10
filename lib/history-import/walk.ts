// lib/history-import/walk.ts
//
// The payoff of importing history into linked accounts (#52): the ESTIMATED
// net-worth history reaching back to the oldest imported transaction. Pure:
// no Plaid, no storage, no clock. lib/history-import/extend.ts reads what it
// needs and writes what it answers.
//
// FROM THE EARLIEST POINT BACK. The walk behind the estimated layer
// (lib/backfill.ts) starts from today's balances and stops where the bank's
// transactions do. This continues it from the earliest point the chart
// already has (the ANCHOR: the oldest net-worth total, recorded or
// estimated, that no earlier run of this wrote), with that day's own
// balances, so the line joins it exactly and nothing at or after it is ever
// rewritten: the real snapshot layer is never touched, and the estimates an
// earlier reconstruction made are kept. One day at a time, as the backfill
// walks: un-applying day D's flows gives the balance at the end of day D-1,
// raising a bank account's balance by what left it and lowering what a card
// owes by what was charged to it (lib/balance.ts says why the two signs are
// never merged).
//
// ONLY WHERE EVERY DAY IS COVERED. An account's balance can be walked across
// a day only if every transaction of that day is known: the bank's window
// (its earliest row on), and the period each import covers (its statement's,
// or the file's first to last day, or wider where the person said so). These
// are its COVERED RANGES. The walk goes back from the anchor through the run
// of covered days that holds it, and stops where it ends: imports of 2019 and
// 2023 without 2020 to 2022 extend the chart through 2023 and no further,
// never interpolating across the hole, and the gap is reported, so the chart
// can say what isn't drawn and why. The point the day before a covered run
// begins is kept: it is what the account held before that run's first flow.
//
// ONLY BANK ACCOUNTS AND CARDS. Their transactions explain every change of
// their balance; an investment account's don't (market movement isn't a
// transaction), and a loan's amortization isn't in its stream, so those are
// never walked here, whatever was imported into them: held at their balance
// on the anchor day, as everything not walked is, like the backfill's flat
// term. An account the anchor doesn't count isn't walked either: adding it
// before the anchor would put money into the past that the anchor's own total
// never had.
//
// WHAT EACH POINT HOLDS, as the estimated layer keeps it (lib/history.ts): the
// total, the walked balances (each the account's own estimated point) and the
// held ones (the flat term), so a hidden account is subtracted from each
// point by exactly what it put in. A walked account is held, at the balance it
// reached, on the days before its own covered run begins: in the total, never
// as a point of its own, since nothing says what it held then.

import { signedContribution } from '../balance';

/** The furthest back the chart is extended: thirty years. Covered days past
 *  it are reported (capped), not drawn. */
export const MAX_EXTENSION_DAYS = 10_958;

/** A stretch of days every transaction of which is known: the bank's window,
 *  or an import's period. Inclusive YYYY-MM-DD days. */
export type CoveredRange = { from: string; to: string; kind: 'bank' | 'import' };

/** A bank account or card to walk. */
export type WalkAccount = {
  /** The id it is known by now: what its points are written under. */
  account_id: string;
  /** Every id it has had, the current first (lib/link-core.ts sameAccountIds):
   *  the anchor's balances may name it by any. */
  ids: string[];
  type: 'depository' | 'credit';
  /** Each day's flows, summed, in Plaid's sign (positive left the account):
   *  the bank's posted rows and the imported rows that count. */
  flows: ReadonlyMap<string, number>;
  covered: CoveredRange[];
};

/** The earliest point the chart has: its day, its net-worth total, and every
 *  account's balance it was made of (walked and held, or recorded). */
export type Anchor = { date: string; total: number; balances: Record<string, number> };

/** A stretch imported for an account that isn't drawn, and the uncovered days
 *  that cut it off from the rest. */
export type Gap = { imported: { from: string; to: string }; uncovered: { from: string; to: string } };

/** How far back one account is walked, and why no further. */
export type AccountReach = {
  account_id: string;
  /** The oldest day its balance is estimated for, or null when it isn't
   *  walked at all. */
  reach: string | null;
  /** Why it isn't walked: the anchor doesn't count it, or no covered range
   *  holds the anchor's day. */
  why: 'not-counted' | 'anchor-not-covered' | null;
  gaps: Gap[];
  /** Its covered run reaches past MAX_EXTENSION_DAYS, which isn't drawn. */
  capped: boolean;
};

export type ExtensionPoint = {
  date: string;
  total: number;
  /** The walked accounts' balances that day, by their current ids. */
  walked: Record<string, number>;
  /** The balances held flat that day: everything the anchor counted that
   *  isn't walked, and walked accounts on days before their covered run. */
  held: Record<string, number>;
};

export type Extension = {
  /** Newest first, from the day before the anchor. */
  points: ExtensionPoint[];
  accounts: AccountReach[];
  /** The oldest day drawn, or null when nothing is. */
  from: string | null;
};

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100) / 100 || 0;

/** Covered ranges as day numbers, merged where they overlap or touch, oldest
 *  first, each saying whether an import is in it. */
export function mergeRanges(ranges: readonly CoveredRange[]): { from: number; to: number; imported: boolean }[] {
  const sorted = ranges
    .filter((r) => r.from <= r.to)
    .map((r) => ({ from: dayNumber(r.from), to: dayNumber(r.to), imported: r.kind === 'import' }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out: { from: number; to: number; imported: boolean }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
      last.imported ||= r.imported;
    } else out.push({ ...r });
  }
  return out;
}

/**
 * How far back one account can be walked from the anchor (see the header):
 * to the day before the covered run holding the anchor's day begins, no
 * further than MAX_EXTENSION_DAYS; with the imported stretches before that
 * run, which aren't drawn, each with the uncovered days cutting it off. Only
 * an import reaching before the anchor is walked: a run of the bank's own days
 * alone is the backfill's (lib/backfill.ts), which stops where it stops.
 */
export function reachOf(account: Pick<WalkAccount, 'account_id' | 'covered'>, anchor: string, counted: boolean, maxDays: number = MAX_EXTENSION_DAYS): AccountReach {
  const blocks = mergeRanges(account.covered);
  const a = dayNumber(anchor);
  const holding = blocks.find((b) => b.from <= a && a <= b.to) ?? null;
  // The runs before the one holding the anchor (or before the anchor, when no
  // run holds it), and of them those an import covers, each cut off by the
  // uncovered days up to the next run, or up to the anchor's own run.
  const end = holding ? holding.from - 1 : a;
  const before = blocks.filter((b) => b.to < (holding ? holding.from : a));
  const gaps: Gap[] = before.flatMap((b, i) => {
    if (!b.imported) return [];
    const until = i + 1 < before.length ? before[i + 1].from - 1 : end;
    return [{ imported: { from: dayOf(b.from), to: dayOf(b.to) }, uncovered: { from: dayOf(b.to + 1), to: dayOf(until) } }];
  });
  const none = (why: AccountReach['why']): AccountReach => ({ account_id: account.account_id, reach: null, why, gaps, capped: false });
  if (!holding) return none(gaps.length > 0 ? 'anchor-not-covered' : null);
  // An import in the run, before the anchor's day: what there is to draw.
  const importedBefore = account.covered.some((r) => r.kind === 'import' && dayNumber(r.from) < a && dayNumber(r.from) >= holding.from);
  if (!importedBefore) return none(null);
  if (!counted) return none('not-counted');
  const furthest = a - maxDays;
  const reach = Math.max(holding.from - 1, furthest);
  return { account_id: account.account_id, reach: dayOf(reach), why: null, gaps, capped: holding.from - 1 < furthest };
}

/**
 * The extension (see the header): the anchor walked back through each bank
 * account's and card's covered days. Answers its points newest first, how far
 * each account reached, and the oldest day drawn. Nothing when no account
 * reaches before the anchor.
 */
export function extendHistory(input: { anchor: Anchor; accounts: readonly WalkAccount[]; maxDays?: number }): Extension {
  const { anchor } = input;
  const walking: { account: WalkAccount; reach: number; start: number }[] = [];
  const reaches: AccountReach[] = [];
  for (const account of input.accounts) {
    const id = account.ids.find((i) => typeof anchor.balances[i] === 'number' && Number.isFinite(anchor.balances[i]));
    const reach = reachOf(account, anchor.date, id !== undefined, input.maxDays);
    reaches.push(reach);
    if (reach.reach === null || id === undefined || reach.reach >= anchor.date) continue;
    walking.push({ account, reach: dayNumber(reach.reach), start: anchor.balances[id] });
  }
  if (walking.length === 0) return { points: [], accounts: reaches, from: null };

  // Everything the anchor counted that isn't walked, held at its balance then.
  const walkedIds = new Set(walking.flatMap((w) => w.account.ids));
  const held: Record<string, number> = {};
  for (const [id, b] of Object.entries(anchor.balances)) if (!walkedIds.has(id) && typeof b === 'number' && Number.isFinite(b)) held[id] = b;

  const balance = walking.map((w) => w.start);
  const startContribution = walking.map((w) => signedContribution(w.account.type, w.start));
  const a = dayNumber(anchor.date);
  const oldest = Math.min(...walking.map((w) => w.reach));
  const points: ExtensionPoint[] = [];
  for (let d = a - 1; d >= oldest; d--) {
    const day = dayOf(d);
    const after = dayOf(d + 1);
    let total = anchor.total;
    const walked: Record<string, number> = {};
    const flat: Record<string, number> = { ...held };
    walking.forEach((w, i) => {
      if (d >= w.reach) {
        // Un-apply the day after's flows: the balance at the end of this day.
        const flow = w.account.flows.get(after) ?? 0;
        balance[i] += w.account.type === 'credit' ? -flow : flow;
        walked[w.account.account_id] = cents(balance[i]);
      } else flat[w.account.account_id] = cents(balance[i]);
      total += signedContribution(w.account.type, balance[i]) - startContribution[i];
    });
    points.push({ date: day, total: cents(total), walked, held: flat });
  }
  return { points, accounts: reaches, from: dayOf(oldest) };
}

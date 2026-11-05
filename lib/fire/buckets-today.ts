// lib/fire/buckets-today.ts
//
// What invested assets are made of today, by how each kind of money is taxed:
// the Invested assets sheet's groups, and where the projected mix starts
// (lib/fire/tax/mix.ts).
//
// From `investedAssets(...).accounts`, so the groups' totals are invested
// assets, to the cent, whatever currency an account is in. An account's bucket
// is Portfolio's (lib/allocation/buckets.ts, with the person's choice winning),
// so the two never disagree; counted checking and savings sit under Taxable, and
// an account no subtype or choice places is its own group, which the tax model
// counts as tax-deferred (D8). A child's account counted anyway sits under
// Education.
//
// Cost basis comes from the positions the browser already has, each in the
// account's currency and converted with its balance: cash at its value, a
// position with no basis counted as all gain, what the person typed winning.
// Nothing here is stored but what the person typed (the tax facts).
//
// Pure, and safe in the browser.

import { BUCKET_SLOTS, accountBucket, type BucketSlot, type TaxBucket } from '@/lib/allocation/buckets';
import { isCashHolding, type CashHolding } from '@/lib/cash';
import type { ChildAccount, CountedAccount, InvestedAssets } from './inputs';
import type { Owner, TaxFacts } from './tax-facts';

/** Where an account's cost basis came from:
 *  - typed: the person's;
 *  - positions: every position's;
 *  - partial: some positions', the rest counted as all gain;
 *  - none: nothing says (the gain isn't known);
 *  - cash: a checking or savings account, which has no gain. */
export type BasisFrom = 'typed' | 'positions' | 'partial' | 'none' | 'cash';

/** A position, as much of one as the basis needs. */
export type BasisHolding = CashHolding & {
  account_id?: string;
  value?: number | null;
  cost_basis?: number | null;
  currency?: string | null;
};

/** What an account's row (app/api/plan-inputs) measured over the last year, in
 *  its own currency: null for what isn't known. */
export type AccountYear = { income: number | null; contributions: number | null };

export type BucketAccount = {
  account_id: string;
  name: string;
  institution: string;
  item_id: string | null;
  subtype: string | null;
  bucket: BucketSlot;
  /** The bucket came from the person's choice (not the account's kind). */
  chosen: boolean;
  /** Why the account's kind gives no bucket; null when it does. */
  why: string | null;
  owner: Owner;
  /** In the total's currency, as is everything below. */
  value: number;
  basis: number | null;
  basisFrom: BasisFrom;
  gain: number | null;
  /** The last year's dividends and interest; null while not known. */
  income: number | null;
  /** That, as a share of the value. */
  yieldRate: number | null;
  /** The last year's new money in; null while not known. */
  contributions: number | null;
};

export type BucketGroup = { bucket: BucketSlot; total: number; accounts: BucketAccount[] };

export type BucketsToday = {
  /** In Portfolio's order, those with an account. */
  groups: BucketGroup[];
  total: number;
  /** Accounts for a child's education left out (D7), and the sum of those with
   *  a value. */
  leftOut: { accounts: ChildAccount[]; total: number };
  /** Roth contributions per person: one row each once a Roth account is
   *  counted or an amount is held, the partner's once they are set. */
  roth: { owner: Owner; amount: number | null }[];
};

/** What the positions say about an account's basis, in its own currency. */
export function positionsBasis(account: { currency?: string | null }, holdings: readonly BasisHolding[]): { basis: number | null; from: BasisFrom } {
  let basis = 0;
  let positions = 0;
  let lacking = 0;
  let known = 0;
  for (const h of holdings) {
    if (typeof h.value !== 'number' || !Number.isFinite(h.value)) continue;
    positions++;
    if (h.currency && account.currency && h.currency !== account.currency) lacking++;
    else if (isCashHolding(h)) basis += h.value;
    else if (typeof h.cost_basis === 'number' && Number.isFinite(h.cost_basis)) {
      basis += h.cost_basis;
      known++;
    } else lacking++;
  }
  if (positions === 0 || (lacking > 0 && known === 0)) return { basis: null, from: 'none' };
  return { basis, from: lacking > 0 ? 'partial' : 'positions' };
}

export function bucketsToday(args: {
  assets: Pick<InvestedAssets, 'accounts' | 'childAccounts'>;
  holdings: readonly BasisHolding[];
  tax: TaxFacts;
  /** The person's own buckets (lib/allocation/settings.ts overridesOf). */
  overrides: ReadonlyMap<string, TaxBucket>;
  /** The account's last year, as far as it is known. */
  yearOf?: (account: CountedAccount) => AccountYear;
  /** A partner is set, so there are two people to tell apart. */
  partner?: boolean;
}): BucketsToday {
  const { assets, holdings, tax, overrides, yearOf, partner = false } = args;
  const ownerOf = new Map(tax.owners.map((o) => [o.account_id, o.owner]));
  const typedBasis = new Map(tax.basis.map((b) => [b.account_id, b.amount]));
  const heldBy = new Map<string, BasisHolding[]>();
  for (const h of holdings) {
    if (!h.account_id) continue;
    const list = heldBy.get(h.account_id);
    if (list) list.push(h);
    else heldBy.set(h.account_id, [h]);
  }

  const groups = new Map<BucketSlot, BucketAccount[]>();
  for (const a of assets.accounts) {
    const cash = a.type === 'depository';
    const chosen = overrides.get(a.account_id);
    const placed = accountBucket(a.subtype, chosen);
    const bucket: BucketSlot = cash && !chosen ? 'taxable' : placed.bucket;
    // What the account's own currency becomes in the total's: its share of the
    // one conversion lib/fire/inputs.ts made.
    const rate = a.balance !== 0 ? a.value / a.balance : 1;
    const typed = typedBasis.get(a.account_id);
    let basis: number | null;
    let basisFrom: BasisFrom;
    if (typed !== undefined) {
      basis = typed;
      basisFrom = 'typed';
    } else if (cash) {
      basis = a.value;
      basisFrom = 'cash';
    } else {
      const fromPositions = positionsBasis(a, heldBy.get(a.account_id) ?? []);
      basis = fromPositions.basis === null ? null : fromPositions.basis * rate;
      basisFrom = fromPositions.from;
    }
    const year = yearOf?.(a) ?? { income: null, contributions: null };
    const income = year.income === null ? null : year.income * rate;
    const row: BucketAccount = {
      account_id: a.account_id,
      name: a.name,
      institution: a.institution,
      item_id: a.item_id,
      subtype: a.subtype ?? null,
      bucket,
      chosen: !!chosen,
      why: cash ? null : placed.why,
      owner: ownerOf.get(a.account_id) ?? 'you',
      value: a.value,
      basis,
      basisFrom,
      gain: basis === null ? null : a.value - basis,
      income,
      yieldRate: income !== null && a.value > 0 ? income / a.value : null,
      contributions: year.contributions === null ? null : year.contributions * rate,
    };
    const list = groups.get(bucket);
    if (list) list.push(row);
    else groups.set(bucket, [row]);
  }

  const ordered = BUCKET_SLOTS.flatMap((bucket): BucketGroup[] => {
    const accounts = groups.get(bucket);
    return accounts ? [{ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) }] : [];
  });
  const children = assets.childAccounts ?? [];
  const held = new Map(tax.rothContributions.map((r) => [r.owner, r.amount]));
  const people: Owner[] = partner || held.has('partner') ? ['you', 'partner'] : ['you'];
  return {
    groups: ordered,
    total: ordered.reduce((s, g) => s + g.total, 0),
    leftOut: { accounts: children, total: children.reduce((s, a) => s + (a.value ?? 0), 0) },
    roth: groups.has('roth') || held.size > 0 ? people.map((owner) => ({ owner, amount: held.get(owner) ?? null })) : [],
  };
}

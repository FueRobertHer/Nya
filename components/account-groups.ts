// components/account-groups.ts
//
// The Accounts tab's line by type (rollout phase 3c): Cash, Credit,
// Investments, Loans and Other, each the sum of the accounts on the cards
// below it, so it never disagrees with them. Accounts are grouped by
// institution on the tab because balances fail per institution; this line
// answers "what do I have and owe" without scattering a bank's accounts.
//
// What a group can't count is said from the accounts themselves: a row with
// no balance, an account a broken card can't show, a currency with no rate.
// When the kind of what is missing can't be told (a count with no names, a
// held account Nya never knew the kind of), no group is marked and the
// institution is named instead, since the missing account could be a debt in
// any group. Pure, client-safe.

import { isInvestmentType } from '@/lib/balance';
import { balancesNow, type PageFx } from '@/lib/fx/view';
import { signedBalance, type Account, type Institution } from './accounts-format';
import { institutionNote } from './currency-text';

export type GroupKey = 'cash' | 'credit' | 'investments' | 'loans' | 'other';

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'cash', label: 'Cash' },
  { key: 'credit', label: 'Credit' },
  { key: 'investments', label: 'Investments' },
  { key: 'loans', label: 'Loans' },
  { key: 'other', label: 'Other' },
];

export function groupOf(type: string): GroupKey {
  if (type === 'depository') return 'cash';
  if (type === 'credit') return 'credit';
  if (isInvestmentType(type)) return 'investments';
  if (type === 'loan') return 'loans';
  return 'other';
}

export type AccountGroup = {
  key: GroupKey;
  label: string;
  /** Null when its accounts mix currencies and nothing converts them. */
  total: number | null;
  currency: string | null;
  /** It leaves out an account of its kind, or a currency with no rate. */
  incomplete: boolean;
};

export type AccountsSummary = {
  groups: AccountGroup[];
  /** How mixed currencies were added, in the cards' words; null when they don't mix. */
  currencyNote: string | null;
  /** Institutions whose accounts aren't all counted, and whether the kind of
   *  some of them is unknown, so any group may be short. */
  short: { institutions: string[]; untyped: boolean } | null;
  /** Institutions whose figures here are last known balances, or that may be
   *  missing an account their bank stopped sending (a caution on the card). */
  dated: string[];
};

type InstitutionRows = Pick<
  Institution,
  'institution_name' | 'accounts' | 'error' | 'connector' | 'stale_as_of' | 'stale_missing' | 'stale_too_old' | 'unconfirmed_missing' | 'unshown_accounts'
>;

/** A row the card shows but no total counts: held with no balance, a
 *  connector's account with none (waiting for its sign, or in error), or one
 *  on a card whose fetch failed. */
function uncounted(a: Account, inst: InstitutionRows): boolean {
  return a.balance == null && (!!a.held || !!inst.connector || !!inst.error);
}

/** Each kind of account on `institutions` (already without hidden accounts),
 *  in the tab's order. `main` is the currency an account with none is counted
 *  in, as the server counts it. */
export function summarize(institutions: readonly InstitutionRows[], fx: PageFx | null, main: string | null, now: number = Date.now()): AccountsSummary {
  const rows = new Map<GroupKey, { amount: number; currency: string | null }[]>();
  const incomplete = new Set<GroupKey>();
  const short: string[] = [];
  const dated: string[] = [];
  let untyped = false;

  for (const inst of institutions) {
    let isShort = false;
    let typedMissing = false;
    for (const a of inst.accounts) {
      const key = groupOf(a.type);
      const list = rows.get(key) ?? [];
      list.push({ amount: signedBalance(a), currency: a.currency });
      rows.set(key, list);
      if (uncounted(a, inst)) {
        isShort = true;
        // A held account Nya never knew the kind of is filed as 'other'
        // (lib/lifecycle-questions.ts holdMissingAccounts): its kind is unknown.
        if (a.held && a.type === 'other') untyped = true;
        else {
          incomplete.add(key);
          typedMissing = true;
        }
      }
    }
    for (const u of inst.unshown_accounts ?? []) {
      isShort = true;
      if (!u.type) {
        untyped = true;
        continue;
      }
      const key = groupOf(u.type);
      if (!rows.has(key)) rows.set(key, []);
      incomplete.add(key);
      typedMissing = true;
    }
    // Missing money the card counts but doesn't name: accounts that couldn't
    // be shown, balances too old to show, or nothing fetched or recovered.
    const unnamed = !!inst.error && (!inst.stale_as_of || !!inst.stale_missing || !!inst.stale_too_old);
    if (unnamed && !inst.unshown_accounts?.length && !typedMissing) {
      isShort = true;
      untyped = true;
    }
    if (isShort) short.push(inst.institution_name);
    if (inst.accounts.some((a) => a.stale || (!!a.held && a.balance != null)) || !!inst.unconfirmed_missing) dated.push(inst.institution_name);
  }

  const all = [...rows.values()].flat();
  const mixed = new Set(all.map((r) => r.currency).filter(Boolean)).size > 1;
  const groups: AccountGroup[] = [];
  for (const { key, label } of GROUPS) {
    const list = rows.get(key);
    if (!list) continue;
    let total: number | null;
    let currency: string | null;
    let leftOut = false;
    if (mixed && fx) {
      const b = balancesNow(list, fx, main, now);
      total = b.total;
      currency = b.currency;
      leftOut = b.left_out.length > 0;
    } else {
      const own = new Set(list.map((r) => r.currency).filter(Boolean));
      currency = own.size === 1 ? [...own][0] : own.size === 0 ? main : null;
      total = own.size > 1 ? null : list.reduce((sum, r) => sum + r.amount, 0);
    }
    groups.push({ key, label, total, currency, incomplete: incomplete.has(key) || leftOut });
  }

  return {
    groups,
    currencyNote: !mixed ? null : fx ? institutionNote(balancesNow(all, fx, main, now)) : 'Mixed currencies; totals aren’t converted.',
    short: short.length > 0 ? { institutions: short, untyped } : null,
    dated,
  };
}

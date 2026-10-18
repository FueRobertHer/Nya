// lib/fx/net-worth-read.ts
//
// What /api/net-worth reads and works out to answer `base`, net worth in the
// person's home currency (lib/fx/net-worth-base.ts), so the route's own steps
// (record first, display after; see its comments) stay as they are. Server
// only. Only for a person who chose a home currency: without one nothing here
// runs, and the route reads exactly what it read before.

import { dominantCurrency } from '../format';
import { signedContribution } from '../balance';
import type { Ctx } from '../containers';
import type { Link } from '../link-core';
import type { LifecycleView } from '../lifecycle';
import type { InstitutionResult } from '../networth';
import type { ForeignAccounts, SplitHistoryPoint } from '../history';
import { currenciesById, foreignAccounts, type KnownAccount } from './known-accounts';
import { netWorthBase, currenciesOf, type HistorySplit, type NetWorthBase } from './net-worth-base';
import type { BalanceRow } from './net-worth';
import { readFx } from './read';

type Listed = Pick<InstitutionResult, 'accounts' | 'unshown_accounts'>;

/** The visible accounts' balances, signed, as net worth adds them
 *  (lib/hidden.ts applyHidden): after hiding is applied. */
export function visibleRows(institutions: readonly Listed[]): BalanceRow[] {
  const rows: BalanceRow[] = [];
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      if (a.hidden || a.balance == null || typeof a.type !== 'string') continue;
      rows.push({ amount: signedContribution(a.type, a.balance), currency: typeof a.currency === 'string' ? a.currency : null });
    }
  }
  return rows;
}

/** The currency most visible accounts are in: what Home labels net worth
 *  with, and what an account saying none counts in. */
export function mainCurrency(institutions: readonly Listed[]): string | null {
  return dominantCurrency(institutions.flatMap((i) => i.accounts.filter((a) => !a.hidden).map((a) => ({ iso_currency_code: typeof a.currency === 'string' ? a.currency : null }))));
}

/** Every account listed now, hidden ones and those an institution can't show
 *  too, with its currency and kind. */
export function listedAccounts(institutions: readonly Listed[]): KnownAccount[] {
  const out: KnownAccount[] = [];
  for (const inst of institutions) {
    for (const a of inst.accounts) out.push({ account_id: a.account_id, currency: typeof a.currency === 'string' ? a.currency : null, type: typeof a.type === 'string' ? a.type : null });
    for (const a of inst.unshown_accounts ?? []) out.push({ account_id: a.account_id, currency: a.currency ?? null, type: a.type ?? null });
  }
  return out;
}

/** The accounts with a lifecycle entry, by every id each has had, with the
 *  currency the entry kept. */
export function lifecycleAccounts(view: Pick<LifecycleView, 'accounts' | 'rootOf'>): KnownAccount[] {
  const out: KnownAccount[] = [];
  for (const [id, { entry }] of view.accounts) out.push({ account_id: id, currency: entry.currency ?? null, type: entry.type });
  for (const [id, root] of view.rootOf) {
    const entry = view.accounts.get(root)?.entry;
    if (entry && id !== root) out.push({ account_id: id, currency: entry.currency ?? null, type: entry.type });
  }
  return out;
}

/** The foreign accounts a point's split reads, and how many accounts Nya
 *  knows of without a currency (counted in the main one, as before) when the
 *  accounts are in more than one currency. */
export function foreignFor(
  sources: KnownAccount[][],
  links: ReadonlyMap<string, Pick<Link, 'to'>> | null,
  main: string | null
): { foreign: ForeignAccounts; unknown: number } {
  const byId = currenciesById(sources, links);
  const foreign = foreignAccounts(byId, main);
  const currencies = new Set([...byId.values()].map((a) => a.currency).filter(Boolean));
  const unknown = currencies.size > 1 ? [...byId.values()].filter((a) => a.currency === null).length : 0;
  return { foreign, unknown };
}

/** The split the cache keeps for converting after it. */
export function historySplit(input: {
  main: string | null;
  breaks: string[];
  raw: SplitHistoryPoint[];
  today: { date: string; rows: BalanceRow[] } | null;
  unknown: number;
}): HistorySplit {
  return {
    main: input.main,
    breaks: input.breaks,
    points: input.raw.map((p) => ({ date: p.date, value: p.value, ...(p.estimated ? { estimated: true } : {}), ...(p.parts !== undefined ? { parts: p.parts } : {}) })),
    today: input.today,
    unknown_currency: input.unknown,
  };
}

/** `base`, read and worked out once for this answer: the rates for every
 *  currency and day the accounts and the chart involve, then the figures.
 *  Null with no home currency (nothing converts). */
export async function readNetWorthBase(
  ctx: Ctx,
  input: { institutions: readonly Listed[]; split: HistorySplit; now: number; known?: Parameters<typeof readFx>[2] }
): Promise<{ base: NetWorthBase | null; problem: 'unreadable' | 'unrecognised' | null }> {
  const rows = visibleRows(input.institutions);
  const main = mainCurrency(input.institutions);
  const today = new Date(input.now).toISOString().slice(0, 10);
  const from = input.split.points[0]?.date ?? today;
  const { fx, problem } = await readFx(ctx, { currencies: [...currenciesOf(rows, input.split), ...(main ? [main] : [])], from, to: today }, input.known);
  if (!fx.home) return { base: null, problem };
  return { base: netWorthBase({ fx, rows, main, split: input.split, now: input.now }), problem };
}

// lib/investment-months-store.ts
//
// Where an investment account's imported months (lib/investment-months.ts)
// are kept: a map store on the storage seam (lib/repo.ts), keyed by account
// id, exportable (the person's own record of their account) and compressed,
// since an import holds every month since the account opened. The owner's
// alone: nothing shared reads it.
//
// EACH VALUE IS THE ACCOUNT'S IMPORTS under that id, oldest first, each one
// as it was read, never changed. An import adds its record; an undo takes
// one record out; nothing else is ever written here. Each is one compare-
// and-set on the id's value (MapStore.update), so two devices importing at
// once can't lose each other's. Undoing an id's last import deletes its
// entry rather than leaving an empty list.
//
// KEYED TO SURVIVE A RE-LINK, as money in and out are (lib/money-in-out-
// store.ts): an import is stored under the id the account had then, and
// read through the links that apply now (effectiveLinks over the strict live
// ids, so a paused link never carries one account's imports to another).
// Unlike money in and out, every id's list is read and joined: the newest
// import across them counts, and every one is listed for its Undo. A new
// import goes under the current id and never removes anything under another;
// an undo takes the record from whichever of the account's ids holds it.
//
// Kept when an institution is disconnected, as the account's history is, for
// a re-link; forgotten with the account (lib/links.ts forgetEarlierAccount).

import { defineMapStore, type MapStore } from './repo';
import type { Ctx } from './containers';
import { effectiveLinks, getLinks, sameAccountIds } from './link-core';
import { liveAccountIds } from './links';
import { byImported, countingImport, isInvestmentMonths, MAX_IMPORTS, type InvestmentMonths, type MonthsImport } from './investment-months';

export const investmentMonthsStore: MapStore<InvestmentMonths> = defineMapStore<InvestmentMonths>('investment-months', {
  what: 'months imported from your brokerage',
  isValid: isInvestmentMonths,
  exportable: true,
  compress: true,
});

/** Every id the account has had, by the links that apply now. Strict. */
async function accountIds(ctx: Ctx, account_id: string): Promise<string[]> {
  const links = effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { strict: true }));
  return sameAccountIds(account_id, links);
}

/** Every import of the account, across its ids, oldest first, or null when
 *  it has none. Strict: an entry that can't be read throws, as do links that
 *  can't be. Links are read only when another id holds an entry. */
export async function readInvestmentMonths(ctx: Ctx, account_id: string): Promise<InvestmentMonths | null> {
  const stored = await investmentMonthsStore.ids(ctx);
  if (stored.length === 0) return null;
  const others = stored.some((id) => id !== account_id) ? await accountIds(ctx, account_id) : [account_id];
  const ids = [...new Set([account_id, ...others])].filter((id) => stored.includes(id));
  if (ids.length === 0) return null;
  const entries = await investmentMonthsStore.getMany(ctx, ids);
  const imports = [...entries.values()].flatMap((e) => e.imports).sort(byImported);
  return imports.length > 0 ? { imports } : null;
}

/** Why an import or an undo was refused: the import that counted when the
 *  file was reviewed isn't the one that counts now (another device), the
 *  account has as many imports as it keeps, or the import isn't there. */
export class MonthsRefused extends Error {
  constructor(readonly why: 'changed' | 'full' | 'missing') {
    super(why);
  }
}

/**
 * Adds an import under the account's current id. `counting` is the id of the
 * import that counted when the file was reviewed (null for none): refused
 * when that has changed since. Answers the account's imports now.
 */
export async function addMonthsImport(ctx: Ctx, account_id: string, record: MonthsImport, counting: string | null): Promise<InvestmentMonths> {
  const ids = await accountIds(ctx, account_id);
  const others = ids.filter((id) => id !== account_id);
  await investmentMonthsStore.update(ctx, account_id, async (current) => {
    // Read inside the compare-and-set, so a retry sees the other ids again.
    const elsewhere = others.length > 0 ? [...(await investmentMonthsStore.getMany(ctx, others)).values()].flatMap((e) => e.imports) : [];
    const all = [...(current?.imports ?? []), ...elsewhere];
    if ((countingImport({ imports: all })?.id ?? null) !== counting) throw new MonthsRefused('changed');
    if (all.length >= MAX_IMPORTS) throw new MonthsRefused('full');
    return { imports: [...(current?.imports ?? []), record].sort(byImported) };
  });
  return (await readInvestmentMonths(ctx, account_id)) ?? { imports: [] };
}

/**
 * Takes one import out, from whichever of the account's ids holds it: the
 * id's entry goes when it was its last. Answers the account's imports now,
 * or null when none is left.
 */
export async function undoMonthsImport(ctx: Ctx, account_id: string, import_id: string): Promise<InvestmentMonths | null> {
  const ids = await accountIds(ctx, account_id);
  const entries = await investmentMonthsStore.getMany(ctx, ids);
  const holder = [...entries].find(([, e]) => e.imports.some((i) => i.id === import_id))?.[0];
  if (!holder) throw new MonthsRefused('missing');
  await investmentMonthsStore.update(ctx, holder, (current) => {
    if (!current || !current.imports.some((i) => i.id === import_id)) throw new MonthsRefused('missing');
    const left = current.imports.filter((i) => i.id !== import_id);
    return left.length > 0 ? { imports: left } : null;
  });
  return readInvestmentMonths(ctx, account_id);
}

/** Forgetting an earlier account (lib/links.ts forgetEarlierAccount) takes
 *  its imports too. */
export async function forgetInvestmentMonths(ctx: Ctx, id: string): Promise<void> {
  await investmentMonthsStore.remove(ctx, id);
}

// lib/fx/read.ts
//
// What a request converts with, read once (lib/fx/rates.ts FxTable): the
// person's settings, and, only when something is in a currency other than
// their home one, the ECB's fields for the currencies and days involved. Never
// a fetch: rates come only from the store the nightly fetch fills
// (lib/fx/ecb-fetch.ts). Server only.
//
// LENIENT, for showing figures (see lib/fx/settings.ts and
// lib/fx/ecb-store.ts): settings that can't be read convert nothing, and a
// field of rates that can't be used gives no rate on its days, each said in
// `problem` and `unusable`; nothing writes, deletes or records on a
// conversion. A deployment problem (storage out of reach) still throws.

import type { Ctx } from '../containers';
import { readSettingsForDisplay, type CurrencySettings } from './settings';
import { readEcbFields } from './ecb-store';
import { fieldsFor, tableFromFields, yearsFor, LATEST_FIELD, FETCH_FIELD } from './fields';
import { NO_FX, type FxTable } from './rates';

/** What a reader will convert: the currencies its amounts are in, and the
 *  days they fall on (the newest publication is always read). */
export type FxNeed = { currencies: Iterable<string>; from: string; to: string };

export type FxRead = {
  fx: FxTable;
  /** The settings couldn't be used, so nothing converts: say so. */
  problem: 'unreadable' | 'unrecognised' | null;
  /** Fields of rates that couldn't be used, by id (their days have no rate). */
  unusable: string[];
};

/** The currencies whose rates converting these amounts into `home` needs:
 *  each one other than home, home itself, and the quotes of the own rates
 *  that price them. The euro has no series of its own (its rate is 1), but a
 *  rate of the person's for it goes through its quote's, which is read. */
export function currenciesFor(given: Iterable<string>, fx: Pick<FxTable, 'home' | 'own'>): Set<string> {
  const out = new Set<string>();
  const home = fx.home!;
  const add = (c: string) => {
    if (c !== 'EUR') out.add(c);
    for (const o of fx.own) if (o.currency === c && o.quote !== 'EUR') out.add(o.quote);
  };
  let foreign = false;
  for (const c of given) {
    if (c === home) continue;
    foreign = true;
    add(c);
  }
  if (foreign) add(home);
  return out;
}

/** `known`: the settings as this request already read them, so they are
 *  read once. */
export async function readFx(ctx: Ctx, need: FxNeed, known?: { settings: CurrencySettings; problem: FxRead['problem'] }): Promise<FxRead> {
  const { settings, problem } = known ?? (await readSettingsForDisplay(ctx));
  if (!settings.home) return { fx: { ...NO_FX, own: settings.own }, problem, unusable: [] };
  const base = { home: settings.home, own: settings.own };
  const given = [...need.currencies];
  // Nothing in another currency: nothing to read, nothing to convert.
  if (!given.some((c) => c !== settings.home)) return { fx: { ...NO_FX, ...base }, problem, unusable: [] };
  const years = yearsFor(need.from <= need.to ? need.from : need.to, need.to >= need.from ? need.to : need.from);
  const ids = fieldsFor(currenciesFor(given, base), years);
  const { fields, unusable } = await readEcbFields(ids);
  return { fx: tableFromFields(fields, years, settings.home, settings.own), problem, unusable };
}

/** The newest publication and the last fetch alone, for the Currency card. */
export async function readLatestRates(): Promise<Pick<FxTable, 'latest' | 'fetch'> & { unusable: string[] }> {
  const { fields, unusable } = await readEcbFields([LATEST_FIELD, FETCH_FIELD]);
  const t = tableFromFields(fields, [], null, []);
  return { latest: t.latest, fetch: t.fetch, unusable };
}

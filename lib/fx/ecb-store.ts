// lib/fx/ecb-store.ts
//
// The ECB's euro reference rates, kept once for the whole environment: public
// data, the same for everyone and nobody's, so a public store on the storage
// seam (lib/repo.ts definePublicMapStore), never one per container. Plain
// JSON, never encrypted, never in anyone's download; left out of backups and
// kept through restores, since it can always be fetched again (lib/export.ts
// REFETCHED_PREFIXES). Its fields are laid out in lib/fx/fields.ts; only the
// fetch (lib/fx/ecb-fetch.ts) writes them, and readers only read
// (lib/fx/read.ts).
//
// READS FOR CONVERSION ARE LENIENT, BY FIELD (readEcbFields): a field that
// can't be used (not JSON, or not the shape its id holds) is left out and
// named, so its days have no rate and say so, rather than every page that
// converts failing on one damaged year. Nothing writes, deletes or records on
// a conversion, so that is the convenience case lib/stored-json.ts allows. A
// storage failure still throws.

import { definePublicMapStore } from '../repo';
import { isEcbValue } from './fields';

export const ecbStore = definePublicMapStore<unknown>('fx:ecb', {
  what: 'exchange rates',
  isValid: (v: unknown, id: string): v is unknown => isEcbValue(v, id),
});

/** LENIENT, by field (see the header): the values these fields hold that can
 *  be used, and the ids of those that can't. */
export async function readEcbFields(ids: readonly string[]): Promise<{ fields: Map<string, unknown>; unusable: string[] }> {
  const { entries, unrecognised } = await ecbStore.getManyReport(ids);
  return { fields: entries, unusable: unrecognised };
}

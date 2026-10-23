// The ECB's own rows (eurofxref-hist.zip as of 14 Sep 2026), cut to a few
// stretches (test/fixtures/ecb), as a reader's table: for the tests of what
// converts with it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEcbCsv, planWrites, type EcbFile } from '@/lib/fx/ecb-parse';
import { tableFromFields } from '@/lib/fx/fields';
import type { FxTable, OwnRate } from '@/lib/fx/rates';

export const ECB_CSV = readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.csv'), 'utf8');
export const ECB_FILE = parseEcbCsv(ECB_CSV) as EcbFile;

/** Every field the fixture writes into an empty store. */
export function ecbFields(): Map<string, unknown> {
  const plan = planWrites(ECB_FILE, { days: new Map(), latest: null }, { current: '2026' });
  const out = new Map<string, unknown>();
  for (const step of plan.years) for (const [k, v] of step.fields) out.set(k, v);
  return out;
}

const YEARS = ['1999', '2010', '2011', '2021', '2022', '2025', '2026'];

/** A table over the fixture: with its newest publication (14 Sep 2026)
 *  unless `latest` is false. */
export function ecbTable(opts: { home?: string | null; own?: OwnRate[]; latest?: boolean } = {}): FxTable {
  const fields = ecbFields();
  if (opts.latest === false) fields.delete('latest');
  return tableFromFields(fields, YEARS, opts.home === undefined ? 'EUR' : opts.home, opts.own ?? []);
}

/** Every field, as the store's hash holds them. */
export function ecbHash(): Record<string, string> {
  return Object.fromEntries([...ecbFields()].map(([k, v]) => [k, JSON.stringify(v)]));
}

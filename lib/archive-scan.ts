// lib/archive-scan.ts
//
// What a data archive's values say about their keys, read from the values'
// headers alone, never decrypted: which key each ciphertext names, by
// container. For the nightly backup (which containers have a value under a
// shared key, and which keys its key archive must hold) and for a restore
// (whether the key archive given holds every key the data archive needs).
// Where a record holds ciphertext comes from classify() (lib/reencrypt.ts),
// as for the migration pass.

import { splitScoped } from './containers';
import { classify } from './reencrypt';
import { formatOf } from './crypto';
import type { ExportRecord } from './export';

/** The header's key id of a value, or null for one that isn't ciphertext in
 *  a format this code reads. */
function keyIdOf(value: string): string | null {
  try {
    return formatOf(value).keyId;
  } catch {
    return null;
  }
}

/**
 * Every key id the ciphertexts of one record name. A key the lists don't
 * classify is read as if every value could be ciphertext, so a store added
 * later without being listed still has its keys found: a plain value there
 * reads as v1, naming k0, which errs toward a container counting as under a
 * shared key, never away from it.
 */
export function keyIdsOfRecord(record: ExportRecord): string[] {
  const kind = classify(record.key);
  if (kind === 'plain') return [];
  const values = record.type === 'string' ? [record.value] : Object.values(record.value);
  const out: string[] = [];
  for (const v of values) {
    let ciphertext: string | null = v;
    if (kind === 'items') {
      try {
        const token = JSON.parse(v)?.encrypted_access_token;
        ciphertext = typeof token === 'string' ? token : null;
      } catch {
        ciphertext = null;
      }
    }
    if (ciphertext === null) continue;
    const id = keyIdOf(ciphertext);
    if (id !== null) out.push(id);
  }
  return out;
}

/** The key ids a data archive's values name, by container ('' for the values
 *  outside every container). */
export function keyIdsByContainer(records: ExportRecord[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const record of records) {
    const container = splitScoped(record.key).container ?? '';
    const ids = keyIdsOfRecord(record);
    if (ids.length === 0) continue;
    let set = out.get(container);
    if (!set) out.set(container, (set = new Set()));
    for (const id of ids) set.add(id);
  }
  return out;
}

/** Every key id the archive's values name. */
export function namedKeyIds(byContainer: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const ids of byContainer.values()) for (const id of ids) out.add(id);
  return out;
}

/**
 * The containers with a value under k0 or an environment key (one whose
 * record names no container), from `keyOwner`: a key id's container, null
 * for an environment key, undefined for one not in the key store (counted as
 * shared: the store doesn't say otherwise).
 */
export function containersUnderSharedKeys(
  byContainer: Map<string, Set<string>>,
  keyOwner: (keyId: string) => string | null | undefined
): string[] {
  const out: string[] = [];
  for (const [container, ids] of byContainer) {
    if (container === '') continue;
    for (const id of ids) {
      const owner = id === 'k0' ? null : keyOwner(id);
      if (owner === null || owner === undefined) {
        out.push(container);
        break;
      }
    }
  }
  return out.sort();
}

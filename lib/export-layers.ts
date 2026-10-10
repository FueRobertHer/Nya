// lib/export-layers.ts
//
// What the download of your data (lib/user-export.ts) says each transaction
// carries, as the app shows it: the same layers (lib/txn-layers.ts), applied
// by the same function to every stored row, of any date, so the file and the
// app never disagree. Read from the parts of the file itself: what was said
// about each transaction (`transaction-annotations`), what was carried from
// earlier accounts (`carried-annotations`, followed through the links that
// apply now) and the tags (`tags`). An entry the file couldn't read is named
// under problems, and is passed over here, as the app passes it over.

import { applyLayers, type LayerInputs } from './txn-layers';
import { carriedAnnotations, carriedExtras, isCarriedAnnotations, isTxnAnnotation, type CarriedAnnotation, type CarriedAnnotations, type TxnAnnotation } from './txn-annotations';
import { isTagSet, type TagSet } from './tags';
import { contentKey, type StoredTxn, type Txn } from './transactions';
import type { Link } from './link-core';

/** What the layers read, gathered from the file's parts. */
export type ExportLayers = LayerInputs & { carried: Map<string, CarriedAnnotation> };

/** A map store's part of the file: its entries as { id, value }. */
function entries(part: unknown): [string, unknown][] {
  return Array.isArray(part)
    ? part.flatMap((e) => (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? [[(e as { id: string }).id, (e as { value?: unknown }).value] as [string, unknown]] : []))
    : [];
}

/** The layers' inputs from the file's parts (`part` reads one by name), with
 *  the carried records followed through `links`, the links that apply now. */
export function exportLayers(part: (key: string) => unknown, links: Map<string, Link>): ExportLayers {
  const records = new Map<string, TxnAnnotation>();
  for (const [id, value] of entries(part('transaction-annotations'))) if (isTxnAnnotation(value)) records.set(id, value);
  const carriedRecords = new Map<string, CarriedAnnotations>();
  for (const [id, value] of entries(part('carried-annotations'))) if (isCarriedAnnotations(value)) carriedRecords.set(id, value);
  const tags = part('tags');
  return { records, unknown: new Set(), tags: isTagSet(tags) ? (tags as TagSet) : null, carried: carriedAnnotations(carriedRecords, links) };
}

/** What a row carries once the layers are applied: its tags by name, and its
 *  note (null for none). */
export type Layered = { tags: string[]; note: string | null };

function layered(row: Txn, inputs: ExportLayers): Layered {
  applyLayers([row], inputs);
  const names = new Map((inputs.tags?.tags ?? []).map((t) => [t.id, t.name]));
  return { tags: (row.tags ?? []).map((id) => names.get(id)!).filter(Boolean), note: row.note ? row.note : null };
}

/** A bank's stored row, as the app would show it. */
export function layerBankRow(t: StoredTxn, inputs: ExportLayers): Layered {
  const carried = t.pending ? undefined : inputs.carried.get(contentKey(t.account_id, t));
  const extras = carriedExtras(carried);
  const row = {
    transaction_id: t.transaction_id,
    pending: t.pending,
    ...(carried?.excluded === true ? { excluded: true } : {}),
    ...(extras ? { carried: extras } : {}),
  } as unknown as Txn;
  return layered(row, inputs);
}

/** A manual or imported row: its note is its own. */
export function layerManualRow(r: { id: string; note: string | null; source: string }, inputs: ExportLayers): Layered {
  const row = { transaction_id: r.id, pending: false, source: r.source, note: r.note } as unknown as Txn;
  return layered(row, inputs);
}

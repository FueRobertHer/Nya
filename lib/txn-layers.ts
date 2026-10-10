// lib/txn-layers.ts
//
// What is said about each transaction, applied on read in one place and one
// order (lib/activity.ts finishActivity, the read layer the app, the read-only
// API and its MCP server, reports and recurring detection share; the data
// download applies the same function to every stored row, lib/user-export.ts).
// Nothing here is ever written into a stored row, so changing or clearing
// anything below changes every past and future transaction at once, and
// clearing it puts each one back exactly as it was.
//
// THE LAYERS, each over the one before, the person's own last:
//   1. the bank's data, or a manual or imported row's own;
//   2. the rules (lib/rules.ts), in priority order;
//   3. what the person said on an earlier account's row, carried across a
//      re-link (lib/txn-annotations.ts carriedAnnotations);
//   4. what the person said on the row itself (lib/txn-annotations.ts), and
//      their own category, carried category and merchant name, which the
//      banks' part applies (lib/activity.ts assembleBankRows).
// So a choice made on one transaction always wins: a category chosen for it,
// a rename of its merchant, a tag taken off it, an exclusion set or cleared on
// it.
//
// FIELD BY FIELD:
//   - excluded: the row's own record (true or false), else unknown when that
//     record can't be read (counted, and marked null: lib/spending.ts), else
//     what was carried (an exclusion, already marked on the cached row, or an
//     include), else a rule's hide (marked excluded_by_rule);
//   - tags: each layer takes off the tags it took off and puts on the tags it
//     put on, over the one before; only tags that exist are shown, in the
//     order they were made (lib/tags.ts);
//   - note: a bank row's own (an empty one is a note cleared), else carried;
//     a manual or imported row's is its own, written with it.
//
// The facts the banks' part keeps for this (account_ref, renamed_from,
// carried) go once applied: they are never sent.

import type { Txn, OlderTxn } from './transactions';
import type { TxnAnnotation, CarriedRowFacts } from './txn-annotations';
import { orderTagIds, type TagSet } from './tags';

/** What the layers read besides the rows. */
export type LayerInputs = {
  /** Each transaction's own record (lib/txn-annotations.ts readAnnotations). */
  records: ReadonlyMap<string, TxnAnnotation>;
  /** The ids whose own record couldn't be read or isn't recognised. */
  unknown: ReadonlySet<string>;
  /** The tags that exist; null when none were ever saved or they couldn't
   *  be read, and then no transaction shows any. */
  tags: TagSet | null;
};

type Row = Txn | OlderTxn;

/** A row of the year, as the Activity tab lists it, rather than one from
 *  before it kept for recurring detection (OlderTxn), which needs no tags or
 *  notes. */
const isListed = (t: Row): t is Txn => 'pending' in t;

/** Takes off what a layer took off, then puts on what it put on. */
function layer(set: Set<string>, l: { tags?: readonly string[]; untagged?: readonly string[] } | null | undefined): void {
  if (!l) return;
  for (const id of l.untagged ?? []) set.delete(id);
  for (const id of l.tags ?? []) set.add(id);
}

/** Applies every layer to the rows, in place (see the header). */
export function applyLayers(rows: Row[], inputs: LayerInputs): void {
  for (const t of rows) {
    const id = t.transaction_id;
    const own = inputs.records.get(id);
    const unknown = inputs.unknown.has(id);
    const carried: CarriedRowFacts | undefined = t.carried;

    // Excluded. A carried exclusion is already on the cached row.
    if (own?.excluded === true) t.excluded = true;
    else if (own?.excluded === false) delete t.excluded;
    else if (unknown) t.excluded = null;
    else if (carried?.excluded === false) delete t.excluded;

    if (isListed(t)) {
      // Tags, layer over layer.
      const tags = new Set<string>();
      layer(tags, carried);
      layer(tags, own);
      const shown = orderTagIds(inputs.tags, tags);
      if (shown.length > 0) t.tags = shown;
      else delete t.tags;

      // A bank row's note: its own (an empty one cleared it), else carried.
      if (t.source === undefined) {
        const note = own?.note !== undefined ? own.note : carried?.note;
        if (note) t.note = note;
        else delete t.note;
      }
    }

    delete t.carried;
    delete t.account_ref;
    delete t.renamed_from;
  }
}

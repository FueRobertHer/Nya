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
// a rename of its merchant (or a name given an imported or SimpleFIN row, or
// typed on one entered by hand), a tag taken off it, an exclusion set or
// cleared on it.
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
//     a manual or imported row's is its own, written with it;
//   - category: a rule's only on a row with none of its own, marked
//     category_by_rule, so an edit of a manual row never writes it into the
//     row as the row's own (components/ManualTxnSheet.tsx);
//   - name: a rule's on a bank's row whose merchant the person hasn't
//     renamed, and on an imported or SimpleFIN row whose name they haven't
//     given it themselves (own_name); never on a row entered by hand, whose
//     name was typed. The name before is kept (name_before_rules): what rules
//     match, so a rule made from the row matches it, and what an edit of the
//     row starts from.
//
// The facts the assembly keeps for this (account_ref, renamed_from, carried,
// own_name) go once applied: they are never sent.

import type { Txn, OlderTxn } from './transactions';
import type { TxnAnnotation, CarriedRowFacts } from './txn-annotations';
import { orderTagIds, type TagSet } from './tags';
import { categoryById, choiceText, ownCategory, resolveCategory, type CategoryIndex } from './categories';
import { evaluateRules, matchText, sourceKind, type CompiledRules, type RuleOutcome, type RuleSubject } from './rules';

/** What the layers read besides the rows. */
export type LayerInputs = {
  /** Each transaction's own record (lib/txn-annotations.ts readAnnotations). */
  records: ReadonlyMap<string, TxnAnnotation>;
  /** The ids whose own record couldn't be read or isn't recognised. */
  unknown: ReadonlySet<string>;
  /** The tags that exist; null when none were ever saved or they couldn't
   *  be read, and then no transaction shows any. */
  tags: TagSet | null;
  /** The rules, ready to apply (lib/rules.ts compileRules); none when absent. */
  rules?: CompiledRules;
  /** The categories rows are filed into, which rules' categories are read
   *  against: without them no rule's category applies. */
  ix?: CategoryIndex | null;
  /** How an account's id is known now, following links (lib/link-core.ts). */
  account?: (id: string) => string;
  /** When given, each row's subject (what rules read of it) is put here by
   *  id, for a rule's preview (app/api/rules/preview). */
  subjects?: Map<string, RuleSubject>;
};

type Row = Txn | OlderTxn;

/** A row of the year, as the Activity tab lists it, rather than one from
 *  before it kept for recurring detection (OlderTxn), which needs no tags or
 *  notes. */
const isListed = (t: Row): t is Txn => 'pending' in t;

/** Whether a rule may give the row its name: never over the person's own
 *  (a rename of a bank's merchant, a name given an imported or SimpleFIN row
 *  in the app, the name typed on a row entered by hand), nor on a row from a
 *  source this release doesn't know. */
function renamable(t: Row): boolean {
  if (t.renamed_from !== undefined || t.own_name) return false;
  const kind = sourceKind(t.source);
  return kind === 'plaid' || kind === 'import' || kind === 'simplefin';
}

/** Takes off what a layer took off, then puts on what it put on. */
function layer(set: Set<string>, l: { tags?: readonly string[]; untagged?: readonly string[] } | null | undefined): void {
  if (!l) return;
  for (const id of l.untagged ?? []) set.delete(id);
  for (const id of l.tags ?? []) set.add(id);
}

const NOTHING: RuleOutcome = { tags: [], matched: [] };

/**
 * What a rule's conditions read of a row, before any rule runs: its names
 * (the one shown, which may be the person's for its merchant, the bank's
 * under it, and the merchant behind a payment processor), its amount, the
 * account it is on as known now, its institution, the category it is filed
 * under (the person's choice, else the bank's) and where it came from.
 */
export function subjectOf(t: Row, ix: CategoryIndex | null, account: (id: string) => string = (id) => id): RuleSubject {
  const names = new Set<string>();
  for (const n of [t.name, t.renamed_from, 'counterparty' in t ? t.counterparty : null]) if (n) names.add(matchText(n));
  const on = t.account_ref ?? ('account_id' in t ? t.account_id : undefined);
  return {
    names: [...names],
    amount: t.amount,
    account: on ? account(on) : null,
    institution: matchText(t.institution_name),
    category: ix ? resolveCategory(ix, t).category.id : null,
    source: sourceKind(t.source),
    keeps_category: !!ix && !!ownCategory(ix, t),
    keeps_name: !renamable(t),
  };
}

/** Applies every layer to the rows, in place (see the header). */
export function applyLayers(rows: Row[], inputs: LayerInputs): void {
  const rules = inputs.rules?.rules.length ? inputs.rules : null;
  const ix = inputs.ix ?? null;
  for (const t of rows) {
    const id = t.transaction_id;
    const own = inputs.records.get(id);
    const unknown = inputs.unknown.has(id);
    const carried: CarriedRowFacts | undefined = t.carried;

    // The rules, read against the row as it is before any of them.
    let outcome = NOTHING;
    if (rules || inputs.subjects) {
      const subject = subjectOf(t, ix, inputs.account);
      inputs.subjects?.set(id, subject);
      if (rules) outcome = evaluateRules(rules, subject, ix);
    }
    if (outcome.matched.length > 0) t.rule_ids = outcome.matched;
    else delete t.rule_ids;
    const listed = isListed(t);
    if (listed) {
      delete t.category_by_rule;
      delete t.name_before_rules;
    }
    // A rule's category, unless the person chose one for the row (or wrote
    // one on a row they entered or imported): filed by id, and carrying its
    // words, as a category chosen does, for the rules that read words.
    if (outcome.category && ix && !ownCategory(ix, t)) {
      const c = categoryById(ix, outcome.category.id);
      if (c) {
        t.rule_category = c.id;
        t.category = choiceText(c);
        if (listed) t.category_by_rule = true;
      }
    }
    // A rule's name, over the name the row came with, never the person's own.
    if (outcome.name && renamable(t)) {
      if (listed) t.name_before_rules = t.name;
      t.name = outcome.name.value;
    }

    // Excluded. A carried exclusion is already on the cached row; a rule's
    // hide is under everything the person said.
    delete t.excluded_by_rule;
    if (own?.excluded === true) t.excluded = true;
    else if (own?.excluded === false) delete t.excluded;
    else if (unknown) t.excluded = null;
    else if (carried?.excluded === false) delete t.excluded;
    else if (t.excluded !== true && outcome.hide) {
      t.excluded = true;
      t.excluded_by_rule = true;
    }

    if (isListed(t)) {
      // Tags, layer over layer: the rules', then carried, then the row's own.
      const tags = new Set<string>(outcome.tags);
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
    delete t.own_name;
  }
}

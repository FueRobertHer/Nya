// lib/export-layers.ts
//
// What the download of your data (lib/user-export.ts) says each transaction
// is, as the app shows it: the same layers (lib/txn-layers.ts), applied by
// the same function to every stored row, of any date, so the file and the app
// never disagree. The rules (lib/rules.ts), what was carried from earlier
// accounts (followed through the links that apply now) and what was said
// about each transaction, read from the parts of the file itself: `rules`,
// `carried-annotations`, `transaction-annotations` and `tags`. A record the
// file couldn't read is named under problems, and its transaction is treated
// as the app treats it: whether it is excluded isn't known (null), and it
// counts.

import { applyLayers, type LayerInputs } from './txn-layers';
import { carriedAnnotations, carriedExtras, isCarriedAnnotations, isTxnAnnotation, type CarriedAnnotation, type CarriedAnnotations, type TxnAnnotation } from './txn-annotations';
import { isTagSet, liveTagIds, type TagSet } from './tags';
import { compileRules, isRuleSet } from './rules';
import { contentKey, type StoredTxn, type Txn } from './transactions';
import { resolveId, type Link } from './link-core';
import type { CategoryFacts, CategoryIndex } from './categories';

/** What the layers read, gathered from the file's parts. */
export type ExportLayers = LayerInputs & { carried: Map<string, CarriedAnnotation> };

/** A map store's part of the file: its entries as { id, value }. */
function entries(part: unknown): [string, unknown][] {
  return Array.isArray(part)
    ? part.flatMap((e) => (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? [[(e as { id: string }).id, (e as { value?: unknown }).value] as [string, unknown]] : []))
    : [];
}

/**
 * The layers' inputs from the file's parts (`part` reads one by name): the
 * rules compiled against `ix`, the categories the file files rows by; the
 * carried records followed through `links`, the links that apply now;
 * `unknown`, the ids of the records the file couldn't read.
 */
export function exportLayers(part: (key: string) => unknown, opts: { links: Map<string, Link>; ix: CategoryIndex; unknown?: Iterable<string> }): ExportLayers {
  const records = new Map<string, TxnAnnotation>();
  for (const [id, value] of entries(part('transaction-annotations'))) if (isTxnAnnotation(value)) records.set(id, value);
  const carriedRecords = new Map<string, CarriedAnnotations>();
  for (const [id, value] of entries(part('carried-annotations'))) if (isCarriedAnnotations(value)) carriedRecords.set(id, value);
  const tagPart = part('tags');
  const tags = isTagSet(tagPart) ? (tagPart as TagSet) : null;
  const rulePart = part('rules');
  const account = opts.links.size ? (id: string) => resolveId(id, opts.links) : undefined;
  return {
    records,
    unknown: new Set(opts.unknown ?? []),
    tags,
    rules: compileRules(isRuleSet(rulePart) ? rulePart : null, { ix: opts.ix, liveTags: liveTagIds(tags), account }),
    ix: opts.ix,
    account,
    carried: carriedAnnotations(carriedRecords, opts.links),
  };
}

/** What a row is once the layers are applied. */
export type Layered = {
  /** Its tags, by name. */
  tags: string[];
  note: string | null;
  /** The name it shows. */
  name: string;
  /** Left out of budgets and reports; null when whether the person excluded
   *  it couldn't be read (it counts). */
  excluded: boolean | null;
  excluded_by_rule: boolean;
  /** The rules that match it, in the order they run. */
  rule_ids: string[];
  /** The category a rule files it under, by id, where one does. */
  rule_category?: string;
};

function layered(row: Txn, inputs: ExportLayers): Layered {
  applyLayers([row], inputs);
  const names = new Map((inputs.tags?.tags ?? []).map((t) => [t.id, t.name]));
  return {
    tags: (row.tags ?? []).map((id) => names.get(id)!).filter(Boolean),
    note: row.note ? row.note : null,
    name: row.name,
    excluded: row.excluded === true ? true : row.excluded === null ? null : false,
    excluded_by_rule: row.excluded_by_rule === true,
    rule_ids: row.rule_ids ?? [],
    ...(row.rule_category ? { rule_category: row.rule_category } : {}),
  };
}

/** The merchant behind a payment processor, when it differs from the name
 *  shown, as lib/transactions.ts works it out for the Activity tab. */
function counterpartyOf(t: StoredTxn, shown: string): string | null {
  const name = (t.counterparties ?? []).find((c) => c.type === 'merchant')?.name ?? null;
  return name && name.toLowerCase().trim() !== shown.toLowerCase().trim() ? name : null;
}

/** A bank's stored row, as the app would show it: `facts` is what files it
 *  (the person's category, else the carried one, else Plaid's), `renamed`
 *  the person's name for its merchant, if any. */
export function layerBankRow(t: StoredTxn, inputs: ExportLayers, facts: CategoryFacts, renamed: string | null): Layered {
  const carried = t.pending ? undefined : inputs.carried.get(contentKey(t.account_id, t));
  const extras = carriedExtras(carried);
  const shown = t.merchant_name || t.name;
  const row = {
    transaction_id: t.transaction_id,
    date: t.date,
    pending: t.pending,
    amount: t.amount,
    name: renamed ?? shown,
    ...(renamed ? { renamed_from: shown } : {}),
    counterparty: counterpartyOf(t, shown),
    account_name: t.account_name,
    institution_name: t.institution_name,
    account_ref: t.account_id,
    ...facts,
    iso_currency_code: t.iso_currency_code,
    ...(carried?.excluded === true ? { excluded: true } : {}),
    ...(extras ? { carried: extras } : {}),
  } as unknown as Txn;
  return layered(row, inputs);
}

/** A manual or imported row: its name, note and category (when it has one)
 *  are its own. */
export function layerManualRow(
  r: { id: string; account_id: string; date: string; name: string; amount: number; currency: string; category: string | null; note: string | null; source: string },
  inputs: ExportLayers,
  institution: string | null
): Layered {
  const row = {
    transaction_id: r.id,
    date: r.date,
    pending: false,
    amount: r.amount,
    name: r.name,
    account_name: '',
    institution_name: institution ?? '',
    account_ref: r.account_id,
    category: r.category,
    source: r.source,
    note: r.note,
    iso_currency_code: r.currency,
  } as unknown as Txn;
  return layered(row, inputs);
}

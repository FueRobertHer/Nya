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
// counts. So are merchants' default categories and what the person approved
// (lib/review-layer.ts), from `vendor-defaults` and `transaction-approvals`:
// an approved transaction is filed as it was approved, as in the app, and a
// default that or an approval the file couldn't read files nothing, as the
// app files nothing by one it can't read.

import { applyLayers, type LayerInputs } from './txn-layers';
import { carriedAnnotations, carriedExtras, isCarriedAnnotations, isTxnAnnotation, type CarriedAnnotation, type CarriedAnnotations, type TxnAnnotation } from './txn-annotations';
import { isTagSet, liveTagIds, type TagSet } from './tags';
import { compileRules, isRuleSet } from './rules';
import { contentKey, vendorKey, type StoredTxn, type Txn } from './transactions';
import { resolveId, type Link } from './link-core';
import type { CategoryFacts, CategoryIndex } from './categories';
import { isApproval, isReviewSettings, type Approval } from './review-store';
import { isVendorDefaults } from './vendor-defaults';
import { reviewLayerOf } from './review-layer';

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
  // The defaults and the approvals: what files a row and where an approved
  // one stays. The queue's settings only decide what is marked to review,
  // which the file's rows don't carry.
  const approvals = new Map<string, Approval>();
  for (const [id, value] of entries(part('transaction-approvals'))) if (isApproval(value)) approvals.set(id, value);
  const settingsPart = part('review-settings');
  const defaultsPart = part('vendor-defaults');
  const review = reviewLayerOf(
    {
      settings: isReviewSettings(settingsPart) ? { on: settingsPart.on, since: settingsPart.since } : null,
      settingsUnread: false,
      defaults: isVendorDefaults(defaultsPart) ? defaultsPart : null,
      defaultsUnread: false,
      approvals,
      approvalsUnknown: new Set(),
    },
    opts.ix
  ).layer;
  return {
    records,
    unknown: new Set(opts.unknown ?? []),
    tags,
    rules: compileRules(isRuleSet(rulePart) ? rulePart : null, { ix: opts.ix, liveTags: liveTagIds(tags), account }),
    ix: opts.ix,
    account,
    carried: carriedAnnotations(carriedRecords, opts.links),
    review,
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
  /** The category the layers file it under, by id, where they do: an
   *  approval's, a rule's or a merchant's default (lib/review-layer.ts). */
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
 *  the person's name for its merchant, if any, and `standsFor` the rows
 *  imported into its account it stands for (#52, earlier imports first), what
 *  was said about which carries to it once it has posted. */
export function layerBankRow(t: StoredTxn, inputs: ExportLayers, facts: CategoryFacts, renamed: string | null, standsFor?: readonly string[]): Layered {
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
    unofficial_currency_code: t.unofficial_currency_code ?? null,
    // The merchant, for its default, and the pending row a posted one
    // replaced, whose approval is its own (lib/review-layer.ts).
    vendor_key: vendorKey(t),
    ...(!t.pending && t.pending_transaction_id ? { pending_from: t.pending_transaction_id } : {}),
    ...(carried?.excluded === true ? { excluded: true } : {}),
    ...(extras ? { carried: extras } : {}),
    ...(standsFor?.length ? { stands_for: [...standsFor] } : {}),
  } as unknown as Txn;
  return layered(row, inputs);
}

/** A manual account's row, entered by hand or imported, or one SimpleFIN
 *  brought: its note and category (when it has one) are its own, and so is
 *  its name when it was entered by hand or the person named it
 *  (ManualTxn.named); a rule names an imported or SimpleFIN row otherwise.
 *  `institution` is the one the Activity tab shows it under. */
export function layerManualRow(
  r: { id: string; account_id: string; date: string; name: string; amount: number; currency: string; category: string | null; note: string | null; source: string; named?: string },
  inputs: ExportLayers,
  institution: string
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
    ...(r.named !== undefined && r.named === r.name ? { own_name: true } : {}),
  } as unknown as Txn;
  return layered(row, inputs);
}

/** A row imported into a linked account from its bank's files (#52), as the
 *  app shows it: filed by `facts` (the category chosen for it, else the
 *  file's own words, so a rule's files it only when it has neither); named
 *  by the person's name for its merchant (`renamed`, which no rule replaces),
 *  else a rule's, else the file's; with their note, kept beside it as on a
 *  bank's row, else the file's. On its account as known now (`account_id`),
 *  at that account's institution, which a rule's institution condition
 *  reads. */
export function layerImportedRow(
  r: { id: string; date: string; name: string; amount: number; currency: string; note: string | null; source: string },
  inputs: ExportLayers,
  opts: { facts: CategoryFacts; renamed: string | null; account_id: string; institution: string }
): Layered {
  const row = {
    transaction_id: r.id,
    date: r.date,
    pending: false,
    amount: r.amount,
    name: opts.renamed ?? r.name,
    ...(opts.renamed ? { renamed_from: r.name } : {}),
    account_name: '',
    institution_name: opts.institution,
    account_ref: opts.account_id,
    ...opts.facts,
    source: r.source,
    note: r.note,
    iso_currency_code: r.currency,
    // Its merchant, as the read layer keys it (lib/history-import/read.ts).
    vendor_key: vendorKey({ merchant_entity_id: null, merchant_name: null, name: r.name, institution_name: opts.institution }),
  } as unknown as Txn;
  return layered(row, inputs);
}

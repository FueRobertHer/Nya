// lib/category-usage.ts
//
// What still uses a category, for deleting it (lib/categories.ts
// deleteCategory: only a category nothing uses goes; else merge or archive).
// A category that can be deleted at all is filed into by its words alone
// (one Plaid files into never is), so what can use it is everything that keeps
// words: a category chosen for a transaction, one carried across a re-link,
// a manual or imported row (every one, of any date), a row imported into a
// linked account from its bank's files (every one, of any date, whether or
// not it counts now: a bank row standing for one today may be gone
// tomorrow), a bank row a restore brought back (every one, of any date,
// held or not: lib/user-restore/restored.ts), and a transaction from before
// Plaid's values were kept; a
// budget, by id; a rule, by id, in a condition or as the category it files
// into (lib/rules.ts); a part of a split transaction or a group of
// transactions, by id (lib/splits.ts, lib/groups.ts: every one, of any
// date); a transaction approved under it, by id (lib/review-store.ts: every
// one, of any date, since an approved transaction stays filed where it was
// approved); an IOU you owe, by id (lib/shared-expenses/model.ts: your
// part of what someone else paid counts in it on its day, of any date); and a
// merchant's default category, by id (lib/vendor-defaults.ts), which is
// cleared first. Every id is followed
// through a merge to where it went. Every read here is strict: a store that
// can't be read refuses the delete rather than letting a category go that
// something may use.

import type { Ctx } from './containers';
import { assembleBankRows, finishActivity } from './activity';
import { readOverridesStrict, readCarriedStrict } from './overrides';
import { manualTxnStore } from './manual-txns';
import { importedTxnStore } from './history-import/store';
import { restoredTxnStore } from './user-restore/store';
import { loadBudgets } from './budget-store';
import { placeBudgets } from './budget-set';
import { categoryById, indexTaxonomy, textKey, TEXT, type CategoryUsage, type Taxonomy } from './categories';
import { readRuleSet, ruleCategories } from './rules';
import { splitStore } from './splits';
import { groupStore } from './groups';
import { bankRows, GROUP_PREFIX, PART_PREFIX } from './split-rows';
import { approvalStore } from './review-store';
import { vendorDefaultsStore } from './vendor-default-store';
import { expenseIousStore } from './shared-expenses/store';
import { defaultUses } from './vendor-defaults';

/** How many transactions are filed under the category, and whether it has a
 *  budget. Reads the stored rows (no Plaid call), hidden accounts' too, and
 *  those of accounts that ended from their end day on (lib/lifecycle.ts):
 *  left out of every total, they are still stored, filed under it, and back
 *  if the account is reopened. */
export async function categoryUsage(ctx: Ctx, taxonomy: Taxonomy, id: string): Promise<CategoryUsage> {
  return (await categoryUsages(ctx, taxonomy, [id])).get(id)!;
}

/** categoryUsage of several categories, every store read once: for deleting
 *  many (an undone import's, lib/migration/commit.ts). */
export async function categoryUsages(ctx: Ctx, taxonomy: Taxonomy, ids: readonly string[]): Promise<Map<string, CategoryUsage>> {
  const out = new Map<string, CategoryUsage>();
  const wanted = ids.filter((id) => taxonomy.categories.some((x) => x.id === id));
  for (const id of ids) if (!wanted.includes(id)) out.set(id, { transactions: 0, budget: false });
  if (wanted.length === 0) return out;

  const [bank, overrides, carried, books, imported, restored, budgets, rules, splits, groups, approvals, defaults, ious] = await Promise.all([
    assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden: true, keepEnded: true }),
    readOverridesStrict(ctx),
    readCarriedStrict(ctx),
    manualTxnStore.getAll(ctx),
    importedTxnStore.getAll(ctx),
    restoredTxnStore.getAll(ctx),
    loadBudgets(ctx),
    readRuleSet(ctx),
    splitStore.getAll(ctx),
    groupStore.getAll(ctx),
    approvalStore.getAll(ctx),
    vendorDefaultsStore.get(ctx),
    expenseIousStore.getAll(ctx),
  ]);
  const shown = await finishActivity(ctx, bank.payload, new Set(), { keepEnded: true });
  const ix = indexTaxonomy(taxonomy);
  const placed = placeBudgets(budgets.budgets, indexTaxonomy(budgets.taxonomy));
  for (const id of wanted) {
    const c = taxonomy.categories.find((x) => x.id === id)!;
    const words = new Set(c.provider_keys.filter((k) => k.provider === TEXT).map((k) => k.key));
    const uses = (text: string | null | undefined) => !!text && words.has(textKey(text));
    const isIt = (ref: string) => categoryById(ix, ref)?.id === id;
    // Rows in the window, as filed: a split's parts and a group's net among
    // them, and each transaction whole too (one in a group is inside its row).
    // Then what keeps words or ids outside it.
    const counted = new Set<string>();
    for (const t of [...shown.transactions, ...bankRows(shown.transactions), ...shown.history]) if (t.category_id === id) counted.add(t.transaction_id);
    for (const [tid, text] of overrides) if (uses(text)) counted.add(tid);
    let carriedRows = 0;
    for (const rows of carried.values()) for (const text of Object.values(rows)) if (uses(text)) carriedRows++;
    for (const book of books.values()) for (const row of book.rows) if (uses(row.category)) counted.add(row.id);
    // Every part and every group, of any date, under the ids their rows have.
    for (const record of splits.values()) for (const p of record.parts) if (isIt(p.category_id)) counted.add(`${PART_PREFIX}${p.id}`);
    for (const [gid, g] of groups) if (isIt(g.category_id)) counted.add(`${GROUP_PREFIX}${gid}`);
    // Every transaction approved under it, of any date: it stays filed there.
    for (const [tid, a] of approvals) if (a.category_id && isIt(a.category_id)) counted.add(tid);
    // Every IOU you owe under it, of any date: its row counts there.
    for (const [iid, iou] of ious) if (iou.category_id && isIt(iou.category_id)) counted.add(`iou:${iid}`);
    for (const book of imported.values()) for (const row of book.rows) if (uses(row.category)) counted.add(row.id);
    // A restored bank row is filed by its own words where Plaid's values
    // don't file it, as the bank's are.
    for (const book of restored.values()) for (const row of book.rows) if (uses(row.bank.category)) counted.add(row.id);
    // A rule naming it, or a category merged into it.
    const ruleUses = (rules?.rules ?? []).filter((r) => ruleCategories(r).some(isIt)).length;
    // The keys counted for: the delete refuses if they change before it lands.
    out.set(id, { transactions: counted.size + carriedRows, budget: placed.categories.has(id), rules: ruleUses, defaults: defaultUses(defaults, isIt), keys: c.provider_keys });
  }
  return out;
}

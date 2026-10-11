// lib/category-usage.ts
//
// What still uses a category, for deleting it (lib/categories.ts
// deleteCategory: only a category nothing uses goes; else merge or archive).
// A category that can be deleted at all is filed into by its words alone
// (one Plaid files into never is), so what can use it is everything that keeps
// words: a category chosen for a transaction, one carried across a re-link,
// a manual or imported row (every one, of any date), and a transaction from
// before Plaid's values were kept; a budget, by id; and a rule, by id, in a
// condition or as the category it files into (lib/rules.ts). Every read here
// is strict: a store that can't be read refuses the delete rather than
// letting a category go that something may use.

import type { Ctx } from './containers';
import { assembleBankRows, finishActivity } from './activity';
import { readOverridesStrict, readCarriedStrict } from './overrides';
import { manualTxnStore } from './manual-txns';
import { loadBudgets } from './budget-store';
import { placeBudgets } from './budget-set';
import { categoryById, indexTaxonomy, textKey, TEXT, type CategoryUsage, type Taxonomy } from './categories';
import { readRuleSet, ruleCategories } from './rules';

/** How many transactions are filed under the category, and whether it has a
 *  budget. Reads the stored rows (no Plaid call), hidden accounts' too, and
 *  those of accounts that ended from their end day on (lib/lifecycle.ts):
 *  left out of every total, they are still stored, filed under it, and back
 *  if the account is reopened. */
export async function categoryUsage(ctx: Ctx, taxonomy: Taxonomy, id: string): Promise<CategoryUsage> {
  const c = taxonomy.categories.find((x) => x.id === id);
  if (!c) return { transactions: 0, budget: false };
  const words = new Set(c.provider_keys.filter((k) => k.provider === TEXT).map((k) => k.key));
  const uses = (text: string | null | undefined) => !!text && words.has(textKey(text));

  const [bank, overrides, carried, books, budgets, rules] = await Promise.all([
    assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden: true, keepEnded: true }),
    readOverridesStrict(ctx),
    readCarriedStrict(ctx),
    manualTxnStore.getAll(ctx),
    loadBudgets(ctx),
    readRuleSet(ctx),
  ]);
  const shown = await finishActivity(ctx, bank.payload, new Set(), { keepEnded: true });
  // Rows in the window, as filed; then what keeps words outside it.
  const counted = new Set<string>();
  for (const t of [...shown.transactions, ...shown.history]) if (t.category_id === id) counted.add(t.transaction_id);
  for (const [tid, text] of overrides) if (uses(text)) counted.add(tid);
  let carriedRows = 0;
  for (const rows of carried.values()) for (const text of Object.values(rows)) if (uses(text)) carriedRows++;
  for (const book of books.values()) for (const row of book.rows) if (uses(row.category)) counted.add(row.id);
  const placed = placeBudgets(budgets.budgets, indexTaxonomy(budgets.taxonomy));
  // A rule naming it, or a category merged into it.
  const ix = indexTaxonomy(taxonomy);
  const ruleUses = (rules?.rules ?? []).filter((r) => ruleCategories(r).some((ref) => categoryById(ix, ref)?.id === id)).length;
  // The keys counted for: the delete refuses if they change before it lands.
  return { transactions: counted.size + carriedRows, budget: placed.categories.has(id), rules: ruleUses, keys: c.provider_keys };
}

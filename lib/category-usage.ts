// lib/category-usage.ts
//
// What still uses a category, for deleting it (lib/categories.ts
// deleteCategory: only a category nothing uses goes; else merge or archive).
// A category that can be deleted at all is filed into by its words alone
// (one Plaid files into never is), so what can use it is everything that keeps
// words: a category chosen for a transaction, one carried across a re-link,
// a manual or imported row (every one, of any date), and a transaction from
// before Plaid's values were kept; and a budget, by id. Every read here is
// strict: a store that can't be read refuses the delete rather than letting a
// category go that something may use.

import type { Ctx } from './containers';
import { assembleBankRows, finishActivity } from './activity';
import { readOverridesStrict, readCarriedStrict } from './overrides';
import { manualTxnStore } from './manual-txns';
import { loadBudgets } from './budget-store';
import { placeBudgets } from './budget-set';
import { indexTaxonomy, textKey, TEXT, type CategoryUsage, type Taxonomy } from './categories';

/** How many transactions are filed under the category, and whether it has a
 *  budget. Reads the stored rows (no Plaid call), hidden accounts' too. */
export async function categoryUsage(ctx: Ctx, taxonomy: Taxonomy, id: string): Promise<CategoryUsage> {
  const c = taxonomy.categories.find((x) => x.id === id);
  if (!c) return { transactions: 0, budget: false };
  const words = new Set(c.provider_keys.filter((k) => k.provider === TEXT).map((k) => k.key));
  const uses = (text: string | null | undefined) => !!text && words.has(textKey(text));

  const [bank, overrides, carried, books, budgets] = await Promise.all([
    assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden: true }),
    readOverridesStrict(ctx),
    readCarriedStrict(ctx),
    manualTxnStore.getAll(ctx),
    loadBudgets(ctx),
  ]);
  const shown = await finishActivity(ctx, bank.payload, new Set());
  // Rows in the window, as filed; then what keeps words outside it.
  const counted = new Set<string>();
  for (const t of [...shown.transactions, ...shown.history]) if (t.category_id === id) counted.add(t.transaction_id);
  for (const [tid, text] of overrides) if (uses(text)) counted.add(tid);
  let carriedRows = 0;
  for (const rows of carried.values()) for (const text of Object.values(rows)) if (uses(text)) carriedRows++;
  for (const book of books.values()) for (const row of book.rows) if (uses(row.category)) counted.add(row.id);
  const placed = placeBudgets(budgets.budgets, indexTaxonomy(budgets.taxonomy));
  // The keys counted for: the delete refuses if they change before it lands.
  return { transactions: counted.size + carriedRows, budget: placed.categories.has(id), keys: c.provider_keys };
}

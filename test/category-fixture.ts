// Your categories and budgets for the view tests: a set seeded as the app
// seeds one (lib/categories.ts), holding these words, with ids made in order,
// and budgets on them given by name, as a view gets them (lib/budget-set.ts:
// by id). Rows in those tests carry only words, which the views file by
// against the set (lib/categories.ts filedId), as they do a row shown before
// the server files it. `groups` moves a category, by its words, into a seeded
// group, by name, so budgets can sit in groups of their own.

import { indexTaxonomy, moveCategory, seedTaxonomy, textKeys, type Taxonomy } from '@/lib/categories';
import { budgetsFromNames, type Budgets } from '@/lib/budget-set';

export function categoriesFor(
  budgetsByName: Record<string, number> = {},
  opts: { words?: string[]; groups?: Record<string, string> } = {}
): { taxonomy: Taxonomy; budgets: Budgets } {
  let n = 0;
  let taxonomy = seedTaxonomy(textKeys([...Object.keys(budgetsByName), ...(opts.words ?? [])]), () => `t${++n}`);
  for (const [name, group] of Object.entries(opts.groups ?? {})) {
    const c = taxonomy.categories.find((x) => x.name.toLowerCase() === name.toLowerCase())!;
    taxonomy = moveCategory(taxonomy, c.id, taxonomy.groups.find((g) => g.name === group)!.id);
  }
  return { taxonomy, budgets: { categories: budgetsFromNames(budgetsByName, indexTaxonomy(taxonomy)).categories, groups: {} } };
}

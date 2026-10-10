'use client';

// The Activity tab's top spending, rolled up to your category groups
// (lib/categories.ts): each group with its total, collapsed, and opened with a
// tap to its categories, each with its own. Bars share one scale, the largest
// group's, so a category's bar reads against its group's. Spending is what the
// month's totals count (lib/spending.ts countsInTotals, done by the caller),
// by category id.

import { useMemo, useState } from 'react';
import { formatMoney } from '@/lib/format';
import { spendingByGroup } from '@/lib/budget-set';
import { categoryById, displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';

export default function CategoryRollup({
  taxonomy,
  byCategory,
  currency,
}: {
  taxonomy: Taxonomy;
  /** Spending by category id. An id the set doesn't have (filed by one not
   *  loaded here yet) counts under the uncategorized category, never left out. */
  byCategory: ReadonlyMap<string, number>;
  currency: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const ix = indexTaxonomy(taxonomy);
    const known = new Map<string, number>();
    for (const [id, total] of byCategory) {
      const at = categoryById(ix, id)?.id ?? taxonomy.uncategorized;
      known.set(at, (known.get(at) ?? 0) + total);
    }
    return spendingByGroup(ix, known);
  }, [taxonomy, byCategory]);
  if (groups.length === 0) return null;
  const max = groups[0].total || 1;
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="cat-list">
      {groups.map(({ group, total, categories }) => {
        const expanded = open.has(group.id);
        return (
          <div key={group.id} className="rollup-group">
            <button
              className="cat-row rollup-toggle"
              onClick={() => toggle(group.id)}
              aria-expanded={expanded}
              aria-label={`${group.name}: ${formatMoney(total, currency)}. ${expanded ? 'Hide' : 'Show'} its categories`}
            >
              <span className="cat-name rollup-name">
                <span className="rollup-caret" aria-hidden="true">
                  {expanded ? '▾' : '▸'}
                </span>
                {group.name}
              </span>
              <div className="cat-track">
                <div className="cat-bar" style={{ width: `${(total / max) * 100}%` }} />
              </div>
              <span className="cat-val">{formatMoney(total, currency)}</span>
            </button>
            {expanded &&
              categories.map(({ category, total: sum }) => (
                <div className="cat-row rollup-child" key={category.id}>
                  <span className="cat-name rollup-name">
                    {category.icon ? `${category.icon} ` : ''}
                    {displayName(category.name)}
                  </span>
                  <div className="cat-track">
                    <div className="cat-bar rollup-child-bar" style={{ width: `${(sum / max) * 100}%` }} />
                  </div>
                  <span className="cat-val">{formatMoney(sum, currency)}</span>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}

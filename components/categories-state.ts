'use client';

// Your categories on the dashboard (lib/categories.ts): loaded once from
// /api/categories, replaced by the set each transactions answer was filed by
// (app/api/transactions), and by the answer to every change made on the
// Categories screen (components/CategoryManager.tsx). The lists to choose a
// category from, the group rollups and the budgets all read it. Until it has
// loaded it is null: those show what the rows say, and offer no list.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTaxonomy, type Taxonomy } from '@/lib/categories';

export type CategoriesState = {
  taxonomy: Taxonomy | null;
  /** Why the categories couldn't be loaded, while they can't. */
  error: string | null;
  /** Takes a set an answer carried (a transactions load, a change made). */
  accept: (t: unknown) => void;
  reload: () => Promise<void>;
};

export function useCategories(): CategoriesState {
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counts every set taken, so a load that started before one isn't kept
  // over it.
  const taken = useRef(0);

  const accept = useCallback((t: unknown) => {
    if (!isTaxonomy(t)) return;
    taken.current++;
    setTaxonomy(t);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    const at = taken.current;
    try {
      const res = await fetch('/api/categories');
      const data = await res.json().catch(() => null);
      if (taken.current !== at) return;
      if (res.ok && isTaxonomy(data?.categories)) {
        setTaxonomy(data.categories);
        setError(null);
        return;
      }
      setError(typeof data?.error === 'string' ? data.error : 'Your categories couldn’t be loaded.');
    } catch {
      if (taken.current === at) setError('Your categories couldn’t be loaded.');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { taxonomy, error, accept, reload };
}

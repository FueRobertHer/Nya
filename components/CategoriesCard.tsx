'use client';

// Your categories, under Manage on the Accounts tab: how many there are, in
// how many groups, and the Categories screen (components/CategoryManager.tsx)
// to rename, regroup, archive, merge or delete them. A change made there shows
// on the next read of the transactions and the budgets, which the dashboard
// starts as soon as it is made (`onChanged`).

import { useState } from 'react';
import CategoryManager from './CategoryManager';
import type { CategoriesState } from './categories-state';

export default function CategoriesCard({ categories, onChanged }: { categories: CategoriesState; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { taxonomy, error } = categories;
  const shown = taxonomy ? taxonomy.categories.filter((c) => !c.archived).length : 0;
  const archived = taxonomy ? taxonomy.categories.length - shown : 0;

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Categories</div>
      </div>
      {taxonomy ? (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {shown} categor{shown === 1 ? 'y' : 'ies'} in {taxonomy.groups.length} group{taxonomy.groups.length === 1 ? '' : 's'}
            {archived > 0 ? `, and ${archived} archived` : ''}. Rename, regroup, archive or merge them: transactions, budgets and totals follow.
          </p>
          <button className="secondary" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>
            Edit categories
          </button>
          <CategoryManager
            open={open}
            onClose={() => setOpen(false)}
            taxonomy={taxonomy}
            onTaxonomy={(t) => {
              categories.accept(t);
              onChanged();
            }}
          />
        </>
      ) : error ? (
        <>
          <p className="stale-note">{error}</p>
          <button className="secondary" style={{ marginTop: 12 }} onClick={() => void categories.reload()}>
            Try again
          </button>
        </>
      ) : (
        <p className="empty-note">Loading your categories…</p>
      )}
    </div>
  );
}

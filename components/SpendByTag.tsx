'use client';

// Spending by tag on the Activity tab (#40), beside top spending: for the
// month shown, what each tag's transactions spent, by the rule every total
// on the tab follows (lib/tag-totals.ts, lib/spending.ts): in the tab's one
// currency, with transfers, loan payments and what is excluded or hidden
// left out. Each transaction adds to its tag exactly what it adds to its
// category, so a tag's figure always agrees with the category totals of its
// transactions; one with two tags counts under both, which the card says.

import { useMemo } from 'react';
import { formatMoney } from '@/lib/format';
import { spendingByTag, type TaggedRow } from '@/lib/tag-totals';
import { shownColor, type Tag } from '@/lib/tags';
import { Masked } from './HideAmounts';

export default function SpendByTag({ txns, tags, currency, caption }: { txns: readonly TaggedRow[]; tags: readonly Tag[]; currency: string | null; caption?: string }) {
  const totals = useMemo(() => {
    const byId = new Map(tags.map((t) => [t.id, t]));
    return spendingByTag(txns, () => true, currency).flatMap((s) => {
      const tag = byId.get(s.tag);
      return tag ? [{ ...s, tag }] : [];
    });
  }, [txns, tags, currency]);
  if (totals.length === 0) return null;
  const max = totals[0].spent || 1;
  const overlapping = txns.some((t) => (t.tags?.length ?? 0) > 1);
  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Spending by tag</div>
        {caption && <div className="inst-total">{caption}</div>}
      </div>
      <div className="cat-list">
        {totals.map(({ tag, spent, transactions }) => (
          <div className="cat-row" key={tag.id} title={`${transactions} transaction${transactions === 1 ? '' : 's'}`}>
            <span className="cat-name">
              <span className={`tag-chip tag-${shownColor(tag.color)}`}>{tag.name}</span>
            </span>
            <div className="cat-track">
              <div className="cat-bar" style={{ width: `${(spent / max) * 100}%` }} />
            </div>
            <span className="cat-val"><Masked>{formatMoney(spent, currency)}</Masked></span>
          </div>
        ))}
      </div>
      {overlapping && <p className="chart-note">A transaction with more than one tag counts under each, so these can add up to more than the month’s spending.</p>}
    </div>
  );
}

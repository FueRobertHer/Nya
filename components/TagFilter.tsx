'use client';

// The Activity tab's filter by tag (#40): every transaction, or only those
// carrying one tag, whoever put it there (the person, a rule, or an earlier
// account's row carried across a re-link). It narrows the list, as the
// search does; the month's totals stay the month's.

import type { Tag } from '@/lib/tags';

export default function TagFilter({ tags, value, onChange }: { tags: readonly Tag[]; value: string; onChange: (id: string) => void }) {
  if (tags.length === 0) return null;
  return (
    <select className="text-input tag-filter" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Show transactions with a tag">
      <option value="">All tags</option>
      {[...tags]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => (
          <option key={t.id} value={t.id}>
            Tagged {t.name}
          </option>
        ))}
    </select>
  );
}

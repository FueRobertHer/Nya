'use client';

// The Activity tab's filter by tag (#40): every transaction, or only those
// carrying one tag, whoever put it there (the person, a rule, or an earlier
// account's row carried across a re-link). A chip among the list's filters
// (components/ChipSelect.tsx). It narrows the list, as the search does; the
// month's totals stay the month's.

import type { Tag } from '@/lib/tags';
import ChipSelect from './ChipSelect';

export default function TagFilter({ tags, value, onChange }: { tags: readonly Tag[]; value: string; onChange: (id: string) => void }) {
  if (tags.length === 0) return null;
  const chosen = tags.find((t) => t.id === value);
  return (
    <ChipSelect label="Tag" shown={chosen ? `Tag: ${chosen.name}` : 'Tag'} on={!!chosen} value={chosen ? value : ''} onChange={onChange}>
      <option value="">All tags</option>
      {[...tags]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
    </ChipSelect>
  );
}

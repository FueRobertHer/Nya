'use client';

// A transaction's tags as small chips, each in its tag's color
// (lib/tags.ts): on the Activity tab's rows, after the merchant, and in the
// transaction's detail, where each can be taken off (`onRemove`). An id no
// tag has (one deleted on another device since the list loaded) shows
// nothing.

import { shownColor, type Tag } from '@/lib/tags';

export default function TagChips({
  ids,
  tags,
  onRemove,
  disabled,
}: {
  ids: readonly string[] | undefined;
  tags: readonly Tag[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  if (!ids?.length) return null;
  const byId = new Map(tags.map((t) => [t.id, t]));
  const shown = ids.map((id) => byId.get(id)).filter((t): t is Tag => !!t);
  if (shown.length === 0) return null;
  return (
    <span className="tag-chips">
      {shown.map((t) => (
        <span key={t.id} className={`tag-chip tag-${shownColor(t.color)}`}>
          {t.name}
          {onRemove && (
            <button type="button" className="tag-chip-remove" onClick={() => onRemove(t.id)} disabled={disabled} aria-label={`Take ${t.name} off`}>
              ×
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

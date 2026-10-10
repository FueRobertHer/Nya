'use client';

// The list to choose one of your categories from (lib/categories.ts): a
// <select> with a group of options per category group, in your order, each
// category by name. Archived categories are left out, except the one chosen
// now, so a transaction filed under one keeps it until another is chosen.
// The value is a category id ('' for none, where `none` names it).

import { categoriesIn, displayName, sortedGroups, type Taxonomy } from '@/lib/categories';

/** The groups and the categories in each that the list offers, in order. */
export function pickerOptions(taxonomy: Taxonomy, current: string | null | undefined): { group: string; options: { id: string; label: string }[] }[] {
  return sortedGroups(taxonomy)
    .map((g) => ({
      group: g.name,
      options: categoriesIn(taxonomy, g.id)
        .filter((c) => !c.archived || c.id === current)
        .map((c) => ({ id: c.id, label: `${c.icon ? `${c.icon} ` : ''}${displayName(c.name)}${c.archived ? ' (archived)' : ''}` })),
    }))
    .filter((g) => g.options.length > 0);
}

export default function CategoryPicker({
  taxonomy,
  value,
  onChange,
  none,
  className = 'text-input',
  label,
  disabled,
}: {
  taxonomy: Taxonomy;
  value: string | null | undefined;
  onChange: (id: string) => void;
  /** Offers no category, under this label. */
  none?: string;
  className?: string;
  /** For a list with no visible label of its own. */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <select className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={disabled}>
      {none !== undefined && <option value="">{none}</option>}
      {pickerOptions(taxonomy, value).map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

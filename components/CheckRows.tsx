'use client';

// Check rows (docs/design/design-system.md): a few things to choose any of,
// one 44px row each, the whole row the target, under a legend. Above a
// sheet's footer, for what a save does besides (Also change it in,
// components/AlsoChange.tsx). Nothing is checked until the person checks it.

import type { ReactNode } from 'react';

export type CheckRow = {
  key: string;
  title: string;
  /** One line under the title: its value, say. */
  sub?: ReactNode;
};

export default function CheckRows({
  legend,
  rows,
  checked,
  onChange,
  disabled = false,
}: {
  legend: string;
  rows: readonly CheckRow[];
  checked: readonly string[];
  /** The keys checked now, in the rows' order. */
  onChange: (keys: string[]) => void;
  disabled?: boolean;
}) {
  if (rows.length === 0) return null;
  const toggle = (key: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(key);
    else next.delete(key);
    onChange(rows.filter((r) => next.has(r.key)).map((r) => r.key));
  };
  return (
    <fieldset className="check-rows">
      <legend className="section-label">{legend}</legend>
      {rows.map((r) => (
        <label key={r.key} className="check-row">
          <input type="checkbox" checked={checked.includes(r.key)} onChange={(e) => toggle(r.key, e.target.checked)} disabled={disabled} />
          <span className="check-row-text">
            <span className="check-row-title">{r.title}</span>
            {r.sub && <span className="check-row-sub">{r.sub}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

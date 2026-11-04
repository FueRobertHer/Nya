'use client';

// Also change it in (the tax plan's C2): in a figure's sheet, or one editing
// an income, a one-off or a life event, the other plans the same change can
// go to, each with its value there now, none checked. Saving saves the plan
// open and every one checked together, all or none (PUT /api/plans). Only
// plans whose amounts are in the same currency (or that hold none) are
// offered; components/PlanTab.tsx works out which.

import CheckRows from './CheckRows';
import { Masked } from './HideAmounts';

export type AlsoChoice = { id: string; name: string; value: string };

export default function AlsoChange({
  choices,
  checked,
  onChange,
  disabled = false,
}: {
  choices: readonly AlsoChoice[];
  checked: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <CheckRows
      legend="Also change it in"
      rows={choices.map((c) => ({ key: c.id, title: c.name, sub: <Masked>{c.value}</Masked> }))}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

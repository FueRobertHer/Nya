'use client';

// An object's actions in its sheet, one to a row: a card of list rows, each
// a button, as the Add account sheet's options and Settings' sections are
// (the screen review found the transaction sheet's Split, Group with others,
// Share the cost and Exclude from budgets as tonal buttons of four widths,
// wrapping raggedly). A row that opens another sheet ends in a chevron and
// says so to a screen reader; one that acts in place has none.

import { chevron, RIGHT } from './MonthStepper';

export type SheetAction = {
  /** The row's key: stable when its title changes (the exclusion row's
   *  flips between Exclude and Include), so focus stays on it. */
  key: string;
  title: string;
  /** One line under the title, for what the action does when that isn't
   *  plain from its name. */
  sub?: string;
  /** It opens another sheet. */
  opens?: boolean;
  onSelect: () => void;
};

export default function ActionRows({ rows }: { rows: readonly SheetAction[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="card list-rows">
      {rows.map((r) => (
        <li key={r.key}>
          <button type="button" className="list-row" aria-haspopup={r.opens ? 'dialog' : undefined} onClick={r.onSelect}>
            <span className="list-row-text">
              <span className="list-row-title">{r.title}</span>
              {r.sub && <span className="list-row-sub">{r.sub}</span>}
            </span>
            {r.opens && chevron(RIGHT)}
          </button>
        </li>
      ))}
    </ul>
  );
}

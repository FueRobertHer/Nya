'use client';

// Radio rows (docs/design/design-system.md, "Radio rows"): one of a few
// options, each with a sentence under its name, in a fieldset whose legend
// says what is chosen. Native radios: one tab stop, the arrows move between
// them, and each row's whole label is the target, at least 44px. A choice
// here is saved by a button beside it, never on the choice alone (arrow keys
// choose at every step). The picked option's own fields (an age, a number of
// years) sit under its row, and an option can be off, with the reason under
// the legend (since E2: an item's Starts and Ends).

import { Fragment, type ReactNode } from 'react';

export type RadioOption = {
  value: string;
  name: string;
  /** One short line, no amounts (they would go unmasked). */
  note?: string;
  /** Off, unless it is the one picked, so the group keeps its tab stop: the
   *  group's helper says why. */
  disabled?: boolean;
  /** Its fields while it is picked, under its row, not in its label (no
   *  control sits inside another's label). */
  detail?: ReactNode;
};

export default function RadioRows({
  legend,
  name,
  options,
  value,
  onChange,
  disabled = false,
  helper,
}: {
  legend: string;
  /** The radios' group name, unique on the page. */
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Under the legend, read with the group: why an option is off. */
  helper?: string;
}) {
  const helperId = `${name}-helper`;
  return (
    <fieldset className="radio-rows" disabled={disabled} aria-describedby={helper ? helperId : undefined}>
      <legend className="section-label">{legend}</legend>
      {helper && (
        <p className="helper" id={helperId}>
          {helper}
        </p>
      )}
      {options.map((o) => (
        <Fragment key={o.value}>
          <label className="radio-row">
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled && value !== o.value} onChange={() => onChange(o.value)} />
            <span>
              <span className="radio-row-name">{o.name}</span>
              {o.note && <span className="radio-row-note">{o.note}</span>}
            </span>
          </label>
          {value === o.value && o.detail && <div className="radio-row-detail">{o.detail}</div>}
        </Fragment>
      ))}
    </fieldset>
  );
}

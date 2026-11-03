'use client';

// Radio rows (docs/design/design-system.md, "Radio rows"): one of a few
// options, each with a sentence under its name, in a fieldset whose legend
// says what is chosen. Native radios: one tab stop, the arrows move between
// them, and each row's whole label is the target, at least 44px. A choice
// here is saved by a button beside it, never on the choice alone (arrow keys
// choose at every step).

export type RadioOption = { value: string; name: string; note?: string };

export default function RadioRows({
  legend,
  name,
  options,
  value,
  onChange,
  disabled = false,
}: {
  legend: string;
  /** The radios' group name, unique on the page. */
  name: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="radio-rows" disabled={disabled}>
      <legend className="section-label">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="radio-row">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            <span className="radio-row-name">{o.name}</span>
            {o.note && <span className="radio-row-note">{o.note}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

'use client';

// The Accounts chip on Accounts > Investments and the sheet it opens
// (docs/design/design-system.md#badge-and-chip). Presets (All accounts,
// Retirement, Non-retirement) check their accounts, and each account is a
// checkbox, so any set can be chosen; a preset shows as chosen while the
// checked set is its own. Show applies the set, and Cancel or closing keeps
// what was shown. With nothing checked, Show waits.
//
// The chip says what is shown: "Accounts" for every account, a preset's name,
// the account's own name for one (cut short with an ellipsis, its last
// digits kept in view), or how many of how many ("Accounts: 2 of 3").

import { useId, useState } from 'react';
import { nameAndMask, withMask } from '@/lib/account-names';
import CheckRows from './CheckRows';
import RadioRows from './RadioRows';
import { Sheet } from './Sheet';

export type ChooserAccount = {
  key: string;
  name: string;
  mask: string | null;
  /** Its line in the sheet: "Vanguard · Retirement". */
  sub: string;
};

export type ChooserPreset = {
  value: string;
  name: string;
  note?: string;
  /** Its accounts, in the accounts' order. */
  keys: readonly string[];
};

/** The preset whose accounts are exactly `keys`, if any. */
export function presetOf(presets: readonly ChooserPreset[], keys: readonly string[]): ChooserPreset | null {
  const set = new Set(keys);
  return presets.find((p) => p.keys.length === set.size && p.keys.every((k) => set.has(k))) ?? null;
}

export default function AccountsChooser({
  accounts,
  presets,
  shown,
  onChoose,
}: {
  accounts: readonly ChooserAccount[];
  /** The first is every account. */
  presets: readonly ChooserPreset[];
  /** The keys shown now. */
  shown: readonly string[];
  /** The keys to show, in the accounts' order, and the preset they are. */
  onChoose: (keys: string[], preset: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const group = useId();

  const now = presetOf(presets, shown);
  const one = shown.length === 1 && !now ? accounts.find((a) => a.key === shown[0]) : undefined;
  const named = one ? nameAndMask(one.name, one.mask) : null;
  const all = now === presets[0];
  const words = all ? 'Accounts' : now ? `Accounts: ${now.name}` : named ? `Accounts: ${named.name}` : `Accounts: ${shown.length} of ${accounts.length}`;

  const inOrder = (keys: Iterable<string>) => {
    const set = new Set(keys);
    return accounts.filter((a) => set.has(a.key)).map((a) => a.key);
  };
  // The draft as the accounts are now: one that went while the sheet was
  // open is no longer checked, and one that came isn't yet.
  const checked = inOrder(draft);
  const picked = presetOf(presets, checked);
  const close = () => setOpen(false);
  const show = () => {
    if (checked.length === 0) return;
    onChoose(checked, picked?.value ?? null);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="chip"
        aria-haspopup="dialog"
        data-on={all ? undefined : ''}
        onClick={() => {
          setDraft(inOrder(shown));
          setOpen(true);
        }}
      >
        <span className="chip-text">
          <span className="chip-name">{words}</span>
          {named?.mask && <span className="chip-mask">{` ••${named.mask}`}</span>}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Sheet
        open={open}
        title="Accounts"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn" disabled={checked.length === 0} onClick={show}>
              Show
            </button>
          </>
        }
      >
        <div className="stack loose">
          {presets.length > 0 && (
            <RadioRows
              legend="Presets"
              name={`${group}-preset`}
              options={presets.map((p) => ({ value: p.value, name: p.name, note: p.note }))}
              value={picked?.value ?? ''}
              onChange={(value) => setDraft(inOrder(presets.find((p) => p.value === value)?.keys ?? []))}
            />
          )}
          <CheckRows
            legend="Or choose accounts"
            rows={accounts.map((a) => ({ key: a.key, title: withMask(a.name, a.mask), sub: a.sub }))}
            checked={checked}
            onChange={(keys) => setDraft(inOrder(keys))}
          />
          {/* On the page throughout, so the line is said as it comes. */}
          <p className="helper" role="status">
            {checked.length === 0 ? 'Choose at least one account.' : ''}
          </p>
        </div>
      </Sheet>
    </>
  );
}

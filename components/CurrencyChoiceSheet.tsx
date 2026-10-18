'use client';

// Choosing the home currency (lib/fx/settings.ts), from the offer on Home or
// the Currency card. Only the person's confirmation here ever writes one: Nya
// never chooses it for them (docs/architecture.md, "Exchange rates"). The
// sheet says exactly what changes in this release: net worth is shown in it,
// converted at the ECB's daily rates; budgets, goals and the Plan stay as
// they are, in the currencies they're shown in now; and a manual account in
// another currency stays in it, its balance converted for the total.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { currencyName, errorOf, everyCurrency, useCurrencySettings, type CurrencySettingsView } from './currency-state';

type Props = {
  open: boolean;
  onClose: () => void;
  /** The sheet's title: the offer's words, or the card's. */
  title?: string;
  /** Chosen when the sheet opens: a suggestion's, or what is chosen now. */
  initial: string | null;
  /** The currencies offered first: the person's accounts', most first. */
  first: readonly string[];
  /** The manual accounts, for what the sheet says of them. */
  manual: readonly { name: string; currency: string }[];
  /** Saved: what is chosen now. */
  onSaved: (home: string | null) => void;
};

const list = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What the sheet says of the manual accounts in another currency than
 *  `home`: they stay in it, converted for the total. Null when none is. */
export function manualText(manual: readonly { name: string; currency: string }[], home: string): string | null {
  const other = manual.filter((m) => m.currency !== home);
  if (other.length === 0) return null;
  const currencies = [...new Set(other.map((m) => m.currency))];
  if (other.length === 1) return `Your manual account ${other[0].name} stays in ${other[0].currency}; its balance is converted for the total.`;
  const where = currencies.length === 1 ? `stay in ${currencies[0]}` : 'stay in their own currencies';
  return `Your manual accounts ${list(other.map((m) => m.name))} ${where}; their balances are converted for the total.`;
}

/** The words the sheet shows for a choice (step 1 of currency conversion:
 *  net worth only). */
export function choiceText(home: string): string {
  return `Your net worth will be shown in ${home}, with accounts in other currencies converted at the European Central Bank’s daily rates. Your budgets, goals and the Plan stay as they are, in the currencies they’re shown in now.`;
}

export default function CurrencyChoiceSheet({ open, onClose, title = 'Show your totals in one currency', initial, first, manual, onSaved }: Props) {
  const { load } = useCurrencySettings(open);
  const [chosen, setChosen] = useState<string>(initial ?? first[0] ?? 'EUR');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setChosen(initial ?? first[0] ?? 'EUR');
      setError(null);
    }
  }, [open, initial, first]);

  const view = load.kind === 'ready' ? load.view : null;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/currency', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ home: chosen }) });
      if (!res.ok) {
        setError(await errorOf(res, 'It wasn’t saved. Try again.'));
        return;
      }
      onSaved(chosen);
      onClose();
    } catch {
      setError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} title={title} onClose={() => !saving && onClose()}>
      <CurrencyChoiceBody view={view} chosen={chosen} onChosen={setChosen} first={first} manual={manual} saving={saving} error={error} onSave={() => void save()} onClose={onClose} />
    </Sheet>
  );
}

/** The sheet's contents, from what was loaded: for tests, and the sheet. */
export function CurrencyChoiceBody({
  view,
  chosen,
  onChosen,
  first,
  manual,
  saving,
  error,
  onSave,
  onClose,
}: {
  view: CurrencySettingsView | null;
  chosen: string;
  onChosen: (code: string) => void;
  first: readonly string[];
  manual: readonly { name: string; currency: string }[];
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onClose: () => void;
}) {
  const published = view ? ['EUR', ...Object.keys(view.ecb.rates)] : ['EUR'];
  const mine = [...new Set(first)];
  const ecb = [...new Set(published)].filter((c) => !mine.includes(c)).sort();
  const rest = everyCurrency().filter((c) => !mine.includes(c) && !ecb.includes(c));
  // A choice the lists don't have (a runtime without Intl's list): kept.
  const known = new Set([...mine, ...ecb, ...rest]);
  const priced = new Set(view?.own.map((o) => o.currency) ?? []);
  const unpriceable = view !== null && !published.includes(chosen) && !priced.has(chosen);
  const same = view !== null && view.home === chosen;
  const option = (c: string) => (
    <option key={c} value={c}>
      {c} · {currencyName(c)}
    </option>
  );
  const said = manualText(manual, chosen);
  return (
    <div className="sheet-form currency-choice">
      <label className="field">
        Home currency
        <select value={chosen} onChange={(e) => onChosen(e.target.value)} disabled={saving}>
          {!known.has(chosen) && option(chosen)}
          {mine.length > 0 && <optgroup label="Your accounts’ currencies">{mine.map(option)}</optgroup>}
          <optgroup label="Published daily by the ECB">{ecb.map(option)}</optgroup>
          {rest.length > 0 && <optgroup label="Every other currency">{rest.map(option)}</optgroup>}
        </select>
      </label>
      <p className="panel-note">{choiceText(chosen)}</p>
      {said && <p className="panel-note">{said}</p>}
      {unpriceable && (
        <p className="stale-note">
          The ECB doesn’t publish a rate for {chosen}, so nothing can be converted into it until you set a rate of your own for it, on the Currency card under
          Manage on the Accounts tab.
        </p>
      )}
      {view?.problem && <p className="stale-note">Your currency settings couldn’t be read, so nothing can be saved over them. See the Currency card under Manage on the Accounts tab.</p>}
      <div className="button-pair">
        <button onClick={onSave} disabled={saving || same || !!view?.problem}>
          {saving ? 'Saving…' : `Show my net worth in ${chosen}`}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Not now
        </button>
      </div>
      {same && <p className="panel-note">It is your home currency now.</p>}
      {error && <div className="error">{error}</div>}
      <p className="panel-note">You can change it, or stop converting, at any time on the Currency card. Nothing converted is ever saved, so nothing has to be undone.</p>
    </div>
  );
}

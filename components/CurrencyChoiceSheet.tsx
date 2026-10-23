'use client';

// Choosing the home currency (lib/fx/settings.ts), from the offer on Home or
// the Currency card. Only the person's confirmation here ever writes one: Nya
// never chooses it for them (docs/architecture.md, "Exchange rates"). The
// sheet says exactly what changes in this release: net worth is shown in it,
// converted at the ECB's daily rates; budgets, goals and the Plan stay as
// they are, in the currencies they're shown in now; and a manual account in
// another currency stays in it, its balance converted for the total. Each
// manual account typed in the app is listed with its currency, which the
// person can correct here before confirming (one request per account, the
// currency alone: app/api/manual-accounts); the balance they typed never
// changes its number. Beside a corrected account, the offer to move the
// transactions typed on it too, with the server's count and the plain words
// that it has no undo (RelabelOffer); once saved, the sheet says what moved.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { currencyName, errorOf, everyCurrency, useCurrencySettings, useRelabelCount, type CurrencySettingsView, type RelabelCount } from './currency-state';
import { CORRECTION_KEEPS, RELABEL_KEEPS, relabelKeptText, relabelText, relabelUndoText, relabelledText } from './currency-text';

type Props = {
  open: boolean;
  onClose: () => void;
  /** The sheet's title: the offer's words, or the card's. */
  title?: string;
  /** Chosen when the sheet opens: a suggestion's, or what is chosen now. */
  initial: string | null;
  /** The currencies offered first: the person's accounts', most first. */
  first: readonly string[];
  /** The manual accounts typed in the app, listed with their currency. */
  manual: readonly ManualCurrency[];
  /** Saved: what is chosen now. */
  onSaved: (home: string | null) => void;
};

/** A manual account typed in the app, and the currency it is in. */
export type ManualCurrency = { account_id: string; name: string; currency: string };

const list = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

const optionOf = (c: string) => (
  <option key={c} value={c}>
    {c} · {currencyName(c)}
  </option>
);

/** A currency select's options: `first` (the person's accounts'), then every
 *  other currency Intl knows; `value` kept when neither list has it. */
export function CurrencyOptions({ first, value }: { first: readonly string[]; value: string }) {
  const mine = [...new Set(first)];
  const rest = everyCurrency().filter((c) => !mine.includes(c));
  return (
    <>
      {!mine.includes(value) && !rest.includes(value) && optionOf(value)}
      {mine.length > 0 && <optgroup label="Your accounts’ currencies">{mine.map(optionOf)}</optgroup>}
      {rest.length > 0 && <optgroup label="Every other currency">{rest.map(optionOf)}</optgroup>}
    </>
  );
}

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

/** The offer to move the transactions typed on a manual account with its
 *  corrected currency: the server's count of every row it would move
 *  (`count`, given; else read), those that would stay, and that it has no
 *  undo. Nothing while counting; why not, when they can't be counted. */
export function RelabelOffer({
  account_id,
  from,
  to,
  checked,
  onChange,
  disabled,
  count: given,
}: {
  account_id: string;
  from: string;
  to: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled: boolean;
  count?: RelabelCount;
}) {
  const read = useRelabelCount(given || from === to ? null : { account_id, from, to });
  const count = given ?? read;
  if (!count || from === to) return null;
  if (count.kind === 'counting') return <p className="panel-note">Counting the transactions you entered on it in {from}…</p>;
  if (count.kind === 'error') return <p className="stale-note">{count.message}</p>;
  if (count.moved === 0) return count.kept > 0 ? <p className="panel-note">{relabelKeptText(count.kept, from, to, false)}</p> : null;
  return (
    <>
      <label className="quick-add-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        <span>{relabelText(count.moved, to)}</span>
      </label>
      <p className="panel-note">
        {count.kept > 0 ? `${relabelKeptText(count.kept, from, to)} ` : ''}
        {relabelUndoText(from, to)}
      </p>
    </>
  );
}

/** What the moves made in the sheet did, by account, once saved. */
type Moved = { name: string; text: string };

/** The manual accounts with the corrections made in the sheet. */
export const corrected = (manual: readonly ManualCurrency[], fixes: Readonly<Record<string, string>>): ManualCurrency[] =>
  manual.map((m) => (Object.hasOwn(fixes, m.account_id) ? { ...m, currency: fixes[m.account_id] } : m));

export default function CurrencyChoiceSheet({ open, onClose, title = 'Show your totals in one currency', initial, first, manual, onSaved }: Props) {
  const { load } = useCurrencySettings(open);
  const [chosen, setChosen] = useState<string>(initial ?? first[0] ?? 'EUR');
  const [fixes, setFixes] = useState<Record<string, string>>({});
  // The corrected accounts whose typed transactions move too: only ticked.
  const [moves, setMoves] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Saved with moves: what they did, shown until the person closes the sheet.
  const [moved, setMoved] = useState<Moved[] | null>(null);
  useEffect(() => {
    if (open) setMoved(null);
  }, [open]);
  useEffect(() => {
    if (open) {
      setChosen(initial ?? first[0] ?? 'EUR');
      setFixes({});
      setMoves({});
      setError(null);
    }
  }, [open, initial, first]);

  const view = load.kind === 'ready' ? load.view : null;
  const save = async () => {
    setSaving(true);
    setError(null);
    let changed = false;
    const done: Moved[] = [];
    try {
      // Each correction first, the currency alone, so the choice converts
      // each account from the currency it is really in.
      for (const m of manual) {
        const to = fixes[m.account_id];
        if (!to || to === m.currency) continue;
        const res = await fetch('/api/manual-accounts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id: m.account_id, currency: to, ...(moves[m.account_id] ? { relabel_from: m.currency } : {}) }),
        });
        if (!res.ok) {
          setError(await errorOf(res, `${m.name}’s currency wasn’t saved. Try again.`));
          return;
        }
        changed = true;
        if (moves[m.account_id]) {
          const r = (await res.json().catch(() => null))?.relabelled;
          if (typeof r?.moved === 'number' && typeof r?.kept === 'number') done.push({ name: m.name, text: relabelledText(r, m.currency, to) });
        }
      }
      if (view?.home !== chosen) {
        const res = await fetch('/api/currency', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ home: chosen }) });
        if (!res.ok) {
          setError(await errorOf(res, 'It wasn’t saved. Try again.'));
          return;
        }
      }
      changed = false;
      onSaved(chosen);
      // What the moves did, said before the sheet closes.
      if (done.length > 0) setMoved(done);
      else onClose();
    } catch {
      setError('Nya could not be reached. Check your connection and try again.');
    } finally {
      // Corrections saved before a failure still change what is shown.
      if (changed) onSaved(view?.home ?? null);
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} title={title} onClose={() => !saving && onClose()}>
      {moved ? (
        <MovedBody moved={moved} onClose={onClose} />
      ) : (
        <CurrencyChoiceBody
          view={view}
          chosen={chosen}
          onChosen={setChosen}
          first={first}
          manual={manual}
          fixes={fixes}
          onFix={(id, currency) => setFixes((f) => ({ ...f, [id]: currency }))}
          moves={moves}
          onMove={(id, on) => setMoves((m) => ({ ...m, [id]: on }))}
          saving={saving}
          error={error}
          onSave={() => void save()}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

/** Saved: what moving each account's typed transactions did. */
export function MovedBody({ moved, onClose }: { moved: readonly Moved[]; onClose: () => void }) {
  return (
    <div className="sheet-form">
      <p className="panel-note">Saved.</p>
      {moved.map((m) => (
        <p key={m.name} className="panel-note">
          {moved.length === 1 ? m.text : `${m.name}: ${m.text}`}
        </p>
      ))}
      <div className="button-pair">
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** The sheet's contents, from what was loaded: for tests, and the sheet. */
export function CurrencyChoiceBody({
  view,
  chosen,
  onChosen,
  first,
  manual,
  fixes = {},
  onFix = () => {},
  moves = {},
  onMove = () => {},
  counts,
  saving,
  error,
  onSave,
  onClose,
}: {
  view: CurrencySettingsView | null;
  chosen: string;
  onChosen: (code: string) => void;
  first: readonly string[];
  manual: readonly ManualCurrency[];
  /** Corrections to the manual accounts' currencies, by account id. */
  fixes?: Readonly<Record<string, string>>;
  onFix?: (account_id: string, currency: string) => void;
  /** The corrected accounts whose typed transactions move too. */
  moves?: Readonly<Record<string, boolean>>;
  onMove?: (account_id: string, on: boolean) => void;
  /** The server's counts of what each move would take, by account id, when
   *  already known (tests); else each offer reads its own. */
  counts?: Readonly<Record<string, RelabelCount>>;
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
  // No rates fetched yet (a fresh copy of Nya): nothing is said to be
  // unpublished, only that the rates aren't in yet.
  const fetched = view !== null && view.ecb.date !== null;
  const unpriceable = fetched && !published.includes(chosen) && !priced.has(chosen);
  // The person's currencies nothing can convert yet: left out of the total
  // until they set a rate for each.
  const unrated = fetched ? mine.filter((c) => c !== chosen && !published.includes(c) && !priced.has(c)) : [];
  const same = view !== null && view.home === chosen;
  const accounts = corrected(manual, fixes);
  const fixing = accounts.some((m, i) => m.currency !== manual[i].currency);
  const option = optionOf;
  const said = manualText(accounts, chosen);
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
      {accounts.length > 0 && (
        <div className="manual-currencies">
          <p className="panel-note">
            {accounts.length === 1 ? 'Your manual account is counted in the currency below.' : 'Your manual accounts are counted in the currencies below.'} If one is in
            another, correct it before you confirm: only the currency changes, never the balance you typed.
          </p>
          {accounts.map((m, i) => {
            const was = manual[i].currency;
            return (
              <div key={m.account_id}>
                <label className="field">
                  {m.name}
                  <select value={m.currency} onChange={(e) => onFix(m.account_id, e.target.value)} disabled={saving}>
                    <CurrencyOptions first={[...first, chosen]} value={m.currency} />
                  </select>
                </label>
                {m.currency !== was && (
                  <RelabelOffer
                    account_id={m.account_id}
                    from={was}
                    to={m.currency}
                    checked={!!moves[m.account_id]}
                    onChange={(on) => onMove(m.account_id, on)}
                    disabled={saving}
                    count={counts?.[m.account_id]}
                  />
                )}
              </div>
            );
          })}
          {fixing && (
            <p className="panel-note">
              Correcting an account changes only its currency.{' '}
              {accounts.some((m, i) => m.currency !== manual[i].currency && moves[m.account_id]) ? RELABEL_KEEPS : CORRECTION_KEEPS}
            </p>
          )}
        </div>
      )}
      {unpriceable && (
        <p className="stale-note">
          The ECB doesn’t publish a rate for {chosen}, so nothing can be converted into it until you set a rate of your own for it, on the Currency card under
          Manage on the Accounts tab.
        </p>
      )}
      {!unpriceable && unrated.length > 0 && (
        <p className="stale-note">
          The ECB doesn’t publish {list(unrated)}, so your accounts in {unrated.length === 1 ? 'it' : 'them'} are left out of the total until you set a rate of your
          own for {unrated.length === 1 ? 'it' : 'each'}, on the Currency card under Manage on the Accounts tab.
        </p>
      )}
      {view !== null && !fetched && (
        <p className="stale-note">Nya doesn’t have the ECB’s rates yet, so nothing in another currency can be converted until it has fetched them (it does each evening).</p>
      )}
      {view?.problem && <p className="stale-note">Your currency settings couldn’t be read, so nothing can be saved over them. See the Currency card under Manage on the Accounts tab.</p>}
      <div className="button-pair">
        <button onClick={onSave} disabled={saving || (same && !fixing) || !!view?.problem}>
          {saving ? 'Saving…' : same && fixing ? 'Save the currencies' : `Show my net worth in ${chosen}`}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Not now
        </button>
      </div>
      {same && !fixing && <p className="panel-note">It is your home currency now.</p>}
      {error && <div className="error">{error}</div>}
      <p className="panel-note">You can change it, or stop converting, at any time on the Currency card. Nya’s server never keeps a converted figure, so nothing has to be undone.</p>
    </div>
  );
}

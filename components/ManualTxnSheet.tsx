'use client';

// The quick-add form for a transaction on a manual account (cash, a bank Plaid
// can't reach), and the same form to edit or delete one. Built for a phone:
// the amount first, on the decimal keypad, with Spent or Received instead of
// a minus sign (that keypad has none); today's date and the last account used
// already filled in; the category taken from the last time the same payee
// was entered.
//
// A manual account's balance is what was typed, and adding a transaction
// doesn't change it. The form says so, and offers to update it as well, as an
// explicit choice showing the balance before and after: the route records it
// as the account's Update form would, and only from the balance shown here to
// the one it says (app/api/manual-transactions). Editing or deleting never
// moves it.
//
// SENT ONCE OR MORE. The new row's id is made when the form opens, and every
// try sends it, so tapping Add again after an answer that never arrived
// finds the row already saved rather than adding it twice, or moving the
// balance twice. If the form was changed before that second tap, the saved
// row is then changed to match it, unless the balance moved (or was to move)
// with it and the amount changed: the server then says what was saved, and
// the form leaves it so (app/api/manual-transactions).

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { categoryOptions, type Txn } from './MonthBreakdown';
import type { TxnSaved } from './transaction-edits';
import { isOwedType } from '@/lib/balance';
import { formatMoney } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import {
  balanceAfter,
  isCurrencyCode,
  newManualTxnId,
  parseAmountInput,
  DEFAULT_CURRENCY,
  MAX_NOTE_CHARS,
  MAX_PAYEE_CHARS,
} from '@/lib/manual-txn-input';

/** What the form is open on: a new transaction (on an account, when opened
 *  from its card), or one to edit. */
export type ManualTxnTarget = { mode: 'add'; account_id: string | null } | { mode: 'edit'; txn: Txn };

/** What the form needs of the dashboard's institutions: the manual ones. */
export type SheetInstitution = {
  institution_name: string;
  manual?: boolean;
  accounts: { account_id: string; name: string; type: string; balance: number | null; currency: string | null; hidden?: boolean }[];
};

type Account = SheetInstitution['accounts'][number] & { institution_name: string };

type Draft = {
  /** A new row's id, made when the form opened; null when editing. */
  id: string | null;
  direction: 'out' | 'in';
  amount: string;
  currency: string;
  name: string;
  date: string;
  account_id: string;
  category: string;
  note: string;
  updateBalance: boolean;
};

// The account the last transaction went on, on this device only: most cash
// is entered against the same one. A convenience; without it the form starts
// on the first account.
const LAST_ACCOUNT_KEY = 'nya:quick-add-account';
function readLastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}
function rememberAccount(account_id: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, account_id);
  } catch {
    // Storage unavailable: the next form starts on the first account.
  }
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'MXN', 'JPY', 'AUD', 'CHF', 'INR', 'CNY'];

const label = (a: Account) => (a.institution_name && a.institution_name !== a.name ? `${a.institution_name} · ${a.name}` : a.name);

async function send(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
  const res = await fetch('/api/manual-transactions', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { res, data: await res.json().catch(() => null) };
}

type Fields = { date: string; amount: number | null; currency: string; name: string; category: string | null; note: string | null };

/** Whether a saved row isn't what the form says now (the server keeps a
 *  payee's spaces single). */
function differs(t: Txn, fields: Fields, account_id: string): boolean {
  return (
    t.date !== fields.date ||
    t.amount !== fields.amount ||
    t.iso_currency_code !== fields.currency ||
    t.name !== fields.name.replace(/\s+/g, ' ') ||
    (t.category ?? null) !== fields.category ||
    (t.note ?? null) !== fields.note ||
    t.account_id !== account_id
  );
}

export default function ManualTxnSheet({
  target,
  institutions,
  txns,
  onClose,
  onSaved,
  onBalanceStale,
}: {
  target: ManualTxnTarget | null;
  institutions: SheetInstitution[];
  /** The loaded transactions: the categories to offer, and past payees. */
  txns: Txn[] | null;
  onClose: () => void;
  /** After any save or delete: the row as saved, or the one deleted, and
   *  `balanceChanged` when the balance moved too. */
  onSaved: (result: TxnSaved) => void;
  /** The balance changed since the dashboard loaded it: reload it. */
  onBalanceStale: () => void;
}) {
  const accounts = useMemo<Account[]>(
    () =>
      institutions
        .filter((i) => i.manual)
        .flatMap((i) => i.accounts.filter((a) => !a.hidden).map((a) => ({ ...a, institution_name: i.institution_name }))),
    [institutions]
  );
  const categories = useMemo(() => categoryOptions(txns), [txns]);
  // Payees entered before, newest first, for the payee field to suggest.
  const pastRows = useMemo(() => (txns ?? []).filter((t) => t.source), [txns]);
  const payees = useMemo(() => [...new Set(pastRows.map((t) => t.name))].slice(0, 50), [pastRows]);

  // What the form shows: kept while the drawer slides out, so it doesn't
  // empty on the way.
  const [shown, setShown] = useState<ManualTxnTarget | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Saved, but with something to read first (the balance didn't update).
  const [done, setDone] = useState(false);

  // A fresh draft each time it opens. Only on opening: balances reloading in
  // the background must not reset what is being typed.
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setError('');
    setConfirmDelete(false);
    setDone(false);
    setSaving(false);
    if (target.mode === 'edit') {
      const t = target.txn;
      setCategoryTouched(true);
      setDraft({
        id: null,
        direction: t.amount > 0 ? 'out' : 'in',
        amount: String(Math.abs(t.amount)),
        currency: t.iso_currency_code ?? DEFAULT_CURRENCY,
        name: t.name,
        date: t.date,
        account_id: t.account_id ?? '',
        category: t.category ?? '',
        note: t.note ?? '',
        updateBalance: false,
      });
      return;
    }
    setCategoryTouched(false);
    const last = readLastAccount();
    const start = target.account_id ?? (accounts.some((a) => a.account_id === last) ? last : accounts[0]?.account_id) ?? '';
    setDraft({
      id: newManualTxnId(),
      direction: 'out',
      amount: '',
      currency: DEFAULT_CURRENCY,
      name: '',
      date: localDate(),
      account_id: start,
      category: '',
      note: '',
      updateBalance: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const edit = shown?.mode === 'edit' ? shown.txn : null;
  // An edited row's own account is always offered, so the form can never move
  // it by showing another one as chosen.
  const options = useMemo<Account[]>(() => {
    if (!edit?.account_id || accounts.some((a) => a.account_id === edit.account_id)) return accounts;
    return [...accounts, { account_id: edit.account_id, name: edit.account_name, institution_name: edit.institution_name, type: '', balance: null, currency: null }];
  }, [accounts, edit]);

  // Nothing to show until it has first opened.
  if (!draft) return null;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const currency = draft.currency.trim().toUpperCase();
  // Read, and rounded, in the currency's own units (a yen has no cents).
  const amount = parseAmountInput(draft.amount, isCurrencyCode(currency) ? currency : DEFAULT_CURRENCY);
  const signed = amount === null ? null : draft.direction === 'out' ? amount : -amount;
  // Something that happened: today at the latest (the server allows a day
  // more, for a clock in another time zone, and no further).
  const future = !!draft.date && draft.date > localDate();
  const account = options.find((a) => a.account_id === draft.account_id) ?? null;
  const owed = account ? isOwedType(account.type) : false;
  // The balance can follow only a new transaction in the balance's own
  // currency (manual balances are in dollars, lib/manual.ts).
  const balance = !edit && account && account.balance !== null && currency === DEFAULT_CURRENCY && signed !== null ? account.balance : null;
  const after = balance === null ? null : balanceAfter(balance, signed!, owed);
  const negativeOwed = after !== null && owed && after < 0;
  const updating = draft.updateBalance && after !== null && !negativeOwed;
  const ready = signed !== null && !!draft.name.trim() && !!draft.date && !future && !!account && isCurrencyCode(currency);
  const busy = saving || done;
  const money = (n: number) => formatMoney(n, DEFAULT_CURRENCY);

  /** A typed payee seen before brings its last category, until one is picked. */
  function setName(name: string) {
    const known = categoryTouched ? null : pastRows.find((t) => t.name.toLowerCase() === name.trim().toLowerCase() && t.category);
    setDraft({ ...draft!, name, ...(known ? { category: known.category! } : {}) });
  }

  async function save() {
    if (!ready || busy) return;
    setSaving(true);
    setError('');
    const fields = { date: draft!.date, amount: signed, currency, name: draft!.name.trim(), category: draft!.category || null, note: draft!.note.trim() || null };
    try {
      const { res, data } = edit
        ? await send('PATCH', {
            id: edit.transaction_id,
            // Where the list shows it, so only that account's rows are read.
            account_id: edit.account_id,
            ...fields,
            // Only a change of account moves it.
            ...(draft!.account_id !== edit.account_id ? { move_to: draft!.account_id } : {}),
          })
        : await send('POST', {
            id: draft!.id,
            account_id: draft!.account_id,
            ...fields,
            ...(updating ? { update_balance: { from: balance, to: after } } : {}),
          });
      if (res.ok) {
        let transaction: Txn | undefined = data?.transaction;
        // Already saved by an earlier try whose answer was lost: if the form
        // was changed since, the saved row is changed to match it.
        if (!edit && data?.added === false && transaction && differs(transaction, fields, draft!.account_id)) {
          const fix = await send('PATCH', {
            id: transaction.transaction_id,
            account_id: transaction.account_id,
            ...fields,
            ...(draft!.account_id !== transaction.account_id ? { move_to: draft!.account_id } : {}),
          });
          if (!fix.res.ok) {
            setError(fix.data?.error ?? 'It was saved as first sent, but the changes since could not be. Edit it from the list.');
            setDone(true);
            onSaved({ balanceChanged: data?.balance_updated === true, transaction });
            return;
          }
          transaction = fix.data?.transaction ?? transaction;
        }
        rememberAccount(draft!.account_id);
        onSaved({ balanceChanged: data?.balance_updated === true, transaction });
        onClose();
        return;
      }
      setError(data?.error ?? 'Could not save. Please try again.');
      // Saved (by this send or an earlier one), but not all as asked: say so,
      // and offer nothing that would add it again.
      if (data?.saved === true && data?.transaction) {
        setDone(true);
        onSaved({ balanceChanged: data.balance_updated === true, transaction: data.transaction });
      }
      // The balance isn't what this form showed: show what it is now (a
      // balance that moved is reloaded by onSaved already).
      if (res.status === 409 && data?.balance_updated !== true && (typeof data?.balance === 'number' || data?.saved === true)) onBalanceStale();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!edit || busy) return;
    setSaving(true);
    setError('');
    try {
      const { res, data } = await send('DELETE', { id: edit.transaction_id, account_id: edit.account_id });
      if (res.ok) {
        onSaved({ balanceChanged: false, removed: edit.transaction_id });
        onClose();
        return;
      }
      setError(data?.error ?? 'Could not delete. Please try again.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  const name = account?.name ?? 'the account';
  let balanceNote: string;
  if (edit) balanceNote = `Editing or deleting a transaction doesn't change ${name}'s balance. Update that from the account itself.`;
  else if (negativeOwed) balanceNote = `This would take the amount owed on ${name} below zero, so update that from the account itself.`;
  else if (account && currency !== DEFAULT_CURRENCY && isCurrencyCode(currency))
    balanceNote = `${name}'s balance is kept in ${DEFAULT_CURRENCY}, so a transaction in ${currency} leaves it as it is.`;
  else balanceNote = `Adding a transaction doesn't change ${name}'s balance, which stays what you typed${after !== null ? '. Tick the box to update it too.' : '.'}`;

  return (
    <Sheet open={!!target} title={edit ? 'Edit transaction' : 'Add a transaction'} onClose={() => !saving && onClose()}>
      <div className="button-pair quick-add-choice" role="group" aria-label="Money out or in" style={{ marginTop: 0 }}>
        <button className="secondary" aria-pressed={draft.direction === 'out'} disabled={busy} onClick={() => set({ direction: 'out' })}>
          Spent
        </button>
        <button className="secondary" aria-pressed={draft.direction === 'in'} disabled={busy} onClick={() => set({ direction: 'in' })}>
          Received
        </button>
      </div>
      <div className="sheet-form">
        <div className="quick-add-pair">
          <label className="field quick-add-amount">
            Amount
            <input
              // A text field on the decimal keypad: "12,50" from a comma
              // locale is read as meant (lib/manual-txn-input.ts).
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="next"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder="0.00"
              disabled={busy}
            />
          </label>
          <label className="field quick-add-currency">
            Currency
            <input
              value={draft.currency}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
              maxLength={3}
              list="quick-add-currencies"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        </div>
        <datalist id="quick-add-currencies">
          {CURRENCIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label className="field">
          {draft.direction === 'out' ? 'Paid to' : 'Received from'}
          <input
            value={draft.name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_PAYEE_CHARS}
            list="quick-add-payees"
            autoCapitalize="words"
            enterKeyHint="next"
            placeholder="e.g. Farmers market"
            disabled={busy}
          />
        </label>
        <datalist id="quick-add-payees">
          {payees.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <label className="field">
          Date
          <input type="date" value={draft.date} max={localDate()} onChange={(e) => set({ date: e.target.value })} disabled={busy} />
        </label>
        {future && <div className="error">The date can&apos;t be in the future.</div>}
        <label className="field">
          Account
          <select value={draft.account_id} onChange={(e) => set({ account_id: e.target.value, updateBalance: false })} disabled={busy}>
            {options.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {label(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Category
          <select
            value={draft.category}
            onChange={(e) => {
              setCategoryTouched(true);
              set({ category: e.target.value });
            }}
            disabled={busy}
          >
            <option value="">No category</option>
            {[...new Set([...categories, ...(draft.category ? [draft.category] : [])])].sort().map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        {draft.direction === 'in' && !draft.category.startsWith('transfer') && (
          <p className="panel-note" style={{ margin: 0 }}>
            Cash taken out of another of your accounts? Choose transfer in, so it isn&apos;t counted as income.
          </p>
        )}
        <label className="field">
          Note
          <input value={draft.note} onChange={(e) => set({ note: e.target.value })} maxLength={MAX_NOTE_CHARS} placeholder="Optional" disabled={busy} />
        </label>
      </div>

      {/* Not offered at all when it would take an amount owed below zero:
          the note below says why. */}
      {!edit && after !== null && account && balance !== null && !negativeOwed && (
        <label className="quick-add-check">
          <input type="checkbox" checked={updating} disabled={busy} onChange={(e) => set({ updateBalance: e.target.checked })} />
          <span>
            Also update {account.name}&apos;s {owed ? 'amount owed' : 'balance'}, from {money(balance)} to {money(after)}
          </span>
        </label>
      )}
      <p className="panel-note">{balanceNote}</p>

      {error && <div className="error">{error}</div>}

      {done ? (
        <div className="button-pair" style={{ marginTop: 16 }}>
          <button onClick={onClose}>Close</button>
        </div>
      ) : confirmDelete ? (
        <>
          <p className="panel-note">Delete this transaction? It can&apos;t be brought back.</p>
          <div className="button-pair" style={{ marginTop: 12 }}>
            <button className="secondary" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Keep it
            </button>
            <button className="danger" onClick={remove} disabled={saving}>
              {saving ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button onClick={save} disabled={!ready || saving}>
              {saving ? 'Saving…' : edit ? 'Save' : amount !== null ? `Add ${formatMoney(amount, isCurrencyCode(currency) ? currency : null)}` : 'Add'}
            </button>
          </div>
          {edit && (
            <button className="danger-outline" style={{ marginTop: 12 }} onClick={() => setConfirmDelete(true)} disabled={saving}>
              Delete transaction
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}

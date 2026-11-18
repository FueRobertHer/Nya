'use client';

// The quick-add form for a transaction on a manual account (cash, a bank Plaid
// can't reach), and the same form to edit or delete one. Built for a phone:
// the amount first, on the decimal keypad, with Spent or Received instead of
// a minus sign (that keypad has none); today's date and the last account used
// already filled in; the category taken from the last time the same payee
// was entered. The category is one of yours (lib/categories.ts), chosen from
// the list by group (components/CategoryPicker.tsx) and sent by id; with your
// categories not loaded, the form offers the words in use, as before.
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
//
// THE ROW'S OWN, NEVER A RULE'S. Rules apply on read (lib/txn-layers.ts): one
// can file a row that has no category of its own, or name an imported or
// SimpleFIN row, and the list shows that. The form edits what is stored, so it
// starts from the row's own category and name (editStart), and an edit sends
// the name or the category only when the person changed it (changedFields):
// saving a note on a row a rule files never makes the rule's category the
// row's, which turning the rule off would then no longer undo.
//
// AFTER SAVE (docs/design/guidelines.md#after-save). Its buttons sit in the
// sheet's footer, a refusal beside them. Added from Activity, edited or
// deleted, it closes on the list, which shows the change. Added from an
// account's sheet, the screen behind doesn't list it, so the sheet says what
// it added, with focus on the line, and where it is changed or deleted. Its
// Undo deletes it, which puts back exactly what was there, so it is offered
// only when the balance didn't move with it: deleting never moves a balance
// back, so that one is said to be updated from the account instead.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import ActionRows from './ActionRows';
import { Masked } from './HideAmounts';
import { deleteFile, filesOn } from './attachment-client';
import { categoryOptions, nameForRules, type Txn } from './MonthBreakdown';
import CategoryPicker from './CategoryPicker';
import { categoryById, choiceText, groupOf, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { bankRows } from '@/lib/split-rows';
import type { TxnSaved } from './transaction-edits';
import { isOwedType } from '@/lib/balance';
import { formatMoney, hideAmountsIn } from '@/lib/format';
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
import { Notice } from './TotalCaveats';
import FieldError from './FieldError';

/** What the form is open on: a new transaction (on an account, when opened
 *  from its card), or one to edit. */
export type ManualTxnTarget = { mode: 'add'; account_id: string | null } | { mode: 'edit'; txn: Txn };

/** What the form needs of the dashboard's institutions: the manual ones (not
 *  those SimpleFIN feeds, `manual` too, whose rows are the bank's). */
export type SheetInstitution = {
  institution_name: string;
  manual?: boolean;
  connector?: string;
  accounts: { account_id: string; name: string; type: string; balance: number | null; currency: string | null; hidden?: boolean }[];
};

type Account = SheetInstitution['accounts'][number] & { institution_name: string };

/** What an add from an account's sheet saved, said once it has: the row,
 *  where it went, and the balance's move when it moved too (then no Undo). */
type Added = {
  id: string;
  account_id: string;
  account: string;
  owed: boolean;
  what: { amount: number; currency: string; direction: 'out' | 'in'; name: string };
  balance: { from: number; to: number; currency: string } | null;
  undone: boolean;
};

/** "$12.50 spent at Corner Store", "$40.00 received from Sam". */
const addedText = (w: Added['what']) => `${formatMoney(w.amount, w.currency)} ${w.direction === 'out' ? 'spent at' : 'received from'} ${w.name}`;

type Draft = {
  /** A new row's id, made when the form opened; null when editing. */
  id: string | null;
  direction: 'out' | 'in';
  amount: string;
  currency: string;
  name: string;
  date: string;
  account_id: string;
  /** The category chosen: one of yours by id, '' for none. */
  category_id: string;
  /** With your categories not loaded: its words, '' for none. */
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

export type Fields = { date: string; amount: number | null; currency: string; name: string; note: string | null } & ({ category_id: string | null; category: string | null } | { category: string | null });

/** Whether a saved row isn't what the form says now (the server keeps a
 *  payee's spaces single). */
function differs(t: Txn, fields: Fields, account_id: string): boolean {
  const category = 'category_id' in fields ? (t.category_name === null ? null : (t.category_id ?? null)) !== fields.category_id : (t.category ?? null) !== fields.category;
  return (
    t.date !== fields.date ||
    t.amount !== fields.amount ||
    t.iso_currency_code !== fields.currency ||
    t.name !== fields.name.replace(/\s+/g, ' ') ||
    category ||
    (t.note ?? null) !== fields.note ||
    t.account_id !== account_id
  );
}

/** The category a row is filed under, for the form: none when it says none. */
const chosenOf = (t: Txn) => (t.category_name === null ? '' : (t.category_id ?? ''));

/** What the form starts from on a row to edit: its own name and category
 *  (see THE ROW'S OWN, NEVER A RULE'S): a rule's category is none of the
 *  row's, and a rule's name isn't its name. */
export function editStart(t: Txn): { name: string; category_id: string; category: string } {
  return {
    name: nameForRules(t),
    category_id: t.category_by_rule ? '' : chosenOf(t),
    category: t.category_by_rule ? '' : (t.category ?? ''),
  };
}

/** A payee as the server keeps it: its spaces single, none at either end. */
const payeeKey = (name: string) => name.replace(/\s+/g, ' ').trim();

/** What an edit sends of the form's fields: all of them, but the name and
 *  the category only when the person changed them from where the form
 *  started (editStart). Names are compared as the server keeps them, so a
 *  name stored with repeated spaces, left as it was, isn't sent as a change
 *  (which would make it the person's own, ManualTxn.named). */
export function changedFields(fields: Fields, start: ReturnType<typeof editStart>): Partial<Fields> {
  const out: Record<string, unknown> = { ...fields };
  if (payeeKey(fields.name) === payeeKey(start.name)) delete out.name;
  if ('category_id' in fields) {
    if ((fields.category_id ?? '') === start.category_id) {
      delete out.category_id;
      delete out.category;
    }
  } else if ((fields.category ?? '') === start.category) delete out.category;
  return out as Partial<Fields>;
}

/** The rows a payee typed is matched against, newest first: each transaction
 *  entered or imported, as it was, a split one whole under its own category,
 *  never a group's row, whose name is the group's (#39, lib/split-rows.ts
 *  bankRows). */
export function pastPayeeRows(txns: readonly Txn[] | null): Txn[] {
  return bankRows(txns ?? []).filter((t) => t.source);
}

export default function ManualTxnSheet({
  target,
  institutions,
  txns,
  taxonomy = null,
  onClose,
  onSaved,
  onBalanceStale,
}: {
  target: ManualTxnTarget | null;
  institutions: SheetInstitution[];
  /** The loaded transactions: past payees, and with your categories not
   *  loaded, the words to offer. */
  txns: Txn[] | null;
  /** Your categories (components/categories-state.ts), the list to choose
   *  from. */
  taxonomy?: Taxonomy | null;
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
        .filter((i) => i.manual && !i.connector)
        .flatMap((i) => i.accounts.filter((a) => !a.hidden).map((a) => ({ ...a, institution_name: i.institution_name }))),
    [institutions]
  );
  const categories = useMemo(() => categoryOptions(txns), [txns]);
  // Payees entered before, newest first, for the payee field to suggest.
  const pastRows = useMemo(() => pastPayeeRows(txns), [txns]);
  const payees = useMemo(() => [...new Set(pastRows.map((t) => t.name))].slice(0, 50), [pastRows]);

  // What the form shows: kept while the drawer slides out, so it doesn't
  // empty on the way.
  const [shown, setShown] = useState<ManualTxnTarget | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dateError = useId();
  // Its receipts and documents (#47), asked about when it is deleted: kept,
  // not on a transaction, unless the person chooses to delete them too.
  const [files, setFiles] = useState<string[] | null>(null);
  const [alsoFiles, setAlsoFiles] = useState(false);
  // Saved, but with something to read first (the balance didn't update).
  const [done, setDone] = useState(false);
  // Added from an account's sheet: said, with its Undo when there is one.
  const [added, setAdded] = useState<Added | null>(null);
  const [undoError, setUndoError] = useState('');
  const doneLine = useRef<HTMLDivElement>(null);
  const errorId = useId();

  // A fresh draft each time it opens. Only on opening: balances reloading in
  // the background must not reset what is being typed.
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setError('');
    setConfirmDelete(false);
    setFiles(null);
    setAlsoFiles(false);
    setDone(false);
    setAdded(null);
    setUndoError('');
    setSaving(false);
    if (target.mode === 'edit') {
      const t = target.txn;
      const start = editStart(t);
      setCategoryTouched(true);
      setDraft({
        id: null,
        direction: t.amount > 0 ? 'out' : 'in',
        amount: String(Math.abs(t.amount)),
        currency: t.iso_currency_code ?? DEFAULT_CURRENCY,
        name: start.name,
        date: t.date,
        account_id: t.account_id ?? '',
        category_id: start.category_id,
        category: start.category,
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
      // The account's own: the one chosen for it, or kept from a connector
      // (US dollars when it names none).
      currency: accounts.find((a) => a.account_id === start)?.currency ?? DEFAULT_CURRENCY,
      name: '',
      date: localDate(),
      account_id: start,
      category_id: '',
      category: '',
      note: '',
      updateBalance: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  // What it added, and then its undoing, said with focus on the line.
  useEffect(() => {
    if (added) doneLine.current?.focus();
  }, [added]);

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
  // currency (the account's, lib/manual.ts: US dollars when it names none).
  const keptIn = account?.currency ?? DEFAULT_CURRENCY;
  const balance = !edit && account && account.balance !== null && currency === keptIn && signed !== null ? account.balance : null;
  const after = balance === null ? null : balanceAfter(balance, signed!, owed);
  const negativeOwed = after !== null && owed && after < 0;
  const updating = draft.updateBalance && after !== null && !negativeOwed;
  const ready = signed !== null && !!draft.name.trim() && !!draft.date && !future && !!account && isCurrencyCode(currency);
  const busy = saving || done;
  const money = (n: number) => formatMoney(n, keptIn);

  /** A typed payee seen before (as shown, or as it was before a rule named
   *  it) brings its last category, until one is picked: one it was given,
   *  never one a rule files it under (the rule files the new one too, while
   *  it matches). */
  function setName(name: string) {
    const typed = name.trim().toLowerCase();
    const known = categoryTouched
      ? null
      : pastRows.find((t) => (t.name.toLowerCase() === typed || nameForRules(t).toLowerCase() === typed) && t.category && !t.category_by_rule);
    setDraft({ ...draft!, name, ...(known ? { category: known.category!, category_id: chosenOf(known) } : {}) });
  }

  // The chosen category's kind, to say when money in isn't a transfer.
  const chosen = taxonomy && draft.category_id ? categoryById(indexTaxonomy(taxonomy), draft.category_id) : null;
  const transferChosen = taxonomy ? !!chosen && groupOf(indexTaxonomy(taxonomy), chosen).kind === 'transfer' : draft.category.startsWith('transfer');

  async function save() {
    if (!ready || busy) return;
    setSaving(true);
    setError('');
    const fields: Fields = {
      date: draft!.date,
      amount: signed,
      currency,
      name: draft!.name.trim(),
      // By id, and its words beside it (choiceText), which this release
      // ignores when the id is there: a page still open after a rollback
      // posts to the release before, which reads only the words.
      ...(taxonomy ? { category_id: draft!.category_id || null, category: chosen ? choiceText(chosen) : null } : { category: draft!.category || null }),
      note: draft!.note.trim() || null,
    };
    try {
      const { res, data } = edit
        ? await send('PATCH', {
            id: edit.transaction_id,
            // Where the list shows it, so only that account's rows are read.
            account_id: edit.account_id,
            ...changedFields(fields, editStart(edit)),
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
        // Added from an account's sheet: nothing behind lists it, so say so here.
        if (!edit && shown?.mode === 'add' && shown.account_id !== null && transaction) {
          const on = options.find((a) => a.account_id === transaction!.account_id) ?? account;
          setAdded({
            id: transaction.transaction_id,
            account_id: transaction.account_id ?? draft!.account_id,
            account: on?.name ?? 'the account',
            owed: on ? isOwedType(on.type) : false,
            what: { amount: amount!, currency, direction: draft!.direction, name: fields.name },
            balance:
              data?.balance_updated === true && balance !== null ? { from: balance, to: typeof data?.balance === 'number' ? data.balance : after!, currency: keptIn } : null,
            undone: false,
          });
          return;
        }
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

  /** Takes back what it just added: deleted, as if never added. */
  async function undo() {
    if (!added || saving) return;
    setSaving(true);
    setUndoError('');
    try {
      const { res, data } = await send('DELETE', { id: added.id, account_id: added.account_id });
      if (res.ok) {
        onSaved({ balanceChanged: false, removed: added.id });
        setAdded({ ...added, undone: true });
        return;
      }
      setUndoError(data?.error ?? 'Could not undo it. Please try again.');
    } catch {
      setUndoError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  }

  /** Asked to delete: the files on it read first, to offer deleting them. */
  function askDelete() {
    setConfirmDelete(true);
    setFiles(null);
    setAlsoFiles(false);
    if (!edit || edit.attached !== true) return;
    const id = edit.transaction_id;
    void filesOn([id]).then((out) => {
      if (!('error' in out)) setFiles(out.files.filter((f) => f.place.on === 'transaction' && f.place.transaction_id === id).map((f) => f.id));
    });
  }

  async function remove() {
    if (!edit || busy) return;
    setSaving(true);
    setError('');
    try {
      const { res, data } = await send('DELETE', { id: edit.transaction_id, account_id: edit.account_id });
      if (res.ok) {
        onSaved({ balanceChanged: false, removed: edit.transaction_id });
        // Its files after it: one that can't be deleted stays, not on a
        // transaction, under Receipts and documents.
        if (alsoFiles && files && files.length > 0) {
          let left = 0;
          for (const id of files) if ('error' in (await deleteFile(id))) left++;
          if (left > 0) {
            setError(
              `The transaction is deleted, but ${left === 1 ? 'one of its files' : `${left} of its files`} couldn’t be: ${left === 1 ? 'it is' : 'they are'} under Receipts and documents in Settings, Your data and privacy, not on a transaction.`
            );
            setDone(true);
            return;
          }
        }
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
  else if (account && currency !== keptIn && isCurrencyCode(currency))
    balanceNote = `${name}'s balance is kept in ${keptIn}, so a transaction in ${currency} leaves it as it is.`;
  else balanceNote = `Adding a transaction doesn't change ${name}'s balance, which stays what you typed${after !== null ? '. Tick the box to update it too.' : '.'}`;

  if (added) {
    const what = addedText(added.what);
    const kept = added.owed ? 'amount owed' : 'balance';
    const moved = added.balance
      ? ` ${added.account}’s ${kept} moved from ${formatMoney(added.balance.from, added.balance.currency)} to ${formatMoney(added.balance.to, added.balance.currency)} with it.`
      : '';
    return (
      <Sheet
        open={!!target}
        title="Add a transaction"
        onClose={() => !saving && onClose()}
        footer={
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Done
          </button>
        }
      >
        <div className="stack">
          <Notice level="done" role="status" ref={doneLine} tabIndex={-1}>
            <Masked>{added.undone ? `Undone: ${what} is no longer on ${added.account}.` : `Added ${what} to ${added.account}.${moved}`}</Masked>
          </Notice>
          {!added.undone && !added.balance && (
            <button type="button" className="btn ghost" onClick={() => void undo()} disabled={saving} aria-describedby={undoError ? errorId : undefined}>
              {saving ? 'Undoing…' : 'Undo'}
            </button>
          )}
          {undoError && (
            <div id={errorId}>
              <Notice level="critical" role="alert">
                <Masked>{hideAmountsIn(undoError)}</Masked>
              </Notice>
            </div>
          )}
          {!added.undone && (
            <p className="helper">
              {added.balance
                ? `It’s in Activity, where you can edit or delete it. Deleting it leaves the ${kept} as it is now: update that from the account.`
                : 'It’s in Activity, where you can edit or delete it.'}
            </p>
          )}
        </div>
      </Sheet>
    );
  }

  // A refusal, beside the buttons it came from; once saved with something to
  // read first, it stays in the body as what came of it.
  const failed = error && !done ? errorId : undefined;
  const footer = done ? (
    <button type="button" className="btn" onClick={onClose}>
      Close
    </button>
  ) : (
    <>
      {failed && (
        <div className="sheet-footer-note" id={errorId}>
          {/* The server's words can name a balance (one changed since the form opened). */}
          <Notice level="critical" role="alert">
            <Masked>{hideAmountsIn(error)}</Masked>
          </Notice>
        </div>
      )}
      {confirmDelete ? (
        <>
          <button type="button" className="btn secondary" onClick={() => setConfirmDelete(false)} disabled={saving}>
            Keep it
          </button>
          <button type="button" className="btn danger" onClick={remove} disabled={saving} aria-describedby={failed}>
            {saving ? 'Deleting…' : 'Delete'}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={save} disabled={!ready || saving} aria-describedby={failed}>
            <Masked>{saving ? 'Saving…' : edit ? 'Save' : amount !== null ? `Add ${formatMoney(amount, isCurrencyCode(currency) ? currency : null)}` : 'Add'}</Masked>
          </button>
        </>
      )}
    </>
  );

  return (
    <Sheet open={!!target} title={edit ? 'Edit transaction' : 'Add a transaction'} onClose={() => !saving && onClose()} footer={footer}>
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
        {edit?.name_before_rules !== undefined && draft.name === edit.name_before_rules && (
          <p className="panel-note" style={{ margin: 0 }}>
            A rule shows it as “{edit.name}”. A name you give it here is its own, and no rule renames it.
          </p>
        )}
        <label className="field">
          Date
          <input
            type="date"
            value={draft.date}
            max={localDate()}
            onChange={(e) => set({ date: e.target.value })}
            aria-invalid={future}
            aria-describedby={future ? dateError : undefined}
            disabled={busy}
          />
        </label>
        {future && <FieldError id={dateError}>The date can&apos;t be in the future.</FieldError>}
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
          {taxonomy ? (
            <CategoryPicker
              taxonomy={taxonomy}
              className=""
              value={draft.category_id}
              none="No category"
              onChange={(id) => {
                setCategoryTouched(true);
                set({ category_id: id });
              }}
              disabled={busy}
            />
          ) : (
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
          )}
        </label>
        {edit?.category_by_rule && (taxonomy ? draft.category_id === '' : draft.category === '') && (
          <p className="panel-note" style={{ margin: 0 }}>
            A rule files it under {edit.category_name ?? edit.category} while it has no category of its own.
          </p>
        )}
        {draft.direction === 'in' && !transferChosen && (
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
            Also update {account.name}&apos;s {owed ? 'amount owed' : 'balance'}, from <Masked>{money(balance)}</Masked> to <Masked>{money(after)}</Masked>
          </span>
        </label>
      )}
      <p className="panel-note">
        <Masked>{balanceNote}</Masked>
      </p>

      {/* Saved, but with something to read first: what came of it. Its
          words can name a balance (one changed since the form opened). */}
      {error && done && (
        <Notice level="critical" role="alert">
          <Masked>{hideAmountsIn(error)}</Masked>
        </Notice>
      )}

      {done ? null : confirmDelete ? (
        <>
          <p className="panel-note">Delete this transaction? It can&apos;t be brought back.</p>
          {files && files.length > 0 && (
            <>
              <label className="quick-add-check">
                <input type="checkbox" checked={alsoFiles} onChange={(e) => setAlsoFiles(e.target.checked)} disabled={saving} />
                <span>{files.length === 1 ? 'Also delete the receipt or document on it' : `Also delete the ${files.length} receipts and documents on it`}</span>
              </label>
              {!alsoFiles && <p className="panel-note">Kept, they stay under Receipts and documents in Settings, Your data and privacy, not on a transaction.</p>}
            </>
          )}
        </>
      ) : (
        edit && (
          // Deleting it, from its actions: last, asking first (ActionRows).
          <ActionRows rows={[{ key: 'delete', title: 'Delete transaction', sub: 'Asks first.', opens: true, neg: true, onSelect: () => !saving && askDelete() }]} />
        )
      )}
    </Sheet>
  );
}

'use client';

// The sheets that add, update and delete a manual account (an institution
// Plaid can't reach, its balance typed), moved out of the dashboard so they
// own their writes (app/api/manual-accounts), as the Disconnect sheet does.
// Every write names a single account, so a stale page can only affect the
// account it acted on: it can't delete accounts it doesn't know about or
// revert a balance a scheduled push to /api/ingest/balance wrote meanwhile.
//
// After Save (docs/design/guidelines.md#after-save): an add, an update or a
// delete closes on the Accounts list, which shows it. An update that moved
// the account's typed transactions with its currency says what moved, in the
// same sheet, until the person closes it. Their buttons sit in the sheet's
// footer, a refusal beside them. Hide this account, offered when Update
// would move it between money held and owed, takes it off the list, so the
// sheet stays open on what moved, with an Undo, as the account sheet's Hide
// does (components/AccountSheet.tsx HiddenSaid), until Done.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { HiddenSaid, type HiddenStep } from './AccountSheet';
import { Notice } from './TotalCaveats';
import { CurrencyOptions, MovedBody, RelabelOffer } from './CurrencyChoiceSheet';
import { CORRECTION_KEEPS, RELABEL_KEEPS, relabelledText } from './currency-text';
import OwedFlipNote, { crossesOwed, OWED_FLIP_REASON } from './OwedFlipNote';
import type { ManualAccount } from './accounts-format';
import { CASH_SUBTYPE, isCashOnHand, isOwedType } from '@/lib/balance';
import { zeroExample } from '@/lib/format';
import { minorDigits } from '@/lib/manual-txn-input';

// The form's working copy. `balance` is a STRING, as in BudgetsTab and GoalsCard:
// an <input type="number"> reports '' for a partly typed value like "-", and
// Number('') is 0, so a number would erase the minus sign as you type it. It's
// parsed once on submit. `account_id` is null while adding; the server mints it.
// `currency` is the one chosen; `stored` the one the account is in now, so the
// form can say what changing it does.
export type ManualDraft = Omit<ManualAccount, 'account_id' | 'balance' | 'currency'> & {
  account_id: string | null;
  balance: string;
  currency: string;
  stored: string | null;
  /** With its currency corrected: also move the transactions typed on it
   *  into the new one (lib/manual-relabel.ts), only when the person ticks it. */
  relabel?: boolean;
  /** The account as it was when Update opened (null when adding): a type
   *  across money held and owed from its own is offered as a close instead
   *  (components/OwedFlipNote.tsx). */
  kept?: ManualAccount | null;
};

// "cash" is a choice, not a type: saved as depository with the subtype
// CASH_SUBTYPE (lib/balance.ts), which the Plan reads to count cash
// withdrawals and the cash spending entered on the account once.
const MANUAL_TYPE_LABELS: { value: string; label: string }[] = [
  { value: 'depository', label: 'Checking or savings' },
  { value: 'cash', label: 'Cash on hand (a wallet)' },
  { value: 'investment', label: 'Investment (brokerage, 401k, HSA)' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'other', label: 'Other (property, crypto)' },
];

/** The value, or the last one that wasn't null: what a closing drawer keeps
 *  showing while it slides out. */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** The manual account sheets, and the ways to open them. `saving` stays on
 *  through `onSaved`, after the sheet has closed, so nothing opens again on
 *  the balance from before the save until the screen behind has read it. */
export function useManualAccountSheets(opts: {
  /** The currencies offered first: the person's accounts', most first. */
  currencies: readonly string[];
  /** Saved: what the screen behind reads again, awaited. */
  onSaved: () => Promise<void>;
  /** Update, with a type across money held and owed: closing the account
   *  instead (components/AccountLifecycle.tsx). */
  onEnd: (account: ManualAccount) => void;
  /** Or hiding it, and the screen behind reads it again: the words of a
   *  refusal, or null once done. */
  onHide: (account_id: string) => Promise<string | null>;
  /** Unhides it: its Undo. */
  onUnhide: (account_id: string) => Promise<string | null>;
  /** A hide under way: the offer to hide waits for it. */
  hiding: boolean;
}) {
  const { currencies, onSaved, onEnd, onHide, onUnhide, hiding } = opts;
  // `draft` drives the add and update sheet, and `editing` flips the same form
  // between adding and updating. `error` is the sheets' own, so a failed save
  // can't linger on the Accounts card after the sheet closes, and a
  // background refresh failure can't look like a save failure.
  const [draft, setDraft] = useState<ManualDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ManualAccount | null>(null);
  // Saved with its typed transactions moved too: what moved, shown in the
  // same sheet until the person closes it (kept while it slides out).
  const [moved, setMoved] = useState<{ text: string; open: boolean } | null>(null);
  // What each sheet shows: the current value, or the last one while it slides out.
  const shown = useLast(draft);
  const editingShown = useLast(draft ? editing : null) ?? false;
  // Update, with a type across money held and owed from the account's own:
  // refused, said why, and offered as a close or a hide (components/OwedFlipNote.tsx).
  const crossing = !!shown?.kept && crossesOwed(shown.kept.type, shown.type);
  const shownDelete = useLast(deleteTarget);
  const id = useId();
  // Hidden from the form: kept open on what was said until Done, which
  // `closed` keeps while it slides out. Each time it says something new
  // (hidden, then undone), focus goes to the line; a refused Undo is said
  // under Undo, and a refused hide beside the form's buttons, focus back on
  // Hide this account.
  const [hid, setHid] = useState<{ account_id: string; label: string; step: 'hiding' | HiddenStep; closed: boolean } | null>(null);
  const [undoError, setUndoError] = useState('');
  const hidLine = useRef<HTMLDivElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const [hidSaid, setHidSaid] = useState(0);
  useEffect(() => {
    if (hidSaid > 0) hidLine.current?.focus();
  }, [hidSaid]);
  const [hideRefused, setHideRefused] = useState(0);
  useEffect(() => {
    const at = document.activeElement;
    if (hideRefused > 0 && (!at || at === document.body || at === hideButton.current)) hideButton.current?.focus();
  }, [hideRefused]);

  /** One manual-account write, naming a single account. */
  const mutate = useCallback(
    async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown) => {
      setSaving(true);
      setError('');
      try {
        const res = await fetch('/api/manual-accounts', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError(data?.error ?? 'Could not save. Please try again.');
          return false;
        }
        // What a move of its typed transactions did, said before the sheet
        // closes (the answer's `relabelled`).
        const done = await res.json().catch(() => null);
        const asked = body as { relabel_from?: string; currency?: string };
        const r = done?.relabelled;
        if (method === 'PATCH' && asked.relabel_from && asked.currency && typeof r?.moved === 'number' && typeof r?.kept === 'number') {
          setMoved({ text: relabelledText(r, asked.relabel_from, asked.currency), open: true });
        }
        setDraft(null);
        setDeleteTarget(null);
        await onSaved();
        return true;
      } catch {
        setError('Could not reach the server.');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [onSaved]
  );

  /** Adding: `currency` is what a new account's currency starts as (the home
   *  currency, else the one most accounts are in), for the person to change. */
  const startAdd = useCallback((currency: string) => {
    setError('');
    setMoved(null);
    setHid(null);
    setEditing(false);
    // The id is minted server-side on create, so a draft doesn't carry one.
    setDraft({
      account_id: null,
      name: '',
      institution_name: '',
      type: 'depository',
      subtype: null,
      balance: '',
      currency,
      stored: null,
    });
  }, []);

  const startEdit = useCallback((account: ManualAccount) => {
    setError('');
    setMoved(null);
    setHid(null);
    setEditing(true);
    const currency = account.currency ?? 'USD';
    setDraft({ ...account, balance: String(account.balance), currency, stored: currency, kept: account });
  }, []);

  const startDelete = useCallback((account: ManualAccount) => {
    setError('');
    setHid(null);
    setDeleteTarget(account);
  }, []);

  const submit = () => {
    if (!draft) return;
    const payload = {
      name: draft.name,
      institution_name: draft.institution_name,
      type: draft.type,
      subtype: draft.subtype,
      // As typed: choosing its currency never changes the number.
      balance: Number(draft.balance),
      currency: draft.currency,
    };
    if (draft.account_id) {
      // The rows typed on it move too only when the person ticked it.
      const relabel = draft.relabel && draft.stored !== null && draft.stored !== draft.currency ? { relabel_from: draft.stored } : {};
      void mutate('PATCH', { ...payload, ...relabel, account_id: draft.account_id });
    } else {
      void mutate('POST', payload);
    }
  };

  /** Hides it from the form, kept open on it while it does. */
  const hide = async (a: ManualAccount) => {
    if (hid || saving) return;
    const at = { account_id: a.account_id, label: a.name, closed: false };
    setError('');
    setUndoError('');
    setHid({ ...at, step: 'hiding' });
    const refused = await onHide(a.account_id);
    if (refused) {
      setHid(null);
      setError(refused);
      setHideRefused((n) => n + 1);
      return;
    }
    setDraft(null);
    setHid({ ...at, step: 'hidden' });
    setHidSaid((n) => n + 1);
  };
  /** Its Undo: unhides it. */
  const undoHide = async () => {
    if (!hid || hid.step !== 'hidden') return;
    const h = hid;
    setUndoError('');
    setHid({ ...h, step: 'undoing' });
    const refused = await onUnhide(h.account_id);
    if (refused) {
      setHid({ ...h, step: 'hidden' });
      setUndoError(refused);
      return;
    }
    setHid({ ...h, step: 'undone' });
    setHidSaid((n) => n + 1);
  };
  const hidShown = hid && hid.step !== 'hiding' ? { ...hid, step: hid.step } : null;
  const closeHid = () => {
    if (hid?.step === 'undoing') return;
    setHid((h) => (h ? { ...h, closed: true } : h));
  };
  const hidingNow = hid?.step === 'hiding';

  const showingMoved = !!moved && !draft;
  const invalid =
    !shown ||
    !shown.name.trim() ||
    !shown.institution_name.trim() ||
    shown.balance.trim() === '' ||
    !Number.isFinite(Number(shown.balance)) ||
    crossing ||
    (isOwedType(shown.type) && Number(shown.balance) < 0);
  const formError = `${id}-error`;
  const deleteError = `${id}-delete-error`;
  const said = (note: string) =>
    error && (
      <div className="sheet-footer-note" id={note}>
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      </div>
    );

  const sheets = (
    <>
      <Sheet
        open={!!draft || !!moved?.open || (!!hid && !hid.closed)}
        title={hidShown ? hidShown.label : showingMoved ? 'Saved' : shown && editingShown ? 'Update account' : 'Add a manual account'}
        onClose={() => {
          if (saving || hidingNow) return;
          if (hidShown) return closeHid();
          setDraft(null);
          setMoved((m) => (m ? { ...m, open: false } : m));
        }}
        // What moved draws its own Done: no footer of the form's under it.
        footer={
          hidShown ? (
            <button type="button" className="btn" onClick={closeHid} disabled={hidShown.step === 'undoing'}>
              Done
            </button>
          ) : (
            !showingMoved &&
            shown && (
            <>
              {said(formError)}
              <button type="button" className="btn secondary" onClick={() => setDraft(null)} disabled={saving || hidingNow}>
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                disabled={saving || hidingNow || invalid}
                onClick={submit}
                aria-describedby={[crossing && OWED_FLIP_REASON, error && formError].filter(Boolean).join(' ') || undefined}
              >
                {saving ? 'Saving…' : editingShown ? 'Save' : 'Add account'}
              </button>
            </>
            )
          )
        }
      >
        {hidShown ? (
          <HiddenSaid label={hidShown.label} step={hidShown.step} syncs={false} undoError={undoError} onUndo={() => void undoHide()} lineRef={hidLine} />
        ) : showingMoved ? (
          <MovedBody moved={[{ name: '', text: moved.text }]} onClose={() => setMoved((m) => (m ? { ...m, open: false } : m))} />
        ) : (
          shown && (
            <div className="stack">
              <p className="helper">
                For institutions Plaid can&apos;t reach. The balance you type counts toward net worth and is recorded on the timeline each time you update it.
              </p>
              <div className="sheet-form">
                <label className="field">
                  Account name
                  <input
                    value={shown.name}
                    onChange={(e) => setDraft({ ...shown, name: e.target.value })}
                    placeholder="e.g. Credit Union Checking"
                    maxLength={60}
                    disabled={saving || hidingNow}
                  />
                </label>
                <label className="field">
                  Institution
                  <input
                    value={shown.institution_name}
                    onChange={(e) => setDraft({ ...shown, institution_name: e.target.value })}
                    placeholder="Groups accounts into one card"
                    maxLength={60}
                    disabled={saving || hidingNow}
                  />
                </label>
                <label className="field">
                  Type
                  <select
                    value={isCashOnHand(shown) ? 'cash' : shown.type}
                    onChange={(e) => {
                      const cash = e.target.value === 'cash';
                      setDraft({
                        ...shown,
                        type: cash ? 'depository' : e.target.value,
                        // Cash only when chosen; another subtype is kept as it was.
                        subtype: cash ? CASH_SUBTYPE : shown.subtype === CASH_SUBTYPE ? null : shown.subtype,
                      });
                    }}
                    disabled={saving || hidingNow}
                    aria-describedby={crossing ? OWED_FLIP_REASON : undefined}
                  >
                    {MANUAL_TYPE_LABELS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Currency
                  <select
                    value={shown.currency}
                    // The balance stays as typed: only what it is counted in changes.
                    onChange={(e) => setDraft({ ...shown, currency: e.target.value })}
                    disabled={saving || hidingNow}
                  >
                    <CurrencyOptions first={currencies} value={shown.currency} />
                  </select>
                </label>
                <label className="field">
                  {isOwedType(shown.type) ? 'Amount owed' : 'Current balance'}
                  <input
                    // Held as a string (see ManualDraft) so a leading "-" survives
                    // typing. Credit and loan balances are amounts owed, which
                    // subtract from net worth, so a negative would double-negate.
                    type="number"
                    inputMode="decimal"
                    step={String(10 ** -minorDigits(shown.currency))}
                    min={isOwedType(shown.type) ? 0 : undefined}
                    value={shown.balance}
                    onChange={(e) => setDraft({ ...shown, balance: e.target.value })}
                    placeholder={zeroExample(minorDigits(shown.currency))}
                    disabled={saving || hidingNow}
                  />
                </label>
              </div>
              {shown.stored !== null && shown.currency !== shown.stored && (
                <p className="helper">
                  The balance you typed stays as it is, now in {shown.currency}: this account and its history are counted in {shown.currency} from now on.{' '}
                  {shown.relabel ? RELABEL_KEEPS : CORRECTION_KEEPS}
                </p>
              )}
              {shown.stored !== null && shown.account_id && shown.currency !== shown.stored && (
                // The server's count of every row the move would take, older
                // ones too, and that it has no undo.
                <RelabelOffer
                  account_id={shown.account_id}
                  from={shown.stored}
                  to={shown.currency}
                  checked={!!shown.relabel}
                  onChange={(on) => setDraft({ ...shown, relabel: on })}
                  disabled={saving || hidingNow}
                />
              )}
              {/* One child of the stack: the note's live region is there
                  while it says nothing, and would add a gap of its own. */}
              <div>
                <p className="helper">
                  {isOwedType(shown.type) ? 'Enter what you owe as a positive number. It subtracts from net worth.' : 'Negative balances are allowed (e.g. an overdrawn account).'}
                </p>
                <OwedFlipNote
                  crossing={crossing}
                  toOwed={isOwedType(shown.type)}
                  disabled={saving || hiding || !!hid}
                  hiding={hidingNow}
                  hideRef={hideButton}
                  onClose={() => {
                    const a = shown.kept!;
                    setDraft(null);
                    onEnd(a);
                  }}
                  onHide={() => void hide(shown.kept!)}
                />
              </div>
              {editingShown && shown.account_id && (
                <p className="helper manual-id">
                  Account ID for scripted updates: <code>{shown.account_id}</code>
                </p>
              )}
            </div>
          )
        )}
      </Sheet>

      <Sheet
        open={!!deleteTarget}
        title={shownDelete ? `Delete ${shownDelete.name}?` : 'Delete'}
        onClose={() => !saving && setDeleteTarget(null)}
        footer={
          shownDelete && (
            <>
              {said(deleteError)}
              <button type="button" className="btn secondary" onClick={() => setDeleteTarget(null)} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={saving}
                onClick={() => void mutate('DELETE', { account_id: shownDelete.account_id })}
                aria-describedby={error ? deleteError : undefined}
              >
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </>
          )
        }
      >
        {shownDelete && (
          <p className="helper">
            This account&apos;s balance history, any transactions entered on it and what you told your plan about it are <strong>not recoverable</strong>. Re-adding it creates a new
            account with an empty history.
          </p>
        )}
      </Sheet>
    </>
  );

  return { startAdd, startEdit, startDelete, saving, sheets };
}

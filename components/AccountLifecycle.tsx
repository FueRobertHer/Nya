'use client';

// Accounts that end (#50): the person says an account closed, is no longer
// theirs, or is no longer followed, from a day (lib/lifecycle.ts), and Nya's
// questions about an account missing from its bank's answer or at zero for
// weeks are answered here (lib/lifecycle-questions.ts).
//
//   - LifecycleSheet: the form, opened from an account's Close… action, from a
//     question, or from the Accounts that ended card.
//   - AccountQuestions: the questions on an institution's card (and in
//     connection health): Closed, Still open, Stop following.
//   - EndedAccounts: the collapsed card of accounts that ended, with when,
//     to change or reopen.
//   - useAccountLifecycle: the state and the one route behind all three
//     (app/api/account-lifecycle).
//   - LifecycleRepair: what the Accounts tab says when saved closures can't
//     be read, which stops it loading rather than count an account the
//     person closed; damaged ones can be removed once confirmed.
//
// The words keep the three apart where it matters: closed and left are the
// same to the math and differ only in what they say; untracked counts before
// its day and not after, where hidden leaves an account out of every day. It
// is said as following, never tracking: stopping tracking is what letting an
// account go from SimpleFIN is called (components/Connectors.tsx), which ends
// nothing.
// Nothing here removes anything: reopening restores an account exactly, and
// one its bank no longer returns is held at its last known balance and asked
// about until it does. The sheet says what an end does to net worth when the
// account still shows a balance, and asks for a tick before a debt still owed
// stops counting: ending one raises net worth, and must never look like
// money gained by accident.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { localDate } from '@/lib/local-date';
import { formatMoney } from '@/lib/format';
import { signedContribution } from '@/lib/balance';

export type EndState = 'closed' | 'left' | 'untracked';

/** An ended account as /api/net-worth sends it (lib/lifecycle.ts
 *  LifecycleForClient). */
export type EndedAccount = {
  account_id: string;
  lifecycle: { state: 'closed' | 'left'; on: string; note?: string } | { state: 'untracked'; from: string };
  assumed?: true;
  label: { name: string; institution: string; mask: string | null };
  type: string | null;
  item_id: string | null;
  /** Its balance's currency, where its end recorded it. */
  currency?: string;
  set_at: string;
};

/** A question on an account's row (lib/lifecycle-questions.ts AccountQuestion). */
export type AccountQuestion = {
  kind: 'missing' | 'zero' | 'reported';
  end: string;
  since: string | null;
  still_open?: true;
  again?: true;
  ended?: { state: 'closed' | 'left'; on: string; note?: string };
};

/** How long a "Still open" holds a missing account (lib/lifecycle.ts
 *  STILL_OPEN_HOLD_DAYS), in words. */
const HOLD_WORDS = 'two weeks';

/** What the sheet is about: an account, and what it opens on. */
export type LifecycleTarget = {
  account_id: string;
  name: string;
  mask: string | null;
  institution: string;
  /** Opens on this choice; the account's own end when it has one. */
  state?: EndState;
  /** The day to start from: a question's prefill, or the end it has. */
  day?: string;
  note?: string;
  /** It ended already: the sheet offers to reopen it. */
  ended?: boolean;
  /** What it shows now, when the app knows: what an end takes out of net
   *  worth, said in the sheet, and what a bank still returning it is
   *  compared with later. `lastKnown` says it is a held balance. */
  balance?: number | null;
  type?: string | null;
  currency?: string | null;
  lastKnown?: boolean;
  /** Why the day is prefilled, in a line. */
  prefilled?: string;
};

const endOf = (l: EndedAccount['lifecycle']) => (l.state === 'untracked' ? l.from : l.on);

/** "Mar 12", or "Mar 12, 2025" outside this year: a calendar day, read at
 *  local midnight so it never shows as the day before. */
export function dayText(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

/** "Ally Savings ••1234". */
export const accountName = (name: string, mask: string | null) => (mask ? `${name} ••${mask}` : name);

/** What an end says, in a few words: "Closed Mar 12". */
export function endText(l: EndedAccount['lifecycle']): string {
  switch (l.state) {
    case 'closed':
      return `Closed ${dayText(l.on)}`;
    case 'left':
      return `No longer yours since ${dayText(l.on)}`;
    case 'untracked':
      return `Not followed since ${dayText(l.from)}`;
  }
}

/** What a rule can name of the accounts (components/RuleSheet.tsx), as the
 *  Rules screen labels them: the live ones, then each that ended and that
 *  the live list no longer holds, labelled with its end. A rule on one still
 *  applies to its transactions from before its end, which the Activity tab
 *  still lists: it is never "an account no longer here". */
export function withEndedAccounts(live: readonly { id: string; label: string }[], ended: readonly EndedAccount[]): { id: string; label: string }[] {
  const listed = new Set(live.map((a) => a.id));
  const more = ended
    .filter((e) => !listed.has(e.account_id))
    .map((e) => ({ id: e.account_id, label: `${e.label.institution ? `${e.label.institution} ` : ''}${accountName(e.label.name || 'Account', e.label.mask)} · ${endText(e.lifecycle)}` }));
  return [...live, ...more];
}

const CHOICES: { value: EndState; label: string; note: string }[] = [
  { value: 'closed', label: 'Closed', note: 'It no longer exists: closed at the bank, a loan paid off, a cash jar emptied.' },
  { value: 'left', label: 'No longer yours', note: 'It still exists, but isn’t yours: sold, transferred, or divided.' },
  {
    value: 'untracked',
    label: 'Stop following',
    note: 'It is still yours, and you stop following it. It still counts on every day before the one you choose, and not after. Hiding is different: a hidden account is left out of every day, past ones too.',
  },
];

const DAY_LABEL: Record<EndState, string> = {
  closed: 'Closed on',
  left: 'No longer yours from',
  untracked: 'Stop counting it from',
};

/** The value a component keeps showing while its drawer slides out. */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** A Plaid connection whose every account has ended (the route's answer). */
export type EndedConnection = { item_id: string; institution_name: string };

type Answer = { lifecycle?: unknown; remove_connection?: EndedConnection; error?: string };

/**
 * The state behind the sheet, the questions and the card, and the one route
 * they write through. `onChanged` reloads what the change touches (net worth,
 * transactions, notes); `onRemoveConnection` opens the confirmation to remove
 * a connection whose last open account just ended. `problem` is a failure to
 * show outside the sheet (an answer given from a card); inside, the sheet
 * says it.
 */
export function useAccountLifecycle(opts: { onChanged: () => void; onRemoveConnection: (c: EndedConnection) => void }) {
  const [target, setTarget] = useState<LifecycleTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { onChanged, onRemoveConnection } = opts;

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<Answer | null> => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/account-lifecycle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data: Answer = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error ?? 'That change couldn’t be saved.');
          return null;
        }
        onChanged();
        return data;
      } catch {
        setError('That change couldn’t be saved: the server couldn’t be reached.');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [onChanged]
  );

  const open = useCallback((t: LifecycleTarget) => {
    setError('');
    setTarget(t);
  }, []);
  const close = useCallback(() => setTarget(null), []);

  /** Ends an account as the sheet says; asks about the connection after. */
  const end = useCallback(
    async (account_id: string, state: EndState, day: string, note: string, balance?: number | null) => {
      const seen = balance !== undefined ? { balance } : {};
      const body = state === 'untracked' ? { account_id, state, from: day, ...seen } : { account_id, state, on: day, ...(note.trim() ? { note: note.trim() } : {}), ...seen };
      const done = await post(body);
      if (!done) return;
      setTarget(null);
      if (done.remove_connection) onRemoveConnection(done.remove_connection);
    },
    [post, onRemoveConnection]
  );

  const reopen = useCallback(
    async (account_id: string) => {
      if (await post({ account_id, state: 'active' })) setTarget(null);
    },
    [post]
  );

  /** "Still open": the answer to a question, saved at once. */
  const stillOpen = useCallback(
    (account_id: string, question: Pick<AccountQuestion, 'kind' | 'since' | 'end'>) =>
      post({ account_id, state: 'active', answer: question.kind, since: question.since ?? question.end }),
    [post]
  );

  /** "Still closed": an end confirmed as it is, with the balance its bank
   *  shows now, which is asked about again only if it moves. */
  const confirmEnd = useCallback(
    (account_id: string, ended: NonNullable<AccountQuestion['ended']>, balance: number | null) =>
      post({ account_id, state: ended.state, on: ended.on, ...(ended.note ? { note: ended.note } : {}), balance }),
    [post]
  );

  const shown = useLast(target);
  const sheet = (
    <Sheet open={!!target} title={shown ? accountName(shown.name, shown.mask) : 'Account'} onClose={() => !busy && close()}>
      {shown && <LifecycleForm key={`${shown.account_id}|${shown.state}|${shown.day}`} target={shown} busy={busy} error={error} onCancel={close} onEnd={end} onReopen={reopen} />}
    </Sheet>
  );

  return { open, stillOpen, confirmEnd, reopen, sheet, busy, problem: target ? '' : error };
}

/**
 * What an end does to net worth now, from the balance the account shows:
 * null when that isn't known or is zero. A debt still owed (`owed`) raises
 * net worth when it stops counting, which the form asks the person to
 * confirm. Pure, for the tests.
 */
export function endEffect(t: Pick<LifecycleTarget, 'balance' | 'type' | 'currency' | 'lastKnown'>, day: string): { text: string; owed: boolean } | null {
  if (typeof t.balance !== 'number' || !t.type) return null;
  const c = signedContribution(t.type, t.balance);
  if (Math.abs(c) < 0.005) return null;
  const amount = formatMoney(Math.abs(c), t.currency ?? null);
  const shows = t.lastKnown ? 'Its last known balance is' : 'It still shows';
  if (c < 0) {
    return {
      text: `${shows} ${amount} owed. From ${dayText(day)} that debt stops counting, so your net worth rises by ${amount}. If it is still owed, keep the account open until it is paid.`,
      owed: true,
    };
  }
  return { text: `${shows} ${amount}. From ${dayText(day)} it stops counting, so your net worth falls by ${amount}.`, owed: false };
}

/** The sheet's form. */
export function LifecycleForm({
  target,
  busy,
  error,
  onCancel,
  onEnd,
  onReopen,
  today = localDate(),
}: {
  target: LifecycleTarget;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onEnd: (account_id: string, state: EndState, day: string, note: string, balance?: number | null) => void;
  onReopen: (account_id: string) => void;
  today?: string;
}) {
  const [state, setState] = useState<EndState>(target.state ?? 'closed');
  const [day, setDay] = useState(target.day && target.day <= today ? target.day : today);
  const [note, setNote] = useState(target.note ?? '');
  const [owedOk, setOwedOk] = useState(false);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '1970-01-01' && day <= today;
  const effect = valid ? endEffect(target, day) : null;
  const confirmed = !effect?.owed || owedOk;
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {target.institution ? `${target.institution}. ` : ''}What happened to it?
      </p>
      <fieldset className="lifecycle-choices" disabled={busy}>
        <legend className="section-label">It is</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="lifecycle-choice">
            <input type="radio" name="lifecycle-state" value={c.value} checked={state === c.value} onChange={() => setState(c.value)} />
            <span>
              <span className="lifecycle-choice-name">{c.label}</span>
              <span className="lifecycle-choice-note">{c.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="sheet-form">
        <label className="field">
          {DAY_LABEL[state]}
          <input type="date" value={day} min="1970-01-01" max={today} onChange={(e) => setDay(e.target.value)} disabled={busy} />
        </label>
        {target.prefilled && <p className="panel-note lifecycle-prefilled">{target.prefilled}</p>}
        {state !== 'untracked' && (
          <label className="field">
            A note, if you like
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={state === 'closed' ? 'e.g. Moved to Chase' : 'e.g. Transferred to Fidelity'} disabled={busy} />
          </label>
        )}
      </div>
      <p className="panel-note">
        {valid
          ? `Every day before ${dayText(day)} stays as it was. From ${dayText(day)} on it isn’t counted: not in net worth, the chart, allocation, budgets or spending. Nothing is deleted, so reopening puts it back exactly.`
          : 'Choose a day up to today.'}
      </p>
      {effect && (
        <p className={effect.owed ? 'stale-note lifecycle-effect' : 'panel-note lifecycle-effect'}>
          <Masked>{effect.text}</Masked>
        </p>
      )}
      {effect?.owed && (
        <label className="lifecycle-confirm">
          <input type="checkbox" checked={owedOk} onChange={(e) => setOwedOk(e.target.checked)} disabled={busy} />
          <span>Stop counting what it owes</span>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button disabled={busy || !valid || !confirmed} onClick={() => onEnd(target.account_id, state, day, note, target.balance)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {target.ended && (
        <div className="lifecycle-reopen">
          <p className="panel-note">
            Still open after all? Reopening counts it again on every day. If its bank no longer returns it, it is held at its
            last known balance, and asked about, until the bank does.
          </p>
          <button className="secondary" onClick={() => onReopen(target.account_id)} disabled={busy}>
            Reopen it
          </button>
        </div>
      )}
    </>
  );
}

/** An account's row, as AccountQuestions reads it. */
type QuestionRow = {
  account_id: string;
  name: string;
  mask: string | null;
  type?: string;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
  question?: AccountQuestion;
  held?: { as_of: string | null; too_old?: string };
};

/** "$450.00 owed", or "$450.00": a balance as a question names it. */
function balanceWords(row: Pick<QuestionRow, 'balance' | 'currency' | 'type'> | undefined): string | null {
  if (typeof row?.balance !== 'number') return null;
  const owed = row.type === 'credit' || row.type === 'loan';
  return `${formatMoney(Math.abs(row.balance), row.currency ?? null)}${owed && row.balance > 0 ? ' owed' : ''}`;
}

/** The words of a question, and the line under it. Pure, for the tests. */
export function questionText(
  q: AccountQuestion,
  who: string,
  institution: string,
  row?: Pick<QuestionRow, 'balance' | 'currency' | 'held' | 'hidden' | 'type'>
): { ask: string; detail: string } {
  if (q.kind === 'zero') {
    return {
      ask: `${who} has been at ${formatMoney(0, row?.currency ?? null)} with no activity since ${dayText(q.since ?? q.end)}. Closed?`,
      detail: 'Nothing waits on your answer: a zero counts the same either way.',
    };
  }
  if (q.kind === 'reported') {
    const ended = q.ended?.state === 'left' ? `no longer yours since ${dayText(q.end)}` : `closed ${dayText(q.end)}`;
    const shows = balanceWords(row);
    const what = q.since ? `has a transaction from ${dayText(q.since)}` : shows ? `shows ${shows}` : 'has moved';
    return {
      ask: `${who}, ${ended}, ${what}. ${q.ended?.state === 'left' ? 'Still not yours?' : 'Still closed?'}`,
      detail: `${institution || 'Its bank'} still reports it, and from its end it counts in nothing, so this isn’t in your net worth. If it is open again, reopen it to count it.`,
    };
  }
  const held = row?.hidden
    ? 'It’s hidden, so it counts in no total either way'
    : row?.held?.as_of
      ? `It’s shown at its last known balance, from ${dayText(row.held.as_of)}`
      : row?.held?.too_old
        ? `Its last known balance, from ${dayText(row.held.too_old)}, is too old to count`
        : 'Nya has no recent balance for it';
  if (q.still_open) {
    return {
      ask: `You said ${who} is still open, but ${institution || 'its bank'} hasn’t reported it since ${q.since ? dayText(q.since) : 'it went missing'}.`,
      detail: `${held}, and no total is saved while it’s missing, for ${HOLD_WORDS} from your answer at most: then Nya asks again. Reconnecting may bring it back, or say it closed.`,
    };
  }
  if (q.again) {
    return {
      ask: `You said ${who} was still open, but it still hasn’t appeared${q.since ? ` since ${dayText(q.since)}` : ''}. Closed?`,
      detail: `${held}, and no total is saved until you answer. If nobody answers within three days, Nya assumes it closed, and you can say otherwise.`,
    };
  }
  return {
    ask: q.since ? `${who} hasn’t appeared since ${dayText(q.since)}. Closed?` : `${who} is missing from ${institution || 'its bank'}’s latest answer. Closed?`,
    detail: `${held}, and no total is saved until you answer.`,
  };
}

/** What a debt its bank still reports owes, as words, or null when it owes
 *  nothing (or isn't a debt): "Still closed" keeps that out of net worth. */
export function owedWords(row: Pick<QuestionRow, 'balance' | 'currency' | 'type'>): string | null {
  if (typeof row.balance !== 'number' || !row.type) return null;
  const c = signedContribution(row.type, row.balance);
  return c <= -0.005 ? formatMoney(Math.abs(c), row.currency ?? null) : null;
}

/**
 * A question about an end its bank doesn't agree with, and its answers. On a
 * debt it says is owed, "Still closed" (or "Still not mine") keeps what it
 * owes out of net worth, so it waits for the same tick the sheet asks for
 * (endEffect), with the amount named: a debt that stops counting must never
 * look like money gained by a tap.
 */
function ReportedQuestion({
  a,
  ended,
  ask,
  detail,
  busy,
  onConfirmEnd,
  onReopen,
}: {
  a: QuestionRow;
  ended: NonNullable<AccountQuestion['ended']>;
  ask: string;
  detail: string;
  busy: boolean;
  onConfirmEnd?: (account_id: string, ended: NonNullable<AccountQuestion['ended']>, balance: number | null) => void;
  onReopen?: (account_id: string) => void;
}) {
  const owed = owedWords(a);
  const [owedOk, setOwedOk] = useState(false);
  return (
    <li className="lifecycle-question">
      <p className="lifecycle-ask">
        <Masked>{ask}</Masked>
      </p>
      <p className="panel-note">{detail}</p>
      {owed && (
        <label className="lifecycle-confirm">
          <input type="checkbox" checked={owedOk} onChange={(e) => setOwedOk(e.target.checked)} disabled={busy} />
          <span>
            Stop counting the <Masked>{owed}</Masked> it owes
          </span>
        </label>
      )}
      <div className="card-actions">
        <button className="secondary" onClick={() => onConfirmEnd?.(a.account_id, ended, a.balance)} disabled={busy || !onConfirmEnd || (!!owed && !owedOk)}>
          {ended.state === 'left' ? 'Still not mine' : 'Still closed'}
        </button>
        <button className="secondary" onClick={() => onReopen?.(a.account_id)} disabled={busy || !onReopen}>
          Reopen
        </button>
      </div>
    </li>
  );
}

/** The questions on one institution's accounts, each with its answers. */
export function AccountQuestions({
  accounts,
  institution,
  busy,
  onOpen,
  onStillOpen,
  onConfirmEnd,
  onReopen,
}: {
  accounts: QuestionRow[];
  institution: string;
  busy: boolean;
  onOpen: (t: LifecycleTarget) => void;
  onStillOpen: (account_id: string, q: AccountQuestion) => void;
  /** An end that a bank still reporting the account questions, confirmed
   *  ("Still closed"), with the balance it shows now. */
  onConfirmEnd?: (account_id: string, ended: NonNullable<AccountQuestion['ended']>, balance: number | null) => void;
  onReopen?: (account_id: string) => void;
}): ReactNode {
  const asked = accounts.filter((a): a is QuestionRow & { question: AccountQuestion } => !!a.question);
  if (asked.length === 0) return null;
  return (
    <ul className="lifecycle-questions">
      {asked.map((a) => {
        const who = accountName(a.name, a.mask);
        const { ask, detail } = questionText(a.question, who, institution, a);
        const ended = a.question.kind === 'reported' ? a.question.ended : undefined;
        if (ended) {
          return <ReportedQuestion key={a.account_id} a={a} ended={ended} ask={ask} detail={detail} busy={busy} onConfirmEnd={onConfirmEnd} onReopen={onReopen} />;
        }
        const target = (state: EndState): LifecycleTarget => ({
          account_id: a.account_id,
          name: a.name,
          mask: a.mask,
          institution,
          state,
          day: a.question.end,
          balance: a.hidden ? undefined : a.balance,
          type: a.type ?? null,
          currency: a.currency,
          lastKnown: !!a.held,
          prefilled:
            a.question.kind === 'zero'
              ? 'Prefilled with the first day it was at zero.'
              : a.question.since
                ? `Prefilled with the day after it was last seen, ${dayText(a.question.since)}.`
                : undefined,
        });
        return (
          <li key={a.account_id} className="lifecycle-question">
            <p className="lifecycle-ask">
              <Masked>{ask}</Masked>
            </p>
            <p className="panel-note">{detail}</p>
            <div className="card-actions">
              <button className="secondary" onClick={() => onOpen(target('closed'))} disabled={busy}>
                Closed
              </button>
              {!a.question.still_open && (
                <button className="secondary" onClick={() => onStillOpen(a.account_id, a.question)} disabled={busy}>
                  Still open
                </button>
              )}
              <button className="secondary" onClick={() => onOpen(target('untracked'))} disabled={busy}>
                Stop following
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The collapsed card of accounts that ended, with when, to change or
 *  reopen. `hidden` names the ones also hidden (the Hidden card has them too). */
export function EndedAccounts({
  ended,
  hidden,
  busy,
  onOpen,
  onReopen,
  onStillOpen,
  onImportHistory,
  importable,
}: {
  ended: EndedAccount[];
  hidden: ReadonlySet<string>;
  busy: boolean;
  onOpen: (t: LifecycleTarget) => void;
  onReopen: (account_id: string) => void;
  onStillOpen: (account_id: string, q: Pick<AccountQuestion, 'kind' | 'since' | 'end'>) => void;
  /** Importing its history from a file (#52, components/HistoryImportSheet.tsx),
   *  for a linked account whose connection is still stored (`importable`, by
   *  connection): its rows before its end count, those from it are kept and
   *  count in nothing, as its bank's own. */
  onImportHistory?: (e: EndedAccount) => void;
  importable?: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(ended.some((e) => e.assumed));
  if (ended.length === 0) return null;
  const assumed = ended.filter((e) => e.assumed).length;
  return (
    <div className="card hidden-section lifecycle-card">
      <button className="holdings-toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className="holdings-title">
          Accounts that ended
          <span className="holdings-count">{ended.length}</span>
        </span>
        <span className="holdings-summary">
          {assumed > 0 && <span className="health-attention">{assumed === 1 ? '1 to confirm' : `${assumed} to confirm`}</span>}
          <svg className={`chevron${expanded ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {expanded && (
        <>
          <p className="empty-note">
            These stopped counting on the day shown: every day before it still counts, so your chart keeps the step and
            its note. Nothing was deleted, so reopening one puts it back exactly; one its bank no longer returns is held
            at its last known balance, and asked about, until the bank does.
          </p>
          <ul className="lifecycle-list">
            {ended.map((e) => {
              const l = e.lifecycle;
              const day = endOf(l);
              const name = accountName(e.label.name || 'Account', e.label.mask);
              const target: LifecycleTarget = {
                account_id: e.account_id,
                name: e.label.name || 'Account',
                mask: e.label.mask,
                institution: e.label.institution,
                state: l.state,
                day,
                note: l.state !== 'untracked' ? l.note : undefined,
                ended: true,
              };
              return (
                <li key={e.account_id} className="lifecycle-row">
                  <div>
                    {name}
                    <div className="type-tag">
                      {e.label.institution ? `${e.label.institution} · ` : ''}
                      {endText(l)}
                      {hidden.has(e.account_id) ? ' · also hidden' : ''}
                    </div>
                    {l.state !== 'untracked' && l.note && <div className="lifecycle-note">{l.note}</div>}
                    {e.assumed && (
                      <p className="stale-note lifecycle-assumed">
                        Assumed closed: {e.label.institution || 'its bank'} stopped reporting it and nobody answered. Is it?
                      </p>
                    )}
                  </div>
                  <div className="manual-row-actions lifecycle-actions">
                    {e.assumed ? (
                      <>
                        <button
                          className="link-btn"
                          disabled={busy}
                          onClick={() => onOpen({ ...target, ended: false, prefilled: 'The day Nya assumed: the day after it was last seen.' })}
                        >
                          Yes, closed
                        </button>
                        <button className="link-btn" disabled={busy} onClick={() => onStillOpen(e.account_id, { kind: 'missing', since: day, end: day })}>
                          Still open
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="link-btn" disabled={busy} onClick={() => onOpen(target)}>
                          Change
                        </button>
                        <button className="link-btn" disabled={busy} onClick={() => onReopen(e.account_id)}>
                          Reopen
                        </button>
                      </>
                    )}
                    {onImportHistory && e.item_id !== null && importable?.has(e.item_id) && (
                      <button className="link-btn" disabled={busy} onClick={() => onImportHistory(e)}>
                        Import history from a file
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** What a dashboard load that failed on closures it couldn't read said
 *  (app/api/net-worth: 409 with `repair`). */
export type LifecycleDamage = { unreadable: number; unrecognised: number };

/** The ids a 409 named, as counts, when it says the closures are what can't
 *  be read; null for any other failure. Pure. */
export function lifecycleDamageOf(status: number, body: unknown): LifecycleDamage | null {
  const b = body as { repair?: unknown; unreadable_ids?: unknown; unrecognised_ids?: unknown } | null;
  if (status !== 409 || !b || b.repair !== 'account-lifecycle') return null;
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return { unreadable: count(b.unreadable_ids), unrecognised: count(b.unrecognised_ids) };
}

/**
 * Saved closures that can't be read stop the dashboard loading: one of them
 * may be an account the person closed, and counting it would be wrong. Those
 * whose bytes are damaged can be removed, once confirmed (the accounts they
 * ended count again until ended again). Those saved by a newer version of Nya
 * are only named: they are intact, and that version reads them.
 */
export function LifecycleRepair({ damage, onRepaired }: { damage: LifecycleDamage; onRepaired: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = damage.unreadable;
  const repair = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account-lifecycle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'repair', confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'The damaged closures couldn’t be removed.');
        return;
      }
      setConfirming(false);
      onRepaired();
    } catch {
      setError('The damaged closures couldn’t be removed: the server couldn’t be reached.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stale-note lifecycle-repair">
      {n > 0 && (
        <p>
          {n === 1 ? 'One saved account closure is damaged' : `${n} saved account closures are damaged`} and can’t be read.
          {damage.unrecognised > 0
            ? ` Accounts can’t load while any closure can’t be read, since one may be an account you closed, and removing ${n === 1 ? 'this one' : 'these'} isn’t enough on its own (see below).`
            : ` Accounts can’t load until ${n === 1 ? 'it is' : 'they are'} removed, since one may be an account you closed.`}{' '}
          Removing {n === 1 ? 'it' : 'them'} counts {n === 1 ? 'that account' : 'those accounts'} again until you close{' '}
          {n === 1 ? 'it' : 'them'} again.
        </p>
      )}
      {damage.unrecognised > 0 && (
        <p>
          {damage.unrecognised === 1 ? 'One account closure is' : `${damage.unrecognised} account closures are`} in a form this
          version of Nya can’t read, though {damage.unrecognised === 1 ? 'it looks' : 'they look'} intact: perhaps saved by a
          newer version. Nothing here changes {damage.unrecognised === 1 ? 'it' : 'them'}, and accounts can’t load until the
          version that saved {damage.unrecognised === 1 ? 'it' : 'them'} is back.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {n > 0 &&
        (confirming ? (
          <div className="button-pair">
            <button className="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button className="danger" onClick={repair} disabled={busy}>
              {busy ? 'Removing…' : n === 1 ? 'Remove it' : `Remove all ${n}`}
            </button>
          </div>
        ) : (
          <button className="secondary" onClick={() => setConfirming(true)}>
            Remove the damaged {n === 1 ? 'closure' : 'closures'}
          </button>
        ))}
    </div>
  );
}

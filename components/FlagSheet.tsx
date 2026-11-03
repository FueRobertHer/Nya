'use client';

// One feature switch's sheet (lib/flags.ts), opened from its row in the
// Feature switches card: what it does, what turning it off does, its key and
// variable, and its value, set as its kind is set:
//   - a mode or a switch: radio rows, saved by Save in the footer;
//   - an audience: radio rows for who it is on for, saved by Save, and on
//     the admin page the accounts it is also on for, each removed in place,
//     added from a second level listing the accounts in use, and its last
//     changes;
//   - the sign-in list (the admin page only): the deployment's owners, always
//     let in, then each id or email, removed after a second level confirms
//     it, and a field to add someone.
// Saved by Save, never on a choice alone: the arrow keys choose at every step,
// and a policy would pass through Off on its way to Enforce. Adding and
// removing act at once, each one change in the record.
//
// On /dev/flags (`place: 'dev'`) only the choices are set, through
// /api/dev/flags; accounts and people are counted, never named, and set on
// the admin page. On the admin page every change goes through
// /api/admin/flags, with a fresh sign-in where it asks for one: Clerk's
// useReverification wraps the request (components/FeatureSwitchesCard.tsx),
// or, with the app password, the password field at the top is sent with each.

import { useState } from 'react';
import { isReverificationCancelledError } from '@clerk/nextjs/errors';
import { Sheet } from './Sheet';
import RadioRows, { type RadioOption } from './RadioRows';
import { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './MonthStepper';
import type { AdminAccount, ChangeLine, Place, SwitchRow } from '@/lib/flag-view';

/** An account as the admin page names it, from the registry. */

type Hint = { clerk_error: { type: string; reason: string } };
/** What a change came back with: the flag's row (the admin's route), or the
 *  choice stored (the dev route). */
export type Answer = { ok: true; row: SwitchRow | null; choice: string | null } | { ok: false; error: string } | Hint;
export type Send = (body: Record<string, unknown>) => Promise<Answer>;

export function isHint(v: unknown): v is Hint {
  const e = (v as Hint | null)?.clerk_error;
  return !!e && e.type === 'forbidden' && e.reason === 'reverification-error';
}

const COULDNT = 'The switch couldn’t be set just now.';

/** Sends one change to `url`. Clerk's hint comes back as it is, for its hook
 *  to ask the person to confirm it's them and send it again. */
export async function putFlag(url: string, body: Record<string, unknown>): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.' };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (isHint(data)) return data;
    return { ok: false, error: typeof data?.error === 'string' ? data.error : COULDNT };
  }
  return { ok: true, row: data?.row ?? null, choice: typeof data?.choice === 'string' ? data.choice : null };
}

const WHO: Record<Place, Record<string, string>> = {
  admin: { nobody: 'Off', admin: 'You', 'admin-and-demo': 'You and the demo accounts', everyone: 'Everyone' },
  dev: { nobody: 'Off', admin: 'The admin', 'admin-and-demo': 'The admin and the demo accounts', everyone: 'Everyone' },
};
const OTHER_WORDS: Record<string, string> = { off: 'Off', on: 'On', 'report-only': 'Report only', enforce: 'Enforce' };

/** A choice in words. */
export function choiceWord(row: SwitchRow, place: Place, choice: string | null): string {
  if (choice === null) return '';
  return (row.kind === 'audience' ? WHO[place][choice] : OTHER_WORDS[choice]) ?? choice;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The choice that applies now: the variable's while it is set, else the one
 *  stored, else the default (also when the stored one can't be read). */
export function choiceInForce(row: SwitchRow): string | null {
  if (row.variableSet && row.variableChoice !== null) return row.variableChoice;
  return row.stored !== null && row.stored !== 'unreadable' && row.stored !== 'list' ? row.stored : row.defaultChoice;
}

/** A switch's value in words, as its row shows it. */
export function valueWords(row: SwitchRow, place: Place): string {
  if (row.kind === 'list') {
    if (row.variableSet) return 'The environment’s list';
    return row.people === null ? 'Nobody on the stored list' : `${count(row.people, 'person', 'people')} on the stored list`;
  }
  const choice = choiceInForce(row);
  const word = choiceWord(row, place, choice);
  const named = row.variableSet ? 0 : (row.accounts ?? 0);
  if (row.kind !== 'audience' || named === 0 || choice === 'everyone') return word;
  const accounts = count(named, 'account', 'accounts');
  return choice === 'nobody' ? `On for ${accounts} by name` : `${word}, and ${accounts} by name`;
}

const NOTES: Record<string, string> = {
  nobody: 'On for nobody, but any accounts named below.',
  admin: 'The deployment’s owner.',
  'admin-and-demo': 'The owner, and the demo accounts where there are any.',
  everyone: 'Every account on this copy of Nya.',
  enforce: 'Pages refuse what the policy doesn’t allow.',
  'report-only': 'Pages report what the policy would refuse, and refuse nothing.',
  off: '',
  on: '',
};

function options(row: SwitchRow, place: Place, demos: boolean, shown: string | null): RadioOption[] {
  const order = row.kind === 'mode' ? ['enforce', 'report-only', 'off'] : row.kind === 'switch' ? ['on', 'off'] : row.choices;
  return order
    .filter((c) => row.choices.includes(c))
    .filter((c) => c !== 'admin-and-demo' || demos || shown === c)
    .map((c) => {
      let note = NOTES[c];
      if (row.kind === 'mode' && c === 'off') note = 'Pages carry no policy.';
      if (row.kind === 'switch') note = c === 'on' ? 'The ops routes answer a request signed with OPS_SECRET.' : 'The ops routes answer as missing.';
      return { value: c, name: choiceWord(row, place, c), ...(note ? { note } : {}) };
    });
}

export default function FlagSheet({
  row,
  place,
  open,
  onClose,
  send,
  onChanged,
  demos,
  environment,
  clerk,
  askPassword,
  accounts,
  changes,
  day,
}: {
  row: SwitchRow;
  place: Place;
  open: boolean;
  onClose: () => void;
  send: Send;
  onChanged: (answer: Extract<Answer, { ok: true }>) => void;
  demos: boolean;
  /** Where these values hold: "Production", "Preview", "local development". */
  environment: string;
  clerk: boolean;
  /** Whether each change carries the app password (no Clerk, and a fresh
   *  sign-in asked for). */
  askPassword: boolean;
  accounts: AdminAccount[];
  changes: ChangeLine[];
  day: (iso: string) => string;
}) {
  const admin = place === 'admin';
  const unreadable = row.stored === 'unreadable';
  const stored = row.stored !== null && row.stored !== 'unreadable' && row.stored !== 'list' ? row.stored : null;
  const shown = stored ?? row.defaultChoice;
  const [choice, setChoice] = useState(shown ?? '');
  const [password, setPassword] = useState('');
  const [entry, setEntry] = useState('');
  const [level, setLevel] = useState<'main' | 'add-account' | { remove: string }>('main');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /** Another level of the sheet, without the last one's failure: it was
   *  about something else. */
  const goTo = (next: typeof level) => {
    setFailed(null);
    setLevel(next);
  };

  /** Sends one change; true when it was made. */
  const run = async (change: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setFailed(null);
    try {
      const body = admin ? { key: row.key, change, ...(askPassword ? { password } : {}) } : { key: row.key, choice: change.choice };
      const answer = await send(body);
      if (isHint(answer)) {
        setFailed('Nya couldn’t confirm it’s you. Sign out and in again, then try again.');
        return false;
      }
      if (!answer.ok) {
        setFailed(answer.error);
        return false;
      }
      onChanged(answer);
      return true;
    } catch (err) {
      if (!isReverificationCancelledError(err)) setFailed(COULDNT);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const needsPassword = askPassword && password.length === 0;
  const known = new Map(accounts.map((a) => [a.id, a]));
  const named = row.containers ?? [];
  const failure = failed && (
    <Notice level="critical" role="alert">
      {failed}
    </Notice>
  );

  if (level === 'add-account') {
    const addable = accounts.filter((a) => a.active && !named.includes(a.id));
    return (
      <Sheet open={open} title="Add an account" onClose={onClose} onBack={() => goTo('main')} level="add-account">
        <div className="stack">
          <p className="helper">
            {row.name} will be on for the account you choose, in {environment}, whoever else it is on for.
          </p>
          {addable.length === 0 ? (
            <p className="empty-note">Every account in use is on it already.</p>
          ) : (
            <ul className="card list-rows">
              {addable.map((a) => (
                <li key={a.id}>
                  <button type="button" className="list-row" disabled={busy || needsPassword} onClick={async () => (await run({ op: 'add-account', container: a.id })) && setLevel('main')}>
                    <span className="list-row-text">
                      <span className="list-row-title">{a.name}</span>
                      {a.made && <span className="list-row-sub">Made {day(a.made)}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {needsPassword && <p className="helper">Type your app password on the switch’s sheet first.</p>}
          {failure}
        </div>
      </Sheet>
    );
  }

  if (typeof level === 'object') {
    return (
      <Sheet
        open={open}
        title="Remove from the list"
        onClose={onClose}
        onBack={() => goTo('main')}
        level="remove-person"
        footer={
          <div className="btn-row">
            <button type="button" className="btn danger" disabled={busy || needsPassword} onClick={async () => (await run({ op: 'remove-person', entry: level.remove })) && setLevel('main')}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        }
      >
        <div className="stack">
          <p>
            Remove <strong>{level.remove}</strong> from who may sign in?
          </p>
          <p className="helper">They are refused at their next request, signed in or not.</p>
          {needsPassword && <p className="helper">Type your app password on the switch’s sheet first.</p>}
          {failure}
        </div>
      </Sheet>
    );
  }

  const choosing = row.kind !== 'list' && !unreadable;
  const footer =
    choosing && choice !== shown ? (
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy || needsPassword} onClick={() => run({ op: 'choose', choice })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    ) : undefined;

  return (
    <Sheet open={open} title={row.name} onClose={onClose} level="main" footer={footer}>
      <div className="stack">
        <p>{row.about}</p>
        <p className="helper">Turned off: {row.offMeans}</p>
        <p className="helper">
          Its key is <code>{row.key}</code>
          {row.variable ? (
            <>
              , and <code>{row.variable}</code> decides it while that is set.
            </>
          ) : (
            '.'
          )}
          {row.removeBy && ` A release switch: it is to be removed by ${row.removeBy}.`}
        </p>
        {row.variableSet && (
          <Notice level="info">
            {row.variable} is set, so it decides: {valueWords(row, place)}. {row.kind === 'list' ? 'This list' : 'Your choice'} takes over when it is removed.
          </Notice>
        )}
        {unreadable && <Notice level="caution">Its stored value can’t be read, so its default applies, and it is left as it is.</Notice>}
        {askPassword && !unreadable && (admin || choosing) && (
          <label className="field">
            Your app password, to confirm it’s you
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {choosing && (
          <>
            <RadioRows
              legend={row.kind === 'audience' ? `Who it is on for, in ${environment}` : row.kind === 'mode' ? `The policy, in ${environment}` : `The ops routes, in ${environment}`}
              name={`flag-${row.key}`}
              options={options(row, place, demos, shown)}
              value={choice}
              onChange={setChoice}
              disabled={busy}
            />
            {stored === null && <p className="helper">Not set: its default, {choiceWord(row, place, row.defaultChoice)}, applies.</p>}
          </>
        )}
        {row.kind === 'audience' && !unreadable && !admin && (row.accounts ?? 0) > 0 && (
          <p className="helper">Also on for {count(row.accounts!, 'account', 'accounts')} by name, set on the admin page.</p>
        )}
        {row.kind === 'audience' && !unreadable && admin && (
          <section className="stack tight" aria-labelledby={`also-${row.key}`}>
            <h3 className="section-label" id={`also-${row.key}`}>
              Also on for
            </h3>
            {named.length === 0 ? (
              <p className="empty-note">No account by name.</p>
            ) : (
              <ul className="card list-rows">
                {named.map((id) => {
                  const a = known.get(id);
                  return (
                    <li key={id}>
                      <div className="list-row">
                        <span className="list-row-text">
                          <span className="list-row-title">{a ? a.name : 'An account that is gone'}</span>
                          {a?.made && <span className="list-row-sub">Made {day(a.made)}</span>}
                        </span>
                        <button type="button" className="btn ghost" disabled={busy || needsPassword} onClick={() => run({ op: 'remove-account', container: id })}>
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <ul className="card list-rows">
              <li>
                <button type="button" className="list-row" aria-haspopup="dialog" onClick={() => goTo('add-account')}>
                  <span className="list-row-text">
                    <span className="list-row-title">Add an account</span>
                  </span>
                  {chevron(RIGHT)}
                </button>
              </li>
            </ul>
          </section>
        )}
        {row.kind === 'list' && !admin && (
          <p className="helper">
            {row.people === null ? 'Nobody is on the stored list.' : `${count(row.people, 'person', 'people')} on the stored list.`} Who may sign in is set on the admin page.
          </p>
        )}
        {row.kind === 'list' && admin && !unreadable && (
          <>
            {!clerk && <Notice level="info">Without Clerk, signing in is the app password, so this list isn’t used.</Notice>}
            <ul className="card list-rows">
              <li>
                <div className="list-row">
                  <span className="list-row-text">
                    <span className="list-row-title">You, the owner</span>
                    <span className="list-row-sub">Always let in</span>
                  </span>
                </div>
              </li>
              {[...(row.ids ?? []), ...(row.emails ?? [])].map((person) => (
                <li key={person}>
                  <div className="list-row">
                    <span className="list-row-text">
                      <span className="list-row-title">{person}</span>
                    </span>
                    <button type="button" className="btn ghost" aria-haspopup="dialog" disabled={busy} onClick={() => goTo({ remove: person })}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <form
              className="stack tight"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run({ op: 'add-person', entry })) setEntry('');
              }}
            >
              <label className="field">
                Add someone: an email address or a Clerk user id
                <input type="text" autoComplete="off" spellCheck={false} value={entry} onChange={(e) => setEntry(e.target.value)} />
              </label>
              <div className="btn-row">
                <button type="submit" className="btn secondary" disabled={busy || needsPassword || entry.trim() === ''}>
                  {busy ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>
          </>
        )}
        {admin && changes.length > 0 && (
          <section className="stack tight" aria-labelledby={`changes-${row.key}`}>
            <h3 className="section-label" id={`changes-${row.key}`}>
              Last changes
            </h3>
            <ul className="list-rows">
              {changes.map((c) => (
                <li key={`${c.at}-${c.what}`}>
                  <div className="list-row">
                    <span className="list-row-text">
                      <span className="list-row-title">{c.what}</span>
                      <span className="list-row-sub">
                        {day(c.at)}, by {c.by}
                      </span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {failure}
      </div>
    </Sheet>
  );
}

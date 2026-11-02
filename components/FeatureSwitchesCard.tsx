'use client';

// The feature switches (lib/flags.ts), a card each: what it does, a release
// flag's removal date, whether its variable still decides it, and its value,
// changed with a choice and Save. On /dev/flags (app/dev/flags) for local
// development, where anyone signed in may set them; F2 puts it on the admin
// page, each card a row that opens its kind's sheet. The list of who may sign
// in is shown, not set, here: adding and removing people comes with F2's
// sheets.
//
// Saved by Save, never on a choice alone: a closed select's arrow keys choose
// at every step, and the policy would pass through Off on its way to Enforce.

import { useState } from 'react';
import { ALERT, CAUTION, LevelWord } from './ConnectionStatus';

/** One switch as the page shows it. `stored` is the choice stored, null when
 *  none is (its default applies), or 'unreadable'. */
export type SwitchRow = {
  key: string;
  about: string;
  kind: 'audience' | 'mode' | 'switch' | 'list';
  removeBy: string | null;
  choices: string[];
  stored: string | null | 'unreadable';
  defaultChoice: string | null;
  variable: string | null;
  variableSet: boolean;
  /** For the list: how many people are on the stored one. */
  people: number | null;
};

const WORDS: Record<string, string> = {
  nobody: 'Nobody',
  admin: 'The admin',
  'admin-and-demo': 'The admin and the demo accounts',
  everyone: 'Everyone',
  off: 'Off',
  on: 'On',
  'report-only': 'Report only',
  enforce: 'Enforce',
};

const FIELD: Record<SwitchRow['kind'], string> = { audience: 'On for', mode: 'Policy', switch: 'Routes', list: '' };

const word = (choice: string | null) => (choice === null ? '' : (WORDS[choice] ?? choice));

const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

export function SwitchCard({ row, demos }: { row: SwitchRow; demos: boolean }) {
  const [stored, setStored] = useState(row.stored);
  const shown = stored === 'unreadable' ? null : (stored ?? row.defaultChoice);
  const [choice, setChoice] = useState(shown ?? '');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const id = `switch-${row.key}`;
  // The admin and the demo accounts only where there are demo accounts.
  const choices = row.choices.filter((c) => c !== 'admin-and-demo' || demos || shown === c);

  const save = async () => {
    setSaving(true);
    setFailed(null);
    try {
      const res = await fetch('/api/dev/flags', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: row.key, choice }) });
      const body = (await res.json().catch(() => ({}))) as { choice?: unknown; error?: unknown };
      if (res.ok && typeof body.choice === 'string') setStored(body.choice);
      else setFailed(typeof body.error === 'string' ? body.error : 'The switch couldn’t be set just now.');
    } catch {
      setFailed('The switch couldn’t be set just now.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <h2 id={id}>
          <code>{row.key}</code>
        </h2>
      </div>
      <div className="stack">
        <p className="helper">{row.about}</p>
        {row.removeBy && <p className="helper">A release switch, to be removed by {row.removeBy}.</p>}
        {row.variableSet && (
          <p className="helper">
            Set by the environment ({row.variable}); your choice takes over when it is removed.
          </p>
        )}
        {stored === 'unreadable' && (
          <div className="notice caution">
            {CAUTION}
            <div>
              <LevelWord level="caution" />
              Its stored value can’t be read, so its default applies, and it is left as it is.
            </div>
          </div>
        )}
        {row.kind === 'list' ? (
          <p className="helper">
            {stored === null ? 'Nobody is on the stored list.' : `${people(row.people ?? 0)} on the stored list.`} Who may sign in is set on the admin page.
          </p>
        ) : (
          stored !== 'unreadable' && (
            <>
              <label className="field">
                {FIELD[row.kind]}
                <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={saving}>
                  {choices.map((c) => (
                    <option key={c} value={c}>
                      {word(c)}
                    </option>
                  ))}
                </select>
              </label>
              {stored === null && <p className="helper">Not set: its default, {word(row.defaultChoice)}, applies.</p>}
              {choice !== shown ? (
                <div className="btn-row">
                  <button type="button" className="btn secondary" onClick={save} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : null}
            </>
          )
        )}
        {failed && (
          <div className="notice critical" role="alert">
            {ALERT}
            <p>
              <LevelWord level="critical" />
              {failed}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

export default function FeatureSwitchesCard({ rows, demos }: { rows: SwitchRow[]; demos: boolean }) {
  return (
    <div className="stack">
      {rows.map((row) => (
        <SwitchCard key={row.key} row={row} demos={demos} />
      ))}
    </div>
  );
}

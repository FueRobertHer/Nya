'use client';

// The feature switches (lib/flags.ts), one card of rows: each switch by its
// short name, with what it does under it and, as badges after that, a value
// that can't be read, a variable that still decides it, and a release
// switch's removal date; its value is the badge at the row's end. A row opens
// the switch's sheet (components/FlagSheet.tsx), where it is set. On the
// admin page (components/AdminPage.tsx) and on /dev/flags for local
// development (app/dev/flags), which sets the choices alone.
//
// The rows come from the page (lib/flag-view.ts switchRows). A change answers
// with the switch's new row on the admin page, or the choice stored on
// /dev/flags, shown at once; then the page is read again (router.refresh), so
// its other cards (the record of changes, Needs attention) follow, and its
// rows replace the ones answered.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useReverification } from '@clerk/nextjs';
import FlagSheet, { alsoWords, putFlag, removeByWords, valueBadge, type Answer, type Send } from './FlagSheet';
import { chevron, RIGHT } from './MonthStepper';
import { useBrowserDay, useBrowserWhen } from './browser-day';
import type { AdminAccount, ChangeLine, Place, SwitchRow } from '@/lib/flag-view';

type Props = {
  rows: SwitchRow[];
  place: Place;
  demos: boolean;
  /** Where these values hold, in words: "Production", "Preview", "local
   *  development". */
  environment: string;
  /** Whether a change asks for a fresh sign-in (lib/flag-change.ts
   *  flagChangeNeedsFreshSignIn). */
  freshSignIn: boolean;
  clerk: boolean;
  /** The admin page's: the accounts in the registry, named. */
  accounts?: AdminAccount[];
  /** The admin page's: each switch's latest changes, worded, latest first. */
  changes?: Record<string, ChangeLine[]>;
};

export default function FeatureSwitchesCard(props: Props) {
  // Clerk's hook only works inside its provider, which exists only with Clerk.
  if (props.place === 'admin' && props.clerk && props.freshSignIn) return <WithClerk {...props} />;
  return <Switches {...props} send={(body) => putFlag(props.place === 'admin' ? '/api/admin/flags' : '/api/dev/flags', body)} />;
}

function WithClerk(props: Props) {
  const verified = useReverification((body: Record<string, unknown>) => putFlag('/api/admin/flags', body));
  return <Switches {...props} send={verified as Send} />;
}

function Switches({ rows, place, demos, environment, freshSignIn, clerk, accounts = [], changes = {}, send }: Props & { send: Send }) {
  const router = useRouter();
  const day = useBrowserDay();
  const when = useBrowserWhen();
  // Rows answered by a change, until the page's own come back.
  const [given, setGiven] = useState(rows);
  const [answered, setAnswered] = useState<Record<string, SwitchRow>>({});
  if (given !== rows) {
    setGiven(rows);
    setAnswered({});
  }
  // The sheet's switch stays named while it slides out; `opened` gives each
  // opening a fresh sheet.
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0);

  const current = rows.map((r) => answered[r.key] ?? r);
  const sheetRow = current.find((r) => r.key === sheetKey);

  const onChanged = (answer: Extract<Answer, { ok: true }>) => {
    if (!sheetRow) return;
    const next = answer.row ?? (answer.choice !== null ? { ...sheetRow, stored: answer.choice } : sheetRow);
    setAnswered((a) => ({ ...a, [sheetRow.key]: next }));
    router.refresh();
  };

  return (
    <section id="feature-switches" className="card" aria-labelledby="feature-switches-title">
      <div className="card-header">
        <h2 id="feature-switches-title">Feature switches</h2>
      </div>
      <p className="helper">
        A change reaches the routes that check a switch at once, and pages within 30 seconds.{' '}
        {place === 'admin' ? `These are ${environment}’s: each environment keeps its own.` : 'These are this machine’s, for local development.'}
        {place === 'admin' && freshSignIn && ' You’ll confirm it’s you before a change is saved.'}
      </p>
      <ul className="list-rows">
        {current.map((row) => {
          const badge = valueBadge(row, place);
          const also = alsoWords(row);
          return (
            <li key={row.key}>
              <button
                type="button"
                className="list-row"
                aria-haspopup="dialog"
                onClick={() => {
                  setSheetKey(row.key);
                  setOpened((n) => n + 1);
                  setOpen(true);
                }}
              >
                <span className="list-row-text">
                  <span className="list-row-title">{row.name}</span>
                  <span className="list-row-sub">
                    {row.about}
                    {also && ` ${also}`}
                    {row.stored === 'unreadable' && (
                      <>
                        {' '}
                        <span className="badge warn">Can’t be read</span>
                      </>
                    )}
                    {row.variableSet && (
                      <>
                        {' '}
                        <span className="badge">Set by {row.variable}</span>
                      </>
                    )}
                    {row.removeBy && (
                      <>
                        {' '}
                        <span className="badge">Remove by {removeByWords(row.removeBy)}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="list-row-value">
                  <span className={badge.tone ? `badge ${badge.tone}` : 'badge'}>{badge.text}</span>
                </span>
                {chevron(RIGHT)}
              </button>
            </li>
          );
        })}
      </ul>
      {sheetRow && (
        <FlagSheet
          key={`${sheetRow.key}-${opened}`}
          row={sheetRow}
          place={place}
          open={open}
          onClose={() => setOpen(false)}
          send={send}
          onChanged={onChanged}
          demos={demos}
          environment={environment}
          clerk={clerk}
          askPassword={place === 'admin' && !clerk && freshSignIn}
          accounts={accounts}
          changes={changes[sheetRow.key] ?? []}
          day={day}
          when={when}
        />
      )}
    </section>
  );
}

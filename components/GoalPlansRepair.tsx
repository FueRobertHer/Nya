'use client';

// Goal plans that can't be read stop the Goals card loading (lib/goal-plans.ts,
// READS ARE STRICT): a save from a list without them would write over a
// goal's plan with nothing. Those whose bytes are damaged hold nothing anyone
// can read, so they can be removed, once the person confirms
// (app/api/goals, repair): their goals then read with no plan, to set again.
// Those a newer version of Nya saved are only named: they are intact, and
// that version reads them.

import { useState } from 'react';

export type GoalPlansDamage = { unreadable: number; unrecognised: number };

export default function GoalPlansRepair({ damage, onRepaired }: { damage: GoalPlansDamage; onRepaired: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = damage.unreadable;
  const m = damage.unrecognised;
  const repair = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'repair', confirm: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'The damaged plans couldn’t be removed.');
        return;
      }
      setConfirming(false);
      onRepaired();
    } catch {
      setError('The damaged plans couldn’t be removed: the server couldn’t be reached.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stale-note goal-plans-repair">
      {n > 0 && (
        <p>
          {n === 1 ? 'The plan of one goal is damaged' : `The plans of ${n} goals are damaged`} and can’t be read.
          {m > 0
            ? ` Goals can’t be shown or changed while any plan can’t be read, and removing ${n === 1 ? 'this one' : 'these'} isn’t enough on its own (see below).`
            : ` Goals can’t be shown or changed until ${n === 1 ? 'it is' : 'they are'} removed.`}{' '}
          Deleting {n === 1 ? 'it' : 'them'} keeps {n === 1 ? 'that goal' : 'those goals'}, with {n === 1 ? 'its' : 'their'} name, target
          and account, and no plan: an allocation, monthly target or target date {n === 1 ? 'it' : 'they'} had needs setting again. This
          can’t be undone here: if a backup holds {n === 1 ? 'it' : 'them'}, whoever runs this Nya may want to recover{' '}
          {n === 1 ? 'it' : 'them'} from there first.
        </p>
      )}
      {m > 0 && (
        <p>
          {m === 1 ? 'The plan of one goal is' : `The plans of ${m} goals are`} in a form this version of Nya can’t read, though{' '}
          {m === 1 ? 'it looks' : 'they look'} intact: perhaps saved by a newer version. Nothing here changes {m === 1 ? 'it' : 'them'}, and
          goals can’t be shown until the version that saved {m === 1 ? 'it' : 'them'} is back.
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
              {busy ? 'Deleting…' : n === 1 ? 'Delete it' : `Delete all ${n}`}
            </button>
          </div>
        ) : (
          <button className="secondary" onClick={() => setConfirming(true)}>
            Delete the damaged {n === 1 ? 'plan' : 'plans'}
          </button>
        ))}
    </div>
  );
}

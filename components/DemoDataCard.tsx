'use client';

// Settings > Your data and privacy, for a demo account only: reset it to one
// of the scenarios (lib/demo-seed/scenarios.ts), replacing everything in it,
// through app/api/demo/seed. Anyone else never sees it: the card renders
// nothing until the route says this is a demo account.
//
// The reset is confirmed in a sheet, as every destructive action is, saying
// it replaces the account for everyone using it. A reset still running
// (someone else's, or this one before a reload) is said, and so is one that
// stopped part way, so it is run again rather than taken for the demo; and
// why the account can't be reset, when it can't.

import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { LevelWord, Notice } from './TotalCaveats';
import { minutesText } from '@/lib/demo-seed/words';

type ScenarioView = { id: string; title: string; description: string };
export type DemoInfo =
  | { demo: false }
  | {
      demo: true;
      scenarios: ScenarioView[];
      default: string;
      last: { scenario: string; at: string; phase: 'finished' | 'running' | 'stopped' } | null;
      next_in_seconds: number;
      window_minutes: number;
      /** Why this account can't be reset, when it can't. */
      refused?: string;
    };

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

type ViewProps = {
  info: DemoInfo | null;
  /** The scenario picked here, before any reset. */
  chosen: string | null;
  busy: boolean;
  error: string | null;
  done: string | null;
  onChoose: (id: string) => void;
  onAsk: () => void;
};

/** The scenario the card shows: the one picked, else the last reset's, else
 *  the account's own. */
export function shownScenario(info: Extract<DemoInfo, { demo: true }>, chosen: string | null): ScenarioView {
  return info.scenarios.find((s) => s.id === (chosen ?? info.last?.scenario ?? info.default)) ?? info.scenarios[0];
}

/** The card, for whatever state it is in. Nothing for anyone but a demo
 *  account, or before the route has said. */
export function DemoDataView({ info, chosen, busy, error, done, onChoose, onAsk }: ViewProps) {
  if (!info || !info.demo) return null;
  const scenario = shownScenario(info, chosen);
  const running = info.last?.phase === 'running' && !busy;
  const limited = info.next_in_seconds > 0;
  return (
    <div className="card stack">
      <div className="card-header">
        <h2>Demo data</h2>
      </div>
      <p className="helper">This demo account is shared by everyone who tries Nya, so it can’t bring a download back. Reset it to start again from a known set of accounts.</p>

      {info.refused && <Notice level="caution">{info.refused}</Notice>}
      {running && <Notice level="info">This account is being reset now, so some of it may be missing. Load the page again in a minute.</Notice>}
      {info.last?.phase === 'stopped' && !busy && (
        <Notice level="caution">The last reset stopped part way, so some of this account may be missing. Reset it again to finish.</Notice>
      )}
      {done && (
        <div className="notice done" role="status">
          {CHECK}
          <div>
            <LevelWord level="done" />
            {done}
          </div>
        </div>
      )}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}

      <label className="field">
        Scenario
        <select value={scenario.id} onChange={(e) => onChoose(e.target.value)} disabled={busy}>
          {info.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      <p className="helper">{scenario.description}</p>
      {limited && !running && (
        <p className="helper">
          Demo accounts can be reset once every {info.window_minutes} minutes. This one can be reset again in {minutesText(info.next_in_seconds)}.
        </p>
      )}

      <div className="btn-row">
        <button type="button" className="btn secondary" disabled={busy || limited || running || !!info.refused} onClick={onAsk}>
          Reset demo data
        </button>
      </div>
    </div>
  );
}

export default function DemoDataCard({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/demo/seed', { cache: 'no-store' });
      if (res.ok) setInfo((await res.json()) as DemoInfo);
    } catch {
      // Not a demo account as far as this page knows: the card stays away.
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (!info || !info.demo) return null;
  const scenario = shownScenario(info, chosen);

  const reset = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/demo/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: scenario.id }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; waiting?: string[] };
      if (res.ok) {
        setDone(
          body.waiting && body.waiting.length > 0
            ? `Reset to ${scenario.title}. ${body.waiting.join(', ')} ${body.waiting.length === 1 ? 'is' : 'are'} still bringing in older transactions, which appear within minutes.`
            : `Reset to ${scenario.title}.`
        );
        onChanged();
      } else {
        setError(body.error ?? 'The demo couldn’t be reset just now.');
      }
    } catch {
      setError('The demo couldn’t be reached. Check the connection and try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
      void load();
    }
  };

  return (
    <>
      <DemoDataView info={info} chosen={chosen} busy={busy} error={error} done={done} onChoose={setChosen} onAsk={() => setConfirming(true)} />
      <Sheet
        open={confirming}
        title="Reset demo data"
        onClose={() => !busy && setConfirming(false)}
        footer={
          <div className="btn-row">
            <button type="button" className="btn secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn danger" onClick={() => void reset()} disabled={busy}>
              {busy ? 'Resetting…' : 'Reset'}
            </button>
          </div>
        }
      >
        <div className="stack">
          <p>
            Replace everything in this demo account with {scenario.title}? Its banks, transactions, budgets, goals, Plan and files are all replaced, for everyone
            using it, and its connections to other people end.
          </p>
          <p className="helper">{busy ? 'Resetting. This takes about a minute.' : 'It takes about a minute, and it can’t be undone.'}</p>
        </div>
      </Sheet>
    </>
  );
}
